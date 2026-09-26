"""
Playbook endpoint — a filterable gallery of trades for studying 2-min charts.

Backed by:
  • trades.setup    (TEXT) — the setup label, e.g. "Reversal long".
  • trades.category (TEXT) — the quality rating, e.g. "A+".

The old per-setup strategy notes (setup_playbook table) are no longer
exposed. The table is left in the database untouched so no data is lost.
"""

from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query

from dependencies import get_db_conn
from core.config import settings
from schemas.api_schemas import (
    PlaybookGalleryResponse,
    PlaybookGalleryTrade,
)

import logging
logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/api/playbook",
    tags=["Playbook"],
)


def _window_start(weeks: Optional[int]) -> Optional[date]:
    """Convert a weeks window to a Helsinki-local Monday cutoff date.

    weeks=1 → this week's Monday (i.e. "this week").
    """
    if weeks is None:
        return None
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    return this_monday - timedelta(weeks=weeks - 1)


@router.get("/trades", response_model=PlaybookGalleryResponse)
async def list_playbook_trades(
    setup: Optional[list[str]] = Query(
        None, description="Setup labels to include (repeatable). Omit for all.",
    ),
    rating: Optional[list[str]] = Query(
        None, description="Ratings (trades.category) to include (repeatable). Omit for all.",
    ),
    weeks: Optional[int] = Query(
        None, ge=1, le=520,
        description="Window in weeks (1 = this week); omit for all time.",
    ),
    db_conn=Depends(get_db_conn),
) -> PlaybookGalleryResponse:
    """Trades matching the setup / rating / window filters, newest first.

    Trades without executions (e.g. manually added ones) are included —
    they still have 2-min bars, just no fill markers on the chart.
    """
    start_monday = _window_start(weeks)

    where = ["TRUE"]
    args: list = []

    if setup:
        args.append(setup)
        where.append(f"t.setup = ANY(${len(args)}::text[])")
    if rating:
        args.append(rating)
        where.append(f"t.category = ANY(${len(args)}::text[])")
    if start_monday is not None:
        args.append(start_monday)
        where.append(
            f"(t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= ${len(args)}::date"
        )

    sql = f"""
        SELECT t.tradeid, t.symbol, t.date, t.setup, t.category
        FROM trades t
        WHERE {" AND ".join(where)}
        ORDER BY t.date DESC, t.tradeid DESC
    """
    rows = await db_conn.fetch(sql, *args)

    trades = [
        PlaybookGalleryTrade(
            tradeid=r["tradeid"],
            symbol=r["symbol"],
            date=r["date"],
            setup=r["setup"],
            rating=r["category"],
        )
        for r in rows
    ]

    logger.info(
        "playbook trades listed | setup=%s rating=%s weeks=%s count=%d",
        setup, rating, "all" if weeks is None else weeks, len(trades),
    )

    return PlaybookGalleryResponse(weeks=weeks, trades=trades)
