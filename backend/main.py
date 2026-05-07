from my_logging.logger import setup_logging

# Set up logging first so anything imported below logs through it.
logger = setup_logging(__name__)
logger.info("Application backend starting")

from contextlib import asynccontextmanager

import asyncpg
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ib_async import IB

from core.config import settings

# Routers — add new ones here as the app grows.
from routers import executions, trades

# Schema setup helpers
from db.executions import create_executions_table
from db.trades import (
    create_trades_table,
    add_trade_fk_to_executions,
    add_notes_column_to_trades,
)
from db.trade_bars import create_trade_bars_tables


# Process-wide IBKR client. Connected during lifespan, reused by routes.
ib = IB()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: connect IBKR, open DB pool. Shutdown: close both."""
    db_pool: asyncpg.Pool | None = None
    try:
        # IBKR is required: if TWS / IB Gateway isn't running the app fails
        # to start. Bar fetches assume a live IB connection.
        logger.info(
            "Connecting to IBKR | host=%s port=%s clientId=%s",
            settings.IB_HOST,
            settings.IB_PORT,
            settings.IB_CLIENT_ID,
        )
        await ib.connectAsync(
            settings.IB_HOST,
            settings.IB_PORT,
            clientId=settings.IB_CLIENT_ID,
        )
        logger.info("IBKR connected")

        logger.info("Creating DB pool")
        db_pool = await asyncpg.create_pool(dsn=settings.DATABASE_URL)

        # Ensure tables / columns exist. Order matters: executions first,
        # then trades, then add the FK column on executions. Per-column
        # migration helpers (add_notes_column_to_trades) backfill columns
        # on databases that pre-date the schema change.
        async with db_pool.acquire() as conn:
            await create_executions_table(conn)
            await create_trades_table(conn)
            await add_notes_column_to_trades(conn)
            await add_trade_fk_to_executions(conn)
            await create_trade_bars_tables(conn)

        app.state.ib = ib
        app.state.db_pool = db_pool

    except Exception:
        logger.exception("Startup failed")
        raise

    yield  # --- app runs ---

    try:
        if db_pool is not None:
            await db_pool.close()
            logger.info("PostgreSQL pool closed")
        if ib.isConnected():
            ib.disconnect()
            logger.info("IBKR disconnected")
    except Exception:
        logger.exception("Error during shutdown")


app = FastAPI(
    title="30_ReviewApp Backend",
    description="Trade review app backend (FastAPI, asyncpg, IBKR API)",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(executions.router)
app.include_router(trades.router)


if __name__ == "__main__":
    uvicorn.run("main:app")
