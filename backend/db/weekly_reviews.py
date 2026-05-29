"""
weekly_reviews table: one stored Claude-generated trade review per week.

One row per ``week_start`` (the Monday, Europe/Helsinki, that anchors the
week — same bucketing convention as the analytics module). Re-generating a
week overwrites the existing row (UPSERT), so there's always at most one
current review per week, but the row is kept so the user can revisit past
reviews and so future generations can read prior weeks' reviews for
cross-week context.

Columns:
  * week_start  — Monday (local) anchoring the week. PRIMARY KEY.
  * model       — the Anthropic model string that produced the review.
  * content     — the review itself, markdown.
  * stats       — JSONB snapshot of the aggregate numbers the prompt was
                  built from (pnl, trade count, win rate, deviations …),
                  so the page can show headline figures without recomputing.
  * created_at  — when this review was generated.
"""

import json
from datetime import date
from typing import Optional

import asyncpg

import logging
logger = logging.getLogger(__name__)


async def create_weekly_reviews_table(db_conn: asyncpg.Connection) -> None:
    """Create the weekly_reviews table. Idempotent."""
    exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'weekly_reviews'
        )
    """)

    if exists:
        logger.info("weekly_reviews table already exists, skipping creation")
        return

    await db_conn.execute("""
        CREATE TABLE weekly_reviews (
            week_start  DATE PRIMARY KEY,
            model       TEXT NOT NULL DEFAULT '',
            content     TEXT NOT NULL DEFAULT '',
            stats       JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    logger.info("Created weekly_reviews table")


async def upsert_weekly_review(
    db_conn: asyncpg.Connection,
    week_start: date,
    model: str,
    content: str,
    stats: dict,
) -> dict:
    """Insert or overwrite the review for ``week_start``. Returns the row."""
    row = await db_conn.fetchrow(
        """
        INSERT INTO weekly_reviews (week_start, model, content, stats, created_at)
        VALUES ($1, $2, $3, $4::jsonb, now())
        ON CONFLICT (week_start) DO UPDATE
            SET model = EXCLUDED.model,
                content = EXCLUDED.content,
                stats = EXCLUDED.stats,
                created_at = now()
        RETURNING week_start, model, content, stats, created_at
        """,
        week_start, model, content, json.dumps(stats),
    )
    return _row_to_dict(row)


async def fetch_weekly_review(
    db_conn: asyncpg.Connection,
    week_start: date,
) -> Optional[dict]:
    """Return the stored review for ``week_start``, or None if none exists."""
    row = await db_conn.fetchrow(
        """
        SELECT week_start, model, content, stats, created_at
        FROM weekly_reviews
        WHERE week_start = $1
        """,
        week_start,
    )
    return _row_to_dict(row) if row else None


async def list_review_weeks(db_conn: asyncpg.Connection) -> list[date]:
    """Return the week_starts that already have a stored review (newest first)."""
    rows = await db_conn.fetch(
        "SELECT week_start FROM weekly_reviews ORDER BY week_start DESC"
    )
    return [r["week_start"] for r in rows]


def _row_to_dict(row: asyncpg.Record) -> dict:
    d = dict(row)
    # asyncpg returns JSONB as a str unless a codec is set; normalise to dict.
    if isinstance(d.get("stats"), str):
        d["stats"] = json.loads(d["stats"])
    return d
