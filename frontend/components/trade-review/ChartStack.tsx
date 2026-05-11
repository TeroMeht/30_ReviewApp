"use client";

/**
 * Three stacked TradeCharts — daily / 30 min / 2 min — each fetching its
 * bars independently. Executions are passed in once and plotted on all
 * three. Bar fetching is parallel.
 */

import { useEffect, useState } from "react";
import { API_PREFIX } from "@/lib/api_prefix";
import type { BarsResponse, IbExecution, Timeframe } from "@/lib/types";
import TradeChart from "./TradeChart";

const TIMEFRAMES: { tf: Timeframe; label: string; height: number }[] = [
  { tf: "daily", label: "Daily · 1Y", height: 280 },
  { tf: "30min", label: "30 min · 30D", height: 320 },
  { tf: "2min",  label: "2 min · 5D",  height: 420 },
];

interface Props {
  tradeid: number;
  executions: IbExecution[];
}

export default function ChartStack({ tradeid, executions }: Props) {
  const [bars, setBars] = useState<Record<Timeframe, BarsResponse | null>>({
    daily: null,
    "30min": null,
    "2min": null,
  });
  const [errors, setErrors] = useState<Record<Timeframe, string | null>>({
    daily: null,
    "30min": null,
    "2min": null,
  });
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setBars({ daily: null, "30min": null, "2min": null });
    setErrors({ daily: null, "30min": null, "2min": null });

    const fetchOne = async (tf: Timeframe) => {
      try {
        const res = await fetch(
          `${API_PREFIX}/trades/${tradeid}/bars?timeframe=${tf}`
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
        const data: BarsResponse = await res.json();
        if (cancelled) return;
        setBars((prev) => ({ ...prev, [tf]: data }));
      } catch (e) {
        if (cancelled) return;
        setErrors((prev) => ({
          ...prev,
          [tf]: e instanceof Error ? e.message : String(e),
        }));
      }
    };

    Promise.all(TIMEFRAMES.map((t) => fetchOne(t.tf))).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [tradeid]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {TIMEFRAMES.map(({ tf, label, height }) => {
        const data = bars[tf];
        const err = errors[tf];
        return (
          <div key={tf}>
            {err ? (
              <div
                style={{
                  padding: 24,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: 8,
                  color: "#b91c1c",
                  fontSize: 13,
                }}
              >
                {label}: {err}
              </div>
            ) : !data ? (
              <div
                style={{
                  padding: 24,
                  textAlign: "center",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  color: "#64748b",
                  fontSize: 13,
                  height,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#f8fafc",
                }}
              >
                {loading ? `Loading ${label}…` : "No data"}
              </div>
            ) : data.bars.length === 0 ? (
              <div
                style={{
                  padding: 24,
                  textAlign: "center",
                  border: "1px dashed #cbd5e1",
                  borderRadius: 8,
                  color: "#94a3b8",
                  fontSize: 13,
                  height,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#f8fafc",
                }}
              >
                {label}: no bars in DB yet — run “Update Market Data”.
              </div>
            ) : (
              <TradeChart
                bars={data.bars}
                executions={executions}
                timeframe={tf}
                label={label}
                height={height}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
