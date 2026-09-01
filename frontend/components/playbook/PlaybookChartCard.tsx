"use client";

/**
 * One trade card in the Playbook chart grid.
 *
 * Strategy/tactics view — the card deliberately hides plan, actual,
 * and P/L. Those are review-page concerns; here you're studying how
 * the *pattern* shows up on the chart, not how the trade went. The
 * "+ other observed setups" chip stays because it tells you the
 * pattern co-occurred with other patterns that day, which matters
 * when developing rules.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────┐
 *   │ AAPL · Mon 12.05.2026                          │
 *   │ + Trend continuation, Range break              │  ← chip when there
 *   │                                                │    are other observed
 *   │ ┌──────────────────────────────────────────┐   │    setups beyond the
 *   │ │           2-min chart (lazy)             │   │    one this section
 *   │ └──────────────────────────────────────────┘   │    is for
 *   └────────────────────────────────────────────────┘
 *
 * Click anywhere on the card to open the trade in /trade-review when
 * you do want to see the review-side detail (plan/actual/P/L/etc.).
 *
 * Lazy fetch: bars + executions are NOT loaded until the card scrolls
 * within 200px of the viewport. This keeps the page fast even when a
 * setup section has dozens of trades — only what you actually scroll to
 * hits the API. We use IntersectionObserver and never tear down once
 * loaded so scrolling back up doesn't refetch.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  BarsResponse,
  IbExecution,
  PlaybookTradeSummary,
} from "@/lib/types";
import TradeChart from "@/components/trade-review/TradeChart";

const HELSINKI_TZ = "Europe/Helsinki";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("fi-FI", {
    timeZone: HELSINKI_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

interface Props {
  trade: PlaybookTradeSummary;
  /** The setup label this card is being rendered under. Kept for API
   *  compatibility with callers; no longer used inside the card. */
  sectionLabel?: string;
}

export default function PlaybookChartCard({ trade }: Props) {
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement | null>(null);

  // `inView` flips true the first time the card scrolls near the
  // viewport and stays true after that (we don't tear down on scroll-
  // out — scrolling back shouldn't refetch).
  const [inView, setInView] = useState<boolean>(false);
  const [bars, setBars] = useState<BarsResponse | null>(null);
  const [executions, setExecutions] = useState<IbExecution[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // IntersectionObserver: load when within 200px of viewport.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  // Fetch bars + executions in parallel once the card is visible.
  useEffect(() => {
    if (!inView || bars !== null || executions !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const [barsRes, execsRes] = await Promise.all([
          fetch(`${API_PREFIX}/trades/${trade.tradeid}/bars?timeframe=2min`),
          fetch(`${API_PREFIX}/trades/${trade.tradeid}/executions`),
        ]);
        if (!barsRes.ok) throw new Error(`bars HTTP ${barsRes.status}`);
        if (!execsRes.ok) throw new Error(`executions HTTP ${execsRes.status}`);
        const barsJson: BarsResponse = await barsRes.json();
        const execsJson: IbExecution[] = await execsRes.json();
        if (cancelled) return;
        setBars(barsJson);
        setExecutions(execsJson);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inView, trade.tradeid, bars, executions]);

  const goToTrade = () => {
    router.push(`/trade-review?id=${trade.tradeid}`);
  };

  return (
    <div
      ref={cardRef}
      role="link"
      tabIndex={0}
      onClick={goToTrade}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goToTrade();
        }
      }}
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: "#fff",
        padding: 10,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        // Lift on hover so the click affordance is obvious.
        transition: "box-shadow 120ms ease, transform 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = "0 4px 12px rgba(15,23,42,0.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "none";
      }}
      title={`Open trade #${trade.tradeid} in Trade Review`}
    >
      {/* Header: symbol · date. Plan/actual/P/L deliberately omitted —
          this view is for studying the chart pattern, not reviewing
          the trade's outcome. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontWeight: 700,
            fontSize: 13,
            color: "#0f172a",
          }}
        >
          {trade.symbol}
        </span>
        <span style={{ fontSize: 11, color: "#64748b" }}>
          {fmtDate(trade.date)}
        </span>
      </div>

      {/* Chart area — placeholder, error, or live chart. Click bubbles
          up to the card; we stop propagation on the chart in case a
          future chart variant adds its own click handling. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ borderTop: "1px solid #f1f5f9", paddingTop: 6, marginTop: 2 }}
      >
        {error ? (
          <div
            style={{
              padding: 16,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              color: "#b91c1c",
              fontSize: 11,
              textAlign: "center",
            }}
          >
            Failed to load chart: {error}
          </div>
        ) : !inView || !bars || !executions ? (
          <div
            style={{
              height: 240,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px dashed #e2e8f0",
              borderRadius: 6,
              color: "#94a3b8",
              fontSize: 11,
              background: "#f8fafc",
            }}
          >
            {inView ? "Loading 2-min chart…" : "Chart loads as you scroll"}
          </div>
        ) : bars.bars.length === 0 ? (
          <div
            style={{
              height: 240,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px dashed #cbd5e1",
              borderRadius: 6,
              color: "#94a3b8",
              fontSize: 11,
              background: "#f8fafc",
              textAlign: "center",
              padding: 8,
            }}
          >
            No 2-min bars in DB. Run “Update Market Data” for this trade.
          </div>
        ) : (
          <TradeChart
            bars={bars.bars}
            executions={executions}
            timeframe="2min"
            label="2 min · 5D"
            // Smaller than trade-review (730px) — grid cards need to be
            // skimmable. Still tall enough that the price + indicator
            // panes inside TradeChart have room.
            height={360}
            indicators={bars.indicators}
            // Playbook view: only the execution markers and their text
            // labels should appear — strip the right-axis last-value
            // badges, the dashed last-close line, and indicator
            // reference-level labels. Also hide the EMA9 crossover
            // signal triangles since they'd clutter the grid view.
            hideLastValueLabels
            showCrossoverMarkers={false}
          />
        )}
      </div>
    </div>
  );
}
