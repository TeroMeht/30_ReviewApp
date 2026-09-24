"""
Speed-of-move indicator anchored on the last EMA9 cross.

Concept
-------
The slope of EMA9 is our speedometer for the move: it measures how fast
price is being pulled away from its short-term mean. The anchor is the
first 2-min bar whose close crosses BELOW EMA9 coming from above (long /
capitulation direction). An intervening close-crosses-ABOVE-EMA9 clears
the anchor.

For every 2-min bar with an active anchor:

    speed_pct_per_bar = (C_anchor - C_now) / C_anchor / bars * 100

Positive values mean price is moving away from the anchor in the setup's
direction (down for longs, up for shorts). Bars with no active anchor
return None so the chart / CSV shows an empty cell there.

Interpretation bands (2-min bars, calibrated on real capitulation trades)
    < 0.20  -> grind, skip the trade
    0.20-0.40  -> real decline, insufficient alone
    >= 0.40 (with bars >= 5)  -> capitulation zone

Pure module. No I/O, no framework dependencies.
"""

from __future__ import annotations

from datetime import datetime
from typing import Mapping, Optional


DEFAULT_RELATR_THRESHOLD = 0.40


def compute_speed_series(
    bars: list,
    ema9_by_time: Mapping[datetime, Optional[float]],
    direction: str = "long",
) -> dict[datetime, Optional[float]]:
    """Return {bar.time: speed_pct_per_bar} for every 2-min bar.

    Bars with no active anchor (before the first cross-down, or after a
    clearing up-cross) get None. The mapping covers every bar so callers
    can index by time without a KeyError.

    Parameters
    ----------
    bars : ordered list of BarRow-shaped objects (fields: time, close).
        Must be time-ascending.
    ema9_by_time : mapping bar.time -> ema9 value (or None where missing).
    direction : 'long' -> anchor on close-crosses-BELOW-EMA9 (capitulation).
                'short' -> anchor on close-crosses-ABOVE-EMA9 (blow-off).
    """
    if direction not in ("long", "short"):
        raise ValueError("direction must be 'long' or 'short'")

    out: dict[datetime, Optional[float]] = {}
    if not bars:
        return out

    sign = 1 if direction == "long" else -1
    anchor_idx: Optional[int] = None

    prev_close: Optional[float] = None
    prev_ema9: Optional[float] = None

    for i, b in enumerate(bars):
        close = float(b.close)
        ema9 = ema9_by_time.get(b.time)
        ema9_f = float(ema9) if ema9 is not None else None

        # Detect cross events off the previous bar's (close, ema9)
        if prev_close is not None and prev_ema9 is not None and ema9_f is not None:
            if direction == "long":
                is_down = prev_close >= prev_ema9 and close < ema9_f
                is_up   = prev_close <= prev_ema9 and close > ema9_f
            else:  # short
                is_down = prev_close <= prev_ema9 and close > ema9_f
                is_up   = prev_close >= prev_ema9 and close < ema9_f
            if is_down:
                anchor_idx = i
            elif is_up:
                anchor_idx = None

        # Compute running speed if an anchor is active
        if anchor_idx is not None and anchor_idx != i:
            C_anchor = float(bars[anchor_idx].close)
            bars_since = i - anchor_idx
            if bars_since > 0 and C_anchor != 0:
                delta = sign * (C_anchor - close)
                out[b.time] = (delta / C_anchor / bars_since) * 100.0
            else:
                out[b.time] = None
        else:
            out[b.time] = None

        prev_close = close
        prev_ema9 = ema9_f

    return out
