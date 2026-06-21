"""File upload, folder management, and item file operation routes."""

import logging
import platform
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, UploadFile

from app.config import config
from app.database import (
    _rename_collection_in_db,
    delete_collection_by_path,
    get_items_batch,
    update_collection_path,
    update_item_file_path,
    update_items_file_paths_prefix,
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
    if not file.filename or Path(file.filename).suffix.lower() not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Supported: PDF, images (PNG/JPG/WebP/GIF/BMP/TIFF), Word (.docx), TXT, Markdown, CSV, RIS, BibTeX.")

    target = Path(target_dir).expanduser().resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {target_dir}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {target_dir}")

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
        raise HTTPException(status_code=500, detail=f"Failed to save file: {exc}")

    sync_dir = str(target)
    for directory in config.reference_dirs:
        directory_path = Path(directory.get("path", "")).expanduser().resolve()
        if target == directory_path or target.is_relative_to(directory_path):
            sync_dir = str(directory_path)
            break

    def _index_single() -> None:
        from app.sync import sync_single_file

        try:
            sync_single_file(str(dest), sync_dir)
        except Exception as exc:
            logger.error("Single file index error: %s", exc)

    thread = threading.Thread(target=_index_single, daemon=True)
    thread.start()

    return {
        "status": "success",
        "file_path": str(dest),
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
    for directory in config.reference_dirs:
        directory_path = str(Path(directory.get("path", "")).expanduser().resolve())
        if norm == directory_path or norm.startswith(directory_path + "/") or norm.startswith(directory_path + "\\"):
            return directory_path
    return ""


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

    return {"status": "created", "path": str(new_path), "name": folder_name}


@router.post("/api/folders/rename")
def rename_folder_route(body: RenameFolderRequest) -> Dict:
    target = _validate_folder_in_library(body.folder_path)
    new_name = body.new_name.strip()
    if not new_name or "/" in new_name or "\\" in new_name:
        raise HTTPException(status_code=400, detail="Invalid folder name.")

    new_path = target.parent / new_name
    if new_path.exists():
        raise HTTPException(status_code=409, detail=f"'{new_name}' already exists at this location.")

    old_path_str = str(target)
    try:
        target.rename(new_path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not rename folder: {exc}")

    new_path_str = str(new_path.resolve())
    try:
        _rename_collection_in_db(body.collection_key, old_path_str, new_path_str)
        update_items_file_paths_prefix(old_path_str, new_path_str)
    except Exception as exc:
        logger.warning("DB update after rename failed: %s", exc)

    return {"status": "renamed", "old_path": old_path_str, "new_path": new_path_str, "name": new_name}


@router.post("/api/folders/move")
def move_folder_route(body: MoveFolderRequest) -> Dict:
    target = _validate_folder_in_library(body.folder_path)
    new_parent = Path(body.target_parent).expanduser().resolve()
    if not new_parent.exists() or not new_parent.is_dir():
        raise HTTPException(status_code=404, detail=f"Target parent not found: {body.target_parent}")
    _validate_folder_in_library(str(new_parent))

    folder_name = target.name
    new_path = new_parent / folder_name
    if new_path.exists():
        raise HTTPException(status_code=409, detail=f"'{folder_name}' already exists in target location.")

    old_path_str = str(target.resolve())
    old_raw = body.folder_path
    try:
        import shutil

        shutil.move(str(target), str(new_path))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not move folder: {exc}")

    new_path_str = str(new_path.resolve())
    try:
        update_collection_path(old_path_str, new_path_str)
        update_collection_path(old_raw, new_path_str)
        update_items_file_paths_prefix(old_path_str, new_path_str)
    except Exception as exc:
        logger.warning("DB update after move failed: %s", exc)

    return {"status": "moved", "old_path": old_path_str, "new_path": new_path_str}


@router.delete("/api/folders/delete")
def delete_folder_route(body: DeleteFolderRequest) -> Dict:
    target = _validate_folder_in_library(body.folder_path)
    source_dir = _find_source_dir_for_path(target)
    if str(target.resolve()) == source_dir:
        raise HTTPException(status_code=400, detail="Cannot delete a root library directory from here. Use Settings to remove it.")

    if body.delete_contents:
        try:
            import shutil

            shutil.rmtree(str(target))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not delete folder: {exc}")
    else:
        has_files = any(file_path.is_file() for file_path in target.rglob("*") if not file_path.name.startswith("."))
        if has_files:
            raise HTTPException(
                status_code=409,
                detail="Folder is not empty. Set delete_contents=true to remove all files.",
            )
        try:
            target.rmdir()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not delete folder: {exc}")

    try:
        delete_collection_by_path(str(target.resolve()))
    except Exception as exc:
        logger.warning("DB cleanup after folder delete failed: %s", exc)

    return {"status": "deleted", "path": str(target)}


@router.post("/api/items/move")
def move_items_route(body: MoveItemsRequest) -> Dict:
    target_dir = Path(body.target_dir).expanduser().resolve()
    if not target_dir.exists() or not target_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Target directory not found: {body.target_dir}")
    _validate_folder_in_library(str(target_dir))

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
            update_item_file_path(item_key, old_file_str, new_file_str)
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
