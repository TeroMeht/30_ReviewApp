"""
IBKR historical-bar fetching for trades.

For each trade we pull three timeframes (daily 1Y, 30min 30D, 2min 5D),
ending at the trade's `date`. RTH only, whatToShow='TRADES'. Each (tradeid,
timeframe) pair is fetched at most once: if rows already exist for that
combination we skip — manual retries can be done via the dedicated route.

Concurrency model — IB pacing constraint:
  IBKR throttles historical-data requests aggressively, so we serialise
  per-ticker work with a single process-wide `asyncio.Lock`
  (`_TICKER_LOCK`). At most one trade is ever requesting bars at a time.
  Inside the lock the three timeframes for that trade fire concurrently
  via `asyncio.gather` (one DB connection per timeframe) — that's what
  the user signed off on as "the 3 timeframes can fire async, but the
  next ticker waits".

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


# Helsinki zone — bar timestamps are converted to this before insert so the
# TIMESTAMPTZ values returned by the DB are already in the local zone.
_HELSINKI_TZ = ZoneInfo(LOCAL_TZ)


# ─── IB pacing lock ───────────────────────────────────────────────────────────
#
# Process-wide lock that serialises per-ticker IB requests. Acquired around
# the gather() of a single trade's three timeframes; released before moving
# to the next trade in the queue. If two batches are scheduled concurrently
# (e.g. user double-clicks the button) they share this lock so the IB
# pacing guarantee still holds.
_TICKER_LOCK: asyncio.Lock = asyncio.Lock()


# ─── IB request timeout ──────────────────────────────────────────────────────
#
# `ib.reqHistoricalDataAsync` will occasionally never return — IB acknowledges
# the request but then never sends data and never sends an error. Without a
# timeout the await blocks forever, which means `_TICKER_LOCK` is held forever
# and the entire batch queue freezes. We wrap each request in `asyncio.wait_for`
# so a hang is converted to a TimeoutError, the timeframe is marked as errored,
# the lock is released, and the next trade in the queue can proceed.
#
# 60s is well above IB's typical historical-data response time (a few seconds
# to ~20s for large 2-min/5-day pulls) so genuine slow responses still succeed.
_IB_REQUEST_TIMEOUT_SEC: float = 60.0


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
    for daily bars. Normalise both to a tz-aware Europe/Helsinki datetime —
    asyncpg will write the same instant into TIMESTAMPTZ; on read it comes
    back in the Helsinki offset, which matches how the rest of the app
    timestamps user-facing data.
    """
    if isinstance(d, datetime):
        # Intraday bars: with formatDate=2 IB returns tz-aware UTC datetimes.
        # Some IB code paths still hand back naive datetimes, so default to UTC.
        dt_utc = d if d.tzinfo is not None else d.replace(tzinfo=timezone.utc)
        return dt_utc.astimezone(_HELSINKI_TZ)
    if isinstance(d, date):
        # Daily bars: a naked `date`. Treat it as midnight Helsinki — that's
        # the local trading day boundary the user thinks in.
        return datetime.combine(d, dt_time(0, 0), tzinfo=_HELSINKI_TZ)
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
        bars = await asyncio.wait_for(
            ib.reqHistoricalDataAsync(
                contract,
                endDateTime=end_dt,
                durationStr=tf.duration,
                barSizeSetting=tf.bar_size,
                whatToShow="TRADES",
                useRTH=False,
                formatDate=2,  # tz-aware UTC datetime / date for daily
            ),
            timeout=_IB_REQUEST_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        # IB never sent data and never sent an error — most common hang mode.
        # Surface as a normal per-timeframe error so the rest of the queue
        # continues; the lock is released by the surrounding `async with`.
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
    db_pool: asyncpg.Pool,
    trade: Trade,
) -> BarFetchResult:
    """
    Fetch all three timeframes for a single trade. The 3 timeframes run
    concurrently with `asyncio.gather` (each on its own pooled connection
    so we don't share an asyncpg.Connection across concurrent statements).

    Acquires the global `_TICKER_LOCK` so this is the only ticker hitting
    IB while it runs — IB's pacing rules don't tolerate parallel
    historical-data requests across different contracts.

    Best-effort: per-timeframe failures don't abort the others; the failed
    timeframe just comes back with `error` set on its result.
    """
    if not ib.isConnected():
        logger.warning(
            "IB not connected; cannot fetch bars for tradeid=%d", trade.tradeid
        )
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

    async def _run_one(tf: TimeframeSpec) -> BarFetchTimeframeResult:
        # Each timeframe gets its own connection — asyncpg connections are
        # not safe for concurrent queries.
        async with db_pool.acquire() as conn:
            return await _fetch_one_timeframe(ib, conn, trade, tf)

    async with _TICKER_LOCK:
        logger.info(
            "[bars tradeid=%d %s] acquired IB ticker lock; firing %d timeframes",
            trade.tradeid, trade.symbol, len(TIMEFRAMES),
        )
        gathered = await asyncio.gather(
            *(_run_one(tf) for tf in TIMEFRAMES),
            return_exceptions=True,
        )

    results: list[BarFetchTimeframeResult] = []
    for tf, r in zip(TIMEFRAMES, gathered):
        if isinstance(r, BaseException):
            logger.exception(
                "[bars tradeid=%d %s/%s] timeframe task crashed",
                trade.tradeid, trade.symbol, tf.label, exc_info=r,
            )
            results.append(BarFetchTimeframeResult(
                timeframe=tf.label, inserted=0, skipped=False, error=str(r),
            ))
        else:
            results.append(r)

    return BarFetchResult(
        tradeid=trade.tradeid, symbol=trade.symbol, results=results,
    )


