"use client";

/**
 * Thin React wrapper around TradingView lightweight-charts (v5).
 *
 * - Renders a single OHLCV candlestick chart with a volume histogram.
 * - Accepts execution markers (BUY blue triangle up, SELL red triangle
 *   down). Markers are SNAPPED to the nearest bar time per timeframe so
 *   they always land on a real candle even when the execution timestamp
 *   (e.g. 19:08) doesn't fall on a bar boundary.
 * - Chart axes display Europe/Helsinki wall-clock time regardless of the
 *   user's browser timezone. We feed the chart "Helsinki-wall-clock-
 *   as-if-UTC" seconds.
 */

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
  LineStyle,
} from "lightweight-charts";
import type { Bar, IbExecution, IndicatorSeries, Timeframe } from "@/lib/types";

interface Props {
  bars: Bar[];
  executions: IbExecution[];
  timeframe: Timeframe;
  label: string;
  height?: number;
  /** Optional overlays (EMA, VWAP, …) — one LineSeries per entry. */
  indicators?: IndicatorSeries[];
}

const HELSINKI_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function helsinkiWallSeconds(iso: string): UTCTimestamp {
  const parts = HELSINKI_FMT.formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Math.floor(
    Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second")
    ) / 1000
  ) as UTCTimestamp;
}

function nearestBarTime(
  target: number,
  barSeconds: number[],
  timeframe: Timeframe
): number {
  if (barSeconds.length === 0) {
    const step =
      timeframe === "2min" ? 120 : timeframe === "30min" ? 1800 : 86400;
    return Math.round(target / step) * step;
  }
  let bestI = 0;
  let bestDiff = Math.abs(barSeconds[0] - target);
  for (let i = 1; i < barSeconds.length; i++) {
    const diff = Math.abs(barSeconds[i] - target);
    if (diff <= bestDiff) {
      bestDiff = diff;
      bestI = i;
    } else if (barSeconds[i] > target) {
      break;
    }
  }
  return barSeconds[bestI];
}

