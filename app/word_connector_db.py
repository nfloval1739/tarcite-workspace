"""
Word connector database operations.

Tracks documents that use the Word add-in and their citation markers.
Citation markers are stored with hidden metadata so they can be refreshed,
edited, and used to generate bibliographies.
"""

import json
import logging
import sqlite3
from typing import Any, Dict, List, Optional

from app.config import config

logger = logging.getLogger(__name__)


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(config.db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_word_tables() -> None:
    with _get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS word_documents (
                doc_id          TEXT PRIMARY KEY,
                doc_name        TEXT DEFAULT '',
                doc_path        TEXT DEFAULT '',
                style           TEXT DEFAULT 'apa7',
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS word_citations (
                citation_id     TEXT PRIMARY KEY,
                doc_id          TEXT NOT NULL,
                item_key        TEXT NOT NULL,
                locator         TEXT DEFAULT '',
                prefix          TEXT DEFAULT '',
                suffix          TEXT DEFAULT '',
                suppress_author INTEGER DEFAULT 0,
                style           TEXT DEFAULT 'apa7',
                formatted_text  TEXT DEFAULT '',
                position        INTEGER DEFAULT 0,
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (doc_id) REFERENCES word_documents(doc_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_word_citations_doc ON word_citations(doc_id);
            CREATE INDEX IF NOT EXISTS idx_word_citations_item ON word_citations(item_key);

            CREATE TABLE IF NOT EXISTS word_connector_state (
                key             TEXT PRIMARY KEY,
                value           TEXT
            );
        """)
    logger.info("Word connector tables ready")


def set_connector_state(key: str, value: str) -> None:
    with _get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO word_connector_state (key, value) VALUES (?, ?)",
            (key, value),
        )


def get_connector_state(key: str, default: str = "") -> str:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM word_connector_state WHERE key = ?",
            (key,),
        ).fetchone()
        return row["value"] if row else default


def upsert_document(doc_id: str, doc_name: str = "", doc_path: str = "", style: str = "apa7") -> None:
    with _get_conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO word_documents
               (doc_id, doc_name, doc_path, style, updated_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)""",
            (doc_id, doc_name, doc_path, style),
        )


def get_document(doc_id: str) -> Optional[Dict]:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM word_documents WHERE doc_id = ?",
            (doc_id,),
        ).fetchone()
        return dict(row) if row else None


def update_document_style(doc_id: str, style: str) -> None:
    with _get_conn() as conn:
        conn.execute(
            "UPDATE word_documents SET style = ?, updated_at = CURRENT_TIMESTAMP WHERE doc_id = ?",
            (style, doc_id),
        )


def delete_document(doc_id: str) -> bool:
    with _get_conn() as conn:
        cursor = conn.execute(
            "DELETE FROM word_documents WHERE doc_id = ?",
            (doc_id,),
        )
        return cursor.rowcount > 0


def add_citation(
    citation_id: str,
    doc_id: str,
    item_key: str,
    locator: str = "",
    prefix: str = "",
    suffix: str = "",
    suppress_author: bool = False,
    style: str = "apa7",
    formatted_text: str = "",
    position: int = 0,
) -> None:
    with _get_conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO word_citations
               (citation_id, doc_id, item_key, locator, prefix, suffix,
                suppress_author, style, formatted_text, position, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
            (citation_id, doc_id, item_key, locator, prefix, suffix,
             int(suppress_author), style, formatted_text, position),
        )


def get_citations_for_document(doc_id: str) -> List[Dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM word_citations WHERE doc_id = ? ORDER BY position",
            (doc_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def update_citation(citation_id: str, updates: Dict[str, Any]) -> None:
    allowed = {"locator", "prefix", "suffix", "suppress_author", "style", "formatted_text", "position"}
    filtered = {k: v for k, v in updates.items() if k in allowed}
    if not filtered:
        return
    if "suppress_author" in filtered:
        filtered["suppress_author"] = int(bool(filtered["suppress_author"]))
    with _get_conn() as conn:
        set_clauses = ", ".join(f"{k} = :{k}" for k in filtered)
        filtered["citation_id"] = citation_id
        conn.execute(
            f"UPDATE word_citations SET {set_clauses}, updated_at = CURRENT_TIMESTAMP WHERE citation_id = :citation_id",
            filtered,
        )


def delete_citation(citation_id: str) -> bool:
    with _get_conn() as conn:
        cursor = conn.execute(
            "DELETE FROM word_citations WHERE citation_id = ?",
            (citation_id,),
        )
        return cursor.rowcount > 0


def bulk_upsert_citations(doc_id: str, citations: List[Dict]) -> None:
    with _get_conn() as conn:
        for c in citations:
            conn.execute(
                """INSERT OR REPLACE INTO word_citations
                   (citation_id, doc_id, item_key, locator, prefix, suffix,
                    suppress_author, style, formatted_text, position, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                (
                    c["citation_id"],
                    doc_id,
                    c["item_key"],
                    c.get("locator", ""),
                    c.get("prefix", ""),
                    c.get("suffix", ""),
                    int(c.get("suppress_author", False)),
                    c.get("style", "apa7"),
                    c.get("formatted_text", ""),
                    c.get("position", 0),
                ),
            )


def get_citation(citation_id: str) -> Optional[Dict]:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM word_citations WHERE citation_id = ?",
            (citation_id,),
        ).fetchone()
        return dict(row) if row else None


def get_document_citation_count(doc_id: str) -> int:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM word_citations WHERE doc_id = ?",
            (doc_id,),
        ).fetchone()
        return row["cnt"] if row else 0
