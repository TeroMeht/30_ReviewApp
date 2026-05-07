"""
IBKR historical-bar fetching for trades.

For each trade we pull three timeframes (daily 1Y, 30min 30D, 2min 5D),
ending at the trade's `date`. RTH only, whatToShow='TRADES'. Each (tradeid,
timeframe) pair is fetched at most once: if rows already exist for that
combination we skip — manual retries can be done via the dedicated route.

`schedule_bar_fetch` exposes a fire-and-forget API: it spawns an asyncio
background task and returns immediately. The task pulls a fresh DB
connection from the app's pool, so it doesn't depend on the request's
connection lifetime.
"""

import asyncio
from datetime import datetime, date, time as dt_time, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import asyncpg
from ib_async import IB, Stock

from schemas.api_schemas import (
    Trade,
    BarFetchResult,
    BarFetchTimeframeResult,
)
from db.trades import fetch_trade_by_id, LOCAL_TZ
from db.trade_bars import (
    TIMEFRAMES,
    TimeframeSpec,
    BarRow,
    count_bars,
    insert_bars,
)

import logging
logger = logging.getLogger(__name__)


# ─── In-memory bar-fetch status tracking ──────────────────────────────────────
#
# These maps let the UI show per-trade fetch status while a background task
# is running. They are intentionally process-local and reset on restart.
#
#   _IN_FLIGHT  — tradeids whose bar fetch is currently scheduled / running
#   _LAST_ERROR — last error message from a failed background fetch
#                 (cleared once a fresh fetch is scheduled for that tradeid)
_IN_FLIGHT: set[int] = set()
_LAST_ERROR: dict[int, str] = {}


def is_fetching(tradeid: int) -> bool:
    """True if a background bar fetch is currently in-flight for this trade."""
    return tradeid in _IN_FLIGHT


def get_last_error(tradeid: int) -> Optional[str]:
    """Return the last background-fetch error for a trade, or None."""
    return _LAST_ERROR.get(tradeid)


def compute_bar_status(
    tradeid: int,
    bar_counts: dict[str, int],
) -> str:
    """
    Compute a single status string from bar counts + in-flight state.

    States:
      - "fetching" : a background fetch is currently running
      - "error"    : last fetch errored AND no full set of bars yet
      - "done"     : every timeframe in TIMEFRAMES has at least 1 bar
      - "partial"  : 1+ but not all timeframes have bars
      - "pending"  : no bars yet
    """
    if tradeid in _IN_FLIGHT:
        return "fetching"

    populated = sum(1 for tf in TIMEFRAMES if bar_counts.get(tf.label, 0) > 0)
    total = len(TIMEFRAMES)
    if populated == total:
        return "done"
    if populated > 0:
        return "partial"
    if tradeid in _LAST_ERROR:
        return "error"
    return "pending"


async def fetch_bar_counts_for_trades(
    db_conn: asyncpg.Connection,
    tradeids: list[int],
) -> dict[int, dict[str, int]]:
    """For each tradeid, return a {timeframe_label: row_count} map."""
    out: dict[int, dict[str, int]] = {tid: {tf.label: 0 for tf in TIMEFRAMES} for tid in tradeids}
    if not tradeids:
        return out

    for tf in TIMEFRAMES:
        rows = await db_conn.fetch(
            f"""
            SELECT tradeid, COUNT(*) AS n
            FROM {tf.table}
            WHERE tradeid = ANY($1::int[])
            GROUP BY tradeid
            """,
            tradeids,
        )
        for r in rows:
            out[int(r["tradeid"])][tf.label] = int(r["n"])
    return out


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _bar_time_to_datetime(d) -> datetime:
    """
    ib_async returns `bar.date` as a `datetime` for intraday bars and a `date`
    for daily bars. Normalise both to a tz-aware UTC datetime so the column
    type (TIMESTAMPTZ) is consistent across all three tables.
    """
    if isinstance(d, datetime):
        if d.tzinfo is None:
            return d.replace(tzinfo=timezone.utc)
        return d
    if isinstance(d, date):
        return datetime.combine(d, dt_time(0, 0), tzinfo=timezone.utc)
    raise TypeError(f"Unexpected bar.date type: {type(d).__name__}")


def _stock_contract(symbol: str) -> Stock:
    """US stocks via SMART/USD per the locked-in design choice."""
    return Stock(symbol, "SMART", "USD")


