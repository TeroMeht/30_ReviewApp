"use client";

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
          </tr>
        </thead>
        <tbody>
          {executions.map((e) => {
            const isBuy = e.buySell.toUpperCase() === "BUY";
            return (
              <tr key={e.tradeID} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={td}>{fmtTime(e.dateTime)}</td>
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
                    {e.buySell}
                  </span>
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {e.quantity.toLocaleString()}
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  ${Number(e.tradePrice).toFixed(3)}
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#64748b" }}>
                  ${Number(e.ibCommission).toFixed(2)}
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
