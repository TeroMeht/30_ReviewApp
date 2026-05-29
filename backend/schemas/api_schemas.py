
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


# ─── Analytics ────────────────────────────────────────────────────────────────

class WeeklyPnlBucket(BaseModel):
    """One week's per-setup P/L breakdown.

    ``week_start`` is the Monday (Europe/Helsinki) anchoring the bucket.
    ``by_setup`` maps each setup label to its summed realized P/L for
    that week, serialized as a Decimal string to keep the API
    Decimal-safe. Setups with zero P/L in the week may be omitted; the
    frontend treats missing keys as 0. NULL-setup trades are excluded
    upstream.
    """
    week_start: date
    by_setup: dict[str, Decimal] = Field(default_factory=dict)


class WeeklyPnlResponse(BaseModel):
    """Response for GET /api/analytics/weekly-pnl.

    ``weeks`` is contiguous — every Mon..Sun bucket in the requested
    window is present, even if no trades fell in it, so the frontend
    can render a stable x-axis. ``setups`` is the alphabetically-sorted
    list of every distinct setup that appeared anywhere in the window,
    giving the frontend a stable color/legend ordering.

    ``group_by`` echoes back the field the server attributed P/L to
    (``intended_setup`` or ``setup``) so the page can label the chart.
    """
    group_by: str
    weeks: list[WeeklyPnlBucket]
    setups: list[str]


class SetupStatsRow(BaseModel):
    """Aggregated stats for one setup over the requested window.

    Trades with no executions linked are excluded (no P/L computable).
    Trades with P/L exactly 0 are counted in ``trade_count`` as
    "scratches" — they don't contribute to ``avg_win`` or ``avg_loss``
    but they are still part of the denominator for ``win_rate`` and
    ``expectancy``, matching how a trader would think about it: a
    scratch is a trade that happened, just not a winner.

    ``avg_loss`` is a *negative* number (loss in dollars). ``avg_win``
    is positive. Both are NULL when the bucket they describe is empty
    (e.g. ``avg_win`` is NULL if the setup never won in the window).

    ``avg_win_hold_sec`` / ``avg_loss_hold_sec`` are average hold
    times in seconds, computed as MAX(execution.datetime) -
    MIN(execution.datetime) per trade then averaged. Single-fill
    trades contribute 0 seconds.

    ``expectancy`` is net P/L per trade across the whole bucket
    (including scratches): ``(wins * avg_win + losses * avg_loss) /
    trade_count``. The number you'd expect to make on the next trade
    of this setup if the past N weeks are representative.
    """
    setup: str
    trade_count: int
    wins: int
    losses: int
    scratches: int
    win_rate: float  # 0.0–1.0
    avg_win: Optional[Decimal] = None
    avg_loss: Optional[Decimal] = None
    avg_win_hold_sec: Optional[int] = None
    avg_loss_hold_sec: Optional[int] = None
    expectancy: Decimal


class SetupStatsResponse(BaseModel):
    """Response for GET /api/analytics/setup-stats. Rows are sorted
    by setup label alphabetically. ``group_by`` echoes which trade
    column the rows are bucketed against. ``weeks`` echoes the
    window size used."""
    group_by: str
    weeks: int
    rows: list[SetupStatsRow]


class PlanVsActualRow(BaseModel):
    """One (planned setup → actual setup) bucket over the requested window.

    Only trades where both ``setup`` (planned) and ``intended_setup``
    (actual) are populated contribute — the mapping is meaningless
    otherwise. Trades with no executions linked are also excluded (no
    P/L computable).

    A row where ``planned_setup == actual_setup`` is a *matched* trade
    (you did what you intended). Any other row is a *deviation* — the
    cost of those rows is the question this view exists to answer.

    P/L fields are Decimal-as-string at the API boundary. ``total_pnl``
    is the summed realised P/L over every trade in the bucket;
    ``avg_pnl`` is per-trade.
    """
    planned_setup: str
    actual_setup: str
    trade_count: int
    wins: int
    losses: int
    scratches: int
    win_rate: float  # 0.0–1.0
    total_pnl: Decimal
    avg_pnl: Decimal


class PlanVsActualResponse(BaseModel):
    """Response for GET /api/analytics/plan-vs-actual. Rows are sorted
    by ``total_pnl`` ascending so the costliest deviations bubble to
    the top. ``weeks`` echoes the window size used."""
    weeks: int
    rows: list[PlanVsActualRow]


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


# ─── Playbook ─────────────────────────────────────────────────────────────────

class PlaybookSetupSummary(BaseModel):
    """One row of GET /api/playbook/setups — a setup label with its
    aggregate stats over the requested window. Powers the Playbook
    page's section list.

    ``total_pnl`` is the summed realised P/L over every trade where this
    label appears in ``observed_setup``. Trades with no executions are
    excluded (no P/L). A trade with multiple observed setups contributes
    its full P/L to each setup's total — the Playbook is a per-pattern
    study view, not an attribution model.
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
    setup. Slim subset of ``Trade`` plus the precomputed ``realized_pnl``
    and the full ``observed_setup`` list so the card can render its
    "+ other observed setups" chip without a second roundtrip.
    """
    tradeid: int
    symbol: str
    date: datetime
    setup: Optional[str] = None
    intended_setup: Optional[str] = None
    observed_setup: Optional[list[str]] = None
    realized_pnl: Optional[Decimal] = None


class PlaybookTradesResponse(BaseModel):
    """Response for GET /api/playbook/setups/{label}/trades. Trades are
    sorted by ``date`` descending — most recent first. ``setup_label``
    echoes which observed-setup label was queried."""
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
    """A stored, Claude-generated review for one Mon–Sun (Helsinki) week.

    ``week_start`` is the Monday anchoring the week. ``content`` is the
    review body as markdown. ``stats`` is the aggregate snapshot the
    review was built from (P/L, trade count, win rate, number of plan
    deviations, etc.) so the page can show headline numbers without
    recomputing. ``model`` records which Anthropic model produced it.
    """
    week_start: date
    model: str = ""
    content: str = ""
    stats: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[datetime] = None


class WeeklyReviewWeek(BaseModel):
    """One selectable week in GET /api/reviews/weeks.

    ``week_start`` is the Monday (local). ``label`` is a human range like
    '2026-05-25 → 2026-05-31'. ``trade_count`` is how many trades fall in
    the week (0 weeks are still listed so the user can pick recent empty
    weeks). ``has_review`` is True if a generated review is already stored.
    """
    week_start: date
    week_end: date
    label: str
    trade_count: int
    has_review: bool


class WeeklyReviewWeeksResponse(BaseModel):
    """Response for GET /api/reviews/weeks — newest week first."""
    weeks: list[WeeklyReviewWeek]
