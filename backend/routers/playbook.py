"""
Playbook endpoints — per-setup study view + strategy notes.

Backed by:
  • trades.observed_setup (TEXT[]) — the universe of setup labels.
    Trades may have multiple observed setups; each one contributes the
    trade to that setup's bucket. We UNNEST the array to query.
  • setup_playbook (one row per setup_label) — strategy notes.

P/L formula and signed-quantity caveat are identical to the analytics
module — see backend/routers/analytics.py module docstring.

Window semantics:
  ``weeks=N`` restricts to the last N Mon–Sun Helsinki weeks,
  matching the analytics endpoints. ``weeks`` omitted means "all
  time" — the Playbook page exposes an 'All' pill that calls the
  endpoint without the parameter.
"""

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query

from dependencies import get_db_conn
from core.config import settings
from schemas.api_schemas import (
    PlaybookNotes,
    PlaybookNotesUpdate,
    PlaybookSetupsResponse,
    PlaybookSetupSummary,
    PlaybookTradeSummary,
    PlaybookTradesResponse,
)

import logging
logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/api/playbook",
    tags=["Playbook"],
)




def _window_start(weeks: Optional[int]) -> Optional[date]:
    """Convert a weeks window to a Helsinki-local Monday cutoff date.
    Returns None for weeks=None (the 'all time' case) so the SQL can
    skip the date filter entirely."""
    if weeks is None:
        return None
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    return this_monday - timedelta(weeks=weeks - 1)


@router.get("/setups", response_model=PlaybookSetupsResponse)
async def list_playbook_setups(
    weeks: Optional[int] = Query(
        None, ge=1, le=520,
        description="Window in weeks; omit for all time.",
    ),
    db_conn=Depends(get_db_conn),
) -> PlaybookSetupsResponse:
    """List every setup label that appears in observed_setup within the
    requested window, with trade count and total realised P/L.

    Sorted by trade_count desc so the most-observed setup is at the top
    (matches the page's 'most observed first' ordering). Setups with
    saved notes but no trades in the window are NOT returned — the page
    intentionally hides empty sections; switching the window selector
    to 'All' brings them back.
    """
    start_monday = _window_start(weeks)

    # Two-stage: per-trade P/L first (so a trade with 5 fills counts
    # once), then UNNEST observed_setup and aggregate per label. A trade
    # with N observed setups contributes its full P/L to each — the
    # Playbook is a study view, not an attribution model.
    if start_monday is None:
        sql = f"""
            WITH trade_stats AS (
                SELECT
                    t.tradeid,
                    t.observed_setup,
                    (
                        COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                        + COALESCE(SUM(e.ibcommission), 0)
                    )::numeric AS pnl
                FROM trades t
                JOIN executions e ON e.trade_fk = t.tradeid
                WHERE t.observed_setup IS NOT NULL
                  AND array_length(t.observed_setup, 1) > 0
                GROUP BY t.tradeid, t.observed_setup
            )
            SELECT
                label              AS setup_label,
                COUNT(*)::int      AS trade_count,
                SUM(pnl)::numeric  AS total_pnl
            FROM trade_stats, UNNEST(observed_setup) AS label
            GROUP BY label
            ORDER BY trade_count DESC, label ASC
        """
        rows = await db_conn.fetch(sql)
    else:
        sql = f"""
            WITH trade_stats AS (
                SELECT
                    t.tradeid,
                    t.observed_setup,
                    (
                        COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                        + COALESCE(SUM(e.ibcommission), 0)
                    )::numeric AS pnl
                FROM trades t
                JOIN executions e ON e.trade_fk = t.tradeid
                WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $1::date
                  AND t.observed_setup IS NOT NULL
                  AND array_length(t.observed_setup, 1) > 0
                GROUP BY t.tradeid, t.observed_setup
            )
            SELECT
                label              AS setup_label,
                COUNT(*)::int      AS trade_count,
                SUM(pnl)::numeric  AS total_pnl
            FROM trade_stats, UNNEST(observed_setup) AS label
            GROUP BY label
            ORDER BY trade_count DESC, label ASC
        """
        rows = await db_conn.fetch(sql, start_monday)

    out = [
        PlaybookSetupSummary(
            setup_label=r["setup_label"],
            trade_count=r["trade_count"],
            total_pnl=Decimal(r["total_pnl"]),
        )
        for r in rows
    ]

    logger.info(
        "playbook setups listed | weeks=%s setups=%d",
        "all" if weeks is None else weeks, len(out),
    )

    return PlaybookSetupsResponse(weeks=weeks, rows=out)


