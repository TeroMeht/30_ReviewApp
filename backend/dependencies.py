"""
FastAPI dependency providers.

Routes do ``source: IBSource = Depends(get_ib_source)`` /
``conn = Depends(get_db_conn)`` -- the shared ``IBSource`` and asyncpg
pool are stashed on ``app.state`` during the lifespan startup in
``main.py``.

The IB socket is opened once at startup (see ``main.py``'s lifespan).
Routes that need it just check ``source.ib.isConnected()`` and
return 503 if it isn't up. No lazy reconnect, no lock -- if TWS goes
down after boot, restart the backend.
"""
from typing import AsyncGenerator
from fastapi import Request
import asyncpg

from data_sources.ib._client import IBSource


def get_ib_source(request: Request) -> IBSource:
    """Return the process-wide IBSource (may or may not be connected)."""
    return request.app.state.ib_source


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
