"""
Shared bar dataclass for the calculations layer.

The DB layer returns `schemas.api_schemas.BarRow` (pydantic, Decimal-typed)
and the IB layer hands us `BarRow` NamedTuples — both are fine, but the
calculation functions want plain floats + a tz-aware datetime so the math
is dependency-free.

`IndicatorBar` is the lowest-common-denominator: one immutable dataclass
that the calculation functions accept. Callers convert once at the
boundary via `to_indicator_bars(...)`.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Iterable


@dataclass(frozen=True, slots=True)
class IndicatorBar:
    """One OHLCV bar in float form, with a tz-aware timestamp."""
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def typical_price(self) -> float:
        """Standard VWAP / pivot input: (H + L + C) / 3."""
        return (self.high + self.low + self.close) / 3.0


def to_indicator_bars(rows: Iterable) -> list[IndicatorBar]:
    """
    Coerce anything that quacks like an OHLCV row into IndicatorBar.

    Accepts:
      * `schemas.api_schemas.BarRow` (pydantic with Decimals)
      * `db.trade_bars.BarRow` NamedTuple
      * Any object with .time/.open/.high/.low/.close/.volume attributes
      * dicts with the same keys

    All numeric fields are pushed through `float(...)` so Decimal,
    Numeric-from-asyncpg, int, etc. all normalise the same way.
    """
    out: list[IndicatorBar] = []
    for r in rows:
        if isinstance(r, dict):
            t = r["time"]
            o, h, l, c, v = r["open"], r["high"], r["low"], r["close"], r["volume"]
        else:
            t = r.time
            o, h, l, c, v = r.open, r.high, r.low, r.close, r.volume
        out.append(
            IndicatorBar(
                time=t,
                open=_to_float(o),
                high=_to_float(h),
                low=_to_float(l),
                close=_to_float(c),
                volume=_to_float(v),
            )
        )
    return out


def _to_float(x) -> float:
    """Decimal / int / float / str → float."""
    if isinstance(x, float):
        return x
    if isinstance(x, Decimal):
        return float(x)
    return float(x)
