"""Couche d'accès SQLite du projet restaurant.

Pattern repris de agents/telegram/tasks.py (WAL, isolation autocommit, timeout).
Souverain, zéro dépendance. Expose : init, connexion, insert/upsert business,
helpers de transition de statut, et la vérification de la liste de suppression
(garde-fou conformité — docs/01 §3.7).
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from . import config as _cfg


def now_ms() -> int:
    return int(time.time() * 1000)


def db_path(cfg: dict | None = None) -> Path:
    cfg = cfg or _cfg.load_config()
    return _cfg.resolve_path(cfg, "database")


def connect(cfg: dict | None = None) -> sqlite3.Connection:
    path = db_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(cfg: dict | None = None) -> Path:
    """Crée/actualise le schéma (idempotent)."""
    cfg = cfg or _cfg.load_config()
    schema = _cfg.resolve_path(cfg, "schema").read_text(encoding="utf-8")
    conn = connect(cfg)
    try:
        conn.executescript(schema)
    finally:
        conn.close()
    return db_path(cfg)


def audit(conn: sqlite3.Connection, entity: str, entity_id: Any, action: str,
          actor: str = "system", detail: dict | None = None) -> None:
    """Journalise une action sensible (traçabilité RGPD — audit_log)."""
    conn.execute(
        "INSERT INTO audit_log (entity, entity_id, action, actor, detail, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (entity, str(entity_id) if entity_id is not None else None, action, actor,
         json.dumps(detail, ensure_ascii=False) if detail else None, now_ms()),
    )


def is_suppressed(conn: sqlite3.Connection, email: str | None) -> bool:
    """Vrai si l'e-mail est sur la liste de suppression (insensible à la casse)."""
    if not email:
        return False
    row = conn.execute(
        "SELECT 1 FROM suppression_list WHERE email = ? COLLATE NOCASE LIMIT 1",
        (email,),
    ).fetchone()
    return row is not None


def add_suppression(conn: sqlite3.Connection, email: str, reason: str = "unsubscribe",
                    source: str = "link", business_id: int | None = None) -> None:
    """Ajoute (idempotent) une adresse à la liste de suppression IRRÉVERSIBLE."""
    conn.execute(
        "INSERT INTO suppression_list (email, reason, source, business_id, created_at)"
        " VALUES (?,?,?,?,?) ON CONFLICT(email) DO NOTHING",
        (email, reason, source, business_id, now_ms()),
    )
    audit(conn, "suppression", email, "suppressed", detail={"reason": reason, "source": source})


def upsert_business(conn: sqlite3.Connection, b: dict, cfg: dict) -> int:
    """Insère/maj un prospect par (data_source, external_id). Retourne son id."""
    ts = now_ms()
    retention_days = int(cfg.get("compliance", {}).get("retention_days", 90))
    retention_until = ts + retention_days * 86400 * 1000
    cols = dict(
        name=b["name"], category=b.get("category"), address=b.get("address"),
        city=b.get("city"), postal_code=b.get("postal_code"), country=b.get("country"),
        lat=b.get("lat"), lon=b.get("lon"), phone=b.get("phone"),
        email=b.get("email"), email_is_generic=int(b.get("email_is_generic", 0)),
        existing_website=b.get("existing_website"),
        data_source=b["data_source"], source_url=b.get("source_url"),
        consent_basis=b.get("consent_basis", "legitimate_interest_b2b"),
        external_id=b.get("external_id"), collected_at=ts,
        retention_until=retention_until, status=b.get("status", "discovered"),
        created_at=ts, updated_at=ts,
    )
    placeholders = ",".join("?" for _ in cols)
    try:
        cur = conn.execute(
            f"INSERT INTO businesses ({','.join(cols)}) VALUES ({placeholders})",
            tuple(cols.values()),
        )
        bid = cur.lastrowid
        audit(conn, "business", bid, "collected",
              detail={"source": b["data_source"], "url": b.get("source_url")})
        return bid
    except sqlite3.IntegrityError:
        row = conn.execute(
            "SELECT id FROM businesses WHERE data_source=? AND external_id=?",
            (b["data_source"], b.get("external_id")),
        ).fetchone()
        return row["id"] if row else -1


def set_business_status(conn: sqlite3.Connection, bid: int, status: str, **extra) -> None:
    sets, vals = ["status=?", "updated_at=?"], [status, now_ms()]
    for k, v in extra.items():
        sets.append(f"{k}=?")
        vals.append(v)
    vals.append(bid)
    conn.execute(f"UPDATE businesses SET {','.join(sets)} WHERE id=?", vals)


def record_run(conn: sqlite3.Connection, agent: str, *, model: str = "",
               ok: bool = True, error: str | None = None, cost_usd: float = 0.0,
               duration_ms: int = 0) -> None:
    conn.execute(
        "INSERT INTO agent_runs (agent, model, cost_usd, duration_ms, ok, error, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (agent, model, cost_usd, duration_ms, int(ok), error, now_ms()),
    )


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", action="store_true", help="créer le schéma")
    args = ap.parse_args()
    if args.init:
        print("Base initialisée :", init_db())
