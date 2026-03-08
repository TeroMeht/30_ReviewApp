import msal
import requests
import re
from datetime import datetime
from typing import Optional,Dict

from core.config import settings
from zoneinfo import ZoneInfo
from db.executions import insert_executions
from schemas.api_schemas import ExecutionEmail

import logging
logger = logging.getLogger(__name__)






# ─── Auth ─────────────────────────────────────────────────────────────────────

async def get_access_token() -> str:
    """Acquire Microsoft Graph access token interactively."""
    msal_app = msal.PublicClientApplication(settings.CLIENT_ID, authority=settings.AUTHORITY)
    # Fall back to interactive login
    result = msal_app.acquire_token_interactive(scopes=settings.SCOPES)
    if "access_token" not in result:
        raise Exception(f"Login failed: {result.get('error_description')}")
    return result["access_token"]


# ─── Email Fetching ───────────────────────────────────────────────────────────

async def fetch_all_emails(access_token: str) -> list:
    """Fetch all emails from Microsoft Graph API with pagination."""
    headers = {"Authorization": f"Bearer {access_token}"}
    all_emails = []
    url = (
        "https://graph.microsoft.com/v1.0/me/messages"
        "?$top=1000"
        "&$orderby=receivedDateTime desc"
        "&$select=subject,from,receivedDateTime,isRead,bodyPreview"
    )
    while url:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        all_emails.extend(data.get("value", []))
        url = data.get("@odata.nextLink")

    return all_emails


# ─── Parsing & Filtering ──────────────────────────────────────────────────────

def parse_execution_subject(subject: str) -> str:
    pattern = r"(BOUGHT|SOLD)\s+([\d,]+)\s+([A-Z\.]+)(?:\s+[A-Z0-9]+)?\s+@\s+([\d\.]+)"

    match = re.search(pattern, subject)

    if not match:
        return None

    action, size, symbol, price = match.groups()

    return {
        "action": action,
        "size": int(size),
        "symbol": symbol,
        "price": float(price),
    }

def parse_time_message(message: str) -> datetime:
    """Extract full sent timestamp with timezone from email body preview."""
    
    match = re.search(
        r"Sent Date:\s*(\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4})",
        message,
    )

    if not match:
        return None

    return datetime.strptime(match.group(1), "%Y.%m.%d %H:%M:%S %z")

def parse_reference_number(message: str) -> str:
    pattern = r"Message Reference Number:\s*([^\s,]+)"
    match = re.search(pattern, message)

    if not match:
        return None

    return match.group(1)


def filter_executions(emails: list, start_date: Optional[datetime], end_date: Optional[datetime],) -> list[ExecutionEmail]:
    """Filter emails by IBKR sender and date range."""
    results = []

    for i, email in enumerate(emails, 1):
        sender = email.get("from", {}).get("emailAddress", {}).get("address", "")
        if sender.lower() != settings.IBKR_SENDER:
            continue
        subject = email.get("subject", "")
        subject = subject.replace(",","")
        message = email.get("bodyPreview", "")
        dt = parse_time_message(message)

        if dt is None:
            logger.warning(f"Email {i}: No valid timestamp found, skipping.")
            continue

        helsinki_time = dt.astimezone(ZoneInfo("Europe/Helsinki"))

        email_date = dt.date()  # just the date part


        # Compare with start_date / end_date
        if start_date and email_date < start_date.date():
            continue
        if end_date and email_date > end_date.date():
            continue

        # parse trade data
        trade = parse_execution_subject(subject)
        reference = parse_reference_number(message)
        if trade is None:
            logger.info(f" Failed to parse subject: {subject}")
            continue
        # Log successful parse
        logger.debug(f"Email {i}: Parsed trade: {trade}")

        results.append(
            ExecutionEmail(
                subject=subject,
                time=helsinki_time,
                action=trade["action"],
                reference=reference,
                size=trade["size"],
                symbol=trade["symbol"],
                price=trade["price"],
            )
        )
    print(f"Found {len(results)} execution emails")
    return results

# ─── Main Service Function ────────────────────────────────────────────────────

async def get_executions_from_email(db_conn,start_date: Optional[datetime] = None, end_date: Optional[datetime] = None) -> list[ExecutionEmail]:
# Log the start and end times
    logger.info("Fetching executions with start_date=%s, end_date=%s", start_date, end_date)
    access_token = await get_access_token()
    all_emails = await fetch_all_emails(access_token)
    results = filter_executions(all_emails, start_date, end_date)
    return await insert_executions(db_conn, results)