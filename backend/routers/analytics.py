"""
Analytics endpoints — aggregate views over trades + executions.

Decimal-safety: every P/L value is returned as a string at the API
boundary (FastAPI/pydantic serialise ``Decimal`` to string) so the
frontend doesn't lose precision through JS number parsing. Sums are
computed in SQL using NUMERIC arithmetic on ``executions.quantity`` /
``executions.tradeprice`` / ``executions.ibcommission``.

Week bucketing:
    ``date_trunc('week', …)`` in Postgres returns Monday 00:00 in the
    requested timezone. We apply it to ``t.date AT TIME ZONE
    'Europe/Helsinki'`` so weeks line up with the trader's local
    calendar (matches every other Helsinki-based bucket in the app).

P/L formula (mirrors /trades/{id}/day):
    per-execution cash flow = -quantity * tradeprice + ibcommission
    * BUY  +N @ P → quantity=+N → cash -N*P (cash out)
    * SELL -N @ P → quantity=-N → cash +N*P (cash in)
    * ibcommission is stored negative (a cost), so simple addition
      gives a net figure.
    Caveat: this is *raw cash flow*. It equals realized P/L only when
    the trade is flat (Σ quantity = 0). For partially-closed
    positions the number bakes in the cost basis of the still-open
    shares. Same caveat as the daily table — fine for the basic
    weekly view.
"""

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo
from core.config import settings
from fastapi import APIRouter, Depends, HTTPException, Query

from dependencies import get_db_conn

from schemas.api_schemas import (
    DailyPnlExecsPoint,
    DailyPnlExecsResponse,
    PlanVsActualResponse,
    PlanVsActualRow,
    SetupStatsResponse,
    SetupStatsRow,
    WeeklyExecsBucket,
    WeeklyExecsResponse,
    WeeklyOrderCategoriesBucket,
    WeeklyOrderCategoriesResponse,
    WeeklyPnlBucket,
    WeeklyPnlResponse,
)

import logging
logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/api/analytics",
    tags=["Analytics"],
)


# Whitelist of group-by columns. We embed the column name directly in
# the SQL (asyncpg can't parameterise identifiers), so this MUST be a
# closed set to prevent SQL injection.
_ALLOWED_GROUP_BY = {"intended_setup", "setup"}



@router.get("/weekly-pnl", response_model=WeeklyPnlResponse)
async def get_weekly_pnl(
    weeks: int = Query(
        12, ge=1, le=104,
        description="Number of Mon..Sun weeks to include, ending on the current Helsinki week.",
    ),
    group_by: Literal["intended_setup", "setup"] = Query(
        "intended_setup",
        description="Which setup column to attribute P/L to.",
    ),
    db_conn=Depends(get_db_conn),
) -> WeeklyPnlResponse:
    """Aggregate realized P/L per (week, setup) for the last ``weeks`` weeks.

    Excludes trades where the chosen setup column is NULL. The response
    always contains exactly ``weeks`` week buckets in chronological
    order so the chart can render a stable x-axis even on light weeks.
    """
    if group_by not in _ALLOWED_GROUP_BY:
        # Belt-and-braces in case the Literal type ever changes.
        raise HTTPException(
            status_code=400,
            detail=f"group_by must be one of {sorted(_ALLOWED_GROUP_BY)}",
        )

    # Compute the contiguous list of Monday-anchored weeks in Python so
    # the response always has exactly `weeks` buckets, even if some are
    # empty. `today_local` is today in Helsinki; we walk back to its
    # Monday, then subtract (weeks - 1) full weeks for the window start.
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)
    all_week_starts: list[date] = [
        start_monday + timedelta(weeks=i) for i in range(weeks)
    ]

    # `group_by` is whitelisted above so embedding it directly is safe.
    # Aggregation is done in SQL using NUMERIC math; we cast tradeprice
    # to numeric explicitly in case the column type ever drifts.
    sql = f"""
        WITH win AS (
            SELECT $1::date AS start_monday
        )
        SELECT
            (date_trunc(
                'week',
                ((t.date AT TIME ZONE '{settings.TIMEZONE}')::date)::timestamp
            ))::date AS week_start,
            t.{group_by} AS setup_label,
            (
                COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                + COALESCE(SUM(e.ibcommission), 0)
            )::numeric AS pnl
        FROM trades t
        JOIN executions e ON e.trade_fk = t.tradeid
        WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= (SELECT start_monday FROM win)
          AND t.{group_by} IS NOT NULL
        GROUP BY week_start, setup_label
        ORDER BY week_start ASC, setup_label ASC
    """
    rows = await db_conn.fetch(sql, start_monday)

    # Fold rows into the prefilled week skeleton so empty weeks are
    # preserved. Also collect the union of setup labels for a stable
    # legend ordering on the frontend.
    bucket_by_start: dict[date, WeeklyPnlBucket] = {
        ws: WeeklyPnlBucket(week_start=ws, by_setup={}) for ws in all_week_starts
    }
    setups: set[str] = set()
    for r in rows:
        ws: date = r["week_start"]
        label: str = r["setup_label"]
        pnl: Decimal = Decimal(r["pnl"])
        bucket = bucket_by_start.get(ws)
        if bucket is None:
            # Row outside the requested window — shouldn't happen given
            # the WHERE filter, but skip defensively rather than crash.
            continue
        bucket.by_setup[label] = pnl
        setups.add(label)

    logger.info(
        "weekly-pnl computed | group_by=%s weeks=%d setups=%d non-empty=%d",
        group_by, weeks, len(setups),
        sum(1 for b in bucket_by_start.values() if b.by_setup),
    )

    return WeeklyPnlResponse(
        group_by=group_by,
        weeks=[bucket_by_start[ws] for ws in all_week_starts],
        setups=sorted(setups),
    )


