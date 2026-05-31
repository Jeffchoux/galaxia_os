#!/usr/bin/env python3
"""File de tâches partagée (bot ⇄ worker) dans la SQLite du cockpit.

Le bot ENQUEUE ici (il sait écrire la DB) ; le service `galaxia-tg-worker` poll la
table, exécute, et met à jour. Statuts : pending → running → done | error | killed.
Tout en même utilisateur Unix (galaxia) → le bot peut tuer un job via os.killpg
sans sudo (le kill-switch /stop).
"""
from __future__ import annotations

import os
import sqlite3
import time
import uuid
from pathlib import Path

COCKPIT_DB = Path(
    os.environ.get(
        "COCKPIT_DB_PATH",
        "/home/galaxia/galaxia-project/apps/cockpit/data/cockpit.db",
    )
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tg_tasks (
    id          TEXT PRIMARY KEY,
    chat_id     INTEGER NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'order',
    prompt      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    result      TEXT,
    pgid        INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
"""


def _conn() -> sqlite3.Connection:
    db = sqlite3.connect(COCKPIT_DB, isolation_level=None, timeout=15)
    db.execute("PRAGMA journal_mode = WAL")
    db.execute(_SCHEMA)
    return db


def _now() -> int:
    return int(time.time() * 1000)


def enqueue(chat_id: int, prompt: str, kind: str = "order") -> str:
    tid = uuid.uuid4().hex
    db = _conn()
    try:
        now = _now()
        db.execute(
            "INSERT INTO tg_tasks (id, chat_id, kind, prompt, status, created_at, updated_at)"
            " VALUES (?,?,?,?, 'pending', ?, ?)",
            (tid, chat_id, kind, prompt, now, now),
        )
    finally:
        db.close()
    return tid


_COLS = ["id", "chat_id", "kind", "prompt", "status", "result", "pgid",
         "created_at", "updated_at"]


def get(tid: str) -> dict | None:
    db = _conn()
    try:
        row = db.execute(
            f"SELECT {','.join(_COLS)} FROM tg_tasks WHERE id=?", (tid,)
        ).fetchone()
        return dict(zip(_COLS, row)) if row else None
    finally:
        db.close()


def claim_next() -> dict | None:
    """Atomiquement : prend la plus vieille tâche pending, la passe en running."""
    db = _conn()
    try:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT id FROM tg_tasks WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            db.execute("COMMIT")
            return None
        tid = row[0]
        db.execute(
            "UPDATE tg_tasks SET status='running', updated_at=? WHERE id=?",
            (_now(), tid),
        )
        db.execute("COMMIT")
    finally:
        db.close()
    return get(tid)


def set_status(tid: str, status: str, *, result: str | None = None,
               pgid: int | None = None) -> None:
    db = _conn()
    try:
        sets, vals = ["status=?", "updated_at=?"], [status, _now()]
        if result is not None:
            sets.append("result=?")
            vals.append(result[:8000])
        if pgid is not None:
            sets.append("pgid=?")
            vals.append(pgid)
        vals.append(tid)
        db.execute(f"UPDATE tg_tasks SET {','.join(sets)} WHERE id=?", vals)
    finally:
        db.close()


def status_of(tid: str) -> str | None:
    db = _conn()
    try:
        row = db.execute("SELECT status FROM tg_tasks WHERE id=?", (tid,)).fetchone()
        return row[0] if row else None
    finally:
        db.close()


def active_tasks() -> list[dict]:
    db = _conn()
    try:
        rows = db.execute(
            f"SELECT {','.join(_COLS)} FROM tg_tasks WHERE status IN ('pending','running')"
            " ORDER BY created_at ASC"
        ).fetchall()
        return [dict(zip(_COLS, r)) for r in rows]
    finally:
        db.close()
