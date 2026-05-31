#!/usr/bin/env python3
"""Coordinator — chef d'orchestre. Ne s'exécute pas lui-même : il MET EN FILE le
travail du cycle (table `tasks`), le worker résident l'exécute. Sépare décision
(coordinator) et exécution (worker) — cohérent avec l'archi bot/worker Galaxia.

Cycle quotidien (Anneau 0) :
  1) purge des sites expirés (hosting) ;
  2) découverte + qualification + génération + e-mail (dry-run).

Décisions autonomes ; ne bloque que sur risque sérieux (→ QUESTIONS_POUR_JEFF.md).
"""
from __future__ import annotations

from . import config, db, tasks


def plan_cycle(conn, cfg: dict) -> list[str]:
    """Met en file un cycle complet. Retourne les ids de tâches créées."""
    ids = []
    # Priorité basse = traité d'abord (purge avant de regénérer).
    ids.append(tasks.enqueue(conn, "purge_expired", priority=10))
    ids.append(tasks.enqueue(conn, "discover", priority=20))
    db.audit(conn, "task", None, "cycle_planned", actor="coordinator",
             detail={"tasks": len(ids), "ring": cfg.get("ring", 0)})
    return ids


def main() -> None:
    cfg = config.load_config()
    db.init_db(cfg)
    conn = db.connect(cfg)
    try:
        ids = plan_cycle(conn, cfg)
        print(f"[coordinator] cycle planifié : {len(ids)} tâches en file "
              f"(dry_run={cfg.get('dry_run')}).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
