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
 *
 * Groups are sorted by earliest fill time ascending so the read matches
 * the natural chronological flow of the trade.
 */

import type { IbExecution } from "@/lib/types";

const HELSINKI_TZ = "Europe/Helsinki";

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
}

export default function ExecutionsTable({ executions }: Props) {
  if (executions.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "#94a3b8", padding: 8 }}>
        No executions linked to this trade yet.
      </div>
    );
  }
  const groups = groupByOrder(executions);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
        <thead style={{ color: "#64748b" }}>
          <tr>
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
            const priceTitle = `${priceRange} · ${g.fillCount} fill${g.fillCount === 1 ? "" : "s"} · Order ${g.ibOrderID}`;
            return (
              <tr key={g.ibOrderID} style={{ borderTop: "1px solid #f1f5f9" }}>
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
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {g.totalQty.toLocaleString()}
                </td>
                <td
                  style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  title={priceTitle}
                >
                  ${g.avgPrice.toFixed(3)}
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#64748b" }}>
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
