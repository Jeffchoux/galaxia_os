#!/usr/bin/env python3
"""Orchestrateur DRY-RUN du pipeline restaurant (Anneau 0).

Déroule la chaîne complète sur des données fictives, SANS aucun effet externe :
  discovery → audit/qualification → content → build (site statique) → email (sur disque).

Rien n'est envoyé, rien n'est publié sur une URL indexée, rien n'est facturé.
C'est la preuve de bout en bout demandée par le brief + la base des tests.

Usage :
  python -m pipeline.run_dry              # exécute le dry-run, affiche un résumé
  python -m pipeline.run_dry --json       # résumé machine
  python -m pipeline.run_dry --reset      # repart d'une base vierge
"""
from __future__ import annotations

import argparse
import json
import sys

from . import audit, build, config, content, db, discovery, email_gen


def run(reset: bool = False) -> dict:
    cfg = config.load_config()
    if not cfg.get("dry_run", True):
        print("!! dry_run=false dans la config — l'orchestrateur dry-run refuse de tourner.",
              file=sys.stderr)
        sys.exit(2)

    dbfile = db.db_path(cfg)
    if reset and dbfile.exists():
        dbfile.unlink()
        for ext in ("-wal", "-shm"):
            p = dbfile.with_name(dbfile.name + ext)
            if p.exists():
                p.unlink()

    db.init_db(cfg)
    conn = db.connect(cfg)
    summary = {"dry_run": True, "discovered": 0, "qualified": 0, "rejected": 0,
               "sites_built": 0, "emails_written": 0, "emails_blocked": 0, "details": []}
    try:
        # 1) Découverte
        ids = discovery.discover(conn, cfg)
        summary["discovered"] = len(ids)
        db.record_run(conn, "discovery", model="-", ok=True)

        # 2) Audit + qualification
        stats = audit.audit_all(conn, cfg, ids)
        summary["qualified"], summary["rejected"] = stats["qualified"], stats["rejected"]
        db.record_run(conn, "website_audit", model="-", ok=True)

        # 3..5) Pour chaque prospect contactable : contenu → build → e-mail
        rows = conn.execute("SELECT * FROM v_contactable").fetchall()
        langs = cfg.get("email", {}).get("languages", ["fr"])
        for row in rows:
            b = dict(row)
            # rappatrie la cuisine éventuelle depuis la seed d'audit (fixtures)
            c = content.build_content(b, cfg)
            site = build.build_site(conn, cfg, b, c)
            summary["sites_built"] += 1
            res = email_gen.generate_email(conn, cfg, b, site, lang=langs[0])
            if res["status"] == "blocked":
                summary["emails_blocked"] += 1
            else:
                summary["emails_written"] += 1
            summary["details"].append({
                "business": b["name"], "slug": site["slug"],
                "email_status": res["status"], "email_path": res.get("path"),
            })
        db.record_run(conn, "content+build+email", model="ollama:llama3.1:8b (simulé)", ok=True)
    finally:
        conn.close()
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description="Pipeline restaurant — dry-run")
    ap.add_argument("--json", action="store_true", help="sortie JSON")
    ap.add_argument("--reset", action="store_true", help="base vierge avant run")
    args = ap.parse_args()

    s = run(reset=args.reset)
    if args.json:
        print(json.dumps(s, ensure_ascii=False, indent=2))
        return
    print("=== Pipeline restaurant — DRY-RUN terminé ===")
    print(f"  Découverts        : {s['discovered']}")
    print(f"  Qualifiés (cibles): {s['qualified']}")
    print(f"  Rejetés           : {s['rejected']}")
    print(f"  Sites générés     : {s['sites_built']}")
    print(f"  E-mails écrits     : {s['emails_written']}  (bloqués : {s['emails_blocked']})")
    print("  ---")
    for d in s["details"]:
        print(f"  • {d['business']:28} → site '{d['slug']}'  e-mail={d['email_status']}")
    print("\n  Aucun e-mail envoyé, aucun site publié publiquement. ✅")


if __name__ == "__main__":
    main()
