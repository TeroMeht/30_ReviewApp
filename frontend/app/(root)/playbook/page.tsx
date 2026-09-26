"use client";

/**
 * Playbook page — a gallery of 2-min charts filtered by setup and rating.
 *
 * Filters:
 *   • Setup  — trades.setup (Reversal long, VWAP continuation, …). One at
 *              a time: clicking a setup replaces the previous one. "All"
 *              means every setup in PLAYBOOK_SETUPS — setups in
 *              HIDDEN_SETUPS never appear on this page.
 *   • Rating — trades.category (B- .. A+). Multi-select; none = all.
 *   • Window — This week / 4w / 12w / 26w / 52w / All
 *
 * Display: "Executions" toggle shows/hides the buy/sell markers on every
 * chart (remembered in localStorage).
 *
 * Example: Setup = Reversal long, Rating = A+, Window = This week shows
 * every A+ reversal-long trade since Monday.
 *
 * Filters are mirrored into the URL (?setup=…&rating=…&window=…) so a view
 * can be bookmarked, and into localStorage so the page reopens on the
 * last filters used. Charts lazy-load as you scroll (see PlaybookChartCard).
 */

import { useEffect, useState } from "react";
import HeaderBox from "@/components/HeaderBox";
import PlaybookChartCard from "@/components/playbook/PlaybookChartCard";
import { API_PREFIX } from "@/lib/api_prefix";
import { CATEGORY_OPTIONS, SETUP_OPTIONS } from "@/constants";
import type { PlaybookGalleryResponse } from "@/lib/types";

type WindowChoice = 1 | 4 | 12 | 26 | 52 | "all";
const WINDOW_OPTIONS: WindowChoice[] = [1, 4, 12, 26, 52, "all"];
const DEFAULT_WINDOW: WindowChoice = 1;
const STORAGE_KEY = "playbook.filters";
const SHOW_EXECS_KEY = "playbook.showExecutions";

// Setups that are never shown on the Playbook page.
const HIDDEN_SETUPS: readonly string[] = [
  "Swing exit",
  "Extreme reversal",
  "VWAP continuation short",
  "Opening range breakdown",
];
const PLAYBOOK_SETUPS = SETUP_OPTIONS.filter((s) => !HIDDEN_SETUPS.includes(s));

// Best rating first — that's what you usually reach for here.
const RATING_OPTIONS = [...CATEGORY_OPTIONS].reverse();

interface Filters {
  setups: string[];
  ratings: string[];
  window: WindowChoice;
}

function windowLabel(w: WindowChoice): string {
  if (w === "all") return "All";
  if (w === 1) return "This week";
  return `${w}w`;
}

function parseWindow(v: string | null | undefined): WindowChoice {
  if (v === "all") return "all";
  const n = Number(v);
  return (WINDOW_OPTIONS as (number | string)[]).includes(n)
    ? (n as WindowChoice)
    : DEFAULT_WINDOW;
}

function readInitialFilters(): Filters {
  const f = readRawFilters();
  // Drop any hidden setup that a bookmark or old saved state still
  // carries, and keep at most one (single-select).
  const visible = f.setups.filter((s) => PLAYBOOK_SETUPS.includes(s as never));
  return { ...f, setups: visible.slice(0, 1) };
}

function readRawFilters(): Filters {
  const params = new URLSearchParams(window.location.search);
  if (params.has("setup") || params.has("rating") || params.has("window")) {
    return {
      setups: params.getAll("setup"),
      ratings: params.getAll("rating"),
      window: parseWindow(params.get("window")),
    };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      return {
        setups: Array.isArray(j.setups) ? j.setups : [],
        ratings: Array.isArray(j.ratings) ? j.ratings : [],
        window: parseWindow(String(j.window)),
      };
    }
  } catch {
    /* localStorage unavailable or corrupt — fall through to defaults. */
  }
  return { setups: [], ratings: [], window: DEFAULT_WINDOW };
}

