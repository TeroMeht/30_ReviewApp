from datetime import date
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from ib_async import IB
import asyncpg

from dependencies import get_db_conn, get_db_pool, get_ib, ensure_ib_connected
from schemas.api_schemas import (
    Trade,
    TradeCreate,
    TradeUpdate,
    TradeSyncRequest,
    TradeSyncResult,
    BarFetchBatchResult,
    BarTimeframeStatus,
    TradeBarStatus,
    Execution,
    BarRow as BarRowSchema,
    BarsResponse,
    NeighborTrades,
)
from db.trades import (
    insert_trade,
    insert_manual_trades,
    sync_trades_from_executions,
    fetch_trades,
    fetch_trade_by_id,
    update_trade,
    delete_trade,
    LOCAL_TZ,
)
from db.trade_bars import TIMEFRAMES, TIMEFRAME_BY_LABEL
from services.ib_bars import (
    schedule_bar_fetch_batch,
    find_incomplete_tradeids,
    fetch_bar_counts_for_trades,
    compute_bar_status,
    get_last_error,
)
from services.chart_indicators import build_indicators


import logging
logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/trades",
    tags=["Trades"],
)


@router.post("", response_model=Trade)
async def create_trade(payload: TradeCreate,db_conn=Depends(get_db_conn)):
    try:
        trade = await insert_trade(db_conn, payload)
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=409,
            detail=f"Trade for symbol={payload.symbol} on that date already exists",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create trade: {e}")

    return trade



@router.post("/sync", response_model=TradeSyncResult)
async def sync_trades(
    payload: Optional[TradeSyncRequest] = None,
    db_conn=Depends(get_db_conn),
):
    """Run two passes:
      1. Insert any `manual_trades` from the request body (no executions).
         Conflicts (a trade for that (symbol, day) already exists) are
         skipped silently and counted in `manual_trades_skipped`.
      2. Auto-bucket: create trades from any unlinked executions and link
         them.

    Order matters: manual trades land first so any matching executions get
    linked to them in the auto-bucket pass.

    Bar-fetch scheduling is intentionally NOT triggered here — the
    /data-management UI gates that behind the explicit "Start data fetch"
    button so the user can review trades first.
    """
    manual_entries = payload.manual_trades if payload else []
    try:
        manual_rows, manual_skipped = await insert_manual_trades(
            db_conn, manual_entries
        )
        auto_result = await sync_trades_from_executions(db_conn)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trade sync failed: {e}")

    # Merge: manual rows always come first in trades_created_rows so the UI
    # can render them above the auto-bucketed ones if it cares to.
    merged_rows = manual_rows + auto_result.trades_created_rows
    merged_ids = [t.tradeid for t in manual_rows] + auto_result.trades_created_ids

    return TradeSyncResult(
        trades_created=len(manual_rows) + auto_result.trades_created,
        executions_linked=auto_result.executions_linked,
        manual_trades_created=len(manual_rows),
        manual_trades_skipped=len(manual_skipped),
        trades_created_ids=merged_ids,
        trades_created_rows=merged_rows,
    )


# ─── Market data (bar) fetch ──────────────────────────────────────────────────

@router.post("/fetch-bars-batch", response_model=BarFetchBatchResult)
async def fetch_bars_batch(
    db_conn=Depends(get_db_conn),
    db_pool: asyncpg.Pool = Depends(get_db_pool),
    ib: IB = Depends(get_ib),
):
    """
    "Update Market Data" button entry point.

    Finds every trade that's missing at least one timeframe of bars and
    schedules a background batch to fetch them. Returns immediately —
    the actual IB calls happen on a background task that processes one
    ticker at a time (per IB pacing rules); inside a ticker, the three
    timeframes fire concurrently.

    UI polls GET /api/trades/bars-status?tradeids=... to track progress.

    Connection is opened lazily here: if IBKR isn't connected yet (the
    common case at first click after startup), we attempt to connect to
    TWS / IB Gateway and only fail with 503 if that doesn't succeed.
    """
    # ensure_ib_connected() either returns the live client or raises a
    # 503 with a user-readable detail — no need for a separate check.
    await ensure_ib_connected(ib)

    try:
        tradeids = await find_incomplete_tradeids(db_conn)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to find incomplete trades: {e}",
        )

    scheduled, skipped = schedule_bar_fetch_batch(ib, db_pool, tradeids)
    logger.info(
        "fetch-bars-batch: scheduled=%d skipped_already_fetching=%d",
        len(scheduled), len(skipped),
    )
    return BarFetchBatchResult(
        scheduled=len(scheduled),
        skipped_already_fetching=skipped,
        tradeids=scheduled,
    )


