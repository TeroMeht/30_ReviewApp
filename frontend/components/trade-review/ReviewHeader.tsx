"use client";

import { useEffect, useState } from "react";
import type { NeighborTrades, Trade } from "@/lib/types";

const HELSINKI_TZ = "Europe/Helsinki";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("fi-FI", {
    timeZone: HELSINKI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

interface Props {
  trade: Trade;
  neighbors: NeighborTrades | null;
  /** Called when user picks a different trade (prev/next/jump). */
  onSelectTrade: (tradeid: number) => void;
}

export default function ReviewHeader({ trade, neighbors, onSelectTrade }: Props) {
  const [jumpValue, setJumpValue] = useState<string>(String(trade.tradeid));
  useEffect(() => setJumpValue(String(trade.tradeid)), [trade.tradeid]);

  const onJump = () => {
    const n = parseInt(jumpValue, 10);
    if (!Number.isFinite(n)) return;
    onSelectTrade(n);
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.05em", textTransform: "uppercase" }}>
          Trade #{trade.tradeid}
        </span>
        <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
          {trade.symbol}
        </span>
      </div>
      <div style={{ fontSize: 13, color: "#475569" }}>{fmtDate(trade.date)}</div>

      <div style={{ flex: 1 }} />

      <button
        onClick={() => neighbors?.prev_id != null && onSelectTrade(neighbors.prev_id)}
        disabled={!neighbors?.prev_id}
        style={btn}
      >
        ← Prev
      </button>
      <button
        onClick={() => neighbors?.next_id != null && onSelectTrade(neighbors.next_id)}
        disabled={!neighbors?.next_id}
        style={btn}
      >
        Next →
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "#64748b" }}>Jump to #</span>
        <input
          type="number"
          value={jumpValue}
          onChange={(e) => setJumpValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onJump();
          }}
          style={{
            width: 80,
            padding: "5px 8px",
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            fontSize: 12,
          }}
        />
        <button onClick={onJump} style={btn}>
          Go
        </button>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 12px",
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
