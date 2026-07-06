"""File upload, folder management, and item file operation routes."""

import logging
import platform
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.config import config
from app.database import (
    _rename_collection_in_db,
    collection_key_for_path,
    delete_item,
    delete_collection_by_path,
    get_item_keys_for_file_path_prefix,
    get_items_batch,
    refresh_item_collection_memberships_for_path_prefix,
    set_item_collection_keys,
    update_collection_path,
    update_item_file_path,
    update_items_file_paths_prefix,
    upsert_collection,
)
from app.schemas import (
    CopyItemsRequest,
    CreateFolderRequest,
    DeleteFolderRequest,
    MoveFolderRequest,
    MoveItemsRequest,
    RenameFolderRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["files"])

SUPPORTED_UPLOAD_EXTENSIONS = {
    ".pdf",
    ".ris",
    ".bib",
    ".bibtex",
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".docx",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".tiff",
    ".tif",
}


def _validate_upload_file(file: UploadFile) -> None:
    if not file.filename or Path(file.filename).suffix.lower() not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Supported: PDF, images (PNG/JPG/WebP/GIF/BMP/TIFF), Word (.docx), TXT, Markdown, CSV, RIS, BibTeX.",
        )


async def _save_uploaded_file(file: UploadFile, target: Path) -> Path:
    _validate_upload_file(file)
    dest = target / file.filename
    counter = 1
    while dest.exists():
        stem = Path(file.filename).stem
        suffix = Path(file.filename).suffix
        dest = target / f"{stem}_{counter}{suffix}"
        counter += 1

    try:
        content = await file.read()
        dest.write_bytes(content)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save file '{file.filename}': {exc}")
    return dest


def _source_dir_for_upload_target(target: Path) -> str:
    sync_dir = str(target)
    matches = []
    for directory in config.reference_dirs:
        directory_path = Path(directory.get("path", "")).expanduser().resolve()
        if target == directory_path or target.is_relative_to(directory_path):
            matches.append(str(directory_path))
    if matches:
        sync_dir = max(matches, key=len)
    return sync_dir


def _start_index_files(file_paths: List[Path], sync_dir: str) -> None:
    if not file_paths:
        return

    def _index_files() -> None:
        from app.sync import sync_single_file

        for dest in file_paths:
            try:
                sync_single_file(str(dest), sync_dir)
            except Exception as exc:
                logger.error("Single file index error for %s: %s", dest, exc)

    thread = threading.Thread(target=_index_files, daemon=True)
    thread.start()


@router.post("/api/open-directory")
def open_directory(body: Dict[str, Any]) -> Dict:
    dir_path = body.get("path", "")
    if not dir_path:
        raise HTTPException(status_code=400, detail="No directory path provided.")
    target = Path(dir_path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {dir_path}")
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.Popen(["open", str(target)])
        elif system == "Windows":
            subprocess.Popen(["explorer", str(target)])
        elif system == "Linux":
            subprocess.Popen(["xdg-open", str(target)])
        else:
            raise RuntimeError(f"Unsupported platform: {system}")
        return {"status": "opened", "path": dir_path}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to open directory: {exc}")


@router.post("/api/upload-file")
@router.post("/api/upload-pdf")
async def upload_file(file: UploadFile, target_dir: str) -> Dict:
    target = Path(target_dir).expanduser().resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {target_dir}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {target_dir}")

    dest = await _save_uploaded_file(file, target)
    sync_dir = _source_dir_for_upload_target(target)
    _start_index_files([dest], sync_dir)

    return {
        "status": "success",
        "file_path": str(dest),
        "sync_started": True,
    }


@router.post("/api/upload-files")
async def upload_files(files: List[UploadFile] = File(...), target_dir: str = "") -> Dict:
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    target = Path(target_dir).expanduser().resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {target_dir}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {target_dir}")

    saved: List[Path] = []
    for file in files:
        _validate_upload_file(file)

    for file in files:
        saved.append(await _save_uploaded_file(file, target))

    sync_dir = _source_dir_for_upload_target(target)
    _start_index_files(saved, sync_dir)

    return {
        "status": "success",
        "file_paths": [str(path) for path in saved],
        "count": len(saved),
        "sync_started": True,
    }


def _validate_folder_in_library(folder_path: str) -> Path:
    target = Path(folder_path).expanduser().resolve()
    if not target.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Folder not found on disk. It may have been moved or deleted outside the app. Try re-scanning the library. Path: {folder_path}",
        )
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {folder_path}")
    norm = str(target)
    for directory in config.reference_dirs:
        directory_path = str(Path(directory.get("path", "")).expanduser().resolve())
        if norm == directory_path or norm.startswith(directory_path + "/") or norm.startswith(directory_path + "\\"):
            return target
    raise HTTPException(
        status_code=403,
        detail="This folder is not inside any configured library directory.",
    )


