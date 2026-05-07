"""
FastAPI dependency providers.

Routes do `ib: IB = Depends(get_ib)` / `conn = Depends(get_db_conn)` — the
shared IB client and asyncpg pool are stashed on `app.state` during the
lifespan startup in main.py.
"""
from typing import AsyncGenerator
from fastapi import Request
from ib_async import IB
import asyncpg


def get_ib(request: Request) -> IB:
    """Return the process-wide IBKR client."""
    ib: IB = request.app.state.ib
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
