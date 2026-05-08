from datetime import date
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from ib_async import IB
import asyncpg

from dependencies import get_db_conn, get_db_pool, get_ib
from schemas.api_schemas import (
    Trade,
    TradeCreate,
    TradeSyncRequest,
    TradeSyncResult,
    BarFetchBatchResult,
    BarTimeframeStatus,
    TradeBarStatus,
)
from db.trades import (
    insert_trade,
    insert_manual_trades,
    sync_trades_from_executions,
)
from db.trade_bars import TIMEFRAMES
from services.ib_bars import (
    schedule_bar_fetch_batch,
    find_incomplete_tradeids,
    fetch_bar_counts_for_trades,
    compute_bar_status,
    get_last_error,
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


# ─── Market data (bar) fetch ──────────────────────────────────────────────────

@router.post("/fetch-bars-batch", response_model=BarFetchBatchResult)
async def fetch_bars_batch(
    db_conn=Depends(get_db_conn),
    db_pool: asyncpg.Pool = Depends(get_db_pool),
    ib: IB = Depends(get_ib),
):
    """
    "Update Market Data" button entry point.

    Finds every trade that's missing at least one timeframe of bars and
    schedules a background batch to fetch them. Returns immediately —
    the actual IB calls happen on a background task that processes one
    ticker at a time (per IB pacing rules); inside a ticker, the three
    timeframes fire concurrently.

    UI polls GET /api/trades/bars-status?tradeids=... to track progress.
    """
    if not ib.isConnected():
        raise HTTPException(
            status_code=503,
            detail="IBKR client is not connected; cannot fetch bars.",
        )

    try:
        tradeids = await find_incomplete_tradeids(db_conn)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to find incomplete trades: {e}",
        )

    scheduled, skipped = schedule_bar_fetch_batch(ib, db_pool, tradeids)
    logger.info(
        "fetch-bars-batch: scheduled=%d skipped_already_fetching=%d",
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
        ...,
        description="Repeat the param: ?tradeids=1&tradeids=2",
    ),
    db_conn=Depends(get_db_conn),
):
    """
    Per-trade bar fetch status. UI polls this while a batch is running.

    For each requested tradeid we return:
      * symbol, date — pulled from the trades table so the UI can render
                       a human-readable row without a second round-trip
      * timeframes  — current row counts per (daily/30min/2min)
      * status      — pending | fetching | partial | done | error
      * last_error  — last background-fetch error, if any
    """
    if not tradeids:
        return []

    try:
        counts = await fetch_bar_counts_for_trades(db_conn, tradeids)
        # One query for symbol + date — the trades table has the canonical
        # values; we keep this endpoint a strict superset of what the UI
        # needs to render the table.
        trade_rows = await db_conn.fetch(
            "SELECT tradeid, symbol, date FROM trades WHERE tradeid = ANY($1::int[])",
            tradeids,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to read bar status: {e}",
        )

    trade_meta = {int(r["tradeid"]): r for r in trade_rows}

    out: list[TradeBarStatus] = []
    for tid in tradeids:
        meta = trade_meta.get(tid)
        if meta is None:
            # Trade was deleted between scheduling and polling — skip.
            continue
        per_tf = counts.get(tid, {tf.label: 0 for tf in TIMEFRAMES})
        status = compute_bar_status(tid, per_tf)
        out.append(TradeBarStatus(
            tradeid=tid,
            symbol=meta["symbol"],
            date=meta["date"],
            status=status,
            timeframes=[
                BarTimeframeStatus(timeframe=tf.label, rows=per_tf.get(tf.label, 0))
                for tf in TIMEFRAMES
            ],
            last_error=get_last_error(tid),
        ))
    return out
