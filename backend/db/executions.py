import asyncpg
from schemas.api_schemas import ExecutionEmail,Execution
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
            reference   TEXT PRIMARY KEY,
            subject     TEXT NOT NULL,
            time        TIMESTAMPTZ NOT NULL,
            action      TEXT NOT NULL,
            size        INTEGER NOT NULL,
            symbol      TEXT NOT NULL,
            price       NUMERIC(10, 3) NOT NULL,
            category    TEXT
        )
    """)
    logger.info("Executions table created successfully")


async def insert_executions(db_conn: asyncpg.Connection, executions: list[ExecutionEmail]) -> list[ExecutionEmail]:
    """Insert new executions, skip duplicates. Returns all with db_status set."""

    if not executions:
        return []

    references = [ex.reference for ex in executions]
    existing = await db_conn.fetch(
        "SELECT reference FROM executions WHERE reference = ANY($1::text[])",
        references
    )
    existing_refs = {row["reference"] for row in existing}

    new_executions = [ex for ex in executions if ex.reference not in existing_refs]
    skipped = [ex for ex in executions if ex.reference in existing_refs]

    for ex in skipped:
        ex.db_status = "duplicate"
        logger.info("Skipping duplicate execution: reference=%s symbol=%s time=%s", ex.reference, ex.symbol, ex.time)

    if not new_executions:
        logger.info("No new executions to insert, all %d were duplicates", len(skipped))
        return executions

    try:
        await db_conn.executemany(
            """
            INSERT INTO executions (reference, subject, time, action, size, symbol, price)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            [
                (ex.reference, ex.subject, ex.time, ex.action, ex.size, ex.symbol, ex.price)
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

    logger.info("Inserted %d new executions, skipped %d duplicates", len(new_executions), len(skipped))
    return executions





async def fetch_executions(db_conn: asyncpg.Connection, year: int, month: int) -> list[Execution]:
    rows = await db_conn.fetch(
        """
        SELECT reference, time, action, size, symbol, price,category
        FROM executions
        WHERE EXTRACT(YEAR FROM time) = $1
          AND EXTRACT(MONTH FROM time) = $2
        ORDER BY time ASC
        """,
        year, month
    )
    return [Execution(**dict(row)) for row in rows]