def _find_source_dir_for_path(target: Path) -> str:
    norm = str(target)
    matches = []
    for directory in config.reference_dirs:
        directory_path = str(Path(directory.get("path", "")).expanduser().resolve())
        if norm == directory_path or norm.startswith(directory_path + "/") or norm.startswith(directory_path + "\\"):
            matches.append(directory_path)
    return max(matches, key=len) if matches else ""


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _collection_keys_for_directory(folder_path: Path, source_dir: str) -> List[str]:
    root = Path(source_dir).expanduser().resolve()
    folder = folder_path.expanduser().resolve()
    if folder == root or not _path_is_within(folder, root):
        return ["root"]
    keys: List[str] = []
    current = folder
    while current != root:
        keys.append(collection_key_for_path(str(current)))
        current = current.parent
    return keys or ["root"]


def _upsert_folder_chain(folder_path: Path) -> Dict[str, Any]:
    folder = folder_path.expanduser().resolve()
    source_dir = _find_source_dir_for_path(folder)
    if not source_dir:
        raise HTTPException(status_code=403, detail="This folder is not inside any configured library directory.")

    root = Path(source_dir).expanduser().resolve()
    if folder == root:
        return {
            "source_dir": source_dir,
            "collection_key": "",
            "parent_collection_key": "",
            "collection_keys": ["root"],
        }

    chain: List[Path] = []
    current = folder
    while current != root:
        chain.append(current)
        current = current.parent
    chain.reverse()

    parent_key = ""
    last_key = ""
    for path in chain:
        key = collection_key_for_path(str(path))
        upsert_collection({
            "collection_key": key,
            "name": path.name,
            "parent_key": parent_key,
            "source_dir": source_dir,
            "path": str(path),
        })
        last_key = key
        parent_key = key

    parent_collection_key = collection_key_for_path(str(chain[-2])) if len(chain) > 1 else ""
    return {
        "source_dir": source_dir,
        "collection_key": last_key,
        "parent_collection_key": parent_collection_key,
        "collection_keys": _collection_keys_for_directory(folder, source_dir),
    }


def _delete_items_from_indexes(item_keys: List[str]) -> None:
    if not item_keys:
        return
    try:
        from app.embeddings import delete_item_chunks, get_chroma_client, get_or_create_collection

        client = get_chroma_client()
        collection = get_or_create_collection(client)
    except Exception as exc:
        logger.warning("Could not open ChromaDB for folder delete cleanup: %s", exc)
        collection = None

    for item_key in item_keys:
        try:
            if collection is not None:
                delete_item_chunks(collection, item_key)
        except Exception as exc:
            logger.warning("Could not delete ChromaDB chunks for %s: %s", item_key, exc)
        try:
            delete_item(item_key)
        except Exception as exc:
            logger.warning("Could not delete DB item %s after folder delete: %s", item_key, exc)


@router.post("/api/folders/create")
def create_folder_route(body: CreateFolderRequest) -> Dict:
    parent = Path(body.parent_path).expanduser().resolve()
    if not parent.exists() or not parent.is_dir():
        raise HTTPException(status_code=404, detail=f"Parent directory not found: {body.parent_path}")
    _validate_folder_in_library(str(parent))

    folder_name = body.folder_name.strip()
    if not folder_name or "/" in folder_name or "\\" in folder_name:
        raise HTTPException(status_code=400, detail="Invalid folder name.")

    new_path = parent / folder_name
    if new_path.exists():
        raise HTTPException(status_code=409, detail=f"A folder named '{folder_name}' already exists.")

    try:
        new_path.mkdir(parents=False, exist_ok=False)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not create folder: {exc}")

    collection = _upsert_folder_chain(new_path)
    return {
        "status": "created",
        "path": str(new_path),
        "name": folder_name,
        **collection,
    }


