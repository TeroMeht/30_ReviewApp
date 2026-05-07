"""
Cross-cutting helpers (formatters, small pure functions, constants).
Anything that doesn't belong in services/ because it's not domain logic.
"""


def normalize_symbol(value: str) -> str:
    """Trim and uppercase a ticker-like string."""
    return value.strip().upper()
