"use client";

/**
 * Renders IB executions grouped by ibOrderID — one row per order, not per
 * fill. A single IB order frequently produces multiple partial fill rows
 * in the underlying data; the user thinks in terms of orders (one click
 * in TWS = one ibOrderID), so we collapse the fills into a single
 * aggregated row.
 *
 * Per-order aggregates:
 *   - Time   — earliest fill timestamp in the group
 *   - Side   — taken from the first fill (an IB order is BUY xor SELL)
 *   - Qty    — sum of fill quantities
 *   - Price  — quantity-weighted average across fills; tooltip shows
 *              the min/max fill range and fill count for transparency
 *   - Comm   — sum of IB commissions across fills
 *   - Cat    — user-assigned trade-review category (see below).
 *
 * Categories (per-order, stored in `order_categories`):
 *   1 — Followed plan, made money
 *   2 — Followed plan, stopped out at predefined stop
 *   3 — Off-plan (FOMO / revenge), lost money
 *   4 — Off-plan, made money in the end
 *   — — Uncategorised (default; no row in DB).
 *
 * Groups are sorted by earliest fill time ascending so the read matches
 * the natural chronological flow of the trade.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { API_PREFIX } from "@/lib/api_prefix";
import type {
  IbExecution,
  OrderCategory,
  OrderCategoryValue,
} from "@/lib/types";

const HELSINKI_TZ = "Europe/Helsinki";

/** Human-readable label for each category, shown as the <select> option
 *  text and used to build the row tooltip. Keep in sync with backend
 *  taxonomy in db/order_categories.py. */
