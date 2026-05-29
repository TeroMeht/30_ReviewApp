"""
Weekly trade-review generation.

Pulls the selected Mon–Sun (Europe/Helsinki) week's trades, executions,
per-trade realised P/L, free-text notes, plan-vs-actual deviations, plus
several *trailing* weeks of the same raw data and the user's playbook
notes (especially the per-setup "common mistakes"), packs it into a prompt
and asks Claude to write a review.

The trailing weeks exist so Claude can spot mistakes the trader makes over
and over again, not just within the selected week. The number of trailing
weeks is ``TRAILING_WEEKS``.

P/L formula matches the analytics module exactly:
    per-execution cash flow = -quantity * tradeprice + ibcommission
    (quantity is signed: BUY +N, SELL -N; ibcommission stored negative).
    Net per trade = SUM(-quantity*tradeprice) + SUM(ibcommission).
This is raw cash flow; it equals realised P/L when the trade is flat.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

import asyncpg

from core.config import settings
from db.trades import LOCAL_TZ

import logging
logger = logging.getLogger(__name__)


# How many weeks before the selected week to include as raw context so
# Claude can detect recurring mistakes. Tune here if prompts get too large.
TRAILING_WEEKS = 4


class ReviewConfigError(RuntimeError):
    """Raised when the feature isn't configured (e.g. missing API key)."""


# ─── Data gathering ───────────────────────────────────────────────────────────

async def _fetch_trades_with_pnl(
    db_conn: asyncpg.Connection,
    start: date,
    end: date,
) -> list[dict]:
    """Trades in [start, end] (local-day inclusive) with P/L, exec count and
    hold time joined from executions. Newest-first within the range."""
    rows = await db_conn.fetch(
        f"""
        SELECT
            t.tradeid,
            t.symbol,
            (t.date AT TIME ZONE '{LOCAL_TZ}')::date AS day,
            t.setup,
            t.intended_setup,
            t.observed_setup,
            t.price_action_rating,
            t.price_position,
            t.category,
            t.notes,
            COUNT(DISTINCT e.iborderid) AS exec_count,
            CASE WHEN COUNT(e.tradeid) = 0 THEN NULL
                 ELSE COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                      + COALESCE(SUM(e.ibcommission), 0)
            END AS realized_pnl,
            CASE WHEN COUNT(e.tradeid) = 0 THEN NULL
                 ELSE EXTRACT(EPOCH FROM (MAX(e.datetime) - MIN(e.datetime)))::int
            END AS hold_sec
        FROM trades t
        LEFT JOIN executions e ON e.trade_fk = t.tradeid
        WHERE (t.date AT TIME ZONE '{LOCAL_TZ}')::date BETWEEN $1 AND $2
        GROUP BY t.tradeid, t.symbol, t.date, t.setup, t.intended_setup,
                 t.observed_setup, t.price_action_rating, t.price_position,
                 t.category, t.notes
        ORDER BY day ASC, t.tradeid ASC
        """,
        start, end,
    )
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        # JSON-friendly types
        d["day"] = d["day"].isoformat()
        if d["realized_pnl"] is not None:
            d["realized_pnl"] = float(round(Decimal(d["realized_pnl"]), 2))
        out.append(d)
    return out


async def _fetch_playbook(db_conn: asyncpg.Connection) -> list[dict]:
    """All playbook notes — the strategy rules + common mistakes per setup."""
    rows = await db_conn.fetch(
        """
        SELECT setup_label, description, entry_rules, exit_rules,
               common_mistakes, examples
        FROM setup_playbook
        ORDER BY setup_label ASC
        """
    )
    return [dict(r) for r in rows]


def _aggregate(trades: list[dict]) -> dict:
    """Headline numbers for a set of trades (the selected week)."""
    with_pnl = [t for t in trades if t.get("realized_pnl") is not None]
    total_pnl = round(sum(t["realized_pnl"] for t in with_pnl), 2)
    wins = sum(1 for t in with_pnl if t["realized_pnl"] > 0)
    losses = sum(1 for t in with_pnl if t["realized_pnl"] < 0)
    scratches = sum(1 for t in with_pnl if t["realized_pnl"] == 0)
    decided = wins + losses + scratches
    win_rate = round(wins / decided, 4) if decided else 0.0
    total_execs = sum(int(t.get("exec_count") or 0) for t in trades)
    # Plan deviations: planned setup populated AND differs from intended.
    deviations = sum(
        1 for t in trades
        if t.get("setup") and t.get("intended_setup")
        and t["setup"] != t["intended_setup"]
    )
    return {
        "trade_count": len(trades),
        "trades_with_pnl": len(with_pnl),
        "total_pnl": total_pnl,
        "wins": wins,
        "losses": losses,
        "scratches": scratches,
        "win_rate": win_rate,
        "total_execs": total_execs,
        "plan_deviations": deviations,
    }


