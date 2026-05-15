"use client";

/**
 * Hand-rolled SVG grouped-bar chart for weekly P/L per setup.
 *
 * One cluster per week, one bar per setup inside the cluster. Bars
 * are green for positive P/L and red for negative — no per-setup
 * color encoding. Each bar's setup name is rendered as a horizontal
 * label adjacent to the bar (above positive bars, below negative
 * bars) so the chart is self-explanatory without a color legend.
 *
 * Width is intended to be driven by the parent (e.g. a ResizeObserver
 * measuring the panel) so the chart fills the available container
 * and the user never needs to horizontally scroll. With many setups
 * per cluster the labels may visually overlap — that's the cost of
 * keeping them horizontal and is by design.
 *
 * Zero-valued setups within a week are omitted (no zero-height bar)
 * so empty rows stay visually quiet. Slot positions inside a cluster
 * are reserved for every setup regardless, so a given setup always
 * sits in the same horizontal position across all weeks.
 *
 * No external charting library — keeps the dep footprint small and
 * makes the rendering predictable. Easy to swap for recharts later
 * if richer interactions are needed.
 */

import * as React from "react";
import type { WeeklyPnlResponse } from "@/lib/types";

// Bar fill colors — semantic, not categorical. Green for win, red
// for loss. Keeps the visual language consistent with how P/L is
// shown elsewhere in the app (daily table, window-total readout).
const COLOR_PROFIT = "#16a34a";
const COLOR_LOSS = "#dc2626";

interface Props {
  data: WeeklyPnlResponse;
  /** Total chart width in px. Bars and labels scale to fit. */
  width?: number;
  /** Plot height in px (including label gutters above/below). */
  height?: number;
}

// Plot padding. `top` / `bottom` are intentionally generous so the
// rotated setup labels above positive bars and below negative bars
// have room before they hit the SVG edge or the week label row.
const PAD = { top: 88, right: 16, bottom: 92, left: 56 } as const;

// Vertical gap between a bar's edge and the start of its label.
const LABEL_GAP = 4;

