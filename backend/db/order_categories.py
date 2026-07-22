"""
Order-level trade-review categories.

Categories are attached at the IB *order* level (one row per iborderid),
not per fill. The user thinks in orders — one click in TWS = one
ibOrderID that may produce several partial fills — so the executions
table in the UI collapses fills to one row per ibOrderID, and the
categorisation follows the same shape.

Category taxonomy (INTEGER 1..4):
  1 — Followed the plan and made money.
  2 — Followed the plan but got stopped out at the predefined stop.
  3 — Low-quality decision (FOMO, revenge, off-plan) and lost money.
  4 — Low-quality decision (off-plan) but made money in the end.

Storage shape:
    order_categories 1 ── 1 iborderid
        iborderid   TEXT PRIMARY KEY   — IB order id (matches
                                          executions.iborderid).
        trade_fk    INTEGER NOT NULL   — FK to trades.tradeid; deleting a
                                          trade cascades and removes its
                                          category rows.
        category    INTEGER CHECK 1..4 — the user's assessment.
        updated_at  TIMESTAMPTZ        — for future audit / analytics.

Rationale for a separate table (vs. a column on executions):
  * A category belongs to one order (iborderid), not one fill.
    Denormalising onto the fill rows would require every fill of the
    same order to stay in sync via a trigger or app-level guard.
  * Adding future per-order fields (a reason note, a checklist) is a
    schema add on this table, not a churn on the fills table.
  * Deleting/relabelling is a single row write.
"""

import asyncpg
from schemas.api_schemas import OrderCategory
import logging

logger = logging.getLogger(__name__)


# ─── Schema setup ─────────────────────────────────────────────────────────────

async def create_order_categories_table(db_conn: asyncpg.Connection) -> None:
    """Create the order_categories table. Idempotent.

    NOTE: This table references ``trades(tradeid)``, so the trades table
    MUST be created first. Startup in main.py orders these correctly.
    """
    exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'order_categories'
        )
    """)

    if exists:
        logger.info("order_categories table already exists, skipping creation")
        return

    await db_conn.execute("""
        CREATE TABLE IF NOT EXISTS order_categories (
            iborderid   TEXT PRIMARY KEY,
            trade_fk    INTEGER NOT NULL
                          REFERENCES trades(tradeid) ON DELETE CASCADE,
            category    INTEGER NOT NULL CHECK (category BETWEEN 1 AND 4),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    # Fast lookup of "all categories for this trade".
    await db_conn.execute("""
        CREATE INDEX IF NOT EXISTS order_categories_trade_fk_idx
        ON order_categories (trade_fk)
    """)
    logger.info("order_categories table created successfully")


# ─── CRUD ─────────────────────────────────────────────────────────────────────

async def fetch_categories_for_trade(
    db_conn: asyncpg.Connection,
    trade_fk: int,
) -> list[OrderCategory]:
    """Return every categorised order for the given trade. Uncategorised
    orders are simply absent — the UI treats "no row" as "no category"."""
    rows = await db_conn.fetch(
        """
        SELECT iborderid, trade_fk, category, updated_at
        FROM order_categories
        WHERE trade_fk = $1
        """,
        trade_fk,
    )
    return [OrderCategory(**dict(r)) for r in rows]


async def upsert_category(
    db_conn: asyncpg.Connection,
    iborderid: str,
    trade_fk: int,
    category: int,
) -> OrderCategory:
    """Insert or update the category for one iborderid.

    ``category`` must be one of 1..4 (enforced both here and by the
    table's CHECK constraint). ``trade_fk`` must reference an existing
    trade (FK-enforced).
    """
    if category not in (1, 2, 3, 4):
        raise ValueError(f"category must be 1..4, got {category!r}")

    row = await db_conn.fetchrow(
        """
        INSERT INTO order_categories (iborderid, trade_fk, category, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (iborderid) DO UPDATE
          SET category   = EXCLUDED.category,
              trade_fk   = EXCLUDED.trade_fk,
              updated_at = NOW()
        RETURNING iborderid, trade_fk, category, updated_at
        """,
        iborderid, trade_fk, category,
    )
    return OrderCategory(**dict(row))


async def delete_category(
    db_conn: asyncpg.Connection,
    iborderid: str,
) -> bool:
    """Clear the category on one iborderid. Returns True if a row was
    removed, False if there was nothing to clear (already uncategorised)."""
    result = await db_conn.execute(
        "DELETE FROM order_categories WHERE iborderid = $1",
        iborderid,
    )
    try:
        count = int(result.split()[-1])
    except (ValueError, IndexError):
        count = 0
    return count > 0
