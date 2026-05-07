"""
Per-timeframe bar tables: trade_bars_daily, trade_bars_30min, trade_bars_2min.

Each row is one OHLCV bar belonging to a specific trade. Composite PK
(tradeid, time) lets us upsert idempotently. ON DELETE CASCADE means deleting
a trade removes its bar history too.

Schema setup helpers are idempotent and called at app startup.
"""

import asyncpg
from datetime import datetime
from typing import Iterable, NamedTuple

import logging
logger = logging.getLogger(__name__)


class TimeframeSpec(NamedTuple):
    label: str          # e.g. "daily" — used in logs and as URL/key
    table: str          # PG table name
    bar_size: str       # IBKR barSizeSetting, e.g. "1 day", "30 mins", "2 mins"
    duration: str       # IBKR durationStr, e.g. "1 Y", "30 D", "5 D"


# Locked-in lookbacks: Daily 1Y / 30min 30D / 2min 5D, RTH only, TRADES.
TIMEFRAMES: list[TimeframeSpec] = [
    TimeframeSpec("daily", "trade_bars_daily", "1 day",  "1 Y"),
    TimeframeSpec("30min", "trade_bars_30min", "30 mins", "30 D"),
    TimeframeSpec("2min",  "trade_bars_2min",  "2 mins",  "5 D"),
]

# Fast lookup by label.
TIMEFRAME_BY_LABEL: dict[str, TimeframeSpec] = {t.label: t for t in TIMEFRAMES}


# ─── Schema setup ─────────────────────────────────────────────────────────────

async def create_trade_bars_tables(db_conn: asyncpg.Connection) -> None:
    """Create all three bar tables. Idempotent."""
    for tf in TIMEFRAMES:
        await db_conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {tf.table} (
                tradeid    INTEGER NOT NULL
                           REFERENCES trades(tradeid) ON DELETE CASCADE,
                time       TIMESTAMPTZ NOT NULL,
                open       NUMERIC(14, 4) NOT NULL,
                high       NUMERIC(14, 4) NOT NULL,
                low        NUMERIC(14, 4) NOT NULL,
                close      NUMERIC(14, 4) NOT NULL,
                volume     BIGINT NOT NULL,
                PRIMARY KEY (tradeid, time)
            )
        """)
        await db_conn.execute(f"""
            CREATE INDEX IF NOT EXISTS {tf.table}_tradeid_idx
            ON {tf.table} (tradeid)
        """)
        logger.info("Bar table ready: %s", tf.table)


# ─── Read helpers ─────────────────────────────────────────────────────────────

async def count_bars(
    db_conn: asyncpg.Connection,
    tradeid: int,
    timeframe: TimeframeSpec,
) -> int:
    """How many bar rows exist for (tradeid, timeframe)?"""
    n = await db_conn.fetchval(
        f"SELECT COUNT(*) FROM {timeframe.table} WHERE tradeid = $1",
        tradeid,
    )
    return int(n or 0)


# ─── Write helpers ────────────────────────────────────────────────────────────

class BarRow(NamedTuple):
    tradeid: int
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int


async def insert_bars(
    db_conn: asyncpg.Connection,
    timeframe: TimeframeSpec,
    rows: Iterable[BarRow],
) -> int:
    """Bulk insert bars. ON CONFLICT DO NOTHING so re-runs are safe."""
    rows_list = list(rows)
    if not rows_list:
        return 0
    await db_conn.executemany(
        f"""
        INSERT INTO {timeframe.table}
            (tradeid, time, open, high, low, close, volume)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tradeid, time) DO NOTHING
        """,
        rows_list,
    )
    return len(rows_list)
