"""
IBKR Flex Web Service client.

The Flex Web Service is a separate IB endpoint (NOT part of the TWS API)
that returns arbitrarily-historical statements for any date range. Unlike
the email parser this gives us:
  * the broker's authoritative fill timestamp (down to the second)
  * a unique per-fill execId that survives across emails and re-imports
  * fills more than a few days old

Two-step request flow:
  1. POST /SendRequest?t=<token>&q=<queryId>&v=3   →  ReferenceCode
  2. GET  /GetStatement?t=<token>&q=<refCode>&v=3  →  XML statement
     (often returns "Statement generation in progress" first; we poll
     until the actual XML report comes back, with a timeout.)

The XML schema depends on the Flex Query's configuration. We look for
<Trade> rows under <Trades>; field names that we expect are listed in
``_REQUIRED_TRADE_FIELDS`` below. Edit the Flex Query in IB Account
Management if any are missing.
"""

from __future__ import annotations

import asyncio
import logging
import xml.etree.ElementTree as ET
from datetime import  datetime
from decimal import Decimal
from typing import Optional
from zoneinfo import ZoneInfo

# IB Flex `dateTime` attributes are wall-clock US/Eastern (EST in winter,
# EDT in summer) with no offset information in the string. We localize to
# America/New_York so DST is handled automatically, then convert to UTC so
# the value stored in TIMESTAMPTZ is unambiguous regardless of the DB
# session's timezone (otherwise asyncpg interprets a naive datetime in the
# server's local zone — e.g. Helsinki — and the offset ends up wrong).
_IB_TZ = ZoneInfo("America/New_York")
_UTC = ZoneInfo("UTC")

import httpx

from core.config import settings
from schemas.api_schemas import Execution

logger = logging.getLogger(__name__)


# Public Flex Web Service v3 endpoints. These don't change.
_FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
_FLEX_SUBMIT = f"{_FLEX_BASE}/SendRequest"
_FLEX_DOWNLOAD = f"{_FLEX_BASE}/GetStatement"

# How long we wait for a generated report. IB usually completes simple
# trade queries in < 5 s, but allow plenty of headroom for big windows.
_DEFAULT_POLL_TIMEOUT_SEC = 60.0
_POLL_INTERVAL_SEC = 2.0




# ─── Low-level HTTP ───────────────────────────────────────────────────────────


async def _submit_flex_request(client: httpx.AsyncClient,token: str,query_id: str) -> str:
    """Submit a Flex Query run, return the IB-issued ReferenceCode."""
    params = {"t": token, "q": query_id, "v": "3"}
    resp = await client.get(_FLEX_SUBMIT, params=params, timeout=30.0)
    resp.raise_for_status()
    root = ET.fromstring(resp.text)

    status = (root.findtext("Status") or "").strip()
    if status != "Success":
        # Error responses look like:
        #   <FlexStatementResponse><Status>Fail</Status>
        #     <ErrorCode>1009</ErrorCode><ErrorMessage>...</ErrorMessage></FlexStatementResponse>
        err_code = (root.findtext("ErrorCode") or "").strip()
        err_msg = (root.findtext("ErrorMessage") or "unknown error").strip()
        raise RuntimeError(f"Flex SendRequest failed [{err_code}]: {err_msg}")

    ref = (root.findtext("ReferenceCode") or "").strip()
    if not ref:
        raise RuntimeError("Flex SendRequest returned no ReferenceCode")
    logger.info("Flex SendRequest OK, reference=%s", ref)
    return ref


async def _download_flex_report(client: httpx.AsyncClient,token: str,reference_code: str,*,timeout_sec: float = _DEFAULT_POLL_TIMEOUT_SEC) -> str:
    """
    Poll GetStatement until IB produces the report. Returns the raw XML body.

    IB's first response after submission is usually:
        <FlexStatementResponse><Status>Warn</Status>
          <ErrorCode>1019</ErrorCode>
          <ErrorMessage>Statement generation in progress.</ErrorMessage>
        </FlexStatementResponse>
    so we keep polling until either:
      * we get a real <FlexQueryResponse> body, or
      * we exceed timeout_sec.
    """
    params = {"t": token, "q": reference_code, "v": "3"}
    deadline = asyncio.get_event_loop().time() + timeout_sec
    while True:
        resp = await client.get(_FLEX_DOWNLOAD, params=params, timeout=30.0)
        resp.raise_for_status()
        body = resp.text
         # debugging: log the raw response so we can diagnose parsing issues in the wild

        # The "still generating" response uses the FlexStatementResponse root;
        # the real report uses FlexQueryResponse. Sniff the first XML tag.
        if "<FlexQueryResponse" in body:
            logger.info("Flex GetStatement: report ready (%d bytes)", len(body))
            return body

        # Likely warn/in-progress. Parse to confirm and possibly bail on real errors.
        try:
            root = ET.fromstring(body)
            status = (root.findtext("Status") or "").strip()
            err_code = (root.findtext("ErrorCode") or "").strip()
            err_msg = (root.findtext("ErrorMessage") or "").strip()
        except ET.ParseError:
            status, err_code, err_msg = "Unknown", "", body[:200]

        if status == "Fail":
            raise RuntimeError(f"Flex GetStatement failed [{err_code}]: {err_msg}")

        if asyncio.get_event_loop().time() >= deadline:
            raise TimeoutError(
                f"Flex report not ready after {timeout_sec:.0f}s "
                f"(last status={status!r}, code={err_code!r}, msg={err_msg!r})"
            )

        logger.debug(
            "Flex GetStatement still generating (status=%s, code=%s) — sleeping %.1fs",
            status, err_code, _POLL_INTERVAL_SEC,
        )
        await asyncio.sleep(_POLL_INTERVAL_SEC)


