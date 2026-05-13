
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
    """A trade row as stored / returned from the DB.

    Three setup fields are tracked:
      * ``setup``           – the *planned* / target setup for the day.
      * ``intended_setup``  – what was *actually* executed.
      * ``observed_setup``  – list of *other* setups that also formed
                              on the ticker that day, regardless of
                              plan/execution. Empty list / None means
                              nothing else observed. Backtesting label.
    A deviation is ``setup != intended_setup``. ``setup`` and
    ``intended_setup`` are free-form text (taxonomy enforced in the
    UI) and either can be None. ``observed_setup`` is a Postgres
    TEXT[] mapped to a Python list.

    ``execution_count`` is opt-in: most endpoints leave it as None. The
    /trades/{id}/day endpoint populates it with COUNT(DISTINCT iborderid)
    so the daily table can show how many distinct orders made up each
    trade (multiple fills sharing the same iborderid count as one).

    ``realized_pnl`` is also opt-in and populated by /trades/{id}/day. It is
    the net realised P/L computed from this trade's linked executions:
    SUM(sell cash – buy cash) + SUM(ibCommission). IB commission is stored
    as a negative number (it's a cost), so simple addition gives net P/L.
    Returned as a string so the API stays Decimal-safe; the frontend
    parses it. Will be None if the trade has no executions yet.
    """
    tradeid: int
    symbol: str
    date: datetime
    setup: Optional[str] = None
    intended_setup: Optional[str] = None
    observed_setup: Optional[list[str]] = None
    price_action_rating: Optional[int] = None
    price_position: Optional[int] = None
    category: Optional[str] = None
    notes: Optional[str] = None
    execution_count: Optional[int] = None
    realized_pnl: Optional[Decimal] = None


class TradeCreate(BaseModel):
    """Body for POST /api/trades. Only symbol + date are required."""
    symbol: str
    date: datetime
    setup: Optional[str] = None
    intended_setup: Optional[str] = None
    observed_setup: Optional[list[str]] = None
    price_action_rating: Optional[int] = Field(default=None, ge=1, le=5)
    price_position: Optional[int] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class TradeUpdate(BaseModel):
    """Body for PATCH /api/trades/{tradeid}. All fields optional."""
    symbol: Optional[str] = None
    date: Optional[datetime] = None
    setup: Optional[str] = None
    intended_setup: Optional[str] = None
    observed_setup: Optional[list[str]] = None
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


# ─── Bars read (for Trade Review charts) ──────────────────────────────────────

class BarRow(BaseModel):
    """One OHLCV row, returned by GET /api/trades/{id}/bars."""
    time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int


class IndicatorPoint(BaseModel):
    """One indicator sample.

    `time` is the timestamp of the underlying bar — frontend matches points
    to candles by exact timestamp. `value` is None for warm-up bars and
    any point where the indicator isn't defined yet (e.g. start of a VWAP
    session before any volume has accumulated)."""
    time: datetime
    value: Optional[float] = None


class IndicatorSeries(BaseModel):
    """A named indicator overlay returned with a BarsResponse.

    Generic shape so adding more indicators later (RSI, MACD lines, etc.)
    doesn't churn the response schema. `name` is the stable key the
    frontend keys on (e.g. 'ema9', 'vwap'); `label` is the human-readable
    legend; `color` is a hint the frontend may use, but the frontend is
    free to ignore it and pick its own palette.

    `pane`: which chart pane to draw on. 0 = price pane (default — overlay
    on candles). 1+ = stacked sub-panes below. Used for indicators that
    aren't on the price axis (Relatr, Rvol).

    `series_type`: how to render. 'line' (default) for continuous lines
    (EMA, VWAP, Relatr). 'histogram' for bar-style indicators (Rvol).
    """
    name: str
    label: str
    color: Optional[str] = None
    pane: int = 0
    series_type: str = "line"
    points: list[IndicatorPoint]


class BarsResponse(BaseModel):
    tradeid: int
    symbol: str
    timeframe: str
    bars: list[BarRow]
    # Computed overlays (EMA, VWAP, …). Empty for timeframes we haven't
    # wired indicators for yet.
    indicators: list[IndicatorSeries] = []


class NeighborTrades(BaseModel):
    """Prev/next tradeids by date order (newest -> oldest)."""
    current: int
    prev_id: Optional[int] = None  # newer than current (one step back in time order)
    next_id: Optional[int] = None  # older than current
