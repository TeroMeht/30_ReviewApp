"use client";

/**
 * One trade card in the Playbook chart gallery.
 *
 * Header: symbol · date · setup · rating badge. P/L is deliberately
 * hidden — this view is for studying how the pattern looks on the
 * chart, not how the trade went.
 *
 * Click anywhere on the card to open the trade in /trade-review.
 *
 * Lazy fetch: bars + executions are NOT loaded until the card scrolls
 * within 200px of the viewport, so a filter matching dozens of trades
 * only hits the API for what you actually scroll to. Once loaded we
 * never tear down, so scrolling back up doesn't refetch.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  BarsResponse,
  Bar,
  IbExecution,
  IndicatorSeries,
  PlaybookGalleryTrade,
} from "@/lib/types";
import TradeChart, {
  type ChartAnnotation,
} from "@/components/trade-review/TradeChart";

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
  trade: PlaybookGalleryTrade;
  /** When false, buy/sell execution markers are left off the chart. */
  showExecutions?: boolean;
}

const NO_EXECUTIONS: IbExecution[] = [];

/** Badge colours per rating — solid, darker fills; greener = better. */
function ratingStyle(r: string | null): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    padding: "1px 8px",
    borderRadius: 999,
    whiteSpace: "nowrap",
    color: "#fff",
  };
  switch (r) {
    case "A+":
      return { ...base, background: "#14532d" };
    case "A":
      return { ...base, background: "#15803d" };
    case "A-":
      return { ...base, background: "#0f766e" };
    case "B":
      return { ...base, background: "#a16207" };
    case "B-":
      return { ...base, background: "#c2410c" };
    default:
      return { ...base, background: "#64748b" };
  }
}

const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: HELSINKI_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const helsinkiDay = (iso: string) => DAY_FMT.format(new Date(iso));

// Regular US session check: 09:30 <= New York time < 16:00, returning the
// NY calendar day so we can match it to the trade day.
const NY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function rthDay(iso: string): string | null {
  const parts = NY_FMT.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  if (mins < 9 * 60 + 30 || mins >= 16 * 60) return null;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

interface RelatrMaxStats {
  /** Highest relATR in the trade day's regular session. relATR =
   *  (VWAP − close) / ATR, so this is where price is furthest below VWAP. */
  relatr: number;
  /** Bar where it happened (ISO) and that bar's close. */
  time: string;
  close: number;
  /** Previous trading day's regular-session close (last RTH 2-min bar). */
  prevClose: number | null;
  /** % change from prevClose to `close`. */
  changePct: number | null;
}

/** relATR max during the regular session of the trade day (pre-market /
 *  after-hours / other days in the 5D window ignored), plus the % move
 *  from the previous day's close to that bar's close. */
function relatrMaxStats(
  bars: Bar[],
  indicators: IndicatorSeries[] | undefined,
  tradeIso: string,
): RelatrMaxStats | null {
  const day = helsinkiDay(tradeIso);
  const rel = indicators?.find((s) => s.name === "relatr")?.points ?? [];

  let best: { time: string; value: number } | null = null;
  for (const p of rel) {
    if (p.value == null || rthDay(p.time) !== day) continue;
    if (!best || p.value > best.value) best = { time: p.time, value: p.value };
  }
  if (!best) return null;

  const bar = bars.find((b) => b.time === best!.time);
  if (!bar) return null;
  const close = Number(bar.close);

  // Last regular-session bar on the most recent earlier day.
  let prevClose: number | null = null;
  let prevDay = "";
  for (const b of bars) {
    const d = rthDay(b.time);
    if (d == null || d >= day) continue;
    if (d >= prevDay) {
      prevDay = d;
      prevClose = Number(b.close);
    }
  }

  const changePct =
    prevClose != null && prevClose !== 0
      ? ((close - prevClose) / prevClose) * 100
      : null;
  return { relatr: best.value, time: best.time, close, prevClose, changePct };
}

const fmtPct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap" }}>
      {label}{" "}
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          fontWeight: 700,
          color: "#0f172a",
        }}
      >
        {value}
      </span>
    </span>
  );
}

export default function PlaybookChartCard({
  trade,
  showExecutions = true,
}: Props) {
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

  const stats = useMemo(
    () => (bars ? relatrMaxStats(bars.bars, bars.indicators, trade.date) : null),
    [bars, trade.date],
  );

  // Marker on the relATR-max bar labelled with the move from prev close.
  const annotations = useMemo<ChartAnnotation[]>(
    () =>
      stats && stats.changePct != null
        ? [
            {
              time: stats.time,
              price: stats.close,
              text: `${fmtPct(stats.changePct)} from prev close`,
            },
          ]
        : [],
    [stats],
  );

  // Price pane (candles, volume, EMA9, VWAP, SMA) + the RVOL pane. The
  // relATR and speed panes are dropped — relATR max shows as a number
  // above. RVOL is moved to pane 1 because it's the only sub-pane left.
  const chartIndicators = useMemo(
    () =>
      bars?.indicators
        ?.filter((s) => (s.pane ?? 0) === 0 || s.name === "rvol")
        .map((s) => (s.name === "rvol" ? { ...s, pane: 1 } : s)),
    [bars],
  );

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
      {/* Header: symbol · date · setup · rating. */}
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
        <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap" }}>
          {fmtDate(trade.date)}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "#334155",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={trade.setup ?? "No setup"}
        >
          {trade.setup ?? "—"}
        </span>
        <span style={{ marginLeft: "auto", ...ratingStyle(trade.rating) }}>
          {trade.rating ?? "Unrated"}
        </span>
      </div>

      {/* relATR max + move from prev close (once bars are loaded). */}
      <div style={{ display: "flex", gap: 12, minHeight: 16 }}>
        {bars && (
          <>
            <Stat
              label="relATR max"
              value={stats == null ? "—" : stats.relatr.toFixed(2)}
            />
            <Stat
              label="prev close → max"
              value={
                stats?.changePct == null ? "—" : fmtPct(stats.changePct)
              }
            />
          </>
        )}
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
            executions={showExecutions ? executions : NO_EXECUTIONS}
            timeframe="2min"
            label="2 min · 5D"
            // Smaller than trade-review (730px) — grid cards need to be
            // skimmable. Still tall enough that the price + indicator
            // panes inside TradeChart have room.
            height={320}
            indicators={chartIndicators}
            annotations={annotations}
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
