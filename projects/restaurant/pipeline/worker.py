#!/usr/bin/env python3
"""Worker résident des agents restaurant — gabarit agents/telegram/worker.py.

Boucle 24/7 : claim la prochaine tâche `pending`, la dispatche vers l'étape d'agent
correspondante, écrit le résultat. En DRY-RUN, aucune étape n'a d'effet externe
(génération par gabarit, e-mails sur disque). Deux modes :
  - drain()  : traite la file jusqu'à épuisement (tests, exécution ponctuelle) ;
  - serve()  : boucle infinie avec polling (service systemd).

Garde-fou : refuse de tourner si dry_run=false sans send_enabled validé
(double sécurité avec email_gen). Les étapes inconnues échouent proprement.
"""
from __future__ import annotations

import sys
import time

from . import audit, build, config, content, db, discovery, email_gen, tasks


def _handle_discover(conn, cfg, task) -> str:
    ids = discovery.discover(conn, cfg)
    audit.audit_all(conn, cfg, ids)
    enq = 0
    for bid in ids:
        row = conn.execute("SELECT status FROM businesses WHERE id=?", (bid,)).fetchone()
        if row and row["status"] == "qualified":
            tasks.enqueue(conn, "process", business_id=bid, priority=50)
            enq += 1
    return f"découverte: {len(ids)} prospects, {enq} qualifiés mis en file"


def _handle_process(conn, cfg, task) -> str:
    bid = task["business_id"]
    row = conn.execute("SELECT * FROM businesses WHERE id=?", (bid,)).fetchone()
    if not row:
        return f"business {bid} introuvable"
    b = dict(row)
    # Re-vérifie l'éligibilité (la qualif a pu changer / suppression entre-temps).
    if b["status"] not in ("qualified", "site_built"):
        return f"business {bid} non éligible (status={b['status']})"
    if db.is_suppressed(conn, b.get("email")):
        db.set_business_status(conn, bid, "suppressed")
        return f"business {bid} supprimé (opt-out) — ignoré"

    c = content.build_content(b, cfg)
    site = build.build_site(conn, cfg, b, c)
    langs = cfg.get("email", {}).get("languages", ["fr"])
    res = email_gen.generate_email(conn, cfg, b, site, lang=langs[0])
    return f"business {bid}: site '{site['slug']}', e-mail {res['status']}"


def _handle_purge_expired(conn, cfg, task) -> str:
    """Agent hosting : retire les sites dont le TTL est dépassé (v_expired_sites)."""
    rows = conn.execute("SELECT id, slug FROM v_expired_sites").fetchall()
    for r in rows:
        conn.execute(
            "UPDATE websites SET status='expired', removed_at=?, updated_at=? WHERE id=?",
            (db.now_ms(), db.now_ms(), r["id"]),
        )
        db.audit(conn, "website", r["id"], "expired", detail={"slug": r["slug"]})
    return f"sites expirés retirés: {len(rows)}"


_HANDLERS = {
    "discover": _handle_discover,
    "process": _handle_process,
    "purge_expired": _handle_purge_expired,
}


def _guard(cfg) -> None:
    if not cfg.get("dry_run", True) and not cfg.get("email", {}).get("send_enabled", False):
        # Cohérent avec run_dry : on n'autorise pas un mode ambigu.
        print("[worker] dry_run=false mais send_enabled=false — config ambiguë, arrêt.",
              file=sys.stderr)
        sys.exit(2)


def _run_one(conn, cfg, task) -> None:
    handler = _HANDLERS.get(task["agent"])
    t0 = db.now_ms()
    if not handler:
        tasks.set_status(conn, task["id"], "error", f"agent inconnu: {task['agent']}")
        db.record_run(conn, task["agent"], ok=False, error="unknown agent")
        return
    try:
        msg = handler(conn, cfg, task)
        tasks.set_status(conn, task["id"], "done", msg)
        db.record_run(conn, task["agent"], ok=True, duration_ms=db.now_ms() - t0)
    except Exception as e:  # noqa: BLE001
        tasks.set_status(conn, task["id"], "error", str(e))
        db.record_run(conn, task["agent"], ok=False, error=str(e),
                      duration_ms=db.now_ms() - t0)


def drain(cfg=None, max_tasks: int = 1000) -> int:
    """Traite la file jusqu'à épuisement. Retourne le nombre de tâches traitées."""
    cfg = cfg or config.load_config()
    _guard(cfg)
    conn = db.connect(cfg)
    n = 0
    try:
        while n < max_tasks:
            task = tasks.claim_next(conn)
            if not task:
                break
            _run_one(conn, cfg, task)
            n += 1
    finally:
        conn.close()
    return n


def serve(poll_sec: float = 3.0) -> None:
    cfg = config.load_config()
    _guard(cfg)
    print(f"[worker] démarré (dry_run={cfg.get('dry_run')})", flush=True)
    conn = db.connect(cfg)
    try:
        while True:
            task = tasks.claim_next(conn)
            if not task:
                time.sleep(poll_sec)
                continue
            print(f"[worker] {task['agent']} {task['id'][:8]}", flush=True)
            _run_one(conn, cfg, task)
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Worker résident restaurant")
    ap.add_argument("--drain", action="store_true", help="traite la file puis sort")
    args = ap.parse_args()
    if args.drain:
        print(f"[worker] {drain()} tâche(s) traitée(s)")
    else:
        serve()
