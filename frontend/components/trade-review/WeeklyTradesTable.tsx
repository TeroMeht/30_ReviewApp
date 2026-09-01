"use client";

/**
 * Lists every trade that falls in the same Mon–Sun (Helsinki) week as
 * the currently displayed trade. Collapsed by default; click header to expand.
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

function helsinkiYMD(iso: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HELSINKI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: +get("year"), m: +get("month"), d: +get("day") };
}

function fmtWeekRange(iso: string, weekOffset: number): string {
  const { y, m, d } = helsinkiYMD(iso);
  const ref = new Date(Date.UTC(y, m - 1, d));
  const dow = ref.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  const monday = new Date(ref);
  monday.setUTCDate(monday.getUTCDate() - daysFromMonday + weekOffset * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const fmt = (date: Date, withYear: boolean) =>
    new Intl.DateTimeFormat("fi-FI", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
    }).format(date);
  return `${fmt(monday, false)} – ${fmt(sunday, true)}`;
}

interface Props {
  currentTradeId: number;
  currentTradeDate: string;
  weekKey: number;
  onSelectTrade: (tradeid: number) => void;
}

export default function WeeklyTradesTable({
  currentTradeId,
  currentTradeDate,
  weekKey,
  onSelectTrade,
}: Props) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState<number>(0);

  useEffect(() => {
    setExpanded(false);
    setTrades(null);
    setError(null);
    setWeekOffset(0);
  }, [currentTradeId, weekKey]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setTrades(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `${API_PREFIX}/trades/${currentTradeId}/week?offset=${weekOffset}`
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
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, currentTradeId, weekKey, weekOffset]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={headerBtn}
      >
        <span
          style={{
            display: "inline-block",
            width: 12,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms ease",
            color: "#64748b",
          }}
        >
          ▶
        </span>
        <span>This week’s trades</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>
          {expanded ? "click to collapse" : "click to expand"}
        </span>
      </button>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          <WeekNav
            weekOffset={weekOffset}
            onPrev={() => setWeekOffset((v) => v - 1)}
            onNext={() => setWeekOffset((v) => v + 1)}
            onReset={() => setWeekOffset(0)}
            label={fmtWeekRange(currentTradeDate, weekOffset)}
          />
          <WeekBody
            currentTradeId={currentTradeId}
            trades={trades}
            error={error}
            onSelectTrade={onSelectTrade}
          />
        </div>
      )}
    </div>
  );
}

function WeekNav({
  weekOffset,
  onPrev,
  onNext,
  onReset,
  label,
}: {
  weekOffset: number;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  label: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
      }}
    >
      <button type="button" onClick={onPrev} style={navBtn}>
        ← Prev week
      </button>
      <button type="button" onClick={onNext} style={navBtn}>
        Next week →
      </button>
      <span
        style={{
          fontSize: 12,
          color: "#475569",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {label}
        {weekOffset !== 0 && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 11,
              color: "#94a3b8",
              fontWeight: 400,
            }}
          >
            ({weekOffset > 0 ? `+${weekOffset}` : weekOffset}w)
          </span>
        )}
      </span>
      {weekOffset !== 0 && (
        <button
          type="button"
          onClick={onReset}
          style={{ ...navBtn, background: "#fff", color: "#0f172a", border: "1px solid #e2e8f0" }}
          title="Jump back to the reviewed trade's own week"
        >
          This week
        </button>
      )}
    </div>
  );
}

function WeekBody({
  currentTradeId,
  trades,
  error,
  onSelectTrade,
}: {
  currentTradeId: number;
  trades: Trade[] | null;
  error: string | null;
  onSelectTrade: (tradeid: number) => void;
}) {
  if (error) {
    return (
      <div style={{ fontSize: 12, color: "#b91c1c" }}>
        Failed to load weekly trades: {error}
      </div>
    );
  }
  if (trades === null) {
    return (
      <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading week…</div>
    );
  }
  if (trades.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "#94a3b8" }}>
        No trades in this week.
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
            Week P/L:{" "}
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
        <table
          style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
        >
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
                  Week total ({totalTrades} trade{totalTrades === 1 ? "" : "s"}
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

const navBtn: React.CSSProperties = {
  padding: "5px 10px",
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const headerBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "2px 0 8px",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid #e2e8f0",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
  fontWeight: 700,
  color: "#0f172a",
  fontFamily: "inherit",
};
