from fastapi import APIRouter, HTTPException, Depends
from typing import List
from services.ib_flex import fetch_executions_from_ib
from db.executions import (
    insert_executions,
)
from schemas.api_schemas import Execution
from dependencies import get_db_conn

router = APIRouter(
    prefix="/api/executions",
    tags=["Flex query"]
)





@router.get("/ib", response_model=List[Execution])
async def update_my_db_from_flex_executions_data(db_conn=Depends(get_db_conn)):
    """
    Fetch executions from IBKR via the Flex Web Service. This will fetch execution data 
    starting from year first day of the current year, so it should be used periodically to keep the DB in sync with IBKR.
    """
    try:
        executions = await fetch_executions_from_ib()

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch executions from IB Flex: {e}",
        )
    try:
        return await insert_executions(db_conn, executions)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to persist IB executions: {e}",
        )






