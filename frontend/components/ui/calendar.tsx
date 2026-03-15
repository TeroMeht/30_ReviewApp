import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
}

export interface WeeklySummary {
  weekIndex: number;       // 0-based week index within the displayed month view
  startDate: Date;         // Monday of that week
  endDate: Date;           // Sunday of that week
  days: CalendarDay[];
}

export interface CalendarCellProps {
  day: CalendarDay;
}

export interface WeeklySummaryProps {
  summary: WeeklySummary;
}

export interface CalendarProps {
  /** Render function for each day cell. Receives day info. */
  renderDay?: (day: CalendarDay) => React.ReactNode;
  /** Render function for the weekly summary column. */
  renderWeeklySummary?: (summary: WeeklySummary) => React.ReactNode;
  /** Initially displayed month (defaults to current month). */
  initialDate?: Date;
  /** Called whenever the visible month changes. */
  onMonthChange?: (year: number, month: number) => void;
  /** Extra className for the root element. */
  className?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAYS_OF_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Build the 6×7 (or less) grid of days for the calendar.
 * Week starts on Monday (ISO). Returns weeks as arrays of CalendarDay[7].
 */
function buildCalendarWeeks(year: number, month: number): CalendarDay[][] {
  const firstDay = startOfMonth(year, month);
  // getDay() returns 0=Sun … 6=Sat; we want 0=Mon … 6=Sun
  const dayOfWeek = (firstDay.getDay() + 6) % 7; // shift so Monday = 0

  const weeks: CalendarDay[][] = [];
  let current = new Date(firstDay);
  current.setDate(current.getDate() - dayOfWeek); // rewind to Monday

  // Always render 6 weeks for a stable grid height
  for (let w = 0; w < 6; w++) {
    const week: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      week.push({
        date: new Date(current),
        isCurrentMonth: current.getMonth() === month,
      });
      current.setDate(current.getDate() + 1);
    }
    weeks.push(week);
  }

  return weeks;
}

// ─── Default renderers ────────────────────────────────────────────────────────

function DefaultDayCell({ day }: { day: CalendarDay }) {
  const today = new Date();
  const isToday = isSameDay(day.date, today);
  const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;

  return (
    <div
      style={{
        minHeight: 80,
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        opacity: day.isCurrentMonth ? 1 : 0.35,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: "50%",
          fontSize: 15,
          fontWeight: isToday ? 700 : 400,
          fontFamily: "inherit",
          background: isToday ? "var(--cal-accent)" : "transparent",
          color: isToday
            ? "var(--cal-accent-fg)"
            : isWeekend
            ? "var(--cal-weekend)"
            : "var(--cal-text)",
          lineHeight: 1,
        }}
      >
        {day.date.getDate()}
      </span>
    </div>
  );
}

function DefaultWeeklySummaryCell({ summary }: { summary: WeeklySummary }) {
  return (
    <div
      style={{
        minHeight: 80,
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        color: "var(--cal-summary-text)",
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.55,
        }}
      >
        Wk {getWeekNumber(summary.startDate)}
      </span>
    </div>
  );
}

