"""
Cross-cutting helpers (formatters, small pure functions, constants).
Anything that doesn't belong in services/ because it's not domain logic.
"""

import re


# IB cash-FX conversion legs come across as "XXX.YYY" where both sides
# are 3-letter ISO currency codes (EUR.USD, USD.JPY, GBP.EUR, ...).
# These aren't trades — they're the broker auto-converting cash balances
# between denominations — so we exclude them everywhere trades are
# generated or fetched from IB. Match against the already-normalised
# (uppercased, trimmed) symbol.
_CURRENCY_PAIR_RE = re.compile(r"^[A-Z]{3}\.[A-Z]{3}$")


def is_currency_conversion(symbol: str) -> bool:
    """True if `symbol` looks like an IB cash-FX conversion leg (XXX.YYY)."""
    if not symbol:
        return False
    return bool(_CURRENCY_PAIR_RE.match(symbol.strip().upper()))


# Regex source-of-truth for SQL callers that need the same filter
# server-side. Postgres POSIX regex — use with `symbol !~ CURRENCY_PAIR_SQL_RE`.
CURRENCY_PAIR_SQL_RE = r'^[A-Z]{3}\.[A-Z]{3}$'


def normalize_symbol(value: str) -> str:
    """
    Canonicalise a ticker-like string for storage / IB lookup.

    Steps:
      1. Trim surrounding whitespace.
      2. Drop the IB CFD-contract trailing-'n' marker (lowercase) — IB
         appends 'n' to the underlying symbol when an execution comes
         from a CFD contract (e.g. "CARn", "IBITn", "QQQn"). The
         underlying ticker is what TWS / reqHistoricalData expects, so
         we strip that suffix here. We only strip a single LOWERCASE
         'n' so we never clip real tickers that legitimately end in
         uppercase N (e.g. AMZN, GRPN).
      3. Uppercase the result so symbols are case-stable across sources.

    Pure function — safe to call repeatedly (idempotent).
    """
    s = value.strip()
    if len(s) > 1 and s.endswith("n"):
        s = s[:-1]
    return s.upper()
