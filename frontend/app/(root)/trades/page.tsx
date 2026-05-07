"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  Execution,
  Trade,
  TradeSyncResult,
  TradeUpdate,
} from "@/lib/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HELSINKI_TZ = "Europe/Helsinki";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("fi-FI", {
    timeZone: HELSINKI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("fi-FI", {
    timeZone: HELSINKI_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const NOW = new Date();

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TradesPage() {
  const [year, setYear] = useState<number>(NOW.getFullYear());
  const [month, setMonth] = useState<number>(NOW.getMonth() + 1);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<number | null>(null);
  const [executionsByTrade, setExecutionsByTrade] = useState<
    Record<number, Execution[]>
  >({});

  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<boolean>(false);

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadTrades = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `${API_PREFIX}/trades?year=${year}&month=${month}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET /trades ${res.status}`);
      const data: Trade[] = await res.json();
      setTrades(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    loadTrades();
  }, [loadTrades]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch(`${API_PREFIX}/trades/sync`, { method: "POST" });
      if (!res.ok) throw new Error(`POST /trades/sync ${res.status}`);
      const data: TradeSyncResult = await res.json();
      setSyncMsg(
        `Sync OK — created ${data.trades_created} trade(s), linked ${data.executions_linked} execution(s).`
      );
      await loadTrades();
    } catch (e) {
      setSyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const toggleExpand = async (tradeid: number) => {
    if (expanded === tradeid) {
      setExpanded(null);
      return;
    }
    setExpanded(tradeid);
    if (executionsByTrade[tradeid]) return;
    try {
      const res = await fetch(`${API_PREFIX}/trades/${tradeid}/executions`);
      if (!res.ok) throw new Error(`GET /trades/${tradeid}/executions ${res.status}`);
      const data: Execution[] = await res.json();
      setExecutionsByTrade((prev) => ({ ...prev, [tradeid]: data }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const patchTrade = async (tradeid: number, body: TradeUpdate) => {
    try {
      const res = await fetch(`${API_PREFIX}/trades/${tradeid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH /trades/${tradeid} ${res.status}`);
      const updated: Trade = await res.json();
      setTrades((prev) =>
        prev.map((t) => (t.tradeid === tradeid ? updated : t))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteTrade = async (tradeid: number) => {
    if (!confirm(`Delete trade #${tradeid}? Linked executions will be unlinked.`))
      return;
    try {
      const res = await fetch(`${API_PREFIX}/trades/${tradeid}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`DELETE /trades/${tradeid} ${res.status}`);
      setTrades((prev) => prev.filter((t) => t.tradeid !== tradeid));
      if (expanded === tradeid) setExpanded(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const yearOptions = useMemo(() => {
    const y = NOW.getFullYear();
    return [y - 2, y - 1, y, y + 1];
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Trades</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-slate-600">Year</label>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border border-slate-300 rounded px-2 py-1 text-sm"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <label className="text-sm text-slate-600">Month</label>
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="border border-slate-300 rounded px-2 py-1 text-sm"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m.toString().padStart(2, "0")}
              </option>
            ))}
          </select>
          <button
            onClick={loadTrades}
            className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            Reload
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-3 py-1 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync from executions"}
          </button>
        </div>
      </header>

      {syncMsg && (
        <div className="text-sm px-3 py-2 rounded bg-slate-50 border border-slate-200">
          {syncMsg}
        </div>
      )}
      {error && (
        <div className="text-sm px-3 py-2 rounded bg-red-50 border border-red-200 text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-x-auto border border-slate-200 rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-700">
            <tr>
              <Th>#</Th>
              <Th>Date</Th>
              <Th>Symbol</Th>
              <Th>Setup</Th>
              <Th>Price Action</Th>
              <Th>Price Position</Th>
              <Th>Category</Th>
              <Th>Notes</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-2" colSpan={9}>
                  Loading…
                </td>
              </tr>
            )}
            {!loading && trades.length === 0 && (
              <tr>
                <td className="px-3 py-2 text-slate-500" colSpan={9}>
                  No trades for {year}-{month.toString().padStart(2, "0")}.
                </td>
              </tr>
            )}
            {trades.map((t) => {
              const isOpen = expanded === t.tradeid;
              return (
                <Fragment key={t.tradeid}>
                  <tr
                    className="border-t border-slate-200 hover:bg-slate-50"
                  >
                    <Td>{t.tradeid}</Td>
                    <Td>{fmtDate(t.date)}</Td>
                    <Td className="font-mono">{t.symbol}</Td>
                    <Td>
                      <InlineText
                        value={t.setup ?? ""}
                        placeholder="—"
                        onCommit={(v) =>
                          patchTrade(t.tradeid, { setup: v || null })
                        }
                      />
                    </Td>
                    <Td>
                      <InlineNumber
                        value={t.price_action_rating}
                        min={1}
                        max={5}
                        onCommit={(v) =>
                          patchTrade(t.tradeid, { price_action_rating: v })
                        }
                      />
                    </Td>
                    <Td>
                      <InlineNumber
                        value={t.price_position}
                        onCommit={(v) =>
                          patchTrade(t.tradeid, { price_position: v })
                        }
                      />
                    </Td>
                    <Td>
                      <InlineText
                        value={t.category ?? ""}
                        placeholder="—"
                        onCommit={(v) =>
                          patchTrade(t.tradeid, { category: v || null })
                        }
                      />
                    </Td>
                    <Td>
                      <InlineText
                        value={t.notes ?? ""}
                        placeholder="—"
                        onCommit={(v) =>
                          patchTrade(t.tradeid, { notes: v || null })
                        }
                      />
                    </Td>
                    <Td>
                      <div className="flex gap-2">
                        <button
                          onClick={() => toggleExpand(t.tradeid)}
                          className="text-xs px-2 py-1 border border-slate-300 rounded hover:bg-slate-100"
                        >
                          {isOpen ? "Hide" : "Executions"}
                        </button>
                        <button
                          onClick={() => deleteTrade(t.tradeid)}
                          className="text-xs px-2 py-1 border border-red-300 text-red-700 rounded hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50">
                      <td colSpan={9} className="px-3 py-2">
                        <ExecutionList
                          rows={executionsByTrade[t.tradeid] ?? []}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2 font-medium border-b border-slate-200">
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

function InlineText({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      type="text"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="border border-transparent hover:border-slate-300 focus:border-slate-400 rounded px-1 py-0.5 text-sm w-full bg-transparent"
    />
  );
}

function InlineNumber({
  value,
  min,
  max,
  onCommit,
}: {
  value: number | null;
  min?: number;
  max?: number;
  onCommit: (v: number | null) => void;
}) {
  const [v, setV] = useState<string>(value === null ? "" : String(value));
  useEffect(() => setV(value === null ? "" : String(value)), [value]);
  return (
    <input
      type="number"
      value={v}
      min={min}
      max={max}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const next = v === "" ? null : Number(v);
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="border border-transparent hover:border-slate-300 focus:border-slate-400 rounded px-1 py-0.5 text-sm w-20 bg-transparent"
    />
  );
}

/**
 * Net P&L across the executions in a trade:
 *   sum(SOLD: size * price) − sum(BOUGHT: size * price)
 *
 * For a fully-closed trade (shares bought = shares sold) this equals
 * realized P&L. For a still-open trade it's the realized portion only —
 * the remaining open position isn't priced here.
 */
function computePnl(rows: Execution[]): {
  pnl: number;
  bought: number;
  sold: number;
  netShares: number;
} {
  let bought = 0;
  let sold = 0;
  let netShares = 0;
  for (const r of rows) {
    const px = parseFloat(r.price);
    if (Number.isNaN(px)) continue;
    const cash = r.size * px;
    if (r.action === "BOUGHT") {
      bought += cash;
      netShares += r.size;
    } else if (r.action === "SOLD") {
      sold += cash;
      netShares -= r.size;
    }
  }
  return { pnl: sold - bought, bought, sold, netShares };
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function ExecutionList({ rows }: { rows: Execution[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-slate-500">No executions linked yet.</div>
    );
  }
  const { pnl, bought, sold, netShares } = computePnl(rows);
  const pnlColor =
    pnl > 0 ? "text-green-700" : pnl < 0 ? "text-red-700" : "text-slate-700";
  const isOpen = netShares !== 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span>
          <span className="text-slate-500">P&amp;L: </span>
          <span className={`font-semibold ${pnlColor}`}>{fmtMoney(pnl)}</span>
        </span>
        <span className="text-slate-500">
          Bought {fmtMoney(bought)} · Sold {fmtMoney(sold)}
        </span>
        {isOpen && (
          <span className="text-amber-700">
            Open position: {netShares > 0 ? "+" : ""}
            {netShares} shares (P&amp;L is realized portion only)
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="text-slate-600">
            <tr>
              <th className="text-left px-2 py-1">Reference</th>
              <th className="text-left px-2 py-1">Time</th>
              <th className="text-left px-2 py-1">Action</th>
              <th className="text-right px-2 py-1">Size</th>
              <th className="text-right px-2 py-1">Price</th>
              <th className="text-left px-2 py-1">Category</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.reference} className="border-t border-slate-200">
                <td className="px-2 py-1 font-mono">{r.reference}</td>
                <td className="px-2 py-1">{fmtTime(r.time)}</td>
                <td className="px-2 py-1">{r.action}</td>
                <td className="px-2 py-1 text-right">{r.size}</td>
                <td className="px-2 py-1 text-right">{r.price}</td>
                <td className="px-2 py-1">{r.category ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
