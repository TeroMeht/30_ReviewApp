"use client";

/**
 * Hand-rolled SVG scatter — one dot per Helsinki trading day.
 *
 * X = total executions that day (sum of distinct ibOrderIDs across
 *     every trade on the day; matches the daily table's "Total execs").
 * Y = realised P/L summed across every trade that day.
 *
 * Dots are coloured by sign: green for positive P/L, red for negative,
 * grey for scratch days. A linear regression line is overlaid so the
 * user can see at a glance whether high-exec days trend positive or
 * negative.
 *
 * Hover a dot to see the date, P/L, exec count and trade count.
 *
 * No external charting library — keeps the dep footprint tiny and
 * matches the rest of the analytics charts in this folder. Easy to
 * swap for recharts later if richer interactions are needed.
 */

import * as React from "react";
import type { DailyPnlExecsResponse } from "@/lib/types";

const COLOR_PROFIT = "#16a34a";
const COLOR_LOSS = "#dc2626";
const COLOR_SCRATCH = "#94a3b8";
const COLOR_TREND = "#2563eb";

interface Props {
  data: DailyPnlExecsResponse;
  /** Total chart width in px. */
  width?: number;
  /** Plot height in px. */
  height?: number;
}

// Padding is generous on the left so $-axis labels fit, and on the
// bottom so the X-axis "Executions" label has space below the ticks.
const PAD = { top: 16, right: 24, bottom: 56, left: 64 } as const;