const CATEGORY_LABELS: Record<OrderCategoryValue, string> = {
  1: "1 — Followed plan, made money",
  2: "2 — Followed plan, stopped at plan stop",
  3: "3 — Off-plan (FOMO/revenge), lost money",
  4: "4 — Off-plan, made money",
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("fi-FI", {
    timeZone: HELSINKI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface OrderGroup {
  ibOrderID: string;
  /** Earliest fill timestamp (ISO) — used for sort + display. */
  earliestTime: string;
  /** Taken from the first fill in time order. An IB order is normally
   *  homogeneous (all BUY or all SELL) so this represents the group. */
  buySell: string;
  totalQty: number;
  /** Quantity-weighted average fill price. */
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  totalCommission: number;
  fillCount: number;
}

/** Collapse the raw fill list into one row per ibOrderID, computing the
 *  per-order aggregates the table renders. Fills with a falsy ibOrderID
 *  (shouldn't happen for real IB data, but defensive) are bucketed
 *  under each fill's own tradeID so they still show up. */
function groupByOrder(executions: IbExecution[]): OrderGroup[] {
  const buckets = new Map<string, IbExecution[]>();
  for (const e of executions) {
    const key = e.ibOrderID || `__no_order_${e.tradeID}`;
    const arr = buckets.get(key);
    if (arr) arr.push(e);
    else buckets.set(key, [e]);
  }

  const groups: OrderGroup[] = [];
  for (const [ibOrderID, fills] of buckets) {
    // Sort fills within the group by time so the "first fill" we pick
    // for buySell is the actual first one, and earliestTime is correct.
    const sorted = [...fills].sort((a, b) =>
      a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0
    );
    let totalQty = 0;
    let qtyTimesPrice = 0;
    let totalCommission = 0;
    let minPrice = Number.POSITIVE_INFINITY;
    let maxPrice = Number.NEGATIVE_INFINITY;
    for (const f of sorted) {
      const qty = Number(f.quantity);
      const price = Number(f.tradePrice);
      const comm = Number(f.ibCommission);
      totalQty += qty;
      qtyTimesPrice += qty * price;
      totalCommission += Number.isFinite(comm) ? comm : 0;
      if (price < minPrice) minPrice = price;
      if (price > maxPrice) maxPrice = price;
    }
    // Quantity-weighted average. Guard against pathological zero-qty
    // groups (should never happen for real fills) by falling back to a
    // simple mean of fill prices.
    const avgPrice =
      totalQty !== 0
        ? qtyTimesPrice / totalQty
        : sorted.reduce((a, f) => a + Number(f.tradePrice), 0) / sorted.length;
    groups.push({
      ibOrderID,
      earliestTime: sorted[0].dateTime,
      buySell: sorted[0].buySell,
      totalQty,
      avgPrice,
      minPrice,
      maxPrice,
      totalCommission,
      fillCount: sorted.length,
    });
  }

  groups.sort((a, b) =>
    a.earliestTime < b.earliestTime
      ? -1
      : a.earliestTime > b.earliestTime
      ? 1
      : 0
  );
  return groups;
}

interface Props {
  executions: IbExecution[];
  /** The trade these executions belong to. Required for category
   *  persistence — the backend needs a trade_fk anchor when creating a
   *  category row for the first time. */
  tradeid: number;
}

export default function ExecutionsTable({ executions, tradeid }: Props) {
  // iborderid → category. Uncategorised orders are absent from the map.
  const [categories, setCategories] = useState<Map<string, OrderCategoryValue>>(
    () => new Map()
  );
  // iborderids currently in-flight (disable the select while saving so a
  // fast toggle can't race two writes).
  const [saving, setSaving] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch existing categories whenever the trade changes.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    async function load() {
      try {
        const res = await fetch(
          `${API_PREFIX}/trades/${tradeid}/order-categories`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows: OrderCategory[] = await res.json();
        if (cancelled) return;
        const m = new Map<string, OrderCategoryValue>();
        for (const r of rows) m.set(r.iborderid, r.category);
        setCategories(m);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tradeid]);

  const handleChange = useCallback(
    async (ibOrderID: string, nextRaw: string) => {
      // Empty string from the placeholder option → clear the category.
      const isClear = nextRaw === "";
      const next = isClear ? null : (Number(nextRaw) as OrderCategoryValue);

      // Optimistic update — the table stays snappy even on a slow LAN.
      const prev = categories.get(ibOrderID) ?? null;
      const optimistic = new Map(categories);
      if (next === null) optimistic.delete(ibOrderID);
      else optimistic.set(ibOrderID, next);
      setCategories(optimistic);

      // Mark as saving so we can dim the control until the roundtrip returns.
      setSaving((s) => {
        const nx = new Set(s);
        nx.add(ibOrderID);
        return nx;
      });

      try {
        if (next === null) {
          const res = await fetch(
            `${API_PREFIX}/order-categories/${encodeURIComponent(ibOrderID)}`,
            { method: "DELETE" }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else {
          const res = await fetch(
            `${API_PREFIX}/order-categories/${encodeURIComponent(ibOrderID)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trade_fk: tradeid, category: next }),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
      } catch (e) {
        // Roll back on failure.
        setCategories((cur) => {
          const nx = new Map(cur);
          if (prev === null) nx.delete(ibOrderID);
          else nx.set(ibOrderID, prev);
          return nx;
        });
        setLoadError(
          `Failed to save category: ${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setSaving((s) => {
          const nx = new Set(s);
          nx.delete(ibOrderID);
          return nx;
        });
      }
    },
    [categories, tradeid]
  );

  const groups = useMemo(() => groupByOrder(executions), [executions]);

  if (executions.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "#94a3b8", padding: 8 }}>
        No executions linked to this trade yet.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      {loadError && (
        <div
          style={{
            fontSize: 11,
            color: "#b91c1c",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 4,
            padding: "4px 6px",
            marginBottom: 6,
          }}
        >
          {loadError}
        </div>
      )}
      <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
        <thead style={{ color: "#64748b" }}>
          <tr>
            <th
              style={{ ...th, textAlign: "center" }}
              title={
                "Trade-review category:\n" +
                CATEGORY_LABELS[1] +
                "\n" +
                CATEGORY_LABELS[2] +
                "\n" +
                CATEGORY_LABELS[3] +
                "\n" +
                CATEGORY_LABELS[4]
              }
            >
              Cat
            </th>
            <th style={th}>Time</th>
            <th style={th}>Side</th>
            <th style={{ ...th, textAlign: "right" }}>Qty</th>
            <th style={{ ...th, textAlign: "right" }}>Price</th>
            <th style={{ ...th, textAlign: "right" }}>Comm</th>
            <th style={{ ...th, textAlign: "right" }}>Fills</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isBuy = g.buySell.toUpperCase() === "BUY";
            const priceRange =
              g.minPrice === g.maxPrice
                ? `Single price: $${g.minPrice.toFixed(4)}`
                : `Range: $${g.minPrice.toFixed(4)} – $${g.maxPrice.toFixed(4)}`;
            const priceTitle = `${priceRange} · ${g.fillCount} fill${
              g.fillCount === 1 ? "" : "s"
            } · Order ${g.ibOrderID}`;
            const cat = categories.get(g.ibOrderID);
            const isSaving = saving.has(g.ibOrderID);
            const catTitle = cat
              ? CATEGORY_LABELS[cat]
              : "Uncategorised — pick 1..4";
            return (
              <tr key={g.ibOrderID} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td
                  style={{ ...td, textAlign: "center", width: 1, whiteSpace: "nowrap" }}
                  title={catTitle}
                >
                  <select
                    value={cat ?? ""}
                    disabled={isSaving}
                    onChange={(e) => handleChange(g.ibOrderID, e.target.value)}
                    style={{
                      fontSize: 11,
                      // Narrow: just enough for a single-digit + native arrow.
                      // Options still render at their natural width when the
                      // popup opens, so the descriptive labels stay legible.
                      width: 34,
                      padding: "1px 2px",
                      borderRadius: 3,
                      border: "1px solid #e2e8f0",
                      background: cat ? categoryBg(cat) : "#fff",
                      color: cat ? categoryFg(cat) : "#94a3b8",
                      fontWeight: cat ? 700 : 400,
                      cursor: isSaving ? "wait" : "pointer",
                      appearance: "none",
                      textAlign: "center",
                      textAlignLast: "center",
                    }}
                    aria-label={`Category for order ${g.ibOrderID}`}
                  >
                    {/* Closed-state text = value only, so the box stays narrow.
                        `label` is what the popup renders — full description. */}
                    <option value="" label="—">
                      — Uncategorised
                    </option>
                    <option value="1" label="1">
                      {CATEGORY_LABELS[1]}
                    </option>
                    <option value="2" label="2">
                      {CATEGORY_LABELS[2]}
                    </option>
                    <option value="3" label="3">
                      {CATEGORY_LABELS[3]}
                    </option>
                    <option value="4" label="4">
                      {CATEGORY_LABELS[4]}
                    </option>
                  </select>
                </td>
                <td style={td}>{fmtTime(g.earliestTime)}</td>
                <td style={td}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 6px",
                      borderRadius: 3,
                      background: isBuy
                        ? "rgba(37,99,235,0.10)"
                        : "rgba(220,38,38,0.10)",
                      color: isBuy ? "#1d4ed8" : "#b91c1c",
                      fontWeight: 600,
                      fontSize: 10,
                    }}
                  >
                    {g.buySell}
                  </span>
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {g.totalQty.toLocaleString()}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  title={priceTitle}
                >
                  ${g.avgPrice.toFixed(3)}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: "#64748b",
                  }}
                >
                  ${g.totalCommission.toFixed(2)}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: g.fillCount > 1 ? "#0f172a" : "#94a3b8",
                  }}
                  title={priceTitle}
                >
                  {g.fillCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Discipline-based color coding: 1 & 2 are green (followed the plan),
 *  3 & 4 are red (off-plan, regardless of P/L outcome). */
function categoryBg(c: OrderCategoryValue): string {
  switch (c) {
    case 1:
    case 2:
      return "rgba(22,163,74,0.12)";
    case 3:
    case 4:
      return "rgba(220,38,38,0.15)";
  }
}

function categoryFg(c: OrderCategoryValue): string {
  switch (c) {
    case 1:
    case 2:
      return "#15803d";
    case 3:
    case 4:
      return "#b91c1c";
  }
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  fontWeight: 600,
  fontSize: 10,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  borderBottom: "1px solid #e2e8f0",
};
const td: React.CSSProperties = {
  padding: "6px 8px",
};