@router.get("/bars-status", response_model=list[TradeBarStatus])
async def bars_status(
    tradeids: list[int] = Query(
        ...,
        description="Repeat the param: ?tradeids=1&tradeids=2",
    ),
    db_conn=Depends(get_db_conn),
):
    """
    Per-trade bar fetch status. UI polls this while a batch is running.

    For each requested tradeid we return:
      * symbol, date — pulled from the trades table so the UI can render
                       a human-readable row without a second round-trip
      * timeframes  — current row counts per (daily/30min/2min)
      * status      — pending | fetching | partial | done | error
      * last_error  — last background-fetch error, if any
    """
    if not tradeids:
        return []

    try:
        counts = await fetch_bar_counts_for_trades(db_conn, tradeids)
        # One query for symbol + date — the trades table has the canonical
        # values; we keep this endpoint a strict superset of what the UI
        # needs to render the table.
        trade_rows = await db_conn.fetch(
            "SELECT tradeid, symbol, date FROM trades WHERE tradeid = ANY($1::int[])",
            tradeids,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to read bar status: {e}",
        )

    trade_meta = {int(r["tradeid"]): r for r in trade_rows}

    out: list[TradeBarStatus] = []
    for tid in tradeids:
        meta = trade_meta.get(tid)
        if meta is None:
            # Trade was deleted between scheduling and polling — skip.
            continue
        per_tf = counts.get(tid, {tf.label: 0 for tf in TIMEFRAMES})
        status = compute_bar_status(tid, per_tf)
        out.append(TradeBarStatus(
            tradeid=tid,
            symbol=meta["symbol"],
            date=meta["date"],
            status=status,
            timeframes=[
                BarTimeframeStatus(timeframe=tf.label, rows=per_tf.get(tf.label, 0))
                for tf in TIMEFRAMES
            ],
            last_error=get_last_error(tid),
        ))
    return out


# ─── Trade CRUD + Review-page reads ───────────────────────────────────────────

@router.get("", response_model=list[Trade])
async def list_trades(
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    db_conn=Depends(get_db_conn),
):
    """List trades. With year/month filters or unfiltered (all)."""
    try:
        return await fetch_trades(db_conn, year=year, month=month)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list trades: {e}")


@router.get("/latest", response_model=Trade)
async def get_latest_trade(db_conn=Depends(get_db_conn)):
    """Return the trade with the largest `date`. Default landing row for the review page."""
    row = await db_conn.fetchrow(
        """
        SELECT tradeid, symbol, date, setup, intended_setup, observed_setup,
               price_action_rating, price_position, category, notes
        FROM trades
        ORDER BY date DESC, tradeid DESC
        LIMIT 1
        """
    )
    if row is None:
        raise HTTPException(status_code=404, detail="No trades yet.")
    return Trade(**dict(row))


@router.get("/{tradeid}", response_model=Trade)
async def get_trade(tradeid: int, db_conn=Depends(get_db_conn)):
    try:
        return await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch trade: {e}")


@router.patch("/{tradeid}", response_model=Trade)
async def patch_trade(tradeid: int, payload: TradeUpdate, db_conn=Depends(get_db_conn)):
    try:
        return await update_trade(db_conn, tradeid, payload)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update trade: {e}")


@router.delete("/{tradeid}")
async def remove_trade(tradeid: int, db_conn=Depends(get_db_conn)):
    try:
        await delete_trade(db_conn, tradeid)
        return {"deleted": tradeid}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete trade: {e}")


@router.get("/{tradeid}/executions", response_model=list[Execution])
async def list_trade_executions(tradeid: int, db_conn=Depends(get_db_conn)):
    """All executions linked to this trade (via executions.trade_fk = tradeid),
    ordered by fill time. Shape matches the existing Execution schema."""
    rows = await db_conn.fetch(
        """
        SELECT  tradeid    AS "tradeID",
                datetime   AS "dateTime",
                symbol,
                buysell    AS "buySell",
                quantity,
                tradeprice AS "tradePrice",
                iborderid  AS "ibOrderID",
                ibcommission AS "ibCommission"
        FROM    executions
        WHERE   trade_fk = $1
        ORDER BY datetime ASC
        """,
        tradeid,
    )
    return [Execution(**dict(r)) for r in rows]


