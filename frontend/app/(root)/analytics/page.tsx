"use client";

/**
 * Analytics page — weekly execution count chart only.
 *
 * The page owns the shared `weeks` window control (default 12) and the
 * weekly-execs fetch lifecycle. The other panels (weekly P/L, setup
 * stats, plan-vs-actual) were removed for being visually noisy; the
 * underlying components still exist if we want to reinstate them later.
 */

import { useEffect, useState } from "react";
import HeaderBox from "@/components/HeaderBox";
import WeeklyExecsBarChart from "@/components/analytics/WeeklyExecsBarChart";
import { API_PREFIX } from "@/lib/api_prefix";
import type { WeeklyExecsResponse } from "@/lib/types";

const WEEK_OPTIONS = [4, 8, 12, 26, 52] as const;

export default function AnalyticsPage() {
  const [weeks, setWeeks] = useState<number>(12);

  // Weekly executions bar chart lifecycle.
  const [execs, setExecs] = useState<WeeklyExecsResponse | null>(null);
  const [execsLoading, setExecsLoading] = useState<boolean>(false);
  const [execsError, setExecsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExecsLoading(true);
    setExecsError(null);
    (async () => {
      try {
        const url = `${API_PREFIX}/analytics/weekly-execs?weeks=${weeks}`;
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
        const json: WeeklyExecsResponse = await res.json();
        if (!cancelled) setExecs(json);
      } catch (e) {
        if (!cancelled)
          setExecsError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setExecsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weeks]);

  return (
    <section className="home">
      <div className="home-content">
        <header className="home-header">
          <HeaderBox
            type="title"
            title="Analytics"
            subtext="Weekly execution activity."
          />
        </header>

        {/* Shared window control. */}
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
        </div>

        {/* Weekly execution count. */}
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#fff",
            padding: 16,
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
            Weekly execution count
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#64748b",
              marginBottom: 12,
            }}
          >
            One bar per Mon..Sun week. Y = sum of distinct IB order IDs
            across every trade in the week (same definition as the
            daily table&apos;s &ldquo;Total execs&rdquo;, aggregated to
            the week). Useful for spotting trends in how active you are
            over time.
          </div>
          {execsError && (
            <div style={{ color: "#b91c1c", fontSize: 12 }}>
              Failed to load weekly executions: {execsError}
            </div>
          )}
          {!execsError && execsLoading && !execs && (
            <div style={{ color: "#94a3b8", fontSize: 12 }}>Loading…</div>
          )}
          {execs && <WeeklyExecsBarChart data={execs} />}
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
