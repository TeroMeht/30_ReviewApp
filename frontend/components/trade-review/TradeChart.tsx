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
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
} from "lightweight-charts";
import type { Bar, IbExecution, Timeframe } from "@/lib/types";

interface Props {
  bars: Bar[];
  executions: IbExecution[];
  timeframe: Timeframe;
  label: string;
  height?: number;
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
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

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
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

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
