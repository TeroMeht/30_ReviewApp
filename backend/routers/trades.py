from datetime import date
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query
import asyncpg

from dependencies import get_db_conn, get_db_pool, get_ib
from schemas.api_schemas import (
    Trade,
    TradeCreate,
    TradeUpdate,
    TradeSyncRequest,
    TradeSyncResult,
    Execution,
    BarFetchResult,
    BarFetchBatchRequest,
    BarFetchBatchResult,
    TradeBarStatus,
    BarTimeframeStatus,
)
from db.trades import (
    insert_trade,
    fetch_trades,
    fetch_trades_in_range,
    fetch_trade_by_id,
    update_trade,
    delete_trade,
    fetch_executions_for_trade,
    insert_manual_trades,
    sync_trades_from_executions,
)
from services.ib_bars import (
    schedule_bar_fetch,
    schedule_bar_fetches,
    fetch_bars_for_trade,
    is_fetching,
    get_last_error,
    compute_bar_status,
    fetch_bar_counts_for_trades,
)

import logging
logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/trades",
    tags=["Trades"],
)


@router.post("", response_model=Trade)
async def create_trade(
    payload: TradeCreate,
    db_conn=Depends(get_db_conn),
    db_pool=Depends(get_db_pool),
    ib=Depends(get_ib),
):
    try:
        trade = await insert_trade(db_conn, payload)
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=409,
            detail=f"Trade for symbol={payload.symbol} on that date already exists",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create trade: {e}")

    # Kick off background bar fetch — does not block the response.
    schedule_bar_fetch(ib, db_pool, trade.tradeid)
    logger.info("create_trade: scheduled background bar fetch tradeid=%d", trade.tradeid)
    return trade


@router.get("", response_model=list[Trade])
async def list_trades(
    year: Optional[int] = None,
    month: Optional[int] = None,
    start_date: Optional[date] = Query(
        default=None,
        description="Filter trades whose local-day is on/after this date (YYYY-MM-DD).",
    ),
    end_date: Optional[date] = Query(
        default=None,
        description="Filter trades whose local-day is on/before this date (YYYY-MM-DD).",
    ),
    db_conn=Depends(get_db_conn),
):
    """
    List trades. Two mutually-exclusive filter modes:
      * year + month       — calendar-month view (back-compat).
      * start_date+end_date — inclusive date range (used by /data-management).
    With no filters, returns all trades.
    """
    try:
        if start_date is not None and end_date is not None:
            return await fetch_trades_in_range(db_conn, start_date, end_date)
        return await fetch_trades(db_conn, year=year, month=month)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch trades: {e}")


@router.post("/fetch-bars-batch", response_model=BarFetchBatchResult)
async def fetch_bars_batch(
    payload: BarFetchBatchRequest,
    db_pool=Depends(get_db_pool),
    ib=Depends(get_ib),
):
    """
    Schedule background IBKR bar fetches for a batch of trade IDs and return
    immediately. The frontend polls /bars-status to track per-trade progress.
    """
    scheduled: list[int] = []
    skipped: list[int] = []
    for tid in payload.tradeids:
        if is_fetching(tid):
            skipped.append(tid)
            continue
        task = schedule_bar_fetch(ib, db_pool, tid)
        if task is not None:
            scheduled.append(tid)
    logger.info(
        "fetch_bars_batch: scheduled=%d skipped_already_fetching=%d",
        len(scheduled), len(skipped),
    )
    return BarFetchBatchResult(
        scheduled=len(scheduled),
        skipped_already_fetching=skipped,
        tradeids=scheduled,
    )


@router.get("/bars-status", response_model=list[TradeBarStatus])
async def bars_status(
    tradeids: list[int] = Query(
        default=[],
        description="Repeat the param: ?tradeids=1&tradeids=2&...",
    ),
    db_conn=Depends(get_db_conn),
):
    """Return per-tradeid bar-fetch status (pending/fetching/partial/done/error)."""
    if not tradeids:
        return []
    counts = await fetch_bar_counts_for_trades(db_conn, tradeids)
    out: list[TradeBarStatus] = []
    for tid in tradeids:
        bar_counts = counts.get(tid, {})
        status = compute_bar_status(tid, bar_counts)
        out.append(
            TradeBarStatus(
                tradeid=tid,
                status=status,
                timeframes=[
                    BarTimeframeStatus(timeframe=tf, rows=n)
                    for tf, n in bar_counts.items()
                ],
                last_error=get_last_error(tid),
            )
        )
    return out


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


@router.post("/{tradeid}/fetch-bars", response_model=BarFetchResult)
async def fetch_bars(
    tradeid: int,
    db_conn=Depends(get_db_conn),
    ib=Depends(get_ib),
):
    """Manually (and synchronously) fetch IBKR bars for a trade. Skips timeframes
    that already have data — delete those rows first to force a refetch."""
    try:
        trade = await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        return await fetch_bars_for_trade(ib, db_conn, trade)
    except Exception as e:
        logger.exception("Manual fetch-bars failed for tradeid=%d", tradeid)
        raise HTTPException(status_code=500, detail=f"Bar fetch failed: {e}")


@router.get("/{tradeid}", response_model=Trade)
async def get_trade(tradeid: int, db_conn=Depends(get_db_conn)):
    try:
        return await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch trade: {e}")


@router.patch("/{tradeid}", response_model=Trade)
async def patch_trade(
    tradeid: int,
    payload: TradeUpdate,
    db_conn=Depends(get_db_conn),
):
    try:
        return await update_trade(db_conn, tradeid, payload)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=409,
            detail="Update would violate (symbol, day) uniqueness",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update trade: {e}")


@router.delete("/{tradeid}")
async def remove_trade(tradeid: int, db_conn=Depends(get_db_conn)):
    try:
        await delete_trade(db_conn, tradeid)
        return {"tradeid": tradeid, "deleted": True}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete trade: {e}")


@router.get("/{tradeid}/executions", response_model=list[Execution])
async def get_trade_executions(tradeid: int, db_conn=Depends(get_db_conn)):
    try:
        # Confirm the trade exists for a clean 404 vs an empty list.
        await fetch_trade_by_id(db_conn, tradeid)
        return await fetch_executions_for_trade(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch executions: {e}")
