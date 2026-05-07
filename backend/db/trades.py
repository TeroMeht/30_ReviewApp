"""
Trades table: one row per (symbol, local-day) bucket of executions.

Relationship:
    trades 1 ── many executions
    executions.tradeid is a nullable FK to trades.tradeid (ON DELETE SET NULL).

Auto-link logic:
    sync_trades_from_executions() finds all executions whose tradeid IS NULL,
    groups them by (symbol, day-in-Europe/Helsinki), upserts a trades row for
    each missing pair (with date = MIN(execution.time) for that day), then
    sets executions.tradeid for every matching execution.
"""

import asyncpg
from datetime import datetime, time
from typing import Optional
from zoneinfo import ZoneInfo
from schemas.api_schemas import (
    Trade,
    TradeCreate,
    TradeUpdate,
    TradeSyncResult,
    Execution,
    ManualTradeEntry,
)

import logging
logger = logging.getLogger(__name__)


# Timezone used for the (symbol, day) bucketing. Executions are parsed in
# Helsinki time (see services/executions.parse_time_message), so we use the
# same zone for the unique index and for the sync grouping.
LOCAL_TZ = "Europe/Helsinki"


# ─── Schema setup ─────────────────────────────────────────────────────────────

async def create_trades_table(db_conn: asyncpg.Connection) -> None:
    """Create the trades table and its (symbol, local-day) unique index. Idempotent."""
    exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'trades'
        )
    """)

    if exists:
        logger.info("Trades table already exists, skipping creation")
        return

    await db_conn.execute(f"""
        CREATE TABLE IF NOT EXISTS trades (
            tradeid              SERIAL PRIMARY KEY,
            symbol               TEXT NOT NULL,
            date                 TIMESTAMPTZ NOT NULL,
            setup                TEXT,
            price_action_rating  INTEGER CHECK (price_action_rating BETWEEN 1 AND 5),
            price_position       INTEGER,
            category             TEXT,
            notes                TEXT
        )
    """)

    # Unique on (symbol, local calendar day). This is the "1 trade per
    # symbol per day" rule.
    await db_conn.execute(f"""
        CREATE UNIQUE INDEX IF NOT EXISTS trades_symbol_localday_uniq
        ON trades (symbol, ((date AT TIME ZONE '{LOCAL_TZ}')::date))
    """)
    logger.info("Trades table + unique index created successfully")


async def add_notes_column_to_trades(db_conn: asyncpg.Connection) -> None:
    """ALTER trades ADD COLUMN notes TEXT NULL. Idempotent — used to migrate older DBs."""
    col_exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'trades'
              AND column_name = 'notes'
        )
    """)
    if col_exists:
        logger.info("trades.notes already exists, skipping ALTER")
        return

    await db_conn.execute("ALTER TABLE trades ADD COLUMN notes TEXT NULL")
    logger.info("Added notes column to trades")


