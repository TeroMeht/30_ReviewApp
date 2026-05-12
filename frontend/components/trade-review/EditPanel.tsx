"use client";

/**
 * Operation panel for the Trade Review page. Auto-saves on blur via
 * PATCH /api/trades/{id}.
 *
 * Setup uses the user's locked-in taxonomy. Category is still a
 * placeholder dropdown — replace CATEGORY_OPTIONS once the real list
 * is defined.
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
  const [category, setCategory] = useState<string>(trade.category ?? "");
  const [notes, setNotes] = useState<string>(trade.notes ?? "");
  const [pa, setPa] = useState<number | null>(trade.price_action_rating);
  const [pp, setPp] = useState<number | null>(trade.price_position);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savingState, setSavingState] = useState<SavingState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSetup(trade.setup ?? "");
    setCategory(trade.category ?? "");
    setNotes(trade.notes ?? "");
    setPa(trade.price_action_rating);
    setPp(trade.price_position);
    setSavedAt(null);
    setSavingState("idle");
    setError(null);
  }, [trade.tradeid]);

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

      <Field label="Setup">
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