function parsePnl(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  // Compact $K on the axis so labels don't overflow.
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtMoneyFull(n: number): string {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  // Pin the locale so SSR and the browser produce the same string —
  // `undefined` uses the runtime default and breaks hydration.
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

function fmtDate(isoDate: string): string {
  // `YYYY-MM-DD` → local-formatted short label. Anchored at midnight
  // so the formatter doesn't drift across the dateline.
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Round `x` to the nearest "nice" axis tick step (1/2/5 × 10^n). */
function niceStep(roughStep: number): number {
  if (roughStep <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm = roughStep / pow;
  let step: number;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  return step * pow;
}

/** Ordinary-least-squares slope+intercept for points (x, y). Returns
 *  null when the X variance is zero (single point or all same x) — no
 *  meaningful line to draw in those cases. */
function regression(
  points: { x: number; y: number }[]
): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0, den = 0;
  for (const p of points) {
    const dx = p.x - mx;
    num += dx * (p.y - my);
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

export default function PnlVsExecsScatter({
  data,
  width = 960,
  height = 420,
}: Props) {
  const points = data.points.map((p) => ({
    date: p.date,
    x: p.exec_count,
    y: parsePnl(p.total_pnl),
    trade_count: p.trade_count,
  }));

  if (points.length === 0) {
    return (
      <div style={{ color: "#94a3b8", fontSize: 12 }}>
        No trading days with executions in this window.
      </div>
    );
  }

  // ─── Domain ────────────────────────────────────────────────────────
  let xMax = 0;
  let yMax = 0;
  let yMin = 0;
  for (const p of points) {
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
    if (p.y < yMin) yMin = p.y;
  }
  // X always starts at 0 — a 0-exec day is a meaningful left edge.
  // Pad up so the rightmost dot isn't glued to the right edge.
  const xDomainMax = Math.max(niceStep((xMax || 1) * 1.05), 1);
  // Symmetric-ish Y padding so $0 sits in a sensible vertical position
  // and the regression line has headroom. If all P/L is zero, fall
  // back to ±$100 to keep the plot from collapsing.
  if (yMax === 0 && yMin === 0) {
    yMax = 100;
    yMin = -100;
  }
  const yRange = yMax - yMin;
  const yStep = niceStep(yRange / 5);
  const yMaxNice = Math.ceil(yMax / yStep) * yStep;
  const yMinNice = Math.floor(yMin / yStep) * yStep;
  const xStep = niceStep(xDomainMax / 6);
  const xMaxNice = Math.ceil(xDomainMax / xStep) * xStep;

  // ─── Layout math ───────────────────────────────────────────────────
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  function xFor(value: number): number {
    return PAD.left + (value / xMaxNice) * plotW;
  }
  function yFor(value: number): number {
    return (
      PAD.top + ((yMaxNice - value) / (yMaxNice - yMinNice)) * plotH
    );
  }

  // ─── Tick lists ────────────────────────────────────────────────────
  const yTicks: number[] = [];
  for (let v = yMinNice; v <= yMaxNice + 1e-9; v += yStep) {
    yTicks.push(Math.round(v * 100) / 100);
  }
  const xTicks: number[] = [];
  for (let v = 0; v <= xMaxNice + 1e-9; v += xStep) {
    xTicks.push(Math.round(v));
  }

  // ─── Regression line ───────────────────────────────────────────────
  // OLS over the (exec_count, P/L) pairs. The line spans the X domain
  // so the user can see the slope at a glance even if all the data is
  // clustered low-X.
  const reg = regression(points.map((p) => ({ x: p.x, y: p.y })));
  let trendStart: { x: number; y: number } | null = null;
  let trendEnd: { x: number; y: number } | null = null;
  if (reg) {
    // Clip the line to the visible Y domain so it doesn't shoot off
    // the chart on steep slopes. We solve for the X-extent intersection
    // with both the X domain and the Y domain and take the inner pair.
    const xs: number[] = [0, xMaxNice];
    if (reg.slope !== 0) {
      xs.push((yMaxNice - reg.intercept) / reg.slope);
      xs.push((yMinNice - reg.intercept) / reg.slope);
    }
    // Keep only xs inside the visible X domain.
    const visibleXs = xs
      .filter((x) => x >= 0 - 1e-9 && x <= xMaxNice + 1e-9)
      .sort((a, b) => a - b);
    if (visibleXs.length >= 2) {
      const x0 = visibleXs[0];
      const x1 = visibleXs[visibleXs.length - 1];
      trendStart = { x: x0, y: reg.intercept + reg.slope * x0 };
      trendEnd = { x: x1, y: reg.intercept + reg.slope * x1 };
    }
  }

  // ─── Window-wide summary numbers ───────────────────────────────────
  const totalPnl = points.reduce((a, p) => a + p.y, 0);
  const totalExecs = points.reduce((a, p) => a + p.x, 0);
  const dayCount = points.length;
  const positiveDays = points.filter((p) => p.y > 0).length;
  const negativeDays = points.filter((p) => p.y < 0).length;

  return (
    <div style={{ width }}>
      {/* Compact text summary above the chart — mirrors WeeklyPnlChart
          and keeps the user oriented without a separate legend. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 14px",
          marginBottom: 8,
          fontSize: 12,
          color: "#475569",
        }}
      >
        <span>
          Days:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>{dayCount}</span>
          {" "}
          <span style={{ color: COLOR_PROFIT, fontWeight: 600 }}>
            {positiveDays}↑
          </span>
          {" "}
          <span style={{ color: COLOR_LOSS, fontWeight: 600 }}>
            {negativeDays}↓
          </span>
        </span>
        <span>
          Total execs:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>
            {totalExecs}
          </span>
        </span>
        <span>
          Total P/L:{" "}
          <span
            style={{
              color: totalPnl > 0 ? COLOR_PROFIT : totalPnl < 0 ? COLOR_LOSS : "#475569",
              fontWeight: 700,
            }}
          >
            {fmtMoneyFull(totalPnl)}
          </span>
        </span>
        {reg && (
          <span title="Ordinary-least-squares slope of P/L per +1 execution">
            Trend:{" "}
            <span
              style={{
                color: reg.slope > 0 ? COLOR_PROFIT : reg.slope < 0 ? COLOR_LOSS : "#475569",
                fontWeight: 600,
              }}
            >
              {fmtMoneyFull(reg.slope)} / exec
            </span>
          </span>
        )}
      </div>

      <svg
        width={width}
        height={height}
        style={{ display: "block", overflow: "visible" }}
        role="img"
        aria-label="Daily P/L vs daily execution count"
      >
        {/* Horizontal gridlines + Y-axis labels. The $0 line is darker
            so wins/losses are easy to distinguish at a glance. */}
        {yTicks.map((t) => (
          <g key={`yg-${t}`}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke={t === 0 ? "#94a3b8" : "#e2e8f0"}
              strokeWidth={t === 0 ? 1.2 : 1}
            />
            <text
              x={PAD.left - 6}
              y={yFor(t)}
              fontSize={10}
              fill="#64748b"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {fmtMoney(t)}
            </text>
          </g>
        ))}

        {/* Vertical gridlines + X-axis labels. */}
        {xTicks.map((t) => (
          <g key={`xg-${t}`}>
            <line
              x1={xFor(t)}
              x2={xFor(t)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="#f1f5f9"
              strokeWidth={1}
            />
            <text
              x={xFor(t)}
              y={PAD.top + plotH + 14}
              fontSize={10}
              fill="#64748b"
              textAnchor="middle"
            >
              {t}
            </text>
          </g>
        ))}

        {/* X-axis title under the tick row. */}
        <text
          x={PAD.left + plotW / 2}
          y={height - 8}
          fontSize={11}
          fill="#475569"
          textAnchor="middle"
          fontWeight={600}
        >
          Executions (orders)
        </text>

        {/* Y-axis title rotated along the left edge. */}
        <text
          x={-(PAD.top + plotH / 2)}
          y={14}
          fontSize={11}
          fill="#475569"
          textAnchor="middle"
          fontWeight={600}
          transform="rotate(-90)"
        >
          Daily P/L ($)
        </text>

        {/* Regression line. Drawn under the dots so big clusters stay
            visually prominent. Solid coloured stroke; dashed would
            read as "noisy" which is misleading. */}
        {trendStart && trendEnd && (
          <line
            x1={xFor(trendStart.x)}
            y1={yFor(trendStart.y)}
            x2={xFor(trendEnd.x)}
            y2={yFor(trendEnd.y)}
            stroke={COLOR_TREND}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.85}
          />
        )}

        {/* Dots. Slightly translucent so overlapping days are visible.
            Stroke matches fill for a crisp edge at small radii. */}
        {points.map((p) => {
          const fill =
            p.y > 0 ? COLOR_PROFIT : p.y < 0 ? COLOR_LOSS : COLOR_SCRATCH;
          return (
            <circle
              key={p.date}
              cx={xFor(p.x)}
              cy={yFor(p.y)}
              r={4}
              fill={fill}
              stroke={fill}
              fillOpacity={0.65}
              strokeWidth={1}
            >
              <title>
                {`${fmtDate(p.date)}\nP/L: ${fmtMoneyFull(p.y)}\nExecs: ${p.x}\nTrades: ${p.trade_count}`}
              </title>
            </circle>
          );
        })}

        {/* Plot frame. */}
        <line
          x1={PAD.left}
          x2={PAD.left}
          y1={PAD.top}
          y2={PAD.top + plotH}
          stroke="#cbd5e1"
        />
        <line
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke="#cbd5e1"
        />
      </svg>
    </div>
  );
}
