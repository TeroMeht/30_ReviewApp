"""
Cross-cutting helpers (formatters, small pure functions, constants).
Anything that doesn't belong in services/ because it's not domain logic.
"""


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
