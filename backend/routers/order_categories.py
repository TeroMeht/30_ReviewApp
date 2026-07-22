"""
Order-level category endpoints for the Trade Review page.

Shape:
    GET    /api/trades/{tradeid}/order-categories
             → list all categorised orders for one trade.
    PUT    /api/order-categories/{iborderid}
             body: {trade_fk, category(1..4)}
             → upsert; return the row.
    DELETE /api/order-categories/{iborderid}
             → clear the category (order becomes uncategorised).

See db/order_categories.py for storage rationale.
"""

from typing import List
from fastapi import APIRouter, Depends, HTTPException

from db.order_categories import (
    delete_category,
    fetch_categories_for_trade,
    upsert_category,
)
from dependencies import get_db_conn
from schemas.api_schemas import OrderCategory, OrderCategoryUpsert


router = APIRouter(tags=["Order categories"])


@router.get(
    "/api/trades/{tradeid}/order-categories",
    response_model=List[OrderCategory],
)
async def list_order_categories(tradeid: int, db_conn=Depends(get_db_conn)):
    """All categorised orders (iborderid, category) for one trade.

    Uncategorised orders are simply absent from the response — the UI
    treats missing rows as "no pick".
    """
    return await fetch_categories_for_trade(db_conn, tradeid)


@router.put(
    "/api/order-categories/{iborderid}",
    response_model=OrderCategory,
)
async def put_order_category(
    iborderid: str,
    payload: OrderCategoryUpsert,
    db_conn=Depends(get_db_conn),
):
    """Upsert the category for one IB order. Idempotent."""
    try:
        return await upsert_category(
            db_conn,
            iborderid=iborderid,
            trade_fk=payload.trade_fk,
            category=payload.category,
        )
    except ValueError as e:
        # Bad category value that slipped past the pydantic guard.
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Most likely an FK violation — trade_fk pointing at a missing trade.
        raise HTTPException(
            status_code=400,
            detail=f"Failed to upsert order category: {e}",
        )


@router.delete("/api/order-categories/{iborderid}")
async def delete_order_category(iborderid: str, db_conn=Depends(get_db_conn)):
    """Clear the category on one iborderid. Returns {removed: bool}.
    ``removed`` is False if the order was already uncategorised — the
    endpoint is idempotent either way."""
    removed = await delete_category(db_conn, iborderid)
    return {"iborderid": iborderid, "removed": removed}