@router.get("/{tradeid}/bars", response_model=BarsResponse)
async def get_trade_bars(
    tradeid: int,
    timeframe: str = Query(..., description="daily | 30min | 2min"),
    db_conn=Depends(get_db_conn),
):
    """All bars for (tradeid, timeframe) ordered chronologically.
    The full set is returned — bar counts per timeframe stay well under
    1000 (1Y daily ~250, 30D 30min ~390, 5D 2min ~975) so we don't
    paginate. Charts manage their own visible window."""
    tf = TIMEFRAME_BY_LABEL.get(timeframe)
    if tf is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown timeframe '{timeframe}'. Use one of: "
                   f"{', '.join(t.label for t in TIMEFRAMES)}.",
        )
    try:
        trade = await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    rows = await db_conn.fetch(
        f"""
        SELECT time, open, high, low, close, volume
        FROM   {tf.table}
        WHERE  tradeid = $1
        ORDER BY time ASC
        """,
        tradeid,
    )
    bars = [
        BarRowSchema(
            time=r["time"],
            open=r["open"], high=r["high"], low=r["low"], close=r["close"],
            volume=int(r["volume"]),
        )
        for r in rows
    ]

    # For the 2-min chart, Relatr needs a daily ATR scalar — pull the daily
    # series from `trade_bars_daily` and hand it to the indicator builder.
    # Other timeframes don't read indicators, so we skip the round-trip.
    daily_bars: list[BarRowSchema] | None = None
    if tf.label == "2min":
        daily_table = TIMEFRAME_BY_LABEL["daily"].table
        daily_rows = await db_conn.fetch(
            f"""
            SELECT time, open, high, low, close, volume
            FROM   {daily_table}
            WHERE  tradeid = $1
            ORDER BY time ASC
            """,
            tradeid,
        )
        daily_bars = [
            BarRowSchema(
                time=r["time"],
                open=r["open"], high=r["high"], low=r["low"], close=r["close"],
                volume=int(r["volume"]),
            )
            for r in daily_rows
        ]

    # Indicators (EMA9, anchored VWAP, Relatr, Rvol, …) are computed on the
    # bars we just read. Pure functions in `calculations/`, dispatched by
    # timeframe in `services.chart_indicators` so the same code can be
    # reused by the backtest layer later.
    indicators = build_indicators(tf.label, bars, daily_bars=daily_bars)
    return BarsResponse(
        tradeid=tradeid,
        symbol=trade.symbol,
        timeframe=tf.label,
        bars=bars,
        indicators=indicators,
    )


@router.get("/{tradeid}/neighbors", response_model=NeighborTrades)
async def get_trade_neighbors(tradeid: int, db_conn=Depends(get_db_conn)):
    """Adjacent tradeids in date order.

    Convention (matches user mental model):
      * prev_id = ONE STEP BACK IN TIME (older trade)
      * next_id = ONE STEP FORWARD IN TIME (newer trade)

    Ties are broken by tradeid so two trades sharing the same `date`
    still have a deterministic order.
    """
    try:
        current = await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # Older trade: (date, tradeid) STRICTLY less than the current.
    prev_row = await db_conn.fetchrow(
        """
        SELECT tradeid FROM trades
        WHERE  (date, tradeid) < ($1::timestamptz, $2::int)
        ORDER BY date DESC, tradeid DESC
        LIMIT 1
        """,
        current.date, current.tradeid,
    )
    # Newer trade: (date, tradeid) STRICTLY greater than the current.
    next_row = await db_conn.fetchrow(
        """
        SELECT tradeid FROM trades
        WHERE  (date, tradeid) > ($1::timestamptz, $2::int)
        ORDER BY date ASC, tradeid ASC
        LIMIT 1
        """,
        current.date, current.tradeid,
    )
    return NeighborTrades(
        current=tradeid,
        prev_id=int(prev_row["tradeid"]) if prev_row else None,
        next_id=int(next_row["tradeid"]) if next_row else None,
    )


