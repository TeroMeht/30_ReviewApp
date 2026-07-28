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

// ─── Order-level trade-review categories ────────────────────────────────────
// One row per IB order (iborderid). Categories are 1..4:
//   1 = Followed plan, made money
//   2 = Followed plan, stopped out at predefined stop
//   3 = Off-plan (FOMO / revenge), lost money
//   4 = Off-plan, made money in the end
// Missing row = uncategorised.

export type OrderCategoryValue = 1 | 2 | 3 | 4;

export interface OrderCategory {
  iborderid: string;
  trade_fk: number;
  category: OrderCategoryValue;
  /** ISO 8601 timestamp string; may be null if the server didn't populate it. */
  updated_at: string | null;
}

/** Body for PUT /api/order-categories/{iborderid}. */
export interface OrderCategoryUpsert {
  trade_fk: number;
  category: OrderCategoryValue;
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
  /** How many of this trade's distinct ibOrderIDs still lack a
   *  trade-review category. Populated by /trades/{id}/day and
   *  /trades/{id}/week only; null on every other read. When > 0 the
   *  daily/weekly tables show an "uncategorised" dot next to the Execs
   *  cell so the user is nudged to finish labelling. */
  uncategorized_count?: number | null;
  /** Hypothetical PnL if the trade had been exited at the MFE peak
   *  (capped at realized_pnl when a stop was hit before the peak).
   *  Populated by /trades/{id}/day and /trades/{id}/week when a saved
   *  MFE config + 2-min bars are both present; null otherwise.
   *  Decimal serialised as a string. */
  potential_pnl?: string | null;
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

// ─── Trade MFE (Maximum Favorable Excursion) ────────────────────────────────

/** Stored MFE inputs for one trade. `initial_stop_price` is a Decimal
 *  serialised as a string by FastAPI/pydantic. `stop_iborderid` is
 *  populated when the user picked an execution order as the source of
 *  the stop level; null when the price was typed in manually. */
export interface TradeMfeConfig {
  trade_fk: number;
  entry_iborderid: string;
  initial_stop_price: string;
  stop_iborderid: string | null;
  updated_at: string | null;
}

/** Body for PUT /api/trades/{tradeid}/mfe. Exactly one of
 *  `initial_stop_price` / `stop_iborderid` must be supplied — the
 *  backend rejects both-or-neither with 400. When `stop_iborderid` is
 *  used the backend resolves the picked order's qty-weighted avg fill
 *  price and stores that as `initial_stop_price`. */
export interface TradeMfeUpsert {
  entry_iborderid: string;
  /** Manual mode: number-like string, backend parses as Decimal. */
  initial_stop_price?: string;
  /** Execution mode: an ibOrderID from the trade's executions. */
  stop_iborderid?: string;
}

/** Response for GET/PUT /api/trades/{tradeid}/mfe.
 *
 *  All Decimal fields arrive as strings. `config` is null until the
 *  user saves the first time. Every `computed_*` field is null when
 *  either the config or the 2-min bar data isn't available yet — the
 *  frontend renders using the `note` field to explain the empty state.
 *
 *  `stopped_out` is true when a 2-min bar's adverse extreme touched
 *  the initial stop before the MFE peak bar; in that case
 *  `potential_pnl` is capped at `actual_pnl` (the MFE run wasn't
 *  realistically capturable). */
export interface TradeMfeResult {
  trade_fk: number;
  config: TradeMfeConfig | null;
  direction: "long" | "short" | null;
  entry_price: string | null;
  entry_time: string | null;
  entry_qty: number | null;
  mfe_price: string | null;
  mfe_time: string | null;
  potential_pnl: string | null;
  stopped_out: boolean;
  stopped_out_time: string | null;
  actual_pnl: string | null;
  bars_considered: number;
  note: string | null;
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

/** One day in the analytics scatter that plots P/L vs daily execution
 *  count. `date` is the Helsinki calendar day (YYYY-MM-DD). `exec_count`
 *  is the sum of distinct ibOrderIDs across every trade that day —
 *  matches the daily table's "Total execs" stat. Days with no
 *  executions are excluded by the backend. */
export interface DailyPnlExecsPoint {
  /** YYYY-MM-DD — Helsinki calendar day. */
  date: string;
  /** Decimal as string. Sum of per-trade realised P/L on this day. */
  total_pnl: string;
  exec_count: number;
  trade_count: number;
}

/** Response for GET /api/analytics/daily-pnl-vs-execs. `points` are
 *  ordered chronologically (oldest first). */
export interface DailyPnlExecsResponse {
  weeks: number;
  points: DailyPnlExecsPoint[];
}

/** One week's total execution count. `week_start` is the Monday
 *  (Europe/Helsinki) anchoring the bucket. `exec_count` is the sum of
 *  distinct ibOrderIDs across every trade in the week. `total_pnl` is
 *  the summed realised P/L over every trade in the week (Decimal as
 *  string; includes trades with NULL setup, unlike /weekly-pnl). Empty
 *  weeks are returned with zeros so the chart x-axis stays stable. */
export interface WeeklyExecsBucket {
  /** YYYY-MM-DD — Monday in Europe/Helsinki. */
  week_start: string;
  exec_count: number;
  trade_count: number;
  /** Decimal as string. */
  total_pnl: string;
}

/** Response for GET /api/analytics/weekly-execs. `weeks` is contiguous
 *  (every Mon..Sun bucket in the requested window is present, even
 *  empty ones). */
export interface WeeklyExecsResponse {
  window_weeks: number;
  weeks: WeeklyExecsBucket[];
}

/** One Mon..Sun (Helsinki) week's per-category order count. Counts
 *  every distinct IB order in the week, split by trade-review
 *  category; `uncategorized` picks up orders with no row in
 *  `order_categories` yet. By construction
 *    cat1 + cat2 + cat3 + cat4 + uncategorized
 *    == exec_count for the same week in /weekly-execs.
 *  Categories match the taxonomy in ExecutionsTable:
 *    cat1 — Followed plan, made money
 *    cat2 — Followed plan, stopped at plan stop
 *    cat3 — Off-plan (FOMO/revenge), lost money
 *    cat4 — Off-plan, made money in the end. */
export interface WeeklyOrderCategoriesBucket {
  /** YYYY-MM-DD — Monday in Europe/Helsinki. */
  week_start: string;
  cat1: number;
  cat2: number;
  cat3: number;
  cat4: number;
  uncategorized: number;
}

/** Response for GET /api/analytics/weekly-order-categories. Shares
 *  its window arithmetic with /weekly-execs so the two charts always
 *  align on the x-axis when called with the same `weeks` value. */
export interface WeeklyOrderCategoriesResponse {
  window_weeks: number;
  weeks: WeeklyOrderCategoriesBucket[];
}

/** One row of GET /api/playbook/setups — a setup label with aggregate
 *  stats over the requested window. Powers the Playbook page's section
 *  list. `total_pnl` is Decimal-as-string. */
export interface PlaybookSetupSummary {
  setup_label: string;
  trade_count: number;
  total_pnl: string;
}

/** Response for GET /api/playbook/setups. Rows ordered by `trade_count`
 *  desc — most-observed setups first. `weeks` is null when window=all. */
export interface PlaybookSetupsResponse {
  weeks: number | null;
  rows: PlaybookSetupSummary[];
}

/** One trade as it appears in the Playbook chart grid. Slim subset of
 *  Trade plus realized_pnl and the full observed_setup list so the
 *  card can render its '+ other observed setups' chip. */
export interface PlaybookTradeSummary {
  tradeid: number;
  symbol: string;
  /** ISO datetime — first execution time, Helsinki timezone. */
  date: string;
  setup: string | null;
  intended_setup: string | null;
  observed_setup: string[] | null;
  /** Decimal as string; null when the trade has no executions. */
  realized_pnl: string | null;
}

/** Response for GET /api/playbook/setups/{label}/trades. Trades sorted
 *  by date desc — most recent first. */
export interface PlaybookTradesResponse {
  setup_label: string;
  weeks: number | null;
  trades: PlaybookTradeSummary[];
}

/** Structured strategy notes for one setup. All text fields default to
 *  empty string so a setup that's never been written about still
 *  returns a well-formed object. `updated_at` is null when no row has
 *  been saved yet. */
export interface PlaybookNotes {
  setup_label: string;
  description: string;
  entry_rules: string;
  exit_rules: string;
  common_mistakes: string;
  examples: string;
  updated_at: string | null;
}

/** Body for PUT /api/playbook/setups/{label}/notes. Sent fields
 *  overwrite; omitted fields keep their existing values (PATCH-style). */
export interface PlaybookNotesUpdate {
  description?: string;
  entry_rules?: string;
  exit_rules?: string;
  common_mistakes?: string;
  examples?: string;
}

// ─── Weekly Review (Claude-generated) ─────────────────────────────────────────

/** Aggregate snapshot the review was built from. */
export interface WeeklyReviewStats {
  trade_count?: number;
  trades_with_pnl?: number;
  total_pnl?: number;
  wins?: number;
  losses?: number;
  scratches?: number;
  win_rate?: number;
  total_execs?: number;
  plan_deviations?: number;
}

/** A stored Claude-generated review for one Mon–Sun (Helsinki) week. */
export interface WeeklyReview {
  week_start: string;
  model: string;
  /** Review body as markdown. */
  content: string;
  stats: WeeklyReviewStats;
  created_at: string | null;
}
/** One selectable week in GET /api/reviews/weeks. */
export interface WeeklyReviewWeek {
  week_start: string;
  week_end: string;
  label: string;
  trade_count: number;
  has_review: boolean;
}

export interface WeeklyReviewWeeksResponse {
  weeks: WeeklyReviewWeek[];
}
