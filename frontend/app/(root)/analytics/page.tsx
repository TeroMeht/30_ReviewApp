"use client";

/**
 * Analytics page. First chart: weekly P/L per setup.
 *
 * Reads /api/analytics/weekly-pnl. Two user-controllable knobs:
 *   • weeks       — rolling window size (default 12)
 *   • group_by    — attribute P/L to intended_setup (actual, default)
 *                   or setup (planned)
 * The chart re-fetches whenever either control changes.
 *
 * The page is deliberately thin: it owns the controls + data
 * lifecycle, and delegates rendering to <WeeklyPnlChart />.
 */

import { useEffect, useState } from "react";
import HeaderBox from "@/components/HeaderBox";
import WeeklyPnlChart from "@/components/analytics/WeeklyPnlChart";
import SetupStatsTable from "@/components/analytics/SetupStatsTable";
import { API_PREFIX } from "@/lib/api_prefix";
import type { WeeklyPnlResponse } from "@/lib/types";

type GroupBy = "intended_setup" | "setup";

const WEEK_OPTIONS = [4, 8, 12, 26, 52] as const;

export default function AnalyticsPage() {
  const [weeks, setWeeks] = useState<number>(12);
  const [groupBy, setGroupBy] = useState<GroupBy>("intended_setup");
  const [data, setData] = useState<WeeklyPnlResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url = `${API_PREFIX}/analytics/weekly-pnl?weeks=${weeks}&group_by=${groupBy}`;
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
        const json: WeeklyPnlResponse = await res.json();
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

  // Window-wide grand total — sum across every (week, setup) cell.
  const grandTotal =
    data?.weeks.reduce((acc, w) => {
      for (const v of Object.values(w.by_setup)) {
        const n = Number(v);
        if (Number.isFinite(n)) acc += n;
      }
      return acc;
    }, 0) ?? 0;

  return (
    <section className="home">
      <div className="home-content">
        <header className="home-header">
          <HeaderBox
            type="title"
            title="Analytics"
            subtext="Weekly P/L attribution per setup."
          />
        </header>

        {/* Controls row. */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "flex-end",
            marginTop: 8,
            marginBottom: 16,
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
                title="Group P/L by what was actually executed"
              >
                Actual
              </button>
              <button
                type="button"
                onClick={() => setGroupBy("setup")}
                style={pill(groupBy === "setup")}
                aria-pressed={groupBy === "setup"}
                title="Group P/L by what was planned"
              >
                Planned
              </button>
            </div>
          </ControlGroup>

          <div
            style={{
              marginLeft: "auto",
              fontSize: 12,
              color: "#475569",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
            }}
          >
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8" }}>
              Window total
            </span>
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color:
                  grandTotal > 0 ? "#16a34a" : grandTotal < 0 ? "#b91c1c" : "#475569",
              }}
            >
              {fmtMoney(grandTotal)}
            </span>
          </div>
        </div>

        {/* Chart panel. */}
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#fff",
            padding: 16,
            overflowX: "auto",
          }}
        >
          {error && (
            <div style={{ color: "#b91c1c", fontSize: 12 }}>
              Failed to load analytics: {error}
            </div>
          )}
          {!error && loading && !data && (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>Loading…</div>
          )}
          {data && <WeeklyPnlChart data={data} />}
        </div>

        {/* Per-setup win/loss + hold-time stats. Independent window
            and group_by controls live inside the component. */}
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#fff",
            padding: 16,
            marginTop: 16,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#0f172a",
              borderBottom: "1px solid #e2e8f0",
              paddingBottom: 6,
              marginBottom: 12,
            }}
          >
            Setup stats — win/loss size and hold time
          </div>
          <SetupStatsTable />
        </div>
      </div>
    </section>
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

function fmtMoney(n: number): string {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}
