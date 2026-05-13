"use client";

/**
 * Operation panel for the Trade Review page. Auto-saves on blur via
 * PATCH /api/trades/{id}.
 *
 * Setup uses the user's locked-in taxonomy. Three setup fields are
 * tracked so we can later analyse the cost of attempting one setup
 * and executing another:
 *   • Setup            — what was *planned* / the proper setup of the
 *                        day (target).
 *   • Intended Setup   — what was *actually* executed.
 *   • Observed Setups  — multi-select of *other* setups that also
 *                        formed on the ticker that day, independent
 *                        of plan/execution. Pure backtesting label.
 * Setup + Intended share the same SETUP_OPTIONS dropdown. If they
 * differ on a row, the panel shows a small "deviation" marker so the
 * user can spot mis-executions at a glance and we have clean labels
 * for backtesting later. Observed uses the same option list rendered
 * as toggle pills.
 *
 * Category is still a placeholder dropdown — replace CATEGORY_OPTIONS
 * once the real list is defined.
 */

import { useEffect, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type { Trade, TradeUpdate } from "@/lib/types";

const SETUP_OPTIONS = [
  "No setup",
  "VWAP continuation",
  "Reversal short",
  "Reversal long",
  "Parabolic short",
  "Extreme reversal",
  "Opening range breakout",
  "Opening range breakdown",
  "Swing exit",
] as const;

// Quality categories — worst → best so the dropdown reads in the same
// order the user thinks about them.
const CATEGORY_OPTIONS = ["B-", "B", "A-", "A", "A+"] as const;

interface Props {
  trade: Trade;
  onSaved: (updated: Trade) => void;
}

type SavingState = "idle" | "saving" | "saved" | "error";

export default function EditPanel({ trade, onSaved }: Props) {
  const [setup, setSetup] = useState<string>(trade.setup ?? "");
  const [intendedSetup, setIntendedSetup] = useState<string>(
    trade.intended_setup ?? ""
  );
  const [observedSetup, setObservedSetup] = useState<string[]>(
    trade.observed_setup ?? []
  );
  const [category, setCategory] = useState<string>(trade.category ?? "");
  const [notes, setNotes] = useState<string>(trade.notes ?? "");
  const [pa, setPa] = useState<number | null>(trade.price_action_rating);
  const [pp, setPp] = useState<number | null>(trade.price_position);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savingState, setSavingState] = useState<SavingState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSetup(trade.setup ?? "");
    setIntendedSetup(trade.intended_setup ?? "");
    setObservedSetup(trade.observed_setup ?? []);
    setCategory(trade.category ?? "");
    setNotes(trade.notes ?? "");
    setPa(trade.price_action_rating);
    setPp(trade.price_position);
    setSavedAt(null);
    setSavingState("idle");
    setError(null);
  }, [trade.tradeid]);

  /** Toggle one option in the observed_setup list. Empty list is sent
   *  to the server as null so the column stays sensibly empty rather
   *  than a zero-length array. */
  function toggleObserved(opt: string) {
    setObservedSetup((prev) => {
      const next = prev.includes(opt)
        ? prev.filter((x) => x !== opt)
        : [...prev, opt];
      commit({ observed_setup: next.length === 0 ? null : next });
      return next;
    });
  }

  // Deviation = both fields filled in AND they disagree. We only flag
  // it when both are present so partially-labelled trades don't light
  // up the indicator while you're mid-entry.
  const deviation =
    setup !== "" && intendedSetup !== "" && setup !== intendedSetup;

  async function commit(patch: TradeUpdate) {
    setSavingState("saving");
    setError(null);
    try {
      const res = await fetch(`${API_PREFIX}/trades/${trade.tradeid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
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
      const updated: Trade = await res.json();
      onSaved(updated);
      setSavedAt(Date.now());
      setSavingState("saved");
      setTimeout(() => setSavingState((s) => (s === "saved" ? "idle" : s)), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSavingState("error");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={hdr}>Operation panel</div>

      <Field label="Setup (planned)">
        <select
          value={setup}
          onChange={(e) => {
            const v = e.target.value;
            setSetup(v);
            commit({ setup: v || null });
          }}
          style={input}
        >
          <option value="">—</option>
          {SETUP_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </Field>

      <Field label="Intended setup (actual)">
        <select
          value={intendedSetup}
          onChange={(e) => {
            const v = e.target.value;
            setIntendedSetup(v);
            commit({ intended_setup: v || null });
          }}
          style={{
            ...input,
            ...(deviation
              ? { borderColor: "#f59e0b", background: "#fffbeb" }
              : null),
          }}
        >
          <option value="">—</option>
          {SETUP_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        {deviation && (
          <span
            style={{
              fontSize: 10,
              color: "#b45309",
              fontWeight: 600,
              marginTop: 2,
            }}
            title="Planned setup differs from what was executed"
          >
            ⚠ Deviation: planned “{setup}” → executed “{intendedSetup}”
          </span>
        )}
      </Field>

      <Field label="Observed setups (also on ticker today)">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {SETUP_OPTIONS.map((opt) => {
            const active = observedSetup.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggleObserved(opt)}
                style={{
                  padding: "3px 8px",
                  fontSize: 11,
                  borderRadius: 999,
                  border: active
                    ? "1px solid #2563eb"
                    : "1px solid #e2e8f0",
                  background: active ? "#dbeafe" : "#fff",
                  color: active ? "#1e3a8a" : "#475569",
                  cursor: "pointer",
                  fontWeight: active ? 600 : 400,
                  fontFamily: "inherit",
                }}
                aria-pressed={active}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Category">
        <select
          value={category}
          onChange={(e) => {
            const v = e.target.value;
            setCategory(v);
            commit({ category: v || null });
          }}
          style={input}
        >
          <option value="">—</option>
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </Field>

      <Field label="Price Action Rating">
        <StarRating
          value={pa}
          onChange={(v) => { setPa(v); commit({ price_action_rating: v }); }}
        />
      </Field>

      <Field label="Price Position">
        <StarRating
          value={pp}
          onChange={(v) => { setPp(v); commit({ price_position: v }); }}
        />
      </Field>

      <Field label="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if (notes !== (trade.notes ?? "")) commit({ notes: notes || null });
          }}
          rows={4}
          style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
          placeholder="Free-form notes about this trade…"
        />
      </Field>

      <SaveIndicator state={savingState} error={error} savedAt={savedAt} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10, fontWeight: 600, letterSpacing: "0.07em",
          textTransform: "uppercase", color: "#64748b",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function StarRating({
  value, onChange,
}: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value !== null && n <= value;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(value === n ? null : n)}
            style={{
              width: 26, height: 26,
              border: "1px solid #e2e8f0", borderRadius: 6,
              background: filled ? "#facc15" : "#fff",
              color: filled ? "#7c2d12" : "#94a3b8",
              fontSize: 13, cursor: "pointer", padding: 0,
            }}
            aria-label={`${n} star`}
          >
            ★
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => onChange(null)}
        title="Clear"
        style={{
          marginLeft: 6, fontSize: 10, color: "#94a3b8",
          background: "transparent", border: "none", cursor: "pointer",
        }}
      >
        clear
      </button>
    </div>
  );
}

function SaveIndicator({
  state, error, savedAt,
}: { state: SavingState; error: string | null; savedAt: number | null }) {
  if (state === "saving") return <Tiny color="#64748b">Saving…</Tiny>;
  if (state === "saved" && savedAt) return <Tiny color="#16a34a">✓ Saved</Tiny>;
  if (state === "error") return <Tiny color="#b91c1c">Save failed: {error}</Tiny>;
  return <Tiny color="transparent">·</Tiny>;
}

function Tiny({ color, children }: { color: string; children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color, minHeight: 14 }}>{children}</div>;
}

const hdr: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, color: "#0f172a",
  borderBottom: "1px solid #e2e8f0", paddingBottom: 6,
};

const input: React.CSSProperties = {
  width: "100%", padding: "6px 8px",
  border: "1px solid #e2e8f0", borderRadius: 6,
  background: "#fff", fontSize: 12, color: "#0f172a",
};
