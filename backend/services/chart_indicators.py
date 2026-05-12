"""
Bridge between the pure calculation primitives and the BarsResponse the
chart endpoint returns.

Responsibilities:
  * Decide which indicators run for which timeframe (e.g. EMA9 + anchored
    VWAP are only meaningful on the 2-min chart, not the daily/30-min).
  * Translate the aligned `list[float | None]` that the calc primitives
    return into the `IndicatorSeries` schema shape (one point per bar).
  * Coordinate cross-timeframe inputs — Relatr on the 2-min chart needs a
    daily ATR scalar, so the bars endpoint hands us daily bars too.

Everything below this layer (calculations/*) is pure and reusable by the
upcoming backtest engine — this file is the only place that knows about
chart-side wiring.
"""

from typing import Optional, Sequence

from schemas.api_schemas import BarRow as BarRowSchema, IndicatorPoint, IndicatorSeries
from calculations import (
    sma,
    ema,
    vwap_anchored,
    atr,
    relatr,
    avg_volume_per_time_of_day,
    rvol,
)
from calculations.bars import to_indicator_bars
from calculations.indicators import _session_anchor_date  # noqa: F401  (for typing/intent — not called here)


# Locked-in chart anchors / periods. Centralised here so the future
# backtester pulls from the same source of truth.
EMA_PERIOD: int = 9
VWAP_ANCHOR_HOUR: int = 11
VWAP_ANCHOR_MINUTE: int = 0
VWAP_ANCHOR_TZ: str = "Europe/Helsinki"
ATR_PERIOD: int = 14

# Daily-chart SMA. 200 is the standard long-term trend filter; values
# only start ~200 bars in (we fetch 1Y ≈ 250 daily bars, so the line
# appears for roughly the most recent 50 trading days).
SMA200_PERIOD: int = 200

# Hints the frontend may consult for default styling.
EMA_COLOR: str = "#2563eb"     # blue
VWAP_COLOR: str = "#dc2626"    # red
SMA200_COLOR: str = "#dc2626"  # red (daily chart)
RELATR_COLOR: str = "#2563eb"  # blue (sub-pane 1)
RVOL_COLOR: str = "#a855f7"    # purple (sub-pane 2)


