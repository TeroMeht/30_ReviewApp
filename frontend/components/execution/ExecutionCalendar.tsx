"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import Calendar, { CalendarDay, WeeklySummary } from "@/components/ui/calendar"
import { API_PREFIX } from "@/lib/api_prefix"
import { paths } from "@/generated/api"

// ─── Types ────────────────────────────────────────────────────────────────────

type Execution =
  paths["/api/executions/mydb"]["get"]["responses"][200]["content"]["application/json"][number]

type CategoryUpdate =
  paths["/api/executions/category"]["patch"]["responses"][200]["content"]["application/json"]

type ExecutionMap = Record<string, Execution[]>

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TZ = "Europe/Helsinki"

function toDateKey(date: Date): string {
  return date.toLocaleDateString("sv-SE", { timeZone: TZ })
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TZ,
  })
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: TZ,
  })
}

// ─── Category cell (inline editable) ─────────────────────────────────────────

const CATEGORIES = [
  "exit premature",
  "entry premature",
  "no setup",
  "ok",
  "not in playbook",
  "revenge",
] as const

type Category = typeof CATEGORIES[number]

function categoryStyle(cat: string | null): { bg: string; fg: string; border: string } {
  if (!cat) return { bg: "transparent", fg: "var(--modal-subtext, #9ca3af)", border: "1px dashed var(--modal-border, #e5e7eb)" }
  if (cat === "ok") return { bg: "rgba(22,163,74,0.1)", fg: "#15803d", border: "1px solid rgba(22,163,74,0.3)" }
  return { bg: "rgba(220,38,38,0.08)", fg: "#b91c1c", border: "1px solid rgba(220,38,38,0.25)" }
}

