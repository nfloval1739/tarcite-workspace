"""
SQLite database: V2 schema with migration from V1.
Uses WAL mode for safe concurrent reads during background sync.
"""

import hashlib
import json
import logging
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import config
from app.repositories.core import get_connection

logger = logging.getLogger(__name__)

V2_SCHEMA_VERSION = 2


def _get_schema_version() -> int:
    try:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT value FROM app_config WHERE key = 'schema_version'"
            ).fetchone()
            if row:
                return int(row["value"])
    except Exception:
        pass
    return 1


def _ensure_app_config_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS app_config (
            key    TEXT PRIMARY KEY,
            value  TEXT
        );
    """)


def init_db() -> None:
    with get_connection() as conn:
        _ensure_app_config_table(conn)

        current_version = _get_schema_version_from_conn(conn)

        if current_version < 2:
            _backup_before_schema_migration(conn, current_version, V2_SCHEMA_VERSION)
            _create_v1_tables(conn)
            _migrate_to_v2(conn)
        else:
            _create_v1_tables(conn)
            _ensure_v2_tables(conn)

        _ensure_tag_parent_column(conn)
        _ensure_tag_type_column(conn)
        _ensure_tag_codebook_columns(conn)
        _ensure_annotation_sentiment_column(conn)
        _ensure_item_activity_table(conn)
        _ensure_item_notes_columns(conn)
        _ensure_project_tables(conn)
        _ensure_citation_graph_tables(conn)
        _ensure_performance_indexes(conn)
        _ensure_reading_status_column(conn)
        _optimize_sqlite_planner(conn)

    logger.info("Database schema ready (version=%d) at %s", V2_SCHEMA_VERSION, config.db_path)


def _backup_before_schema_migration(conn: sqlite3.Connection, current_version: int, target_version: int) -> None:
    """Create a local SQLite safety copy before destructive/future schema migrations."""
    try:
        db_path = Path(config.db_path)
        backup_dir = db_path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"pre_migration_v{current_version}_to_v{target_version}_{stamp}.sqlite"
        with sqlite3.connect(str(backup_path)) as dst:
            conn.backup(dst)
        logger.info("Created pre-migration database backup at %s", backup_path)
    except Exception as exc:
        logger.warning("Could not create pre-migration database backup: %s", exc)


def _ensure_tag_parent_column(conn: sqlite3.Connection) -> None:
    """Add parent_id to tags table if it doesn't exist yet (non-destructive migration)."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(tags)").fetchall()}
    if "parent_id" not in cols:
        conn.execute("ALTER TABLE tags ADD COLUMN parent_id INTEGER DEFAULT NULL")


def _ensure_annotation_sentiment_column(conn: sqlite3.Connection) -> None:
    """Add sentiment to annotations table if it doesn't exist yet (non-destructive migration)."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(annotations)").fetchall()}
    if "sentiment" not in cols:
        conn.execute("ALTER TABLE annotations ADD COLUMN sentiment TEXT DEFAULT NULL")


def _ensure_tag_type_column(conn: sqlite3.Connection) -> None:
    """Add tag_type to tags table and migrate existing keyword tags (non-destructive)."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(tags)").fetchall()}
    if "tag_type" not in cols:
        conn.execute("ALTER TABLE tags ADD COLUMN tag_type TEXT NOT NULL DEFAULT 'theme'")
        # Migrate: mark tags that are ONLY in item_tags (never used for annotation coding)
        # and have no parent (not part of a user hierarchy) as 'keyword'
        conn.execute("""
            UPDATE tags SET tag_type = 'keyword'
            WHERE parent_id IS NULL
              AND tag_id IN (
                  SELECT t.tag_id FROM tags t
                  JOIN item_tags it ON it.tag_id = t.tag_id
                  LEFT JOIN annotation_tags at ON at.tag_id = t.tag_id
                  WHERE at.annotation_id IS NULL
            )
        """)


def _ensure_tag_codebook_columns(conn: sqlite3.Connection) -> None:
    """Add optional qualitative-codebook fields to theme tags."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(tags)").fetchall()}
    additions = {
        "description": "TEXT DEFAULT ''",
        "inclusion_criteria": "TEXT DEFAULT ''",
        "exclusion_criteria": "TEXT DEFAULT ''",
    }
    for col, ddl in additions.items():
        if col not in cols:
            conn.execute(f"ALTER TABLE tags ADD COLUMN {col} {ddl}")


def _ensure_item_activity_table(conn: sqlite3.Connection) -> None:
    """Track user-facing item activity without changing the synced metadata row."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS item_activity (
            item_key TEXT PRIMARY KEY,
            opened_at TIMESTAMP,
            open_count INTEGER NOT NULL DEFAULT 0,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            favorite_at TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_item_activity_opened
            ON item_activity(opened_at);
        CREATE INDEX IF NOT EXISTS idx_item_activity_favorite
            ON item_activity(is_favorite, favorite_at);
    """)


def _ensure_item_notes_columns(conn: sqlite3.Connection) -> None:
    """Add document-scoped notes fields to items without touching synced metadata."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(items)").fetchall()}
    if "notes" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN notes TEXT DEFAULT ''")
    if "note_connections" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN note_connections TEXT DEFAULT '[]'")


def _ensure_project_tables(conn: sqlite3.Connection) -> None:
    """Logical project/thesis workspaces that do not move files on disk."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
            project_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            project_type TEXT DEFAULT 'project',
            research_question TEXT DEFAULT '',
            objective TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS project_items (
            project_id INTEGER NOT NULL,
            item_key TEXT NOT NULL,
            reading_status TEXT DEFAULT '',
            note TEXT DEFAULT '',
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (project_id, item_key),
            FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_project_items_project ON project_items(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_items_item ON project_items(item_key);

        CREATE TABLE IF NOT EXISTS project_annotations (
            project_id INTEGER NOT NULL,
            annotation_id INTEGER NOT NULL,
            role TEXT DEFAULT '',
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (project_id, annotation_id),
            FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
            FOREIGN KEY (annotation_id) REFERENCES annotations(annotation_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_project_annotations_project ON project_annotations(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_annotations_annotation ON project_annotations(annotation_id);

        CREATE TABLE IF NOT EXISTS project_outputs (
            output_id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            output_type TEXT DEFAULT 'note',
            title TEXT DEFAULT '',
            content TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_project_outputs_project ON project_outputs(project_id);

        CREATE TABLE IF NOT EXISTS project_theme_roots (
            project_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            include_descendants INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (project_id, tag_id),
            FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_project_theme_roots_project ON project_theme_roots(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_theme_roots_tag ON project_theme_roots(tag_id);
    """)
    try:
        conn.execute("ALTER TABLE projects ADD COLUMN notes TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE projects ADD COLUMN note_connections TEXT DEFAULT '[]'")
    except Exception:
        pass


def _ensure_citation_graph_tables(conn: sqlite3.Connection) -> None:
    """Persist local citation graph extraction state and edges."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS citation_graph_jobs (
            job_id TEXT PRIMARY KEY,
            source_dir TEXT DEFAULT '',
            status TEXT DEFAULT 'running',
            total_items INTEGER DEFAULT 0,
            processed_items INTEGER DEFAULT 0,
            references_found INTEGER DEFAULT 0,
            edges_created INTEGER DEFAULT 0,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            finished_at TIMESTAMP,
            error TEXT DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_citation_graph_jobs_source_started
            ON citation_graph_jobs(source_dir, started_at);
        CREATE INDEX IF NOT EXISTS idx_citation_graph_jobs_status
            ON citation_graph_jobs(status);

        CREATE TABLE IF NOT EXISTS citation_graph_item_status (
            item_key TEXT PRIMARY KEY,
            source_dir TEXT DEFAULT '',
            provider TEXT DEFAULT 'crossref',
            status TEXT DEFAULT 'pending',
            reference_count INTEGER DEFAULT 0,
            matched_count INTEGER DEFAULT 0,
            last_indexed_at TIMESTAMP,
            error TEXT DEFAULT '',
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_citation_graph_item_status_source
            ON citation_graph_item_status(source_dir, status);

        CREATE TABLE IF NOT EXISTS parsed_references (
            reference_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_item_key TEXT NOT NULL,
            ref_index INTEGER DEFAULT 0,
            raw_reference TEXT DEFAULT '',
            cited_doi TEXT DEFAULT '',
            cited_title TEXT DEFAULT '',
            cited_year TEXT DEFAULT '',
            cited_author TEXT DEFAULT '',
            provider TEXT DEFAULT 'crossref',
            confidence REAL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (source_item_key) REFERENCES items(item_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_parsed_refs_source
            ON parsed_references(source_item_key);
        CREATE INDEX IF NOT EXISTS idx_parsed_refs_doi
            ON parsed_references(cited_doi);

        CREATE TABLE IF NOT EXISTS citation_edges (
            edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_item_key TEXT NOT NULL,
            target_item_key TEXT NOT NULL,
            reference_id INTEGER,
            source_dir TEXT DEFAULT '',
            match_method TEXT DEFAULT '',
            confidence REAL DEFAULT 0,
            provider TEXT DEFAULT 'crossref',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (source_item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (target_item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (reference_id) REFERENCES parsed_references(reference_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_citation_edges_source
            ON citation_edges(source_item_key);
        CREATE INDEX IF NOT EXISTS idx_citation_edges_target
            ON citation_edges(target_item_key);
        CREATE INDEX IF NOT EXISTS idx_citation_edges_source_dir
            ON citation_edges(source_dir);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_citation_edges_unique_ref
            ON citation_edges(source_item_key, target_item_key, reference_id);
    """)


