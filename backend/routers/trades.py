
import csv
import io
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Depends, Query, Response
import asyncpg

from data_sources.ib._client import IBSource
from core.config import settings
from dependencies import get_db_conn, get_db_pool, get_ib_source
from helpers.speed_metrics import compute_speed_series, DEFAULT_RELATR_THRESHOLD
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
      2. Auto-bucket: create trades from any unlinked executions and link
         them.
    """
    manual_entries = payload.manual_trades if payload else []
    try:
        manual_rows, manual_skipped = await insert_manual_trades(
            db_conn, manual_entries
        )
        auto_result = await sync_trades_from_executions(db_conn)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trade sync failed: {e}")

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
    source: IBSource = Depends(get_ib_source),
):
    """
    "Update Market Data" button entry point.
    """
    if not source.ib.isConnected():
        raise HTTPException(
            status_code=503,
            detail=(
                "IBKR is not connected. Start TWS / IB Gateway and restart "
                "the backend."
            ),
        )

    try:
        tradeids = await find_incomplete_tradeids(db_conn)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to find incomplete trades: {e}",
        )

    scheduled, skipped = schedule_bar_fetch_batch(source, db_pool, tradeids)
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
    if not tradeids:
        return []

    try:
        counts = await fetch_bar_counts_for_trades(db_conn, tradeids)
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
        SELECT tradeid, symbol, date, setup, category, notes
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

    indicators = build_indicators(tf.label, bars, daily_bars=daily_bars, symbol=trade.symbol)
    return BarsResponse(
        tradeid=tradeid,
        symbol=trade.symbol,
        timeframe=tf.label,
        bars=bars,
        indicators=indicators,
    )


# ─── Full-dataset CSV export ──────────────────────────────────────────────────

_CSV_FIELDS = [
    "timeframe", "tradeid", "symbol",
    "trade_date", "trade_setup", "trade_category",
    "time", "open", "high", "low", "close", "volume",
    "ema9", "vwap", "relatr", "rvol", "sma200",
    # Speed of move (% per 2min bar) — anchored on the most recent EMA9
    # cross-down (long setup). Populated only on 2min bars where
    # |relatr| >= 0.45. See helpers/speed_metrics.py for the concept.
    "speed_pct_per_bar",
]


def _fmt_indicator(v: Optional[float]) -> str:
    """Indicator values: 6 decimals when present, empty when None."""
    if v is None:
        return ""
    return f"{v:.6f}"


@router.get("/{tradeid}/dataset.csv")
async def download_trade_dataset_csv(
    tradeid: int,
    db_conn=Depends(get_db_conn),
):
    """
    Full trade dataset as one CSV: every bar from every timeframe
    (daily, 30min, 2min) linked to this trade, plus the computed
    indicator values (EMA9 / VWAP / Relatr / Rvol on the 2min set,
    SMA200 on the daily set) merged onto each bar by timestamp.
    Blank cells where the indicator doesn't apply for that timeframe.
    Suitable for offline analysis, model training, or spot-checking.

    Filename is set via Content-Disposition so a browser
    <a href download> gets a meaningful name automatically.
    """
    try:
        trade = await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # Fetch every timeframe's bars in one loop -- same shape the
    # /bars endpoint uses, minus its response_model wrapping.
    per_tf: dict[str, list[BarRowSchema]] = {}
    for tf in TIMEFRAMES:
        rows = await db_conn.fetch(
            f"""
            SELECT time, open, high, low, close, volume
            FROM   {tf.table}
            WHERE  tradeid = $1
            ORDER BY time ASC
            """,
            tradeid,
        )
        per_tf[tf.label] = [
            BarRowSchema(
                time=r["time"],
                open=r["open"], high=r["high"], low=r["low"], close=r["close"],
                volume=int(r["volume"]),
            )
            for r in rows
        ]

    # Build indicators per timeframe. 2min needs the daily bars as
    # ATR input (same wiring as get_trade_bars above).
    daily_bars = per_tf.get("daily") or None
    indicators_by_tf = {
        tf.label: build_indicators(
            tf.label,
            per_tf[tf.label],
            daily_bars=daily_bars if tf.label == "2min" else None,
            symbol=trade.symbol,
        )
        for tf in TIMEFRAMES
    }

    # Emit both `trade_date` and each bar's `time` in the app's
    # configured wall-clock timezone (settings.TIMEZONE = Europe/Helsinki),
    # matching what the chart's x-axis shows. Raw UTC readings out of
    # asyncpg (offset +00) are confusing to eyeball against the chart --
    # the DST-aware conversion below keeps them aligned.
    tz = ZoneInfo(settings.TIMEZONE)
    trade_date_local = trade.date.astimezone(tz).isoformat()
    # For the filename we want the LOCAL calendar day of the trade,
    # not the UTC calendar day (which for post-midnight-Helsinki trades
    # rolls back one date).
    trade_day = trade.date.astimezone(tz).date().isoformat()

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=_CSV_FIELDS, lineterminator="\n")
    writer.writeheader()

    for tf in TIMEFRAMES:
        bars = per_tf[tf.label]
        # {indicator_name: {bar_ts: value}} lookup for O(1) merge by ts.
        # IndicatorPoint.time is copied directly from BarRow.time inside
        # build_indicators, so equality-by-datetime is safe here.
        ind_lookups: dict[str, dict] = {
            s.name: {p.time: p.value for p in s.points}
            for s in indicators_by_tf[tf.label]
        }
        # Speed of move: running value at every 2min bar where an EMA9
        # cross-down anchor is active. Filtered to bars where |relatr|
        # >= 0.45 for the CSV — every other bar (and every daily / 30min
        # row) leaves the column blank. Long-side anchor for now.
        if tf.label == "2min":
            relatr_lookup = ind_lookups.get("relatr", {})
            speed_running = compute_speed_series(
                bars,
                ema9_by_time=ind_lookups.get("ema9", {}),
                direction="long",
            )
            speed_by_time = {
                t: v for t, v in speed_running.items()
                if v is not None
                and (r := relatr_lookup.get(t)) is not None
                and abs(float(r)) >= DEFAULT_RELATR_THRESHOLD
            }
        else:
            speed_by_time = {}

        for b in bars:
            sp = speed_by_time.get(b.time)
            writer.writerow({
                "timeframe":       tf.label,
                "tradeid":         tradeid,
                "symbol":          trade.symbol,
                "trade_date":      trade_date_local,
                "trade_setup":     trade.setup or "",
                "trade_category":  trade.category or "",
                "time":            b.time.astimezone(tz).isoformat(),
                # Decimal -> plain string keeps the DB precision intact
                # in a way Excel / pandas both read cleanly.
                "open":            str(b.open),
                "high":            str(b.high),
                "low":             str(b.low),
                "close":           str(b.close),
                "volume":          b.volume,
                "ema9":            _fmt_indicator(ind_lookups.get("ema9",   {}).get(b.time)),
                "vwap":            _fmt_indicator(ind_lookups.get("vwap",   {}).get(b.time)),
                "relatr":          _fmt_indicator(ind_lookups.get("relatr", {}).get(b.time)),
                "rvol":            _fmt_indicator(ind_lookups.get("rvol",   {}).get(b.time)),
                "sma200":          _fmt_indicator(ind_lookups.get("sma200", {}).get(b.time)),
                "speed_pct_per_bar": _fmt_indicator(sp),
            })

    filename = f"trade_{tradeid}_{trade.symbol}_{trade_day}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{tradeid}/neighbors", response_model=NeighborTrades)
async def get_trade_neighbors(tradeid: int, db_conn=Depends(get_db_conn)):
    """Adjacent tradeids in date order."""
    try:
        current = await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    prev_row = await db_conn.fetchrow(
        """
        SELECT tradeid FROM trades
        WHERE  (date, tradeid) < ($1::timestamptz, $2::int)
        ORDER BY date DESC, tradeid DESC
        LIMIT 1
        """,
        current.date, current.tradeid,
    )
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
    """All trades in a Mon–Sun Helsinki week, anchored on this trade's week."""
    try:
        await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    rows = await db_conn.fetch(
        f"""
        WITH ref AS (
          SELECT date_trunc(
            'week',
            (date AT TIME ZONE '{settings.TIMEZONE}')::date::timestamp
          ) + ($2::int * INTERVAL '1 week') AS week_start
          FROM trades WHERE tradeid = $1
        )
        SELECT t.tradeid, t.symbol, t.date, t.setup,
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
                 (t.date AT TIME ZONE '{settings.TIMEZONE}')::date::timestamp
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
    """All trades on the same Helsinki calendar day as this trade."""
    try:
        await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    rows = await db_conn.fetch(
        f"""
        WITH ref AS (
          SELECT (date AT TIME ZONE '{settings.TIMEZONE}')::date AS local_day
          FROM   trades WHERE tradeid = $1
        )
        SELECT  t.tradeid, t.symbol, t.date, t.setup,
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
        WHERE   (t.date AT TIME ZONE '{settings.TIMEZONE}')::date = (SELECT local_day FROM ref)
        GROUP BY t.tradeid
        ORDER BY MIN(e.datetime) ASC NULLS LAST, t.tradeid ASC
        """,
        tradeid,
    )
    return [Trade(**dict(r)) for r in rows]
