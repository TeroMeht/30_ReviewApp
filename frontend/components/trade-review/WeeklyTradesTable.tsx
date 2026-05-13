"use client";

/**
 * Lists every trade that falls in the same Mon–Sun (Helsinki) week as
 * the currently displayed trade. Clicking a row navigates the review
 * page to that trade. The current trade is highlighted.
 *
 * Collapsed by default — the user clicks the header bar to expand it.
 * Fetching is deferred until the first expansion so we don't burn an
 * API call for users who never open the section. The collapsed/expanded
 * state is reset whenever the user navigates to a different trade so
 * the panel doesn't stay open across navigations.
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
  /** Reviewed trade — used to pick the week and highlight the row. */
  currentTradeId: number;
  /** Re-fetches whenever the user navigates to another trade. */
  weekKey: number;
  onSelectTrade: (tradeid: number) => void;
}

export default function WeeklyTradesTable({
  currentTradeId,
  weekKey,
  onSelectTrade,
}: Props) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset to collapsed + clear cached rows whenever the reviewed trade
  // changes — keeps the deferred-fetch behaviour consistent across
  // navigations and avoids briefly showing the previous week's data.
  useEffect(() => {
    setExpanded(false);
    setTrades(null);
    setError(null);
  }, [currentTradeId, weekKey]);

  // Lazy fetch: only hit the API once the user opens the panel.
  useEffect(() => {
    if (!expanded || trades !== null || error !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_PREFIX}/trades/${currentTradeId}/week`
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
  }, [expanded, currentTradeId, weekKey, trades, error]);

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

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
      >
        <thead style={{ color: "#64748b" }}>
          <tr>
            <th style={th}>#</th>
            <th style={th}>Date</th>
            <th style={th}>Symbol</th>
            <th style={th}>Setup (planned)</th>
            <th style={th}>Intended (actual)</th>
            <th style={th}>Observed</th>
            <th style={th}>Category</th>
            <th style={{ ...th, textAlign: "center" }}>PA</th>
            <th style={{ ...th, textAlign: "center" }}>PP</th>
            <th style={th}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const isCurrent = t.tradeid === currentTradeId;
            // Highlight deviations (planned ≠ actual). Only flag when
            // both columns are filled in to avoid lighting up rows that
            // are simply unlabelled.
            const deviation =
              t.setup != null &&
              t.intended_setup != null &&
              t.setup !== t.intended_setup;
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
                <td
                  style={{
                    ...td,
                    ...(deviation
                      ? { color: "#b45309", fontWeight: 600 }
                      : null),
                  }}
                  title={
                    deviation
                      ? `Deviation: planned "${t.setup}" → executed "${t.intended_setup}"`
                      : undefined
                  }
                >
                  {deviation ? "⚠ " : ""}
                  {t.intended_setup ?? "—"}
                </td>
                <td
                  style={{
                    ...td,
                    color: "#475569",
                    maxWidth: 240,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={(t.observed_setup ?? []).join(", ")}
                >
                  {t.observed_setup && t.observed_setup.length > 0
                    ? t.observed_setup.join(", ")
                    : "—"}
                </td>
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

// Header looks like the existing panel headers but is interactive — it
// gets a chevron + hover affordance so the click target is obvious.
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