/** Returns ISO week number. */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.valueOf() - yearStart.valueOf()) / 86400000 + 1) / 7);
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Calendar({
  renderDay,
  renderWeeklySummary,
  initialDate,
  onMonthChange,
  className,
}: CalendarProps) {
  const now = initialDate ?? new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const weeks = buildCalendarWeeks(year, month);

  function navigate(delta: number) {
    let newMonth = month + delta;
    let newYear = year;
    if (newMonth > 11) { newMonth = 0; newYear += 1; }
    if (newMonth < 0)  { newMonth = 11; newYear -= 1; }
    setMonth(newMonth);
    setYear(newYear);
    onMonthChange?.(newYear, newMonth);
  }

  const today = new Date();

  return (
    <>
      {/* Scoped styles */}
      <style>{`
        .cal-root {
          --cal-bg:          #ffffff;
          --cal-border:      #e5e7eb;
          --cal-header-bg:   #f9fafb;
          --cal-text:        #111827;
          --cal-muted:       #111827;
          --cal-weekend:     #6366f1;
          --cal-accent:      #111827;
          --cal-accent-fg:   #ffffff;
          --cal-summary-bg:  #f3f4f6;
          --cal-summary-text:#374151;
          --cal-today-ring:  #111827;
          --cal-radius:      12px;
          font-family: 'Georgia', 'Times New Roman', serif;
          background: var(--cal-bg);
          border: 1px solid var(--cal-border);
          border-radius: var(--cal-radius);
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0,0,0,.07), 0 4px 16px rgba(0,0,0,.06);
          user-select: none;
        }

        @media (prefers-color-scheme: dark) {
          .cal-root {
            --cal-bg:          #0f1117;
            --cal-border:      #1f2937;
            --cal-header-bg:   #161b27;
            --cal-text:        #f3f4f6;
            --cal-muted:       #111827;
            --cal-weekend:     #111827;
            --cal-accent:      #f3f4f6;
            --cal-accent-fg:   #0f1117;
            --cal-summary-bg:  #161b27;
            --cal-summary-text:#9ca3af;
          }
        }

        .cal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          background: var(--cal-header-bg);
          border-bottom: 1px solid var(--cal-border);
        }

        .cal-title {
          font-size: 18px;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--cal-text);
          font-family: inherit;
        }

        .cal-title-year {
          font-weight: 400;
          opacity: 0.45;
          margin-left: 6px;
          font-size: 20px;
        }

        .cal-nav-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: 1px solid var(--cal-border);
          background: var(--cal-bg);
          cursor: pointer;
          color: var(--cal-text);
          transition: background 0.15s, border-color 0.15s;
          font-size: 14px;
          line-height: 1;
        }
        .cal-nav-btn:hover {
          background: var(--cal-border);
        }

        .cal-today-btn {
          font-family: inherit;
          font-size: 12px;
          font-weight: 500;
          letter-spacing: 0.04em;
          padding: 4px 12px;
          border-radius: 6px;
          border: 1px solid var(--cal-border);
          background: var(--cal-bg);
          cursor: pointer;
          color: var(--cal-muted);
          transition: background 0.15s, color 0.15s;
        }
        .cal-today-btn:hover {
          background: var(--cal-border);
          color: var(--cal-text);
        }

        .cal-grid {
          display: grid;
          /* 7 day columns + 1 summary column */
          grid-template-columns: repeat(5, 1fr) 200px;
        }

        .cal-dow {
          padding: 8px 0 8px 8px;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--cal-muted);
          border-bottom: 1px solid var(--cal-border);
          background: var(--cal-header-bg);
          font-family: 'system-ui', sans-serif;
        }

        .cal-dow-weekend {
          color: var(--cal-weekend);
        }

        .cal-dow-summary {
          padding: 8px 0 8px 8px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--cal-muted);
          border-bottom: 1px solid var(--cal-border);
          border-left: 1px solid var(--cal-border);
          background: var(--cal-summary-bg);
          font-family: 'system-ui', sans-serif;
          opacity: 0.7;
        }

        .cal-cell {
          border-right: 1px solid var(--cal-border);
          border-bottom: 1px solid var(--cal-border);
          transition: background 0.1s;
          cursor: default;
        }
        .cal-cell:nth-child(8n) {
          /* every Sunday column — the 7th day column per row (index 7 in 8-col grid) */
        }
        .cal-cell:hover {
          background: var(--cal-header-bg);
        }

        .cal-cell-today {
          background: color-mix(in srgb, var(--cal-accent) 5%, transparent);
        }

        .cal-cell-weekend {
          background: color-mix(in srgb, var(--cal-weekend) 3%, transparent);
        }

        .cal-cell-summary {
          border-left: 2px solid var(--cal-border);
          border-bottom: 1px solid var(--cal-border);
          background: var(--cal-summary-bg);
          cursor: default;
        }
        .cal-cell-summary:hover {
          background: color-mix(in srgb, var(--cal-muted) 8%, var(--cal-summary-bg));
        }

        .cal-cell:last-child,
        .cal-cell-summary:last-child {
          border-right: none;
        }

        .cal-row-last .cal-cell,
        .cal-row-last .cal-cell-summary {
          border-bottom: none;
        }
      `}</style>

      <div className={`cal-root${className ? ` ${className}` : ""}`}>
        {/* ── Header ── */}
        <div className="cal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="cal-title">
              {MONTH_NAMES[month]}
              <span className="cal-title-year">{year}</span>
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button className="cal-today-btn" onClick={() => {
              setYear(today.getFullYear());
              setMonth(today.getMonth());
              onMonthChange?.(today.getFullYear(), today.getMonth());
            }}>
              Today
            </button>
            <button className="cal-nav-btn" onClick={() => navigate(-1)} aria-label="Previous month">
              ‹
            </button>
            <button className="cal-nav-btn" onClick={() => navigate(1)} aria-label="Next month">
              ›
            </button>
          </div>
        </div>

        {/* ── Column headers ── */}
        <div className="cal-grid">
          {DAYS_OF_WEEK.map((d, i) => (
            <div
              key={d}
              className={`cal-dow${i >= 5 ? " cal-dow-weekend" : ""}`}
            >
              {d}
            </div>
          ))}
          <div className="cal-dow-summary">Summary</div>

          {/* ── Weeks ── */}
          {weeks.map((week, wi) => {
            const isLastRow = wi === weeks.length - 1;
            const summary: WeeklySummary = {
              weekIndex: wi,
              startDate: week[0].date,
              endDate: week[6].date,
              days: week.filter((d) => { const dow = d.date.getDay(); return dow !== 0 && dow !== 6; }),
            };

            return (
              <div
                key={wi}
                style={{ display: "contents" }}
                className={isLastRow ? "cal-row-last" : ""}
              >
                {week
                  .filter((day) => {
                    const dow = day.date.getDay();
                    return dow !== 0 && dow !== 6; // hide Sat (6) and Sun (0)
                  })
                  .map((day) => {
                    const isToday = isSameDay(day.date, today);
                    let cellClass = "cal-cell";
                    if (isToday) cellClass += " cal-cell-today";

                    return (
                      <div key={day.date.toISOString()} className={cellClass}>
                        {renderDay ? renderDay(day) : <DefaultDayCell day={day} />}
                      </div>
                    );
                  })}
                {/* Weekly summary cell */}
                <div className="cal-cell-summary">
                  {renderWeeklySummary
                    ? renderWeeklySummary(summary)
                    : <DefaultWeeklySummaryCell summary={summary} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
