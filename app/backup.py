"""
Workspace backup and restore helpers.

The backup format is intentionally small and restore-focused: a consistent
SQLite snapshot, settings JSON, and a manifest. Rebuildable indexes such as
Chroma are excluded so backups stay portable across app versions.
"""

import io
import json
import logging
import shutil
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, Optional, Tuple

from app.config import DATA_DIR, SETTINGS_FILE, config, get_settings, save_settings

logger = logging.getLogger(__name__)

BACKUP_FORMAT = "tarcite-workspace-backup"
BACKUP_FORMAT_VERSION = 1
MAX_RESTORE_BYTES = 500 * 1024 * 1024


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _count_table(conn: sqlite3.Connection, table: str) -> int:
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    except sqlite3.Error:
        return 0


def _schema_version(conn: sqlite3.Connection) -> Optional[int]:
    try:
        row = conn.execute(
            "SELECT value FROM app_config WHERE key = 'schema_version'"
        ).fetchone()
        return int(row[0]) if row else None
    except (sqlite3.Error, TypeError, ValueError):
        return None


def _database_counts(db_path: Path) -> Dict[str, int]:
    if not db_path.exists():
        return {"items": 0, "annotations": 0, "tags": 0, "files": 0}
    with sqlite3.connect(str(db_path)) as conn:
        return {
            "items": _count_table(conn, "items"),
            "annotations": _count_table(conn, "annotations"),
            "tags": _count_table(conn, "tags"),
            "files": _count_table(conn, "files"),
        }


def _database_schema_version(db_path: Path) -> Optional[int]:
    if not db_path.exists():
        return None
    with sqlite3.connect(str(db_path)) as conn:
        return _schema_version(conn)


def _copy_sqlite_snapshot(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        with sqlite3.connect(str(destination)):
            return
    with sqlite3.connect(str(source)) as src, sqlite3.connect(str(destination)) as dst:
        src.backup(dst)


def _settings_payload() -> Dict[str, Any]:
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("Could not read settings file during backup; using loaded settings")
    return get_settings()


def create_workspace_backup(app_version: str) -> Tuple[io.BytesIO, str, Dict[str, Any]]:
    """Return a zip buffer, filename, and manifest for the current workspace."""
    db_path = Path(config.db_path)
    stamp = _utc_stamp()
    filename = f"tarcite_workspace_backup_{stamp}.zip"

    with TemporaryDirectory(prefix="tarcite-backup-") as tmp:
        snapshot_path = Path(tmp) / "local_citation.sqlite"
        _copy_sqlite_snapshot(db_path, snapshot_path)

        settings_payload = _settings_payload()
        counts = _database_counts(snapshot_path)
        manifest: Dict[str, Any] = {
            "format": BACKUP_FORMAT,
            "format_version": BACKUP_FORMAT_VERSION,
            "app": "TarCite Workspace",
            "app_version": app_version,
            "created_at": _utc_iso(),
            "schema_version": _database_schema_version(snapshot_path),
            "includes": {
                "database": True,
                "settings": True,
                "chroma_index": False,
            },
            "counts": counts,
            "notes": [
                "Chroma/vector indexes are not included because they can be rebuilt by scanning the library.",
                "External PDF/document files remain in their original reference directories.",
            ],
        }

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
            zf.write(snapshot_path, "database/local_citation.sqlite")
            zf.writestr("settings/settings.json", json.dumps(settings_payload, indent=2))
        buf.seek(0)
        return buf, filename, manifest


def _read_zip_member(zf: zipfile.ZipFile, *names: str) -> Optional[bytes]:
    available = set(zf.namelist())
    for name in names:
        if name in available:
            return zf.read(name)
    return None


def _validate_backup(raw: bytes) -> Tuple[Dict[str, Any], bytes, Optional[Dict[str, Any]]]:
    if len(raw) > MAX_RESTORE_BYTES:
        raise ValueError("Backup file is too large.")
    try:
        with zipfile.ZipFile(io.BytesIO(raw), "r") as zf:
            manifest_raw = _read_zip_member(zf, "manifest.json")
            if not manifest_raw:
                raise ValueError("Backup manifest is missing.")
            manifest = json.loads(manifest_raw.decode("utf-8"))
            if manifest.get("format") != BACKUP_FORMAT:
                raise ValueError("This is not a TarCite Workspace backup.")
            if int(manifest.get("format_version", 0)) > BACKUP_FORMAT_VERSION:
                raise ValueError("Backup was created by a newer unsupported format.")

            db_raw = _read_zip_member(
                zf,
                "database/local_citation.sqlite",
                "local_citation.sqlite",
            )
            if not db_raw:
                raise ValueError("Backup database is missing.")

            settings = None
            settings_raw = _read_zip_member(zf, "settings/settings.json", "settings.json")
            if settings_raw:
                settings = json.loads(settings_raw.decode("utf-8"))
                if not isinstance(settings, dict):
                    raise ValueError("Backup settings are invalid.")
            return manifest, db_raw, settings
    except zipfile.BadZipFile as exc:
        raise ValueError("Backup file is not a valid zip archive.") from exc
    except json.JSONDecodeError as exc:
        raise ValueError("Backup metadata is invalid JSON.") from exc


def _validate_sqlite_database(db_raw: bytes) -> Dict[str, Any]:
    from app.database import V2_SCHEMA_VERSION

    with TemporaryDirectory(prefix="tarcite-restore-check-") as tmp:
        db_path = Path(tmp) / "restore.sqlite"
        db_path.write_bytes(db_raw)
        with sqlite3.connect(str(db_path)) as conn:
            integrity = conn.execute("PRAGMA quick_check").fetchone()[0]
            if integrity != "ok":
                raise ValueError(f"Backup database failed integrity check: {integrity}")
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')"
                ).fetchall()
            }
            required = {"items", "annotations", "tags", "annotation_tags"}
            missing = sorted(required - tables)
            if missing:
                raise ValueError("Backup database is missing required tables: " + ", ".join(missing))
            schema_version = _schema_version(conn)
            if schema_version and schema_version > V2_SCHEMA_VERSION:
                raise ValueError(
                    "Backup database was created by a newer TarCite database schema. "
                    "Upgrade this app before restoring it."
                )
            return {
                "schema_version": schema_version,
                "counts": {
                    "items": _count_table(conn, "items"),
                    "annotations": _count_table(conn, "annotations"),
                    "tags": _count_table(conn, "tags"),
                    "files": _count_table(conn, "files"),
                },
            }


