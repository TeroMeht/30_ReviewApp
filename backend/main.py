from my_logging.logger import setup_logging

# Set up logging first so anything imported below logs through it.
logger = setup_logging(__name__)
logger.info("Application backend starting")

from contextlib import asynccontextmanager

import asyncpg
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from data_sources.ib._client import (
    connect as ib_connect,
    disconnect as ib_disconnect,
    from_config as ib_source_from_config,
)

from core.config import settings

# Routers — add new ones here as the app grows.
from routers import analytics, executions, mfe, order_categories, playbook, reviews, trades

# Schema setup helpers
from db.executions import create_executions_table
from db.order_categories import create_order_categories_table
from db.trades import create_trades_table
from db.trade_bars import create_trade_bars_tables
from db.trade_mfe import create_trade_mfe_table
from db.playbook import create_playbook_table
from db.weekly_reviews import create_weekly_reviews_table


# Process-wide IBSource. Built here, connected in the lifespan below,
# stashed on app.state, and used by routes via get_ib_source. No lazy
# reconnect: if TWS goes down after boot, restart the backend.
ib_source = ib_source_from_config(settings)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: open DB pool, then open the IBKR socket.

    IBKR connect is wrapped in try/except so the backend still boots
    when TWS / IB Gateway isn't running -- market-data routes will just
    return 503 until TWS is up AND the backend is restarted. This keeps
    the app's config-editing / review pages usable in a TWS-off state.

    Shutdown: close DB pool, disconnect IB (disconnect is idempotent,
    so it's safe whether or not the connect succeeded).
    """
    db_pool: asyncpg.Pool | None = None
    try:
        logger.info("Creating DB pool")
        db_pool = await asyncpg.create_pool(dsn=settings.DATABASE_URL)

        async with db_pool.acquire() as conn:
            await create_trades_table(conn)
            await create_executions_table(conn)
            await create_order_categories_table(conn)
            await create_trade_bars_tables(conn)
            await create_trade_mfe_table(conn)
            await create_playbook_table(conn)
            await create_weekly_reviews_table(conn)

        # Open the IB socket. On failure log and continue -- routes
        # that need IB check isConnected() and return 503 themselves.
        try:
            await ib_connect(ib_source)

        except Exception as e:
            logger.warning(
                "IBKR connect failed at startup (%s). Backend will boot; "
                "market-data routes will return 503 until TWS / IB Gateway "
                "is running AND the backend is restarted.",
                e,
            )

        app.state.ib_source = ib_source
        app.state.db_pool = db_pool
        logger.info("Backend ready.")

    except Exception:
        logger.exception("Startup failed")
        raise

    yield  # --- app runs ---

    try:
        if db_pool is not None:
            await db_pool.close()
            logger.info("PostgreSQL pool closed")
        ib_disconnect(ib_source)
        logger.info("IBKR disconnected (no-op if never connected)")
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
app.include_router(reviews.router)
app.include_router(order_categories.router)
app.include_router(mfe.router)


if __name__ == "__main__":
    uvicorn.run("main:app")
