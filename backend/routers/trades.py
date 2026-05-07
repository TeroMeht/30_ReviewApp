from datetime import date
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
import asyncpg

from dependencies import get_db_conn
from schemas.api_schemas import (
    Trade,
    TradeCreate,
    TradeSyncRequest,
    TradeSyncResult,
)
from db.trades import (
    insert_trade,
    insert_manual_trades,
    sync_trades_from_executions,
)


import logging
logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/trades",
    tags=["Trades"],
)


@router.post("", response_model=Trade)
async def create_trade(payload: TradeCreate,db_conn=Depends(get_db_conn)):
    try:
        trade = await insert_trade(db_conn, payload)
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=409,
            detail=f"Trade for symbol={payload.symbol} on that date already exists",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create trade: {e}")

    return trade



@router.post("/sync", response_model=TradeSyncResult)
async def sync_trades(
    payload: Optional[TradeSyncRequest] = None,
    db_conn=Depends(get_db_conn),
):
    """Run two passes:
      1. Insert any `manual_trades` from the request body (no executions).
         Conflicts (a trade for that (symbol, day) already exists) are
         skipped silently and counted in `manual_trades_skipped`.
      2. Auto-bucket: create trades from any unlinked executions and link
         them.

    Order matters: manual trades land first so any matching executions get
    linked to them in the auto-bucket pass.

    Bar-fetch scheduling is intentionally NOT triggered here — the
    /data-management UI gates that behind the explicit "Start data fetch"
    button so the user can review trades first.
    """
    manual_entries = payload.manual_trades if payload else []
    try:
        manual_rows, manual_skipped = await insert_manual_trades(
            db_conn, manual_entries
        )
        auto_result = await sync_trades_from_executions(db_conn)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trade sync failed: {e}")

    # Merge: manual rows always come first in trades_created_rows so the UI
    # can render them above the auto-bucketed ones if it cares to.
    merged_rows = manual_rows + auto_result.trades_created_rows
    merged_ids = [t.tradeid for t in manual_rows] + auto_result.trades_created_ids

    return TradeSyncResult(
        trades_created=len(manual_rows) + auto_result.trades_created,
        executions_linked=auto_result.executions_linked,
        manual_trades_created=len(manual_rows),
        manual_trades_skipped=len(manual_skipped),
        trades_created_ids=merged_ids,
        trades_created_rows=merged_rows,
    )




