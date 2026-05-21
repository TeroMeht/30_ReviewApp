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
from routers import analytics, executions, playbook, trades

# Schema setup helpers
from db.executions import create_executions_table
from db.trades import create_trades_table
from db.trade_bars import create_trade_bars_tables
from db.playbook import create_playbook_table


# Process-wide IBKR client. Connected during lifespan, reused by routes.
ib = IB()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: open DB pool only. IBKR is connected lazily — see
    routers/trades.py /fetch-bars-batch which calls ensure_ib_connected().

    The IB() object is still created here and stashed on app.state so
    get_ib() can hand it out, but no socket is opened. This means the
    backend boots even when TWS / IB Gateway isn't running; only the
    market-data fetch path needs the live connection.

    Shutdown: close DB pool, and disconnect IB if it was opened during
    the session.
    """
    db_pool: asyncpg.Pool | None = None
    try:
        logger.info("Creating DB pool")
        db_pool = await asyncpg.create_pool(dsn=settings.DATABASE_URL)

        async with db_pool.acquire() as conn:
            await create_trades_table(conn)
            await create_executions_table(conn)
            await create_trade_bars_tables(conn)
            await create_playbook_table(conn)

        app.state.ib = ib
        app.state.db_pool = db_pool

        logger.info(
            "Backend ready. IBKR not connected yet — will connect on first "
            "market-data fetch (host=%s port=%s clientId=%s).",
            settings.IB_HOST,
            settings.IB_PORT,
            settings.IB_CLIENT_ID,
        )

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
app.include_router(analytics.router)
app.include_router(playbook.router)


if __name__ == "__main__":
    uvicorn.run("main:app")
