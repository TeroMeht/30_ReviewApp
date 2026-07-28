"use client";

/**
 * MFE (Maximum Favorable Excursion) analysis for a single trade.
 *
 * The user pinpoints:
 *   1. The execution order that represents the trade's ENTRY (dropdown
 *      of the trade's ibOrderIDs). Scaled-in trades have several
 *      orders — the backend can't infer which is the "entry", so the
 *      user picks.
 *   2. The INITIAL stop price they had in mind BEFORE any mid-trade
 *      adjustment. This can't be inferred from executed stop orders
 *      because those may reflect a moved stop.
 *
 * The backend then:
 *   - Fetches the qty-weighted avg fill price + earliest fill time of
 *     the picked order.
 *   - Walks 2-min bars from that time to end of RTH (16:00 America/
 *     New_York) looking for the max favorable price:
 *       * BUY entry  → max(bar.high)   (long)
 *       * SELL entry → min(bar.low)    (short)
 *   - Chronologically checks whether any bar's adverse extreme (low
 *     for long, high for short) touched the stop before the peak. If
 *     so, `stopped_out=true` and `potential_pnl` is capped at the
 *     trade's actual realised PnL (the MFE run wasn't realistically
 *     capturable).
 *
 * Displayed:
 *   - Actual realised PnL (whole trade).
 *   - Potential PnL (MFE-based on picked entry qty).
 *   - Δ = potential − actual (money left on the table).
 *   - MFE price + time, and stop-hit warning if applicable.
 *
 * See backend/services/mfe.py for the compute logic.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { API_PREFIX } from "@/lib/api_prefix";
import type { IbExecution, TradeMfeResult } from "@/lib/types";

const HELSINKI_TZ = "Europe/Helsinki";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fi-FI", {
    timeZone: HELSINKI_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtMoney(v: string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPrice(v: string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(3)}`;
}

/** One aggregated entry-order option shown in the dropdown. Mirrors
 *  the ExecutionsTable's per-ibOrderID grouping so what the user picks
 *  here matches what they see in the executions table above. */
interface OrderOption {
  ibOrderID: string;
  earliestTime: string;
  buySell: string;
  totalQty: number;
  avgPrice: number;
}

function groupOrders(executions: IbExecution[]): OrderOption[] {
  const buckets = new Map<string, IbExecution[]>();
  for (const e of executions) {
    const k = e.ibOrderID || `__no_order_${e.tradeID}`;
    const arr = buckets.get(k);
    if (arr) arr.push(e);
    else buckets.set(k, [e]);
  }
  const out: OrderOption[] = [];
  for (const [ibOrderID, fills] of buckets) {
    const sorted = [...fills].sort((a, b) =>
      a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0
    );
    let totalQty = 0;
    let qtyTimesPrice = 0;
    for (const f of sorted) {
      const q = Number(f.quantity);
      const p = Number(f.tradePrice);
      totalQty += q;
      qtyTimesPrice += q * p;
    }
    const avgPrice = totalQty !== 0
      ? qtyTimesPrice / totalQty
      : sorted.reduce((a, f) => a + Number(f.tradePrice), 0) / sorted.length;
    out.push({
      ibOrderID,
      earliestTime: sorted[0].dateTime,
      buySell: sorted[0].buySell,
      totalQty,
      avgPrice,
    });
  }
  out.sort((a, b) =>
    a.earliestTime < b.earliestTime ? -1 : a.earliestTime > b.earliestTime ? 1 : 0
  );
  return out;
}

interface Props {
  tradeid: number;
  executions: IbExecution[];
}