# ─── Parsing ──────────────────────────────────────────────────────────────────


# Helper to get XML attribute safely
def _row_get(elem: ET.Element, attr: str) -> Optional[str]:
    return elem.attrib.get(attr)

# Helper to parse dateTime from Flex XML (format: YYYYMMDD;HHMMSS).
# IB reports wall-clock time in US/Eastern; we attach that tz (DST-aware)
# and convert to UTC so the resulting datetime is unambiguous.
def _parse_flex_datetime(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        naive = datetime.strptime(value, "%Y%m%d;%H%M%S")
    except ValueError:
        return None
    return naive.replace(tzinfo=_IB_TZ).astimezone(_UTC)

# Helper to normalize buy/sell actions
def _action_for_buy_sell(value: str) -> str:
    return value.upper() if value else ""

def parse_flex_executions(xml_body: str) -> list[Execution]:
    """
    Walk the Flex XML and return ExecutionFromXML rows.
    Does not skip any trades; missing numeric fields are set to zero,
    missing strings are set to empty strings, missing dateTime is None.
    """
    try:
        root = ET.fromstring(xml_body)
    except ET.ParseError as e:
        raise RuntimeError(f"Flex report is not valid XML: {e}") from e

    out: list[Execution] = []

    # Parse all <Trade> elements anywhere in XML
    for trade_elem in root.iter("Trade"):
        dateTime_str = _row_get(trade_elem, "dateTime") or ""
        ts = _parse_flex_datetime(dateTime_str)

        # Convert numerics safely
        try:
            quantity = int(float(_row_get(trade_elem, "quantity") or 0))
        except (TypeError, ValueError):
            quantity = 0

        try:
            tradePrice = Decimal(str(_row_get(trade_elem, "tradePrice") or 0))
        except (TypeError, ValueError):
            tradePrice = Decimal(0)

        try:
            ibCommission = Decimal(str(_row_get(trade_elem, "ibCommission") or 0))
        except (TypeError, ValueError):
            ibCommission = Decimal(0)

        out.append(
            Execution(
                dateTime=ts,
                symbol=(_row_get(trade_elem, "symbol") or "").strip(),
                tradeID=(_row_get(trade_elem, "tradeID") or "").strip(),
                buySell=_action_for_buy_sell(_row_get(trade_elem, "buySell")),
                quantity=quantity,
                tradePrice=tradePrice,
                ibOrderID=(_row_get(trade_elem, "ibOrderID") or "").strip(),
                ibCommission=ibCommission,
            )
        )

    logger.info("Parsed %d trades from XML", len(out))
    return out


# ─── Orchestrator ─────────────────────────────────────────────────────────────


async def fetch_executions_from_ib(*,poll_timeout_sec: float = _DEFAULT_POLL_TIMEOUT_SEC) -> list[Execution]:
    
    """End-to-end: submit → poll → parse. Date-filtered to [start, end]."""
    if not settings.IB_FLEX_TOKEN or not settings.IB_FLEX_QUERY_ID:
        raise RuntimeError(
            "IB Flex is not configured. Set IB_FLEX_TOKEN and IB_FLEX_QUERY_ID "
            "in your .env (see core/config.py for details)."
        )

    async with httpx.AsyncClient(http2=False) as client:
        ref = await _submit_flex_request(client, settings.IB_FLEX_TOKEN, settings.IB_FLEX_QUERY_ID)
        body = await _download_flex_report(client, settings.IB_FLEX_TOKEN, ref, timeout_sec=poll_timeout_sec)
        print(body)
    return parse_flex_executions(body)
