"use client";

/**
 * Lists every trade that falls on the same Helsinki calendar day as the
 * currently displayed trade. Ordered by each trade's earliest linked
 * execution timestamp (so the first ticker fired that day is at the
 * top). Clicking a row navigates the review page to that trade.
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

function parsePnl(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

function pnlColor(n: number | null): string {
  if (n === null) return "#94a3b8";
  if (n > 0) return "#16a34a";
  if (n < 0) return "#b91c1c";
  return "#64748b";
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

  const totalTrades = trades.length;
  const pnls = trades
    .map((t) => parsePnl(t.realized_pnl))
    .filter((n): n is number => n !== null);
  const tradesWithPnl = pnls.length;
  const totalPnl = pnls.reduce((acc, n) => acc + n, 0);
  const totalExecs = trades.reduce(
    (acc, t) => acc + (t.execution_count ?? 0),
    0
  );

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "#475569",
          marginBottom: 6,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span>
          Total trades:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>
            {totalTrades}
          </span>
        </span>
        {tradesWithPnl > 0 && (
          <span>
            Day P/L:{" "}
            <span style={{ color: pnlColor(totalPnl), fontWeight: 700 }}>
              {fmtPnl(totalPnl)}
            </span>
          </span>
        )}
        <span>
          Total execs:{" "}
          <span style={{ color: "#0f172a", fontWeight: 600 }}>
            {totalExecs}
          </span>
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead style={{ color: "#64748b" }}>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Date</th>
              <th style={th}>Symbol</th>
              <th style={th}>Setup</th>
              <th style={th}>Category</th>
              <th style={{ ...th, textAlign: "center" }}>Execs</th>
              <th style={{ ...th, textAlign: "right" }}>P/L</th>
              <th style={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const isCurrent = t.tradeid === currentTradeId;
              const pnl = parsePnl(t.realized_pnl);
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
                  <td
                    style={{
                      ...td,
                      textAlign: "center",
                      fontVariantNumeric: "tabular-nums",
                      color: (t.execution_count ?? 0) === 0 ? "#94a3b8" : "#0f172a",
                      whiteSpace: "nowrap",
                    }}
                    title={
                      (t.uncategorized_count ?? 0) > 0
                        ? `${t.uncategorized_count} of ${t.execution_count} orders still uncategorised`
                        : undefined
                    }
                  >
                    {t.execution_count ?? "—"}
                    {(t.uncategorized_count ?? 0) > 0 && (
                      <span
                        style={{
                          marginLeft: 4,
                          display: "inline-block",
                          padding: "0 4px",
                          fontSize: 10,
                          fontWeight: 700,
                          color: "#c2410c",
                          background: "rgba(249,115,22,0.15)",
                          border: "1px solid rgba(249,115,22,0.35)",
                          borderRadius: 6,
                          lineHeight: "14px",
                          verticalAlign: "middle",
                        }}
                        aria-label={`${t.uncategorized_count} orders uncategorised`}
                      >
                        !{t.uncategorized_count}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      ...td,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: pnlColor(pnl),
                      fontWeight: pnl !== null ? 600 : 400,
                    }}
                  >
                    {pnl === null ? "—" : fmtPnl(pnl)}
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
          {tradesWithPnl > 0 && (
            <tfoot>
              <tr
                style={{
                  borderTop: "2px solid #cbd5e1",
                  background: "#f8fafc",
                }}
              >
                <td
                  style={{ ...td, fontWeight: 700, color: "#475569" }}
                  colSpan={5}
                >
                  Day total ({totalTrades} trade{totalTrades === 1 ? "" : "s"}
                  {tradesWithPnl !== totalTrades
                    ? `, ${tradesWithPnl} with fills`
                    : ""}
                  )
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "center",
                    fontVariantNumeric: "tabular-nums",
                    color: "#0f172a",
                    fontWeight: 700,
                  }}
                >
                  {totalExecs}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: pnlColor(totalPnl),
                    fontWeight: 700,
                  }}
                >
                  {fmtPnl(totalPnl)}
                </td>
                <td style={td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
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
