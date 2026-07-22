"use client";

/**
 * Hand-rolled SVG bar chart — weekly execution count over time, with
 * the week's net P/L printed above each bar.
 *
 * X = week (Monday-anchored, Europe/Helsinki). One bar per week.
 * Y = total executions in that week (sum of distinct ibOrderIDs across
 *     every trade in the week — same definition as the daily table's
 *     "Total execs", aggregated to the week).
 * Label above each bar = the week's realised P/L, coloured green for
 *     profit, red for loss, grey for scratch.
 *
 * Replaces the prior daily-P/L-vs-execution scatter. Shows whether the
 * weekly volume of executions (and the cash they generate) trends up,
 * down, or stays flat across the window.
 *
 * Empty weeks render as a tiny baseline tick (no bar, no label) so the
 * user can still see the week slot exists. Hover a bar to see the week
 * range, exec count, trade count and P/L.
 *
 * No external charting library — matches the rest of the analytics
 * folder. Easy to swap for recharts later if richer interactions are
 * needed.
 */

import * as React from "react";
import { useRef } from "react";
import type { WeeklyExecsResponse } from "@/lib/types";
import { useContainerWidth } from "@/lib/useContainerWidth";

const COLOR_BAR = "#2563eb";
const COLOR_BAR_HOVER = "#1d4ed8";
const COLOR_EMPTY = "#e2e8f0";
const COLOR_PROFIT = "#16a34a";
const COLOR_LOSS = "#dc2626";
const COLOR_SCRATCH = "#64748b";

interface Props {
  data: WeeklyExecsResponse;
  /** Fallback width (px) used until the container is measured. The
   *  rendered chart width is always the container width, so this
   *  prop just affects the first paint. */
  width?: number;
  /** Plot height in px. */
  height?: number;
}

// Padding leaves room for Y-axis labels on the left, rotated week
// labels under the X-axis, and a P/L number above the tallest bar.
const PAD = { top: 28, right: 16, bottom: 64, left: 56 } as const;

// Vertical gap between the top of a bar and its P/L label.
const PNL_LABEL_GAP = 4;