export default function MfePanel({ tradeid, executions }: Props) {
  const [result, setResult] = useState<TradeMfeResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  // Form state — seeded from `result.config` when it loads.
  const [entryOrderId, setEntryOrderId] = useState<string>("");
  const [stopMode, setStopMode] = useState<"manual" | "execution">("manual");
  const [stopInput, setStopInput] = useState<string>("");
  const [stopOrderId, setStopOrderId] = useState<string>("");

  const orderOptions = useMemo(() => groupOrders(executions), [executions]);

  // Load stored config + current computed result whenever the trade
  // changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    async function load() {
      try {
        const res = await fetch(`${API_PREFIX}/trades/${tradeid}/mfe`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: TradeMfeResult = await res.json();
        if (cancelled) return;
        setResult(json);
        // Seed form from saved config, or clear it. When the saved
        // config used an execution as the stop source, restore the
        // "From execution" mode with that order preselected.
        setEntryOrderId(json.config?.entry_iborderid ?? "");
        if (json.config?.stop_iborderid) {
          setStopMode("execution");
          setStopOrderId(json.config.stop_iborderid);
          setStopInput(json.config.initial_stop_price ?? "");
        } else {
          setStopMode("manual");
          setStopOrderId("");
          setStopInput(json.config?.initial_stop_price ?? "");
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [tradeid]);

  const handleSave = useCallback(async () => {
    if (!entryOrderId) {
      setError("Pick an entry order first.");
      return;
    }
    // Build the stop half of the payload based on the selected source.
    // Exactly one of `initial_stop_price` / `stop_iborderid` goes on
    // the wire; the backend 400s otherwise.
    const stopPayload: Record<string, string> = {};
    if (stopMode === "execution") {
      if (!stopOrderId) {
        setError("Pick a stop order first.");
        return;
      }
      stopPayload.stop_iborderid = stopOrderId;
    } else {
      // Reject non-positive / non-numeric stops early so we don't send
      // garbage to the backend (which would 400 anyway).
      const stopNum = Number(stopInput);
      if (!Number.isFinite(stopNum) || stopNum <= 0) {
        setError("Enter a valid initial stop price (> 0).");
        return;
      }
      stopPayload.initial_stop_price = String(stopNum);
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_PREFIX}/trades/${tradeid}/mfe`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_iborderid: entryOrderId,
          ...stopPayload,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `HTTP ${res.status}`);
      }
      const json: TradeMfeResult = await res.json();
      setResult(json);
      // Backend resolved the picked-order price → sync the visible
      // number input so it matches what got stored.
      if (json.config?.initial_stop_price) {
        setStopInput(json.config.initial_stop_price);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [tradeid, entryOrderId, stopMode, stopInput, stopOrderId]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_PREFIX}/trades/${tradeid}/mfe`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refetch so we get the "no config" note.
      const g = await fetch(`${API_PREFIX}/trades/${tradeid}/mfe`);
      if (!g.ok) throw new Error(`HTTP ${g.status}`);
      const json: TradeMfeResult = await g.json();
      setResult(json);
      setEntryOrderId("");
      setStopInput("");
      setStopOrderId("");
      setStopMode("manual");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [tradeid]);

  // Computed values for display.
  const actualN = result?.actual_pnl != null ? Number(result.actual_pnl) : null;
  const potentialN = result?.potential_pnl != null ? Number(result.potential_pnl) : null;

  if (loading) {
    return <div style={{ fontSize: 12, color: "#64748b" }}>Loading MFE…</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <label style={labelWrap}>
          <span style={labelText}>Entry order</span>
          <select
            value={entryOrderId}
            onChange={(e) => setEntryOrderId(e.target.value)}
            disabled={saving || orderOptions.length === 0}
            style={{ ...control, minWidth: 280 }}
          >
            <option value="">— pick an order —</option>
            {orderOptions.map((o) => (
              <option key={o.ibOrderID} value={o.ibOrderID}>
                {fmtTime(o.earliestTime)} · {o.buySell} {o.totalQty} @ {fmtPrice(String(o.avgPrice))}
              </option>
            ))}
          </select>
        </label>

        <div style={labelWrap}>
          <span style={labelText}>Initial stop source</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              onClick={() => setStopMode("manual")}
              disabled={saving}
              style={stopMode === "manual" ? tabActive : tabInactive}
            >
              Manual
            </button>
            <button
              type="button"
              onClick={() => setStopMode("execution")}
              disabled={saving || orderOptions.length === 0}
              style={stopMode === "execution" ? tabActive : tabInactive}
              title={
                orderOptions.length === 0
                  ? "No executions linked to this trade"
                  : "Pick an executed order as the stop level"
              }
            >
              From execution
            </button>
          </div>
        </div>

        {stopMode === "manual" ? (
          <label style={labelWrap}>
            <span style={labelText}>Initial stop $</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={stopInput}
              onChange={(e) => setStopInput(e.target.value)}
              disabled={saving}
              placeholder="e.g. 55.20"
              style={{ ...control, width: 120 }}
            />
          </label>
        ) : (
          <label style={labelWrap}>
            <span style={labelText}>Stop order</span>
            <select
              value={stopOrderId}
              onChange={(e) => setStopOrderId(e.target.value)}
              disabled={saving || orderOptions.length === 0}
              style={{ ...control, minWidth: 280 }}
              title="Backend will use this order's qty-weighted avg fill price as the initial stop."
            >
              <option value="">— pick an order —</option>
              {orderOptions.map((o) => (
                <option key={o.ibOrderID} value={o.ibOrderID}>
                  {fmtTime(o.earliestTime)} · {o.buySell} {o.totalQty} @ {fmtPrice(String(o.avgPrice))}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={
            saving ||
            !entryOrderId ||
            (stopMode === "manual" ? !stopInput : !stopOrderId)
          }
          style={btnPrimary}
        >
          {saving ? "Saving…" : "Save & compute"}
        </button>

        {result?.config && (
          <button
            type="button"
            onClick={handleClear}
            disabled={saving}
            style={btnSecondary}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div style={errBox}>{error}</div>
      )}

      {result?.note && (
        <div style={noteBox}>{result.note}</div>
      )}

      {result?.stopped_out && (
        <div style={warnBox}>
          Stop was tagged at {fmtTime(result.stopped_out_time)} — before the MFE peak.
          Potential PnL capped at actual (the MFE run wasn&apos;t realistically capturable).
        </div>
      )}

      {result && result.direction && (
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Metric label="Direction" value={result.direction.toUpperCase()} />
          <Metric label="Entry" value={`${fmtPrice(result.entry_price)} × ${result.entry_qty ?? "—"}`} sub={fmtTime(result.entry_time)} />
          <Metric
            label="Initial stop"
            value={fmtPrice(result.config?.initial_stop_price ?? null)}
            sub={result.config?.stop_iborderid ? "from execution" : "manual"}
          />
          <Metric label="MFE price" value={fmtPrice(result.mfe_price)} sub={fmtTime(result.mfe_time)} />
          <Metric label="Actual PnL" value={fmtMoney(result.actual_pnl)} tone={actualN != null ? (actualN >= 0 ? "pos" : "neg") : "neutral"} />
          <Metric label="Potential PnL" value={fmtMoney(result.potential_pnl)} tone={potentialN != null ? (potentialN >= 0 ? "pos" : "neg") : "neutral"} />
        </div>
      )}
    </div>
  );
}

// ─── Small metric card ──────────────────────────────────────────────────────

interface MetricProps {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg" | "warn" | "neutral";
}

function Metric({ label, value, sub, tone = "neutral" }: MetricProps) {
  const color =
    tone === "pos" ? "#15803d" :
    tone === "neg" ? "#b91c1c" :
    tone === "warn" ? "#a16207" :
    "#0f172a";
  return (
    <div style={{
      background: "#f8fafc",
      border: "1px solid #e2e8f0",
      borderRadius: 6,
      padding: "8px 10px",
    }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const labelWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const labelText: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", fontWeight: 600 };
const control: React.CSSProperties = {
  fontSize: 12,
  padding: "5px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  background: "#fff",
};
const btnPrimary: React.CSSProperties = {
  fontSize: 12,
  padding: "6px 14px",
  border: "1px solid #1d4ed8",
  borderRadius: 4,
  background: "#2563eb",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};
// Kept as separate longhand properties (borderWidth/Style/Color)
// rather than the `border` shorthand so React doesn't warn when we
// swap between active/inactive styles on the same button — React
// forbids mixing shorthand + longhand for the same visual property
// across renders. See:
//   https://github.com/facebook/react/issues/17982
const tabBase: React.CSSProperties = {
  fontSize: 11,
  padding: "5px 10px",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#cbd5e1",
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 600,
};
const tabActive: React.CSSProperties = {
  ...tabBase,
  background: "#2563eb",
  color: "#fff",
  borderColor: "#1d4ed8",
};
const tabInactive: React.CSSProperties = {
  ...tabBase,
  background: "#fff",
  color: "#334155",
};
const btnSecondary: React.CSSProperties = {
  fontSize: 12,
  padding: "6px 14px",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  background: "#fff",
  color: "#334155",
  cursor: "pointer",
};
const errBox: React.CSSProperties = {
  marginTop: 10, padding: "6px 10px",
  fontSize: 12, color: "#b91c1c",
  background: "#fef2f2", border: "1px solid #fecaca",
  borderRadius: 4,
};
const noteBox: React.CSSProperties = {
  marginTop: 10, padding: "6px 10px",
  fontSize: 12, color: "#475569",
  background: "#f1f5f9", border: "1px solid #e2e8f0",
  borderRadius: 4,
};
const warnBox: React.CSSProperties = {
  marginTop: 10, padding: "6px 10px",
  fontSize: 12, color: "#92400e",
  background: "#fef3c7", border: "1px solid #fde68a",
  borderRadius: 4,
};