function CategoryCell({
  exec,
  onUpdated,
}: {
  exec: Execution
  onUpdated: (reference: string, category: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [dropPos, setDropPos] = useState<{ top: number; left: number; flipUp: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState<"ok" | "err" | null>(null)
  const [current, setCurrent] = useState(exec.category ?? null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function select(cat: Category) {
    setOpen(false)
    if (cat === current) return
    setSaving(true)
    try {
      const params = new URLSearchParams({ reference: exec.reference, category: cat })
      const res = await fetch(`${API_PREFIX}/executions/category?${params}`, { method: "PATCH" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: CategoryUpdate = await res.json()
      setCurrent(data.category)
      onUpdated(data.reference, data.category)
      setFlash("ok")
    } catch {
      setFlash("err")
    } finally {
      setSaving(false)
      setTimeout(() => setFlash(null), 1800)
    }
  }

  const { bg, fg, border } = flash === "ok"
    ? { bg: "rgba(22,163,74,0.08)", fg: "#15803d", border: "1px solid rgba(22,163,74,0.4)" }
    : flash === "err"
    ? { bg: "rgba(220,38,38,0.08)", fg: "#b91c1c", border: "1px solid rgba(220,38,38,0.4)" }
    : categoryStyle(current)

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={triggerRef}
        onClick={() => {
          if (saving || flash) return
          if (!open && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect()
            const dropHeight = 220
            const flipUp = rect.bottom + dropHeight > window.innerHeight
            setDropPos({
              top: flipUp ? rect.top + window.scrollY - dropHeight - 4 : rect.bottom + window.scrollY + 4,
              left: rect.left + window.scrollX,
              flipUp,
            })
          } else {
            setDropPos(null)
          }
          setOpen((o) => !o)
        }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "2px 7px", borderRadius: 5, border,
          background: bg, color: fg,
          fontSize: 11, fontFamily: "inherit",
          cursor: saving || flash ? "default" : "pointer",
          transition: "all 0.15s", whiteSpace: "nowrap",
        }}
      >
        {saving ? "…" : flash === "ok" ? "✓ saved" : flash === "err" ? "✗ failed" : current ?? "set category"}
        {!saving && !flash && (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" style={{ opacity: 0.6, marginTop: 1 }}>
            <path d="M5 7L1 3h8L5 7z" />
          </svg>
        )}
      </button>

      {open && dropPos && createPortal(
        <>
          {/* click-away */}
          <div onClick={() => { setOpen(false); setDropPos(null) }} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
          <div style={{
            position: "absolute",
            top: dropPos.top,
            left: dropPos.left,
            zIndex: 9999,
            minWidth: 170,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
            overflow: "hidden",
            animation: "cal-fade-in 0.1s ease",
          }}>
            {CATEGORIES.map((cat) => {
              const { bg: oBg, fg: oFg } = categoryStyle(cat)
              const isActive = cat === current
              return (
                <button
                  key={cat}
                  onClick={() => { select(cat); setDropPos(null) }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    width: "100%", padding: "7px 12px",
                    border: "none", background: isActive ? oBg : "transparent",
                    color: isActive ? oFg : "#111827",
                    fontSize: 12, fontFamily: "inherit",
                    cursor: "pointer", textAlign: "left",
                    transition: "background 0.1s",
                    gap: 8,
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#f9fafb" }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isActive ? oBg : "transparent" }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                      background: cat === "ok" ? "#16a34a" : "#dc2626",
                    }} />
                    {cat}
                  </span>
                  {isActive && (
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke={oFg} strokeWidth="2" strokeLinecap="round">
                      <path d="M2 6l3 3 5-5" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

// ─── Execution detail modal ───────────────────────────────────────────────────

function ExecutionModal({
  date,
  executions,
  onClose,
  onCategoryUpdated,
}: {
  date: Date
  executions: Execution[]
  onClose: () => void
  onCategoryUpdated: (reference: string, category: string) => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const bought = executions.filter((e) => e.action === "BOUGHT")
  const sold = executions.filter((e) => e.action === "SOLD")

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(2px)",
          zIndex: 50,
          animation: "cal-fade-in 0.15s ease",
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Executions for ${formatDate(date)}`}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 51,
          width: "min(640px, 95vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--modal-bg, #fff)",
          border: "1px solid var(--modal-border, #e5e7eb)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
          overflow: "hidden",
          animation: "cal-slide-up 0.2s cubic-bezier(0.34,1.56,0.64,1)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <style>{`
          @keyframes cal-fade-in  { from { opacity:0 } to { opacity:1 } }
          @keyframes cal-slide-up { from { opacity:0; transform:translate(-50%,calc(-50% + 12px)) } to { opacity:1; transform:translate(-50%,-50%) } }
          @media (prefers-color-scheme: dark) {
            :root {
              --modal-bg:#0f1117; --modal-border:#1f2937; --modal-header-bg:#161b27;
              --modal-text:#f3f4f6; --modal-subtext:#9ca3af; --modal-row-hover:#1a2030;
              --modal-divider:#1f2937;
              --modal-badge-bought-bg:rgba(22,163,74,0.15); --modal-badge-bought-fg:#4ade80;
              --modal-badge-sold-bg:rgba(220,38,38,0.15);   --modal-badge-sold-fg:#f87171;
              --modal-tag-bg:#1f2937; --modal-tag-fg:#9ca3af;
            }
          }
          @media (prefers-color-scheme: light) {
            :root {
              --modal-bg:#ffffff; --modal-border:#e5e7eb; --modal-header-bg:#f9fafb;
              --modal-text:#111827; --modal-subtext:#6b7280; --modal-row-hover:#f9fafb;
              --modal-divider:#f3f4f6;
              --modal-badge-bought-bg:rgba(22,163,74,0.1); --modal-badge-bought-fg:#15803d;
              --modal-badge-sold-bg:rgba(220,38,38,0.1);   --modal-badge-sold-fg:#b91c1c;
              --modal-tag-bg:#f3f4f6; --modal-tag-fg:#6b7280;
            }
          }
        `}</style>

        {/* Header */}
        <div style={{
          padding: "16px 20px",
          background: "var(--modal-header-bg, #f9fafb)",
          borderBottom: "1px solid var(--modal-divider, #f3f4f6)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexShrink: 0,
        }}>
          <div>
            <p style={{ fontSize: 16, fontWeight: 700, color: "var(--modal-text)", margin: 0 }}>
              {formatDate(date)}
            </p>
            <p style={{ fontSize: 13, color: "var(--modal-subtext)", margin: "2px 0 0" }}>
              {executions.length} execution{executions.length !== 1 ? "s" : ""}
              {bought.length > 0 && (
                <span style={{ marginLeft: 8, color: "var(--modal-badge-bought-fg)" }}>{bought.length} bought</span>
              )}
              {sold.length > 0 && (
                <span style={{ marginLeft: 6, color: "var(--modal-badge-sold-fg)" }}>· {sold.length} sold</span>
              )}
              <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.5 }}>· click category to edit</span>
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 32, height: 32, borderRadius: 8,
              border: "1px solid var(--modal-divider)",
              background: "transparent", cursor: "pointer",
              color: "var(--modal-subtext)", fontSize: 20, lineHeight: 1, flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Table */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {executions.length === 0 ? (
            <p style={{ padding: 24, textAlign: "center", color: "var(--modal-subtext)", fontSize: 14 }}>
              No executions on this day.
            </p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--modal-divider)" }}>
                  {["Time", "Symbol", "Action", "Size", "Price", "Category"].map((h) => (
                    <th key={h} style={{
                      padding: "8px 14px",
                      textAlign: "left",
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "var(--modal-subtext)",
                      background: "var(--modal-header-bg)",
                      position: "sticky",
                      top: 0,
                      whiteSpace: "nowrap",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {executions.map((exec, i) => {
                  const isBought = exec.action === "BOUGHT"
                  return (
                    <tr
                      key={exec.reference}
                      style={{
                        borderBottom: i < executions.length - 1 ? "1px solid var(--modal-divider)" : "none",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--modal-row-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--modal-subtext)", whiteSpace: "nowrap" }}>
                        {formatTime(exec.time)}
                      </td>
                      <td style={{ padding: "10px 14px" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--modal-text)", letterSpacing: "0.03em" }}>
                          {exec.symbol}
                        </span>
                      </td>
                      <td style={{ padding: "10px 14px" }}>
                        <span style={{
                          display: "inline-block", padding: "2px 8px", borderRadius: 5,
                          fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
                          background: isBought ? "var(--modal-badge-bought-bg)" : "var(--modal-badge-sold-bg)",
                          color: isBought ? "var(--modal-badge-bought-fg)" : "var(--modal-badge-sold-fg)",
                        }}>
                          {exec.action}
                        </span>
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 13, color: "var(--modal-text)", fontVariantNumeric: "tabular-nums" }}>
                        {exec.size.toLocaleString()}
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: "var(--modal-text)", fontVariantNumeric: "tabular-nums" }}>
                        ${Number(exec.price).toFixed(3)}
                      </td>
                      <td style={{ padding: "10px 14px" }}>
                        <CategoryCell exec={exec} onUpdated={onCategoryUpdated} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "8px 20px",
          borderTop: "1px solid var(--modal-divider)",
          flexShrink: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}>
          {executions.map((exec) => (
            <span key={exec.reference} title={exec.reference} style={{
              fontSize: 9, color: "var(--modal-subtext)", opacity: 0.4,
              fontFamily: "monospace", maxWidth: 180,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {exec.reference}
            </span>
          ))}
        </div>
      </div>
    </>
  )
}

// ─── Day cell renderer ────────────────────────────────────────────────────────

function DayCell({
  day,
  executions,
  onClick,
}: {
  day: CalendarDay
  executions: Execution[]
  onClick: () => void
}) {
  const today = new Date()
  const isToday =
    day.date.getFullYear() === today.getFullYear() &&
    day.date.getMonth() === today.getMonth() &&
    day.date.getDate() === today.getDate()

  const hasExecutions = executions.length > 0

  return (
    <div
      onClick={hasExecutions ? onClick : undefined}
      style={{
        minHeight: 80,
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        opacity: day.isCurrentMonth ? 1 : 0.3,
        cursor: hasExecutions ? "pointer" : "default",
      }}
      title={hasExecutions ? `${executions.length} execution${executions.length !== 1 ? "s" : ""} — click to expand` : undefined}
    >
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 24, height: 24, borderRadius: "50%",
        fontSize: 18, fontWeight: isToday ? 700 : 400,
        background: isToday ? "var(--cal-accent)" : "transparent",
        color: isToday ? "var(--cal-accent-fg)" : "var(--cal-text)",
        flexShrink: 0, lineHeight: 1,
      }}>
        {day.date.getDate()}
      </span>

      {executions.slice(0, 3).map((exec) => {
        const isBought = exec.action === "BOUGHT"
        return (
          <div key={exec.reference} style={{
            fontSize: 11, lineHeight: 1.3, padding: "2px 5px", borderRadius: 4,
            background: isBought ? "rgba(22,163,74,0.1)" : "rgba(220,38,38,0.1)",
            color: isBought ? "#15803d" : "#b91c1c",
            fontFamily: "system-ui, sans-serif", fontWeight: 500,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {exec.symbol} {isBought ? "B" : "S"} ×{exec.size} @ ${Number(exec.price).toFixed(2)}
          </div>
        )
      })}

      {executions.length > 3 && (
        <span style={{ fontSize: 9, color: "var(--cal-muted)", fontFamily: "system-ui, sans-serif" }}>
          +{executions.length - 3} more
        </span>
      )}
    </div>
  )
}

// ─── Weekly summary renderer ──────────────────────────────────────────────────



function WeeklySummaryCell({
  summary,
  executionMap,
}: {
  summary: WeeklySummary
  executionMap: ExecutionMap
}) {
  const allExecs = summary.days.flatMap(
    (d) => executionMap[toDateKey(d.date)] ?? []
  )
  const total = allExecs.length

  const counts = new Map<string, number>()
  for (const exec of allExecs) {
    if (exec.category) counts.set(exec.category, (counts.get(exec.category) ?? 0) + 1)
  }

  return (
    <div style={{
      minHeight: 80, padding: "5px 6px",
      display: "flex", flexDirection: "column", gap: 2,
      fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 1 }}>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--cal-muted)" }}>
          Week
        </span>
        {total > 0 && (
          <span style={{ fontSize: 12, color: "var(--cal-muted)", opacity: 0.6 }}>{total}</span>
        )}
      </div>

      {CATEGORIES.map((cat) => {
        const count = counts.get(cat) ?? 0
        const isOk = cat === "ok"
        const hasAny = count > 0

        const fg = hasAny
          ? isOk ? "#15803d" : "#b91c1c"
          : "#111827"
        const bg = hasAny
          ? isOk ? "rgba(22,163,74,0.12)" : "rgba(220,38,38,0.08)"
          : "transparent"
        const dot = isOk ? "#16a34a" : "#dc2626"

        return (
          <div key={cat} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "1px 4px", borderRadius: 4,
            background: bg,
            opacity: hasAny ? 1 : 0.28,
            gap: 3,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 3, minWidth: 0 }}>
              <span style={{
                width: 5, height: 5, borderRadius: "100%", flexShrink: 0,
                background: hasAny ? dot : "#111827",
              }} />
              <span style={{
                fontSize: 12, color: fg, fontWeight: hasAny ? 500 : 400,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {cat}
              </span>
            </div>
            <span style={{
              fontSize: 9, fontWeight: 700, color: fg, flexShrink: 0,
              minWidth: 10, textAlign: "right",
            }}>
              {hasAny ? count : "·"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function ExecutionCalendar() {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())

  const [executionMap, setExecutionMap] = useState<ExecutionMap>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<Date | null>(null)

  const fetchExecutions = useCallback(async (y: number, m: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_PREFIX}/executions/mydb?year=${y}&month=${m + 1}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const json: Execution[] = await res.json()

      const map: ExecutionMap = {}
      for (const exec of json) {
        const key = exec.time?.slice(0, 10)
        if (!key) continue
        if (!map[key]) map[key] = []
        map[key].push(exec)
      }
      setExecutionMap(map)
    } catch (err) {
      console.error("[ExecutionCalendar] fetch failed:", err)
      setError("Failed to load execution data.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchExecutions(year, month)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleMonthChange(newYear: number, newMonth: number) {
    setYear(newYear)
    setMonth(newMonth)
    fetchExecutions(newYear, newMonth)
  }

  // Update category in the execution map without refetching
  const handleCategoryUpdated = useCallback((reference: string, category: string) => {
    setExecutionMap((prev) => {
      const next: ExecutionMap = {}
      for (const [key, execs] of Object.entries(prev)) {
        next[key] = execs.map((e) =>
          e.reference === reference ? { ...e, category } : e
        )
      }
      return next
    })
  }, [])

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-bold"></h2>
        {loading && (
          <span className="text-sm text-gray-400 animate-pulse">Loading…</span>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      <Calendar
        initialDate={today}
        onMonthChange={handleMonthChange}
        renderDay={(day: CalendarDay) => (
          <DayCell
            day={day}
            executions={executionMap[toDateKey(day.date)] ?? []}
            onClick={() => setSelectedDay(day.date)}
          />
        )}
        renderWeeklySummary={(summary: WeeklySummary) => (
          <WeeklySummaryCell summary={summary} executionMap={executionMap} />
        )}
      />

      {selectedDay && (
        <ExecutionModal
          date={selectedDay}
          executions={executionMap[toDateKey(selectedDay)] ?? []}
          onClose={() => setSelectedDay(null)}
          onCategoryUpdated={handleCategoryUpdated}
        />
      )}
    </div>
  )
}
