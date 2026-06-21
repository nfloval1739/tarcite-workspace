"""Model package download routes."""

from typing import Dict

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["packages"])


@router.get("/api/packages")
async def packages_list_route() -> Dict:
    from app.downloader import list_packages

    return {"packages": list_packages()}


@router.post("/api/packages/{slug}/download")
async def packages_start_download_route(slug: str) -> Dict:
    from app.downloader import get_progress, list_packages, start_download

    pkgs = list_packages()
    pkg = next((p for p in pkgs if p["slug"] == slug), None)
    if not pkg:
        raise HTTPException(status_code=404, detail="Package not found")
    started = start_download(slug, pkg["name"], pkg["file_size_bytes"], pkg.get("sha256_checksum", ""))
    return {"started": started, "slug": slug, "state": get_progress(slug)}


@router.get("/api/packages/progress")
async def packages_progress_route() -> Dict:
    from app.downloader import get_all_progress

    return {"downloads": get_all_progress()}


@router.post("/api/packages/{slug}/cancel")
async def packages_cancel_route(slug: str) -> Dict:
    from app.downloader import cancel_download

    cancelled = cancel_download(slug)
    return {"cancelled": cancelled, "slug": slug}
