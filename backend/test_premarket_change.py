"""
Manual smoke-test for indicators.premarket_change against real trades
in the ReviewApp DB.

Run from ``C:\\codebase\\prod\\30_ReviewApp\\backend``::

    uv run python test_premarket_change.py                # 20 most recent trades
    uv run python test_premarket_change.py --limit 50
    uv run python test_premarket_change.py --tradeid 123  # single trade

Prints one row per trade with the computed ``premarket_change_pct``
next to the inputs (``prev_close``, ``pm_last_price``) so you can
eyeball a couple against Finviz's premarket % for that ticker/date.

Only touches the DB (read-only) -- no bar rows are written.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import date, time
from typing import Optional
from zoneinfo import ZoneInfo

import asyncpg
import pandas as pd

from core.config import settings
from indicators.premarket_change import (
    DEFAULT_MARKET_OPEN,
    premarket_change_pct_series,
)


TZ = ZoneInfo(settings.TIMEZONE)


async def _fetch_recent_trades(
    conn: asyncpg.Connection, limit: int,
) -> list[asyncpg.Record]:
    return await conn.fetch(
        f"""
        SELECT tradeid,
               symbol,
               (date AT TIME ZONE '{settings.TIMEZONE}')::date AS local_date
        FROM trades
        ORDER BY date DESC
        LIMIT $1
        """,
        limit,
    )


async def _fetch_trade(
    conn: asyncpg.Connection, tradeid: int,
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        f"""
        SELECT tradeid,
               symbol,
               (date AT TIME ZONE '{settings.TIMEZONE}')::date AS local_date
        FROM trades
        WHERE tradeid = $1
        """,
        tradeid,
    )


async def _fetch_2min_bars(
    conn: asyncpg.Connection, tradeid: int,
) -> list[asyncpg.Record]:
    return await conn.fetch(
        """
        SELECT time, close
        FROM trade_bars_2min
        WHERE tradeid = $1
        ORDER BY time
        """,
        tradeid,
    )


async def _fetch_prev_daily_close(
    conn: asyncpg.Connection, tradeid: int, local_date: date,
) -> Optional[float]:
    """
    Close of the daily bar immediately preceding ``local_date`` for
    this trade's symbol. Returns None if no earlier daily bar exists.
    """
    val = await conn.fetchval(
        f"""
        SELECT close
        FROM trade_bars_daily
        WHERE tradeid = $1
          AND (time AT TIME ZONE '{settings.TIMEZONE}')::date < $2
        ORDER BY time DESC
        LIMIT 1
        """,
        tradeid, local_date,
    )
    return float(val) if val is not None else None


def _compute_row(
    tradeid: int,
    symbol: str,
    local_date: date,
    bars: list[asyncpg.Record],
    prev_close: Optional[float],
    market_open: time,
) -> dict:
    if not bars:
        return {
            "tradeid": tradeid, "symbol": symbol, "date": local_date,
            "prev_close": prev_close, "pm_last_price": None,
            "premarket_change_pct": None, "note": "no 2min bars",
        }

    df = pd.DataFrame(
        [{
            "symbol": symbol,
            "date":   b["time"].astimezone(TZ).date(),
            "time":   b["time"].astimezone(TZ).time(),
            "close":  float(b["close"]),
        } for b in bars]
    )
    # 2min table holds 5 days per trade — restrict to the trade's session.
    day_df = df[df["date"] == local_date].copy()

    prev_map = {symbol: prev_close if prev_close is not None else float("nan")}
    out = premarket_change_pct_series(
        day_df, prev_close_by_symbol=prev_map, market_open=market_open,
    )
    pct = (
        out["premarket_change_pct"].iloc[0]
        if not out.empty else None
    )

    pm_bars = day_df[day_df["time"] < market_open].sort_values("time")
    pm_last = float(pm_bars["close"].iloc[-1]) if not pm_bars.empty else None

    return {
        "tradeid": tradeid,
        "symbol": symbol,
        "date": local_date,
        "prev_close": prev_close,
        "pm_last_price": pm_last,
        "premarket_change_pct": pct,
        "note": "" if pm_last is not None else "no premarket bars",
    }


async def main(limit: int, tradeid: Optional[int], market_open: time) -> None:
    conn = await asyncpg.connect(dsn=settings.DATABASE_URL)
    try:
        if tradeid is not None:
            t = await _fetch_trade(conn, tradeid)
            trades = [t] if t else []
        else:
            trades = await _fetch_recent_trades(conn, limit)

        if not trades:
            print("No matching trades in DB.")
            return

        rows = []
        for t in trades:
            bars = await _fetch_2min_bars(conn, t["tradeid"])
            prev_close = await _fetch_prev_daily_close(
                conn, t["tradeid"], t["local_date"],
            )
            rows.append(_compute_row(
                t["tradeid"], t["symbol"], t["local_date"],
                bars, prev_close, market_open,
            ))

        report = pd.DataFrame(rows)
        pd.set_option("display.max_rows", None)
        pd.set_option("display.width", 200)
        print(report.to_string(index=False))
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit",   type=int, default=20,
                    help="How many most-recent trades to check (ignored if --tradeid is set).")
    ap.add_argument("--tradeid", type=int, default=None,
                    help="Check a single trade by id.")
    ap.add_argument("--market-open", type=str, default=None,
                    help="Override market open in HH:MM Helsinki local. "
                         "Default = 16:30 (09:30 ET).")
    args = ap.parse_args()

    if args.market_open:
        hh, mm = args.market_open.split(":")
        mo = time(int(hh), int(mm))
    else:
        mo = DEFAULT_MARKET_OPEN

    asyncio.run(main(args.limit, args.tradeid, mo))
