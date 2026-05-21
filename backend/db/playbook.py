"""
setup_playbook table: per-setup strategy notes for the Playbook page.

One row per setup label (the free-form strings that appear in
``trades.observed_setup``). Notes are structured rather than a single
markdown blob so the playbook stays scannable across setups.

The setup label itself is the primary key — there's no auto-id. The
label is treated case-sensitively to match the rest of the app
(``observed_setup`` is a TEXT[] of free-form strings; we don't
normalise casing anywhere else, so we don't here either).

There is no FK from this table to ``trades.observed_setup`` — the
labels are user-editable strings that drift over time, and we'd rather
keep stale notes around than cascade-delete them when a label rotates
out of recent observation. The Playbook page hides setups with no
recent trades, so stale notes are simply invisible until the label
appears again.
"""

import asyncpg

import logging
logger = logging.getLogger(__name__)


async def create_playbook_table(db_conn: asyncpg.Connection) -> None:
    """Create the setup_playbook table. Idempotent.

    Forward-compatible ALTER TABLE block lets us add new structured
    fields later (e.g. an ``r_multiple_target`` or ``filters`` column)
    without breaking existing deployments. Pattern matches db/trades.py.
    """
    exists = await db_conn.fetchval("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'setup_playbook'
        )
    """)

    if exists:
        logger.info("setup_playbook table already exists, skipping creation")
        # Reserved for future ALTER TABLE additions. Keeping the block
        # in place so adding a column is a one-line change.
        return

    await db_conn.execute("""
        CREATE TABLE setup_playbook (
            setup_label      TEXT PRIMARY KEY,
            description      TEXT NOT NULL DEFAULT '',
            entry_rules      TEXT NOT NULL DEFAULT '',
            exit_rules       TEXT NOT NULL DEFAULT '',
            common_mistakes  TEXT NOT NULL DEFAULT '',
            examples         TEXT NOT NULL DEFAULT '',
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    logger.info("Created setup_playbook table")
