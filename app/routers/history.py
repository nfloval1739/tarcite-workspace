"""Chat session, suggestion run, and feedback history routes."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.database import (
    add_chat_message,
    create_chat_session,
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

router = APIRouter(tags=["history"])


@router.get("/api/chat-sessions")
def chat_sessions_route() -> Dict:
    return {"sessions": get_chat_sessions()}


@router.post("/api/chat-sessions")
def create_chat_session_route(body: Dict[str, Any]) -> Dict:
    session_id = create_chat_session(body)
    return {"status": "created", "session_id": session_id}


@router.patch("/api/chat-sessions/{session_id}")
def update_chat_session_route(session_id: str, body: Dict[str, Any]) -> Dict:
    update_chat_session(session_id, body)
    return {"status": "updated", "session_id": session_id}


@router.delete("/api/chat-sessions")
def delete_all_chat_sessions_route() -> Dict:
    count = delete_all_chat_sessions()
    return {"status": "deleted", "count": count}


@router.delete("/api/chat-sessions/{session_id}")
def delete_chat_session_route(session_id: str) -> Dict:
    if not delete_chat_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found.")
    return {"status": "deleted", "session_id": session_id}


@router.get("/api/chat-sessions/{session_id}/messages")
def chat_messages_route(session_id: str) -> Dict:
    return {"messages": get_chat_messages(session_id)}


@router.post("/api/chat-sessions/{session_id}/messages")
def add_chat_message_route(session_id: str, body: Dict[str, Any]) -> Dict:
    body["session_id"] = session_id
    message_id = add_chat_message(body)
    return {"status": "created", "message_id": message_id}


@router.get("/api/suggestion-runs")
def suggestion_runs_route() -> Dict:
    return {"runs": get_suggestion_runs()}


@router.get("/api/suggestion-runs/{run_id}")
def suggestion_run_detail_route(run_id: str) -> Dict:
    run = get_suggestion_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Suggestion run not found.")
    return run


@router.delete("/api/suggestion-runs")
def delete_all_suggestion_runs_route() -> Dict:
    count = delete_all_suggestion_runs()
    return {"status": "deleted", "count": count}


@router.delete("/api/suggestion-runs/{run_id}")
def delete_suggestion_run_route(run_id: str) -> Dict:
    if not delete_suggestion_run(run_id):
        raise HTTPException(status_code=404, detail="Suggestion run not found.")
    return {"status": "deleted", "run_id": run_id}


@router.post("/api/suggestion-feedback")
def suggestion_feedback_route(body: Dict[str, Any]) -> Dict:
    run_id = body.get("run_id", "")
    item_key = body.get("item_key", "")
    feedback_type = body.get("feedback_type", "")
    feedback_value = body.get("feedback_value")

    if not run_id or not item_key:
        raise HTTPException(status_code=400, detail="run_id and item_key are required.")

    ok = set_suggestion_feedback(run_id, item_key, feedback_type, feedback_value)
    if not ok:
        raise HTTPException(status_code=400, detail="Invalid feedback or result not found.")
    return {"status": "saved", "run_id": run_id, "item_key": item_key}


@router.get("/api/feedback-stats")
def feedback_stats_route() -> Dict:
    return {"stats": get_feedback_stats()}
