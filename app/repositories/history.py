"""Chat session, suggestion run, and feedback persistence."""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.repositories.core import get_connection


def get_chat_sessions() -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_sessions WHERE status = 'active' ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def create_chat_session(data: Dict[str, Any]) -> str:
    import uuid

    session_id = data.get("session_id", str(uuid.uuid4())[:12])
    payload = {
        "session_id": session_id,
        "title": data.get("title", ""),
        "suggestion_run_id": data.get("suggestion_run_id", ""),
        "linked_item_key": data.get("linked_item_key", ""),
        "active_profile": data.get("active_profile", ""),
    }
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO chat_sessions
               (session_id, title, suggestion_run_id, linked_item_key, active_profile)
               VALUES (:session_id, :title, :suggestion_run_id, :linked_item_key, :active_profile)""",
            payload,
        )
    return session_id


def update_chat_session(session_id: str, updates: Dict[str, Any]) -> None:
    with get_connection() as conn:
        set_clauses = ", ".join(f"{key} = :{key}" for key in updates if key != "session_id")
        if set_clauses:
            conn.execute(
                f"UPDATE chat_sessions SET {set_clauses}, updated_at = CURRENT_TIMESTAMP WHERE session_id = :session_id",
                {**updates, "session_id": session_id},
            )


def delete_chat_session(session_id: str) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM chat_sessions WHERE session_id = ?",
            (session_id,),
        )
        return cursor.rowcount > 0


def delete_all_chat_sessions() -> int:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM chat_sessions")
        return cursor.rowcount


def get_chat_messages(session_id: str) -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        ).fetchall()
        return [dict(row) for row in rows]


def add_chat_message(data: Dict[str, Any]) -> int:
    payload = {
        "session_id": data.get("session_id", ""),
        "role": data.get("role", ""),
        "content": data.get("content", ""),
        "model_used": data.get("model_used", ""),
        "linked_item_key": data.get("linked_item_key", ""),
    }
    with get_connection() as conn:
        cursor = conn.execute(
            """INSERT INTO chat_messages
               (session_id, role, content, model_used, linked_item_key)
               VALUES (:session_id, :role, :content, :model_used, :linked_item_key)""",
            payload,
        )
        return cursor.lastrowid


def get_suggestion_runs() -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT sr.*,
                   COUNT(res.result_id)                                          AS result_count,
                   SUM(CASE WHEN LOWER(res.confidence) = 'high'   THEN 1 ELSE 0 END) AS high_count,
                   SUM(CASE WHEN LOWER(res.confidence) = 'medium' THEN 1 ELSE 0 END) AS medium_count,
                   SUM(CASE WHEN LOWER(res.confidence) = 'low'    THEN 1 ELSE 0 END) AS low_count
            FROM suggestion_runs sr
            LEFT JOIN suggestion_results res ON sr.run_id = res.run_id
            GROUP BY sr.run_id
            ORDER BY sr.created_at DESC
        """).fetchall()
        return [dict(row) for row in rows]


def get_suggestion_run(run_id: str) -> Optional[Dict]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM suggestion_runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if not row:
            return None
        run = dict(row)

        results = conn.execute(
            "SELECT * FROM suggestion_results WHERE run_id = ? ORDER BY position",
            (run_id,),
        ).fetchall()
        enriched_results = []
        for result_row in results:
            result = dict(result_row)
            item = conn.execute(
                """SELECT title, year, item_type, publication_title, source_dir,
                          citation_count, citation_count_updated_at
                   FROM items WHERE item_key = ?""",
                (result.get("item_key", ""),),
            ).fetchone()
            if item:
                result.update(dict(item))
            enriched_results.append(result)
        run["results"] = enriched_results
        return run


def create_suggestion_run(data: Dict[str, Any]) -> str:
    import uuid

    run_id = data.get("run_id", str(uuid.uuid4())[:12])
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO suggestion_runs
               (run_id, title, paragraph, active_profile, ai_model, source_dir,
                collection_key, top_k, citation_style, status, elapsed_seconds, warnings_json, temperature,
                candidates_json)
               VALUES (:run_id, :title, :paragraph, :active_profile, :ai_model, :source_dir,
                       :collection_key, :top_k, :citation_style, :status, :elapsed_seconds, :warnings_json,
                       :temperature, :candidates_json)""",
            {**data, "run_id": run_id, "temperature": data.get("temperature"),
             "candidates_json": data.get("candidates_json", "[]")},
        )
    return run_id


def add_suggestion_result(data: Dict[str, Any]) -> int:
    with get_connection() as conn:
        cursor = conn.execute(
            """INSERT INTO suggestion_results
               (run_id, item_key, inline_citation, full_reference, reason,
                evidence_points_json, evidence_coverage, confidence, source_type, citation_count, position)
               VALUES (:run_id, :item_key, :inline_citation, :full_reference, :reason,
                       :evidence_points_json, :evidence_coverage, :confidence, :source_type,
                       :citation_count, :position)""",
            {**data, "citation_count": data.get("citation_count", 0)},
        )
        return cursor.lastrowid


def set_suggestion_feedback(
    run_id: str,
    item_key: str,
    feedback_type: str,
    feedback_value: Optional[int] = None,
) -> bool:
    if feedback_type not in ("thumb_up", "thumb_down", "star", "none"):
        return False
    if feedback_type == "star" and (feedback_value is None or feedback_value < 1 or feedback_value > 5):
        return False
    if feedback_type == "thumb_up":
        feedback_value = 1
    elif feedback_type == "thumb_down":
        feedback_value = -1
    elif feedback_type == "none":
        feedback_value = None
        feedback_type = None

    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        cursor = conn.execute(
            """UPDATE suggestion_results
               SET feedback_type = ?, feedback_value = ?, feedback_at = ?
               WHERE run_id = ? AND item_key = ?""",
            (feedback_type, feedback_value, now if feedback_type else None, run_id, item_key),
        )
        return cursor.rowcount > 0


def get_feedback_stats() -> Dict[str, Any]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT item_key,
                      SUM(CASE WHEN feedback_type = 'thumb_up' THEN 1 ELSE 0 END) as thumbs_up,
                      SUM(CASE WHEN feedback_type = 'thumb_down' THEN 1 ELSE 0 END) as thumbs_down,
                      SUM(CASE WHEN feedback_type = 'star' THEN feedback_value ELSE 0 END) as star_total,
                      SUM(CASE WHEN feedback_type = 'star' THEN 1 ELSE 0 END) as star_count
               FROM suggestion_results
               WHERE feedback_type IS NOT NULL
               GROUP BY item_key"""
        ).fetchall()
        stats = {}
        for row in rows:
            data = dict(row)
            stats[data["item_key"]] = data
        return stats


def delete_suggestion_run(run_id: str) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM suggestion_runs WHERE run_id = ?",
            (run_id,),
        )
        return cursor.rowcount > 0


def delete_all_suggestion_runs() -> int:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM suggestion_runs")
        return cursor.rowcount
