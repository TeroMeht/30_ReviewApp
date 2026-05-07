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
  trad