@router.get("/setup-stats", response_model=SetupStatsResponse)
async def get_setup_stats(
    weeks: int = Query(
        12, ge=1, le=104,
        description="Number of Mon..Sun weeks to include, ending on the current Helsinki week.",
    ),
    group_by: Literal["intended_setup", "setup"] = Query(
        "intended_setup",
        description="Which setup column to bucket trades by.",
    ),
    db_conn=Depends(get_db_conn),
) -> SetupStatsResponse:
    """Per-setup win/loss + hold-time stats over the last ``weeks`` weeks.

    For each setup (alphabetical order) returns trade counts split
    into wins/losses/scratches, win rate, average win / loss $, average
    hold time for winners and losers, and expectancy ($ per trade).

    Excludes trades where the chosen setup column is NULL, and trades
    with no executions linked (no P/L computable).
    """
    if group_by not in _ALLOWED_GROUP_BY:
        # Belt-and-braces — Literal type already constrains the param.
        raise HTTPException(
            status_code=400,
            detail=f"group_by must be one of {sorted(_ALLOWED_GROUP_BY)}",
        )

    # Same window arithmetic as /weekly-pnl so the two endpoints can be
    # called with the same `weeks` and align.
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)

    # Two-stage aggregation: first per-trade (P/L + hold seconds), then
    # per-setup. `FILTER (WHERE …)` lets us compute win and loss
    # averages from one pass without sub-queries. AVG returns NULL for
    # empty buckets which we'll expose as None on the response.
    #
    # `group_by` is whitelisted above so embedding it directly is safe.
    sql = f"""
        WITH trade_stats AS (
            SELECT
                t.tradeid,
                t.{group_by} AS setup_label,
                (
                    COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                    + COALESCE(SUM(e.ibcommission), 0)
                )::numeric AS pnl,
                EXTRACT(EPOCH FROM (MAX(e.datetime) - MIN(e.datetime)))::bigint
                    AS hold_sec
            FROM trades t
            JOIN executions e ON e.trade_fk = t.tradeid
            WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $1::date
              AND t.{group_by} IS NOT NULL
            GROUP BY t.tradeid, t.{group_by}
        )
        SELECT
            setup_label,
            COUNT(*)::int                                            AS trade_count,
            COUNT(*) FILTER (WHERE pnl > 0)::int                     AS wins,
            COUNT(*) FILTER (WHERE pnl < 0)::int                     AS losses,
            COUNT(*) FILTER (WHERE pnl = 0)::int                     AS scratches,
            AVG(pnl) FILTER (WHERE pnl > 0)                          AS avg_win,
            AVG(pnl) FILTER (WHERE pnl < 0)                          AS avg_loss,
            AVG(hold_sec) FILTER (WHERE pnl > 0)                     AS avg_win_hold_sec,
            AVG(hold_sec) FILTER (WHERE pnl < 0)                     AS avg_loss_hold_sec
        FROM trade_stats
        GROUP BY setup_label
        ORDER BY setup_label ASC
    """
    rows = await db_conn.fetch(sql, start_monday)

    out: list[SetupStatsRow] = []
    for r in rows:
        trade_count: int = r["trade_count"]
        wins: int = r["wins"]
        losses: int = r["losses"]
        scratches: int = r["scratches"]
        avg_win = Decimal(r["avg_win"]) if r["avg_win"] is not None else None
        avg_loss = Decimal(r["avg_loss"]) if r["avg_loss"] is not None else None
        # Round float-y hold seconds to nearest int. AVG returns
        # numeric-ish, so coerce defensively.
        avg_win_hold = (
            int(round(float(r["avg_win_hold_sec"])))
            if r["avg_win_hold_sec"] is not None
            else None
        )
        avg_loss_hold = (
            int(round(float(r["avg_loss_hold_sec"])))
            if r["avg_loss_hold_sec"] is not None
            else None
        )

        # Expectancy = net P/L per trade across the bucket including
        # scratches (which contribute $0). Equivalent to
        # (wins*avg_win + losses*avg_loss) / trade_count, with NULLs
        # treated as 0.
        win_contrib = (avg_win or Decimal(0)) * wins
        loss_contrib = (avg_loss or Decimal(0)) * losses
        expectancy = (
            (win_contrib + loss_contrib) / Decimal(trade_count)
            if trade_count > 0
            else Decimal(0)
        )

        out.append(
            SetupStatsRow(
                setup=r["setup_label"],
                trade_count=trade_count,
                wins=wins,
                losses=losses,
                scratches=scratches,
                win_rate=(wins / trade_count) if trade_count > 0 else 0.0,
                avg_win=avg_win,
                avg_loss=avg_loss,
                avg_win_hold_sec=avg_win_hold,
                avg_loss_hold_sec=avg_loss_hold,
                expectancy=expectancy,
            )
        )

    logger.info(
        "setup-stats computed | group_by=%s weeks=%d setups=%d",
        group_by, weeks, len(out),
    )

    return SetupStatsResponse(group_by=group_by, weeks=weeks, rows=out)


