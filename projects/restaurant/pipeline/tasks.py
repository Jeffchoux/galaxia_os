"""File de tâches des agents (table `tasks`) — gabarit agents/telegram/tasks.py.

claim atomique via BEGIN IMMEDIATE ; pending → running → done | error | killed.
Tout en SQLite (pas de Redis), même utilisateur Unix (galaxia) → kill-switch propre.
"""
from __future__ import annotations

import json
import sqlite3
import uuid

from . import db as _db

_COLS = ["id", "agent", "business_id", "payload", "status", "result",
         "priority", "attempts", "pgid", "created_at", "updated_at"]


def enqueue(conn: sqlite3.Connection, agent: str, *, business_id: int | None = None,
            payload: dict | None = None, priority: int = 100) -> str:
    tid = uuid.uuid4().hex
    now = _db.now_ms()
    conn.execute(
        "INSERT INTO tasks (id, agent, business_id, payload, status, priority,"
        " created_at, updated_at) VALUES (?,?,?,?, 'pending', ?, ?, ?)",
        (tid, agent, business_id,
         json.dumps(payload, ensure_ascii=False) if payload else None,
         priority, now, now),
    )
    return tid


def claim_next(conn: sqlite3.Connection) -> dict | None:
    """Prend atomiquement la tâche pending la plus prioritaire et la passe running."""
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        "SELECT id FROM tasks WHERE status='pending'"
        " ORDER BY priority ASC, created_at ASC LIMIT 1"
    ).fetchone()
    if not row:
        conn.execute("COMMIT")
        return None
    tid = row["id"]
    conn.execute(
        "UPDATE tasks SET status='running', attempts=attempts+1, updated_at=? WHERE id=?",
        (_db.now_ms(), tid),
    )
    conn.execute("COMMIT")
    return get(conn, tid)


def get(conn: sqlite3.Connection, tid: str) -> dict | None:
    row = conn.execute(
        f"SELECT {','.join(_COLS)} FROM tasks WHERE id=?", (tid,)
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["payload"] = json.loads(d["payload"]) if d["payload"] else None
    return d


def set_status(conn: sqlite3.Connection, tid: str, status: str,
               result: str | None = None) -> None:
    sets, vals = ["status=?", "updated_at=?"], [status, _db.now_ms()]
    if result is not None:
        sets.append("result=?")
        vals.append(result[:8000])
    vals.append(tid)
    conn.execute(f"UPDATE tasks SET {','.join(sets)} WHERE id=?", vals)


def pending_count(conn: sqlite3.Connection) -> int:
    return conn.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE status='pending'"
    ).fetchone()["n"]
