"use client"

import { useState } from "react"
import { API_PREFIX } from "@/lib/api_prefix"
import { paths } from "@/generated/api"

// ─── Types ────────────────────────────────────────────────────────────────────

type ExecutionEmail =
  paths["/api/executions/email"]["get"]["responses"][200]["content"]["application/json"][number]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Helsinki",
  })
}

function statusColor(status: string): { bg: string; fg: string } {
  switch (status.toLowerCase()) {
    case "saved":
    case "done":
    case "ok":
      return { bg: "rgba(22,163,74,0.12)", fg: "#15803d" }
    case "pending":
      return { bg: "rgba(234,179,8,0.12)", fg: "#a16207" }
    case "failed":
    case "error":
      return { bg: "rgba(220,38,38,0.12)", fg: "#b91c1c" }
    default:
      return { bg: "rgba(100,116,139,0.1)", fg: "#475569" }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function EmailExecutionFetcher() {
  // Default: last 7 days
  const todayStr = new Date().toISOString().slice(0, 10)
  const weekAgoStr = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)

  const [startDate, setStartDate] = useState(weekAgoStr)
  const [endDate, setEndDate] = useState(todayStr)

  const [results, setResults] = useState<ExecutionEmail[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFetch() {
    if (!startDate || !endDate) return
    setLoading(true)
    setError(null)
    setResults(null)

    try {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      })
      const res = await fetch(`${API_PREFIX}/executions/email?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: ExecutionEmail[] = await res.json()
      setResults(json)
    } catch (err) {
      console.error("[EmailExecutionFetcher] fetch failed:", err)
      setError("Failed to fetch executions. Check the date range and try again.")
    } finally {
      setLoading(false)
    }
  }

  const bought = results?.filter((e) => e.action === "BOUGHT") ?? []
  const sold   = results?.filter((e) => e.action === "SOLD")   ?? []

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <style>{`
        .efe-root {
          --efe-bg:          #ffffff;
          --efe-border:      #e5e7eb;
          --efe-input-bg:    #f9fafb;
          --efe-text:        #111827;
          --efe-muted:       #6b7280;
          --efe-accent:      #111827;
          --efe-accent-fg:   #ffffff;
          --efe-hover:       #f3f4f6;
          --efe-row-hover:   #f9fafb;
          --efe-divider:     #f3f4f6;
          --efe-radius:      10px;
          --efe-bought-bg:   rgba(22,163,74,0.1);
          --efe-bought-fg:   #15803d;
          --efe-sold-bg:     rgba(220,38,38,0.1);
          --efe-sold-fg:     #b91c1c;
        }
        @media (prefers-color-scheme: dark) {
          .efe-root {
            --efe-bg:          #0f1117;
            --efe-border:      #1f2937;
            --efe-input-bg:    #161b27;
            --efe-text:        #f3f4f6;
            --efe-muted:       #9ca3af;
            --efe-accent:      #f3f4f6;
            --efe-accent-fg:   #0f1117;
            --efe-hover:       #1a2030;
            --efe-row-hover:   #161b27;
            --efe-divider:     #1f2937;
            --efe-bought-bg:   rgba(22,163,74,0.15);
            --efe-bought-fg:   #4ade80;
            --efe-sold-bg:     rgba(220,38,38,0.15);
            --efe-sold-fg:     #f87171;
          }
        }
        .efe-input {
          appearance: none;
          background: var(--efe-input-bg);
          border: 1px solid var(--efe-border);
          border-radius: var(--efe-radius);
          color: var(--efe-text);
          font-size: 13px;
          font-family: inherit;
          padding: 8px 12px;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          width: 100%;
          cursor: pointer;
        }
        .efe-input:focus {
          border-color: var(--efe-accent);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--efe-accent) 12%, transparent);
        }
        .efe-btn {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 9px 20px;
          border-radius: var(--efe-radius);
          border: none;
          background: var(--efe-accent);
          color: var(--efe-accent-fg);
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: opacity 0.15s, transform 0.1s;
          white-space: nowrap;
          letter-spacing: 0.02em;
        }
        .efe-btn:hover:not(:disabled) { opacity: 0.85; }
        .efe-btn:active:not(:disabled) { transform: scale(0.98); }
        .efe-btn:disabled { opacity: 0.45; cursor: not-allowed; }

        .efe-table { width: 100%; border-collapse: collapse; }
        .efe-table th {
          padding: 8px 14px;
          text-align: left;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--efe-muted);
          background: var(--efe-input-bg);
          position: sticky;
          top: 0;
          border-bottom: 1px solid var(--efe-border);
          white-space: nowrap;
        }
        .efe-table td { padding: 10px 14px; font-size: 12px; color: var(--efe-text); }
        .efe-table tbody tr { border-bottom: 1px solid var(--efe-divider); transition: background 0.1s; }
        .efe-table tbody tr:last-child { border-bottom: none; }
        .efe-table tbody tr:hover { background: var(--efe-row-hover); }

        @keyframes efe-spin { to { transform: rotate(360deg) } }
        .efe-spinner {
          width: 13px; height: 13px;
          border: 2px solid var(--efe-accent-fg);
          border-top-color: transparent;
          border-radius: 50%;
          animation: efe-spin 0.7s linear infinite;
          flex-shrink: 0;
        }
      `}</style>

      <div className="efe-root" style={{
        background: "var(--efe-bg)",
        border: "1px solid var(--efe-border)",
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.05)",
      }}>

        {/* ── Controls bar ── */}
        <div style={{
          padding: "16px 20px",
          background: "var(--efe-input-bg)",
          borderBottom: "1px solid var(--efe-border)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          gap: 12,
        }}>
          {/* Start date */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 150 }}>
            <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--efe-muted)" }}>
              From
            </label>
            <input
              type="date"
              className="efe-input"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          {/* Arrow separator */}
          <span style={{ color: "var(--efe-muted)", fontSize: 16, paddingBottom: 8, flexShrink: 0 }}>→</span>

          {/* End date */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 150 }}>
            <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--efe-muted)" }}>
              To
            </label>
            <input
              type="date"
              className="efe-input"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          {/* Quick presets */}
          <div style={{ display: "flex", gap: 6, paddingBottom: 1, flexWrap: "wrap" }}>
            {[
              { label: "Today",   days: 0 },
              { label: "7d",      days: 7 },
              { label: "30d",     days: 30 },
              { label: "90d",     days: 90 },
            ].map(({ label, days }) => (
              <button
                key={label}
                onClick={() => {
                  const end = new Date()
                  const start = new Date(Date.now() - days * 86400_000)
                  setEndDate(end.toISOString().slice(0, 10))
                  setStartDate(start.toISOString().slice(0, 10))
                }}
                style={{
                  padding: "5px 10px",
                  borderRadius: 7,
                  border: "1px solid var(--efe-border)",
                  background: "var(--efe-bg)",
                  color: "var(--efe-muted)",
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  transition: "background 0.1s, color 0.1s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--efe-hover)"
                  e.currentTarget.style.color = "var(--efe-text)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--efe-bg)"
                  e.currentTarget.style.color = "var(--efe-muted)"
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Fetch button — pushed to the right */}
          <div style={{ marginLeft: "auto" }}>
            <button
              className="efe-btn"
              onClick={handleFetch}
              disabled={loading || !startDate || !endDate}
            >
              {loading ? <span className="efe-spinner" /> : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 8a7 7 0 1 0 7-7" />
                  <polyline points="5 1 1 1 1 5" />
                </svg>
              )}
              {loading ? "Fetching…" : "Fetch executions"}
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div style={{
            margin: 16,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #fca5a5",
            background: "rgba(220,38,38,0.06)",
            color: "#b91c1c",
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {/* ── Summary strip ── */}
        {results !== null && !loading && (
          <div style={{
            padding: "10px 20px",
            borderBottom: results.length > 0 ? "1px solid var(--efe-border)" : "none",
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--efe-text)" }}>
              {results.length} result{results.length !== 1 ? "s" : ""}
            </span>
            {bought.length > 0 && (
              <span style={{ fontSize: 12, color: "var(--efe-bought-fg)", background: "var(--efe-bought-bg)", padding: "2px 8px", borderRadius: 5, fontWeight: 500 }}>
                {bought.length} bought
              </span>
            )}
            {sold.length > 0 && (
              <span style={{ fontSize: 12, color: "var(--efe-sold-fg)", background: "var(--efe-sold-bg)", padding: "2px 8px", borderRadius: 5, fontWeight: 500 }}>
                {sold.length} sold
              </span>
            )}
            {results.length === 0 && (
              <span style={{ fontSize: 12, color: "var(--efe-muted)" }}>No executions in this range.</span>
            )}
          </div>
        )}

        {/* ── Results table ── */}
        {results !== null && results.length > 0 && (
          <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
            <table className="efe-table">
              <thead>
                <tr>
                  {["Time", "Symbol", "Action", "Size", "Price", "DB Status", "Reference"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((exec) => {
                  const isBought = exec.action === "BOUGHT"
                  const { bg: sBg, fg: sFg } = statusColor(exec.db_status)
                  return (
                    <tr key={exec.reference}>
                      <td style={{ whiteSpace: "nowrap", color: "var(--efe-muted)" }}>
                        {formatDateTime(exec.time)}
                      </td>
                      <td style={{ fontWeight: 700, letterSpacing: "0.03em" }}>
                        {exec.symbol}
                      </td>
                      <td>
                        <span style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 5,
                          fontSize: 11,
                          fontWeight: 600,
                          background: isBought ? "var(--efe-bought-bg)" : "var(--efe-sold-bg)",
                          color: isBought ? "var(--efe-bought-fg)" : "var(--efe-sold-fg)",
                        }}>
                          {exec.action}
                        </span>
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>
                        {exec.size.toLocaleString()}
                      </td>
                      <td style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        ${Number(exec.price).toFixed(3)}
                      </td>
                      <td>
                        <span style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 5,
                          fontSize: 11,
                          fontWeight: 500,
                          background: sBg,
                          color: sFg,
                        }}>
                          {exec.db_status}
                        </span>
                      </td>
                      <td style={{ fontFamily: "monospace", fontSize: 10, color: "var(--efe-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {exec.reference}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Empty state before first fetch ── */}
        {results === null && !loading && !error && (
          <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--efe-muted)", fontSize: 13 }}>
            Select a date range and press <strong style={{ color: "var(--efe-text)" }}>Fetch executions</strong>
          </div>
        )}
      </div>
    </div>
  )
}