@router.get("/{tradeid}/week", response_model=list[Trade])
async def get_trades_in_week(
    tradeid: int,
    offset: int = 0,
    db_conn=Depends(get_db_conn),
):
    """All trades in a Mon–Sun Helsinki week, anchored on this trade's week.

    `offset` shifts which week is returned, in whole weeks, relative to
    the anchor trade's week:
      *  0 → this trade's own week (default)
      * -1 → the week before
      * +1 → the week after
    Used by the weekly table's prev/next-week controls so the user can
    browse adjacent weeks without changing the reviewed trade.

    `execution_count` and `realized_pnl` are computed inline (mirroring
    the /day endpoint) so the weekly table can show per-trade fills + P/L
    and sum them for a week total without a second roundtrip. See the
    /day endpoint for notes on the signed-quantity arithmetic and the
    flat-vs-partially-closed caveat.
    """
    try:
        await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # `uncategorized_count`: LEFT JOIN order_categories on e.iborderid so
    # every fill of an uncategorised order has oc.iborderid = NULL. FILTER
    # then counts distinct e.iborderids where no category row exists.
    # A trade with no fills yields 0.
    rows = await db_conn.fetch(
        f"""
        WITH ref AS (
          SELECT date_trunc(
            'week',
            (date AT TIME ZONE '{LOCAL_TZ}')::date::timestamp
          ) + ($2::int * INTERVAL '1 week') AS week_start
          FROM trades WHERE tradeid = $1
        )
        SELECT t.tradeid, t.symbol, t.date, t.setup, t.intended_setup,
               t.observed_setup, t.price_action_rating, t.price_position,
               t.category, t.notes,
               COUNT(DISTINCT e.iborderid)::int AS execution_count,
               COUNT(DISTINCT e.iborderid)
                 FILTER (WHERE e.iborderid IS NOT NULL AND oc.iborderid IS NULL)
                 ::int AS uncategorized_count,
               CASE WHEN COUNT(e.tradeid) = 0 THEN NULL
                    ELSE COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                         + COALESCE(SUM(e.ibcommission), 0)
               END AS realized_pnl
        FROM   trades t
        CROSS JOIN ref
        LEFT JOIN executions e ON e.trade_fk = t.tradeid
        LEFT JOIN order_categories oc ON oc.iborderid = e.iborderid
        WHERE  date_trunc(
                 'week',
                 (t.date AT TIME ZONE '{LOCAL_TZ}')::date::timestamp
               ) = ref.week_start
        GROUP BY t.tradeid, ref.week_start
        ORDER BY t.date ASC, t.tradeid ASC
        """,
        tradeid,
        offset,
    )
    return [Trade(**dict(r)) for r in rows]

@router.get("/{tradeid}/day", response_model=list[Trade])
async def get_trades_on_day(tradeid: int, db_conn=Depends(get_db_conn)):
    """All trades on the same Helsinki calendar day as this trade.

    Ordered by each trade's earliest linked execution timestamp (so the
    trade that fired first in real time is first in the table). Trades
    with no executions yet fall back to NULLS LAST + tradeid.
    """
    try:
        await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # `realized_pnl` is computed inline so the daily table can show
    # per-trade P/L and the page can sum them for a day total without a
    # second roundtrip.
    #
    # `quantity` in executions is SIGNED — positive on BUY, negative on
    # SELL (carried straight from IB Flex). So per-row cash flow is
    # simply `-quantity * price`:
    #   * BUY  +70 @ 56.07  →  cash out  -70*56.07  = -3924.9
    #   * SELL -32 @ 55.52  →  cash in  -(-32)*55.52 = +1776.7
    #
    # `ibcommission` is stored negative (it's a cost), so summing it in
    # produces a net figure.
    #
    # NULL when no executions are linked yet — distinguishes "no fills"
    # from "fills that net to zero".
    #
    # Caveat: this is the *raw cash flow*, which equals realized P/L
    # only when the trade is flat (Σ quantity = 0). For partially-closed
    # positions the number includes the cost basis of the open shares.
    # `uncategorized_count`: LEFT JOIN order_categories on e.iborderid so
    # every fill of an uncategorised order has oc.iborderid = NULL. FILTER
    # then counts distinct e.iborderids where no category row exists.
    # A trade with no fills yields 0.
    rows = await db_conn.fetch(
        f"""
        WITH ref AS (
          SELECT (date AT TIME ZONE '{LOCAL_TZ}')::date AS local_day
          FROM   trades WHERE tradeid = $1
        )
        SELECT  t.tradeid, t.symbol, t.date, t.setup, t.intended_setup,
                t.observed_setup, t.price_action_rating, t.price_position,
                t.category, t.notes,
                COUNT(DISTINCT e.iborderid)::int AS execution_count,
                COUNT(DISTINCT e.iborderid)
                  FILTER (WHERE e.iborderid IS NOT NULL AND oc.iborderid IS NULL)
                  ::int AS uncategorized_count,
                CASE WHEN COUNT(e.tradeid) = 0 THEN NULL
                     ELSE COALESCE(SUM(-e.quantity * e.tradeprice), 0)
                          + COALESCE(SUM(e.ibcommission), 0)
                END AS realized_pnl
        FROM    trades t
        LEFT JOIN executions e ON e.trade_fk = t.tradeid
        LEFT JOIN order_categories oc ON oc.iborderid = e.iborderid
        WHERE   (t.date AT TIME ZONE '{LOCAL_TZ}')::date = (SELECT local_day FROM ref)
        GROUP BY t.tradeid
        ORDER BY MIN(e.datetime) ASC NULLS LAST, t.tradeid ASC
        """,
        tradeid,
    )
    return [Trade(**dict(r)) for r in rows]

