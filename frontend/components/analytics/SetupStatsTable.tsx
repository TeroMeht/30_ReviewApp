"use client";

/**
 * Per-setup win/loss + hold-time stats table.
 *
 * Self-contained: owns its own weeks-window and group_by controls and
 * its own data fetch lifecycle. Dropped into the analytics page next
 * to the weekly P/L chart but independent of it.
 *
 * Columns:
 *   • Setup
 *   • Trades (count) — with wins/losses/scratches breakdown on hover
 *   • Win rate (%)
 *   • Avg win ($), positive
 *   • Avg loss ($), negative
 *   • Avg win hold (min:sec)
 *   • Avg loss hold (min:sec)
 *   • Expectancy ($/trade) — colored by sign
 */

import { useEffect, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type { SetupStatsResponse } from "@/lib/types";

type GroupBy = "intended_setup" | "setup";
const WEEK_OPTIONS = [4, 8, 12, 26, 52] as const;

const COLOR_PROFIT = "#16a34a";
const COLOR_LOSS = "#dc2626";
const COLOR_NEUTRAL = "#475569";

function parseDec(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtMoney(n: number | null): string {
  if (n === null) return "—";
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** Render seconds as `Hh Mm Ss` (drops empty leading parts). Used
 *  for hold-time columns. Returns "—" for null and "0s" for zero. */
function fmtDuration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec === 0) return "0s";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

function moneyColor(n: number | null): string {
  if (n === null || n === 0) return COLOR_NEUTRAL;
  return n > 0 ? COLOR_PROFIT : COLOR_LOSS;
}

export default function SetupStatsTable() {
  const [weeks, setWeeks] = useState<number>(12);
  const [groupBy, setGroupBy] = useState<GroupBy>("intended_setup");
  const [data, setData] = useState<SetupStatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url = `${API_PREFIX}/analytics/setup-stats?weeks=${weeks}&group_by=${groupBy}`;
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
        const json: SetupStatsResponse = await res.json();
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
  }, [weeks, groupBy]);

  return (
    <div>
      {/* Local controls row — independent of the weekly chart above. */}
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

        <ControlGroup label="Attribute to">
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              onClick={() => setGroupBy("intended_setup")}
              style={pill(groupBy === "intended_setup")}
              aria-pressed={groupBy === "intended_setup"}
              title="Group by what was actually executed"
            >
              Actual
            </button>
            <button
              type="button"
              onClick={() => setGroupBy("setup")}
              style={pill(groupBy === "setup")}
              aria-pressed={groupBy === "setup"}
              title="Group by what was planned"
            >
              Planned
            </button>
          </div>
        </ControlGroup>
      </div>

      {error && (
        <div style={{ color: "#b91c1c", fontSize: 12 }}>
          Failed to load setup stats: {error}
        </div>
      )}
      {!error && loading && !data && (
        <div style={{ color: "#94a3b8", fontSize: 12 }}>Loading…</div>
      )}
      {data && data.rows.length === 0 && (
        <div style={{ color: "#94a3b8", fontSize: 12 }}>
          No labelled trades in this window.
        </div>
      )}
      {data && data.rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            <thead style={{ color: "#64748b" }}>
              <tr>
                <th style={th}>Setup</th>
                <th style={{ ...th, textAlign: "right" }}>Trades</th>
                <th style={{ ...th, textAlign: "right" }}>Win rate</th>
                <th style={{ ...th, textAlign: "right" }}>Avg win</th>
                <th style={{ ...th, textAlign: "right" }}>Avg loss</th>
                <th style={{ ...th, textAlign: "right" }}>Avg win hold</th>
                <th style={{ ...th, textAlign: "right" }}>Avg loss hold</th>
                <th style={{ ...th, textAlign: "right" }}>Expectancy</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const avgWin = parseDec(r.avg_win);
                const avgLoss = parseDec(r.avg_loss);
                const expectancy = parseDec(r.expectancy) ?? 0;
                return (
                  <tr
                    key={r.setup}
                    style={{ borderTop: "1px solid #f1f5f9" }}
                  >
                    <td style={{ ...td, fontWeight: 600, color: "#0f172a" }}>
                      {r.setup}
                    </td>
                    <td
                      style={{ ...td, ...numCell }}
                      title={`${r.wins} win${r.wins === 1 ? "" : "s"}, ${r.losses} loss${
                        r.losses === 1 ? "" : "es"
                      }${r.scratches > 0 ? `, ${r.scratches} scratch${r.scratches === 1 ? "" : "es"}` : ""}`}
                    >
                      {r.trade_count}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color:
                          r.win_rate >= 0.5 ? COLOR_PROFIT : COLOR_LOSS,
                        fontWeight: 600,
                      }}
                    >
                      {fmtPct(r.win_rate)}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: avgWin === null ? "#94a3b8" : COLOR_PROFIT,
                      }}
                    >
                      {fmtMoney(avgWin)}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: avgLoss === null ? "#94a3b8" : COLOR_LOSS,
                      }}
                    >
                      {fmtMoney(avgLoss)}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: r.avg_win_hold_sec === null ? "#94a3b8" : "#475569",
                      }}
                    >
                      {fmtDuration(r.avg_win_hold_sec)}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: r.avg_loss_hold_sec === null ? "#94a3b8" : "#475569",
                      }}
                    >
                      {fmtDuration(r.avg_loss_hold_sec)}
                    </td>
                    <td
                      style={{
                        ...td,
                        ...numCell,
                        color: moneyColor(expectancy),
                        fontWeight: 700,
                      }}
                    >
                      {fmtMoney(expectancy)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
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
