import React from "react";
import type { WeeklyReviewStats } from "@/lib/types";

/** Headline numbers shown above the review body. */
export default function ReviewStats({ stats }: { stats: WeeklyReviewStats }) {
  const pnl = stats.total_pnl ?? 0;
  const winRate =
    stats.win_rate != null ? `${Math.round(stats.win_rate * 100)}%` : "—";

  const items: { label: string; value: string; tone?: "pos" | "neg" }[] = [
    {
      label: "Net P/L",
      value: pnl.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }),
      tone: pnl > 0 ? "pos" : pnl < 0 ? "neg" : undefined,
    },
    { label: "Trades", value: String(stats.trade_count ?? 0) },
    { label: "Win rate", value: winRate },
    {
      label: "W / L / Scr",
      value: `${stats.wins ?? 0} / ${stats.losses ?? 0} / ${stats.scratches ?? 0}`,
    },
    { label: "Total execs", value: String(stats.total_execs ?? 0) },
    { label: "Plan deviations", value: String(stats.plan_deviations ?? 0) },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-lg border border-gray-200 bg-white px-4 py-3"
        >
          <div className="text-xs uppercase tracking-wide text-gray-500">
            {it.label}
          </div>
          <div
            className={
              "mt-1 text-lg font-semibold " +
              (it.tone === "pos"
                ? "text-green-600"
                : it.tone === "neg"
                ? "text-red-600"
                : "text-gray-900")
            }
          >
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}
