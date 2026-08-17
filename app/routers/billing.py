"""Billing and quota routes."""

import logging
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.config import get_device_id

logger = logging.getLogger(__name__)
router = APIRouter(tags=["billing"])


@router.get("/api/billing/balance")
def billing_balance_route() -> Dict:
    device_id = get_device_id()
    try:
        import httpx

        resp = httpx.get(
            "https://api.tarcite.com/billing/balance",
            params={"device_id": device_id},
            headers={
                "Content-Type": "application/json",
                "User-Agent": "TarCiteWorkspace/1.0",
            },
            timeout=8.0,
        )
        if resp.status_code == 200:
            return resp.json()
        return {
            "tier": "free",
            "tier_usage": [
                {"group": "default", "used_today": 0, "daily_limit": 40},
                {"group": "premium", "used_today": 0, "daily_limit": 10},
            ],
            "credits_remaining": 0,
            "error": resp.text[:200] if resp.text else f"HTTP {resp.status_code}",
        }
    except Exception as exc:
        logger.warning("billing/balance fetch failed: %s", exc)
        return {
            "tier": "free",
            "tier_usage": [
                {"group": "default", "used_today": 0, "daily_limit": 40},
                {"group": "premium", "used_today": 0, "daily_limit": 10},
            ],
            "credits_remaining": 0,
            "error": str(exc)[:200],
        }


@router.post("/api/billing/checkout")
def billing_checkout_route(body: Dict[str, Any]) -> Dict:
    # Sync on purpose: the httpx call below blocks for up to 15s, which would
    # freeze the whole event loop if this handler were async. See the note at
    # the top of routers/translation.py.
    device_id = get_device_id()
    amount_cents = body.get("amount_cents", 500)
    if amount_cents < 300:
        raise HTTPException(status_code=400, detail="Minimum payment is $3.00 (300 cents).")
    try:
        import httpx

        resp = httpx.post(
            "https://api.tarcite.com/billing/checkout",
            json={"device_id": device_id, "amount_cents": amount_cents},
            headers={
                "Content-Type": "application/json",
                "User-Agent": "TarCiteWorkspace/1.0",
            },
            timeout=15.0,
        )
        if resp.status_code == 200:
            return resp.json()
        try:
            err = resp.json()
            raise HTTPException(status_code=resp.status_code, detail=err.get("message", err.get("error", "Checkout failed")))
        except (ValueError, AttributeError):
            raise HTTPException(status_code=resp.status_code, detail=f"Checkout failed: HTTP {resp.status_code}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("billing/checkout error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Could not initiate checkout: {exc}")
