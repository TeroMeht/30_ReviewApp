"""
Indicator primitives.

Each function returns a list aligned 1:1 with its input — `None` is used
for warm-up bars or bars where the indicator isn't defined yet. This
shape is what the frontend chart wants (one indicator point per candle)
and is also what a backtester wants (so it can ask "what was EMA9 at bar
i?" without recomputing).

Currently exported:
  * `ema(values, period)`              — SMA-seeded exponential moving avg
  * `ewm(values, span)`                — pandas-style recursive EMA
                                         (ewm(span, adjust=False).mean())
  * `vwap_anchored(bars, ...)`         — session-anchored volume-weighted
                                         average price (anchored to a wall
                                         clock time in a given timezone)
  * `true_ranges(bars)`                — Wilder's TR, with first-row fallback
  * `atr(bars, period=14)`             — ATR via ewm() of true_ranges
  * `relatr(closes, vwaps, atr_value)` — (VWAP - Close) / ATR
  * `avg_volume_per_time_of_day(...)`  — {(h, m): avg_volume} baseline
  * `rvol(bars, baseline, tz, ...)`    — anchored-session cumulative Rvol
"""

from datetime import datetime, timedelta, date as date_cls
from typing import Sequence
from zoneinfo import ZoneInfo

from .bars import IndicatorBar


# ─── EMA (SMA-seeded) ─────────────────────────────────────────────────────────

def ema(values: Sequence[float | None], period: int) -> list[float | None]:
    """
    Exponential moving average of `values`.

    Seeding rule: the first `period` values are required to compute the
    initial SMA seed. Output is None for indices [0 .. period-2]; index
    `period-1` is the simple mean of values[0:period], and subsequent
    indices apply the standard EMA recurrence:

        multiplier = 2 / (period + 1)
        EMA[i]     = close[i] * multiplier + EMA[i-1] * (1 - multiplier)

    None entries reset the seed window so the function is robust over
    sparse / hole-y series (rare in our chart data, common in backtest).
    """
    if period < 1:
        raise ValueError(f"ema period must be >= 1, got {period}")

    out: list[float | None] = [None] * len(values)
    multiplier = 2.0 / (period + 1)

    prev_ema: float | None = None
    seed_window: list[float] = []

    for i, v in enumerate(values):
        if v is None:
            prev_ema = None
            seed_window = []
            continue

        if prev_ema is None:
            seed_window.append(v)
            if len(seed_window) == period:
                prev_ema = sum(seed_window) / period
                out[i] = prev_ema
        else:
            prev_ema = v * multiplier + prev_ema * (1 - multiplier)
            out[i] = prev_ema

    return out


# ─── Anchored VWAP ────────────────────────────────────────────────────────────

def vwap_anchored(
    bars: Sequence[IndicatorBar],
    anchor_hour: int,
    anchor_minute: int,
    tz_name: str,
) -> list[float | None]:
    """
    Session-anchored VWAP.

    A "session" begins each calendar day at `anchor_hour:anchor_minute` in
    the timezone `tz_name`. The session for a given bar is determined by
    that bar's wall-clock time in `tz_name`:

        if local(bar.time) >= today's anchor → session = today
        else                                 → session = yesterday

    VWAP within a session is cumulative typical-price (H+L+C)/3 weighted
    by volume:

        vwap = sum(tp_i * v_i) / sum(v_i)

    Returns a list aligned 1:1 with `bars`. None at the start of a
    session until non-zero volume accumulates. Raises if any bar
    timestamp is naive — tz info is required to anchor correctly.
    """
    if not (0 <= anchor_hour < 24 and 0 <= anchor_minute < 60):
        raise ValueError(
            f"Invalid anchor time: {anchor_hour:02d}:{anchor_minute:02d}"
        )

    tz = ZoneInfo(tz_name)
    out: list[float | None] = [None] * len(bars)

    current_session: date_cls | None = None
    cum_pv = 0.0
    cum_v = 0.0

    for i, b in enumerate(bars):
        if b.time.tzinfo is None:
            raise ValueError(
                "vwap_anchored requires tz-aware bar timestamps; "
                f"got naive datetime at index {i}: {b.time!r}"
            )

        session = _session_anchor_date(b.time, anchor_hour, anchor_minute, tz)
        if session != current_session:
            current_session = session
            cum_pv = 0.0
            cum_v = 0.0

        v = b.volume
        if v > 0:
            cum_pv += b.typical_price * v
            cum_v += v

        out[i] = (cum_pv / cum_v) if cum_v > 0 else None

    return out