def _checkpoint_current_database(db_path: Path) -> None:
    if not db_path.exists():
        return
    try:
        with sqlite3.connect(str(db_path)) as conn:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.Error as exc:
        logger.warning("Could not checkpoint database before restore: %s", exc)


def _remove_sqlite_sidecars(db_path: Path) -> None:
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(db_path) + suffix)
        try:
            sidecar.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Could not remove SQLite sidecar %s: %s", sidecar, exc)


def restore_workspace_backup(raw: bytes, app_version: str) -> Dict[str, Any]:
    """Restore workspace data from a backup zip and return restore metadata."""
    manifest, db_raw, settings = _validate_backup(raw)
    db_meta = _validate_sqlite_database(db_raw)

    safety_buf, safety_filename, _ = create_workspace_backup(app_version)
    backup_dir = DATA_DIR / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    safety_path = backup_dir / f"pre_restore_{safety_filename}"
    safety_path.write_bytes(safety_buf.getvalue())

    db_path = Path(config.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    _checkpoint_current_database(db_path)
    _remove_sqlite_sidecars(db_path)

    with TemporaryDirectory(prefix="tarcite-restore-") as tmp:
        restore_db = Path(tmp) / "local_citation.sqlite"
        restore_db.write_bytes(db_raw)
        shutil.copy2(restore_db, db_path)

    if settings is not None:
        save_settings(settings)
    config.reload()

    return {
        "status": "restored",
        "restored_at": _utc_iso(),
        "source_created_at": manifest.get("created_at"),
        "source_app_version": manifest.get("app_version"),
        "schema_version": db_meta.get("schema_version"),
        "counts": db_meta.get("counts", {}),
        "safety_backup": str(safety_path),
        "index_note": "Vector indexes are rebuildable and were not restored. Run a scan if search results look stale.",
    }


def get_workspace_backup_status() -> Dict[str, Any]:
    db_path = Path(config.db_path)
    settings_path = SETTINGS_FILE
    return {
        "database_path": str(db_path),
        "settings_path": str(settings_path),
        "database_exists": db_path.exists(),
        "settings_exists": settings_path.exists(),
        "schema_version": _database_schema_version(db_path),
        "counts": _database_counts(db_path),
        "backup_dir": str(DATA_DIR / "backups"),
    }
