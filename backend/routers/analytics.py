"""
Analytics endpoints — aggregate views over trades + executions.

Decimal-safety: every P/L value is returned as a string at the API
boundary (FastAPI/pydantic serialise ``Decimal`` to string) so the
frontend doesn't lose precision through JS number parsing. Sums are
computed in SQL using NUMERIC arithmetic on ``executions.quantity`` /
``executions.tradeprice`` / ``executions.ibcommission``.

P/L formula (mirrors /trades/{id}/day):
    per-execution cash flow = -quantity * tradeprice + ibcommission
"""

from datetime import date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo
from core.config import settings
from fastapi import APIRouter, Depends

from dependencies import get_db_conn

from schemas.api_schemas import (
    DailyPnlExecsPoint,
    DailyPnlExecsResponse,
    WeeklyExecsBucket,
    WeeklyExecsResponse,
    WeeklyOrderCategoriesBucket,
    WeeklyOrderCategoriesResponse,
)

from fastapi import Query

import logging
logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/api/analytics",
    tags=["Analytics"],
)


@router.get("/daily-pnl-vs-execs", response_model=DailyPnlExecsResponse)
async def get_daily_pnl_vs_execs(
    weeks: int = Query(
        12, ge=1, le=104,
        description="Number of Mon..Sun weeks to include, ending on the current Helsinki week.",
    ),
    db_conn=Depends(get_db_conn),
) -> DailyPnlExecsResponse:
    """Per-Helsinki-day total realised P/L and total execution count."""
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)

    sql = f"""
        WITH per_trade AS (
            SELECT
                (t.date AT TIME ZONE '{settings.TIMEZONE}')::date AS local_date,
                t.tradeid,
                COUNT(DISTINCT e.iborderid)::int           AS execs,
                (
                    COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                    + COALESCE(SUM(e.ibcommission), 0)
                )::numeric                                  AS pnl
            FROM trades t
            JOIN executions e ON e.trade_fk = t.tradeid
            WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $1::date
            GROUP BY local_date, t.tradeid
        )
        SELECT
            local_date,
            SUM(execs)::int     AS exec_count,
            SUM(pnl)::numeric   AS total_pnl,
            COUNT(*)::int       AS trade_count
        FROM per_trade
        GROUP BY local_date
        ORDER BY local_date ASC
    """
    rows = await db_conn.fetch(sql, start_monday)

    points = [
        DailyPnlExecsPoint(
            date=r["local_date"],
            total_pnl=Decimal(r["total_pnl"]),
            exec_count=r["exec_count"],
            trade_count=r["trade_count"],
        )
        for r in rows
    ]

    logger.info(
        "daily-pnl-vs-execs computed | weeks=%d days=%d",
        weeks, len(points),
    )

    return DailyPnlExecsResponse(weeks=weeks, points=points)