# ─── Incomplete-trade discovery ───────────────────────────────────────────────

async def find_incomplete_tradeids(db_conn: asyncpg.Connection) -> list[int]:
    """
    Return tradeids that are missing at least one timeframe of bar data.

    A trade is "complete" only when EVERY timeframe in TIMEFRAMES has at
    least one row. Any other state (zero rows, partial coverage) lands the
    trade in the returned list. Order: ascending by tradeid for determinism.

    Implementation note: we use OR'd NOT EXISTS subqueries instead of
    chaining LEFT JOINs. Multiple LEFT JOINs against the bar tables would
    produce a Cartesian product (e.g. 250 daily × 350 30-min × 1000 2-min
    rows per trade) which is a serious perf hazard once trades fill in.
    NOT EXISTS short-circuits per timeframe and uses the (tradeid, time)
    PK index on each bar table.
    """
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
    Background worker: drain `tradeids` one at a time, fetching bars for
    each. Per-trade failures are logged + surfaced via `_LAST_ERROR`; they
    do NOT abort the rest of the queue.

    `_IN_FLIGHT` is updated as each trade starts/finishes so the UI's
    status endpoint reflects progress in real time.
    """
    logger.info("Bar-fetch batch starting: %d trade(s) queued", len(tradeids))
    for tid in tradeids:
        try:
            # Trade row may have changed since scheduling — refetch.
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
    one at a time, returning (scheduled, skipped_already_fetching) where
      * scheduled  — tradeids accepted into this batch
      * skipped    — tradeids already in-flight from a previous batch

    The caller (route handler) returns immediately; the UI polls
    /api/trades/bars-status to track progress.
    """
    scheduled: list[int] = []
    skipped: list[int] = []
    for tid in tradeids:
        if tid in _IN_FLIGHT:
            skipped.append(tid)
            continue
        _IN_FLIGHT.add(tid)
        # Clear any stale error state — a fresh attempt is being made.
        _LAST_ERROR.pop(tid, None)
        scheduled.append(tid)

    if scheduled:
        # Detached task — exceptions are caught inside _process_batch so
        # we don't need to keep a reference for them. Naming helps debug.
        asyncio.create_task(
            _process_batch(ib, db_pool, scheduled),
            name=f"bar-fetch-batch[{len(scheduled)}]",
        )
    return scheduled, skipped


