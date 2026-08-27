"""
Project-side wrapper around ``data_sources.ib`` Flex utilities.

The transport (submit -> poll), the XML -> ``Execution`` parse, and
the ET -> UTC timezone handling all live under
``data_sources.ib._flex_client`` / ``_flex_parser`` -- shared with any
future project that reads Flex reports. This file keeps the two
30_ReviewApp-specific concerns that don't belong in the common
package:

  * Normalize the raw IB ticker via ``helpers.example.normalize_symbol``
    (project-specific taxonomy -- CFD suffixes, exchange qualifiers)
    and drop currency-conversion legs (``EUR.USD`` etc.) with
    ``helpers.example.is_currency_conversion``. Trade auto-bucketing
    joins on ``executions.symbol``, so any cleanup HAS to happen
    before rows reach the DB or the JOIN loses CFD-derived rows.

  * Adapt the canonical ``data_sources.ib.Execution`` dataclass (frozen
    dataclass, provider shape) into the project's pydantic
    ``schemas.api_schemas.Execution`` shape (used as a FastAPI
    ``response_model`` and stamped with an in-flight ``db_status`` by
    ``db.executions.insert_executions``).
"""
from __future__ import annotations

import logging

from data_sources.ib._execution   import Execution as SourceExecution
from data_sources.ib._flex_client import fetch_flex_report
from data_sources.ib._flex_parser import parse_executions

from core.config import settings
from helpers.example import normalize_symbol, is_currency_conversion
from schemas.api_schemas import Execution


logger = logging.getLogger(__name__)


# Chosen to match the previous project-local value; every knob else
# lives on the common client. Raise at the call site if a very long
# window ever needs more than 60s.
_DEFAULT_POLL_TIMEOUT_SEC: float = 60.0


def _adapt(src: SourceExecution, *, symbol: str) -> Execution:
    """``data_sources.ib.Execution`` (dataclass) -> project's pydantic
    ``Execution``. ``symbol`` is passed in already-normalized so the
    caller can filter and adapt in one loop."""
    return Execution(
        dateTime     = src.dateTime,
        symbol       = symbol,
        tradeID      = src.tradeID,
        buySell      = src.buySell,
        quantity     = src.quantity,
        tradePrice   = src.tradePrice,
        ibOrderID    = src.ibOrderID,
        ibCommission = src.ibCommission,
    )


async def fetch_executions_from_ib(
    *,
    poll_timeout_sec: float = _DEFAULT_POLL_TIMEOUT_SEC,
) -> list[Execution]:
    """Submit -> poll -> parse -> project-side filter + adapt."""
    body = await fetch_flex_report(
        settings.IB_FLEX_TOKEN,
        settings.IB_FLEX_QUERY_ID,
        submit_url      = settings.IB_FLEX_SUBMIT_URL,
        download_url    = settings.IB_FLEX_DOWNLOAD_URL,
        poll_timeout_sec= poll_timeout_sec,
    )

    raw = parse_executions(body)

    kept: list[Execution] = []
    skipped_fx = 0
    for src in raw:
        symbol = normalize_symbol(src.symbol)
        if is_currency_conversion(symbol):
            skipped_fx += 1
            continue
        kept.append(_adapt(src, symbol=symbol))

    logger.info(
        "Flex fetch: %d executions kept, %d FX conversion rows skipped",
        len(kept),
        skipped_fx,
    )
    return kept
