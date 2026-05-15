/**
 * Hand-written TypeScript types mirroring backend Pydantic models in
 * backend/schemas/api_schemas.py. Keep in sync, or regenerate the
 * fully-typed client via `npm run gen:types` (writes to generated/api.ts).
 */

// ─── Executions ──────────────────────────────────────────────────────────────

export interface Execution {
  reference: string;
  /** ISO 8601 timestamp string */
  time: string;
  action: string;
  size: number;
  symbol: string;
  /** Decimal serialised as a string by FastAPI/pydantic */
  price: string;
  category: string | null;
  tradeid: number | null;
}

export interface CategoryUpdate {
  reference: string;
  symbol: string;
  category: string;
  updated: boolean;
}

// ─── Trades ──────────────────────────────────────────────────────────────────

export interface Trade {
  tradeid: number;
  symbol: string;
  /** ISO 8601 timestamp string */
  date: string;
  /** Planned / target setup for the day (what we were trying to take). */
  setup: string | null;
  /** Actually-executed setup (what we ended up doing). When this differs
   *  from `setup` the trade is a deviation. */
  intended_setup: string | null;
  /** Other setups that also formed on the ticker that day, regardless of
   *  plan/execution. Backtesting label — lets us ask "when these
   *  setups co-occurred, what was the outcome?". Empty array / null
   *  means nothing else observed. */
  observed_setup: string[] | null;
  price_action_rating: number | null;
  price_position: number | null;
  category: string | null;
  notes: string | null;
  /** Distinct iborderids linked to this trade. Populated by the
   *  /trades/{id}/day endpoint; null on every other read. */
  execution_count?: number | null;
  /** Net realised P/L (cash in − cash out + commission). Decimal
   *  serialised as a string by FastAPI/pydantic. Populated by the
   *  /trades/{id}/day endpoint; null on every other read and on
   *  trades with no executions linked yet. */
  realized_pnl?: string | null;
}

/** Body for POST /api/trades */
export interface TradeCreate {
  symbol: string;
  /** ISO 8601 timestamp string */
  date: string;
  setup?: string | null;
  intended_setup?: string | null;
  observed_setup?: string[] | null;
  price_action_rating?: number | null;
  price_position?: number | null;
  category?: string | null;
  notes?: string | null;
}

/** Body for PATCH /api/trades/{tradeid} (all optional) */
export interface TradeUpdate {
  symbol?: string;
  date?: string;
  setup?: string | null;
  intended_setup?: string | null;
  observed_setup?: string[] | null;
  price_action_rating?: number | null;
  price_position?: number | null;
  category?: string | null;
  notes?: string | null;
}

/** A manually-entered trade — no executions backing it.
 *  `date` is a YYYY-MM-DD calendar date string (no time). */
export interface ManualTradeEntry {
  symbol: string;
  date: string;
}

/** Optional body for POST /api/trades/sync. */
export interface TradeSyncRequest {
  manual_trades: ManualTradeEntry[];
}

export interface TradeSyncResult {
  trades_created: number;
  executions_linked: number;
  /** Subset of trades_created that came from manual_trades input. */
  manual_trades_created?: number;
  /** Manual entries that conflicted with an existing (symbol, day) row. */
  manual_trades_skipped?: number;
  trades_created_ids?: number[];
  /** Full Trade rows for everything just inserted (server populates).
   *  Manual rows precede auto-bucketed ones. */
  trades_created_rows?: Trade[];
}

// ─── Email-fetched executions ────────────────────────────────────────────────

export interface ExecutionEmail {
  subject: string;
  /** ISO 8601 timestamp string */
  time: string;
  action: string;
  size: number;
  reference: string;
  symbol: string;
  /** Decimal serialised as a string by FastAPI/pydantic */
  price: string;
  db_status: string;
}

// ─── IB Flex executions (from /api/executions/ib) ────────────────────────────
// Mirrors backend/schemas/api_schemas.py :: Execution. Keep field names in
// camelCase exactly as the FastAPI/pydantic model serialises them.

export interface IbExecution {
  /** ISO 8601 timestamp string (UTC, from IB Flex) */
  dateTime: string;
  symbol: string;
  tradeID: string;
  /** "BUY" | "SELL" */
  buySell: string;
  quantity: number;
  /** Decimal serialised as a string by FastAPI/pydantic */
  tradePrice: string;
  ibOrderID: string;
  /** Decimal serialised as a string */
  ibCommission: string;
  /** "inserted" | "duplicate" | "error" — set server-side after insert */
  db_status: string | null;
}

// ─── IBKR bar fetch (single-trade) ───────────────────────────────────────────

export interface BarFetchTimeframeResult {
  timeframe: string;
  inserted: number;
  skipped: boolean;
  existing?: number;
  error?: string | null;
}

export interface BarFetchResult {
  tradeid: number;
  symbol: string;
  results: BarFetchTimeframeResult[];
}

// ─── IBKR bar fetch (batch + status, used by /data-management) ───────────────

export interface BarFetchBatchRequest {
  tradeids: number[];
}

export interface BarFetchBatchResult {
  scheduled: number;
  skipped_already_fetching: number[];
  tradeids: number[];
}