# ─── Prompt + LLM call ─────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "You are an elite trading coach reviewing a discretionary trader's week. "
    "You are direct, specific, and quantitative. You cite individual trades by "
    "symbol and date when making a point. You care most about helping the trader "
    "notice mistakes they repeat across weeks. You never invent numbers — you only "
    "use the data provided. Write in clear markdown.\n\n"
    "Be ruthlessly concise. The trader wants only the few highest-impact "
    "factors, not an exhaustive list. Surface what actually moved the needle "
    "and cut everything else. No filler, no hedging, no restating the stats "
    "they can already see. If something isn't among the most important points, "
    "leave it out."
)


def _build_user_prompt(
    week_start: date,
    week_end: date,
    week_trades: list[dict],
    week_stats: dict,
    trailing_trades: list[dict],
    playbook: list[dict],
) -> str:
    payload = {
        "selected_week": {
            "week_start": week_start.isoformat(),
            "week_end": week_end.isoformat(),
            "stats": week_stats,
            "trades": week_trades,
        },
        "trailing_weeks_raw_trades": trailing_trades,
        "playbook": playbook,
        "field_notes": {
            "setup": "planned setup for the day",
            "intended_setup": "what was actually executed (a plan deviation is setup != intended_setup)",
            "observed_setup": "other setups that also formed that day (backtest labels)",
            "price_action_rating": "1-5 quality score",
            "realized_pnl": "net cash P/L in account currency; null = no executions linked",
            "hold_sec": "hold time in seconds",
            "exec_count": "distinct orders that made up the trade (high = lots of in/out)",
        },
    }
    return (
        "Here is the trading data. `selected_week` is the week to review. "
        "`trailing_weeks_raw_trades` are the weeks immediately before it — use "
        "them ONLY to detect patterns and mistakes that repeat across weeks.\n\n"
        f"```json\n{json.dumps(payload, indent=2, default=str)}\n```\n\n"
        "Write a VERY TIGHT weekly review in markdown. Your primary source is the "
        "trader's own free-text `notes` on each trade — what they were thinking, "
        "how they felt, what they planned vs. did. Mine the notes (this week and "
        "the trailing weeks) for the behavioural and decision-making themes. P/L "
        "is secondary context only: mention a number only when it sharpens a point "
        "drawn from the notes; never lead with money.\n\n"
        "Use exactly these three sections and respect the hard caps:\n\n"
        "## What went well\n"
        "AT MOST 2 general ideas, drawn from the notes. One short bullet each. "
        "These should be themes/habits, not a play-by-play of individual trades.\n\n"
        "## What went poorly\n"
        "AT MOST 2 general ideas, drawn from the notes — especially anything that "
        "also shows up in the trailing weeks or the playbook's `common_mistakes` "
        "(say so if it's repeating). One short bullet each. Themes, not a trade list.\n\n"
        "## Do this next week\n"
        "AT MOST 3 specific, checkable rules. Fewer is fine.\n\n"
        "Hard limits: only these three sections; no more than 2 + 2 + 3 bullets "
        "total; no bullet longer than two sentences; no preamble, no summary line, "
        "no stats dump. If the week has no trades or no notes, say so in one line."
    )


async def generate_weekly_review(
    db_conn: asyncpg.Connection,
    week_start: date,
) -> dict:
    """Gather data, call Claude, and return {model, content, stats}.

    Raises ReviewConfigError if the Anthropic API key isn't configured.
    """
    if not settings.ANTHROPIC_API_KEY:
        raise ReviewConfigError(
            "ANTHROPIC_API_KEY is not set. Add it to your .env "
            "(C:/codebase/env-repo/30_ReviewApp.env) to generate reviews."
        )

    week_end = week_start + timedelta(days=6)
    trailing_start = week_start - timedelta(weeks=TRAILING_WEEKS)
    trailing_end = week_start - timedelta(days=1)

    week_trades = await _fetch_trades_with_pnl(db_conn, week_start, week_end)
    trailing_trades = await _fetch_trades_with_pnl(db_conn, trailing_start, trailing_end)
    playbook = await _fetch_playbook(db_conn)

    week_stats = _aggregate(week_trades)
    user_prompt = _build_user_prompt(
        week_start, week_end, week_trades, week_stats, trailing_trades, playbook
    )

    # Import here so the backend boots even if the package isn't installed yet.
    try:
        from anthropic import AsyncAnthropic
    except ImportError as e:  # pragma: no cover
        raise ReviewConfigError(
            "The `anthropic` package isn't installed. Run `uv sync` in backend/."
        ) from e

    client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    logger.info(
        "Generating weekly review | week_start=%s trades=%d trailing=%d model=%s",
        week_start, len(week_trades), len(trailing_trades), settings.ANTHROPIC_MODEL,
    )
    resp = await client.messages.create(
        model=settings.ANTHROPIC_MODEL,
        max_tokens=700,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    content = "".join(
        block.text for block in resp.content if getattr(block, "type", None) == "text"
    ).strip()

    return {
        "model": settings.ANTHROPIC_MODEL,
        "content": content,
        "stats": week_stats,
    }