function parsePnl(v: string | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  // Compact $K for big numbers, two-decimal otherwise. Keeps axis
  // labels readable without truncating small per-bar values in
  // tooltips (the tooltip path uses fmtMoneyFull instead).
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
  // Render the Monday as "DD MMM" — short enough to fit under a
  // cluster without rotation in most windows.
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** Round `x` to the nearest "nice" axis tick step. Used to pick the
 *  y-axis range so labels are round numbers (250, 500, 1000…). */
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

export default function WeeklyPnlChart({
  data,
  width = 960,
  height = 480,
}: Props) {
  const { weeks, setups } = data;

  // ─── Domain (y-axis range) ─────────────────────────────────────────
  // Find the largest positive and largest-magnitude negative P/L
  // across every (week, setup) cell so bar heights are comparable.
  let yMax = 0;
  let yMin = 0;
  for (const w of weeks) {
    for (const s of setups) {
      const v = parsePnl(w.by_setup[s]);
      if (v > yMax) yMax = v;
      if (v < yMin) yMin = v;
    }
  }
  // Guarantee a visible y range even when everything is zero — a 100$
  // floor keeps the empty chart from collapsing into a single line.
  if (yMax === 0 && yMin === 0) {
    yMax = 100;
    yMin = -100;
  }
  // Pick a nice step that gives ~4-6 ticks across the range.
  const range = yMax - yMin;
  const step = niceStep(range / 5);
  const yMaxNice = Math.ceil(yMax / step) * step;
  const yMinNice = Math.floor(yMin / step) * step;

  // ─── Layout math ──────────────────────────────────────────────────
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const zeroY =
    PAD.top + (yMaxNice / (yMaxNice - yMinNice)) * plotH;

  const clusterW = plotW / Math.max(weeks.length, 1);
  // Reserve 20% horizontal padding between clusters; the remaining
  // 80% is split evenly among the setups in the cluster.
  const clusterInnerW = clusterW * 0.8;
  const barW =
    setups.length > 0 ? clusterInnerW / setups.length : clusterInnerW;
  const clusterPadL = (clusterW - clusterInnerW) / 2;

  function yFor(value: number): number {
    // Map a P/L value to a y-pixel within the plot area.
    return (
      PAD.top + ((yMaxNice - value) / (yMaxNice - yMinNice)) * plotH
    );
  }

  // ─── Y-axis ticks ─────────────────────────────────────────────────
  const ticks: number[] = [];
  for (let v = yMinNice; v <= yMaxNice + 1e-9; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }

  // ─── Per-setup totals (text summary, no color encoding) ──────────
  const totalsBySetup = new Map<string, number>();
  for (const s of setups) {
    let sum = 0;
    for (const w of weeks) sum += parsePnl(w.by_setup[s]);
    totalsBySetup.set(s, sum);
  }

  return (
    <div style={{ width }}>
      {/* Compact text summary in place of the old colored legend.
          Color is now reserved for win/loss semantics in the bars
          themselves; the per-setup totals just need numbers. */}
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
        {setups.length === 0 && (
          <span style={{ color: "#94a3b8" }}>
            No labelled trades in this window.
          </span>
        )}
        {setups.map((s) => {
          const total = totalsBySetup.get(s) ?? 0;
          return (
            <span
              key={s}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              title={`${s}: ${fmtMoneyFull(total)} over ${weeks.length} weeks`}
            >
              <span>{s}</span>
              <span
                style={{
                  color:
                    total > 0 ? COLOR_PROFIT : total < 0 ? COLOR_LOSS : "#64748b",
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 600,
                }}
              >
                {fmtMoneyFull(total)}
              </span>
            </span>
          );
        })}
      </div>

      <svg
        width={width}
        height={height}
        style={{ display: "block", overflow: "visible" }}
        role="img"
        aria-label="Weekly P/L per setup"
      >
        {/* Horizontal gridlines + y-axis labels. */}
        {ticks.map((t) => (
          <g key={`grid-${t}`}>
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

        {/* One <g> per week cluster, containing one rect+label per
            non-zero setup. The label is rotated -90° (reads bottom-
            to-top) and placed adjacent to the bar's outer edge so
            every bar is self-identifying. */}
        {weeks.map((wk, wi) => {
          const cx = PAD.left + wi * clusterW;
          return (
            <g key={wk.week_start}>
              {setups.map((s, si) => {
                const v = parsePnl(wk.by_setup[s]);
                if (v === 0) return null;
                const bx = cx + clusterPadL + si * barW;
                const top = v >= 0 ? yFor(v) : zeroY;
                const bot = v >= 0 ? zeroY : yFor(v);
                const h = Math.max(bot - top, 1); // 1px floor so tiny values stay visible
                const fill = v >= 0 ? COLOR_PROFIT : COLOR_LOSS;
                // Center the label horizontally on the bar; anchor
                // its baseline at the bar's outer edge so the text
                // grows away from the bar after rotation.
                const labelX = bx + barW / 2;
                // Positive bar: label sits above the bar top, text
                // grows upward from there → text-anchor "start" on a
                // -90° rotation (start = right edge before rotation,
                // which becomes the bottom after rotating).
                // Negative bar: label sits below the bar bottom and
                // grows downward → text-anchor "end".
                const labelY =
                  v >= 0 ? top - LABEL_GAP : bot + LABEL_GAP;
                const labelAnchor: "start" | "end" =
                  v >= 0 ? "start" : "end";
                return (
                  <g key={s}>
                    <rect
                      x={bx}
                      y={top}
                      width={Math.max(barW - 1, 1)}
                      height={h}
                      fill={fill}
                      rx={1}
                    >
                      <title>
                        {`${s}\n${fmtWeekLabel(wk.week_start)} (w/c ${wk.week_start})\n${fmtMoneyFull(v)}`}
                      </title>
                    </rect>
                    <text
                      x={labelX}
                      y={labelY}
                      fontSize={9}
                      fill="#334155"
                      textAnchor={labelAnchor}
                      dominantBaseline="middle"
                      transform={`rotate(-90 ${labelX} ${labelY})`}
                      style={{ pointerEvents: "none" }}
                    >
                      {s}
                    </text>
                  </g>
                );
              })}

              {/* Week label under the cluster. */}
              <text
                x={cx + clusterW / 2}
                y={height - PAD.bottom + 14}
                fontSize={10}
                fill="#64748b"
                textAnchor="middle"
              >
                {fmtWeekLabel(wk.week_start)}
              </text>
            </g>
          );
        })}

        {/* Left axis spine. */}
        <line
          x1={PAD.left}
          x2={PAD.left}
          y1={PAD.top}
          y2={PAD.top + plotH}
          stroke="#cbd5e1"
        />
      </svg>
    </div>
  );
}
