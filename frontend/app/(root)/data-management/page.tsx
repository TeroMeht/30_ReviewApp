"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  BarFetchBatchResult,
  IbExecution,
  ManualTradeEntry,
  TradeBarStatus,
  TradeSyncRequest,
  TradeSyncResult,
} from "@/lib/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HELSINKI_TZ = "Europe/Helsinki";

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: HELSINKI_TZ,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: HELSINKI_TZ,
  });
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// One row in the manual-trades form. `id` is just a stable React key so
// removing rows from the middle of the list doesn't break input focus.
interface ManualRow {
  id: string;
  date: string;   // YYYY-MM-DD
  ticker: string; // displayed as-typed; uppercased on submit
}

function makeRow(): ManualRow {
  return {
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
    date: todayStr(),
    ticker: "",
  };
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DataManagementPage() {
  // /api/executions/ib pulls from IBKR Flex (year-to-date) and inserts new
  // rows into the executions table. The response includes every fetched
  // execution tagged with db_status: "inserted" | "duplicate" | "error".
  // We only show the rows that were actually inserted into the DB on this
  // sync — duplicates are filtered out client-side.
  const [execs, setExecs] = useState<IbExecution[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  // /api/trades/sync groups all executions whose trade_fk IS NULL by
  // (symbol, local-day) and creates one trade per bucket. Returns the full
  // list of newly inserted trade rows (trades_created_rows) plus how many
  // executions were linked. If both counts are 0 the DB is already up to
  // date and we just say so.
  const [tradeSync, setTradeSync] = useState<TradeSyncResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<Date | null>(null);

  // Manual trade entries that the user has queued up. They're sent in the
  // body of the next /trades/sync POST. In-memory only — refresh wipes them.
  const [manualRows, setManualRows] = useState<ManualRow[]>([makeRow()]);

  // /api/trades/fetch-bars-batch kicks off a background job that pulls bar
  // data from IBKR for every trade missing any of the 3 timeframes. The
  // server enforces the IB pacing rule (one ticker at a time). We poll
  // /api/trades/bars-status to keep the per-trade pills in sync until
  // every queued trade is no longer 'fetching'.
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketBatch, setMarketBatch] = useState<BarFetchBatchResult | null>(null);
  const [marketStatus, setMarketStatus] = useState<TradeBarStatus[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop polling on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const updateManualRow = (id: string, patch: Partial<ManualRow>) =>
    setManualRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  const addManualRow = () =>
    setManualRows((prev) => [...prev, makeRow()]);
  const removeManualRow = (id: string) =>
    setManualRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      // Always keep at least one row visible so the form never collapses.
      return next.length === 0 ? [makeRow()] : next;
    });
  const clearManualRows = () => setManualRows([makeRow()]);

  // Build the request payload from the current form rows. Empty tickers
  // are dropped (so the user can leave a blank trailing row in the form).
  // Tickers are uppercased here regardless of how they were typed.
  const buildManualPayload = (): ManualTradeEntry[] =>
    manualRows
      .map((r) => ({ symbol: r.ticker.trim().toUpperCase(), date: r.date }))
      .filter((e) => e.symbol.length > 0 && e.date.length > 0);

  const handleSync = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_PREFIX}/executions/ib`);
      if (!res.ok) {
        // Surface the FastAPI detail string when present.
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) detail = String(j.detail);
        } catch {
          /* non-JSON body — keep the status code */
        }
        throw new Error(detail);
      }
      const data: IbExecution[] = await res.json();
      setExecs(data);
      setLastSyncedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateTrades = async () => {
    setGenerating(true);
    setTradeError(null);
    try {
      const body: TradeSyncRequest = { manual_trades: buildManualPayload() };
      const res = await fetch(`${API_PREFIX}/trades/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) detail = String(j.detail);
        } catch {
          /* non-JSON body — keep the status code */
        }
        throw new Error(detail);
      }
      const data: TradeSyncResult = await res.json();
      setTradeSync(data);
      setLastGeneratedAt(new Date());
      // Reset the form on success so the user doesn't accidentally re-submit
      // the same manual entries on the next click.
      clearManualRows();
    } catch (e) {
      setTradeError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const stopMarketPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const pollMarketStatus = async (tradeids: number[]): Promise<boolean> => {
    // Returns true when nothing is still 'fetching' (i.e. it's safe to stop).
    const params = tradeids.map((id) => `tradeids=${id}`).join("&");
    const res = await fetch(`${API_PREFIX}/trades/bars-status?${params}`);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j?.detail) detail = String(j.detail);
      } catch {
        /* keep status */
      }
      throw new Error(detail);
    }
    const data: TradeBarStatus[] = await res.json();
    setMarketStatus(data);
    return data.every((d) => d.status !== "fetching");
  };

  const handleUpdateMarketData = async () => {
    setMarketLoading(true);
    setMarketError(null);
    setMarketBatch(null);
    setMarketStatus([]);
    stopMarketPolling();

    try {
      const res = await fetch(`${API_PREFIX}/trades/fetch-bars-batch`, {
        method: "POST",
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) detail = String(j.detail);
        } catch {
          /* keep status */
        }
        throw new Error(detail);
      }
      const data: BarFetchBatchResult = await res.json();
      setMarketBatch(data);

      // Nothing scheduled => nothing to poll.
      if (data.tradeids.length === 0) {
        setMarketLoading(false);
        return;
      }

      // Prime the table with one immediate poll, then poll every 2s until
      // the backend reports no trade is in 'fetching' state.
      await pollMarketStatus(data.tradeids);
      pollTimerRef.current = setInterval(async () => {
        try {
          const done = await pollMarketStatus(data.tradeids);
          if (done) {
            stopMarketPolling();
            setMarketLoading(false);
          }
        } catch (e) {
          stopMarketPolling();
          setMarketError(e instanceof Error ? e.message : String(e));
          setMarketLoading(false);
        }
      }, 2000);
    } catch (e) {
      setMarketError(e instanceof Error ? e.message : String(e));
      setMarketLoading(false);
    }
  };

  // Only newly inserted rows make it into the visible table.
  const insertedRows = useMemo(
    () => (execs ?? []).filter((e) => e.db_status === "inserted"),
    [execs]
  );

  const summary = useMemo(() => {
    if (!execs) return null;
    const inserted = execs.filter((e) => e.db_status === "inserted").length;
    const duplicate = execs.filter((e) => e.db_status === "duplicate").length;
    const errored = execs.filter((e) => e.db_status === "error").length;
    return { total: execs.length, inserted, duplicate, errored };
  }, [execs]);

  return (
    <div className="p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Data Management</h1>
          <p className="text-sm text-slate-500">
            Sync executions from IBKR Flex Web Service into the database.
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={loading}
          className="px-4 py-2 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "Syncing…" : "Sync Executions"}
        </button>
      </header>

      <section className="border border-slate-200 rounded-lg overflow-hidden bg-white">
        <div className="px-4 py-3 border-b border-slate-200 bg-white flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">New Executions Inserted</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Rows added to the database on the most recent sync. Duplicates
              already in the DB are filtered out.
            </p>
          </div>
          {lastSyncedAt && (
            <span className="text-xs text-slate-500">
              Last synced: {fmtDateTime(lastSyncedAt.toISOString())}
            </span>
          )}
        </div>

        {error && (
          <div className="text-sm px-4 py-2 border-b bg-red-50 border-red-200 text-red-700">
            {error}
          </div>
        )}

        {summary && !loading && (
          <div className="px-4 py-2 text-sm border-b border-slate-200 bg-slate-50 flex flex-wrap gap-3">
            <span className="font-medium">{summary.total} fetched from IB</span>
            {summary.inserted > 0 && (
              <Pill bg="rgba(22,163,74,0.12)" fg="#15803d">
                {summary.inserted} inserted
              </Pill>
            )}
            {summary.duplicate > 0 && (
              <Pill bg="rgba(100,116,139,0.12)" fg="#475569">
                {summary.duplicate} duplicate (skipped)
              </Pill>
            )}
            {summary.errored > 0 && (
              <Pill bg="rgba(220,38,38,0.14)" fg="#b91c1c">
                {summary.errored} error
              </Pill>
            )}
            {summary.total === 0 && (
              <span className="text-slate-500">
                No executions returned by Flex.
              </span>
            )}
            {summary.total > 0 && summary.inserted === 0 && (
              <span className="text-slate-500">
                Nothing new — database already up to date.
              </span>
            )}
          </div>
        )}

        {insertedRows.length > 0 && (
          <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 sticky top-0">
                <tr>
                  <Th>Time</Th>
                  <Th>Symbol</Th>
                  <Th>Action</Th>
                  <Th className="text-right">Quantity</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Commission</Th>
                  <Th>Trade ID</Th>
                  <Th>Order ID</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {insertedRows.map((e) => {
                  const isBuy = e.buySell.toUpperCase() === "BUY";
                  return (
                    <tr
                      key={e.tradeID}
                      className="border-t border-slate-100 hover:bg-slate-50"
                    >
                      <Td className="text-slate-600 whitespace-nowrap">
                        {fmtDateTime(e.dateTime)}
                      </Td>
                      <Td className="font-mono font-semibold">{e.symbol}</Td>
                      <Td>
                        <Pill
                          bg={
                            isBuy
                              ? "rgba(22,163,74,0.10)"
                              : "rgba(220,38,38,0.10)"
                          }
                          fg={isBuy ? "#15803d" : "#b91c1c"}
                        >
                          {e.buySell}
                        </Pill>
                      </Td>
                      <Td className="text-right tabular-nums">
                        {e.quantity.toLocaleString()}
                      </Td>
                      <Td className="text-right tabular-nums font-medium">
                        ${Number(e.tradePrice).toFixed(3)}
                      </Td>
                      <Td className="text-right tabular-nums text-slate-600">
                        ${Number(e.ibCommission).toFixed(2)}
                      </Td>
                      <Td className="font-mono text-xs text-slate-500 truncate max-w-[160px]">
                        {e.tradeID}
                      </Td>
                      <Td className="font-mono text-xs text-slate-500 truncate max-w-[160px]">
                        {e.ibOrderID}
                      </Td>
                      <Td>
                        <Pill bg="rgba(22,163,74,0.12)" fg="#15803d">
                          inserted
                        </Pill>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {execs === null && !loading && !error && (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            Press <strong>Sync Executions</strong> to pull the latest fills
            from IBKR Flex.
          </div>
        )}

        {execs !== null && insertedRows.length === 0 && !loading && (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            No new executions inserted on this sync.
          </div>
        )}
      </section>

      {/* ─── Manual Trades ─────────────────────────────────────────────── */}
      <section className="border border-slate-200 rounded-lg overflow-hidden bg-white">
        <div className="px-4 py-3 border-b border-slate-200 bg-white flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Manual Trades</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Queue trades that don&apos;t have executions backing them. Tickers
              are uppercased on submit. Empty rows are ignored. The list is
              sent on the next <strong>Generate Trades</strong> click.
            </p>
          </div>
          <button
            onClick={addManualRow}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            + Add row
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <Th className="w-44">Date</Th>
                <Th>Ticker</Th>
                <Th className="w-24"></Th>
              </tr>
            </thead>
            <tbody>
              {manualRows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Td>
                    <input
                      type="date"
                      value={row.date}
                      onChange={(e) =>
                        updateManualRow(row.id, { date: e.target.value })
                      }
                      className="border border-slate-300 rounded px-2 py-1 text-sm bg-white w-40"
                    />
                  </Td>
                  <Td>
                    <input
                      type="text"
                      value={row.ticker}
                      placeholder="aapl"
                      onChange={(e) =>
                        updateManualRow(row.id, { ticker: e.target.value })
                      }
                      className="border border-slate-300 rounded px-2 py-1 text-sm bg-white font-mono uppercase placeholder:normal-case placeholder:text-slate-400 w-40"
                    />
                  </Td>
                  <Td>
                    <button
                      onClick={() => removeManualRow(row.id)}
                      className="px-2 py-1 text-xs text-slate-500 border border-slate-300 rounded hover:bg-slate-100"
                      aria-label="Remove row"
                    >
                      Remove
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ─── Generate Trades ─────────────────────────────────────────────── */}
      <section className="border border-slate-200 rounded-lg overflow-hidden bg-white">
        <div className="px-4 py-3 border-b border-slate-200 bg-white flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Generate Trades</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Group unlinked executions into trades by (symbol, day) and link
              each execution to its trade. Idempotent — re-running when every
              execution is already linked is a no-op.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastGeneratedAt && (
              <span className="text-xs text-slate-500">
                Last run: {fmtDateTime(lastGeneratedAt.toISOString())}
              </span>
            )}
            <button
              onClick={handleGenerateTrades}
              disabled={generating}
              className="px-4 py-2 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50"
            >
              {generating ? "Generating…" : "Generate Trades"}
            </button>
          </div>
        </div>

        {tradeError && (
          <div className="text-sm px-4 py-2 border-b bg-red-50 border-red-200 text-red-700">
            {tradeError}
          </div>
        )}

        {tradeSync && !generating && (
          <div className="px-4 py-2 text-sm border-b border-slate-200 bg-slate-50 flex flex-wrap gap-3">
            {tradeSync.trades_created > 0 && (
              <Pill bg="rgba(22,163,74,0.12)" fg="#15803d">
                {tradeSync.trades_created} trade
                {tradeSync.trades_created === 1 ? "" : "s"} created
              </Pill>
            )}
            {(tradeSync.manual_trades_created ?? 0) > 0 && (
              <Pill bg="rgba(168,85,247,0.14)" fg="#7e22ce">
                {tradeSync.manual_trades_created} manual
              </Pill>
            )}
            {(tradeSync.manual_trades_skipped ?? 0) > 0 && (
              <Pill bg="rgba(100,116,139,0.12)" fg="#475569">
                {tradeSync.manual_trades_skipped} manual skipped (already
                existed)
              </Pill>
            )}
            {tradeSync.executions_linked > 0 && (
              <Pill bg="rgba(59,130,246,0.14)" fg="#1d4ed8">
                {tradeSync.executions_linked} execution
                {tradeSync.executions_linked === 1 ? "" : "s"} linked
              </Pill>
            )}
            {tradeSync.trades_created === 0 &&
              tradeSync.executions_linked === 0 &&
              (tradeSync.manual_trades_skipped ?? 0) === 0 && (
                <span className="font-medium text-slate-700">
                  Trades up to date — every execution is already linked.
                </span>
              )}
          </div>
        )}

        {tradeSync &&
          tradeSync.trades_created_rows &&
          tradeSync.trades_created_rows.length > 0 && (
            <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 sticky top-0">
                  <tr>
                    <Th>Trade ID</Th>
                    <Th>Date</Th>
                    <Th>Symbol</Th>
                    <Th>Setup (planned)</Th>
                    <Th>Intended (actual)</Th>
                    <Th>Observed</Th>
                    <Th>Category</Th>
                  </tr>
                </thead>
                <tbody>
                  {tradeSync.trades_created_rows.map((t) => (
                    <tr
                      key={t.tradeid}
                      className="border-t border-slate-100 hover:bg-slate-50"
                    >
                      <Td className="text-slate-500 tabular-nums">
                        {t.tradeid}
                      </Td>
                      <Td className="whitespace-nowrap">{fmtDate(t.date)}</Td>
                      <Td className="font-mono font-semibold">{t.symbol}</Td>
                      <Td className="text-slate-700">{t.setup ?? "—"}</Td>
                      <Td className="text-slate-700">
                        {t.intended_setup ?? "—"}
                      </Td>
                      <Td className="text-slate-700">
                        {t.observed_setup && t.observed_setup.length > 0
                          ? t.observed_setup.join(", ")
                          : "—"}
                      </Td>
                      <Td className="text-slate-700">{t.category ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {tradeSync === null && !generating && !tradeError && (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            Press <strong>Generate Trades</strong> to bucket executions into
            trades.
          </div>
        )}
      </section>

      {/* ─── Update Market Data ─────────────────────────────────────────── */}
      <section className="border border-slate-200 rounded-lg overflow-hidden bg-white">
        <div className="px-4 py-3 border-b border-slate-200 bg-white flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Update Market Data</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Pull daily / 30-min / 2-min bars from IBKR for every trade
              missing data. One ticker fetches at a time (IB pacing); the
              three timeframes for each ticker run concurrently. Bar
              timestamps are stored in Europe/Helsinki.
            </p>
          </div>
          <button
            onClick={handleUpdateMarketData}
            disabled={marketLoading}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50"
          >
            {marketLoading ? "Fetching…" : "Update Market Data"}
          </button>
        </div>

        {marketError && (
          <div className="text-sm px-4 py-2 border-b bg-red-50 border-red-200 text-red-700">
            {marketError}
          </div>
        )}

        {marketBatch && (
          <div className="px-4 py-2 text-sm border-b border-slate-200 bg-slate-50 flex flex-wrap gap-3 items-center">
            {marketBatch.scheduled > 0 ? (
              <Pill bg="rgba(59,130,246,0.14)" fg="#1d4ed8">
                {marketBatch.scheduled} trade
                {marketBatch.scheduled === 1 ? "" : "s"} queued
              </Pill>
            ) : (
              <span className="font-medium text-slate-700">
                Nothing to fetch — every trade already has bar data.
              </span>
            )}
            {marketBatch.skipped_already_fetching.length > 0 && (
              <Pill bg="rgba(100,116,139,0.12)" fg="#475569">
                {marketBatch.skipped_already_fetching.length} skipped (already
                fetching)
              </Pill>
            )}
          </div>
        )}

        {marketStatus.length > 0 && (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 sticky top-0">
                <tr>
                  <Th>Trade ID</Th>
                  <Th>Symbol</Th>
                  <Th>Date</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Daily</Th>
                  <Th className="text-right">30 min</Th>
                  <Th className="text-right">2 min</Th>
                  <Th>Last Error</Th>
                </tr>
              </thead>
              <tbody>
                {marketStatus.map((s) => {
                  const colors = barStatusColors(s.status);
                  const tfRows = (label: string) =>
                    s.timeframes.find((t) => t.timeframe === label)?.rows ?? 0;
                  return (
                    <tr
                      key={s.tradeid}
                      className="border-t border-slate-100 hover:bg-slate-50"
                    >
                      <Td className="text-slate-500 tabular-nums">
                        {s.tradeid}
                      </Td>
                      <Td className="font-mono font-semibold">{s.symbol}</Td>
                      <Td className="whitespace-nowrap">{fmtDate(s.date)}</Td>
                      <Td>
                        <Pill bg={colors.bg} fg={colors.fg}>
                          {s.status}
                        </Pill>
                      </Td>
                      <Td className="text-right tabular-nums">
                        {tfRows("daily").toLocaleString()}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {tfRows("30min").toLocaleString()}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {tfRows("2min").toLocaleString()}
                      </Td>
                      <Td className="text-xs text-red-700">
                        {s.last_error ?? ""}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {marketBatch === null && !marketLoading && !marketError && (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            Press <strong>Update Market Data</strong> to fetch missing bars
            from IBKR.
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-left px-3 py-2 font-medium border-b border-slate-200 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}

function Pill({
  bg,
  fg,
  children,
}: {
  bg: string;
  fg: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{ background: bg, color: fg }}
      className="inline-block px-2 py-[2px] rounded text-[11px] font-medium whitespace-nowrap"
    >
      {children}
    </span>
  );
}

function barStatusColors(status: string): { bg: string; fg: string } {
  switch (status) {
    case "done":
      return { bg: "rgba(22,163,74,0.12)", fg: "#15803d" };
    case "fetching":
      return { bg: "rgba(59,130,246,0.14)", fg: "#1d4ed8" };
    case "partial":
      return { bg: "rgba(234,179,8,0.16)", fg: "#a16207" };
    case "error":
      return { bg: "rgba(220,38,38,0.14)", fg: "#b91c1c" };
    case "pending":
    default:
      return { bg: "rgba(100,116,139,0.12)", fg: "#475569" };
  }
}
