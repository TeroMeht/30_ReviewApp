"""
IBKR historical-bar fetching for trades.

For each trade we pull three timeframes (daily 1Y, 30min 30D, 2min 5D),
ending at the trade's `date`. RTH only, whatToShow='TRADES'. Each (tradeid,
timeframe) pair is fetched at most once: if rows already exist for that
combination we skip — manual retries can be done via the dedicated route.

Concurrency model — fully serial:
  Trades are processed one at a time. Within each trade, timeframes are
  fetched one at a time (sequential await, not asyncio.gather). This means
  only one IB historical-data request is ever in flight at any moment,
  which satisfies IB's pacing constraints without needing a lock.

`schedule_bar_fetch_batch` exposes a fire-and-forget API: it spawns an
asyncio background task and returns immediately. The task pulls fresh DB
connections from the app's pool, so it doesn't depend on the request's
connection lifetime.

Bar timestamps are stored TIMESTAMPTZ but normalised to Europe/Helsinki
before insert so reads return Helsinki-offset datetimes (matches the rest
of the app — executions and trades both bucket on Europe/Helsinki).
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


_HELSINKI_TZ = ZoneInfo(LOCAL_TZ)

# Per-request IB timeout. 60s is well above typical response time.
_IB_REQUEST_TIMEOUT_SEC: float = 60.0

# In-memory fetch status (reset on restart).
_IN_FLIGHT: set[int] = set()
_LAST_ERROR: dict[int, str] = {}


def is_fetching(tradeid: int) -> bool:
    return tradeid in _IN_FLIGHT


def get_last_error(tradeid: int) -> Optional[str]:
    return _LAST_ERROR.get(tradeid)


def compute_bar_status(tradeid: int, bar_counts: dict[str, int]) -> str:
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
    if isinstance(d, datetime):
        dt_utc = d if d.tzinfo is not None else d.replace(tzinfo=timezone.utc)
        return dt_utc.astimezone(_HELSINKI_TZ)
    if isinstance(d, date):
        return datetime.combine(d, dt_time(0, 0), tzinfo=_HELSINKI_TZ)
    raise TypeError(f"Unexpected bar.date type: {type(d).__name__}")


def _stock_contract(symbol: str) -> Stock:
    return Stock(symbol, "SMART", "USD")


def _window_end_for_trade(trade_date: datetime) -> datetime:
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
        "[bars %s/%s tradeid=%d] requesting: barSize=%s duration=%s end=%s",
        trade.symbol, tf.label, trade.tradeid, tf.bar_size, tf.duration, end_dt,
    )

    try:
        bars = await asyncio.wait_for(
            ib.reqHistoricalDataAsync(
                contract,
                endDateTime=end_dt,
                durationStr=tf.duration,
                barSizeSetting=tf.bar_size,
                whatToShow="TRADES",
                useRTH=False,
                formatDate=2,
            ),
            timeout=_IB_REQUEST_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "[bars %s/%s tradeid=%d] IB request timed out after %.0fs",
            trade.symbol, tf.label, trade.tradeid, _IB_REQUEST_TIMEOUT_SEC,
        )
        return BarFetchTimeframeResult(
            timeframe=tf.label, inserted=0, skipped=False,
            error=f"ib_timeout_{int(_IB_REQUEST_TIMEOUT_SEC)}s",
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
        return BarFetchTimeframeResult(timeframe=tf.label, inserted=0, skipped=False)

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
    return BarFetchTimeframeResult(timeframe=tf.label, inserted=inserted, skipped=False)


# ─── Trade-level fetch ────────────────────────────────────────────────────────

async def fetch_bars_for_trade(
    ib: IB,
    db_pool: asyncpg.Pool,
    trade: Trade,
) -> BarFetchResult:
    """
    Fetch all timeframes for a single trade, one at a time (serial).

    Each timeframe gets its own pooled DB connection. Per-timeframe failures
    are recorded but don't stop the remaining timeframes.
    """
    if not ib.isConnected():
        logger.warning("IB not connected; cannot fetch bars for tradeid=%d", trade.tradeid)
        return BarFetchResult(
            tradeid=trade.tradeid,
            symbol=trade.symbol,
            results=[
                BarFetchTimeframeResult(
                    timeframe=tf.label, inserted=0, skipped=False,
                    error="ib_not_connected",
                )
                for tf in TIMEFRAMES
            ],
        )

    results: list[BarFetchTimeframeResult] = []
    for tf in TIMEFRAMES:
        async with db_pool.acquire() as conn:
            try:
                result = await _fetch_one_timeframe(ib, conn, trade, tf)
            except Exception as e:
                logger.exception(
                    "[bars tradeid=%d %s/%s] unexpected error",
                    trade.tradeid, trade.symbol, tf.label,
                )
                result = BarFetchTimeframeResult(
                    timeframe=tf.label, inserted=0, skipped=False, error=str(e),
                )
        results.append(result)

    return BarFetchResult(tradeid=trade.tradeid, symbol=trade.symbol, results=results)


# ─── Incomplete-trade discovery ───────────────────────────────────────────────

async def find_incomplete_tradeids(db_conn: asyncpg.Connection) -> list[int]:
    """Return tradeids missing at least one timeframe of bar data."""
    not_exists_clauses = " OR ".join(
        f"NOT EXISTS (SELECT 1 FROM {tf.table} WHERE tradeid = t.tradeid)"
        for tf in TIMEFRAMES
    )
    sql = f"""
        SELECT t.tradeid
        FROM trades t
        WHERE {not_exists_clauses}
        ORDER BY t.tradeid ASC
    """
    rows = await db_conn.fetch(sql)
    return [int(r["tradeid"]) for r in rows]


# ─── Batch / queue ────────────────────────────────────────────────────────────

async def _process_batch(
    ib: IB,
    db_pool: asyncpg.Pool,
    tradeids: list[int],
) -> None:
    """
    Background worker: process each trade serially. Each trade's timeframes
    are also fetched serially, so only one IB request is ever in flight.
    """
    logger.info("Bar-fetch batch starting: %d trade(s) queued", len(tradeids))
    for tid in tradeids:
        try:
            async with db_pool.acquire() as conn:
                trade = await fetch_trade_by_id(conn, tid)
        except Exception as e:
            logger.exception("Bar-fetch: failed to load tradeid=%d", tid)
            _LAST_ERROR[tid] = f"load_trade: {e}"
            _IN_FLIGHT.discard(tid)
            continue

        try:
            result = await fetch_bars_for_trade(ib, db_pool, trade)
            errors = [r.error for r in result.results if r.error]
            if errors:
                _LAST_ERROR[tid] = "; ".join(errors)
            else:
                _LAST_ERROR.pop(tid, None)
        except Exception as e:
            logger.exception("Bar-fetch: tradeid=%d crashed", tid)
            _LAST_ERROR[tid] = str(e)
        finally:
            _IN_FLIGHT.discard(tid)

    logger.info("Bar-fetch batch finished")


def schedule_bar_fetch_batch(
    ib: IB,
    db_pool: asyncpg.Pool,
    tradeids: list[int],
) -> tuple[list[int], list[int]]:
    """
    Fire-and-forget: spawn a background task that processes `tradeids`
    one at a time. Returns (scheduled, skipped_already_fetching).
    """
    scheduled: list[int] = []
    skipped: list[int] = []
    for tid in tradeids:
        if tid in _IN_FLIGHT:
            skipped.append(tid)
            continue
        _IN_FLIGHT.add(tid)
        _LAST_ERROR.pop(tid, None)
        scheduled.append(tid)

    if scheduled:
        asyncio.create_task(
            _process_batch(ib, db_pool, scheduled),
            name=f"bar-fetch-batch[{len(scheduled)}]",
        )
    return scheduled, skipped
