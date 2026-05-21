"use client";

/**
 * Playbook page.
 *
 * One section per observed-setup label. Each section is collapsible
 * (state persisted to localStorage per label). When expanded, the
 * section shows structured strategy notes and a 3-column grid of
 * 2-min charts for every trade where the setup appears in
 * observed_setup. Charts within a section lazy-load on scroll.
 *
 * Page-level controls:
 *   • Window — 4w / 8w / 12w / 26w / 52w / All. Affects which trades
 *     populate every section. Sections that have zero trades in the
 *     window are not rendered.
 *
 * URL: /playbook (no query params yet).
 */

import { useEffect, useState } from "react";
import HeaderBox from "@/components/HeaderBox";
import PlaybookSection from "@/components/playbook/PlaybookSection";
import { API_PREFIX } from "@/lib/api_prefix";
import type { PlaybookSetupsResponse } from "@/lib/types";

type WindowChoice = 4 | 8 | 12 | 26 | 52 | "all";
const WINDOW_OPTIONS: WindowChoice[] = [4, 8, 12, 26, 52, "all"];

function windowLabel(w: WindowChoice): string {
  return w === "all" ? "All" : `${w}w`;
}

function windowToWeeks(w: WindowChoice): number | null {
  return w === "all" ? null : w;
}

export default function PlaybookPage() {
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(12);
  const [data, setData] = useState<PlaybookSetupsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const weeks = windowToWeeks(windowChoice);
        const qs = weeks == null ? "" : `?weeks=${weeks}`;
        const res = await fetch(`${API_PREFIX}/playbook/setups${qs}`);
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
        const json: PlaybookSetupsResponse = await res.json();
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
  }, [windowChoice]);

  const weeksForChildren = windowToWeeks(windowChoice);

  return (
    <section className="home">
      <div className="home-content">
        <header className="home-header">
          <HeaderBox
            type="title"
            title="Playbook"
            subtext="Develop strategies setup by setup. Click a section to open notes and 2-min charts of every observed trade."
          />
        </header>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "flex-end",
            marginTop: 8,
            marginBottom: 16,
          }}
        >
          <ControlGroup label="Window">
            <div style={{ display: "flex", gap: 4 }}>
              {WINDOW_OPTIONS.map((w) => (
                <button
                  key={String(w)}
                  type="button"
                  onClick={() => setWindowChoice(w)}
                  style={pill(windowChoice === w)}
                  aria-pressed={windowChoice === w}
                >
                  {windowLabel(w)}
                </button>
              ))}
            </div>
          </ControlGroup>
        </div>

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

        {!error && loading && !data && (
          <div style={{ color: "#94a3b8", fontSize: 12 }}>Loading…</div>
        )}

        {data && data.rows.length === 0 && (
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
            No trades with observed setups in this window. Either widen
            the window or label the “Observed setups” field on the
            Trade Review page.
          </div>
        )}

        {data && data.rows.length > 0 && (
          // key={windowChoice} forces remount of every section when the
          // window changes — wipes lazy state (cached trades, expand
          // state survives via localStorage) so each section refetches
          // its trade list against the new window on next expand.
          <div
            key={String(windowChoice)}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {data.rows.map((s) => (
              <PlaybookSection
                key={s.setup_label}
                summary={s}
                weeks={weeksForChildren}
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
