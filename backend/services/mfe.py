"""
MFE (Maximum Favorable Excursion) computation.

Given a trade + a picked entry order + an initial stop price, walk the
2-min bars from the entry timestamp forward through the end of the US
regular-hours session (16:00 America/New_York) on the entry's trading
day. Compute:

  * MFE peak     — max(bar.high) for long entries, min(bar.low) for short.
  * Potential PnL — (peak - entry) * qty for long, (entry - peak) * qty
                    for short. Uses the picked entry order's qty only.
  * Chronological stop check — walk bars in time order; if bar.low <= stop
                    (long) or bar.high >= stop (short) at any bar strictly
                    before the MFE peak bar, mark stopped_out and cap
                    potential_pnl at actual_pnl. The MFE run wasn't
                    realistically capturable because the stop would have
                    taken you out first.

Actual PnL is the trade's cumulative realized P/L across every
execution: SUM(-quantity * tradeprice) + SUM(ibcommission). Same
formula the /trades/{id}/day endpoint uses. This is the raw cash-flow
figure — for a flat trade it equals realised P/L; for a partially open
trade it includes the cost basis of the open shares. The comparison
"actual vs potential" is still meaningful in both cases, but the user
should be aware.

All values are computed on-the-fly on every read — no caching. This
keeps bar backfills and stop-edits reflected immediately.
"""

from datetime import datetime
from decimal import Decimal
from typing import Optional
from zoneinfo import ZoneInfo

import asyncpg

from db.trade_bars import TIMEFRAME_BY_LABEL
from schemas.api_schemas import TradeMfeConfig, TradeMfeResult


# US regular trading hours end. Bars past this timestamp on the entry
# trading day are excluded from the MFE window.
_NY_TZ = ZoneInfo("America/New_York")
_RTH_END_HOUR = 16
_RTH_END_MINUTE = 0


async def _fetch_entry_order_aggregate(
    db_conn: asyncpg.Connection,
    trade_fk: int,
    iborderid: str,
) -> Optional[dict]:
    """Return the aggregate of the picked entry order:
        {
            'earliest_time': datetime,   # first fill in the order
            'buysell': 'BUY' | 'SELL',
            'total_qty': int,            # sum of fill quantities (signed
                                         # per IB Flex: +BUY, -SELL)
            'avg_price': Decimal,        # qty-weighted average fill price
        }
    Returns None if no fills match — the picked iborderid is stale
    (order was removed or belongs to another trade).
    """
    row = await db_conn.fetchrow(
        """
        SELECT MIN(datetime)                         AS earliest_time,
               MAX(buysell)                          AS buysell,
               SUM(quantity)                         AS total_qty,
               (SUM(quantity * tradeprice)
                 / NULLIF(SUM(quantity), 0))         AS avg_price
        FROM   executions
        WHERE  trade_fk = $1 AND iborderid = $2
        """,
        trade_fk, iborderid,
    )
    if row is None or row["earliest_time"] is None:
        return None
    return dict(row)


async def _fetch_actual_pnl(
    db_conn: asyncpg.Connection,
    trade_fk: int,
) -> Optional[Decimal]:
    """Cumulative realised P/L across every execution for the trade.

    Matches the formula used by /trades/{id}/day: -quantity * price is
    the signed cash flow (BUY drains cash, SELL adds cash because
    quantity is negative), plus ibcommission (stored negative).
    Returns None if the trade has no executions yet.
    """
    row = await db_conn.fetchrow(
        """
        SELECT COUNT(*)::int AS n,
               COALESCE(SUM(-quantity * tradeprice), 0)
                 + COALESCE(SUM(ibcommission), 0) AS pnl
        FROM   executions
        WHERE  trade_fk = $1
        """,
        trade_fk,
    )
    if row is None or int(row["n"]) == 0:
        return None
    return Decimal(row["pnl"])


async def _fetch_2min_bars_in_window(
    db_conn: asyncpg.Connection,
    trade_fk: int,
    entry_time: datetime,
) -> list[dict]:
    """Return every 2-min bar for the trade with time >= entry_time and
    strictly on/before RTH close on the entry's NY trading day.
    Ordered chronologically. Bars are dicts of {time, high, low}.
    """
    tf_table = TIMEFRAME_BY_LABEL["2min"].table

    # Compute the NY-tz end-of-RTH timestamp for the entry day. Doing
    # this in Python (rather than SQL) keeps the timezone math obvious
    # and avoids DST corner cases in Postgres AT TIME ZONE arithmetic.
    ny_entry = entry_time.astimezone(_NY_TZ)
    ny_rth_end = ny_entry.replace(
        hour=_RTH_END_HOUR, minute=_RTH_END_MINUTE,
        second=0, microsecond=0,
    )
    # If the entry was somehow after 16:00 ET (post-market fill), the
    # window would be empty; return an empty list rather than an error.
    if ny_entry > ny_rth_end:
        return []

    rows = await db_conn.fetch(
        f"""
        SELECT time, high, low
        FROM   {tf_table}
        WHERE  tradeid = $1
          AND  time >= $2
          AND  time <= $3
        ORDER BY time ASC
        """,
        trade_fk, entry_time, ny_rth_end.astimezone(entry_time.tzinfo or _NY_TZ),
    )
    return [
        {"time": r["time"], "high": Decimal(r["high"]), "low": Decimal(r["low"])}
        for r in rows
    ]