def _session_anchor_date(
    t: datetime,
    anchor_hour: int,
    anchor_minute: int,
    tz: ZoneInfo,
) -> date_cls:
    """
    Calendar date (in `tz`) of the most recent session-anchor that has
    occurred at or before `t`.

    Example with anchor 11:00 Helsinki:
      - bar at 2025-05-12 16:30 Helsinki → session 2025-05-12
      - bar at 2025-05-12 09:15 Helsinki → session 2025-05-11
        (the 11:00 anchor for the 12th hasn't happened yet)
    """
    local = t.astimezone(tz)
    if (local.hour, local.minute) >= (anchor_hour, anchor_minute):
        return local.date()
    return (local - timedelta(days=1)).date()


# ─── Recursive EWM (pandas-style ewm(span, adjust=False)) ─────────────────────

def ewm(values: Sequence[float | None], span: int) -> list[float | None]:
    """
    Recursive exponential moving average — equivalent to pandas:

        series.ewm(span=span, adjust=False).mean()

    Unlike `ema()` (which seeds with an SMA over the first `period`
    values), this seeds with the FIRST value itself and applies the
    recurrence from there:

        alpha = 2 / (span + 1)
        y[0]  = x[0]
        y[i]  = alpha * x[i] + (1 - alpha) * y[i-1]

    Used by `atr()` so the ATR series exactly matches the user's pandas
    reference implementation. None entries reset the recurrence.
    """
    if span < 1:
        raise ValueError(f"ewm span must be >= 1, got {span}")

    out: list[float | None] = [None] * len(values)
    alpha = 2.0 / (span + 1)
    prev: float | None = None

    for i, v in enumerate(values):
        if v is None:
            prev = None
            continue
        if prev is None:
            prev = v
        else:
            prev = alpha * v + (1 - alpha) * prev
        out[i] = prev

    return out


# ─── True Range / ATR ─────────────────────────────────────────────────────────

def true_ranges(bars: Sequence[IndicatorBar]) -> list[float]:
    """
    Wilder's True Range, aligned to bars.

    For each bar:
        TR[i] = max(H - L, |H - prev_close|, |L - prev_close|)

    First row has no previous close, so the |H - PC| and |L - PC|
    components collapse to 0 and the max reduces to (H - L). Matches the
    `.fillna(High / Low)` trick in the user's pandas spec exactly.

    Returns plain `float` (never None) so the result feeds straight into
    `ewm()` / `ema()` for ATR.
    """
    out: list[float] = []
    prev_close: float | None = None
    for b in bars:
        hl = b.high - b.low
        if prev_close is None:
            tr = hl
        else:
            tr = max(hl, abs(b.high - prev_close), abs(b.low - prev_close))
        out.append(tr)
        prev_close = b.close
    return out


def atr(bars: Sequence[IndicatorBar], period: int = 14) -> list[float | None]:
    """
    Average True Range, exponentially smoothed with pandas
    `ewm(span=period, adjust=False).mean()` semantics (alpha = 2/(P+1)).

    Aligned 1:1 with `bars`. First value equals TR[0] (= H-L of the first
    row); subsequent values follow the recurrence in `ewm()`. For the
    chart we typically use only the LAST value (= ATR as of the trade
    day) and feed it as a scalar into `relatr()`.
    """
    return ewm(true_ranges(bars), span=period)


# ─── Relatr ──────────────────────────────────────────────────────────────────

