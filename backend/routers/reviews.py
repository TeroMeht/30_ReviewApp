"""
Weekly Review endpoints — Claude-generated reviews of a selected week.

Weeks are Mon–Sun in Europe/Helsinki, matching the analytics module.
Any ``week_start`` passed in is normalised back to its Monday, so the
frontend can send any day in the week and still hit the right bucket.

Endpoints:
  • GET  /api/reviews/weeks            — selectable weeks (recent N) with
                                          trade counts and whether a review
                                          already exists.
  • GET  /api/reviews?week_start=...   — fetch the stored review (404 if none).
  • POST /api/reviews/generate?week_start=...
                                       — generate via Claude, store, return.
"""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query

from dependencies import get_db_conn
from db.trades import LOCAL_TZ
from db.weekly_reviews import (
    fetch_weekly_review,
    list_review_weeks,
    upsert_weekly_review,
)
from schemas.api_schemas import (
    WeeklyReview,
    WeeklyReviewWeek,
    WeeklyReviewWeeksResponse,
)
from services.weekly_review import generate_weekly_review, ReviewConfigError

import logging
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/reviews", tags=["Reviews"])

# How many recent weeks to offer in the picker.
WEEKS_IN_PICKER = 26


def _monday(d: date) -> date:
    """Monday of the week containing ``d``."""
    return d - timedelta(days=d.weekday())


def _current_monday() -> date:
    """Monday of the current week in the trader's local timezone."""
    today = datetime.now(ZoneInfo(LOCAL_TZ)).date()
    return _monday(today)


@router.get("/weeks", response_model=WeeklyReviewWeeksResponse)
async def get_weeks(db_conn=Depends(get_db_conn)):
    """Recent weeks (newest first) with trade counts and review presence."""
    current = _current_monday()
    earliest = current - timedelta(weeks=WEEKS_IN_PICKER - 1)

    # Trade counts per local Mon–Sun week within the window.
    rows = await db_conn.fetch(
        f"""
        SELECT (date_trunc('week', (date AT TIME ZONE '{LOCAL_TZ}')))::date AS wk,
               COUNT(*) AS n
        FROM trades
        WHERE (date AT TIME ZONE '{LOCAL_TZ}')::date >= $1
        GROUP BY wk
        """,
        earliest,
    )
    counts = {r["wk"]: int(r["n"]) for r in rows}
    reviewed = set(await list_review_weeks(db_conn))

    weeks: list[WeeklyReviewWeek] = []
    wk = current
    for _ in range(WEEKS_IN_PICKER):
        wk_end = wk + timedelta(days=6)
        weeks.append(
            WeeklyReviewWeek(
                week_start=wk,
                week_end=wk_end,
                label=f"{wk.isoformat()} → {wk_end.isoformat()}",
                trade_count=counts.get(wk, 0),
                has_review=wk in reviewed,
            )
        )
        wk = wk - timedelta(weeks=1)
    return WeeklyReviewWeeksResponse(weeks=weeks)


@router.get("", response_model=WeeklyReview)
async def get_review(
    week_start: date = Query(..., description="Any date in the target week"),
    db_conn=Depends(get_db_conn),
):
    """Return the stored review for the week, or 404 if not generated yet."""
    wk = _monday(week_start)
    row = await fetch_weekly_review(db_conn, wk)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"No review stored for week starting {wk.isoformat()}",
        )
    return WeeklyReview(**row)


@router.post("/generate", response_model=WeeklyReview)
async def generate_review(
    week_start: date = Query(..., description="Any date in the target week"),
    db_conn=Depends(get_db_conn),
):
    """Generate a review for the week with Claude, store it, and return it."""
    wk = _monday(week_start)
    try:
        result = await generate_weekly_review(db_conn, wk)
    except ReviewConfigError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception("Weekly review generation failed")
        raise HTTPException(status_code=502, detail=f"Review generation failed: {e}")

    row = await upsert_weekly_review(
        db_conn,
        week_start=wk,
        model=result["model"],
        content=result["content"],
        stats=result["stats"],
    )
    return WeeklyReview(**row)
