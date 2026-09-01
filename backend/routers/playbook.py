"""
Playbook endpoints — per-setup study view + strategy notes.

Backed by:
  • trades.setup (TEXT) — the setup label for the trade.
  • setup_playbook (one row per setup_label) — strategy notes.

P/L formula and signed-quantity caveat are identical to the analytics
module.
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
    """Convert a weeks window to a Helsinki-local Monday cutoff date."""
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
    """List every setup label in trades.setup within the requested window,
    with trade count and total realised P/L. Sorted by trade_count desc."""
    start_monday = _window_start(weeks)

    if start_monday is None:
        sql = f"""
            WITH trade_stats AS (
                SELECT
                    t.tradeid,
                    t.setup AS setup_label,
                    (
                        COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                        + COALESCE(SUM(e.ibcommission), 0)
                    )::numeric AS pnl
                FROM trades t
                JOIN executions e ON e.trade_fk = t.tradeid
                WHERE t.setup IS NOT NULL
                GROUP BY t.tradeid, t.setup
            )
            SELECT
                setup_label,
                COUNT(*)::int      AS trade_count,
                SUM(pnl)::numeric  AS total_pnl
            FROM trade_stats
            GROUP BY setup_label
            ORDER BY trade_count DESC, setup_label ASC
        """
        rows = await db_conn.fetch(sql)
    else:
        sql = f"""
            WITH trade_stats AS (
                SELECT
                    t.tradeid,
                    t.setup AS setup_label,
                    (
                        COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                        + COALESCE(SUM(e.ibcommission), 0)
                    )::numeric AS pnl
                FROM trades t
                JOIN executions e ON e.trade_fk = t.tradeid
                WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $1::date
                  AND t.setup IS NOT NULL
                GROUP BY t.tradeid, t.setup
            )
            SELECT
                setup_label,
                COUNT(*)::int      AS trade_count,
                SUM(pnl)::numeric  AS total_pnl
            FROM trade_stats
            GROUP BY setup_label
            ORDER BY trade_count DESC, setup_label ASC
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
    """Trades with the given setup label, newest first."""
    start_monday = _window_start(weeks)

    base_select = f"""
        SELECT
            t.tradeid,
            t.symbol,
            t.date,
            t.setup,
            (
                COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                + COALESCE(SUM(e.ibcommission), 0)
            )::numeric AS realized_pnl
        FROM trades t
        JOIN executions e ON e.trade_fk = t.tradeid
        WHERE t.setup = $1
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
    """Read the strategy notes for a setup label."""
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
    """Upsert structured notes for a setup label."""
    if not label.strip():
        raise HTTPException(status_code=400, detail="Label cannot be empty.")

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