function parsePnl(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoneyCompact(n: number): string {
  // Compact $K so per-bar labels stay short. Sub-$1k shows as a
  // whole-dollar figure.
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  const abs = Math.abs(n);
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

function fmtWeekLabel(isoDate: string): string {
  // `YYYY-MM-DD` Monday → "DD MMM" (short, en-GB). Anchored at noon so
  // the formatter doesn't drift across DST or the dateline.
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

function fmtWeekRange(isoMonday: string): string {
  // Monday "YYYY-MM-DD" → "DD MMM YYYY → DD MMM YYYY" (Mon..Sun).
  const mon = new Date(`${isoMonday}T12:00:00`);
  const sun = new Date(mon.getTime());
  sun.setDate(sun.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  return `${fmt(mon)} → ${fmt(sun)}`;
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

export default function WeeklyExecsBarChart({
  data,
  width: fallbackWidth = 960,
  height = 360,
}: Props) {
  // Track the actual container width so the chart grows/shrinks with
  // the page. Prevents the "zoomed out" look when many weeks are
  // displayed inside a wider card than the old 960 default.
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef, fallbackWidth);

  const weeks = data.weeks;

  if (weeks.length === 0) {
    return (
      <div
        ref={containerRef}
        style={{ width: "100%", color: "#94a3b8", fontSize: 12 }}
      >
        No weeks in window.
      </div>
    );
  }

  // ─── Domain ────────────────────────────────────────────────────────
  let yMax = 0;
  for (const w of weeks) {
    if (w.exec_count > yMax) yMax = w.exec_count;
  }
  // Pad the top so the tallest bar isn't glued to the chart frame. If
  // every week is zero, fall back to a 10-exec ceiling so the empty
  // baseline still renders sensibly.
  if (yMax === 0) yMax = 10;
  const yStep = niceStep(Math.max(yMax / 5, 1));
  const yMaxNice = Math.ceil(yMax / yStep) * yStep;

  // ─── Layout math ───────────────────────────────────────────────────
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  const slotW = plotW / weeks.length;
  // Bars take ~70 % of the slot width so adjacent bars have breathing
  // room. Cap to a sensible max so wide windows don't render chunky
  // bars in narrow charts.
  const barW = Math.max(Math.min(slotW * 0.7, 40), 2);

  function xForSlot(i: number): number {
    return PAD.left + i * slotW + slotW / 2;
  }
  function yFor(value: number): number {
    return PAD.top + ((yMaxNice - value) / yMaxNice) * plotH;
  }

  // ─── Tick lists ────────────────────────────────────────────────────
  const yTicks: number[] = [];
  for (let v = 0; v <= yMaxNice + 1e-9; v += yStep) {
    yTicks.push(Math.round(v));
  }

  // Show every N-th week label so the X axis doesn't pile up. Aim for
  // roughly 8–10 labels max.
  const labelEvery = Math.max(1, Math.ceil(weeks.length / 10));

  // ─── Summary numbers ───────────────────────────────────────────────
  const totalExecs = weeks.reduce((a, w) => a + w.exec_count, 0);
  const totalTrades = weeks.reduce((a, w) => a + w.trade_count, 0);
  const nonEmpty = weeks.filter((w) => w.exec_count > 0).length;
  const avgExecsPerWeek = weeks.length > 0 ? totalExecs / weeks.length : 0;
  const totalPnl = weeks.reduce((a, w) => a + parsePnl(w.total_pnl), 0);

  return (
    <div ref={containerRef} style={{ width: "100%" }}>
      {/* Compact text summary above the chart — mirrors the other
          analytics charts and keeps the user oriented. */}
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
          Weeks:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>
            {weeks.length}
          </span>{" "}
          <span style={{ color: "#64748b" }}>({nonEmpty} active)</span>
        </span>
        <span>
          Total execs:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>
            {totalExecs}
          </span>
        </span>
        <span>
          Total trades:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>
            {totalTrades}
          </span>
        </span>
        <span>
          Avg execs / week:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>
            {avgExecsPerWeek.toFixed(1)}
          </span>
        </span>
        <span>
          Total P/L:{" "}
          <span
            style={{
              color:
                totalPnl > 0
                  ? COLOR_PROFIT
                  : totalPnl < 0
                    ? COLOR_LOSS
                    : COLOR_SCRATCH,
              fontWeight: 700,
            }}
          >
            {fmtMoneyFull(totalPnl)}
          </span>
        </span>
      </div>

      <svg
        width={width}
        height={height}
        style={{ display: "block", overflow: "visible" }}
        role="img"
        aria-label="Weekly execution count"
      >
        {/* Horizontal gridlines + Y-axis labels. */}
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
              {t}
            </text>
          </g>
        ))}

        {/* Bars. Empty weeks render as a thin baseline tick so the
            slot is still visible. Each non-empty bar gets the week's
            P/L drawn above it, coloured by sign. */}
        {weeks.map((w, i) => {
          const cx = xForSlot(i);
          const x = cx - barW / 2;
          const pnl = parsePnl(w.total_pnl);
          if (w.exec_count <= 0) {
            return (
              <g key={`b-${w.week_start}`}>
                <line
                  x1={x}
                  x2={x + barW}
                  y1={yFor(0)}
                  y2={yFor(0)}
                  stroke={COLOR_EMPTY}
                  strokeWidth={2}
                >
                  <title>
                    {`${fmtWeekRange(w.week_start)}\nNo executions`}
                  </title>
                </line>
              </g>
            );
          }
          const top = yFor(w.exec_count);
          const h = yFor(0) - top;
          const pnlColor =
            pnl > 0 ? COLOR_PROFIT : pnl < 0 ? COLOR_LOSS : COLOR_SCRATCH;
          // Drop the P/L label below the top of the chart if the bar
          // is so tall that the label would clip the top edge.
          const pnlY = Math.max(top - PNL_LABEL_GAP, PAD.top - 4);
          return (
            <g key={`b-${w.week_start}`}>
              <rect
                x={x}
                y={top}
                width={barW}
                height={h}
                fill={COLOR_BAR}
                fillOpacity={0.85}
                style={{ transition: "fill 120ms" }}
                onMouseEnter={(e) => {
                  (e.target as SVGRectElement).setAttribute(
                    "fill",
                    COLOR_BAR_HOVER,
                  );
                }}
                onMouseLeave={(e) => {
                  (e.target as SVGRectElement).setAttribute(
                    "fill",
                    COLOR_BAR,
                  );
                }}
              >
                <title>
                  {`${fmtWeekRange(w.week_start)}\nExecs: ${w.exec_count}\nTrades: ${w.trade_count}\nP/L: ${fmtMoneyFull(pnl)}`}
                </title>
              </rect>
              <text
                x={cx}
                y={pnlY}
                fontSize={10}
                fill={pnlColor}
                fontWeight={700}
                textAnchor="middle"
                style={{ pointerEvents: "none" }}
              >
                {fmtMoneyCompact(pnl)}
              </text>
            </g>
          );
        })}

        {/* X-axis week labels — every N-th to avoid pile-up. Rotated
            slightly so longer labels stay legible. */}
        {weeks.map((w, i) => {
          if (i % labelEvery !== 0 && i !== weeks.length - 1) return null;
          const cx = xForSlot(i);
          return (
            <text
              key={`xl-${w.week_start}`}
              x={cx}
              y={PAD.top + plotH + 16}
              fontSize={10}
              fill="#64748b"
              textAnchor="end"
              transform={`rotate(-35 ${cx} ${PAD.top + plotH + 16})`}
            >
              {fmtWeekLabel(w.week_start)}
            </text>
          );
        })}

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
          Executions / week
        </text>

        {/* X-axis title under the tick row. */}
        <text
          x={PAD.left + plotW / 2}
          y={height - 4}
          fontSize={11}
          fill="#475569"
          textAnchor="middle"
          fontWeight={600}
        >
          Week (Mon, Europe/Helsinki)
        </text>

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