export type BarFetchStatus =
  | "pending"
  | "fetching"
  | "partial"
  | "done"
  | "error";

export interface BarTimeframeStatus {
  timeframe: string;
  rows: number;
}

export interface TradeBarStatus {
  tradeid: number;
  symbol: string;
  /** ISO 8601 timestamp string (Helsinki-tz from backend) */
  date: string;
  status: BarFetchStatus;
  timeframes: BarTimeframeStatus[];
  last_error?: string | null;
}

// ─── Trade Review (bars + neighbors) ─────────────────────────────────────────

export type Timeframe = "daily" | "30min" | "2min";

export interface Bar {
  /** ISO 8601 timestamp string */
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
}

/** One indicator sample, timestamp matches a bar in `bars`.
 *  `value` is null on warm-up bars and any bar where the indicator
 *  isn't defined yet (e.g. start of a VWAP session with no volume). */
export interface IndicatorPoint {
  /** ISO 8601 timestamp string — same instant as the corresponding bar */
  time: string;
  value: number | null;
}

/** A named indicator overlay returned alongside the OHLCV bars.
 *  `name` is a stable key ('ema9', 'vwap'); `color` is a hint the
 *  frontend may use or override.
 *  `pane`: 0 = on price pane (overlay), 1+ = stacked sub-panes below.
 *  `series_type`: 'line' (default) or 'histogram' for bar-style display. */
export interface IndicatorSeries {
  name: string;
  label: string;
  color?: string | null;
  pane?: number;
  series_type?: "line" | "histogram";
  points: IndicatorPoint[];
}

export interface BarsResponse {
  tradeid: number;
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
  /** Empty for timeframes the backend hasn't wired indicators for. */
  indicators?: IndicatorSeries[];
}

export interface NeighborTrades {
  current: number;
  prev_id: number | null;
  next_id: number | null;
}

// ─── Analytics (weekly P/L per setup) ────────────────────────────────────────

/** One week of per-setup P/L. `by_setup` is keyed by setup label;
 *  values are Decimal-as-string. Missing keys = no trades for that
 *  setup that week (treat as 0). */
export interface WeeklyPnlBucket {
  /** YYYY-MM-DD — Monday in Europe/Helsinki. */
  week_start: string;
  by_setup: Record<string, string>;
}

/** Response for GET /api/analytics/weekly-pnl. `weeks` is contiguous
 *  (every Mon..Sun bucket is present, even empty ones) so the chart
 *  has a stable x-axis. `setups` is the alphabetically-sorted union
 *  of every setup that appeared in the window — use it for stable
 *  legend ordering and color assignment. */
export interface WeeklyPnlResponse {
  /** Which trade column P/L was attributed to. */
  group_by: "intended_setup" | "setup";
  weeks: WeeklyPnlBucket[];
  setups: string[];
}

/** One row of /api/analytics/setup-stats — aggregated win/loss + hold-
 *  time stats for a single setup over the requested window. Decimal
 *  fields arrive as strings; nullable fields are null when the bucket
 *  they describe is empty (e.g. `avg_win` is null if a setup never
 *  won in the window). Hold times are integer seconds. */
export interface SetupStatsRow {
  setup: string;
  trade_count: number;
  wins: number;
  losses: number;
  scratches: number;
  /** 0.0–1.0. wins / trade_count (scratches count in denominator). */
  win_rate: number;
  /** Positive Decimal as string, or null if no wins. */
  avg_win: string | null;
  /** Negative Decimal as string, or null if no losses. */
  avg_loss: string | null;
  /** Integer seconds, or null if no wins. */
  avg_win_hold_sec: number | null;
  /** Integer seconds, or null if no losses. */
  avg_loss_hold_sec: number | null;
  /** Net P/L per trade across the bucket (incl. scratches). Decimal
   *  as string; positive is good, negative is bad. */
  expectancy: string;
}

/** Response for GET /api/analytics/setup-stats. Rows are sorted by
 *  setup alphabetically. */
export interface SetupStatsResponse {
  group_by: "intended_setup" | "setup";
  weeks: number;
  rows: SetupStatsRow[];
}

/** One (planned setup → actual setup) bucket from
 *  GET /api/analytics/plan-vs-actual. Only trades with both `setup`
 *  and `intended_setup` populated contribute. A row where
 *  `planned_setup === actual_setup` is a matched trade; any other row
 *  is a deviation. P/L fields are Decimal-as-string. */
export interface PlanVsActualRow {
  planned_setup: string;
  actual_setup: string;
  trade_count: number;
  wins: number;
  losses: number;
  scratches: number;
  /** 0.0–1.0. wins / trade_count (scratches count in denominator). */
  win_rate: number;
  /** Summed realised P/L over the bucket. Decimal as string. */
  total_pnl: string;
  /** Per-trade average P/L over the bucket. Decimal as string. */
  avg_pnl: string;
}

/** Response for GET /api/analytics/plan-vs-actual. Rows are sorted by
 *  `total_pnl` ascending so the costliest deviations are at the top. */
export interface PlanVsActualResponse {
  weeks: number;
  rows: PlanVsActualRow[];
}
