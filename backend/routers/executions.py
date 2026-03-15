from fastapi import APIRouter, HTTPException, Query,Depends
from typing import List, Optional
from datetime import datetime
from domain.executions import get_executions_from_email
from db.executions import fetch_executions,update_execution_category
from schemas.api_schemas import Execution,ExecutionEmail,CategoryUpdate
from dependencies import get_db_conn

router = APIRouter(
    prefix="/api/executions",
    tags=["Executions"]
)


@router.get("/email", response_model=List[ExecutionEmail])
async def get_emailexecutions(db_conn=Depends(get_db_conn),
    start_date: Optional[datetime] = Query(
        default=None,
        description="Filter executions from this date (ISO 8601, e.g. 2026-03-01)"
    ),
    end_date: Optional[datetime] = Query(
        default=None,
        description="Filter executions up to this date (ISO 8601, e.g. 2026-03-06)"
    ),
):
    try:
        return await get_executions_from_email(db_conn,start_date=start_date, end_date=end_date)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch executions: {str(e)}")
    



@router.get("/mydb", response_model=list[Execution])
async def get_executions(
    year: int,
    month: int,
    db_conn=Depends(get_db_conn)
):
    try:
        return await fetch_executions(db_conn, year, month)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch executions: {str(e)}")



@router.patch("/category", response_model=CategoryUpdate)
async def update_category(
    reference: str,
    category: str,
    db_conn=Depends(get_db_conn)
):
    try:
        return await update_execution_category(db_conn, reference, category)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update category: {str(e)}")