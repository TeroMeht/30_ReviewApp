"use client";

/**
 * Lists every trade that falls on the same Helsinki calendar day as the
 * currently displayed trade. Ordered by each trade's earliest linked
 * execution timestamp (so the first ticker fired that day is at the
 * top). Clicking a row navigates the review page to that trade.
 *
 * Mirrors WeeklyTradesTable in style; backed by GET /api/trades/{id}/day.
 */

import { useEffect, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type { Trade } from "@/lib/types";

const HELSINKI_TZ = "Europe/Helsinki";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("fi-FI", {
    timeZone: HELSINKI_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

interface Props {
  currentTradeId: number;
  dayKey: number;
  onSelectTrade: (tradeid: number) => void;
}

export default function DailyTradesTable({
  currentTradeId,
  dayKey,
  onSelectTrade,
}: Props) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrades(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `${API_PREFIX}/trades/${currentTradeId}/day`
        );
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            if (j?.detail) detail = String(j.detail);
          } catch {
            /* keep status */
          }
          throw new Error(detail);
        }
        const data: Trade[] = await res.json();
        if (!cancelled) setTrades(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [currentTradeId, dayKey]);

  if (error) {
    return (
      <div style={{ fontSize: 12, color: "#b91c1c" }}>
        Failed to load daily trades: {error}
      </div>
    );
  }
  if (trades === null) {
    return <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading day…</div>;
  }
  if (trades.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "#94a3b8" }}>
        No trades on this day.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead style={{ color: "#64748b" }}>
          <tr>
            <th style={th}>#</th>
            <th style={th}>Date</th>
            <th style={th}>Symbol</th>
            <th style={th}>Setup</th>
            <th style={th}>Category</th>
            <th style={{ ...th, textAlign: "center" }}>PA</th>
            <th style={{ ...th, textAlign: "center" }}>PP</th>
            <th style={{ ...th, textAlign: "center" }}>Execs</th>
            <th style={th}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const isCurrent = t.tradeid === currentTradeId;
            return (
              <tr
                key={t.tradeid}
                onClick={() => onSelectTrade(t.tradeid)}
                style={{
                  borderTop: "1px solid #f1f5f9",
                  cursor: "pointer",
                  background: isCurrent ? "rgba(37,99,235,0.08)" : undefined,
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                <td style={td}>{t.tradeid}</td>
                <td style={td}>{fmtDate(t.date)}</td>
                <td
                  style={{
                    ...td,
                    fontFamily: "ui-monospace, monospace",
                    fontWeight: 700,
                  }}
                >
                  {t.symbol}
                </td>
                <td style={td}>{t.setup ?? "—"}</td>
                <td style={td}>{t.category ?? "—"}</td>
                <td style={{ ...td, textAlign: "center" }}>
                  {t.price_action_rating ?? "—"}
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  {t.price_position ?? "—"}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "center",
                    fontVariantNumeric: "tabular-nums",
                    color: (t.execution_count ?? 0) === 0 ? "#94a3b8" : "#0f172a",
                  }}
                >
                  {t.execution_count ?? "—"}
                </td>
                <td
                  style={{
                    ...td,
                    color: "#475569",
                    maxWidth: 320,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={t.notes ?? ""}
                >
                  {t.notes ?? ""}
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
  verticalAlign: "top",
};
