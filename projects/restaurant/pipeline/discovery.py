"""Agent discovery — découverte de restaurants (sources publiques licites).

Deux sources (docs/03) :
- `fixtures` (défaut) : lit data/fixtures.json, AUCUN appel réseau. Sert aux tests et
  au dry-run hermétique.
- `osm-overpass` : interroge l'API Overpass (OpenStreetMap, ODbL) en LECTURE SEULE.
  Activée seulement si `discovery.source == 'osm-overpass'` ET `discovery.live: true`
  (opt-in, défaut false). La lecture OSM est licite indépendamment du garde-fou
  d'envoi `dry_run` (qui ne concerne que e-mails/publication/paiement) — mais reste
  bornée (cap par run, espacement entre requêtes, User-Agent honnête, backoff).

Garde-fous : ne stocke QUE le minimum public (docs/03 §3) ; marque les e-mails non
génériques (email_is_generic=0) ; trace la provenance (data_source/source_url/ODbL).
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from . import db as _db

# Attribution ODbL obligatoire (docs/03 §1) — portée par chaque enregistrement OSM
# et reprise sur les sites générés.
ODBL_ATTRIBUTION = "Données © les contributeurs OpenStreetMap, sous licence ODbL"
_DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter"

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
    """Retourne la liste des business_id découverts/mis à jour ce run.

    Route selon `discovery.source` + `discovery.live`. Par défaut (live=false) :
    fixtures, zéro réseau — donc tests et dry-run restent hermétiques.
    """
    disc = cfg.get("discovery", {}) or {}
    if disc.get("source") == "osm-overpass" and disc.get("live", False):
        return _discover_from_overpass(conn, cfg)
    return _discover_from_fixtures(conn, cfg)


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


def _overpass_query(city: str, amenity: str = "restaurant") -> str:
    """Requête Overpass QL : restaurants d'une ville (admin_level 7/8), node+way."""
    safe_city = city.replace('"', "")
    return (
        "[out:json][timeout:25];"
        f'area["name"="{safe_city}"]["admin_level"~"7|8"]->.a;'
        "("
        f'node["amenity"="{amenity}"](area.a);'
        f'way["amenity"="{amenity}"](area.a);'
        ");"
        "out center tags;"
    )


def _overpass_fetch(query: str, cfg: dict) -> dict | None:
    """POST une requête Overpass. Retourne le JSON parsé, ou None si échec/quota.

    Ne lève jamais : sur erreur réseau/quota, on log via audit et on rend None
    pour que le pipeline continue (docs/03 §5, docs/01 §12 — backoff, pas de crash).
    """
    disc = cfg.get("discovery", {}) or {}
    url = disc.get("overpass_url") or _DEFAULT_OVERPASS_URL
    ua = disc.get("user_agent") or "GalaxiaBot/1.0 (+https://galaxia-os.com/bot)"
    timeout = float(disc.get("request_timeout_ms", 30000)) / 1000.0
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"User-Agent": ua, "Content-Type": "application/x-www-form-urlencoded"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 504) and attempt < 2:  # quota/surcharge → backoff
                time.sleep(2.0 * (attempt + 1))
                continue
            return None
        except (urllib.error.URLError, OSError, ValueError, TimeoutError):
            if attempt < 2:
                time.sleep(1.0 * (attempt + 1))
                continue
            return None
    return None


def _parse_element(el: dict) -> dict | None:
    """Mappe un élément OSM -> jeu de champs MINIMAL (docs/03 §3). None si sans nom."""
    tags = el.get("tags") or {}
    name = (tags.get("name") or "").strip()
    if not name:
        return None  # un commerce sans nom n'est pas exploitable / pas une cible

    # Géométrie : node -> lat/lon ; way/relation -> center.
    lat = el.get("lat") if el.get("lat") is not None else (el.get("center") or {}).get("lat")
    lon = el.get("lon") if el.get("lon") is not None else (el.get("center") or {}).get("lon")

    hn, street = tags.get("addr:housenumber"), tags.get("addr:street")
    address = " ".join(p for p in (hn, street) if p) or None
    email = tags.get("email") or tags.get("contact:email")
    osm_type, osm_id = el.get("type", "node"), el.get("id")
    external_id = f"{osm_type}/{osm_id}"

    return {
        "name": name,
        "category": tags.get("amenity") or tags.get("cuisine"),
        "address": address,
        "city": tags.get("addr:city"),
        "postal_code": tags.get("addr:postcode"),
        "country": tags.get("addr:country"),
        "lat": lat, "lon": lon,
        "phone": tags.get("phone") or tags.get("contact:phone"),
        "email": email,
        "email_is_generic": 1 if is_generic_email(email) else 0,
        "existing_website": tags.get("website") or tags.get("contact:website"),
        "data_source": "osm-overpass",
        "source_url": f"https://www.openstreetmap.org/{external_id}",
        "external_id": external_id,
        "attribution": ODBL_ATTRIBUTION,
    }


def _discover_from_overpass(conn, cfg: dict, cities: list[str] | None = None) -> list[int]:
    """Découverte OSM/Overpass en LECTURE SEULE, bornée et polie (docs/03 §2/§5).

    - cap global `discovery.max_per_run` (jamais de crawl mondial) ;
    - espacement `discovery.request_delay_ms` entre villes ;
    - User-Agent honnête, backoff sur quota ; toute source en panne -> on continue.
    Provenance ODbL tracée par enregistrement (audit_log + data_source/source_url).
    """
    disc = cfg.get("discovery", {}) or {}
    cities = cities if cities is not None else (disc.get("cities") or [])
    amenity = disc.get("amenity", "restaurant")
    cap = int(disc.get("max_per_run", 20))
    delay = float(disc.get("request_delay_ms", 1500)) / 1000.0

    ids: list[int] = []
    seen_ext: set[str] = set()
    for i, city in enumerate(cities):
        if len(ids) >= cap:
            break
        if i > 0 and delay > 0:
            time.sleep(delay)  # politesse entre requêtes (étiquette API publique)
        payload = _overpass_fetch(_overpass_query(city, amenity), cfg)
        if not payload:
            _db.audit(conn, "discovery", None, "overpass_unavailable",
                      detail={"city": city})
            continue
        for el in payload.get("elements", []):
            if len(ids) >= cap:
                break
            rec = _parse_element(el)
            if not rec or rec["external_id"] in seen_ext:
                continue
            # Beaucoup de POI OSM n'ont pas de tag addr:city ; on retombe sur la ville
            # interrogée (l'aire admin du run) — info publique fiable, pas une invention.
            if not rec.get("city"):
                rec["city"] = city
            seen_ext.add(rec["external_id"])
            bid = _db.upsert_business(conn, rec, cfg)
            if bid > 0:
                _db.audit(conn, "business", bid, "collected_osm",
                          detail={"source_url": rec["source_url"],
                                  "attribution": ODBL_ATTRIBUTION, "city": city})
                ids.append(bid)
    return ids
