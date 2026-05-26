"use client";

/**
 * Analytics page — single shared control row at the top, every panel
 * below it consumes the same `weeks` / `group_by` values.
 *
 * Two user-controllable knobs:
 *   • weeks       — rolling window size (default 12)
 *   • group_by    — attribute P/L to intended_setup (actual, default)
 *                   or setup (planned). Only relevant for panels that
 *                   bucket by setup (weekly P/L chart, setup stats);
 *                   the scatter and plan-vs-actual panels ignore it.
 *
 * The page owns the controls + the weekly-P/L fetch lifecycle; each
 * child component owns its own fetch keyed on the props passed in.
 */

import { useEffect, useState } from "react";
import HeaderBox from "@/components/HeaderBox";
import WeeklyPnlChart from "@/components/analytics/WeeklyPnlChart";
import SetupStatsTable from "@/components/analytics/SetupStatsTable";
import PlanVsActualTable from "@/components/analytics/PlanVsActualTable";
import PnlVsExecsScatter from "@/components/analytics/PnlVsExecsScatter";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  DailyPnlExecsResponse,
  WeeklyPnlResponse,
} from "@/lib/types";

type GroupBy = "intended_setup" | "setup";

const WEEK_OPTIONS = [4, 8, 12, 26, 52] as const;

export default function AnalyticsPage() {
  const [weeks, setWeeks] = useState<number>(12);
  const [groupBy, setGroupBy] = useState<GroupBy>("intended_setup");
  const [data, setData] = useState<WeeklyPnlResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Scatter (P/L vs daily execs) lifecycle. Lives at the page level so
  // it reacts to the shared `weeks` control without any plumbing. It
  // ignores `groupBy` — the scatter aggregates per-day across every
  // trade regardless of setup.
  const [scatter, setScatter] = useState<DailyPnlExecsResponse | null>(null);
  const [scatterLoading, setScatterLoading] = useState<boolean>(false);
  const [scatterError, setScatterError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    setScatterLoading(true);
    setScatterError(null);
    (async () => {
      try {
        const url = `${API_PREFIX}/analytics/daily-pnl-vs-execs?weeks=${weeks}`;
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
        const json: DailyPnlExecsResponse = await res.json();
        if (!cancelled) setScatter(json);
      } catch (e) {
        if (!cancelled)
          setScatterError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setScatterLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weeks]);

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

        {/* Controls row — shared by every panel below. */}
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

        {/* Weekly P/L per setup. */}
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#fff",
            padding: 16,
            overflowX: "auto",
            overflowY: "visible",
            minHeight: "600px",
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

        {/* Daily P/L vs daily execution count. Consumes the shared
            `weeks` control above. Ignores `groupBy` — the scatter
            aggregates across every trade per day regardless of setup. */}
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
              marginBottom: 4,
            }}
          >
            Daily P/L vs. execution count
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#64748b",
              marginBottom: 12,
            }}
          >
            One dot per trading day. X = sum of distinct IB order IDs
            across every trade that day (same as the daily table&apos;s
            &ldquo;Total execs&rdquo;). Y = day&apos;s realised P/L.
            The dashed line is an ordinary-least-squares fit so you can
            see whether high-execution days trend positive or negative.
          </div>
          {scatterError && (
            <div style={{ color: "#b91c1c", fontSize: 12 }}>
              Failed to load scatter: {scatterError}
            </div>
          )}
          {!scatterError && scatterLoading && !scatter && (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>Loading…</div>
          )}
          {scatter && <PnlVsExecsScatter data={scatter} />}
        </div>

        {/* Per-setup win/loss + hold-time stats. Driven by the shared
            page-level weeks + groupBy controls. */}
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
          <SetupStatsTable weeks={weeks} groupBy={groupBy} />
        </div>

        {/* Plan-vs-actual deviations. Restricted to trades where both
            planned and intended setups are labelled — see component for
            why. Uses the shared `weeks` control; keeps its own
            deviations-only toggle as a table-local concern. */}
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
              marginBottom: 4,
            }}
          >
            Plan vs. actual — what each deviation costs
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#64748b",
              marginBottom: 12,
            }}
          >
            Only includes trades where both the planned setup and the
            executed (intended) setup are labelled. Sorted by total P/L
            ascending — the costliest mappings are at the top.
          </div>
          <PlanVsActualTable weeks={weeks} />
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
  // Pin the locale so SSR (Node, often en-US) and the browser agree —
  // `undefined` here pulled from the runtime default and caused a
  // hydration mismatch in non-en-US browsers.
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}
