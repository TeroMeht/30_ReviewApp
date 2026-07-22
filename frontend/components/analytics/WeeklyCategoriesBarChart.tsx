"use client";

/**
 * Hand-rolled SVG *grouped* bar chart — weekly execution count, split
 * into five side-by-side mini-bars per week: categories 1..4 plus an
 * uncategorised bucket.
 *
 * X = week (Monday-anchored, Europe/Helsinki). One cluster of mini-bars
 *     per week.
 * Y = number of distinct IB orders (iborderids) in that week. By
 *     construction the five mini-bars per week sum to the same value
 *     the "Weekly execution count" chart shows for the same week — so
 *     this chart is a discipline breakdown *of the total order volume*,
 *     not a subset.
 *
 * The mini-bars sit tightly next to each other (no gap between clusters
 * → still compact) so the reader can compare heights within a week
 * without eye-tracking across a wide slot. Colors match the pill colors
 * in the trade-review ExecutionsTable so switching between the two
 * views doesn't require a mental re-mapping.
 *
 * Empty weeks (no orders) render as a thin baseline tick so the slot
 * is still visible.
 *
 * Structurally follows WeeklyExecsBarChart.tsx — the two charts share
 * PAD, Y-tick logic, week label formatting and layout math so they
 * line up visually on the analytics page.
 */

import * as React from "react";
import { useRef } from "react";
import type { WeeklyOrderCategoriesResponse } from "@/lib/types";
import { useContainerWidth } from "@/lib/useContainerWidth";

// Per-category colors — mirror the trade-review pill palette.
const COLOR_CAT1 = "#16a34a"; // plan + win        — dark green
const COLOR_CAT2 = "#86efac"; // plan + stop       — light green
const COLOR_CAT3 = "#dc2626"; // off-plan + loss   — dark red
const COLOR_CAT4 = "#fca5a5"; // off-plan + win    — light red
const COLOR_UNCAT = "#94a3b8"; // uncategorised    — slate grey
const COLOR_EMPTY = "#e2e8f0";

const CATEGORY_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Followed plan, made money",
  2: "Followed plan, stopped at plan stop",
  3: "Off-plan (FOMO/revenge), lost money",
  4: "Off-plan, made money",
};

interface Props {
  data: WeeklyOrderCategoriesResponse;
  /** Fallback width (px) used until the container is measured. The
   *  rendered chart width is always the container width, so this
   *  prop just affects the first paint. */
  width?: number;
  /** Plot height in px. */
  height?: number;
}

// Same padding as WeeklyExecsBarChart so the two charts line up.
const PAD = { top: 28, right: 16, bottom: 64, left: 56 } as const;

// One "series" per bar inside a week cluster. Order left-to-right =
// 1, 2, 3, 4, uncategorised. Keeping green-then-red-then-grey means
// a well-executed week visually leans left; an off-plan week leans
// right. `key` is the field on the bucket; `tick` is the tiny label
// printed under the mini-bar (replaces the standalone legend).
type Series = {
  key: "cat1" | "cat2" | "cat3" | "cat4" | "uncategorized";
  tick: string;
  hoverLabel: string;
  color: string;
};
const SERIES: Series[] = [
  { key: "cat1", tick: "1", hoverLabel: `1 — ${CATEGORY_LABELS[1]}`, color: COLOR_CAT1 },
  { key: "cat2", tick: "2", hoverLabel: `2 — ${CATEGORY_LABELS[2]}`, color: COLOR_CAT2 },
  { key: "cat3", tick: "3", hoverLabel: `3 — ${CATEGORY_LABELS[3]}`, color: COLOR_CAT3 },
  { key: "cat4", tick: "4", hoverLabel: `4 — ${CATEGORY_LABELS[4]}`, color: COLOR_CAT4 },
  { key: "uncategorized", tick: "—", hoverLabel: "— Uncategorised", color: COLOR_UNCAT },
];

function fmtWeekLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function fmtWeekRange(isoMonday: string): string {
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

export default function WeeklyCategoriesBarChart({
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
  // Y scales to the tallest *single mini-bar* — not the week total —
  // because the bars are grouped, not stacked.
  let yMax = 0;
  for (const w of weeks) {
    for (const s of SERIES) {
      const v = w[s.key];
      if (v > yMax) yMax = v;
    }
  }
  if (yMax === 0) yMax = 5;
  const yStep = niceStep(Math.max(yMax / 5, 1));
  const yMaxNice = Math.ceil(yMax / yStep) * yStep;

  // ─── Layout math ───────────────────────────────────────────────────
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  const slotW = plotW / weeks.length;
  // Cluster occupies the same total width a single stacked bar used to,
  // so the chart stays as compact as before. Cap it in narrow charts.
  const clusterW = Math.max(Math.min(slotW * 0.7, 40), 5);
  // Five mini-bars flush against each other inside the cluster — no
  // inner gap so the cluster reads as one group and the height
  // comparison is easy. A thin visual separation is provided by the
  // bar colors themselves.
  const miniW = clusterW / SERIES.length;

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
  const labelEvery = Math.max(1, Math.ceil(weeks.length / 10));

  // ─── Summary numbers ───────────────────────────────────────────────
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  let sum4 = 0;
  let sumU = 0;
  for (const w of weeks) {
    sum1 += w.cat1;
    sum2 += w.cat2;
    sum3 += w.cat3;
    sum4 += w.cat4;
    sumU += w.uncategorized;
  }
  const total = sum1 + sum2 + sum3 + sum4 + sumU;
  const planned = sum1 + sum2;
  const offPlan = sum3 + sum4;
  const categorized = planned + offPlan;
  const plannedPct = categorized > 0 ? (planned / categorized) * 100 : 0;

  return (
    <div ref={containerRef} style={{ width: "100%" }}>
      {/* Compact text summary above the chart — mirrors the weekly-execs
          chart. Discipline % is over categorised orders (uncategorised
          are excluded from the ratio so you don't drift the number just
          by not labelling yet). */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 14px",
          marginBottom: 6,
          fontSize: 12,
          color: "#475569",
        }}
      >
        <span>
          Total orders:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>{total}</span>
        </span>
        <span>
          Followed plan (1+2):{" "}
          <span style={{ color: COLOR_CAT1, fontWeight: 700 }}>{planned}</span>{" "}
          {categorized > 0 && (
            <span style={{ color: "#64748b" }}>
              ({plannedPct.toFixed(0)}% of categorised)
            </span>
          )}
        </span>
        <span>
          Off-plan (3+4):{" "}
          <span style={{ color: COLOR_CAT3, fontWeight: 700 }}>{offPlan}</span>
        </span>
        {sumU > 0 && (
          <span>
            Uncategorised:{" "}
            <span style={{ color: COLOR_UNCAT, fontWeight: 700 }}>{sumU}</span>
          </span>
        )}
      </div>

      <svg
        width={width}
        height={height}
        style={{ display: "block", overflow: "visible" }}
        role="img"
        aria-label="Weekly executions by category"
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

        {/* Grouped bar clusters. Order inside a cluster: 1, 2, 3, 4,
            uncategorised — same left-to-right order as the legend. */}
        {weeks.map((w, i) => {
          const cx = xForSlot(i);
          const clusterX = cx - clusterW / 2;
          const total = w.cat1 + w.cat2 + w.cat3 + w.cat4 + w.uncategorized;
          if (total <= 0) {
            return (
              <line
                key={`b-${w.week_start}`}
                x1={clusterX}
                x2={clusterX + clusterW}
                y1={yFor(0)}
                y2={yFor(0)}
                stroke={COLOR_EMPTY}
                strokeWidth={2}
              >
                <title>
                  {`${fmtWeekRange(w.week_start)}\nNo orders`}
                </title>
              </line>
            );
          }
          const tooltipHeader =
            `${fmtWeekRange(w.week_start)}\n` +
            `Total: ${total}\n` +
            `Cat 1 (${CATEGORY_LABELS[1]}): ${w.cat1}\n` +
            `Cat 2 (${CATEGORY_LABELS[2]}): ${w.cat2}\n` +
            `Cat 3 (${CATEGORY_LABELS[3]}): ${w.cat3}\n` +
            `Cat 4 (${CATEGORY_LABELS[4]}): ${w.cat4}\n` +
            `Uncategorised: ${w.uncategorized}`;
          // Only print per-bar category ticks under the cluster when
          // the mini-bar is wide enough to keep the digits from
          // colliding — very dense windows get suppressed ticks and
          // fall back to the color legend in the tooltip.
          const showTicks = miniW >= 5;
          return (
            <g key={`b-${w.week_start}`}>
              {SERIES.map((s, si) => {
                const v = w[s.key];
                const x = clusterX + si * miniW;
                const miniCx = x + miniW / 2;
                return (
                  <g key={s.key}>
                    {v > 0 && (
                      <>
                        <rect
                          x={x}
                          y={yFor(v)}
                          width={miniW}
                          height={yFor(0) - yFor(v)}
                          fill={s.color}
                          fillOpacity={0.9}
                        >
                          <title>
                            {`${tooltipHeader}\n\n${s.hoverLabel}: ${v}`}
                          </title>
                        </rect>
                        {/* Per-bar count printed above the bar so the
                            reader gets the exact value without hover.
                            Clamped near the top of the plot area so a
                            tallest-bar label doesn't clip. */}
                        <text
                          x={miniCx}
                          y={Math.max(yFor(v) - 3, PAD.top - 4)}
                          fontSize={9}
                          fill="#0f172a"
                          fontWeight={700}
                          textAnchor="middle"
                          style={{ pointerEvents: "none" }}
                        >
                          {v}
                        </text>
                      </>
                    )}
                    {showTicks && (
                      <text
                        x={miniCx}
                        y={yFor(0) + 10}
                        fontSize={9}
                        fill="#0f172a"
                        fontWeight={600}
                        textAnchor="middle"
                        style={{ pointerEvents: "none" }}
                      >
                        {s.tick}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* X-axis week labels. Sit a bit lower than the exec-count
            chart's to leave a clean row of space for the per-mini-bar
            category ticks (1..4, —) drawn just under the baseline. */}
        {weeks.map((w, i) => {
          if (i % labelEvery !== 0 && i !== weeks.length - 1) return null;
          const cx = xForSlot(i);
          const y = PAD.top + plotH + 28;
          return (
            <text
              key={`xl-${w.week_start}`}
              x={cx}
              y={y}
              fontSize={10}
              fill="#64748b"
              textAnchor="end"
              transform={`rotate(-35 ${cx} ${y})`}
            >
              {fmtWeekLabel(w.week_start)}
            </text>
          );
        })}

        {/* Axis titles. */}
        <text
          x={-(PAD.top + plotH / 2)}
          y={14}
          fontSize={11}
          fill="#475569"
          textAnchor="middle"
          fontWeight={600}
          transform="rotate(-90)"
        >
          Orders / week (per category)
        </text>
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

