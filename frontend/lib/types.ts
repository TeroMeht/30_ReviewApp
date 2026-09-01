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
  /** Free-form setup label (taxonomy enforced in the UI). */
  setup: string | null;
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
   *  /trades/{id}/week only; null on every other read. */
  uncategorized_count?: number | null;
}

/** Body for POST /api/trades */
export interface TradeCreate {
  symbol: string;
  /** ISO 8601 timestamp string */
  date: string;
  setup?: string | null;
  category?: string | null;
  notes?: string | null;
}

/** Body for PATCH /api/trades/{tradeid} (all optional) */
export interface TradeUpdate {
  symbol?: string;
  date?: string;
  setup?: string | null;
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

/** One indicator sample, timestamp matches a bar in `bars`. */
export interface IndicatorPoint {
  /** ISO 8601 timestamp string — same instant as the corresponding bar */
  time: string;
  value: number | null;
}

/** A named indicator overlay returned alongside the OHLCV bars. */
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

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface DailyPnlExecsPoint {
  /** YYYY-MM-DD — Helsinki calendar day. */
  date: string;
  /** Decimal as string. Sum of per-trade realised P/L on this day. */
  total_pnl: string;
  exec_count: number;
  trade_count: number;
}

export interface DailyPnlExecsResponse {
  weeks: number;
  points: DailyPnlExecsPoint[];
}

export interface WeeklyExecsBucket {
  /** YYYY-MM-DD — Monday in Europe/Helsinki. */
  week_start: string;
  exec_count: number;
  trade_count: number;
  /** Decimal as string. */
  total_pnl: string;
}

export interface WeeklyExecsResponse {
  window_weeks: number;
  weeks: WeeklyExecsBucket[];
}

export interface WeeklyOrderCategoriesBucket {
  /** YYYY-MM-DD — Monday in Europe/Helsinki. */
  week_start: string;
  cat1: number;
  cat2: number;
  cat3: number;
  cat4: number;
  uncategorized: number;
}

export interface WeeklyOrderCategoriesResponse {
  window_weeks: number;
  weeks: WeeklyOrderCategoriesBucket[];
}

// ─── Playbook ────────────────────────────────────────────────────────────────

export interface PlaybookSetupSummary {
  setup_label: string;
  trade_count: number;
  total_pnl: string;
}

export interface PlaybookSetupsResponse {
  weeks: number | null;
  rows: PlaybookSetupSummary[];
}

export interface PlaybookTradeSummary {
  tradeid: number;
  symbol: string;
  /** ISO datetime — first execution time, Helsinki timezone. */
  date: string;
  setup: string | null;
  /** Decimal as string; null when the trade has no executions. */
  realized_pnl: string | null;
}

export interface PlaybookTradesResponse {
  setup_label: string;
  weeks: number | null;
  trades: PlaybookTradeSummary[];
}

export interface PlaybookNotes {
  setup_label: string;
  description: string;
  entry_rules: string;
  exit_rules: string;
  common_mistakes: string;
  examples: string;
  updated_at: string | null;
}

export interface PlaybookNotesUpdate {
  description?: string;
  entry_rules?: string;
  exit_rules?: string;
  common_mistakes?: string;
  examples?: string;
}

// ─── Weekly Review (Claude-generated) ─────────────────────────────────────────

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

export interface WeeklyReview {
  week_start: string;
  model: string;
  /** Review body as markdown. */
  content: string;
  stats: WeeklyReviewStats;
  created_at: string | null;
}

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
