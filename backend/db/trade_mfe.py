"""
Trade MFE (Maximum Favorable Excursion) configuration.

Storage:
    trade_mfe 1 ── 1 trade
        trade_fk            INTEGER PRIMARY KEY  — references trades.tradeid.
        entry_iborderid     TEXT NOT NULL        — one of the trade's IB
                                                    order ids; the user
                                                    pinpoints "this was my
                                                    entry" when a trade
                                                    scales in over several
                                                    orders.
        initial_stop_price  NUMERIC(14, 4) NOT NULL
                                                — the stop level the user
                                                    planned to exit at
                                                    BEFORE any mid-trade
                                                    adjustments. This can't
                                                    always be inferred from
                                                    the executions because
                                                    a realised stop order
                                                    may have been moved
                                                    during the trade — but
                                                    when the user knows the
                                                    stop wasn't moved, they
                                                    can also PICK an
                                                    execution order and we
                                                    resolve the price from
                                                    it (see stop_iborderid).
        stop_iborderid      TEXT NULL            — optional IB order id
                                                    that was used as the
                                                    source for
                                                    initial_stop_price
                                                    (i.e. "the stop level
                                                    matches this executed
                                                    order's avg fill").
                                                    NULL means the price
                                                    was typed in manually.
                                                    Kept so the UI can
                                                    display "restored from
                                                    picked order" on
                                                    reload.
        updated_at          TIMESTAMPTZ          — for audit / display.

Rationale for a separate table (vs. columns on trades):
  * MFE analysis is optional per trade — most trades will start without a
    row. A NULL-heavy set of columns on the hot `trades` table isn't
    great.
  * Future MFE-related fields (e.g. a computed cache, MAE, R multiple)
    accrete here without churning `trades`.
  * ON DELETE CASCADE means deleting a trade drops its MFE config in one
    query.

There is NO computed value stored in this table. The peak / potential
PnL are recomputed on every read from the 2-min bars so bar backfills
propagate immediately without an invalidation dance.
"""

import asyncpg
from typing import Optional
from schemas.api_schemas import TradeMfeConfig
import logging

logger = logging.getLogger(__name__)


# ─── Schema setup ─────────────────────────────────────────────────────────────

async def create_trade_mfe_table(db_conn: asyncpg.Connection) -> None:
    """Create the trade_mfe table. Idempotent.

    NOTE: References ``trades(tradeid)``, so the trades table MUST be
    created first. Startup ordering in main.py handles this.
    """
    exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'trade_mfe'
        )
    """)
    if not exists:
        await db_conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_mfe (
                trade_fk            INTEGER PRIMARY KEY
                                      REFERENCES trades(tradeid) ON DELETE CASCADE,
                entry_iborderid     TEXT NOT NULL,
                initial_stop_price  NUMERIC(14, 4) NOT NULL,
                stop_iborderid      TEXT NULL,
                updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        logger.info("trade_mfe table created successfully")
        return

    # Forward-compat: pick up `stop_iborderid` on deployments that already
    # ran the earlier version of this migration (table exists, column
    # doesn't). No-op when the column is already present.
    await db_conn.execute(
        "ALTER TABLE trade_mfe ADD COLUMN IF NOT EXISTS stop_iborderid TEXT NULL"
    )
    logger.info("trade_mfe table already exists — stop_iborderid ensured")


# ─── CRUD ─────────────────────────────────────────────────────────────────────

async def fetch_mfe_config(
    db_conn: asyncpg.Connection,
    trade_fk: int,
) -> Optional[TradeMfeConfig]:
    """Return the stored MFE config for one trade, or None if never saved."""
    row = await db_conn.fetchrow(
        """
        SELECT trade_fk, entry_iborderid, initial_stop_price,
               stop_iborderid, updated_at
        FROM trade_mfe
        WHERE trade_fk = $1
        """,
        trade_fk,
    )
    if row is None:
        return None
    return TradeMfeConfig(**dict(row))


async def upsert_mfe_config(
    db_conn: asyncpg.Connection,
    trade_fk: int,
    entry_iborderid: str,
    initial_stop_price,
    stop_iborderid: Optional[str] = None,
) -> TradeMfeConfig:
    """Insert or replace the MFE config for one trade.

    ``stop_iborderid`` is optional and only recorded as metadata — the
    stop level actually used for computation is always
    ``initial_stop_price``. The caller is responsible for resolving the
    picked order to a price before calling us; keeping this function a
    dumb writer avoids the DB module needing to know about the
    executions table.
    """
    row = await db_conn.fetchrow(
        """
        INSERT INTO trade_mfe
            (trade_fk, entry_iborderid, initial_stop_price, stop_iborderid, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (trade_fk) DO UPDATE
          SET entry_iborderid    = EXCLUDED.entry_iborderid,
              initial_stop_price = EXCLUDED.initial_stop_price,
              stop_iborderid     = EXCLUDED.stop_iborderid,
              updated_at         = NOW()
        RETURNING trade_fk, entry_iborderid, initial_stop_price,
                  stop_iborderid, updated_at
        """,
        trade_fk, entry_iborderid, initial_stop_price, stop_iborderid,
    )
    return TradeMfeConfig(**dict(row))


async def delete_mfe_config(
    db_conn: asyncpg.Connection,
    trade_fk: int,
) -> bool:
    """Remove the stored MFE config. Returns True if a row was removed."""
    result = await db_conn.execute(
        "DELETE FROM trade_mfe WHERE trade_fk = $1",
        trade_fk,
    )
    try:
        count = int(result.split()[-1])
    except (ValueError, IndexError):
        count = 0
    return count > 0