def build_indicators(
    timeframe: str,
    bars: Sequence[BarRowSchema],
    daily_bars: Optional[Sequence[BarRowSchema]] = None,
) -> list[IndicatorSeries]:
    """
    Compute the overlay set for a given timeframe.

    Per-timeframe overlays:

      daily
        * SMA200  on closes (red line, drawn on price pane)
      30min
        * (none yet)
      2min
        Pane 0 (price)
          * EMA9        on closes
          * Anchored VWAP (11:00 Helsinki anchor, resets daily)
        Pane 1 (sub-pane)
          * Relatr      = (VWAP − Close) / ATR14   (ATR from daily bars)
        Pane 2 (sub-pane)
          * Rvol        = cumVol / cumAvgVol       (anchored to the same
                                                    11:00 Helsinki session;
                                                    trade-day bars only)

    Add more branches here as we layer in more indicators (and route them
    to other timeframes).
    """
    if not bars:
        return []

    # ─── Daily chart: SMA200 only ─────────────────────────────────────────
    if timeframe == "daily":
        ind_bars = to_indicator_bars(bars)
        sma_vals = sma([b.close for b in ind_bars], SMA200_PERIOD)
        return [
            IndicatorSeries(
                name=f"sma{SMA200_PERIOD}",
                label=f"SMA {SMA200_PERIOD}",
                color=SMA200_COLOR,
                pane=0,
                series_type="line",
                points=[
                    IndicatorPoint(time=b.time, value=v)
                    for b, v in zip(ind_bars, sma_vals)
                ],
            )
        ]

    if timeframe != "2min":
        return []

    ind_bars = to_indicator_bars(bars)
    times = [b.time for b in ind_bars]
    closes = [b.close for b in ind_bars]

    # ─── Pane 0: EMA9 + anchored VWAP ─────────────────────────────────────
    ema_vals = ema(closes, EMA_PERIOD)
    vwap_vals = vwap_anchored(
        ind_bars,
        anchor_hour=VWAP_ANCHOR_HOUR,
        anchor_minute=VWAP_ANCHOR_MINUTE,
        tz_name=VWAP_ANCHOR_TZ,
    )

    series: list[IndicatorSeries] = [
        IndicatorSeries(
            name=f"ema{EMA_PERIOD}",
            label=f"EMA {EMA_PERIOD}",
            color=EMA_COLOR,
            pane=0,
            series_type="line",
            points=[
                IndicatorPoint(time=t, value=v) for t, v in zip(times, ema_vals)
            ],
        ),
        IndicatorSeries(
            name="vwap",
            label=(
                f"VWAP (anchor "
                f"{VWAP_ANCHOR_HOUR:02d}:{VWAP_ANCHOR_MINUTE:02d} "
                f"{VWAP_ANCHOR_TZ})"
            ),
            color=VWAP_COLOR,
            pane=0,
            series_type="line",
            points=[
                IndicatorPoint(time=t, value=v) for t, v in zip(times, vwap_vals)
            ],
        ),
    ]

    # ─── Pane 1: Relatr (needs daily ATR) ─────────────────────────────────
    atr_scalar = _last_atr_scalar(daily_bars)
    relatr_vals = (
        relatr(closes, vwap_vals, atr_scalar)
        if atr_scalar is not None
        else [None] * len(closes)
    )
    series.append(
        IndicatorSeries(
            name="relatr",
            label=f"Relatr (ATR{ATR_PERIOD}={atr_scalar:.4f})"
            if atr_scalar is not None
            else "Relatr (no daily ATR)",
            color=RELATR_COLOR,
            pane=1,
            series_type="line",
            points=[
                IndicatorPoint(time=t, value=v)
                for t, v in zip(times, relatr_vals)
            ],
        )
    )

    # ─── Pane 2: Rvol (5-prior-day baseline, trade-day only) ──────────────
    # Trade day = the session-anchor date of the LAST bar in our 2-min set
    # (e.g. 11:00 Helsinki anchor → trade-day session = calendar day of the
    # most recent bar, possibly its previous day if it's before 11:00).
    trade_day = _trade_day_session(ind_bars)
    if trade_day is not None:
        prior_bars = [
            b
            for b in ind_bars
            if _bar_session(b) != trade_day
        ]
        baseline = avg_volume_per_time_of_day(prior_bars, tz_name=VWAP_ANCHOR_TZ)
        rvol_vals = rvol(
            ind_bars,
            baseline=baseline,
            tz_name=VWAP_ANCHOR_TZ,
            anchor_hour=VWAP_ANCHOR_HOUR,
            anchor_minute=VWAP_ANCHOR_MINUTE,
            only_session_anchor=trade_day,
        )
    else:
        rvol_vals = [None] * len(ind_bars)

    series.append(
        IndicatorSeries(
            name="rvol",
            label="Rvol (cum vs 5-day baseline)",
            color=RVOL_COLOR,
            pane=2,
            series_type="histogram",
            points=[
                IndicatorPoint(time=t, value=v) for t, v in zip(times, rvol_vals)
            ],
        )
    )

    return series


# ─── helpers ─────────────────────────────────────────────────────────────────

def _last_atr_scalar(daily_bars: Optional[Sequence[BarRowSchema]]) -> Optional[float]:
    """Most recent non-None ATR value from the daily bar series, or None."""
    if not daily_bars:
        return None
    daily_ind = to_indicator_bars(daily_bars)
    atr_series = atr(daily_ind, period=ATR_PERIOD)
    for v in reversed(atr_series):
        if v is not None:
            return float(v)
    return None


def _bar_session(b) -> "object":
    """Session-anchor date of a single bar — wraps the private helper."""
    from calculations.indicators import _session_anchor_date
    from zoneinfo import ZoneInfo
    return _session_anchor_date(
        b.time, VWAP_ANCHOR_HOUR, VWAP_ANCHOR_MINUTE, ZoneInfo(VWAP_ANCHOR_TZ)
    )


def _trade_day_session(ind_bars) -> "object | None":
    """Session-anchor of the last bar (the bar most recent in time)."""
    if not ind_bars:
        return None
    return _bar_session(ind_bars[-1])
