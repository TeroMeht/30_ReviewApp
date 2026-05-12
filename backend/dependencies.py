"""
FastAPI dependency providers.

Routes do `ib: IB = Depends(get_ib)` / `conn = Depends(get_db_conn)` — the
shared IB client and asyncpg pool are stashed on `app.state` during the
lifespan startup in main.py.

The IB client is created during lifespan but NOT connected — the first
route that needs a live connection should call `ensure_ib_connected(ib)`
to open the socket on demand. This way the backend can boot without
TWS / IB Gateway running.
"""
import asyncio
import logging
from typing import AsyncGenerator
from fastapi import HTTPException, Request
from ib_async import IB
import asyncpg

from core.config import settings


logger = logging.getLogger(__name__)


# Serialises concurrent ensure_ib_connected() calls so two requests
# arriving simultaneously can't race on connectAsync() — only one opens
# the socket; the other observes the now-connected client and returns.
_IB_CONNECT_LOCK: asyncio.Lock = asyncio.Lock()


def get_ib(request: Request) -> IB:
    """Return the process-wide IBKR client (may or may not be connected)."""
    ib: IB = request.app.state.ib
    return ib


async def ensure_ib_connected(ib: IB) -> IB:
    """Open the IBKR socket if it isn't already.

    Raises HTTPException 503 if the connect attempt fails (e.g. TWS /
    IB Gateway isn't running). The route layer can therefore call this
    without its own try/except and the user sees a clean error.
    """
    if ib.isConnected():
        return ib

    async with _IB_CONNECT_LOCK:
        # Re-check inside the lock — another coroutine may have just
        # finished connecting while we were waiting.
        if ib.isConnected():
            return ib
        try:
            logger.info(
                "Connecting to IBKR on demand | host=%s port=%s clientId=%s",
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
        except Exception as e:
            logger.exception("Failed to connect to IBKR on demand")
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Could not connect to IBKR at "
                    f"{settings.IB_HOST}:{settings.IB_PORT} "
                    f"(clientId={settings.IB_CLIENT_ID}). "
                    f"Is TWS / IB Gateway running? — {e}"
                ),
            )
    return ib


async def get_db_conn(
    request: Request,
) -> AsyncGenerator[asyncpg.Connection, None]:
    """Yield a pooled asyncpg connection scoped to the request."""
    pool: asyncpg.Pool = request.app.state.db_pool
    async with pool.acquire() as conn:
        yield conn


def get_db_pool(request: Request) -> asyncpg.Pool:
    """Return the shared asyncpg pool (for spawning long-running background tasks)."""
    return request.app.state.db_pool
