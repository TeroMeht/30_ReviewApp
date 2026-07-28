"""
Trade MFE (Maximum Favorable Excursion) endpoints.

Shape:
    GET    /api/trades/{tradeid}/mfe
             → stored config + computed result. If no config saved,
                returns a well-formed result with `config=None` and a
                `note` explaining what to do next.
    PUT    /api/trades/{tradeid}/mfe
             body: {entry_iborderid, initial_stop_price}
             → upsert the config, recompute, return the fresh result.
    DELETE /api/trades/{tradeid}/mfe
             → drop the config so the trade goes back to "not analysed".

Computation is not cached — every GET/PUT recomputes from the 2-min
bars so bar backfills propagate immediately.

See db/trade_mfe.py for storage rationale and services/mfe.py for the
compute logic.
"""

from fastapi import APIRouter, Depends, HTTPException

from db.trade_mfe import (
    delete_mfe_config,
    fetch_mfe_config,
    upsert_mfe_config,
)
from db.trades import fetch_trade_by_id
from dependencies import get_db_conn
from schemas.api_schemas import TradeMfeResult, TradeMfeUpsert
from services.mfe import compute_mfe


router = APIRouter(prefix="/api/trades", tags=["MFE"])


@router.get("/{tradeid}/mfe", response_model=TradeMfeResult)
async def get_mfe(tradeid: int, db_conn=Depends(get_db_conn)):
    """Return the trade's stored MFE config (if any) plus a freshly
    computed result. Always returns a 200 with a well-formed result —
    the `note` field explains any "can't compute" state so the frontend
    doesn't have to do special-case error handling."""
    try:
        await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    config = await fetch_mfe_config(db_conn, tradeid)
    return await compute_mfe(db_conn, tradeid, config)


@router.put("/{tradeid}/mfe", response_model=TradeMfeResult)
async def put_mfe(
    tradeid: int,
    payload: TradeMfeUpsert,
    db_conn=Depends(get_db_conn),
):
    """Upsert MFE config for the trade and return the recomputed result.

    Stop source resolution:
      * ``initial_stop_price`` supplied → used as-is; ``stop_iborderid``
                                           is cleared.
      * ``stop_iborderid`` supplied     → we look up the picked order's
                                           qty-weighted avg fill price
                                           and store it. Fails 400 if
                                           the order has no fills on
                                           this trade.
      * Both / neither supplied         → 400.

    The payload's ``entry_iborderid`` is not validated against the
    trade's executions here — the compute layer surfaces "no matching
    fills" via a ``note`` field on the result rather than raising, so a
    stale order id becomes a visible warning rather than a hard error.
    Stop resolution IS validated here because we need a definitive
    price to store; a stale stop order id would silently save a NULL
    otherwise.
    """
    try:
        await fetch_trade_by_id(db_conn, tradeid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    has_price = payload.initial_stop_price is not None
    has_order = payload.stop_iborderid is not None and payload.stop_iborderid != ""
    if has_price == has_order:  # both true or both false
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide exactly one of `initial_stop_price` or "
                "`stop_iborderid`."
            ),
        )

    if has_order:
        # Resolve the picked stop order → qty-weighted avg fill price.
        # Same formula as the entry-order aggregate in services/mfe.py.
        row = await db_conn.fetchrow(
            """
            SELECT (SUM(quantity * tradeprice)
                     / NULLIF(SUM(quantity), 0)) AS avg_price
            FROM   executions
            WHERE  trade_fk = $1 AND iborderid = $2
            """,
            tradeid, payload.stop_iborderid,
        )
        if row is None or row["avg_price"] is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Picked stop order {payload.stop_iborderid!r} has no "
                    f"fills on this trade."
                ),
            )
        resolved_price = row["avg_price"]
        stop_iborderid = payload.stop_iborderid
    else:
        resolved_price = payload.initial_stop_price
        stop_iborderid = None

    try:
        config = await upsert_mfe_config(
            db_conn,
            trade_fk=tradeid,
            entry_iborderid=payload.entry_iborderid,
            initial_stop_price=resolved_price,
            stop_iborderid=stop_iborderid,
        )
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to save MFE config: {e}",
        )

    return await compute_mfe(db_conn, tradeid, config)


@router.delete("/{tradeid}/mfe")
async def clear_mfe(tradeid: int, db_conn=Depends(get_db_conn)):
    """Drop the stored MFE config. Idempotent — returns {removed: bool}."""
    removed = await delete_mfe_config(db_conn, tradeid)
    return {"tradeid": tradeid, "removed": removed}
