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
  setup: string | null;
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
