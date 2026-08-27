from datetime import date as date_cls, datetime, timedelta
from typing import Optional, Sequence
from zoneinfo import ZoneInfo

import pandas as pd

from indicators.atr        import atr_series
from indicators.candle_row import CandleRow
from indicators.ema        import ema_series
from indicators.relatr     import next_relatr
from indicators.rvol       import avg_volume_model, rvol_series
from indicators.sma        import sma_series
from indicators.vwap       import vwap_series

from schemas.api_schemas import (
    BarRow as BarRowSchema,
    IndicatorPoint,
    IndicatorSeries,
)

from core.config import settings

# ─── Chart conventions ────────────────────────────────────────────────────────

EMA_PERIOD:         int = 9
VWAP_ANCHOR_HOUR:   int = 11
VWAP_ANCHOR_MINUTE: int = 0
VWAP_ANCHOR_TZ:     str = settings.TIMEZONE
ATR_PERIOD:         int = 14
SMA200_PERIOD:      int = 200

# Frontend-styling hints (frontend is free to ignore).
EMA_COLOR:    str = "#2563eb"   # blue
VWAP_COLOR:   str = "#dc2626"   # red
SMA200_COLOR: str = "#dc2626"   # red (daily chart)
RELATR_COLOR: str = "#2563eb"   # blue (sub-pane 1)
RVOL_COLOR:   str = "#a855f7"   # purple (sub-pane 2)


# ─── Adapters ────────────────────────────────────────────────────────────────

def _to_candle_rows(
    bars: Sequence[BarRowSchema], symbol: str,
) -> list[CandleRow]:
    """
    Adapt DB ``BarRow`` (pydantic, Decimal-typed, Helsinki-tz-aware
    ``time``) into the canonical ``CandleRow`` shape.

    Both timestamp shapes are filled:

      * ``ts``   -- the tz-aware datetime, verbatim, for the chart's
                    ``IndicatorPoint.time`` axis.
      * ``date`` + ``time`` -- Helsinki-local session date + time-of-day
                    so ``avg_volume_model`` groups on the same wall-clock
                    slot the chart's RVOL was built around.

    Indicator slots start ``None`` and get filled in place by the
    build below -- mirrors ``SymbolSessionState.apply_bar`` in 22/32.
    """
    tz = ZoneInfo(VWAP_ANCHOR_TZ)
    out: list[CandleRow] = []
    for b in bars:
        ts = b.time
        local = ts if ts.tzinfo is not None else ts.replace(tzinfo=tz)
        local = local.astimezone(tz)
        out.append(CandleRow(
            symbol = symbol,
            open   = float(b.open),
            high   = float(b.high),
            low    = float(b.low),
            close  = float(b.close),
            volume = float(b.volume),
            ts     = ts,
            date   = local.date(),
            time   = local.time(),
        ))
    return out


def _candle_df(candles: Sequence[CandleRow]) -> pd.DataFrame:
    """DataFrame shape the shared ``*_series`` functions expect.

    Default integer index (0..N-1) is aligned with the ``candles``
    list so we can write results back onto the CandleRow slots by
    position without an extra id column.
    """
    return pd.DataFrame({
        "symbol": [c.symbol for c in candles],
        "time":   [c.time   for c in candles],
        "open":   [c.open   for c in candles],
        "high":   [c.high   for c in candles],
        "low":    [c.low    for c in candles],
        "close":  [c.close  for c in candles],
        "volume": [c.volume for c in candles],
    })


def _session_anchor_date(
    ts: datetime,
    anchor_hour: int,
    anchor_minute: int,
    tz: ZoneInfo,
) -> date_cls:
    """
    Calendar date (in ``tz``) of the most recent session-anchor at or
    before ``ts``. Used to split bars into "prior-days baseline" vs
    "trade-day line".

    Kept local because 'which 24h session does this bar belong to' is
    chart-domain logic -- the anchor time and timezone are chart
    config, not general indicator math -- so it doesn't belong on the
    shared ``indicators`` package.
    """
    local = ts.astimezone(tz)
    if (local.hour, local.minute) >= (anchor_hour, anchor_minute):
        return local.date()
    return (local - timedelta(days=1)).date()


def _last_daily_atr(
    daily_bars: Optional[Sequence[BarRowSchema]],
) -> Optional[float]:
    """Most recent non-NaN daily ATR value, or ``None`` if unavailable."""
    if not daily_bars:
        return None
    high  = pd.Series([float(b.high)  for b in daily_bars])
    low   = pd.Series([float(b.low)   for b in daily_bars])
    close = pd.Series([float(b.close) for b in daily_bars])
    s = atr_series(high, low, close, span=ATR_PERIOD).dropna()
    if s.empty:
        return None
    return float(s.iloc[-1])


def _f(x) -> Optional[float]:
    """NaN / None -> None; anything else -> float()."""
    if x is None:
        return None
    try:
        if pd.isna(x):
            return None
    except (TypeError, ValueError):
        pass
    return float(x)