@router.get("/weekly-execs", response_model=WeeklyExecsResponse)
async def get_weekly_execs(
    weeks: int = Query(
        12, ge=1, le=104,
        description="Number of Mon..Sun weeks to include, ending on the current Helsinki week.",
    ),
    db_conn=Depends(get_db_conn),
) -> WeeklyExecsResponse:
    """Per-week total execution count over the last ``weeks`` weeks."""
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)
    all_week_starts: list[date] = [
        start_monday + timedelta(weeks=i) for i in range(weeks)
    ]

    sql = f"""
        WITH per_trade AS (
            SELECT
                (date_trunc(
                    'week',
                    ((t.date AT TIME ZONE '{settings.TIMEZONE}')::date)::timestamp
                ))::date                          AS week_start,
                t.tradeid                          AS tradeid,
                COUNT(DISTINCT e.iborderid)::int   AS execs,
                (
                    COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                    + COALESCE(SUM(e.ibcommission), 0)
                )::numeric                          AS pnl
            FROM trades t
            JOIN executions e ON e.trade_fk = t.tradeid
            WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $1::date
            GROUP BY week_start, t.tradeid
        )
        SELECT
            week_start,
            SUM(execs)::int     AS exec_count,
            COUNT(*)::int       AS trade_count,
            SUM(pnl)::numeric   AS total_pnl
        FROM per_trade
        GROUP BY week_start
        ORDER BY week_start ASC
    """
    rows = await db_conn.fetch(sql, start_monday)

    bucket_by_start: dict[date, WeeklyExecsBucket] = {
        ws: WeeklyExecsBucket(
            week_start=ws, exec_count=0, trade_count=0, total_pnl=Decimal(0)
        )
        for ws in all_week_starts
    }
    for r in rows:
        ws: date = r["week_start"]
        if ws in bucket_by_start:
            bucket_by_start[ws] = WeeklyExecsBucket(
                week_start=ws,
                exec_count=int(r["exec_count"]),
                trade_count=int(r["trade_count"]),
                total_pnl=Decimal(r["total_pnl"]),
            )

    logger.info(
        "weekly-execs computed | weeks=%d non-empty=%d",
        weeks, sum(1 for b in bucket_by_start.values() if b.exec_count > 0),
    )

    return WeeklyExecsResponse(
        window_weeks=weeks,
        weeks=[bucket_by_start[ws] for ws in all_week_starts],
    )


@router.get(
    "/weekly-order-categories",
    response_model=WeeklyOrderCategoriesResponse,
)
async def get_weekly_order_categories(
    weeks: int = Query(
        12, ge=1, le=104,
        description="Number of Mon..Sun weeks to include, ending on the current Helsinki week.",
    ),
    db_conn=Depends(get_db_conn),
) -> WeeklyOrderCategoriesResponse:
    """Per-week count of distinct orders, split by trade-review category."""
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)
    all_week_starts: list[date] = [
        start_monday + timedelta(weeks=i) for i in range(weeks)
    ]

    sql = f"""
        WITH order_rows AS (
            SELECT DISTINCT
                (date_trunc(
                    'week',
                    ((t.date AT TIME ZONE '{settings.TIMEZONE}')::date)::timestamp
                ))::date AS week_start,
                e.iborderid
            FROM executions e
            JOIN trades t ON t.tradeid = e.trade_fk
            WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $1::date
              AND e.iborderid IS NOT NULL
        )
        SELECT
            r.week_start,
            COUNT(*) FILTER (WHERE oc.category = 1)::int         AS cat1,
            COUNT(*) FILTER (WHERE oc.category = 2)::int         AS cat2,
            COUNT(*) FILTER (WHERE oc.category = 3)::int         AS cat3,
            COUNT(*) FILTER (WHERE oc.category = 4)::int         AS cat4,
            COUNT(*) FILTER (WHERE oc.category IS NULL)::int     AS uncategorized
        FROM order_rows r
        LEFT JOIN order_categories oc ON oc.iborderid = r.iborderid
        GROUP BY r.week_start
        ORDER BY r.week_start ASC
    """
    rows = await db_conn.fetch(sql, start_monday)

    bucket_by_start: dict[date, WeeklyOrderCategoriesBucket] = {
        ws: WeeklyOrderCategoriesBucket(week_start=ws) for ws in all_week_starts
    }
    for r in rows:
        ws: date = r["week_start"]
        if ws in bucket_by_start:
            bucket_by_start[ws] = WeeklyOrderCategoriesBucket(
                week_start=ws,
                cat1=int(r["cat1"]),
                cat2=int(r["cat2"]),
                cat3=int(r["cat3"]),
                cat4=int(r["cat4"]),
                uncategorized=int(r["uncategorized"]),
            )

    logger.info(
        "weekly-order-categories computed | weeks=%d non-empty=%d",
        weeks,
        sum(
            1 for b in bucket_by_start.values()
            if (b.cat1 + b.cat2 + b.cat3 + b.cat4 + b.uncategorized) > 0
        ),
    )

    return WeeklyOrderCategoriesResponse(
        window_weeks=weeks,
        weeks=[bucket_by_start[ws] for ws in all_week_starts],
    )
