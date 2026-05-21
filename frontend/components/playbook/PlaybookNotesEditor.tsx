"use client";

/**
 * Structured strategy-notes editor for one setup.
 *
 * Five textareas (Description, Entry rules, Exit rules, Common
 * mistakes, Examples / good day) with an explicit Save / Cancel
 * pattern — matches the trade-review EditPanel and avoids accidental
 * autosave overwrites of work-in-progress text. Saved notes round-trip
 * through PUT /api/playbook/setups/{label}/notes; the response is
 * what's rendered after save.
 *
 * Lazy fetch: fetches the existing notes once on mount. The parent
 * (PlaybookSection) only renders this editor when its section is
 * expanded, so notes for collapsed setups are never fetched.
 *
 * Empty state: a setup with no row in setup_playbook returns blank
 * strings from the GET, so this component renders an empty editor
 * without special-casing.
 */

import { useEffect, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type { PlaybookNotes, PlaybookNotesUpdate } from "@/lib/types";

type Field = keyof Pick<
  PlaybookNotes,
  "description" | "entry_rules" | "exit_rules" | "common_mistakes" | "examples"
>;

const FIELDS: { key: Field; label: string; placeholder: string; rows: number }[] = [
  {
    key: "description",
    label: "Description",
    placeholder: "What is this setup? In one sentence, what are you looking for?",
    rows: 3,
  },
  {
    key: "entry_rules",
    label: "Entry rules",
    placeholder:
      "Concrete trigger criteria. What needs to be true before you click buy?",
    rows: 5,
  },
  {
    key: "exit_rules",
    label: "Exit rules",
    placeholder:
      "Profit target, stop placement, scale-out plan, time-based exits.",
    rows: 5,
  },
  {
    key: "common_mistakes",
    label: "Common mistakes",
    placeholder:
      "What goes wrong when you take this setup? What should you not do?",
    rows: 4,
  },
  {
    key: "examples",
    label: "Examples / good day",
    placeholder:
      "Specific trades or chart memories that exemplify the setup at its best.",
    rows: 3,
  },
];

interface Props {
  setupLabel: string;
}

export default function PlaybookNotesEditor({ setupLabel }: Props) {
  const [notes, setNotes] = useState<PlaybookNotes | null>(null);
  // Draft mirrors `notes` once loaded; user edits diverge here until
  // they hit Save (which PUTs and re-syncs notes ← response) or Cancel
  // (which resets draft ← notes).
  const [draft, setDraft] = useState<PlaybookNotes | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `${API_PREFIX}/playbook/setups/${encodeURIComponent(setupLabel)}/notes`,
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
        const data: PlaybookNotes = await res.json();
        if (cancelled) return;
        setNotes(data);
        setDraft(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setupLabel]);

  const dirty =
    notes != null &&
    draft != null &&
    FIELDS.some((f) => draft[f.key] !== notes[f.key]);

  const onSave = async () => {
    if (!draft || !notes) return;
    setSaving(true);
    setError(null);
    try {
      // Send only changed fields — keeps the PATCH-style server logic
      // unambiguous (omitted = unchanged) and the request small.
      const body: PlaybookNotesUpdate = {};
      for (const f of FIELDS) {
        if (draft[f.key] !== notes[f.key]) body[f.key] = draft[f.key];
      }
      const res = await fetch(
        `${API_PREFIX}/playbook/setups/${encodeURIComponent(setupLabel)}/notes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
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
      const updated: PlaybookNotes = await res.json();
      setNotes(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onCancel = () => {
    if (notes) setDraft(notes);
  };

  if (loading) {
    return (
      <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading notes…</div>
    );
  }
  if (error && !notes) {
    return (
      <div style={{ fontSize: 12, color: "#b91c1c" }}>
        Failed to load notes: {error}
      </div>
    );
  }
  if (!draft) return null;

  return (
    <div
      style={{
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "#64748b",
          marginBottom: 8,
        }}
      >
        Strategy notes
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {FIELDS.map((f) => (
          <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "#475569",
              }}
            >
              {f.label}
            </span>
            <textarea
              value={draft[f.key]}
              onChange={(e) =>
                setDraft({ ...draft, [f.key]: e.target.value })
              }
              rows={f.rows}
              placeholder={f.placeholder}
              style={{
                fontFamily: "inherit",
                fontSize: 12,
                padding: "6px 8px",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                background: "#fff",
                resize: "vertical",
                lineHeight: 1.4,
                color: "#0f172a",
              }}
            />
          </label>
        ))}
      </div>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          gap: 8,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        {error && (
          <span style={{ fontSize: 11, color: "#b91c1c", marginRight: "auto" }}>
            {error}
          </span>
        )}
        {notes?.updated_at && !dirty && !error && (
          <span style={{ fontSize: 11, color: "#94a3b8", marginRight: "auto" }}>
            Saved {new Date(notes.updated_at).toLocaleString("fi-FI", {
              timeZone: "Europe/Helsinki",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={!dirty || saving}
          style={{
            padding: "5px 12px",
            background: "#fff",
            color: "#0f172a",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: !dirty || saving ? "not-allowed" : "pointer",
            opacity: !dirty || saving ? 0.5 : 1,
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          style={{
            padding: "5px 12px",
            background: "#0f172a",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: !dirty || saving ? "not-allowed" : "pointer",
            opacity: !dirty || saving ? 0.5 : 1,
            fontFamily: "inherit",
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
