
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


# ─── Order-level trade-review categories ─────────────────────────────────────
#
# One row per IB order (iborderid). Categories:
#   1 — Followed plan, made money.
#   2 — Followed plan, stopped out at predefined stop.
#   3 — Off-plan (FOMO / revenge), lost money.
#   4 — Off-plan, made money in the end.
# Absence of a row = uncategorised (the UI treats missing as "no pick").

class OrderCategory(BaseModel):
    """One (iborderid → category) assignment stored in order_categories."""
    iborderid: str
    trade_fk: int
    category: int = Field(ge=1, le=4)
    updated_at: Optional[datetime] = None


class OrderCategoryUpsert(BaseModel):
    """Body for PUT /api/order-categories/{iborderid}. ``trade_fk`` is
    required so the row is anchored to a trade even on first insert
    (there is no way for the backend to infer it from iborderid alone —
    executions may not have been linked yet)."""
    trade_fk: int
    category: int = Field(ge=1, le=4)


# ─── Trade Models ─────────────────────────────────────────────────────────────

class Trade(BaseModel):
    """A trade row as stored / returned from the DB.

    ``setup`` is a free-form text label (taxonomy enforced in the UI).

    ``execution_count`` is opt-in: most endpoints leave it as None. The
    /trades/{id}/day and /trades/{id}/week endpoints populate it with
    COUNT(DISTINCT iborderid) so the daily and weekly tables can show how
    many distinct orders made up each trade (multiple fills sharing the
    same iborderid count as one).

    ``realized_pnl`` is also opt-in and populated by /trades/{id}/day and
    /trades/{id}/week. It is the net realised P/L computed from this
    trade's linked executions: SUM(sell cash – buy cash) + SUM(ibCommission).
    IB commission is stored as a negative number (it's a cost), so simple
    addition gives net P/L. Returned as a string so the API stays
    Decimal-safe; the frontend parses it. Will be None if the trade has
    no executions yet.
    """
    tradeid: int
    symbol: str
    date: datetime
    setup: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None
    execution_count: Optional[int] = None
    realized_pnl: Optional[Decimal] = None
    # Opt-in like execution_count: populated by /trades/{id}/day and
    # /trades/{id}/week so the tables can flag trades that still have
    # uncategorised orders (distinct iborderids with no matching
    # order_categories row). None on every other read.
    uncategorized_count: Optional[int] = None


class TradeCreate(BaseModel):
    """Body for POST /api/trades. Only symbol + date are required."""
    symbol: str
    date: datetime
    setup: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class TradeUpdate(BaseModel):
    """Body for PATCH /api/trades/{tradeid}. All fields optional."""
    symbol: Optional[str] = None
    date: Optional[datetime] = None
    setup: Optional[str] = None
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


# ─── Analytics ────────────────────────────────────────────────────────────────

class DailyPnlExecsPoint(BaseModel):
    """One trading day's aggregate execution count and realised P/L.

    Powers the scatter that plots whether high-execution days correlate
    with better or worse P/L. ``exec_count`` is the sum of distinct
    ``iborderid`` values across every trade on the day (matches the
    "Total execs" stat in the daily table). ``trade_count`` is the
    number of trades on the day. ``date`` is the Helsinki calendar day.

    Days with no executions are excluded by the endpoint — manual-only
    rows would skew the X axis with phantom zeros.
    """
    date: date
    total_pnl: Decimal
    exec_count: int
    trade_count: int


class DailyPnlExecsResponse(BaseModel):
    """Response for GET /api/analytics/daily-pnl-vs-execs. ``points`` is
    ordered chronologically (oldest day first). ``weeks`` echoes the
    window size used so the frontend can title the chart."""
    weeks: int
    points: list[DailyPnlExecsPoint]


class WeeklyExecsBucket(BaseModel):
    """One Mon..Sun (Helsinki) week's total execution count."""
    week_start: date
    exec_count: int
    trade_count: int
    total_pnl: Decimal


