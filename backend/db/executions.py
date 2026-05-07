import asyncpg
from schemas.api_schemas import Execution
import logging
logger = logging.getLogger(__name__)



# Database table initilization
async def create_executions_table(db_conn: asyncpg.Connection) -> None:
    exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'executions'
        )
    """)

    if exists:
        logger.info("Executions table already exists, skipping creation")
        return

    await db_conn.execute("""
        CREATE TABLE IF NOT EXISTS executions (
            tradeid       TEXT PRIMARY KEY,
            datetime      TIMESTAMPTZ NOT NULL,
            symbol        TEXT NOT NULL,
            buysell       TEXT NOT NULL,
            quantity      INTEGER NOT NULL,
            tradeprice    NUMERIC(10, 3) NOT NULL,
            iborderid     TEXT NOT NULL,
            ibcommission  NUMERIC NOT NULL
        )
    """)
    logger.info("Executions table created successfully")


async def insert_executions(db_conn: asyncpg.Connection,executions: list[Execution]) -> list[Execution]:
    """Insert new executions, skip duplicates. Returns all with db_status set.
    """

    if not executions:
        return []

    trade_ids = [ex.tradeID for ex in executions]
    existing = await db_conn.fetch(
        "SELECT tradeid FROM executions WHERE tradeid = ANY($1::text[])",
        trade_ids
    )
    existing_ids = {row["tradeid"] for row in existing}

    new_executions = [ex for ex in executions if ex.tradeID not in existing_ids]
    skipped = [ex for ex in executions if ex.tradeID in existing_ids]

    for ex in skipped:
        ex.db_status = "duplicate"
        #logger.info("Skipping duplicate execution: tradeID=%s symbol=%s dateTime=%s", ex.tradeID, ex.symbol, ex.dateTime)

    if not new_executions:
        #logger.info("No new executions to insert, all %d were duplicates", len(skipped))
        return executions

    try:
        await db_conn.executemany(
            """
            INSERT INTO executions (tradeid, datetime, symbol, buysell, quantity, tradeprice, iborderid, ibcommission)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            [
                (
                    ex.tradeID,
                    ex.dateTime,
                    ex.symbol,
                    ex.buySell,
                    ex.quantity,
                    ex.tradePrice,
                    ex.ibOrderID,
                    ex.ibCommission,
                )
                for ex in new_executions
            ]
        )
        for ex in new_executions:
            ex.db_status = "inserted"

    except Exception as e:
        for ex in new_executions:
            ex.db_status = "error"
        logger.exception("Failed to insert executions: %s", e)
        raise

    logger.info(
        "Inserted %d new executions, skipped %d duplicates ",
        len(new_executions), len(skipped),
    )
    return executions