@router.get("/plan-vs-actual", response_model=PlanVsActualResponse)
async def get_plan_vs_actual(
    weeks: int = Query(
        12, ge=1, le=104,
        description="Number of Mon..Sun weeks to include, ending on the current Helsinki week.",
    ),
    db_conn=Depends(get_db_conn),
) -> PlanVsActualResponse:
    """P/L bucketed by (planned setup → actual setup) over the window.

    Answers the question 'how much is each plan-vs-actual deviation
    costing me?'. A row where planned == actual is a matched trade
    (you did what you intended); any other row is a deviation.

    Includes only trades where BOTH ``setup`` (planned) and
    ``intended_setup`` (actual) are populated — the mapping is
    meaningless for trades you didn't label both ways. Trades with no
    executions are also excluded (no P/L to attribute).

    Rows are returned sorted by ``total_pnl`` ASC so the costliest
    deviations are at the top of the list.
    """
    # Same window arithmetic as /setup-stats so the two endpoints align
    # when called with the same `weeks` value.
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)

    # Two-stage aggregation: first per-trade P/L, then per-(planned,
    # actual) bucket. Identical signed-quantity P/L formula as the rest
    # of the analytics module — see module docstring for the caveat
    # about partially-closed positions.
    sql = f"""
        WITH trade_stats AS (
            SELECT
                t.tradeid,
                t.setup           AS planned,
                t.intended_setup  AS actual,
                (
                    COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                    + COALESCE(SUM(e.ibcommission), 0)
                )::numeric AS pnl
            FROM trades t
            JOIN executions e ON e.trade_fk = t.tradeid
            WHERE (t.date AT TIME ZONE '{settings.TIMEZONE}')::date >= $1::date
              AND t.setup           IS NOT NULL
              AND t.intended_setup  IS NOT NULL
            GROUP BY t.tradeid, t.setup, t.intended_setup
        )
        SELECT
            planned,
            actual,
            COUNT(*)::int                                AS trade_count,
            COUNT(*) FILTER (WHERE pnl > 0)::int         AS wins,
            COUNT(*) FILTER (WHERE pnl < 0)::int         AS losses,
            COUNT(*) FILTER (WHERE pnl = 0)::int         AS scratches,
            SUM(pnl)::numeric                            AS total_pnl,
            AVG(pnl)::numeric                            AS avg_pnl
        FROM trade_stats
        GROUP BY planned, actual
        ORDER BY total_pnl ASC NULLS LAST, planned ASC, actual ASC
    """
    rows = await db_conn.fetch(sql, start_monday)

    out: list[PlanVsActualRow] = []
    for r in rows:
        trade_count: int = r["trade_count"]
        wins: int = r["wins"]
        out.append(
            PlanVsActualRow(
                planned_setup=r["planned"],
                actual_setup=r["actual"],
                trade_count=trade_count,
                wins=wins,
                losses=r["losses"],
                scratches=r["scratches"],
                win_rate=(wins / trade_count) if trade_count > 0 else 0.0,
                total_pnl=Decimal(r["total_pnl"]),
                avg_pnl=Decimal(r["avg_pnl"]),
            )
        )

    logger.info(
        "plan-vs-actual computed | weeks=%d buckets=%d (deviations=%d)",
        weeks, len(out),
        sum(1 for r in out if r.planned_setup != r.actual_setup),
    )

    return PlanVsActualResponse(weeks=weeks, rows=out)