# ─── Public entrypoint ───────────────────────────────────────────────────────

def build_indicators(
    timeframe: str,
    bars: Sequence[BarRowSchema],
    daily_bars: Optional[Sequence[BarRowSchema]] = None,
    symbol: str = "",
) -> list[IndicatorSeries]:
    """Compute the overlay set for a given timeframe."""
    if not bars:
        return []

    candles = _to_candle_rows(bars, symbol)

    # ─── Daily chart: SMA200 only ─────────────────────────────────────────
    if timeframe == "daily":
        closes = pd.Series([c.close for c in candles])
        sma_vals = sma_series(closes, SMA200_PERIOD).tolist()
        return [
            IndicatorSeries(
                name=f"sma{SMA200_PERIOD}",
                label=f"SMA {SMA200_PERIOD}",
                color=SMA200_COLOR,
                pane=0,
                series_type="line",
                points=[
                    IndicatorPoint(time=c.ts, value=_f(v))
                    for c, v in zip(candles, sma_vals)
                ],
            )
        ]

    if timeframe != "2min":
        return []

    tz = ZoneInfo(VWAP_ANCHOR_TZ)
    df = _candle_df(candles)

    # ─── Pane 0: EMA9 -- runs over the whole 5-day slice (no reset).
    ema_vals = ema_series(df["close"], span=EMA_PERIOD).tolist()

    # ─── Pane 0: anchored VWAP -- reset per 11:00 Helsinki session by
    # slicing bars into sessions and calling the shared cumulative
    # vwap_series on each slice. Same math, chart-domain slicing.
    session_ids: list[date_cls] = [
        _session_anchor_date(c.ts, VWAP_ANCHOR_HOUR, VWAP_ANCHOR_MINUTE, tz)
        for c in candles
    ]
    df["_session"] = session_ids

    vwap_vals: list[Optional[float]] = [None] * len(candles)
    for _, g in df.groupby("_session", sort=False):
        v = vwap_series(g["open"], g["high"], g["low"], g["close"], g["volume"])
        for idx, val in zip(g.index, v.tolist()):
            vwap_vals[idx] = _f(val)

    # Fold results back onto the CandleRow slots -- same enriched-bar
    # shape 22 / 32 use downstream.
    for c, e, v in zip(candles, ema_vals, vwap_vals):
        c.ema9 = _f(e)
        c.vwap = v

    times = [c.ts for c in candles]
    series: list[IndicatorSeries] = [
        IndicatorSeries(
            name=f"ema{EMA_PERIOD}",
            label=f"EMA {EMA_PERIOD}",
            color=EMA_COLOR,
            pane=0,
            series_type="line",
            points=[
                IndicatorPoint(time=t, value=c.ema9)
                for t, c in zip(times, candles)
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
                IndicatorPoint(time=t, value=c.vwap)
                for t, c in zip(times, candles)
            ],
        ),
    ]

    # ─── Pane 1: Relatr -- (VWAP - Close) / daily ATR.
    atr_scalar = _last_daily_atr(daily_bars)
    if atr_scalar is not None and atr_scalar > 0:
        for c in candles:
            if c.vwap is not None:
                c.relatr = next_relatr(c.vwap, c.close, atr_scalar)

    series.append(
        IndicatorSeries(
            name="relatr",
            label=(
                f"Relatr (ATR{ATR_PERIOD}={atr_scalar:.4f})"
                if atr_scalar is not None
                else "Relatr (no daily ATR)"
            ),
            color=RELATR_COLOR,
            pane=1,
            series_type="line",
            points=[
                IndicatorPoint(time=t, value=c.relatr)
                for t, c in zip(times, candles)
            ],
        )
    )

    # ─── Pane 2: RVOL -- 5-prior-day baseline, trade-day line only.
    trade_day = session_ids[-1] if session_ids else None
    if trade_day is not None:
        prior_mask = df["_session"] != trade_day
        trade_mask = df["_session"] == trade_day
        prior_df = df.loc[prior_mask, ["symbol", "time", "volume"]]
        trade_df = df.loc[
            trade_mask,
            ["symbol", "time", "open", "high", "low", "close", "volume"],
        ].reset_index(drop=True)
        trade_positions = [i for i, m in enumerate(trade_mask.tolist()) if m]

        if not trade_df.empty:
            # k=None matches the chart's historical behaviour (no
            # per-slot winsorization on the baseline). Every other
            # project seeds ``rvol_baseline`` via the same call.
            baseline = avg_volume_model(prior_df, k=None)
            rvol_df = rvol_series(trade_df, baseline)
            for pos, val in zip(trade_positions, rvol_df["rvol"].tolist()):
                candles[pos].rvol = _f(val)

    series.append(
        IndicatorSeries(
            name="rvol",
            label="Rvol (cum vs 5-day baseline)",
            color=RVOL_COLOR,
            pane=2,
            series_type="histogram",
            points=[
                IndicatorPoint(time=t, value=c.rvol)
                for t, c in zip(times, candles)
            ],
        )
    )

    return series