def relatr(
    closes: Sequence[float | None],
    vwaps: Sequence[float | None],
    atr_value: float | None,
) -> list[float | None]:
    """
    Relatr per bar = (VWAP - Close) / ATR.

    Sign convention (matches the user's pandas spec):
      * positive ⇒ price is BELOW VWAP by some multiple of daily ATR
      * negative ⇒ price is ABOVE VWAP

    Magnitudes are roughly comparable across symbols because we've
    normalised by each symbol's own daily volatility.

    `atr_value` is a single scalar — the daily ATR as of the trade day,
    pre-computed via `atr()` on the daily bars. None where inputs aren't
    defined (warmup VWAP, missing close, or ATR ≤ 0 / None).
    """
    if len(closes) != len(vwaps):
        raise ValueError(
            f"relatr requires equal-length closes ({len(closes)}) "
            f"and vwaps ({len(vwaps)})"
        )
    if not atr_value or atr_value <= 0:
        return [None] * len(closes)

    out: list[float | None] = []
    for c, v in zip(closes, vwaps):
        if c is None or v is None:
            out.append(None)
        else:
            out.append((v - c) / atr_value)
    return out


# ─── Rvol (relative volume vs intraday baseline) ──────────────────────────────

def avg_volume_per_time_of_day(
    bars: Sequence[IndicatorBar],
    tz_name: str,
) -> dict[tuple[int, int], float]:
    """
    Average volume per HH:MM-in-`tz` bucket across the supplied bars.

    Matches the user's pandas:
        all_data.groupby(['Symbol', 'Time'])['Volume'].mean()

    minus the Symbol dimension (per-trade chart endpoint already filters
    to one symbol). Empty buckets are absent from the result — callers
    should treat missing keys as "no baseline" and contribute 0.

    Caller restricts `bars` to the baseline set (e.g. "everything before
    the trade day's session"). This function doesn't know which bars are
    "trade day" and which are "prior".
    """
    if not bars:
        return {}

    tz = ZoneInfo(tz_name)
    sums: dict[tuple[int, int], float] = {}
    counts: dict[tuple[int, int], int] = {}

    for b in bars:
        if b.time.tzinfo is None:
            raise ValueError(
                "avg_volume_per_time_of_day requires tz-aware timestamps"
            )
        local = b.time.astimezone(tz)
        key = (local.hour, local.minute)
        sums[key] = sums.get(key, 0.0) + b.volume
        counts[key] = counts.get(key, 0) + 1

    return {k: sums[k] / counts[k] for k in sums}


def rvol(
    bars: Sequence[IndicatorBar],
    baseline: dict[tuple[int, int], float],
    tz_name: str,
    anchor_hour: int,
    anchor_minute: int,
    only_session_anchor: date_cls | None = None,
) -> list[float | None]:
    """
    Relative-volume series, anchored to the same wall-clock session as
    the chart's VWAP (default 11:00 Helsinki).

    Semantics:
      * Each bar's session-anchor date is computed via
        `_session_anchor_date`. Cumulative sums reset whenever that
        date changes.
      * Within a session:
            cumVol    += bar.volume
            cumAvgVol += baseline[(local.hour, local.minute)]
            rvol[i]    = cumVol / cumAvgVol
      * Missing baseline buckets contribute 0 (the cumulative average
        just doesn't grow for that bar).
      * `only_session_anchor`: if set, ONLY emit values on bars whose
        session matches this date. Used to confine the chart's Rvol line
        to the trade day — prior-day bars are the baseline source, so
        computing Rvol against themselves would be circular.
    """
    tz = ZoneInfo(tz_name)
    out: list[float | None] = [None] * len(bars)

    current_session: date_cls | None = None
    cum_vol = 0.0
    cum_avg = 0.0

    for i, b in enumerate(bars):
        if b.time.tzinfo is None:
            raise ValueError(
                "rvol requires tz-aware timestamps; "
                f"got naive datetime at index {i}: {b.time!r}"
            )

        session = _session_anchor_date(b.time, anchor_hour, anchor_minute, tz)
        if session != current_session:
            current_session = session
            cum_vol = 0.0
            cum_avg = 0.0

        local = b.time.astimezone(tz)
        cum_vol += b.volume
        cum_avg += baseline.get((local.hour, local.minute), 0.0)

        if only_session_anchor is not None and session != only_session_anchor:
            continue

        out[i] = (cum_vol / cum_avg) if cum_avg > 0 else None

    return out