def _ensure_reading_status_column(conn: sqlite3.Connection) -> None:
    """Add reading_status to item_activity for global (library-wide) tracking."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(item_activity)").fetchall()}
    if "reading_status" not in cols:
        conn.execute("ALTER TABLE item_activity ADD COLUMN reading_status TEXT DEFAULT ''")


def _ensure_performance_indexes(conn: sqlite3.Connection) -> None:
    """Add non-destructive indexes for common UI/API browse paths."""
    conn.executescript("""
        CREATE INDEX IF NOT EXISTS idx_items_title_nocase
            ON items(title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_items_source_title
            ON items(source_dir, title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_items_source_year
            ON items(source_dir, year);
        CREATE INDEX IF NOT EXISTS idx_items_source_synced
            ON items(source_dir, synced_at);
        CREATE INDEX IF NOT EXISTS idx_items_citation_count
            ON items(citation_count);
        CREATE INDEX IF NOT EXISTS idx_items_citation_refresh
            ON items(doi, citation_count_updated_at);

        CREATE INDEX IF NOT EXISTS idx_collections_v2_source_name
            ON collections_v2(source_dir, name);
        CREATE INDEX IF NOT EXISTS idx_item_collections_collection_item
            ON item_collections(collection_key, item_key);

        CREATE INDEX IF NOT EXISTS idx_files_item_primary
            ON files(item_key, is_primary DESC, file_id);

        CREATE INDEX IF NOT EXISTS idx_annotations_item_page_created
            ON annotations(item_key, page_index, created_at);
        CREATE INDEX IF NOT EXISTS idx_annotations_updated
            ON annotations(updated_at);
        CREATE INDEX IF NOT EXISTS idx_annotations_source_chunk
            ON annotations(source_chunk_id);

        CREATE INDEX IF NOT EXISTS idx_tags_type_parent_name
            ON tags(tag_type, parent_id, name);
        CREATE INDEX IF NOT EXISTS idx_tags_type_name
            ON tags(tag_type, name);
        CREATE INDEX IF NOT EXISTS idx_annotation_tags_tag_annotation
            ON annotation_tags(tag_id, annotation_id);

        CREATE INDEX IF NOT EXISTS idx_projects_updated
            ON projects(updated_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_project_items_project_added
            ON project_items(project_id, added_at);
        CREATE INDEX IF NOT EXISTS idx_project_annotations_project_added
            ON project_annotations(project_id, added_at);

        CREATE INDEX IF NOT EXISTS idx_chat_sessions_status_updated
            ON chat_sessions(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
            ON chat_messages(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_suggestion_results_run_position
            ON suggestion_results(run_id, position);
    """)


def _optimize_sqlite_planner(conn: sqlite3.Connection) -> None:
    """Refresh SQLite planner stats opportunistically without blocking startup."""
    try:
        conn.execute("PRAGMA optimize")
    except Exception as exc:
        logger.debug("SQLite planner optimization skipped: %s", exc)


def _get_schema_version_from_conn(conn: sqlite3.Connection) -> int:
    try:
        row = conn.execute(
            "SELECT value FROM app_config WHERE key = 'schema_version'"
        ).fetchone()
        if row:
            return int(row["value"])
    except Exception:
        pass
    return 1


def _create_v1_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS items (
            item_key           TEXT PRIMARY KEY,
            title              TEXT,
            creators           TEXT,
            year               TEXT,
            item_type          TEXT,
            publication_title  TEXT,
            doi                TEXT,
            url                TEXT,
            abstract           TEXT,
            tags               TEXT,
            collection_keys    TEXT,
            date_modified      TEXT,
            extra              TEXT,
            volume             TEXT,
            issue              TEXT,
            pages              TEXT,
            publisher          TEXT,
            place              TEXT,
            edition            TEXT,
            isbn               TEXT,
            issn               TEXT,
            file_path          TEXT,
            source_dir         TEXT DEFAULT '',
            citation_count     INTEGER DEFAULT 0,
            citation_count_updated_at TEXT DEFAULT '',
            notes              TEXT DEFAULT '',
            note_connections   TEXT DEFAULT '[]',
            synced_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS collections (
            collection_key  TEXT PRIMARY KEY,
            name            TEXT,
            parent_key      TEXT
        );

        CREATE TABLE IF NOT EXISTS item_fulltext (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key        TEXT NOT NULL,
            content         TEXT,
            total_pages     INTEGER DEFAULT 0,
            FOREIGN KEY (item_key) REFERENCES items(item_key)
        );

        CREATE TABLE IF NOT EXISTS sync_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            synced_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            items_synced    INTEGER DEFAULT 0,
            chunks_created  INTEGER DEFAULT 0,
            errors          TEXT,
            source_dir      TEXT DEFAULT ''
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            chunk_text,
            item_key     UNINDEXED,
            chunk_id     UNINDEXED,
            source_type  UNINDEXED,
            tokenize     = 'porter unicode61'
        );
    """)

    try:
        conn.execute("ALTER TABLE items ADD COLUMN source_dir TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE items ADD COLUMN citation_count INTEGER DEFAULT 0")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE items ADD COLUMN citation_count_updated_at TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE sync_log ADD COLUMN source_dir TEXT DEFAULT ''")
    except Exception:
        pass
    # Text-extraction health: '' = ok/unknown, 'ok', 'failed'. text_error holds
    # a short reason when a PDF crashed/timed out the isolated extraction worker.
    try:
        conn.execute("ALTER TABLE items ADD COLUMN text_status TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE items ADD COLUMN text_error TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE suggestion_results ADD COLUMN citation_count INTEGER DEFAULT 0")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE suggestion_runs ADD COLUMN temperature REAL DEFAULT NULL")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE suggestion_results ADD COLUMN feedback_type TEXT DEFAULT NULL")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE suggestion_results ADD COLUMN feedback_value INTEGER DEFAULT NULL")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE suggestion_results ADD COLUMN feedback_at TEXT DEFAULT NULL")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE suggestion_runs ADD COLUMN candidates_json TEXT DEFAULT '[]'")
    except Exception:
        pass
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_items_year     ON items(year)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_items_type     ON items(item_type)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_items_filepath ON items(file_path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fulltext_item  ON item_fulltext(item_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_items_sourcedir ON items(source_dir)")
    except Exception:
        pass


def _migrate_to_v2(conn: sqlite3.Connection) -> None:
    logger.info("Migrating database to V2 schema...")

    _create_v2_tables(conn)
    _backfill_v2_data(conn)

    conn.execute(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES ('schema_version', ?)",
        (str(V2_SCHEMA_VERSION),)
    )
    logger.info("Migration to V2 complete")


def _create_v2_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS files (
            file_id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_name TEXT DEFAULT '',
            file_ext TEXT DEFAULT '',
            mime_type TEXT DEFAULT '',
            source_dir TEXT DEFAULT '',
            size_bytes INTEGER DEFAULT 0,
            modified_at TEXT DEFAULT '',
            content_hash TEXT DEFAULT '',
            is_primary INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path ON files(file_path);
        CREATE INDEX IF NOT EXISTS idx_files_item ON files(item_key);
        CREATE INDEX IF NOT EXISTS idx_files_source_dir ON files(source_dir);

        CREATE TABLE IF NOT EXISTS creators (
            creator_id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT DEFAULT '',
            last_name TEXT DEFAULT '',
            name TEXT DEFAULT '',
            normalized_name TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_creators_normalized ON creators(normalized_name);
        CREATE INDEX IF NOT EXISTS idx_creators_last_name ON creators(last_name);

        CREATE TABLE IF NOT EXISTS item_creators (
            item_key TEXT NOT NULL,
            creator_id INTEGER NOT NULL,
            creator_type TEXT DEFAULT 'author',
            position INTEGER DEFAULT 0,
            PRIMARY KEY (item_key, creator_id, creator_type, position),
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (creator_id) REFERENCES creators(creator_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_item_creators_item ON item_creators(item_key);
        CREATE INDEX IF NOT EXISTS idx_item_creators_creator ON item_creators(creator_id);

        CREATE TABLE IF NOT EXISTS collections_v2 (
            collection_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_key TEXT DEFAULT '',
            source_dir TEXT DEFAULT '',
            local_path TEXT DEFAULT '',
            collection_type TEXT DEFAULT 'folder',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_collections_v2_parent ON collections_v2(parent_key);
        CREATE INDEX IF NOT EXISTS idx_collections_v2_source_dir ON collections_v2(source_dir);

        CREATE TABLE IF NOT EXISTS item_collections (
            item_key TEXT NOT NULL,
            collection_key TEXT NOT NULL,
            PRIMARY KEY (item_key, collection_key),
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (collection_key) REFERENCES collections_v2(collection_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_item_collections_item ON item_collections(item_key);
        CREATE INDEX IF NOT EXISTS idx_item_collections_collection ON item_collections(collection_key);

        CREATE TABLE IF NOT EXISTS fulltext_pages (
            page_id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key TEXT NOT NULL,
            file_id INTEGER,
            page_index INTEGER NOT NULL,
            page_label TEXT DEFAULT '',
            text TEXT DEFAULT '',
            width REAL DEFAULT 0,
            height REAL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_fulltext_pages_unique
            ON fulltext_pages(item_key, file_id, page_index);
        CREATE INDEX IF NOT EXISTS idx_fulltext_pages_item ON fulltext_pages(item_key);

        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id TEXT PRIMARY KEY,
            item_key TEXT NOT NULL,
            file_id INTEGER,
            page_start INTEGER DEFAULT 0,
            page_end INTEGER DEFAULT 0,
            chunk_index INTEGER DEFAULT 0,
            source_type TEXT DEFAULT 'fulltext',
            chunk_text TEXT NOT NULL,
            vector_collection TEXT DEFAULT '',
            vector_id TEXT DEFAULT '',
            token_count INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks(item_key);
        CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(item_key, page_start, page_end);
        CREATE INDEX IF NOT EXISTS idx_chunks_vector_id ON chunks(vector_id);

        CREATE TABLE IF NOT EXISTS annotations (
            annotation_id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key TEXT NOT NULL,
            file_id INTEGER,
            page_index INTEGER DEFAULT 0,
            annotation_type TEXT NOT NULL,
            color TEXT DEFAULT '',
            quote TEXT DEFAULT '',
            comment TEXT DEFAULT '',
            geometry_json TEXT DEFAULT '{}',
            source_chunk_id TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE,
            FOREIGN KEY (source_chunk_id) REFERENCES chunks(chunk_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_annotations_item ON annotations(item_key);
        CREATE INDEX IF NOT EXISTS idx_annotations_file_page ON annotations(file_id, page_index);
        CREATE INDEX IF NOT EXISTS idx_annotations_type ON annotations(annotation_type);

        CREATE TABLE IF NOT EXISTS tags (
            tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            color TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_normalized ON tags(normalized_name);

        CREATE TABLE IF NOT EXISTS item_tags (
            item_key TEXT NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (item_key, tag_id),
            FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_item_tags_item ON item_tags(item_key);
        CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

        CREATE TABLE IF NOT EXISTS annotation_tags (
            annotation_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            PRIMARY KEY (annotation_id, tag_id),
            FOREIGN KEY (annotation_id) REFERENCES annotations(annotation_id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_annotation_tags_annotation ON annotation_tags(annotation_id);
        CREATE INDEX IF NOT EXISTS idx_annotation_tags_tag ON annotation_tags(tag_id);

        CREATE TABLE IF NOT EXISTS sync_jobs (
            sync_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_dir TEXT DEFAULT '',
            status TEXT DEFAULT 'running',
            force_resync INTEGER DEFAULT 0,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            finished_at TIMESTAMP,
            items_found INTEGER DEFAULT 0,
            items_synced INTEGER DEFAULT 0,
            items_skipped INTEGER DEFAULT 0,
            chunks_created INTEGER DEFAULT 0,
            errors_json TEXT DEFAULT '[]'
        );

        CREATE INDEX IF NOT EXISTS idx_sync_jobs_source_dir ON sync_jobs(source_dir);
        CREATE INDEX IF NOT EXISTS idx_sync_jobs_started ON sync_jobs(started_at);

        CREATE TABLE IF NOT EXISTS chat_sessions (
            session_id TEXT PRIMARY KEY,
            title TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            suggestion_run_id TEXT DEFAULT '',
            linked_item_key TEXT DEFAULT '',
            active_profile TEXT DEFAULT '',
            status TEXT DEFAULT 'active'
        );

        CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);

        CREATE TABLE IF NOT EXISTS chat_messages (
            message_id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            model_used TEXT DEFAULT '',
            linked_item_key TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

        CREATE TABLE IF NOT EXISTS suggestion_runs (
            run_id TEXT PRIMARY KEY,
            title TEXT DEFAULT '',
            paragraph TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            active_profile TEXT DEFAULT '',
            ai_model TEXT DEFAULT '',
            source_dir TEXT DEFAULT '',
            collection_key TEXT DEFAULT '',
            top_k INTEGER DEFAULT 50,
            citation_style TEXT DEFAULT 'apa7',
            status TEXT DEFAULT 'completed',
            elapsed_seconds REAL DEFAULT 0,
            warnings_json TEXT DEFAULT '[]',
            user_notes TEXT DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_suggestion_runs_created ON suggestion_runs(created_at);
        CREATE INDEX IF NOT EXISTS idx_suggestion_runs_status ON suggestion_runs(status);

        CREATE TABLE IF NOT EXISTS suggestion_results (
            result_id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            inline_citation TEXT DEFAULT '',
            full_reference TEXT DEFAULT '',
            reason TEXT DEFAULT '',
            evidence_points_json TEXT DEFAULT '[]',
            evidence_coverage TEXT DEFAULT 'single_point',
            confidence TEXT DEFAULT 'Low',
            source_type TEXT DEFAULT '',
            citation_count INTEGER DEFAULT 0,
            position INTEGER DEFAULT 0,
            FOREIGN KEY (run_id) REFERENCES suggestion_runs(run_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_suggestion_results_run ON suggestion_results(run_id);
        CREATE INDEX IF NOT EXISTS idx_suggestion_results_item ON suggestion_results(item_key);
    """)


def _backfill_v2_data(conn: sqlite3.Connection) -> None:
    logger.info("Backfilling V2 data from V1 tables...")

    try:
        rows = conn.execute("SELECT * FROM items").fetchall()
        for row in rows:
            item = dict(row)
            item_key = item["item_key"]
            file_path = item.get("file_path", "")
            source_dir = item.get("source_dir", "")

            if file_path:
                from pathlib import Path
                fp = Path(file_path)
                conn.execute(
                    """INSERT OR IGNORE INTO files
                       (item_key, file_path, file_name, file_ext, source_dir)
                       VALUES (?, ?, ?, ?, ?)""",
                    (item_key, file_path, fp.name, fp.suffix.lstrip("."), source_dir)
                )

            creators_raw = item.get("creators", "[]")
            try:
                creators = json.loads(creators_raw) if isinstance(creators_raw, str) else (creators_raw or [])
            except (json.JSONDecodeError, TypeError):
                creators = []

            for pos, c in enumerate(creators):
                first = c.get("firstName", "")
                last = c.get("lastName", "")
                name = c.get("name", "")
                ctype = c.get("creatorType", "author")
                normalized = f"{last}, {first}".strip(", ") if last else name

                conn.execute(
                    """INSERT OR IGNORE INTO creators (first_name, last_name, name, normalized_name)
                       VALUES (?, ?, ?, ?)""",
                    (first, last, name, normalized)
                )

                creator_row = conn.execute(
                    "SELECT creator_id FROM creators WHERE normalized_name = ?",
                    (normalized,)
                ).fetchone()

                if creator_row:
                    conn.execute(
                        """INSERT OR IGNORE INTO item_creators
                           (item_key, creator_id, creator_type, position)
                           VALUES (?, ?, ?, ?)""",
                        (item_key, creator_row["creator_id"], ctype, pos)
                    )

            tags_raw = item.get("tags", "[]")
            try:
                tags = json.loads(tags_raw) if isinstance(tags_raw, str) else []
            except (json.JSONDecodeError, TypeError):
                tags = []

            for tag_name in tags:
                if tag_name:
                    normalized = tag_name.lower().strip()
                    conn.execute(
                        "INSERT OR IGNORE INTO tags (name, normalized_name) VALUES (?, ?)",
                        (tag_name, normalized)
                    )
                    tag_row = conn.execute(
                        "SELECT tag_id FROM tags WHERE normalized_name = ?",
                        (normalized,)
                    ).fetchone()
                    if tag_row:
                        conn.execute(
                            "INSERT OR IGNORE INTO item_tags (item_key, tag_id) VALUES (?, ?)",
                            (item_key, tag_row["tag_id"])
                        )

            col_keys_raw = item.get("collection_keys", "[]")
            try:
                col_keys = json.loads(col_keys_raw) if isinstance(col_keys_raw, str) else []
            except (json.JSONDecodeError, TypeError):
                col_keys = []

            for ck in col_keys:
                if ck:
                    conn.execute(
                        "INSERT OR IGNORE INTO item_collections (item_key, collection_key) VALUES (?, ?)",
                        (item_key, ck)
                    )

        logger.info("Backfilled items, files, creators, tags, collections")
    except Exception as exc:
        logger.warning("Backfill items error (non-fatal): %s", exc)

    try:
        ft_rows = conn.execute("SELECT * FROM item_fulltext").fetchall()
        for ft in ft_rows:
            ft_dict = dict(ft)
            item_key = ft_dict["item_key"]
            content = ft_dict.get("content", "")
            if content:
                file_row = conn.execute(
                    "SELECT file_id FROM files WHERE item_key = ? LIMIT 1",
                    (item_key,)
                ).fetchone()
                file_id = file_row["file_id"] if file_row else None

                conn.execute(
                    """INSERT OR IGNORE INTO fulltext_pages
                       (item_key, file_id, page_index, text)
                       VALUES (?, ?, 0, ?)""",
                    (item_key, file_id, content)
                )

        logger.info("Backfilled fulltext_pages")
    except Exception as exc:
        logger.warning("Backfill fulltext_pages error (non-fatal): %s", exc)

    try:
        col_rows = conn.execute("SELECT * FROM collections").fetchall()
        for col in col_rows:
            col_dict = dict(col)
            conn.execute(
                """INSERT OR IGNORE INTO collections_v2
                   (collection_key, name, parent_key)
                   VALUES (?, ?, ?)""",
                (col_dict["collection_key"], col_dict["name"], col_dict.get("parent_key", ""))
            )
        logger.info("Backfilled collections_v2")
    except Exception as exc:
        logger.warning("Backfill collections error (non-fatal): %s", exc)


def _ensure_v2_tables(conn: sqlite3.Connection) -> None:
    _create_v2_tables(conn)


# ── V1-compatible CRUD (preserved for existing routes) ────────────────────────


def _sync_item_v2_indexes(conn: sqlite3.Connection, item_data: Dict[str, Any]) -> None:
    item_key = item_data.get("item_key", "")
    if not item_key:
        return

    file_path = item_data.get("file_path", "")
    source_dir = item_data.get("source_dir", "")
    if file_path:
        from pathlib import Path
        fp = Path(file_path)
        _VIEWABLE_EXTENSIONS = {".pdf", ".txt", ".md", ".markdown", ".csv", ".docx",
                                 ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
        if fp.suffix.lower() in _VIEWABLE_EXTENSIONS:
            conn.execute(
                """INSERT OR IGNORE INTO files
                   (item_key, file_path, file_name, file_ext, source_dir)
                   VALUES (?, ?, ?, ?, ?)""",
                (item_key, file_path, fp.name, fp.suffix.lstrip("."), source_dir),
            )

    creators_raw = item_data.get("creators", "[]")
    try:
        creators = json.loads(creators_raw) if isinstance(creators_raw, str) else (creators_raw or [])
    except (json.JSONDecodeError, TypeError):
        creators = []
    _replace_item_creators(conn, item_key, creators)

    conn.execute("DELETE FROM item_tags WHERE item_key = ?", (item_key,))
    tags_raw = item_data.get("tags", "[]")
    try:
        tags = json.loads(tags_raw) if isinstance(tags_raw, str) else (tags_raw or [])
    except (json.JSONDecodeError, TypeError):
        tags = []
    for tag_name in tags:
        if not tag_name:
            continue
        normalized = str(tag_name).lower().strip()
        conn.execute(
            "INSERT OR IGNORE INTO tags (name, normalized_name, tag_type) VALUES (?, ?, 'keyword')",
            (tag_name, normalized),
        )
        tag_row = conn.execute(
            "SELECT tag_id FROM tags WHERE normalized_name = ?",
            (normalized,),
        ).fetchone()
        if tag_row:
            conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_key, tag_id) VALUES (?, ?)",
                (item_key, tag_row["tag_id"]),
            )

    conn.execute("DELETE FROM item_collections WHERE item_key = ?", (item_key,))
    col_keys_raw = item_data.get("collection_keys", "[]")
    try:
        col_keys = json.loads(col_keys_raw) if isinstance(col_keys_raw, str) else (col_keys_raw or [])
    except (json.JSONDecodeError, TypeError):
        col_keys = []
    for collection_key in col_keys:
        if collection_key:
            conn.execute(
                """INSERT OR IGNORE INTO collections_v2
                   (collection_key, name, parent_key, source_dir, local_path, collection_type)
                   VALUES (?, ?, '', '', '', 'folder')""",
                (collection_key, "Root" if collection_key == "root" else collection_key),
            )
            conn.execute(
                "INSERT OR IGNORE INTO item_collections (item_key, collection_key) VALUES (?, ?)",
                (item_key, collection_key),
            )


def upsert_item(item_data: Dict[str, Any]) -> None:
    payload = dict(item_data)
    with get_connection() as conn:
        if "citation_count" not in payload or "citation_count_updated_at" not in payload:
            existing = conn.execute(
                "SELECT citation_count, citation_count_updated_at FROM items WHERE item_key = ?",
                (payload.get("item_key", ""),),
            ).fetchone()
            payload.setdefault("citation_count", existing["citation_count"] if existing else 0)
            payload.setdefault("citation_count_updated_at", existing["citation_count_updated_at"] if existing else "")
        conn.execute(
            """
            INSERT INTO items
                (item_key, title, creators, year, item_type, publication_title,
                 doi, url, abstract, tags, collection_keys, date_modified, extra,
                 volume, issue, pages, publisher, place, edition, isbn, issn,
                 file_path, source_dir, citation_count, citation_count_updated_at)
            VALUES
                (:item_key, :title, :creators, :year, :item_type, :publication_title,
                 :doi, :url, :abstract, :tags, :collection_keys, :date_modified, :extra,
                 :volume, :issue, :pages, :publisher, :place, :edition, :isbn, :issn,
                 :file_path, :source_dir, :citation_count, :citation_count_updated_at)
            ON CONFLICT(item_key) DO UPDATE SET
                title                    = excluded.title,
                creators                 = excluded.creators,
                year                     = excluded.year,
                item_type                = excluded.item_type,
                publication_title        = excluded.publication_title,
                doi                      = excluded.doi,
                url                      = excluded.url,
                abstract                 = excluded.abstract,
                tags                     = excluded.tags,
                collection_keys          = excluded.collection_keys,
                date_modified            = excluded.date_modified,
                extra                    = excluded.extra,
                volume                   = excluded.volume,
                issue                    = excluded.issue,
                pages                    = excluded.pages,
                publisher                = excluded.publisher,
                place                    = excluded.place,
                edition                  = excluded.edition,
                isbn                     = excluded.isbn,
                issn                     = excluded.issn,
                file_path                = excluded.file_path,
                source_dir               = excluded.source_dir,
                citation_count           = excluded.citation_count,
                citation_count_updated_at = excluded.citation_count_updated_at,
                synced_at                = CURRENT_TIMESTAMP
            """,
            payload,
        )
        _sync_item_v2_indexes(conn, payload)


def get_item(item_key: str) -> Optional[Dict]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM items WHERE item_key = ?", (item_key,)
        ).fetchone()
        return dict(row) if row else None


def record_item_open(item_key: str) -> Optional[Dict]:
    """Mark an item as opened and return its updated activity state."""
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM items WHERE item_key = ?", (item_key,)
        ).fetchone()
        if not exists:
            return None
        conn.execute(
            """INSERT INTO item_activity
                   (item_key, opened_at, open_count, updated_at)
               VALUES (?, ?, 1, ?)
               ON CONFLICT(item_key) DO UPDATE SET
                   opened_at = excluded.opened_at,
                   open_count = item_activity.open_count + 1,
                   updated_at = excluded.updated_at""",
            (item_key, now, now),
        )
        row = conn.execute(
            """SELECT opened_at, open_count, is_favorite, favorite_at
               FROM item_activity WHERE item_key = ?""",
            (item_key,),
        ).fetchone()
        activity = dict(row) if row else {}
        activity["is_favorite"] = bool(activity.get("is_favorite"))
        return activity


def set_item_favorite(item_key: str, is_favorite: bool) -> Optional[Dict]:
    """Set or clear a library favorite while preserving recent/open counters."""
    now = datetime.now(timezone.utc).isoformat()
    favorite_at = now if is_favorite else None
    favorite_int = 1 if is_favorite else 0
    with get_connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM items WHERE item_key = ?", (item_key,)
        ).fetchone()
        if not exists:
            return None
        conn.execute(
            """INSERT INTO item_activity
                   (item_key, is_favorite, favorite_at, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(item_key) DO UPDATE SET
                   is_favorite = excluded.is_favorite,
                   favorite_at = excluded.favorite_at,
                   updated_at = excluded.updated_at""",
            (item_key, favorite_int, favorite_at, now),
        )
        row = conn.execute(
            """SELECT opened_at, open_count, is_favorite, favorite_at
               FROM item_activity WHERE item_key = ?""",
            (item_key,),
        ).fetchone()
        activity = dict(row) if row else {}
        activity["is_favorite"] = bool(activity.get("is_favorite"))
        return activity


def set_item_reading_status(item_key: str, status: str) -> Optional[Dict]:
    """Set reading status ('', 'reading', 'read') for a library item."""
    if status not in ("", "reading", "read"):
        return None
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM items WHERE item_key = ?", (item_key,)
        ).fetchone()
        if not exists:
            return None
        conn.execute(
            """INSERT INTO item_activity (item_key, reading_status, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(item_key) DO UPDATE SET
                   reading_status = excluded.reading_status,
                   updated_at = excluded.updated_at""",
            (item_key, status, now),
        )
        row = conn.execute(
            """SELECT opened_at, open_count, is_favorite, favorite_at,
                      COALESCE(reading_status, '') AS reading_status
               FROM item_activity WHERE item_key = ?""",
            (item_key,),
        ).fetchone()
        activity = dict(row) if row else {}
        activity["is_favorite"] = bool(activity.get("is_favorite"))
        return activity


def get_items_batch(item_keys: List[str]) -> Dict[str, Dict]:
    if not item_keys:
        return {}
    placeholders = ",".join("?" for _ in item_keys)
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT * FROM items WHERE item_key IN ({placeholders})",
            item_keys,
        ).fetchall()
        return {r["item_key"]: dict(r) for r in rows}


def get_all_items() -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM items ORDER BY year DESC, title").fetchall()
        return [dict(r) for r in rows]


def get_item_count() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]


def upsert_collection(data: Dict[str, Any]) -> None:
    # IMPORTANT: never use INSERT OR REPLACE here. item_collections has
    # FOREIGN KEY(collection_key) REFERENCES collections_v2 ON DELETE CASCADE, and
    # REPLACE deletes the existing row before re-inserting — which cascade-wipes
    # every file's folder membership. Re-indexing one file (sync_single_file calls
    # this for the folder + every ancestor) would then empty the whole folder.
    # ON CONFLICT DO UPDATE edits the row in place, so children survive.
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO collections (collection_key, name, parent_key)
            VALUES (:collection_key, :name, :parent_key)
            ON CONFLICT(collection_key) DO UPDATE SET
                name = excluded.name,
                parent_key = excluded.parent_key
            """,
            data,
        )
        conn.execute(
            """INSERT INTO collections_v2
                   (collection_key, name, parent_key, source_dir, local_path, collection_type)
               VALUES (:collection_key, :name, :parent_key, :source_dir, :local_path, 'folder')
               ON CONFLICT(collection_key) DO UPDATE SET
                   name = excluded.name,
                   parent_key = excluded.parent_key,
                   source_dir = excluded.source_dir,
                   local_path = excluded.local_path,
                   updated_at = CURRENT_TIMESTAMP""",
            {
                "collection_key": data.get("collection_key", ""),
                "name": data.get("name", ""),
                "parent_key": data.get("parent_key", ""),
                "source_dir": data.get("source_dir", ""),
                "local_path": data.get("path", data.get("local_path", "")),
            },
        )


def get_collections() -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM collections ORDER BY name"
        ).fetchall()
        return [dict(r) for r in rows]


def get_collection_count() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0]


def save_fulltext(item_key: str, content: str, total_pages: int = 0) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO item_fulltext (item_key, content, total_pages)
            VALUES (?, ?, ?)
            """,
            (item_key, content, total_pages),
        )


def get_fulltext_for_item(item_key: str) -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM item_fulltext WHERE item_key = ?",
            (item_key,),
        ).fetchall()
        return [dict(r) for r in rows]


def set_text_status(item_key: str, status: str, error: str = "") -> None:
    """Record whether full-text extraction succeeded for an item.

    status: 'ok' or 'failed'. error: short reason when failed.
    """
    with get_connection() as conn:
        conn.execute(
            "UPDATE items SET text_status = ?, text_error = ? WHERE item_key = ?",
            (status, error, item_key),
        )


def get_text_failed_items() -> List[Dict]:
    """Items whose PDF text extraction crashed/timed out — surfaced in the UI."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT item_key, title, file_path, text_error FROM items "
            "WHERE text_status = 'failed' ORDER BY title"
        ).fetchall()
        return [dict(r) for r in rows]


def reconcile_item_collections() -> int:
    """Self-heal folder membership: ensure item_collections has a row for every
    collection listed in each item's collection_keys JSON.

    Folder-scoped views query item_collections, while sync writes both that table
    and the collection_keys field. If they drift (e.g. a crashed/partial sync),
    items vanish from their folder even though they appear at library scope. This
    add-only, idempotent pass closes that gap. Returns links added.
    """
    added = 0
    with get_connection() as conn:
        # Only restore links to collections that still exist. Items may list a
        # stale collection_key (folder later deleted/renamed); inserting that would
        # raise a FOREIGN KEY error and — since this is one transaction — roll back
        # the ENTIRE heal, restoring nothing. Skipping orphans keeps the heal
        # resilient and idempotent.
        valid_keys = set(
            r["collection_key"] for r in conn.execute("SELECT collection_key FROM collections_v2")
        )
        existing = set(
            (r["item_key"], r["collection_key"])
            for r in conn.execute("SELECT item_key, collection_key FROM item_collections")
        )
        rows = conn.execute(
            "SELECT item_key, collection_keys FROM items "
            "WHERE collection_keys NOT IN ('', '[]') AND collection_keys IS NOT NULL"
        ).fetchall()
        for r in rows:
            try:
                keys = json.loads(r["collection_keys"])
            except (json.JSONDecodeError, TypeError):
                continue
            for ck in keys or []:
                if (
                    ck and ck != "root"
                    and ck in valid_keys
                    and (r["item_key"], ck) not in existing
                ):
                    conn.execute(
                        "INSERT OR IGNORE INTO item_collections (item_key, collection_key) VALUES (?, ?)",
                        (r["item_key"], ck),
                    )
                    existing.add((r["item_key"], ck))
                    added += 1
    if added:
        logger.info("Reconciled item_collections: added %d missing folder link(s)", added)
    return added


def log_sync(items_synced: int, chunks_created: int, errors: List[str], source_dir: str = "") -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO sync_log (items_synced, chunks_created, errors, source_dir)
            VALUES (?, ?, ?, ?)
            """,
            (items_synced, chunks_created, json.dumps(errors), source_dir),
        )


def index_chunk_fts(chunk_text: str, item_key: str,
                    chunk_id: str, source_type: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO chunks_fts(chunk_text, item_key, chunk_id, source_type) VALUES (?,?,?,?)",
            (chunk_text, item_key, chunk_id, source_type),
        )


def delete_fts_for_item(item_key: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM chunks_fts WHERE item_key = ?",
            (item_key,),
        )


def clear_all_fts() -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM chunks_fts")


def search_fts(query: str, limit: int = 50) -> List[Dict]:
    if not query.strip():
        return []

    import re as _re
    _STOPWORDS = {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
        "by", "from", "as", "is", "was", "are", "were", "be", "been", "being", "have",
        "has", "had", "do", "does", "did", "will", "would", "could", "should", "may",
        "might", "this", "that", "these", "those", "it", "its", "they", "their",
        "there", "then", "than", "when", "where", "which", "who", "what", "how", "not",
    }
    words = _re.findall(r'\b[a-zA-Z]{2,}\b', query)
    terms = [w.lower() for w in words if w.lower() not in _STOPWORDS and len(w) >= 2]
    seen, unique_terms = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            unique_terms.append(t)
        if len(unique_terms) >= 15:
            break

    if not unique_terms:
        return []

    fts_query = " OR ".join(unique_terms)

    try:
        with get_connection() as conn:
            rows = conn.execute(
                """
                SELECT chunk_text, item_key, chunk_id, source_type, rank
                FROM chunks_fts
                WHERE chunks_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (fts_query, limit),
            ).fetchall()
            return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("FTS search error (query=%r): %s", fts_query, exc)
        return []


def get_fts_chunk_count() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]


def get_all_fts_item_keys() -> List[str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT item_key FROM chunks_fts"
        ).fetchall()
        return [r[0] for r in rows]


def get_fts_chunks_for_item(item_key: str) -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT chunk_id, chunk_text, source_type FROM chunks_fts WHERE item_key = ?",
            (item_key,),
        ).fetchall()
        return [{"chunk_id": r[0], "chunk_text": r[1], "source_type": r[2]} for r in rows]


def _run_fts_for_item(conn, fts_query: str, item_key: str, limit: int) -> list:
    try:
        rows = conn.execute(
            """
            SELECT chunk_id, chunk_text, source_type, rank
            FROM chunks_fts
            WHERE chunks_fts MATCH ? AND item_key = ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, item_key, limit),
        ).fetchall()
        return [{"chunk_id": r[0], "chunk_text": r[1], "source_type": r[2], "rank": r[3]} for r in rows]
    except Exception:
        return []


def search_chunks_for_item(item_key: str, query: str, limit: int = 10) -> List[Dict]:
    """FTS search scoped to a single document.

    When the user query contains a quoted passage, phrase queries are tried first
    (sliding 4-word windows over the quote) for exact-passage lookup. Falls back
    to a broad OR query so general questions still work.
    """
    if not query.strip():
        return []

    _STOPWORDS = {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
        "by", "from", "as", "is", "was", "are", "were", "be", "been", "being", "have",
        "has", "had", "do", "does", "did", "will", "would", "could", "should", "may",
        "might", "this", "that", "these", "those", "it", "its", "they", "their",
        "there", "then", "than", "when", "where", "which", "who", "what", "how", "not",
    }

    # Extract any text the user put in quotes — these are exact-passage requests
    quoted_passages = re.findall(u'(?:\"|\u201c|\u201d)([^\"\u201c\u201d]{10,})(?:\"|\u201c|\u201d)', query)

    results: List[Dict] = []
    seen_ids: set = set()

    def _merge(rows: list) -> None:
        for r in rows:
            if r["chunk_id"] not in seen_ids:
                seen_ids.add(r["chunk_id"])
                results.append(r)

    try:
        with get_connection() as conn:
            # Phase 1: phrase queries for each quoted passage
            for passage in quoted_passages:
                words = re.findall(r'\b[a-zA-Z]{2,}\b', passage)
                content_words = [w.lower() for w in words]
                if not content_words:
                    continue

                # Try sliding 4-word phrase windows; stop at first window that yields hits
                window = min(4, len(content_words))
                while window >= 2:
                    hit_found = False
                    for start in range(len(content_words) - window + 1):
                        ngram = " ".join(content_words[start:start + window])
                        phrase_query = f'"{ngram}"'
                        rows = _run_fts_for_item(conn, phrase_query, item_key, limit)
                        if rows:
                            _merge(rows)
                            hit_found = True
                            break
                    if hit_found:
                        break
                    window -= 1

            # Phase 2: broad OR query using all non-stopword terms from the full message
            all_words = re.findall(r'\b[a-zA-Z]{2,}\b', query)
            terms = [w.lower() for w in all_words if w.lower() not in _STOPWORDS]
            seen_t: set = set()
            unique_terms: List[str] = []
            for t in terms:
                if t not in seen_t:
                    seen_t.add(t)
                    unique_terms.append(t)
                if len(unique_terms) >= 20:
                    break

            if unique_terms:
                or_query = " OR ".join(unique_terms)
                or_rows = _run_fts_for_item(conn, or_query, item_key, limit)
                _merge(or_rows)

    except Exception as exc:
        logger.warning("search_chunks_for_item error (item=%s): %s", item_key, exc)

    return results[:limit]


def get_neighbor_chunks(item_key: str, chunk_ids: List[str], window: int = 1) -> List[Dict]:
    """For each matched chunk, fetch adjacent chunks (±window) by chunk_index for context."""
    if not chunk_ids:
        return []
    try:
        with get_connection() as conn:
            placeholders = ",".join("?" * len(chunk_ids))
            matched = conn.execute(
                f"SELECT chunk_id, chunk_index FROM chunks WHERE chunk_id IN ({placeholders})",
                chunk_ids,
            ).fetchall()
            if not matched:
                return []

            indices = [r[1] for r in matched]
            min_idx = min(indices) - window
            max_idx = max(indices) + window

            rows = conn.execute(
                """
                SELECT chunk_id, chunk_text, chunk_index, source_type
                FROM chunks
                WHERE item_key = ? AND chunk_index BETWEEN ? AND ?
                ORDER BY chunk_index
                """,
                (item_key, min_idx, max_idx),
            ).fetchall()
            return [{"chunk_id": r[0], "chunk_text": r[1], "chunk_index": r[2], "source_type": r[3]} for r in rows]
    except Exception as exc:
        logger.warning("get_neighbor_chunks error (item=%s): %s", item_key, exc)
        return []


def search_titles(query: str, limit: int = 50) -> List[str]:
    if not query.strip():
        return []

    _STOPWORDS = {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
        "by", "from", "as", "is", "was", "are", "were", "be", "been", "being", "have",
        "has", "had", "do", "does", "did", "will", "would", "could", "should", "may",
        "might", "this", "that", "these", "those", "it", "its", "they", "their",
        "there", "then", "than", "when", "where", "which", "who", "what", "how", "not",
    }
    words = re.findall(r'\b[a-zA-Z]{4,}\b', query)
    terms = [w.lower() for w in words if w.lower() not in _STOPWORDS]
    seen, unique_terms = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            unique_terms.append(t)
        if len(unique_terms) >= 10:
            break

    if not unique_terms:
        return []

    conditions = []
    params: list = []
    for term in unique_terms:
        conditions.append("LOWER(title) LIKE ?")
        params.append(f"%{term}%")

    where_clause = " OR ".join(conditions)
    params.append(limit)

    try:
        with get_connection() as conn:
            rows = conn.execute(
                f"""
                SELECT item_key FROM items
                WHERE {where_clause}
                ORDER BY
                    (CASE WHEN LOWER(title) LIKE ? THEN 1 ELSE 0 END
                     + CASE WHEN LOWER(title) LIKE ? THEN 1 ELSE 0 END) DESC,
                    year DESC
                LIMIT ?
                """,
                params[:len(params)-1] + [f"%{unique_terms[0]}%", f"%{unique_terms[0]}%", limit],
            ).fetchall()
            return [r["item_key"] for r in rows]
    except Exception as exc:
        logger.warning("Title search error: %s", exc)
        return []


def search_items(query: str, limit: int = 15) -> List[Dict]:
    q = query.strip()
    if not q:
        return []

    tokens = re.findall(r'[a-zA-Z0-9]+', q)
    if not tokens:
        return []

    conditions = []
    params: Dict[str, Any] = {"limit": limit}

    for i, tok in enumerate(tokens):
        ltok = tok.lower()
        conditions.append(f"LOWER(title) LIKE :t{i}")
        conditions.append(f"LOWER(creators) LIKE :t{i}")
        conditions.append(f"LOWER(file_path) LIKE :t{i}")
        conditions.append(f"year = :y{i}")
        params[f"t{i}"] = f"%{ltok}%"
        params[f"y{i}"] = tok

    where_clause = " AND ".join(f"({' OR '.join(conditions[i*4:(i+1)*4])})" for i in range(len(tokens)))

    with get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM items
            WHERE {where_clause}
            ORDER BY year DESC, title
            LIMIT :limit
            """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]


def get_config(key: str, default: str = "") -> str:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT value FROM app_config WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else default


def set_config(key: str, value: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)",
            (key, value),
        )


def get_all_items_date_modified() -> Dict[str, str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT item_key, date_modified FROM items"
        ).fetchall()
        return {r["item_key"]: (r["date_modified"] or "") for r in rows}


def get_last_sync() -> Optional[Dict]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def get_last_sync_for_dir(source_dir: str) -> Optional[Dict]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM sync_log WHERE source_dir = ? ORDER BY synced_at DESC LIMIT 1",
            (source_dir,),
        ).fetchone()
        return dict(row) if row else None


def get_item_keys_for_dir(source_dir: str) -> List[str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT item_key FROM items WHERE source_dir = ?",
            (source_dir,),
        ).fetchall()
        return [r["item_key"] for r in rows]


def get_item_count_for_dir(source_dir: str) -> int:
    with get_connection() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM items WHERE source_dir = ?",
            (source_dir,),
        ).fetchone()[0]


def get_chunk_count_for_dir(source_dir: str) -> int:
    from app.embeddings import get_collection_stats
    total = get_collection_stats().get("total_chunks", 0)
    return total


def delete_items_for_dir(source_dir: str) -> List[str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT item_key FROM items WHERE source_dir = ?",
            (source_dir,),
        ).fetchall()
        keys = [r["item_key"] for r in rows]
        if keys:
            conn.execute("DELETE FROM chunks_fts WHERE item_key IN (" +
                         ",".join("?" for _ in keys) + ")", keys)
            conn.execute("DELETE FROM item_fulltext WHERE item_key IN (" +
                         ",".join("?" for _ in keys) + ")", keys)
        conn.execute("DELETE FROM items WHERE source_dir = ?", (source_dir,))
        return keys


def merge_duplicate_item_into(source_item_key: str, target_item_key: str) -> bool:
    """Move app-owned data from a duplicate metadata item onto the real file item."""
    if not source_item_key or not target_item_key or source_item_key == target_item_key:
        return False

    with get_connection() as conn:
        source = conn.execute(
            "SELECT item_key FROM items WHERE item_key = ?",
            (source_item_key,),
        ).fetchone()
        target = conn.execute(
            "SELECT item_key FROM items WHERE item_key = ?",
            (target_item_key,),
        ).fetchone()
        if not source or not target:
            return False

        target_file = conn.execute(
            "SELECT file_id FROM files WHERE item_key = ? ORDER BY is_primary DESC, file_id LIMIT 1",
            (target_item_key,),
        ).fetchone()
        target_file_id = target_file["file_id"] if target_file else None

        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_key, tag_id) "
            "SELECT ?, tag_id FROM item_tags WHERE item_key = ?",
            (target_item_key, source_item_key),
        )
        conn.execute(
            "INSERT OR IGNORE INTO item_collections (item_key, collection_key) "
            "SELECT ?, collection_key FROM item_collections WHERE item_key = ?",
            (target_item_key, source_item_key),
        )
        conn.execute(
            """INSERT OR IGNORE INTO project_items
                   (project_id, item_key, reading_status, note, added_at)
               SELECT project_id, ?, reading_status, note, added_at
               FROM project_items WHERE item_key = ?""",
            (target_item_key, source_item_key),
        )

        source_activity = conn.execute(
            "SELECT * FROM item_activity WHERE item_key = ?",
            (source_item_key,),
        ).fetchone()
        target_activity = conn.execute(
            "SELECT * FROM item_activity WHERE item_key = ?",
            (target_item_key,),
        ).fetchone()
        if source_activity:
            if target_activity:
                opened_at = max(
                    source_activity["opened_at"] or "",
                    target_activity["opened_at"] or "",
                ) or None
                favorite_at = max(
                    source_activity["favorite_at"] or "",
                    target_activity["favorite_at"] or "",
                ) or None
                conn.execute(
                    """UPDATE item_activity
                       SET opened_at = ?,
                           open_count = COALESCE(open_count, 0) + ?,
                           is_favorite = CASE WHEN COALESCE(is_favorite, 0) = 1 OR ? = 1 THEN 1 ELSE 0 END,
                           favorite_at = ?,
                           updated_at = CURRENT_TIMESTAMP
                       WHERE item_key = ?""",
                    (
                        opened_at,
                        source_activity["open_count"] or 0,
                        1 if source_activity["is_favorite"] else 0,
                        favorite_at,
                        target_item_key,
                    ),
                )
            else:
                conn.execute(
                    """INSERT INTO item_activity
                           (item_key, opened_at, open_count, is_favorite, favorite_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                    (
                        target_item_key,
                        source_activity["opened_at"],
                        source_activity["open_count"] or 0,
                        source_activity["is_favorite"] or 0,
                        source_activity["favorite_at"],
                    ),
                )

        if target_file_id is not None:
            conn.execute(
                "UPDATE annotations SET item_key = ?, file_id = ?, source_chunk_id = '' WHERE item_key = ?",
                (target_item_key, target_file_id, source_item_key),
            )
        else:
            conn.execute(
                "UPDATE annotations SET item_key = ?, source_chunk_id = '' WHERE item_key = ?",
                (target_item_key, source_item_key),
            )

        conn.execute(
            "UPDATE suggestion_results SET item_key = ? WHERE item_key = ?",
            (target_item_key, source_item_key),
        )
        conn.execute(
            "UPDATE citation_edges SET target_item_key = ? WHERE target_item_key = ?",
            (target_item_key, source_item_key),
        )
        conn.execute(
            "UPDATE chat_messages SET linked_item_key = ? WHERE linked_item_key = ?",
            (target_item_key, source_item_key),
        )
        conn.execute(
            "UPDATE chat_sessions SET linked_item_key = ? WHERE linked_item_key = ?",
            (target_item_key, source_item_key),
        )

        conn.execute("DELETE FROM chunks_fts WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM citation_edges WHERE source_item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM parsed_references WHERE source_item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM citation_graph_item_status WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM chunks WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM item_fulltext WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM item_activity WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM project_items WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM item_tags WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM item_collections WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM item_creators WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM files WHERE item_key = ?", (source_item_key,))
        conn.execute("DELETE FROM items WHERE item_key = ?", (source_item_key,))
        return True


def delete_item(item_key: str) -> Dict[str, Any]:
    """Delete one library item and all app-owned metadata/index rows."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT file_path FROM items WHERE item_key = ?",
            (item_key,),
        ).fetchone()
        if not row:
            return {"deleted": False, "file_paths": []}

        file_rows = conn.execute(
            "SELECT file_path FROM files WHERE item_key = ?",
            (item_key,),
        ).fetchall()
        file_paths = [r["file_path"] for r in file_rows if r["file_path"]]
        if row["file_path"] and row["file_path"] not in file_paths:
            file_paths.append(row["file_path"])

        annotation_rows = conn.execute(
            "SELECT annotation_id FROM annotations WHERE item_key = ?",
            (item_key,),
        ).fetchall()
        annotation_ids = [r["annotation_id"] for r in annotation_rows]
        if annotation_ids:
            conn.execute(
                "DELETE FROM annotation_tags WHERE annotation_id IN (" +
                ",".join("?" for _ in annotation_ids) + ")",
                annotation_ids,
            )

        conn.execute("DELETE FROM suggestion_results WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM citation_edges WHERE source_item_key = ? OR target_item_key = ?", (item_key, item_key))
        conn.execute("DELETE FROM parsed_references WHERE source_item_key = ?", (item_key,))
        conn.execute("DELETE FROM citation_graph_item_status WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM chat_messages WHERE linked_item_key = ?", (item_key,))
        conn.execute("UPDATE chat_sessions SET linked_item_key = '' WHERE linked_item_key = ?", (item_key,))
        conn.execute("DELETE FROM chunks_fts WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM item_activity WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM item_fulltext WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM fulltext_pages WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM annotations WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM chunks WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM item_tags WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM item_creators WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM item_collections WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM files WHERE item_key = ?", (item_key,))
        conn.execute("DELETE FROM items WHERE item_key = ?", (item_key,))
        return {"deleted": True, "file_paths": file_paths}


def get_all_source_dirs() -> List[str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT source_dir FROM items WHERE source_dir != ''"
        ).fetchall()
        return [r["source_dir"] for r in rows]


def update_items_source_dir(old_dir: str, new_dir: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE items SET source_dir = ? WHERE source_dir = ?",
            (new_dir, old_dir),
        )


def _normalise_path(path: str) -> str:
    return str(Path(path).expanduser().resolve()) if path else ""


def _path_prefix_clauses(column: str, prefix: str, params: List[Any]) -> str:
    norm = _normalise_path(prefix)
    params.extend([norm, norm + "/%", norm + "\\%"])
    return f"({column} = ? OR {column} LIKE ? OR {column} LIKE ?)"


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def collection_key_for_path(path: str) -> str:
    return hashlib.md5(_normalise_path(path).encode()).hexdigest()[:12]


def _configured_source_dir_for_path(path: str, fallback: str = "") -> str:
    target = Path(path).expanduser().resolve()
    matches: List[str] = []
    for directory in config.reference_dirs:
        raw = directory.get("path", "")
        if not raw:
            continue
        root = Path(raw).expanduser().resolve()
        if target == root or _path_is_within(target, root):
            matches.append(str(root))
    if matches:
        return max(matches, key=len)
    return _normalise_path(fallback)


def _parent_collection_key_for_path(local_path: str, source_dir: str) -> str:
    if not local_path or not source_dir:
        return ""
    parent = Path(local_path).expanduser().resolve().parent
    root = Path(source_dir).expanduser().resolve()
    if parent == root or not _path_is_within(parent, root):
        return ""
    return collection_key_for_path(str(parent))


def _collection_keys_for_file_path(file_path: str, source_dir: str) -> List[str]:
    if not file_path or not source_dir:
        return ["root"]
    parent = Path(file_path).expanduser().resolve().parent
    root = Path(source_dir).expanduser().resolve()
    if parent == root:
        return ["root"]
    if not _path_is_within(parent, root):
        return ["root"]

    keys: List[str] = []
    while parent != root:
        keys.append(collection_key_for_path(str(parent)))
        parent = parent.parent
    return keys or ["root"]


def _set_item_collection_keys(conn: sqlite3.Connection, item_key: str, collection_keys: List[str]) -> None:
    clean_keys: List[str] = []
    for key in collection_keys or ["root"]:
        if key and key not in clean_keys:
            clean_keys.append(key)
    if not clean_keys:
        clean_keys = ["root"]

    conn.execute(
        "UPDATE items SET collection_keys = ? WHERE item_key = ?",
        (json.dumps(clean_keys), item_key),
    )
    conn.execute("DELETE FROM item_collections WHERE item_key = ?", (item_key,))
    for key in clean_keys:
        if key == "root":
            conn.execute(
                """INSERT OR IGNORE INTO collections_v2
                   (collection_key, name, parent_key, source_dir, local_path, collection_type)
                   VALUES ('root', 'Root', '', '', '', 'folder')"""
            )
        elif not conn.execute(
            "SELECT 1 FROM collections_v2 WHERE collection_key = ?",
            (key,),
        ).fetchone():
            continue
        conn.execute(
            "INSERT OR IGNORE INTO item_collections (item_key, collection_key) VALUES (?, ?)",
            (item_key, key),
        )


def set_item_collection_keys(item_key: str, collection_keys: List[str]) -> None:
    with get_connection() as conn:
        _set_item_collection_keys(conn, item_key, collection_keys)


def _replace_item_collection_keys_in_json(conn: sqlite3.Connection, key_map: Dict[str, str]) -> int:
    if not key_map:
        return 0
    updated = 0
    rows = conn.execute(
        "SELECT item_key, collection_keys FROM items "
        "WHERE collection_keys IS NOT NULL AND collection_keys != ''"
    ).fetchall()
    for row in rows:
        try:
            keys = json.loads(row["collection_keys"]) if isinstance(row["collection_keys"], str) else []
        except (json.JSONDecodeError, TypeError):
            continue
        changed = False
        next_keys: List[str] = []
        for key in keys or []:
            next_key = key_map.get(key, key)
            if next_key != key:
                changed = True
            if next_key and next_key not in next_keys:
                next_keys.append(next_key)
        if changed:
            conn.execute(
                "UPDATE items SET collection_keys = ? WHERE item_key = ?",
                (json.dumps(next_keys or ["root"]), row["item_key"]),
            )
            updated += 1
    return updated


def get_item_keys_for_file_path_prefix(path_prefix: str, source_dir: str = "") -> List[str]:
    params: List[Any] = []
    condition = _path_prefix_clauses("file_path", path_prefix, params)
    if source_dir:
        condition += " AND source_dir = ?"
        params.append(_normalise_path(source_dir))
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT item_key FROM items WHERE {condition}",
            params,
        ).fetchall()
        return [r["item_key"] for r in rows]


def refresh_item_collection_memberships_for_path_prefix(path_prefix: str, source_dir: str = "") -> int:
    params: List[Any] = []
    condition = _path_prefix_clauses("file_path", path_prefix, params)
    if source_dir:
        condition += " AND source_dir = ?"
        params.append(_normalise_path(source_dir))

    updated = 0
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT item_key, file_path, source_dir FROM items WHERE {condition}",
            params,
        ).fetchall()
        for row in rows:
            row_source_dir = _normalise_path(source_dir) or row["source_dir"] or _configured_source_dir_for_path(row["file_path"])
            if row_source_dir and row_source_dir != row["source_dir"]:
                conn.execute(
                    "UPDATE items SET source_dir = ? WHERE item_key = ?",
                    (row_source_dir, row["item_key"]),
                )
                conn.execute(
                    "UPDATE files SET source_dir = ? WHERE item_key = ?",
                    (row_source_dir, row["item_key"]),
                )
            keys = _collection_keys_for_file_path(row["file_path"], row_source_dir)
            _set_item_collection_keys(conn, row["item_key"], keys)
            updated += 1
    return updated


def update_item_file_path(item_key: str, old_prefix: str, new_prefix: str, new_source_dir: str = "") -> None:
    source_norm = _normalise_path(new_source_dir) if new_source_dir else ""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT file_path FROM items WHERE item_key = ?", (item_key,)
        ).fetchone()
        if row and row["file_path"] and row["file_path"].startswith(old_prefix):
            new_path = new_prefix + row["file_path"][len(old_prefix):]
            if source_norm:
                conn.execute(
                    "UPDATE items SET file_path = ?, source_dir = ? WHERE item_key = ?",
                    (new_path, source_norm, item_key),
                )
            else:
                conn.execute(
                    "UPDATE items SET file_path = ? WHERE item_key = ?",
                    (new_path, item_key),
                )
        conn.execute(
            """UPDATE files SET file_path = REPLACE(file_path, ?, ?)
               WHERE item_key = ? AND file_path LIKE ?""",
            (old_prefix, new_prefix, item_key, old_prefix + "%"),
        )
        if source_norm:
            conn.execute(
                "UPDATE files SET source_dir = ? WHERE item_key = ?",
                (source_norm, item_key),
            )
        else:
            conn.execute(
                """UPDATE files SET source_dir = REPLACE(source_dir, ?, ?)
                   WHERE item_key = ? AND source_dir LIKE ?""",
                (old_prefix, new_prefix, item_key, old_prefix + "%"),
            )


def update_items_file_paths_prefix(old_prefix: str, new_prefix: str, new_source_dir: str = "") -> int:
    updated = 0
    old_norm = _normalise_path(old_prefix)
    new_norm = _normalise_path(new_prefix)
    source_norm = _normalise_path(new_source_dir) if new_source_dir else ""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT item_key, file_path FROM items WHERE file_path = ? OR file_path LIKE ? OR file_path LIKE ?",
            (old_norm, old_norm + "/%", old_norm + "\\%"),
        ).fetchall()
        for row in rows:
            suffix = row["file_path"][len(old_norm):]
            new_path = new_norm + suffix
            if source_norm:
                conn.execute(
                    "UPDATE items SET file_path = ?, source_dir = ? WHERE item_key = ?",
                    (new_path, source_norm, row["item_key"]),
                )
            else:
                conn.execute(
                    "UPDATE items SET file_path = ? WHERE item_key = ?",
                    (new_path, row["item_key"]),
                )
            updated += 1
        conn.execute(
            "UPDATE files SET file_path = REPLACE(file_path, ?, ?) "
            "WHERE file_path = ? OR file_path LIKE ? OR file_path LIKE ?",
            (old_norm, new_norm, old_norm, old_norm + "/%", old_norm + "\\%"),
        )
        if source_norm:
            conn.execute(
                "UPDATE files SET source_dir = ? WHERE file_path = ? OR file_path LIKE ? OR file_path LIKE ?",
                (source_norm, new_norm, new_norm + "/%", new_norm + "\\%"),
            )
        else:
            conn.execute(
                "UPDATE files SET source_dir = REPLACE(source_dir, ?, ?) "
                "WHERE source_dir = ? OR source_dir LIKE ? OR source_dir LIKE ?",
                (old_norm, new_norm, old_norm, old_norm + "/%", old_norm + "\\%"),
            )
    return updated


def _replace_path_prefix_value(value: str, old_prefix: str, new_prefix: str) -> str:
    value_path = Path(value).expanduser().resolve()
    old_path = Path(old_prefix).expanduser().resolve()
    new_path = Path(new_prefix).expanduser().resolve()
    try:
        rel = value_path.relative_to(old_path)
        return str(new_path / rel) if rel.parts else str(new_path)
    except ValueError:
        old_norm = str(old_path)
        value_norm = str(value_path)
        if value_norm == old_norm:
            return str(new_path)
        for sep in ("/", "\\", os.sep):
            marker = old_norm + sep
            if value_norm.startswith(marker):
                return str(new_path) + value_norm[len(old_norm):]
        return value_norm


def _update_collection_path_tree(
    conn: sqlite3.Connection,
    old_path: str,
    new_path: str,
    collection_key: str = "",
) -> Dict[str, str]:
    old_norm = _normalise_path(old_path)
    new_norm = _normalise_path(new_path)
    old_key = collection_key or _find_collection_by_local_path(conn, old_path)
    if not old_key:
        logger.warning("update_collection_path: no collection found for %r", old_path)
        return {}

    root_row = conn.execute(
        "SELECT collection_key, local_path, source_dir FROM collections_v2 WHERE collection_key = ?",
        (old_key,),
    ).fetchone()
    if not root_row:
        logger.warning("update_collection_path: no row found for %r", old_key)
        return {}

    old_root_path = root_row["local_path"] or old_norm
    old_root_norm = _normalise_path(old_root_path)
    params: List[Any] = [old_key]
    prefix_condition = _path_prefix_clauses("local_path", old_root_norm, params)
    rows = conn.execute(
        f"""SELECT collection_key, local_path
            FROM collections_v2
            WHERE collection_key = ? OR {prefix_condition}
            ORDER BY LENGTH(local_path)""",
        params,
    ).fetchall()

    rows_by_key: Dict[str, sqlite3.Row] = {}
    for row in rows:
        rows_by_key[row["collection_key"]] = row

    source_dir = _configured_source_dir_for_path(new_norm, root_row["source_dir"] or "")
    key_map: Dict[str, str] = {}
    path_map: Dict[str, str] = {}
    for old_row_key, row in rows_by_key.items():
        row_old_path = row["local_path"] or old_root_norm
        row_new_path = _replace_path_prefix_value(row_old_path, old_root_norm, new_norm)
        new_key = collection_key_for_path(row_new_path)
        key_map[old_row_key] = new_key
        path_map[old_row_key] = row_new_path

    for old_row_key, row in rows_by_key.items():
        row_new_path = path_map[old_row_key]
        new_key = key_map[old_row_key]
        new_name = Path(row_new_path).name
        parent_key = _parent_collection_key_for_path(row_new_path, source_dir)
        conn.execute(
            """INSERT INTO collections_v2
                   (collection_key, name, parent_key, source_dir, local_path, collection_type)
               VALUES (?, ?, ?, ?, ?, 'folder')
               ON CONFLICT(collection_key) DO UPDATE SET
                   name = excluded.name,
                   parent_key = excluded.parent_key,
                   source_dir = excluded.source_dir,
                   local_path = excluded.local_path,
                   updated_at = CURRENT_TIMESTAMP""",
            (new_key, new_name, parent_key, source_dir, row_new_path),
        )
        conn.execute(
            """INSERT INTO collections (collection_key, name, parent_key)
               VALUES (?, ?, ?)
               ON CONFLICT(collection_key) DO UPDATE SET
                   name = excluded.name,
                   parent_key = excluded.parent_key""",
            (new_key, new_name, parent_key),
        )
        if new_key == old_row_key:
            continue
        conn.execute(
            """INSERT OR IGNORE INTO item_collections (item_key, collection_key)
               SELECT item_key, ? FROM item_collections WHERE collection_key = ?""",
            (new_key, old_row_key),
        )
        conn.execute("DELETE FROM item_collections WHERE collection_key = ?", (old_row_key,))

    for old_row_key, new_key in key_map.items():
        if new_key == old_row_key:
            continue
        conn.execute("DELETE FROM collections_v2 WHERE collection_key = ?", (old_row_key,))
        conn.execute("DELETE FROM collections WHERE collection_key = ?", (old_row_key,))

    _replace_item_collection_keys_in_json(conn, key_map)
    return key_map


def delete_collection_by_path(local_path: str) -> None:
    params: List[Any] = []
    condition = _path_prefix_clauses("local_path", local_path, params)
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT collection_key FROM collections_v2 WHERE {condition}",
            params,
        ).fetchall()
        keys = [r["collection_key"] for r in rows]
        conn.execute("DELETE FROM item_collections WHERE collection_key IN (" +
                     ",".join("?" for _ in keys) + ")", keys) if keys else None
        conn.execute(f"DELETE FROM collections_v2 WHERE {condition}", params)
        for k in keys:
            conn.execute("DELETE FROM collections WHERE collection_key = ?", (k,))


def _rename_collection_in_db(collection_key: str, old_path: str, new_path: str) -> Dict[str, str]:
    with get_connection() as conn:
        return _update_collection_path_tree(conn, old_path, new_path, collection_key)


def _find_collection_by_local_path(conn, path: str) -> Optional[str]:
    candidates = [path]
    from pathlib import Path as P
    try:
        resolved = str(P(path).resolve())
        if resolved != path:
            candidates.append(resolved)
    except Exception:
        pass
    for c in candidates:
        row = conn.execute(
            "SELECT collection_key FROM collections_v2 WHERE local_path = ?",
            (c,),
        ).fetchone()
        if row:
            return row["collection_key"]
    for c in candidates:
        like = c + "/%"
        row = conn.execute(
            "SELECT collection_key FROM collections_v2 WHERE local_path LIKE ? LIMIT 1",
            (like,),
        ).fetchone()
        if row:
            return row["collection_key"]
    return None


def update_collection_path(old_path: str, new_path: str) -> Dict[str, str]:
    with get_connection() as conn:
        return _update_collection_path_tree(conn, old_path, new_path)


def backfill_source_dirs(dir_paths: List[str]) -> int:
    from pathlib import Path as P
    normalized = []
    for dp in dir_paths:
        norm = str(P(dp).expanduser().resolve())
        normalized.append(norm)

    updated = 0
    with get_connection() as conn:
        empty_rows = conn.execute(
            "SELECT item_key, file_path FROM items WHERE source_dir = ''"
        ).fetchall()

        for row in empty_rows:
            fp = row["file_path"] or ""
            for nd in normalized:
                if fp.startswith(nd + "/") or fp.startswith(nd):
                    conn.execute(
                        "UPDATE items SET source_dir = ? WHERE item_key = ?",
                        (nd, row["item_key"]),
                    )
                    updated += 1
                    break

        conn.execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES ('source_dir_backfilled', '1')"
        )

    return updated


def is_source_dir_backfilled() -> bool:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT value FROM app_config WHERE key = 'source_dir_backfilled'"
        ).fetchone()
        return row is not None and row["value"] == "1"


# ── V2-specific operations ───────────────────────────────────────────────────


def get_item_v2(item_key: str) -> Optional[Dict]:
    """Get item with V2 enriched data: creators, tags, files, collections."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM items WHERE item_key = ?", (item_key,)
        ).fetchone()
        if not row:
            return None

        item = dict(row)

        creators = conn.execute(
            """SELECT c.first_name, c.last_name, c.name, ic.creator_type, ic.position
               FROM item_creators ic
               JOIN creators c ON ic.creator_id = c.creator_id
               WHERE ic.item_key = ?
               ORDER BY ic.position""",
            (item_key,)
        ).fetchall()
        item["creators_list"] = [dict(c) for c in creators]

        tags = conn.execute(
            """SELECT t.name, t.color
               FROM item_tags it
               JOIN tags t ON it.tag_id = t.tag_id
               WHERE it.item_key = ?""",
            (item_key,)
        ).fetchall()
        item["tags_list"] = [dict(t) for t in tags]

        files = conn.execute(
            "SELECT * FROM files WHERE item_key = ? ORDER BY is_primary DESC, file_id",
            (item_key,)
        ).fetchall()
        item["files"] = [dict(f) for f in files]

        collections = conn.execute(
            """SELECT cv.*
               FROM item_collections ic
               JOIN collections_v2 cv ON ic.collection_key = cv.collection_key
               WHERE ic.item_key = ?""",
            (item_key,)
        ).fetchall()
        item["collections"] = [dict(c) for c in collections]

        activity = conn.execute(
            """SELECT opened_at, open_count, is_favorite, favorite_at,
                      COALESCE(reading_status, '') AS reading_status
               FROM item_activity WHERE item_key = ?""",
            (item_key,)
        ).fetchone()
        if activity:
            item.update(dict(activity))
            item["is_favorite"] = bool(item.get("is_favorite"))
        else:
            item["opened_at"] = None
            item["open_count"] = 0
            item["is_favorite"] = False
            item["favorite_at"] = None
            item["reading_status"] = ""

        return item


def get_item_notes(item_key: str) -> Optional[Dict[str, str]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT item_key, notes, note_connections FROM items WHERE item_key = ?",
            (item_key,),
        ).fetchone()
        if not row:
            return None
        return {
            "item_key": row["item_key"],
            "notes": row["notes"] or "",
            "note_connections": row["note_connections"] or "[]",
        }


def patch_item_notes(item_key: str, data: Dict[str, Any]) -> bool:
    allowed = {
        "notes": lambda v: v or "",
        "note_connections": lambda v: v or "[]",
    }
    updates = []
    values = []
    for key, normalize in allowed.items():
        if key not in data:
            continue
        updates.append(f"{key} = ?")
        values.append(normalize(data.get(key)))

    if not updates:
        return get_item_notes(item_key) is not None

    updates.append("synced_at = CURRENT_TIMESTAMP")
    values.append(item_key)
    with get_connection() as conn:
        cursor = conn.execute(
            f"UPDATE items SET {', '.join(updates)} WHERE item_key = ?",
            tuple(values),
        )
        return cursor.rowcount > 0


def get_library_tree() -> List[Dict]:
    """Get directory/collection tree for library browsing with full nested hierarchy."""
    with get_connection() as conn:
        dirs = conn.execute(
            """SELECT source_dir FROM (
                   SELECT DISTINCT source_dir FROM items WHERE source_dir != ''
                   UNION
                   SELECT DISTINCT source_dir FROM collections_v2 WHERE source_dir != ''
               )
               ORDER BY source_dir"""
        ).fetchall()
        count_rows = conn.execute(
            """SELECT source_dir, COUNT(*) AS cnt
               FROM items
               WHERE source_dir != ''
               GROUP BY source_dir"""
        ).fetchall()
        item_counts = {row["source_dir"]: row["cnt"] for row in count_rows}
        collection_rows = conn.execute(
            """SELECT cv.source_dir, cv.collection_key, cv.name, cv.parent_key, cv.local_path,
                      COUNT(DISTINCT ic.item_key) AS item_count
               FROM collections_v2 cv
               LEFT JOIN item_collections ic ON cv.collection_key = ic.collection_key
               WHERE cv.source_dir != '' AND cv.collection_key != 'root'
               GROUP BY cv.source_dir, cv.collection_key
               ORDER BY cv.source_dir, cv.name"""
        ).fetchall()
        collections_by_source: Dict[str, List[sqlite3.Row]] = {}
        for row in collection_rows:
            collections_by_source.setdefault(row["source_dir"], []).append(row)

        tree = []
        for d in dirs:
            source_dir = d["source_dir"]
            item_count = item_counts.get(source_dir, 0)
            rows = collections_by_source.get(source_dir, [])

            col_map: Dict[str, Dict] = {}
            for r in rows:
                col_map[r["collection_key"]] = {
                    "collection_key": r["collection_key"],
                    "name": r["name"],
                    "parent_key": r["parent_key"] or "",
                    "local_path": r["local_path"] or "",
                    "item_count": r["item_count"],
                    "children": [],
                }

            roots: List[Dict] = []
            for col in col_map.values():
                pk = col["parent_key"]
                if pk and pk in col_map:
                    col_map[pk]["children"].append(col)
                else:
                    roots.append(col)

            roots.sort(key=lambda c: c["name"].lower())

            tree.append({
                "source_dir": source_dir,
                "item_count": item_count,
                "collections": roots,
            })

        return tree


def get_library_items(
    source_dir: str = "",
    collection_key: str = "",
    query: str = "",
    sort_by: str = "title",
    sort_order: str = "asc",
    limit: int = 100,
    offset: int = 0,
    activity_filter: str = "",
) -> Dict:
    """Browse/filter library items with V2 data."""
    conditions = []
    params: Dict[str, Any] = {"limit": limit, "offset": offset}

    if source_dir:
        conditions.append("i.source_dir = :source_dir")
        params["source_dir"] = source_dir

    if collection_key:
        conditions.append("ic.collection_key = :collection_key")
        params["collection_key"] = collection_key

    if query:
        conditions.append(
            "(LOWER(i.title) LIKE :q OR LOWER(i.creators) LIKE :q OR LOWER(i.doi) LIKE :q OR i.year = :qy)"
        )
        params["q"] = f"%{query.lower()}%"
        params["qy"] = query

    join_clauses = "FROM items i LEFT JOIN item_activity ia ON i.item_key = ia.item_key"
    if collection_key:
        join_clauses += " LEFT JOIN item_collections ic ON i.item_key = ic.item_key"

    if activity_filter == "recent":
        conditions.append("ia.opened_at IS NOT NULL")
    elif activity_filter == "favorite":
        conditions.append("COALESCE(ia.is_favorite, 0) = 1")

    where_clause = ""
    if conditions:
        where_clause = "WHERE " + " AND ".join(conditions)

    valid_sort = {"title", "year", "item_type", "source_dir", "doi", "creators", "synced_at", "citation_count", "opened_at"}
    if sort_by not in valid_sort:
        sort_by = "title"
    if sort_order not in ("asc", "desc"):
        sort_order = "asc"
    if sort_by == "opened_at":
        order_expr = f"ia.opened_at {sort_order}, i.title ASC"
    elif activity_filter == "recent" and sort_by == "title":
        order_expr = "ia.opened_at DESC, i.title ASC"
    else:
        order_expr = f"i.{sort_by} {sort_order}"

    with get_connection() as conn:
        count_row = conn.execute(
            f"SELECT COUNT(DISTINCT i.item_key) {join_clauses} {where_clause}",
            params,
        ).fetchone()
        total = count_row[0] if count_row else 0

        rows = conn.execute(
            f"""SELECT DISTINCT i.*,
                       ia.opened_at, COALESCE(ia.open_count, 0) AS open_count,
                       COALESCE(ia.is_favorite, 0) AS is_favorite, ia.favorite_at,
                       COALESCE(ia.reading_status, '') AS reading_status
                {join_clauses} {where_clause}
                ORDER BY {order_expr}
                LIMIT :limit OFFSET :offset""",
            params,
        ).fetchall()

        items = []
        item_keys = [r["item_key"] for r in rows]
        tags_by_item: Dict[str, List[Dict]] = {}
        keywords_by_item: Dict[str, List[str]] = {}
        ann_counts_by_item: Dict[str, int] = {}
        files_by_item: Dict[str, List[Dict]] = {}

        if item_keys:
            placeholders = ",".join("?" for _ in item_keys)

            tag_rows = conn.execute(
                f"""SELECT it.item_key, t.name, t.color
                    FROM item_tags it
                    JOIN tags t ON it.tag_id = t.tag_id
                    WHERE it.item_key IN ({placeholders})
                    ORDER BY t.name""",
                item_keys,
            ).fetchall()
            for tag_row in tag_rows:
                tags_by_item.setdefault(tag_row["item_key"], []).append({
                    "name": tag_row["name"],
                    "color": tag_row["color"],
                })

            keyword_rows = conn.execute(
                f"""SELECT it.item_key, t.name
                    FROM item_tags it
                    JOIN tags t ON it.tag_id = t.tag_id
                    WHERE it.item_key IN ({placeholders})
                      AND t.tag_type = 'keyword'
                    ORDER BY t.name""",
                item_keys,
            ).fetchall()
            for keyword_row in keyword_rows:
                keywords_by_item.setdefault(keyword_row["item_key"], []).append(keyword_row["name"])

            ann_rows = conn.execute(
                f"""SELECT item_key, COUNT(*) AS cnt
                    FROM annotations
                    WHERE item_key IN ({placeholders})
                    GROUP BY item_key""",
                item_keys,
            ).fetchall()
            ann_counts_by_item = {r["item_key"]: r["cnt"] for r in ann_rows}

            file_rows = conn.execute(
                f"""SELECT item_key, file_id, file_path, file_name, file_ext
                    FROM files
                    WHERE item_key IN ({placeholders})
                    ORDER BY item_key, is_primary DESC, file_id""",
                item_keys,
            ).fetchall()
            for file_row in file_rows:
                files_by_item.setdefault(file_row["item_key"], []).append({
                    "file_id": file_row["file_id"],
                    "file_path": file_row["file_path"],
                    "file_name": file_row["file_name"],
                    "file_ext": file_row["file_ext"],
                })

        for row in rows:
            item = dict(row)
            item["is_favorite"] = bool(item.get("is_favorite"))
            creators_raw = item.get("creators", "[]")
            try:
                creators = json.loads(creators_raw) if isinstance(creators_raw, str) else []
            except (json.JSONDecodeError, TypeError):
                creators = []
            item["creators_list"] = creators
            item_key = item["item_key"]
            item["tags_list"] = tags_by_item.get(item_key, [])
            item["keywords"] = keywords_by_item.get(item_key, [])
            item["annotation_count"] = ann_counts_by_item.get(item_key, 0)
            item["files"] = files_by_item.get(item_key, [])

            items.append(item)

        return {"items": items, "total": total, "limit": limit, "offset": offset}


from app.repositories.annotations import (
    create_annotation,
    create_tag,
    delete_annotation,
    delete_tag,
    get_all_annotations_for_synthesis,
    get_all_tags,
    get_annotations_for_item,
    get_item_keywords,
    get_tags_for_annotation,
    import_item_annotations,
    set_annotation_tags,
    update_annotation,
    update_tag,
)

from app.repositories.projects import (
    add_annotation_to_project,
    add_item_to_project,
    add_theme_root_to_project,
    auto_code_annotation,
    create_project,
    delete_project,
    get_project,
    get_project_codebook_tag_ids,
    get_project_detail,
    get_project_theme_roots,
    get_projects_for_item,
    list_projects,
    patch_project,
    remove_annotation_from_project,
    remove_item_from_project,
    remove_theme_root_from_project,
    suggest_themes_for_annotation,
    update_project,
)


def _replace_item_creators(conn: sqlite3.Connection, item_key: str, creators: List[Dict[str, Any]]) -> None:
    conn.execute("DELETE FROM item_creators WHERE item_key = ?", (item_key,))
    for pos, c in enumerate(creators):
        first = c.get("firstName", c.get("first_name", "")) or ""
        last = c.get("lastName", c.get("last_name", "")) or ""
        name = c.get("name", "") or ""
        ctype = c.get("creatorType", c.get("creator_type", "author")) or "author"
        normalized = f"{last}, {first}".strip(", ") if last else name
        if not normalized:
            continue

        creator_row = conn.execute(
            "SELECT creator_id FROM creators WHERE normalized_name = ?",
            (normalized,),
        ).fetchone()
        if not creator_row:
            conn.execute(
                """INSERT INTO creators (first_name, last_name, name, normalized_name)
                   VALUES (?, ?, ?, ?)""",
                (first, last, name, normalized),
            )
            creator_row = conn.execute(
                "SELECT creator_id FROM creators WHERE normalized_name = ?",
                (normalized,),
            ).fetchone()
        if creator_row:
            conn.execute(
                """INSERT OR IGNORE INTO item_creators
                   (item_key, creator_id, creator_type, position)
                   VALUES (?, ?, ?, ?)""",
                (item_key, creator_row["creator_id"], ctype, pos),
            )


def update_item_metadata(item_key: str, updates: Dict[str, Any]) -> None:
    """Update editable item metadata fields and keep creator tables in sync."""
    allowed_fields = {
        "title", "year", "item_type", "publication_title", "doi", "url",
        "abstract", "volume", "issue", "pages", "publisher", "place",
        "edition", "isbn", "issn", "extra", "creators",
        "citation_count", "citation_count_updated_at",
    }
    filtered = {k: v for k, v in updates.items() if k in allowed_fields}
    if not filtered:
        return

    creators_raw = filtered.get("creators")
    creators: Optional[List[Dict[str, Any]]] = None
    if creators_raw is not None:
        if isinstance(creators_raw, str):
            try:
                creators = json.loads(creators_raw)
            except (json.JSONDecodeError, TypeError):
                creators = []
        elif isinstance(creators_raw, list):
            creators = creators_raw
        else:
            creators = []
        filtered["creators"] = json.dumps(creators)

    with get_connection() as conn:
        if filtered:
            set_clauses = ", ".join(f"{k} = :{k}" for k in filtered)
            filtered["item_key"] = item_key
            conn.execute(
                f"UPDATE items SET {set_clauses}, synced_at = CURRENT_TIMESTAMP WHERE item_key = :item_key",
                filtered,
            )
        if creators is not None:
            _replace_item_creators(conn, item_key, creators)


def update_item_citation_count(item_key: str, citation_count: int, updated_at: str = "") -> None:
    """Update Crossref cited-by count without rewriting bibliographic metadata."""
    try:
        count = max(0, int(citation_count))
    except (TypeError, ValueError):
        count = 0
    with get_connection() as conn:
        conn.execute(
            """UPDATE items
               SET citation_count = ?, citation_count_updated_at = ?
               WHERE item_key = ?""",
            (count, updated_at or "", item_key),
        )


def get_items_for_citation_count_refresh(stale_days: int = 30, limit: int = 500) -> List[Dict[str, Any]]:
    """Return DOI-backed items whose Crossref cited-by count is missing or stale."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, stale_days))
    candidates: List[Dict[str, Any]] = []
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT item_key, doi, citation_count, citation_count_updated_at
               FROM items
               WHERE COALESCE(doi, '') <> ''
               ORDER BY
                   CASE WHEN COALESCE(citation_count_updated_at, '') = '' THEN 0 ELSE 1 END,
                   citation_count_updated_at ASC
               LIMIT ?""",
            (max(1, limit),),
        ).fetchall()

    for row in rows:
        item = dict(row)
        updated_raw = item.get("citation_count_updated_at") or ""
        if not updated_raw:
            candidates.append(item)
            continue
        try:
            updated_at = datetime.fromisoformat(updated_raw.replace("Z", "+00:00"))
            if updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=timezone.utc)
            if updated_at < cutoff:
                candidates.append(item)
        except ValueError:
            candidates.append(item)
    return candidates


from app.repositories.history import (
    add_chat_message,
    add_suggestion_result,
    create_chat_session,
    create_suggestion_run,
    delete_all_chat_sessions,
    delete_all_suggestion_runs,
    delete_chat_session,
    delete_suggestion_run,
    get_chat_messages,
    get_chat_sessions,
    get_feedback_stats,
    get_suggestion_run,
    get_suggestion_runs,
    set_suggestion_feedback,
    update_chat_session,
)