class WeeklyExecsResponse(BaseModel):
    """Response for GET /api/analytics/weekly-execs. ``weeks`` is
    contiguous (every Mon..Sun bucket in the requested window is
    present, even empty ones). ``window_weeks`` echoes the window size
    used."""
    window_weeks: int
    weeks: list[WeeklyExecsBucket]


class WeeklyOrderCategoriesBucket(BaseModel):
    """One Mon..Sun (Helsinki) week's per-category order count.

    Counts are the number of distinct IB orders (iborderids) whose
    parent trade fell in the given week, split by trade-review
    category. ``uncategorized`` picks up every order that has no row in
    ``order_categories`` yet.
    """
    week_start: date
    cat1: int = 0
    cat2: int = 0
    cat3: int = 0
    cat4: int = 0
    uncategorized: int = 0


class WeeklyOrderCategoriesResponse(BaseModel):
    """Response for GET /api/analytics/weekly-order-categories."""
    window_weeks: int
    weeks: list[WeeklyOrderCategoriesBucket]


# ─── Playbook ─────────────────────────────────────────────────────────────────

class PlaybookSetupSummary(BaseModel):
    """One row of GET /api/playbook/setups — a setup label with its
    aggregate stats over the requested window. Powers the Playbook
    page's section list.

    ``total_pnl`` is the summed realised P/L over every trade whose
    ``setup`` matches the label. Trades with no executions are excluded
    (no P/L).
    """
    setup_label: str
    trade_count: int
    total_pnl: Decimal


class PlaybookSetupsResponse(BaseModel):
    """Response for GET /api/playbook/setups. Rows are sorted by
    ``trade_count`` descending — most observed setups first."""
    weeks: Optional[int] = None  # None when window=all
    rows: list[PlaybookSetupSummary]


class PlaybookTradeSummary(BaseModel):
    """One trade as it appears in the Playbook chart grid for a given
    setup. Slim subset of ``Trade`` plus the precomputed ``realized_pnl``.
    """
    tradeid: int
    symbol: str
    date: datetime
    setup: Optional[str] = None
    realized_pnl: Optional[Decimal] = None


class PlaybookTradesResponse(BaseModel):
    """Response for GET /api/playbook/setups/{label}/trades. Trades are
    sorted by ``date`` descending — most recent first."""
    setup_label: str
    weeks: Optional[int] = None
    trades: list[PlaybookTradeSummary]


class PlaybookNotes(BaseModel):
    """Structured strategy notes for one setup. All fields default to
    empty string so a setup that's never been written about still
    returns a well-formed object — keeps the frontend simple. Mirrored
    by the columns in db/playbook.py."""
    setup_label: str
    description: str = ""
    entry_rules: str = ""
    exit_rules: str = ""
    common_mistakes: str = ""
    examples: str = ""
    updated_at: Optional[datetime] = None


class PlaybookNotesUpdate(BaseModel):
    """Request body for PUT /api/playbook/setups/{label}/notes. All
    fields optional — sent fields overwrite, omitted fields keep their
    existing values."""
    description: Optional[str] = None
    entry_rules: Optional[str] = None
    exit_rules: Optional[str] = None
    common_mistakes: Optional[str] = None
    examples: Optional[str] = None


# ─── Weekly Review (Claude-generated) ─────────────────────────────────────────

class WeeklyReview(BaseModel):
    """A stored, Claude-generated review for one Mon–Sun (Helsinki) week."""
    week_start: date
    model: str = ""
    content: str = ""
    stats: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[datetime] = None


class WeeklyReviewWeek(BaseModel):
    """One selectable week in GET /api/reviews/weeks."""
    week_start: date
    week_end: date
    label: str
    trade_count: int
    has_review: bool


class WeeklyReviewWeeksResponse(BaseModel):
    """Response for GET /api/reviews/weeks — newest week first."""
    weeks: list[WeeklyReviewWeek]