async def add_trade_fk_to_executions(db_conn: asyncpg.Connection) -> None:
    """
    ALTER executions ADD COLUMN trade_fk (FK → trades.tradeid). Idempotent.

    `executions.tradeid` is already taken: it stores IB's per-fill execution
    identifier (TEXT, primary key) coming from the Flex Web Service. So the
    foreign key to our internal `trades.tradeid` lives in a separate column
    called `trade_fk`.

    On the FIRST creation of this column we also TRUNCATE the trades table.
    This is a one-time clean slate for the IB-Flex migration: any rows in
    `trades` left over from the old email-based flow are unlikely to match
    cleanly to the new IB executions, and the user opted to wipe and
    regenerate. Subsequent app boots are no-ops because the column already
    exists.
    """
    col_exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'executions'
              AND column_name = 'trade_fk'
        )
    """)
    if col_exists:
        logger.info("executions.trade_fk already exists, skipping ALTER")
        return

    async with db_conn.transaction():
        # One-time wipe so Generate Trades produces a clean (symbol, day) set.
        # CASCADE so we don't error on dependent tables (trade_bars, etc).
        await db_conn.execute("TRUNCATE trades RESTART IDENTITY CASCADE")
        logger.info("Wiped trades table (one-time IB-Flex migration)")

        await db_conn.execute("""
            ALTER TABLE executions
            ADD COLUMN trade_fk INTEGER NULL
            REFERENCES trades(tradeid) ON DELETE SET NULL
        """)
        # Helpful for joins / lookups by linked trade.
        await db_conn.execute("""
            CREATE INDEX IF NOT EXISTS executions_trade_fk_idx ON executions (trade_fk)
        """)
    logger.info("Added trade_fk FK column to executions")


# ─── CRUD ─────────────────────────────────────────────────────────────────────

async def insert_trade(db_conn: asyncpg.Connection, payload: TradeCreate) -> Trade:
    """Insert a new trade. Raises asyncpg.UniqueViolationError if (symbol, day) already exists."""
    row = await db_conn.fetchrow(
        """
        INSERT INTO trades (symbol, date, setup, price_action_rating, price_position, category, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING tradeid, symbol, date, setup, price_action_rating, price_position, category, notes
        """,
        payload.symbol,
        payload.date,
        payload.setup,
        payload.price_action_rating,
        payload.price_position,
        payload.category,
        payload.notes,
    )
    return Trade(**dict(row))


async def fetch_trades(
    db_conn: asyncpg.Connection,
    year: Optional[int] = None,
    month: Optional[int] = None,
) -> list[Trade]:
    """List trades, optionally filtered to a given year/month (using local tz)."""
    if year is not None and month is not None:
        rows = await db_conn.fetch(
            f"""
            SELECT tradeid, symbol, date, setup, price_action_rating, price_position, category, notes
            FROM trades
            WHERE EXTRACT(YEAR  FROM (date AT TIME ZONE '{LOCAL_TZ}')) = $1
              AND EXTRACT(MONTH FROM (date AT TIME ZONE '{LOCAL_TZ}')) = $2
            ORDER BY date ASC
            """,
            year, month,
        )
    else:
        rows = await db_conn.fetch(
            """
            SELECT tradeid, symbol, date, setup, price_action_rating, price_position, category, notes
            FROM trades
            ORDER BY date ASC
            """
        )
    return [Trade(**dict(r)) for r in rows]


async def fetch_trades_in_range(
    db_conn: asyncpg.Connection,
    start_date,
    end_date,
) -> list[Trade]:
    """
    List trades whose `date` (as a local-day in LOCAL_TZ) falls within
    [start_date, end_date], inclusive. Both args are date or datetime.
    """
    rows = await db_conn.fetch(
        f"""
        SELECT tradeid, symbol, date, setup, price_action_rating, price_position, category, notes
        FROM trades
        WHERE (date AT TIME ZONE '{LOCAL_TZ}')::date BETWEEN $1::date AND $2::date
        ORDER BY date ASC
        """,
        start_date,
        end_date,
    )
    return [Trade(**dict(r)) for r in rows]


async def fetch_trade_by_id(db_conn: asyncpg.Connection, tradeid: int) -> Trade:
    row = await db_conn.fetchrow(
        """
        SELECT tradeid, symbol, date, setup, price_action_rating, price_position, category, notes
        FROM trades
        WHERE tradeid = $1
        """,
        tradeid,
    )
    if row is None:
        raise ValueError(f"No trade found for tradeid={tradeid}")
    return Trade(**dict(row))


async def update_trade(
    db_conn: asyncpg.Connection,
    tradeid: int,
    payload: TradeUpdate,
) -> Trade:
    """Partial update: only provided fields are written."""
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        # Nothing to update — just return current row.
        return await fetch_trade_by_id(db_conn, tradeid)

    set_clauses = []
    args: list = []
    for i, (col, val) in enumerate(fields.items(), start=1):
        set_clauses.append(f"{col} = ${i}")
        args.append(val)
    args.append(tradeid)

    sql = f"""
        UPDATE trades
        SET {", ".join(set_clauses)}
        WHERE tradeid = ${len(args)}
        RETURNING tradeid, symbol, date, setup, price_action_rating, price_position, category, notes
    """
    row = await db_conn.fetchrow(sql, *args)
    if row is None:
        raise ValueError(f"No trade found for tradeid={tradeid}")
    return Trade(**dict(row))


async def delete_trade(db_conn: asyncpg.Connection, tradeid: int) -> bool:
    """Delete a trade. Linked executions get tradeid=NULL via FK ON DELETE SET NULL."""
    result = await db_conn.execute(
        "DELETE FROM trades WHERE tradeid = $1",
        tradeid,
    )
    # asyncpg returns "DELETE <count>"
    try:
        count = int(result.split()[-1])
    except (ValueError, IndexError):
        count = 0
    if count == 0:
        raise ValueError(f"No trade found for tradeid={tradeid}")
    return True


async def fetch_executions_for_trade(
    db_conn: asyncpg.Connection,
    tradeid: int,
) -> list[Execution]:
    rows = await db_conn.fetch(
        """
        SELECT reference, time, action, size, symbol, price, category, tradeid
        FROM executions
        WHERE tradeid = $1
        ORDER BY time ASC
        """,
        tradeid,
    )
    return [Execution(**dict(r)) for r in rows]


# ─── Manual trade insertion ──────────────────────────────────────────────────

# Zone object reused for converting calendar dates -> TIMESTAMPTZ. We pin
# manual trades to local midnight so the (symbol, local-day) unique index
# treats them the same as auto-bucketed trades.
_LOCAL_TZ_INFO = ZoneInfo(LOCAL_TZ)


async def insert_manual_trades(
    db_conn: asyncpg.Connection,
    entries: list[ManualTradeEntry],
) -> tuple[list[Trade], list[tuple[str, str]]]:
    """
    Insert manual (symbol, date) trades. ON CONFLICT against the
    (symbol, local-day) unique index → DO NOTHING. Logs each duplicate.

    Returns (created_rows, skipped_pairs). `skipped_pairs` is a list of
    (symbol, ISO-date) tuples for entries that conflicted with an
    existing trade — useful for both logging and reporting back to the UI.

    Symbols are uppercased server-side as a defensive normalisation
    (the UI also uppercases on submit). `date` is treated as a calendar
    day in Europe/Helsinki and stored as midnight-local TIMESTAMPTZ.
    """
    if not entries:
        return [], []

    # Pre-normalise + dedupe in-memory so a duplicated row in the form
    # doesn't waste a roundtrip — keep the first occurrence per (sym, day).
    seen: set[tuple[str, str]] = set()
    normalised: list[tuple[str, datetime]] = []
    in_memory_dupes: list[tuple[str, str]] = []
    for e in entries:
        sym = e.symbol.strip().upper()
        if not sym:
            # Skip empty symbols defensively — schema requires min_length=1
            # so this is just belt-and-braces.
            continue
        key = (sym, e.date.isoformat())
        if key in seen:
            in_memory_dupes.append(key)
            continue
        seen.add(key)
        # Midnight local-time, tz-aware → TIMESTAMPTZ.
        dt = datetime.combine(e.date, time(0, 0), tzinfo=_LOCAL_TZ_INFO)
        normalised.append((sym, dt))

    if in_memory_dupes:
        logger.info(
            "Manual trade input had in-memory duplicates: %s", in_memory_dupes
        )

    inserted_rows: list[Trade] = []
    db_dupes: list[tuple[str, str]] = []

    async with db_conn.transaction():
        for sym, dt in normalised:
            row = await db_conn.fetchrow(
                """
                INSERT INTO trades (symbol, date)
                VALUES ($1, $2)
                ON CONFLICT (symbol, ((date AT TIME ZONE $3)::date)) DO NOTHING
                RETURNING tradeid, symbol, date, setup, price_action_rating,
                          price_position, category, notes
                """,
                sym, dt, LOCAL_TZ,
            )
            if row is None:
                # Conflict — a trade for (sym, that local day) already exists.
                day_iso = dt.astimezone(_LOCAL_TZ_INFO).date().isoformat()
                db_dupes.append((sym, day_iso))
                logger.info(
                    "Manual trade skipped (duplicate): symbol=%s date=%s",
                    sym, day_iso,
                )
            else:
                inserted_rows.append(Trade(**dict(row)))

    skipped_all = in_memory_dupes + db_dupes
    logger.info(
        "Manual trades insert complete: created=%d skipped=%d",
        len(inserted_rows), len(skipped_all),
    )
    return inserted_rows, skipped_all


# ─── Auto-link sync ───────────────────────────────────────────────────────────

async def sync_trades_from_executions(db_conn: asyncpg.Connection) -> TradeSyncResult:
    """
    For every (symbol, local-day) appearing in executions but missing a
    linked trade: insert a trade row whose `date` is the earliest execution
    timestamp on that day. Then set executions.trade_fk for every unlinked
    execution whose (symbol, local-day) matches a trade.

    Idempotent — re-running when every execution already has trade_fk set
    does nothing (returns trades_created=0, executions_linked=0).

    Schema notes:
      * executions.tradeid is IB's TEXT primary key (per-fill execution id).
      * executions.trade_fk is the FK INTEGER to trades.tradeid (this column).
      * executions.datetime is the fill timestamp (UTC TIMESTAMPTZ).
    """
    async with db_conn.transaction():
        # Step 1: insert missing (symbol, local-day) trades from unlinked
        # executions. ON CONFLICT DO NOTHING relies on
        # trades_symbol_localday_uniq so re-running is safe.
        created_rows = await db_conn.fetch(
            f"""
            INSERT INTO trades (symbol, date)
            SELECT symbol, MIN(datetime)
            FROM executions
            WHERE trade_fk IS NULL
            GROUP BY symbol, (datetime AT TIME ZONE '{LOCAL_TZ}')::date
            ON CONFLICT (symbol, ((date AT TIME ZONE '{LOCAL_TZ}')::date)) DO NOTHING
            RETURNING
                tradeid, symbol, date, setup, price_action_rating,
                price_position, category, notes
            """
        )
        trades_created_rows = [Trade(**dict(r)) for r in created_rows]
        trades_created_ids = [t.tradeid for t in trades_created_rows]
        trades_created = len(trades_created_ids)

        # Step 2: link unlinked executions to trades by (symbol, local-day).
        link_status = await db_conn.execute(
            f"""
            UPDATE executions e
            SET trade_fk = t.tradeid
            FROM trades t
            WHERE e.trade_fk IS NULL
              AND e.symbol = t.symbol
              AND (e.datetime AT TIME ZONE '{LOCAL_TZ}')::date
                  = (t.date     AT TIME ZONE '{LOCAL_TZ}')::date
            """
        )
        # asyncpg returns "UPDATE <count>"
        try:
            executions_linked = int(link_status.split()[-1])
        except (ValueError, IndexError):
            executions_linked = 0

    logger.info(
        "Trade sync complete: trades_created=%d executions_linked=%d new_ids=%s",
        trades_created,
        executions_linked,
        trades_created_ids,
    )
    return TradeSyncResult(
        trades_created=trades_created,
        executions_linked=executions_linked,
        trades_created_ids=trades_created_ids,
        trades_created_rows=trades_created_rows,
    )
