"use client";

/**
 * Weekly Review page.
 *
 * Pick a Mon–Sun week, hit "Generate review", and the backend asks Claude
 * to review that week's trades, P/L, notes and plan-vs-actual deviations —
 * plus several trailing weeks of raw data so it can flag mistakes the
 * trader repeats over and over. Generated reviews are stored, so revisiting
 * a week loads the saved review without re-spending tokens; the Regenerate
 * button forces a fresh pass.
 */

import { useEffect, useState } from "react";
import HeaderBox from "@/components/HeaderBox";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  WeeklyReview,
  WeeklyReviewWeek,
  WeeklyReviewWeeksResponse,
} from "@/lib/types";

import MarkdownView from "@/components/weekly-review/MarkdownView";
import ReviewStats from "@/components/weekly-review/ReviewStats";

export default function WeeklyReviewPage() {
  const [weeks, setWeeks] = useState<WeeklyReviewWeek[]>([]);
  const [selected, setSelected] = useState<string>(""); // week_start ISO
  const [review, setReview] = useState<WeeklyReview | null>(null);

  const [loadingWeeks, setLoadingWeeks] = useState<boolean>(false);
  const [loadingReview, setLoadingReview] = useState<boolean>(false);
  const [generating, setGenerating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWeek = weeks.find((w) => w.week_start === selected) || null;

  // Load the selectable weeks once.
  useEffect(() => {
    let cancelled = false;
    setLoadingWeeks(true);
    (async () => {
      try {
        const res = await fetch(`${API_PREFIX}/reviews/weeks`);
        if (!res.ok) throw new Error(await readError(res));
        const json: WeeklyReviewWeeksResponse = await res.json();
        if (cancelled) return;
        setWeeks(json.weeks);
        // Default to the most recent week that actually has trades.
        const firstWithTrades =
          json.weeks.find((w) => w.trade_count > 0) || json.weeks[0];
        if (firstWithTrades) setSelected(firstWithTrades.week_start);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoadingWeeks(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the selected week changes, load any stored review for it.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setReview(null);
    setError(null);
    setLoadingReview(true);
    (async () => {
      try {
        const res = await fetch(
          `${API_PREFIX}/reviews?week_start=${selected}`
        );
        if (res.status === 404) {
          if (!cancelled) setReview(null); // no review yet — that's fine
          return;
        }
        if (!res.ok) throw new Error(await readError(res));
        const json: WeeklyReview = await res.json();
        if (!cancelled) setReview(json);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoadingReview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function generate() {
    if (!selected) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_PREFIX}/reviews/generate?week_start=${selected}`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(await readError(res));
      const json: WeeklyReview = await res.json();
      setReview(json);
      // Reflect has_review in the picker.
      setWeeks((prev) =>
        prev.map((w) =>
          w.week_start === selected ? { ...w, has_review: true } : w
        )
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-6 gap-6">
      <HeaderBox
        title="Weekly Review"
        subtext="Let Claude review a week of trading — what went well, what to fix, and the mistakes you keep repeating."
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm text-gray-600">
          <span className="mb-1 font-medium">Week</span>
          <select
            className="rounded-md border border-gray-300 px-3 py-2 text-sm min-w-[260px] bg-white"
            value={selected}
            disabled={loadingWeeks}
            onChange={(e) => setSelected(e.target.value)}
          >
            {weeks.map((w) => (
              <option key={w.week_start} value={w.week_start}>
                {w.label}
                {w.trade_count > 0 ? ` · ${w.trade_count} trades` : " · no trades"}
                {w.has_review ? " · ✓ reviewed" : ""}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={generate}
          disabled={generating || !selected}
          className="rounded-md bg-bankGradient bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-blue-700 transition-colors"
        >
          {generating
            ? "Generating…"
            : review
            ? "Regenerate review"
            : "Generate review"}
        </button>

        {selectedWeek && (
          <span className="text-xs text-gray-500 pb-2">
            {selectedWeek.trade_count} trades in this week
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {review && <ReviewStats stats={review.stats} />}

      <div className="flex-1">
        {generating && (
          <p className="text-sm text-gray-500">
            Claude is reviewing the week — this can take a few seconds…
          </p>
        )}
        {!generating && loadingReview && (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
        {!generating && !loadingReview && review && (
          <>
            <MarkdownView markdown={review.content} />
            {review.created_at && (
              <p className="mt-6 text-xs text-gray-400">
                Generated {new Date(review.created_at).toLocaleString()} ·{" "}
                {review.model}
              </p>
            )}
          </>
        )}
        {!generating && !loadingReview && !review && selected && (
          <p className="text-sm text-gray-500">
            No review for this week yet. Click{" "}
            <span className="font-medium">Generate review</span> to create one.
          </p>
        )}
      </div>
    </div>
  );
}

async function readError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    if (j?.detail) return String(j.detail);
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