@router.get(
    "/setups/{label}/trades",
    response_model=PlaybookTradesResponse,
)
async def list_playbook_trades_for_setup(
    label: str,
    weeks: Optional[int] = Query(
        None, ge=1, le=520,
        description="Window in weeks; omit for all time.",
    ),
    db_conn=Depends(get_db_conn),
) -> PlaybookTradesResponse:
    """Trades observed under a given setup label, newest first.

    Filter is ``label = ANY(t.observed_setup)`` — exact-match (no
    casing/whitespace normalisation) to mirror the rest of the app.
    Trades with no executions are excluded (no P/L to display on the
    chart card). Returns ``observed_setup`` in full so the frontend can
    render the '+ other observed setups' chip.
    """
    start_monday = _window_start(weeks)

    base_select = f"""
        SELECT
            t.tradeid,
            t.symbol,
            t.date,
            t.setup,
            t.intended_setup,
            t.observed_setup,
            (
                COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                + COALESCE(SUM(e.ibcommission), 0)
            )::numeric AS realized_pnl
        FROM trades t
        JOIN executions e ON e.trade_fk = t.tradeid
        WHERE $1 = ANY(t.observed_setup)
    """
    group_order = """
        GROUP BY t.tradeid
        ORDER BY t.date DESC, t.tradeid DESC
    """
    if start_monday is None:
        rows = await db_conn.fetch(base_select + group_order, label)
    else:
        sql = (
            base_select
            + f" AND (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $2::date"
            + group_order
        )
        rows = await db_conn.fetch(sql, label, start_monday)

    trades = [
        PlaybookTradeSummary(
            tradeid=r["tradeid"],
            symbol=r["symbol"],
            date=r["date"],
            setup=r["setup"],
            intended_setup=r["intended_setup"],
            observed_setup=list(r["observed_setup"]) if r["observed_setup"] else None,
            realized_pnl=(
                Decimal(r["realized_pnl"])
                if r["realized_pnl"] is not None
                else None
            ),
        )
        for r in rows
    ]

    logger.info(
        "playbook trades listed | label=%r weeks=%s count=%d",
        label, "all" if weeks is None else weeks, len(trades),
    )

    return PlaybookTradesResponse(
        setup_label=label, weeks=weeks, trades=trades,
    )


@router.get(
    "/setups/{label}/notes",
    response_model=PlaybookNotes,
)
async def get_playbook_notes(
    label: str,
    db_conn=Depends(get_db_conn),
) -> PlaybookNotes:
    """Read the strategy notes for a setup label. Returns an empty
    PlaybookNotes (all fields blank) if no row exists yet — the
    frontend can then render an empty editor without special-casing
    'never written about' setups."""
    row = await db_conn.fetchrow(
        """
        SELECT setup_label, description, entry_rules, exit_rules,
               common_mistakes, examples, updated_at
        FROM   setup_playbook
        WHERE  setup_label = $1
        """,
        label,
    )
    if row is None:
        return PlaybookNotes(setup_label=label)
    return PlaybookNotes(**dict(row))


@router.put(
    "/setups/{label}/notes",
    response_model=PlaybookNotes,
)
async def upsert_playbook_notes(
    label: str,
    body: PlaybookNotesUpdate,
    db_conn=Depends(get_db_conn),
) -> PlaybookNotes:
    """Upsert structured notes for a setup label.

    Sent fields overwrite; omitted fields keep their existing values
    (PATCH-style semantics). On insert (first time writing notes for a
    label) omitted fields default to empty string per the table DDL.
    Returns the post-write row so the client can update its local state
    without a follow-up GET.
    """
    if not label.strip():
        raise HTTPException(status_code=400, detail="Label cannot be empty.")

    # Pull existing row so the COALESCE in the UPSERT can keep
    # unchanged fields. asyncpg rejects None-as-keep on INSERT (the
    # NOT NULL DEFAULT '' would still fire, but we'd lose existing
    # values), so we resolve the merge in Python and write the full row.
    existing = await db_conn.fetchrow(
        "SELECT description, entry_rules, exit_rules, common_mistakes, examples "
        "FROM setup_playbook WHERE setup_label = $1",
        label,
    )

    def _resolve(field: str, fallback: str) -> str:
        v = getattr(body, field)
        return fallback if v is None else v

    if existing is None:
        description = body.description or ""
        entry_rules = body.entry_rules or ""
        exit_rules = body.exit_rules or ""
        common_mistakes = body.common_mistakes or ""
        examples = body.examples or ""
    else:
        description = _resolve("description", existing["description"])
        entry_rules = _resolve("entry_rules", existing["entry_rules"])
        exit_rules = _resolve("exit_rules", existing["exit_rules"])
        common_mistakes = _resolve("common_mistakes", existing["common_mistakes"])
        examples = _resolve("examples", existing["examples"])

    row = await db_conn.fetchrow(
        """
        INSERT INTO setup_playbook (
            setup_label, description, entry_rules, exit_rules,
            common_mistakes, examples, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (setup_label) DO UPDATE SET
            description     = EXCLUDED.description,
            entry_rules     = EXCLUDED.entry_rules,
            exit_rules      = EXCLUDED.exit_rules,
            common_mistakes = EXCLUDED.common_mistakes,
            examples        = EXCLUDED.examples,
            updated_at      = now()
        RETURNING setup_label, description, entry_rules, exit_rules,
                  common_mistakes, examples, updated_at
        """,
        label,
        description,
        entry_rules,
        exit_rules,
        common_mistakes,
        examples,
    )

    logger.info("playbook notes upserted | label=%r", label)
    return PlaybookNotes(**dict(row))
