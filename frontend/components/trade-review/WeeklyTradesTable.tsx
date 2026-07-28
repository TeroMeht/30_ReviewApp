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
 *
 * Once expanded the user can browse adjacent weeks with prev/next
 * controls (mirroring the trade-level prev/next on the page header).
 * The reviewed trade — and therefore the chart, executions, etc — does
 * not change; only the table refetches with a `?offset=±N` query. The
 * offset resets to 0 whenever the user navigates to a different trade
 * so the table re-anchors on the new trade's own week.
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

/** Parse the Decimal-string P/L the backend serialises. Returns null for
 *  trades with no executions. */
function parsePnl(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  // Pin the locale so SSR and the browser produce the same string —
  // `undefined` uses the runtime default and breaks hydration.
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

/** Pull Y/M/D as observed in Helsinki for an ISO timestamp. Used to
 *  walk the calendar in Helsinki time without depending on the runner's
 *  local timezone. */
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

/** Helsinki Mon–Sun range that contains `iso`, shifted by `weekOffset`
 *  whole weeks. Returns a string like "10. toukok. – 16. toukok. 2026"
 *  (locale-formatted) for the panel header. */
function fmtWeekRange(iso: string, weekOffset: number): string {
  const { y, m, d } = helsinkiYMD(iso);
  // Build a UTC anchor for the local Helsinki date so we can do day-of-week
  // arithmetic without TZ surprises. Format both ends as UTC so the
  // displayed dates exactly match the anchor we computed.
  const ref = new Date(Date.UTC(y, m - 1, d));
  const dow = ref.getUTCDay(); // 0=Sun … 6=Sat
  const daysFromMonday = (dow + 6) % 7; // Mon=0 … Sun=6
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
  /** Reviewed trade — used to pick the week and highlight the row. */
  currentTradeId: number;
  /** Reviewed trade's date — anchors the week the offset is relative to. */
  currentTradeDate: string;
  /** Re-fetches whenever the user navigates to another trade. */
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
  // Whole-week shift relative to the reviewed trade's week. 0 = own week.
  const [weekOffset, setWeekOffset] = useState<number>(0);

  // Reset to collapsed + clear cached rows + re-anchor on the new trade's
  // week whenever the reviewed trade changes — keeps the deferred-fetch
  // behaviour consistent across navigations and avoids briefly showing
  // stale data from a previous week or trade.
  useEffect(() => {
    setExpanded(false);
    setTrades(null);
    setError(null);
    setWeekOffset(0);
  }, [currentTradeId, weekKey]);

  // Fetch lifecycle: lazy on first expand, then refetch whenever the
  // user steps to an adjacent week. We re-fire on any change in
  // (expanded, currentTradeId, weekKey, weekOffset) and clear the
  // previous rows so the loading state shows correctly while the new
  // week is in flight.
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

/** Prev/next-week toolbar shown above the table when expanded. Mirrors
 *  the trade-level prev/next styling in ReviewHeader so the affordance
 *  reads the same. The "This week" reset is hidden when offset is 0
 *  since it would be a no-op. */
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

  // Week-level aggregates, mirroring DailyTradesTable. `tradesWithPnl`
  // is the count of trades that actually have fills — used in the footer
  // so the user knows the sum excludes manual-only rows. `totalExecs`
  // sums the per-trade Execs column (each trade's count of distinct
  // ibOrderIDs) so the header surfaces the week's overall order count
  // alongside P/L.
  const totalTrades = trades.length;
  const pnls = trades
    .map((t) => parsePnl(t.realized_pnl))
    .filter((n): n is number => n !== null);
  const tradesWithPnl = pnls.length;
  const totalPnl = pnls.reduce((acc, n) => acc + n, 0);
  // Sum of per-trade MFE potential PnL. Only trades that have a saved
  // MFE config produce a non-null value; the rest are skipped so a
  // partial coverage doesn't zero out the aggregate.
  const potentials = trades
    .map((t) => parsePnl(t.potential_pnl))
    .filter((n): n is number => n !== null);
  const tradesWithPotential = potentials.length;
  const totalPotential = potentials.reduce((acc, n) => acc + n, 0);
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
        {tradesWithPotential > 0 && (
          <span
            title={
              tradesWithPotential !== totalTrades
                ? `${tradesWithPotential} of ${totalTrades} trade${totalTrades === 1 ? "" : "s"} have an MFE config`
                : undefined
            }
          >
            Week potential:{" "}
            <span style={{ color: pnlColor(totalPotential), fontWeight: 700 }}>
              {fmtPnl(totalPotential)}
            </span>
            {tradesWithPotential !== totalTrades && (
              <span style={{ color: "#94a3b8", fontWeight: 400 }}>
                {" "}
                ({tradesWithPotential}/{totalTrades})
              </span>
            )}
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
              <th style={th}>Setup (planned)</th>
              <th style={th}>Intended (actual)</th>
              <th style={th}>Observed</th>
              <th style={th}>Category</th>
              <th style={{ ...th, textAlign: "center" }}>PA</th>
              <th style={{ ...th, textAlign: "center" }}>PP</th>
              <th style={{ ...th, textAlign: "center" }}>Execs</th>
              <th style={{ ...th, textAlign: "right" }}>P/L</th>
              <th
                style={{ ...th, textAlign: "right" }}
                title="MFE-based potential PnL. Requires a saved MFE config on the trade."
              >
                Potential
              </th>
              <th style={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const isCurrent = t.tradeid === currentTradeId;
              const pnl = parsePnl(t.realized_pnl);
              const potential = parsePnl(t.potential_pnl);
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
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: pnlColor(potential),
                      fontWeight: potential !== null ? 600 : 400,
                    }}
                    title={
                      potential === null
                        ? "No MFE config saved for this trade"
                        : undefined
                    }
                  >
                    {potential === null ? "—" : fmtPnl(potential)}
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
                  colSpan={9}
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
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: tradesWithPotential > 0 ? pnlColor(totalPotential) : "#94a3b8",
                    fontWeight: 700,
                  }}
                  title={
                    tradesWithPotential === 0
                      ? "No trades in this week have an MFE config saved"
                      : tradesWithPotential !== totalTrades
                      ? `${tradesWithPotential} of ${totalTrades} trades have an MFE config`
                      : undefined
                  }
                >
                  {tradesWithPotential > 0 ? fmtPnl(totalPotential) : "—"}
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

// Prev/next-week buttons. Matches the trade-level prev/next styling
// in ReviewHeader so the affordance reads the same across the page.
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
