"use client";

/**
 * Plan-vs-actual P/L attribution.
 *
 * Buckets trades by (planned setup → actual setup) and shows the cost
 * of each combination. Designed to answer: "I planned VWAP continuation
 * but ended up taking no setup — how much is that costing me?"
 *
 * Self-contained: owns its own weeks-window control and an optional
 * "deviations only" filter that hides matched (planned == actual) rows.
 * Backed by GET /api/analytics/plan-vs-actual which already filters to
 * trades that have BOTH setup and intended_setup labelled — the mapping
 * makes no sense otherwise.
 *
 * Columns:
 *   • Planned          – setup the trader planned for
 *   • Actual           – intended_setup that actually got executed
 *   • Trades           – bucket size (with W/L/S breakdown on hover)
 *   • Win rate (%)
 *   • Total P/L ($)    – summed realised P/L; the headline number
 *   • Avg P/L ($/trade)
 *
 * Rows arrive sorted by Total P/L ascending (worst first) so the
 * costliest deviations land at the top. Deviation rows are visually
 * distinct (amber, ⚠ marker) to mirror the daily/weekly trade tables.
 */

import { useEffect, useMemo, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type { PlanVsActualResponse } from "@/lib/types";

const WEEK_OPTIONS = [4, 8, 12, 26, 52] as const;

const COLOR_PROFIT = "#16a34a";
const COLOR_LOSS = "#dc2626";
const COLOR_NEUTRAL = "#475569";
const COLOR_DEVIATION = "#b45309";

function parseDec(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  // Pin the locale so SSR and the browser produce the same string;
  // `undefined` falls back to runtime default and breaks hydration in
  // non-en-US browsers.
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function moneyColor(n: number): string {
  if (n === 0) return COLOR_NEUTRAL;
  return n > 0 ? COLOR_PROFIT : COLOR_LOSS;
}

export default function PlanVsActualTable() {
  const [weeks, setWeeks] = useState<number>(12);
  const [deviationsOnly, setDeviationsOnly] = useState<boolean>(false);
  const [data, setData] = useState<PlanVsActualResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url = `${API_PREFIX}/analytics/plan-vs-actual?weeks=${weeks}`;
        const res = await fetch(url);
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
        const json: PlanVsActualResponse = await res.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weeks]);

  // Apply the deviation filter client-side so flipping it doesn't
  // re-fetch — the backend already returns the full set sorted, and
  // the dataset is small (one row per (planned, actual) pair).
  const visibleRows = useMemo(() => {
    if (!data) return [];
    return deviationsOnly
      ? data.rows.filter((r) => r.planned_setup !== r.actual_setup)
      : data.rows;
  }, [data, deviationsOnly]);

  // Footer totals reflect what the user is currently looking at, so
  // toggling "deviations only" updates the bottom-line cost number.
  const footer = useMemo(() => {
    let trades = 0;
    let total = 0;
    for (const r of visibleRows) {
      trades += r.trade_count;
      total += parseDec(r.total_pnl);
    }
    return { trades, total };
  }, [visibleRows]);

  return (
    <div>
      {/* Local controls — independent of the setup-stats table above. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignItems: "flex-end",
          marginBottom: 12,
        }}
      >
        <ControlGroup label="Window">
          <div style={{ display: "flex", gap: 4 }}>
            {WEEK_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setWeeks(n)}
                style={pill(weeks === n)}
                aria-pressed={weeks === n}
              >
                {n}w
              </button>
            ))}
          </div>
        </ControlGroup>

        <ControlGroup label="Show">
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              onClick={() => setDeviationsOnly(false)}
              style={pill(!deviationsOnly)}
              aria-pressed={!deviationsOnly}
              title="Include rows where planned setup matched the executed setup"
            >
              All mappings
            </button>
            <button
              type="button"
              onClick={() => setDeviationsOnly(true)}
              style={pill(deviationsOnly)}
              aria-pressed={deviationsOnly}
              title="Only rows where planned ≠ executed"
            >
              Deviations only
            </button>
          </div>
        </ControlGroup>
      </div>

      {error && (
        <div style={{ color: "#b91c1c", fontSize: 12 }}>
          Failed to load plan-vs-actual: {error}
        </div>
      )}
      {!error && loading && !data && (
        <div style={{ color: "#94a3b8", fontSize: 12 }}>Loading…</div>
      )}
      {data && data.rows.length === 0 && (
        <div style={{ color: "#94a3b8", fontSize: 12 }}>
          No trades in this window have both planned and executed setups
          labelled. Fill those fields in on the Trade Review page to
          populate this table.
        </div>
      )}
      {data && data.rows.length > 0 && visibleRows.length === 0 && (
        <div style={{ color: "#94a3b8", fontSize: 12 }}>
          No deviations in this window — every labelled trade matched
          its plan.
        </div>
      )}

      {data && visibleRows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            <thead style={{ color: "#64748b" }}>
              <tr>
                <th style={th}>Planned</th>
                <th style={th}>Actual</th>
                <th style={{ ...th, textAlign: "right" }}>Trades</th>
                <th style={{ ...th, textAlign: "right" }}>Win rate</th>
                <th style={{ ...th, textAlign: "right" }}>Total P/L</th>
                <th style={{ ...th, textAlign: "right" }}>Avg P/L</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const totalPnl = parseDec(r.total_pnl);
                const avgPnl = parseDec(r.avg_pnl);
                const deviation = r.planned_setup !== r.actual_setup;
                const lossSummary = `${r.wins} win${r.wins === 1 ? "" : "s"}, ${r.losses} loss${
                  r.losses === 1 ? "" : "es"
                }${r.scratches > 0 ? `, ${r.scratches} scratch${r.scratches === 1 ? "" : "es"}` : ""}`;
                return (
                  <tr
                    key={`${r.planned_setup}__${r.actual_setup}`}
                    style={{
                      borderTop: "1px solid #f1f5f9",
                      // Subtle row-tint on deviations so the eye lands
                      // on them when scanning a long list.
                      background: deviation ? "rgba(180,83,9,0.04)" : undefined,
                    }}
                  >
                    <td style={{ ...td, fontWeight: 600, color: "#0f172a" }}>
                      {r.planned_setup}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...(deviation
                          ? { color: COLOR_DEVIATION, fontWeight: 600 }
                          : { color: "#0f172a" }),
                      }}
                      title={
                        deviation
                          ? `Deviation: planned "${r.planned_setup}" → executed "${r.actual_setup}"`
                          : "Matched: executed setup matched the plan"
                      }
                    >
                      {deviation ? "⚠ " : ""}
                      {r.actual_setup}
                    </td>
                    <td style={{ ...td, ...numCell }} title={lossSummary}>
                      {r.trade_count}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: r.win_rate >= 0.5 ? COLOR_PROFIT : COLOR_LOSS,
                        fontWeight: 600,
                      }}
                    >
                      {fmtPct(r.win_rate)}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: moneyColor(totalPnl),
                        fontWeight: 700,
                      }}
                    >
                      {fmtMoney(totalPnl)}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: moneyColor(avgPnl),
                      }}
                    >
                      {fmtMoney(avgPnl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr
                style={{
                  borderTop: "2px solid #cbd5e1",
                  background: "#f8fafc",
                }}
              >
                <td
                  style={{ ...td, fontWeight: 700, color: "#475569" }}
                  colSpan={2}
                >
                  {deviationsOnly ? "Deviation total" : "Window total"}
                </td>
                <td style={{ ...td, ...numCell, fontWeight: 700 }}>
                  {footer.trades}
                </td>
                <td style={td} />
                <td
                  style={{
                    ...td,
                    ...numCell,
                    color: moneyColor(footer.total),
                    fontWeight: 700,
                  }}
                >
                  {fmtMoney(footer.total)}
                </td>
                <td style={td} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function ControlGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: "#64748b",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "5px 10px",
    fontSize: 12,
    borderRadius: 999,
    border: active ? "1px solid #2563eb" : "1px solid #e2e8f0",
    background: active ? "#dbeafe" : "#fff",
    color: active ? "#1e3a8a" : "#475569",
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
    fontFamily: "inherit",
  };
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  fontWeight: 600,
  fontSize: 10,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  borderBottom: "1px solid #e2e8f0",
};
const td: React.CSSProperties = {
  padding: "6px 8px",
  verticalAlign: "top",
};
const numCell: React.CSSProperties = {
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
