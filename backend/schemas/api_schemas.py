
from pydantic import BaseModel, Field
from datetime import date, time
from datetime import datetime
from typing import Optional,Any
from decimal import Decimal



# ─── Models ───────────────────────────────────────────────────────────────────


class Execution(BaseModel):
    dateTime: datetime
    symbol: str
    tradeID: str
    buySell: str
    quantity: int
    tradePrice: Decimal
    ibOrderID: str
    ibCommission: Decimal
    db_status: Optional[str] = None  # 'inserted' | 'skipped' | 'error' — not from DB, set in insert_executions() to indicate what happened with each row

# Db response when updating execution category
class CategoryUpdate(BaseModel):
    reference: str
    symbol: str
    category: str
    updated: bool


# ─── Trade Models ─────────────────────────────────────────────────────────────

class Trade(BaseModel):
    """A trade row as stored / returned from the DB."""
    tradeid: int
    symbol: str
    date: datetime
    setup: Optional[str] = None
    price_action_rating: Optional[int] = None
    price_position: Optional[int] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class TradeCreate(BaseModel):
    """Body for POST /api/trades. Only symbol + date are required."""
    symbol: str
    date: datetime
    setup: Optional[str] = None
    price_action_rating: Optional[int] = Field(default=None, ge=1, le=5)
    price_position: Optional[int] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class TradeUpdate(BaseModel):
    """Body for PATCH /api/trades/{tradeid}. All fields optional."""
    symbol: Optional[str] = None
    date: Optional[datetime] = None
    setup: Optional[str] = None
    price_action_rating: Optional[int] = Field(default=None, ge=1, le=5)
    price_position: Optional[int] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class ManualTradeEntry(BaseModel):
    """A manually-entered trade — no executions backing it.

    `date` is a calendar date (no time). The backend localises it to
    Helsinki midnight before inserting to satisfy the (symbol, local-day)
    unique index on trades.
    """
    symbol: str = Field(min_length=1)
    date: date


class TradeSyncRequest(BaseModel):
    """Optional body for POST /api/trades/sync.

    `manual_trades` are inserted FIRST (with ON CONFLICT DO NOTHING on
    the (symbol, local-day) unique index). Then the executions
    auto-bucket runs as usual, linking executions that match those
    (symbol, day) buckets to the manual trade.
    """
    manual_trades: list[ManualTradeEntry] = []


class TradeSyncResult(BaseModel):
    """Returned by POST /api/trades/sync (and used internally after insert)."""
    trades_created: int
    executions_linked: int
    # Of `trades_created`, how many came from the manual_trades request
    # input vs. the auto-bucket from executions.
    manual_trades_created: int = 0
    manual_trades_skipped: int = 0
    trades_created_ids: list[int] = []
    # Full Trade rows for everything just inserted, so the UI can render
    # the new trades table without a second roundtrip. Manual + auto rows
    # are concatenated; manual entries always come first.
    trades_created_rows: list["Trade"] = []


# ─── IBKR bar-fetch result models ─────────────────────────────────────────────

class BarFetchTimeframeResult(BaseModel):
    timeframe: str          # 'daily' | '30min' | '2min'
    inserted: int           # rows newly inserted this call
    skipped: bool           # True if (tradeid, timeframe) already had data
    existing: int = 0       # how many rows were already present (when skipped)
    error: Optional[str] = None


class BarFetchResult(BaseModel):
    tradeid: int
    symbol: str
    results: list[BarFetchTimeframeResult]


# ─── Batch bar-fetch (data-management UI) ─────────────────────────────────────

class BarFetchBatchRequest(BaseModel):
    """Body for POST /api/trades/fetch-bars-batch."""
    tradeids: list[int]


class BarFetchBatchResult(BaseModel):
    """Response for POST /api/trades/fetch-bars-batch — async, returns immediately."""
    scheduled: int
    skipped_already_fetching: list[int] = []
    tradeids: list[int] = []


class BarTimeframeStatus(BaseModel):
    timeframe: str
    rows: int


class TradeBarStatus(BaseModel):
    """One row in GET /api/trades/bars-status?tradeids=..."""
    tradeid: int
    symbol: str
    date: datetime
    status: str  # 'pending' | 'fetching' | 'partial' | 'done' | 'error'
    timeframes: list[BarTimeframeStatus]
    last_error: Optional[str] = None