export default function TradeChart({
  bars,
  executions,
  timeframe,
  label,
  height = 320,
  indicators,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // Keyed by indicator.name. Track pane + kind alongside the series so
  // we can detect when an indicator switches pane/type and recreate it
  // (those aren't mutable via applyOptions).
  const indicatorSeriesRef = useRef<
    Map<
      string,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        series: ISeriesApi<any>;
        pane: number;
        kind: "line" | "histogram";
      }
    >
  >(new Map());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#334155",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { borderColor: "#e2e8f0" },
      timeScale: {
        borderColor: "#e2e8f0",
        timeVisible: true,
        secondsVisible: false,
      },
      localization: { locale: "fi-FI" },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "#94a3b8",
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candles;
    volumeSeriesRef.current = volume;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      // Series are owned by the chart instance — `chart.remove()` disposes
      // them; we just clear our lookup map.
      indicatorSeriesRef.current.clear();
    };
  }, [height]);

  useEffect(() => {
    const candles = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!candles || !volume) return;

    const candleData = bars.map((b) => ({
      time: helsinkiWallSeconds(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }));
    const volumeData = bars.map((b) => ({
      time: helsinkiWallSeconds(b.time),
      value: b.volume,
      color:
        Number(b.close) >= Number(b.open)
          ? "rgba(22,163,74,0.4)"
          : "rgba(220,38,38,0.4)",
    }));

    candles.setData(candleData);
    volume.setData(volumeData);

    // Default zoom — per-timeframe windows so each chart opens at a
    // useful level of detail rather than fit-to-everything:
    //   * 2-min  → last Helsinki calendar day (5-day buffer to scroll left)
    //   * 30-min → last 10 calendar days       (30-day buffer behind)
    //   * daily  → last 6 calendar months      (1-year buffer behind)
    //
    // helsinkiWallSeconds encodes Helsinki wall-clock as UTC seconds, so
    // all date math below uses UTC functions on the Date object to stay
    // in that same "wall-clock" frame.
    const ts = chartRef.current?.timeScale();
    if (!ts) return;

    if (candleData.length > 0) {
      const lastSec = candleData[candleData.length - 1].time as number;
      let fromSec: number | null = null;

      if (timeframe === "2min") {
        // Midnight Helsinki of the last bar's day.
        fromSec = Math.floor(lastSec / 86400) * 86400;
      } else if (timeframe === "30min") {
        // 10 days back from the last bar.
        fromSec = lastSec - 10 * 86400;
      } else if (timeframe === "daily") {
        // 6 calendar months back — use Date math so month-lengths are
        // handled correctly (180-day approximation drifts).
        const d = new Date(lastSec * 1000);
        d.setUTCMonth(d.getUTCMonth() - 6);
        fromSec = Math.floor(d.getTime() / 1000);
      }

      if (fromSec !== null) {
        // Snap to the first bar at or after the cutoff so the visible
        // range always starts on a real candle.
        const cutoff = fromSec;
        const firstVisible = candleData.find(
          (c) => (c.time as number) >= cutoff
        );
        if (firstVisible) {
          ts.setVisibleRange({
            from: firstVisible.time,
            to: candleData[candleData.length - 1].time,
          });
          return;
        }
      }
    }

    ts.fitContent();
  }, [bars, timeframe]);

  // Indicator overlays.
  //   pane 0  → drawn on top of candles (EMA, VWAP)
  //   pane 1+ → stacked sub-panes below (Relatr, Rvol)
  //   kind=line | histogram
  //
  // We key by `name` and recreate the series only when pane / kind change
  // (those are constructor-time options in lightweight-charts).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const desired = indicators ?? [];
    const wantNames = new Set(desired.map((s) => s.name));

    // Drop series the latest payload no longer carries.
    for (const [name, entry] of indicatorSeriesRef.current) {
      if (!wantNames.has(name)) {
        try {
          chart.removeSeries(entry.series);
        } catch {
          /* chart already torn down — safe to ignore */
        }
        indicatorSeriesRef.current.delete(name);
      }
    }

    for (const ind of desired) {
      const pane = ind.pane ?? 0;
      const kind = (ind.series_type ?? "line") as "line" | "histogram";
      const color = ind.color ?? "#0f172a";

      let entry = indicatorSeriesRef.current.get(ind.name);

      // Pane / kind are addSeries-time options — if they change, drop and
      // recreate. (applyOptions can't move a series between panes.)
      if (entry && (entry.pane !== pane || entry.kind !== kind)) {
        try {
          chart.removeSeries(entry.series);
        } catch {
          /* ignore */
        }
        indicatorSeriesRef.current.delete(ind.name);
        entry = undefined;
      }

      if (!entry) {
        const series =
          kind === "histogram"
            ? chart.addSeries(
                HistogramSeries,
                {
                  color,
                  priceLineVisible: false,
                  lastValueVisible: false,
                  base: 0,
                },
                pane
              )
            : chart.addSeries(
                LineSeries,
                {
                  color,
                  lineWidth: 1,
                  priceLineVisible: false,
                  lastValueVisible: false,
                },
                pane
              );
        entry = { series, pane, kind };
        indicatorSeriesRef.current.set(ind.name, entry);

        // Relatr reference levels: 0 (mid) and ±0.5 (typical reversion
        // bands). createPriceLine is only called once at series-creation
        // time so it doesn't accumulate duplicates across re-renders.
        if (ind.name === "relatr") {
          series.createPriceLine({
            price: 0,
            color: "#000000",
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: "0",
          });
          series.createPriceLine({
            price: 0.5,
            color: "#000000",
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: "+0.5",
          });
          series.createPriceLine({
            price: -0.5,
            color: "#000000",
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: "-0.5",
          });
        }
      } else {
        entry.series.applyOptions({ color });
      }

      // Drop warm-up / undefined points — lightweight-charts wants
      // strictly increasing time and finite numbers.
      const data = ind.points
        .filter(
          (p): p is { time: string; value: number } =>
            p.value !== null && p.value !== undefined && Number.isFinite(p.value)
        )
        .map((p) => ({
          time: helsinkiWallSeconds(p.time),
          value: p.value,
        }));
      entry.series.setData(data);
    }

    // Pane sizing in lightweight-charts v5 is driven by stretch factors,
    // not absolute pixels. Default stretch is auto-assigned and ends up
    // heavily favouring the price pane, which leaves the Relatr pane
    // barely visible. Force a proportional split:
    //   price : relatr : rvol  =  4 : 2 : 1
    // (i.e. Relatr is half the price-pane height, Rvol is half of Relatr).
    const panes = chart.panes();
    if (panes.length >= 1) {
      try {
        panes[0].setStretchFactor(4); // price
      } catch {
        /* ignore */
      }
    }
    if (panes.length >= 2) {
      try {
        panes[1].setStretchFactor(2); // Relatr
      } catch {
        /* ignore */
      }
    }
    if (panes.length >= 3) {
      try {
        panes[2].setStretchFactor(1); // Rvol
      } catch {
        /* ignore */
      }
    }
  }, [indicators]);

  // Group fills by ibOrderID — 1 IB order = 1 marker, mirroring the
  // "Execs" column on the daily table. Multiple partial fills on the
  // same order collapse into a single arrow placed at the order's first
  // fill time, then snapped to the nearest bar.
  useEffect(() => {
    const candles = candleSeriesRef.current;
    if (!candles) return;

    const barSeconds = bars.map((b) => helsinkiWallSeconds(b.time) as number);

    const byOrder = new Map<string, IbExecution[]>();
    for (const e of executions) {
      // Fall back to per-fill key if iborderid is missing so we never lose
      // a marker entirely (shouldn't happen in practice).
      const key = e.ibOrderID || `__nofill_${e.tradeID}`;
      const arr = byOrder.get(key);
      if (arr) arr.push(e);
      else byOrder.set(key, [e]);
    }

    const markers: SeriesMarker<Time>[] = [];
    for (const fills of byOrder.values()) {
      const first = fills.reduce((a, b) =>
        new Date(a.dateTime).getTime() <= new Date(b.dateTime).getTime() ? a : b
      );
      const isBuy = first.buySell.toUpperCase() === "BUY";
      const targetSec = helsinkiWallSeconds(first.dateTime) as number;
      const snapped = nearestBarTime(targetSec, barSeconds, timeframe);
      markers.push({
        time: snapped as UTCTimestamp,
        position: isBuy ? "belowBar" : "aboveBar",
        color: isBuy ? "#2563eb" : "#dc2626",
        shape: isBuy ? "arrowUp" : "arrowDown",
        // No text — arrows only.
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));

    createSeriesMarkers(candles, markers);
  }, [executions, bars, timeframe]);

  return (
    <div
      style={{
        position: "relative",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        overflow: "hidden",
        background: "#fff",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 12,
          zIndex: 2,
          fontSize: 11,
          fontWeight: 600,
          color: "#475569",
          background: "rgba(255,255,255,0.85)",
          padding: "2px 8px",
          borderRadius: 4,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div ref={containerRef} style={{ width: "100%", height }} />
    </div>
  );
}