@router.get("/daily-pnl-vs-execs", response_model=DailyPnlExecsResponse)
async def get_daily_pnl_vs_execs(
    weeks: int = Query(
        12, ge=1, le=104,
        description="Number of Mon..Sun weeks to include, ending on the current Helsinki week.",
    ),
    db_conn=Depends(get_db_conn),
) -> DailyPnlExecsResponse:
    """Per-Helsinki-day total realised P/L and total execution count.

    Drives the analytics-page scatter that asks "do high-execution days
    correlate with better or worse P/L?". Each returned point is one
    calendar day with at least one execution. ``exec_count`` is the sum
    of distinct ``iborderid`` values across every trade that day —
    matches the "Total execs" stat surfaced in the daily table footer.

    Days with no executions are excluded. The window arithmetic mirrors
    /weekly-pnl so the same `weeks` value snaps to the same start
    Monday as the other analytics endpoints.
    """
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)

    # Two-stage aggregation: first per-trade (so COUNT(DISTINCT
    # iborderid) is correct — each IB order with N partial fills counts
    # once), then per-day. Same signed-quantity P/L formula as every
    # other endpoint in this module.
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
    """Per-week total execution count over the last ``weeks`` weeks.

    Drives the analytics-page bar chart that shows how the weekly volume
    of executions trends over time. ``exec_count`` is the sum of distinct
    ``iborderid`` values across every trade in the week — matches the
    daily "Total execs" metric, aggregated to the week.

    The response always contains exactly ``weeks`` buckets in
    chronological order so the chart renders a stable x-axis even on
    weeks with no activity. Window arithmetic mirrors every other
    analytics endpoint in this module.
    """
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)
    all_week_starts: list[date] = [
        start_monday + timedelta(weeks=i) for i in range(weeks)
    ]

    # Two-stage aggregation mirrors /daily-pnl-vs-execs: first per-trade
    # so COUNT(DISTINCT iborderid) is correct (each IB order with N
    # partial fills counts once), then per Helsinki-anchored week. Sums
    # P/L too, using the same signed-quantity formula as every other
    # endpoint in this module (see module docstring).
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

    # Prefill empty weeks so the chart has a stable x-axis.
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
    """Per-week count of distinct orders, split by trade-review category.

    Powers the analytics-page discipline chart — how many orders per
    week were "followed plan" (1, 2), "off-plan" (3, 4) or still
    uncategorised. Every distinct IB order (iborderid) with a parent
    trade in the window contributes exactly once; a LEFT JOIN against
    ``order_categories`` labels each order with its user-assigned
    category or NULL. By construction
        cat1 + cat2 + cat3 + cat4 + uncategorized
        == exec_count for the same week in /weekly-execs.

    Buckets are anchored on the parent trade's Helsinki-local Monday, so
    an order carried out on Sunday and its follow-up on Monday would
    fall in adjacent weeks — matching how every other analytics
    endpoint here buckets.

    The response always contains exactly ``weeks`` buckets in
    chronological order so the chart renders a stable x-axis even on
    empty weeks. Window arithmetic mirrors /weekly-execs so the two
    charts share the same x-axis when called with the same ``weeks``.
    """
    today_local = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    this_monday = today_local - timedelta(days=today_local.weekday())
    start_monday = this_monday - timedelta(weeks=weeks - 1)
    all_week_starts: list[date] = [
        start_monday + timedelta(weeks=i) for i in range(weeks)
    ]

    # Start from distinct (week, iborderid) pairs so every IB order is
    # counted once (regardless of fill count), then LEFT JOIN
    # order_categories so uncategorised orders come through with
    # oc.category = NULL. FILTER folds all five buckets into one pass;
    # by construction their sum equals COUNT(DISTINCT iborderid) per
    # week — i.e. the exec_count that /weekly-execs surfaces.
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

    # Prefill empty weeks so the chart has a stable x-axis.
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