function toQuery(f: Filters): URLSearchParams {
  const qs = new URLSearchParams();
  f.setups.forEach((s) => qs.append("setup", s));
  f.ratings.forEach((r) => qs.append("rating", r));
  return qs;
}

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export default function PlaybookPage() {
  // null until hydrated on the client (URL / localStorage live there).
  const [filters, setFilters] = useState<Filters | null>(null);
  const [data, setData] = useState<PlaybookGalleryResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showExecutions, setShowExecutions] = useState<boolean>(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(SHOW_EXECS_KEY) === "0") {
        setShowExecutions(false);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const toggleExecutions = () =>
    setShowExecutions((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(SHOW_EXECS_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  useEffect(() => {
    setFilters(readInitialFilters());
  }, []);

  // Mirror filters into URL + localStorage, then fetch.
  useEffect(() => {
    if (!filters) return;

    const urlQs = toQuery(filters);
    urlQs.set("window", String(filters.window));
    window.history.replaceState(null, "", `${window.location.pathname}?${urlQs}`);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* ignore */
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // "All" setups = every visible setup, so hidden ones never show up.
        const qs = toQuery(
          filters.setups.length > 0 ? filters : { ...filters, setups: [...PLAYBOOK_SETUPS] },
        );
        if (filters.window !== "all") qs.set("weeks", String(filters.window));
        const res = await fetch(`${API_PREFIX}/playbook/trades?${qs}`);
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
        const json: PlaybookGalleryResponse = await res.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const update = (patch: Partial<Filters>) =>
    setFilters((f) => (f ? { ...f, ...patch } : f));

  const hasFilter =
    !!filters && (filters.setups.length > 0 || filters.ratings.length > 0);

  return (
    <section className="home">
      <div className="home-content">
        <header className="home-header">
          <HeaderBox
            type="title"
            title="Playbook"
            subtext="2-min charts filtered by setup and rating. Click a chart to open the trade."
          />
        </header>

        {filters && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginTop: 8,
              marginBottom: 16,
              padding: 12,
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
            }}
          >
            <ControlGroup label="Setup">
              <PillRow>
                <button
                  type="button"
                  onClick={() => update({ setups: [] })}
                  style={pill(filters.setups.length === 0)}
                  aria-pressed={filters.setups.length === 0}
                >
                  All
                </button>
                {PLAYBOOK_SETUPS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => update({ setups: [s] })}
                    style={pill(filters.setups.includes(s))}
                    aria-pressed={filters.setups.includes(s)}
                  >
                    {s}
                  </button>
                ))}
              </PillRow>
            </ControlGroup>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
              <ControlGroup label="Rating">
                <PillRow>
                  <button
                    type="button"
                    onClick={() => update({ ratings: [] })}
                    style={pill(filters.ratings.length === 0)}
                    aria-pressed={filters.ratings.length === 0}
                  >
                    All
                  </button>
                  {RATING_OPTIONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => update({ ratings: toggle(filters.ratings, r) })}
                      style={pill(filters.ratings.includes(r))}
                      aria-pressed={filters.ratings.includes(r)}
                    >
                      {r}
                    </button>
                  ))}
                </PillRow>
              </ControlGroup>

              <ControlGroup label="Window">
                <PillRow>
                  {WINDOW_OPTIONS.map((w) => (
                    <button
                      key={String(w)}
                      type="button"
                      onClick={() => update({ window: w })}
                      style={pill(filters.window === w)}
                      aria-pressed={filters.window === w}
                    >
                      {windowLabel(w)}
                    </button>
                  ))}
                </PillRow>
              </ControlGroup>

              <ControlGroup label="Executions">
                <PillRow>
                  <button
                    type="button"
                    onClick={toggleExecutions}
                    style={pill(showExecutions)}
                    aria-pressed={showExecutions}
                  >
                    {showExecutions ? "Shown" : "Hidden"}
                  </button>
                </PillRow>
              </ControlGroup>

              <div
                style={{
                  marginLeft: "auto",
                  alignSelf: "flex-end",
                  fontSize: 12,
                  color: "#64748b",
                }}
              >
                {loading
                  ? "Loading…"
                  : data
                    ? `${data.trades.length} chart${data.trades.length === 1 ? "" : "s"}`
                    : ""}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 16,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 8,
              color: "#b91c1c",
              fontSize: 13,
            }}
          >
            Failed to load playbook: {error}
          </div>
        )}

        {!error && data && data.trades.length === 0 && !loading && (
          <div
            style={{
              padding: 16,
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              color: "#475569",
              fontSize: 13,
            }}
          >
            No trades match these filters.
            {hasFilter
              ? " Try another setup or rating, or widen the window."
              : " Try widening the window."}
          </div>
        )}

        {!error && data && data.trades.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
              opacity: loading ? 0.5 : 1,
              transition: "opacity 120ms ease",
            }}
          >
            {data.trades.map((t) => (
              <PlaybookChartCard
                key={t.tradeid}
                trade={t}
                showExecutions={showExecutions}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ControlGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: "#64748b",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function PillRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{children}</div>;
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "5px 10px",
    fontSize: 12,
    borderRadius: 999,
    border: active ? "1px solid #2563eb" : "1px solid #e2e8f0",
    background: active ? "#dbeafe" : "#fff",
    color: active ? "#1e3a8a" : "#475569",
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
    fontFamily: "inherit",
  };
}
