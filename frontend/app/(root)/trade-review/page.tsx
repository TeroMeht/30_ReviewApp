"use client";

/**
 * Trade Review page.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Header: symbol · date · prev/next/jump               │
 *   ├──────────────────────────────────────┬───────────────┤
 *   │  ChartStack                          │  Operation    │
 *   │   - daily / 30min / 2min             │  panel        │
 *   │   - markers: BUY blue ▲ / SELL red ▼ │               │
 *   │   - axes in Europe/Helsinki tz       │  Executions   │
 *   │                                      │  table        │
 *   ├──────────────────────────────────────┴───────────────┤
 *   │  Today's trades (Helsinki day of selected trade)     │
 *   │  This week's trades (Mon–Sun Helsinki week)          │
 *   └──────────────────────────────────────────────────────┘
 *
 * URL semantics:
 *   /trade-review            → latest trade (by date)
 *   /trade-review?id=42      → specific trade
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_PREFIX } from "@/lib/api_prefix";
import type {
  IbExecution,
  NeighborTrades,
  Trade,
} from "@/lib/types";

import ChartStack from "@/components/trade-review/ChartStack";
import DailyTradesTable from "@/components/trade-review/DailyTradesTable";
import EditPanel from "@/components/trade-review/EditPanel";
import ExecutionsTable from "@/components/trade-review/ExecutionsTable";
import ReviewHeader from "@/components/trade-review/ReviewHeader";
import WeeklyTradesTable from "@/components/trade-review/WeeklyTradesTable";

export default function TradeReviewPage() {
  const router = useRouter();
  const search = useSearchParams();
  const idParam = search.get("id");
  const requestedId = idParam ? parseInt(idParam, 10) : null;

  const [trade, setTrade] = useState<Trade | null>(null);
  const [executions, setExecutions] = useState<IbExecution[]>([]);
  const [neighbors, setNeighbors] = useState<NeighborTrades | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function bootstrap() {
      try {
        let tid = requestedId;
        if (tid == null) {
          const res = await fetch(`${API_PREFIX}/trades/latest`);
          if (!res.ok) {
            if (res.status === 404) {
              if (!cancelled) {
                setTrade(null);
                setExecutions([]);
                setNeighbors(null);
                setError("No trades in the database yet.");
                setLoading(false);
              }
              return;
            }
            throw new Error(`HTTP ${res.status}`);
          }
          const latest: Trade = await res.json();
          tid = latest.tradeid;
        }

        const [tradeRes, execsRes, neighborsRes] = await Promise.all([
          fetch(`${API_PREFIX}/trades/${tid}`),
          fetch(`${API_PREFIX}/trades/${tid}/executions`),
          fetch(`${API_PREFIX}/trades/${tid}/neighbors`),
        ]);

        if (!tradeRes.ok) throw new Error(`Failed to load trade: HTTP ${tradeRes.status}`);
        if (!execsRes.ok) throw new Error(`Failed to load executions: HTTP ${execsRes.status}`);
        if (!neighborsRes.ok) throw new Error(`Failed to load neighbors: HTTP ${neighborsRes.status}`);

        const tradeJson: Trade = await tradeRes.json();
        const execsJson: IbExecution[] = await execsRes.json();
        const neighborsJson: NeighborTrades = await neighborsRes.json();
        if (cancelled) return;
        setTrade(tradeJson);
        setExecutions(execsJson);
        setNeighbors(neighborsJson);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    bootstrap();
    return () => { cancelled = true; };
  }, [requestedId]);

  const handleSelectTrade = useCallback((tradeid: number) => {
    const sp = new URLSearchParams();
    sp.set("id", String(tradeid));
    router.replace(`/trade-review?${sp.toString()}`);
  }, [router]);

  const handleTradeSaved = useCallback((updated: Trade) => {
    setTrade(updated);
  }, []);

  if (loading) {
    return <div style={{ padding: 24, color: "#64748b" }}>Loading trade…</div>;
  }

  if (error || !trade) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>Trade Review</h1>
        <div
          style={{
            padding: 16, background: "#fef2f2",
            border: "1px solid #fecaca", borderRadius: 8,
            color: "#b91c1c", fontSize: 13,
          }}
        >
          {error ?? "Trade not found."}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <ReviewHeader
        trade={trade}
        neighbors={neighbors}
        onSelectTrade={handleSelectTrade}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          gap: 16,
          alignItems: "start",
        }}
      >
        <ChartStack tradeid={trade.tradeid} executions={executions} />

        <aside
          style={{
            display: "flex", flexDirection: "column", gap: 16,
            position: "sticky", top: 16,
          }}
        >
          <div style={panel}>
            <EditPanel trade={trade} onSaved={handleTradeSaved} />
          </div>
          <div style={panel}>
            <div style={panelHdr}>Executions ({executions.length})</div>
            <ExecutionsTable executions={executions} />
          </div>
        </aside>
      </div>

      <div style={panel}>
        <div style={panelHdr}>Today’s trades</div>
        <DailyTradesTable
          currentTradeId={trade.tradeid}
          dayKey={trade.tradeid}
          onSelectTrade={handleSelectTrade}
        />
      </div>

      <div style={panel}>
        <div style={panelHdr}>This week’s trades</div>
        <WeeklyTradesTable
          currentTradeId={trade.tradeid}
          weekKey={trade.tradeid}
          onSelectTrade={handleSelectTrade}
        />
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 14,
};

const panelHdr: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#0f172a",
  borderBottom: "1px solid #e2e8f0",
  paddingBottom: 6,
  marginBottom: 8,
};
