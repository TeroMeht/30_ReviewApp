"use client";

/**
 * One collapsible section per setup label on the Playbook page.
 *
 * Header (always visible): chevron · setup label · trade count · total
 * P/L. Click anywhere on the header to expand/collapse.
 *
 * Body (when expanded):
 *   1. PlaybookNotesEditor — structured strategy notes for the setup
 *   2. Chart grid — 3-column grid of PlaybookChartCard, lazy-loaded as
 *      the user scrolls
 *
 * Lazy fetch: the trade list is fetched on the first expand and reused
 * if the user collapses and re-expands. We intentionally re-fetch when
 * the page-level window changes (the parent forces a remount via key
 * so this is automatic).
 *
 * Persisted state: collapsed/expanded is stored per setup_label in
 * localStorage so the page restores whatever sections were last open.
 */

import { useEffect, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  PlaybookSetupSummary,
  PlaybookTradesResponse,
  PlaybookTradeSummary,
} from "@/lib/types";
import PlaybookChartCard from "./PlaybookChartCard";
import PlaybookNotesEditor from "./PlaybookNotesEditor";

const STORAGE_PREFIX = "playbook.section.expanded:";

interface Props {
  summary: PlaybookSetupSummary;
  /** Window query the parent is currently using (for the trades fetch).
   *  Pass null for "all time". */
  weeks: number | null;
}

export default function PlaybookSection({ summary, weeks }: Props) {
  // Initial state hydrates from localStorage. Uses a function initializer
  // so the read happens once, not every render. Falls back to false
  // (collapsed) when localStorage is unavailable or the key is missing —
  // this also ensures the SSR markup matches the first client render
  // (we read localStorage in useEffect on the client only).
  const [expanded, setExpanded] = useState<boolean>(false);
  const [trades, setTrades] = useState<PlaybookTradeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate persisted expand state on mount. Done in useEffect (not in
  // useState initializer) so SSR markup matches the first client paint
  // — we always SSR with expanded=false, then re-render on the client
  // once we've read localStorage. Avoids hydration mismatch.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_PREFIX + summary.setup_label);
      if (v === "1") setExpanded(true);
    } catch {
      /* localStorage unavailable — stay collapsed. */
    }
  }, [summary.setup_label]);

  // Persist whenever the user toggles.
  const toggle = () => {
    setExpanded((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(
          STORAGE_PREFIX + summary.setup_label,
          next ? "1" : "0",
        );
      } catch {
        /* localStorage unavailable — state is in-memory only. */
      }
      return next;
    });
  };

  // Lazy fetch: only hit the trades endpoint after first expand. Reused
  // across collapse/expand cycles within the same window. The parent
  // remounts the section via key={weeks} when the window changes, which
  // resets this state and re-fetches on next expand.
  useEffect(() => {
    if (!expanded || trades !== null || error !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const qs =
          weeks == null ? "" : `?weeks=${weeks}`;
        const res = await fetch(
          `${API_PREFIX}/playbook/setups/${encodeURIComponent(summary.setup_label)}/trades${qs}`,
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
        const data: PlaybookTradesResponse = await res.json();
        if (!cancelled) setTrades(data.trades);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, summary.setup_label, weeks, trades, error]);

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          width: "100%",
          padding: "12px 16px",
          background: "transparent",
          border: "none",
          borderBottom: expanded ? "1px solid #e2e8f0" : "none",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
        }}
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
        <span
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: "#0f172a",
            flex: "0 1 auto",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary.setup_label}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "#64748b",
            fontWeight: 400,
          }}
        >
          {summary.trade_count} trade{summary.trade_count === 1 ? "" : "s"}
        </span>
      </button>

      {expanded && (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          <PlaybookNotesEditor setupLabel={summary.setup_label} />

          {error && (
            <div style={{ fontSize: 12, color: "#b91c1c" }}>
              Failed to load trades: {error}
            </div>
          )}
          {!error && trades === null && (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              Loading trades…
            </div>
          )}
          {trades !== null && trades.length === 0 && (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              No trades observed under this setup in the current window.
            </div>
          )}
          {trades !== null && trades.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 12,
              }}
            >
              {trades.map((t) => (
                <PlaybookChartCard
                  key={t.tradeid}
                  trade={t}
                  sectionLabel={summary.setup_label}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
