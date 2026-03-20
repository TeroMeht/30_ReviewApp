
from pydantic import BaseModel
from datetime import date, time
from datetime import datetime
from typing import Optional,Any
from decimal import Decimal



# ─── Models ───────────────────────────────────────────────────────────────────

class ExecutionEmail(BaseModel):
    subject: str
    time:datetime
    action:str
    size: int
    reference:str
    symbol: str
    price: Decimal
    db_status: str = "pending"  # default

class Execution(BaseModel):
    reference:str
    time:datetime
    action:str
    size:int
    symbol:str
    price: Decimal
    category:Optional[str]

# Db response when updating execution category
class CategoryUpdate(BaseModel):
    reference: str
    symbol: str
    category: str
    updated: bool



        
