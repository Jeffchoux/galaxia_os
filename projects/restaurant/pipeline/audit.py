"""Agent website_audit — note la faiblesse du site existant et qualifie la cible.

DRY-RUN : utilise les audits fictifs de data/fixtures.json.
Production : audit HTTP réel SSRF-safe (anti-IP privées, timeout, taille max,
respect robots.txt, User-Agent honnête) — squelette désactivé en dry-run.

Qualification (docs/01 §6) : cible = site faible/absent (score < seuil) ET
adresse e-mail générique disponible. Sinon rejet tracé.
"""
from __future__ import annotations

import json

from . import db as _db


def _fixture_audits(cfg: dict) -> dict[str, dict]:
    path = _db._cfg.resolve_path(cfg, "fixtures")
    data = json.loads(path.read_text(encoding="utf-8"))
    return {b["external_id"]: b.get("audit_fixture", {}) for b in data.get("businesses", [])}


def audit_all(conn, cfg: dict, business_ids: list[int]) -> dict:
    seuil = int(cfg.get("audit", {}).get("qualify_below_score", 60))
    fixtures = _fixture_audits(cfg) if cfg.get("dry_run", True) else {}
    stats = {"qualified": 0, "rejected": 0}

    for bid in business_ids:
        row = conn.execute(
            "SELECT id, external_id, email, email_is_generic, existing_website"
            " FROM businesses WHERE id=?", (bid,),
        ).fetchone()
        if not row:
            continue

        if cfg.get("dry_run", True):
            a = fixtures.get(row["external_id"], {})
        else:
            a = _audit_live(row["existing_website"], cfg)  # production

        score = int(a.get("score", 0))
        conn.execute(
            "INSERT INTO website_audits (business_id, has_website, reachable, is_https,"
            " mobile_friendly, load_ms, ssl_valid, is_parking_page, score,"
            " weakness_summary, robots_allowed, audited_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (bid, int(a.get("has_website", 0)), a.get("reachable"), a.get("is_https"),
             a.get("mobile_friendly"), a.get("load_ms"), a.get("ssl_valid"),
             a.get("is_parking_page"), score, a.get("weakness_summary"),
             1, _db.now_ms()),
        )

        # Décision de qualification (autonome, déterministe).
        if not row["email_is_generic"]:
            _db.set_business_status(conn, bid, "rejected", reject_reason="no_generic_email")
            _db.audit(conn, "business", bid, "rejected", detail={"reason": "no_generic_email"})
            stats["rejected"] += 1
        elif score >= seuil:
            _db.set_business_status(conn, bid, "rejected", reject_reason="site_already_good")
            _db.audit(conn, "business", bid, "rejected",
                      detail={"reason": "site_already_good", "score": score})
            stats["rejected"] += 1
        else:
            _db.set_business_status(conn, bid, "qualified", qualified=1)
            _db.audit(conn, "business", bid, "qualified", detail={"score": score})
            stats["qualified"] += 1
    return stats


def _audit_live(url: str | None, cfg: dict) -> dict:
    """Production : audit HTTP réel SSRF-safe. Désactivé en dry-run."""
    raise NotImplementedError(
        "Audit HTTP réel non activé (anti-SSRF requis : cf. docs/01 §11). "
        "Repasser dry_run=true."
    )