async def compute_mfe(
    db_conn: asyncpg.Connection,
    trade_fk: int,
    config: Optional[TradeMfeConfig],
) -> TradeMfeResult:
    """Compute the MFE result for a trade given its stored config.

    Handles every "not enough data" case explicitly — the endpoint
    always returns a well-formed result so the frontend can render
    consistent state ("pick an entry", "no bars yet", etc.) without
    error handling.
    """
    actual_pnl = await _fetch_actual_pnl(db_conn, trade_fk)

    # No config saved yet — nothing to compute, just echo the trade.
    if config is None:
        return TradeMfeResult(
            trade_fk=trade_fk,
            actual_pnl=actual_pnl,
            note="No MFE config saved. Pick an entry order + stop to compute.",
        )

    agg = await _fetch_entry_order_aggregate(
        db_conn, trade_fk, config.entry_iborderid,
    )
    if agg is None:
        return TradeMfeResult(
            trade_fk=trade_fk,
            config=config,
            actual_pnl=actual_pnl,
            note=(
                f"Stored entry order {config.entry_iborderid!r} has no "
                f"matching executions on this trade."
            ),
        )

    # Signed qty per IB Flex: BUY positive, SELL negative. Direction is
    # taken from the side; qty magnitude from abs(total_qty).
    signed_qty = int(agg["total_qty"])
    direction = "long" if signed_qty > 0 else "short" if signed_qty < 0 else None
    entry_qty = abs(signed_qty)
    entry_price = Decimal(agg["avg_price"])
    entry_time = agg["earliest_time"]

    if direction is None or entry_qty == 0:
        return TradeMfeResult(
            trade_fk=trade_fk,
            config=config,
            entry_price=entry_price,
            entry_time=entry_time,
            entry_qty=0,
            actual_pnl=actual_pnl,
            note="Picked entry order has zero net quantity — cannot compute MFE.",
        )

    bars = await _fetch_2min_bars_in_window(db_conn, trade_fk, entry_time)
    if not bars:
        return TradeMfeResult(
            trade_fk=trade_fk,
            config=config,
            direction=direction,
            entry_price=entry_price,
            entry_time=entry_time,
            entry_qty=entry_qty,
            actual_pnl=actual_pnl,
            bars_considered=0,
            note=(
                "No 2-min bars found in the entry → end-of-RTH window. "
                "Try running the market-data fetch on this trade."
            ),
        )

    # Chronological walk. Track:
    #   * running peak = max high (long) / min low (short)
    #   * running peak bar time
    #   * whether the stop was breached before the current peak bar
    stop = Decimal(config.initial_stop_price)
    peak_price: Optional[Decimal] = None
    peak_time: Optional[datetime] = None
    stopped_out = False
    stopped_out_time: Optional[datetime] = None

    for bar in bars:
        t = bar["time"]
        high = bar["high"]
        low = bar["low"]

        # 1. Stop check FIRST — this bar's adverse extreme is checked
        #    against the stop BEFORE we let this bar update the peak.
        #    A bar that both prints a new peak high and dips through
        #    the stop on the same bar counts as stopped-out. The 2-min
        #    resolution doesn't tell us intra-bar order.
        if not stopped_out:
            adverse_hit = (
                (direction == "long" and low <= stop) or
                (direction == "short" and high >= stop)
            )
            if adverse_hit:
                stopped_out = True
                stopped_out_time = t

        # 2. Peak update (whether or not the stop was breached — we still
        #    want to report the peak for context; potential_pnl will be
        #    capped below).
        if direction == "long":
            if peak_price is None or high > peak_price:
                peak_price = high
                peak_time = t
        else:  # short
            if peak_price is None or low < peak_price:
                peak_price = low
                peak_time = t

    # Compute potential PnL from peak. `entry_qty` is unsigned, so we
    # just apply the sign convention per direction.
    if peak_price is None:
        # Shouldn't happen (bars was non-empty) but guard anyway.
        potential_pnl: Optional[Decimal] = None
    elif direction == "long":
        potential_pnl = (peak_price - entry_price) * Decimal(entry_qty)
    else:
        potential_pnl = (entry_price - peak_price) * Decimal(entry_qty)

    # Cap at actual when stopped out — a stop-run before the peak means
    # the MFE run wasn't realistically capturable.
    if stopped_out and actual_pnl is not None:
        potential_pnl = actual_pnl

    return TradeMfeResult(
        trade_fk=trade_fk,
        config=config,
        direction=direction,
        entry_price=entry_price,
        entry_time=entry_time,
        entry_qty=entry_qty,
        mfe_price=peak_price,
        mfe_time=peak_time,
        potential_pnl=potential_pnl,
        stopped_out=stopped_out,
        stopped_out_time=stopped_out_time,
        actual_pnl=actual_pnl,
        bars_considered=len(bars),
    )
