"""Agent discovery — découverte de restaurants (sources publiques licites).

En DRY-RUN : lit data/fixtures.json (aucun appel réseau).
En production : interroge l'API Overpass (OpenStreetMap, ODbL) — squelette fourni,
volontairement désactivé tant que dry_run=true (docs/03).

Garde-fous : ne stocke QUE le minimum public ; marque les e-mails non génériques
comme non contactables (email_is_generic=0) ; trace la provenance.
"""
from __future__ import annotations

import json
import re

from . import db as _db

# Préfixes d'adresses GÉNÉRIQUES professionnelles acceptés (docs/01 §4).
_GENERIC_LOCALPARTS = {
    "contact", "info", "hello", "bonjour", "reservation", "reservations",
    "resa", "restaurant", "accueil", "direction", "gerant", "contactez",
    "commande", "commandes", "office", "admin", "mail", "email",
}


def is_generic_email(email: str | None) -> bool:
    """Vrai si l'e-mail est une adresse de contact GÉNÉRIQUE (pas nominative)."""
    if not email or "@" not in email:
        return False
    local = email.split("@", 1)[0].lower()
    local = re.sub(r"[._-].*$", "", local)  # 'contact.pro' -> 'contact'
    return local in _GENERIC_LOCALPARTS


def discover(conn, cfg: dict) -> list[int]:
    """Retourne la liste des business_id découverts/mis à jour ce run."""
    if cfg.get("dry_run", True):
        return _discover_from_fixtures(conn, cfg)
    return _discover_from_overpass(conn, cfg)


def _discover_from_fixtures(conn, cfg: dict) -> list[int]:
    path = _db._cfg.resolve_path(cfg, "fixtures")
    data = json.loads(path.read_text(encoding="utf-8"))
    ids: list[int] = []
    cap = int(cfg.get("discovery", {}).get("max_per_run", 20))
    for raw in data.get("businesses", [])[:cap]:
        email = raw.get("email")
        rec = {
            "name": raw["name"], "category": raw.get("category"),
            "address": raw.get("address"), "city": raw.get("city"),
            "postal_code": raw.get("postal_code"), "country": raw.get("country"),
            "lat": raw.get("lat"), "lon": raw.get("lon"),
            "phone": raw.get("phone"), "email": email,
            "email_is_generic": 1 if is_generic_email(email) else 0,
            "existing_website": raw.get("existing_website"),
            "data_source": "manual-fixture",
            "source_url": f"fixture://{raw.get('external_id')}",
            "external_id": raw.get("external_id"),
        }
        bid = _db.upsert_business(conn, rec, cfg)
        # On conserve l'audit_fixture en mémoire via la table audit_log pour l'étape suivante.
        if "audit_fixture" in raw:
            _db.audit(conn, "business", bid, "audit_fixture_seed",
                      detail=raw["audit_fixture"])
        ids.append(bid)
    return ids


def _discover_from_overpass(conn, cfg: dict) -> list[int]:
    """Production uniquement. Désactivé en dry-run.

    Squelette : construit une requête Overpass `node[amenity=restaurant]` sur les
    villes configurées, avec User-Agent honnête et rate limit. Implémentation réseau
    laissée explicitement inactive tant que les conditions de docs/03 (robots, débit,
    attribution ODbL) ne sont pas câblées et validées.
    """
    raise NotImplementedError(
        "Découverte réseau Overpass non activée. Repasser dry_run=true, ou "
        "implémenter l'appel Overpass conformément à docs/03_DATA_SOURCES.md."
    )