@router.post("/api/folders/rename")
def rename_folder_route(body: RenameFolderRequest) -> Dict:
    target = _validate_folder_in_library(body.folder_path)
    new_name = body.new_name.strip()
    if not new_name or "/" in new_name or "\\" in new_name:
        raise HTTPException(status_code=400, detail="Invalid folder name.")

    new_path = target.parent / new_name
    if new_path.exists():
        raise HTTPException(status_code=409, detail=f"'{new_name}' already exists at this location.")

    old_path_str = str(target.resolve())
    old_collection_key = body.collection_key or collection_key_for_path(old_path_str)
    try:
        target.rename(new_path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not rename folder: {exc}")

    new_path_str = str(new_path.resolve())
    source_dir = _find_source_dir_for_path(new_path)
    try:
        _rename_collection_in_db(body.collection_key, old_path_str, new_path_str)
        update_items_file_paths_prefix(old_path_str, new_path_str, source_dir)
        refresh_item_collection_memberships_for_path_prefix(new_path_str, source_dir)
        collection = _upsert_folder_chain(new_path)
    except Exception as exc:
        logger.warning("DB update after rename failed: %s", exc)
        collection = {
            "source_dir": source_dir,
            "collection_key": collection_key_for_path(new_path_str),
            "parent_collection_key": "",
            "collection_keys": [],
        }

    return {
        "status": "renamed",
        "old_path": old_path_str,
        "new_path": new_path_str,
        "name": new_name,
        "old_collection_key": old_collection_key,
        "new_collection_key": collection.get("collection_key", collection_key_for_path(new_path_str)),
        **collection,
    }


@router.post("/api/folders/move")
def move_folder_route(body: MoveFolderRequest) -> Dict:
    target = _validate_folder_in_library(body.folder_path)
    new_parent = Path(body.target_parent).expanduser().resolve()
    if not new_parent.exists() or not new_parent.is_dir():
        raise HTTPException(status_code=404, detail=f"Target parent not found: {body.target_parent}")
    _validate_folder_in_library(str(new_parent))
    if target == new_parent or _path_is_within(new_parent, target):
        raise HTTPException(status_code=400, detail="Cannot move a folder into itself or one of its subfolders.")

    folder_name = target.name
    new_path = new_parent / folder_name
    if new_path.exists():
        raise HTTPException(status_code=409, detail=f"'{folder_name}' already exists in target location.")

    old_path_str = str(target.resolve())
    try:
        import shutil

        shutil.move(str(target), str(new_path))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not move folder: {exc}")

    new_path_str = str(new_path.resolve())
    new_source_dir = _find_source_dir_for_path(new_path)
    old_collection_key = collection_key_for_path(old_path_str)
    try:
        update_collection_path(old_path_str, new_path_str)
        update_items_file_paths_prefix(old_path_str, new_path_str, new_source_dir)
        refresh_item_collection_memberships_for_path_prefix(new_path_str, new_source_dir)
        collection = _upsert_folder_chain(new_path)
    except Exception as exc:
        logger.warning("DB update after move failed: %s", exc)
        collection = {
            "source_dir": new_source_dir,
            "collection_key": collection_key_for_path(new_path_str),
            "parent_collection_key": "",
            "collection_keys": [],
        }

    return {
        "status": "moved",
        "old_path": old_path_str,
        "new_path": new_path_str,
        "old_collection_key": old_collection_key,
        "new_collection_key": collection.get("collection_key", collection_key_for_path(new_path_str)),
        **collection,
    }


@router.delete("/api/folders/delete")
def delete_folder_route(body: DeleteFolderRequest) -> Dict:
    target = _validate_folder_in_library(body.folder_path)
    source_dir = _find_source_dir_for_path(target)
    if str(target.resolve()) == source_dir:
        raise HTTPException(status_code=400, detail="Cannot delete a root library directory from here. Use Settings to remove it.")

    target_path = str(target.resolve())
    item_keys = get_item_keys_for_file_path_prefix(target_path, source_dir)
    deleted_collection_key = collection_key_for_path(target_path)

    if body.delete_contents:
        try:
            import shutil

            shutil.rmtree(str(target))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not delete folder: {exc}")
    else:
        has_entries = any(file_path for file_path in target.rglob("*") if not file_path.name.startswith("."))
        if has_entries:
            raise HTTPException(
                status_code=409,
                detail="Folder is not empty. Set delete_contents=true to remove all files.",
            )
        try:
            target.rmdir()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not delete folder: {exc}")

    _delete_items_from_indexes(item_keys)
    try:
        delete_collection_by_path(target_path)
    except Exception as exc:
        logger.warning("DB cleanup after folder delete failed: %s", exc)

    return {
        "status": "deleted",
        "path": target_path,
        "source_dir": source_dir,
        "deleted_collection_key": deleted_collection_key,
        "deleted_items": len(item_keys),
    }


@router.post("/api/items/move")
def move_items_route(body: MoveItemsRequest) -> Dict:
    target_dir = Path(body.target_dir).expanduser().resolve()
    if not target_dir.exists() or not target_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Target directory not found: {body.target_dir}")
    _validate_folder_in_library(str(target_dir))

    target_source_dir = _find_source_dir_for_path(target_dir)
    collection = _upsert_folder_chain(target_dir)
    target_collection_keys = collection.get("collection_keys", ["root"])
    items = get_items_batch(body.item_keys)
    moved = []
    errors = []

    for item_key in body.item_keys:
        item = items.get(item_key)
        if not item:
            errors.append(f"Item {item_key} not found")
            continue

        file_path = item.get("file_path", "")
        if not file_path:
            errors.append(f"Item {item_key} has no file")
            continue

        src = Path(file_path)
        if not src.exists():
            errors.append(f"File not found on disk: {file_path}")
            continue

        dest = target_dir / src.name
        counter = 1
        while dest.exists():
            stem = src.stem
            suffix = src.suffix
            dest = target_dir / f"{stem}_{counter}{suffix}"
            counter += 1

        try:
            import shutil

            shutil.move(str(src), str(dest))
        except OSError as exc:
            errors.append(f"Could not move {src.name}: {exc}")
            continue

        try:
            old_file_str = str(src)
            new_file_str = str(dest)
            update_item_file_path(item_key, old_file_str, new_file_str, target_source_dir)
            set_item_collection_keys(item_key, target_collection_keys)
        except Exception as exc:
            logger.warning("DB update after item move failed for %s: %s", item_key, exc)

        moved.append({"item_key": item_key, "new_path": str(dest)})

    return {"status": "moved", "moved": moved, "errors": errors, "count": len(moved)}


@router.post("/api/items/copy")
def copy_items_route(body: CopyItemsRequest) -> Dict:
    target_dir = Path(body.target_dir).expanduser().resolve()
    if not target_dir.exists() or not target_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Target directory not found: {body.target_dir}")
    _validate_folder_in_library(str(target_dir))

    items = get_items_batch(body.item_keys)
    copied = []
    errors = []

    for item_key in body.item_keys:
        item = items.get(item_key)
        if not item:
            errors.append(f"Item {item_key} not found")
            continue

        file_path = item.get("file_path", "")
        if not file_path:
            errors.append(f"Item {item_key} has no file")
            continue

        src = Path(file_path)
        if not src.exists():
            errors.append(f"File not found on disk: {file_path}")
            continue

        dest = target_dir / src.name
        counter = 1
        while dest.exists():
            stem = src.stem
            suffix = src.suffix
            dest = target_dir / f"{stem}_{counter}{suffix}"
            counter += 1

        try:
            import shutil

            shutil.copy2(str(src), str(dest))
        except OSError as exc:
            errors.append(f"Could not copy {src.name}: {exc}")
            continue

        copied.append({"item_key": item_key, "new_path": str(dest)})

    return {"status": "copied", "copied": copied, "errors": errors, "count": len(copied)}