def _window_end_for_trade(trade_date: datetime) -> datetime:
    """
    End of the historical bar window for a trade. We want the window to fully
    include the trade's calendar day in local time (so the user sees the
    pre-trade context AND the trade itself unfolding), capped at 'now' so we
    never request a future end date.
    """
    local = trade_date.astimezone(ZoneInfo(LOCAL_TZ))
    end_local = local.replace(hour=23, minute=59, second=59, microsecond=0)
    end_utc = end_local.astimezone(timezone.utc)
    now = datetime.now(timezone.utc)
    return min(end_utc, now)


# ─── Per-timeframe fetch ──────────────────────────────────────────────────────

async def _fetch_one_timeframe(
    ib: IB,
    db_conn: asyncpg.Connection,
    trade: Trade,
    tf: TimeframeSpec,
) -> BarFetchTimeframeResult:
    """Fetch + persist one timeframe for one trade. Skip if already populated."""
    existing = await count_bars(db_conn, trade.tradeid, tf)
    if existing > 0:
        logger.info(
            "[bars %s/%s tradeid=%d] skipping — %d rows already present",
            trade.symbol, tf.label, trade.tradeid, existing,
        )
        return BarFetchTimeframeResult(
            timeframe=tf.label, inserted=0, skipped=True, existing=existing,
        )

    contract = _stock_contract(trade.symbol)
    end_dt = _window_end_for_trade(trade.date)
    logger.info(
        "[bars %s/%s tradeid=%d] requesting: barSize=%s duration=%s end=%s (trade.date=%s)",
        trade.symbol, tf.label, trade.tradeid, tf.bar_size, tf.duration, end_dt, trade.date,
    )

    try:
        bars = await ib.reqHistoricalDataAsync(
            contract,
            endDateTime=end_dt,
            durationStr=tf.duration,
            barSizeSetting=tf.bar_size,
            whatToShow="TRADES",
            useRTH=False,
            formatDate=2,  # tz-aware UTC datetime / date for daily
        )
    except Exception as e:
        logger.exception(
            "[bars %s/%s tradeid=%d] IB request failed: %s",
            trade.symbol, tf.label, trade.tradeid, e,
        )
        return BarFetchTimeframeResult(
            timeframe=tf.label, inserted=0, skipped=False, error=str(e),
        )

    if not bars:
        logger.warning(
            "[bars %s/%s tradeid=%d] IB returned no bars",
            trade.symbol, tf.label, trade.tradeid,
        )
        return BarFetchTimeframeResult(
            timeframe=tf.label, inserted=0, skipped=False,
        )

    rows: list[BarRow] = []
    for b in bars:
        try:
            rows.append(BarRow(
                tradeid=trade.tradeid,
                time=_bar_time_to_datetime(b.date),
                open=float(b.open),
                high=float(b.high),
                low=float(b.low),
                close=float(b.close),
                volume=int(b.volume) if b.volume is not None else 0,
            ))
        except Exception:
            logger.exception(
                "[bars %s/%s tradeid=%d] failed to coerce bar: %r",
                trade.symbol, tf.label, trade.tradeid, b,
            )

    inserted = await insert_bars(db_conn, tf, rows)
    logger.info(
        "[bars %s/%s tradeid=%d] inserted %d bars (IB returned %d)",
        trade.symbol, tf.label, trade.tradeid, inserted, len(bars),
    )
    return BarFetchTimeframeResult(
        timeframe=tf.label, inserted=inserted, skipped=False,
    )


# ─── Trade-level fetch ────────────────────────────────────────────────────────

async def fetch_bars_for_trade(
    ib: IB,
    db_conn: asyncpg.Connection,
    trade: Trade,
) -> BarFetchResult:
    """Fetch all three timeframes for a single trade. Best-effort: per-tf failures don't abort the others."""
    if not ib.isConnected():
        msg = f"IB not connected; cannot fetch bars for tradeid={trade.tradeid}"
        logger.warning(msg)
        return BarFetchResult(
            tradeid=trade.tradeid,
            symbol=trade.symbol,
            results=[
                BarFetchTimeframeResult(timeframe=tf.label, inserted=0, skipped=False, error="ib_not_connected")
                for tf in TIMEFRAMES
            ],
        )

    results: list[BarFetchTimeframeResult] = []
    for tf in TIMEFRAMES:
        res = await _fetch_one_timeframe(ib, db_conn, trade, tf)
        results.append(res)
    return BarFetchResult(
        tradeid=trade.tradeid, symbol=trade.symbol, results=results,
    )


