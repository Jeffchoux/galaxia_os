"""Agent website_audit — note la faiblesse du site existant et qualifie la cible.

DRY-RUN : utilise les audits fictifs de data/fixtures.json.
Production : audit HTTP réel SSRF-safe (anti-IP privées, timeout, taille max,
respect robots.txt, User-Agent honnête) — squelette désactivé en dry-run.

Qualification (docs/01 §6) : cible = site faible/absent (score < seuil) ET
adresse e-mail générique disponible. Sinon rejet tracé.
"""
from __future__ import annotations

import ipaddress
import json
import socket
import time
import urllib.error
import urllib.request
import urllib.robotparser
from urllib.parse import urljoin, urlparse

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


_PARK_HINTS = (
    "domain for sale", "buy this domain", "this domain is for sale", "parking",
    "domaine à vendre", "ce domaine est à vendre", "domain parking",
    "godaddy", "sedoparking", "future home of", "index of /",
    "site en construction", "under construction", "coming soon",
)


def _host_port(parsed) -> tuple[str | None, int]:
    return parsed.hostname, (parsed.port or (443 if parsed.scheme == "https" else 80))


def _assert_public_host(host: str, port: int) -> None:
    """Anti-SSRF : résout l'hôte et REFUSE si une IP n'est pas publique
    (loopback, privée, lien-local, réservée, multicast). Lève ValueError sinon."""
    infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    ips = {info[4][0] for info in infos}
    if not ips:
        raise ValueError("résolution DNS vide")
    for ip in ips:
        addr = ipaddress.ip_address(ip)
        if not addr.is_global or addr.is_multicast:
            raise ValueError(f"IP non publique {ip}")


def _fetch(url: str, cfg: dict, max_redirects: int = 2) -> dict:
    """GET prudent : schéma http(s) only, hôte public (re-validé à chaque redirection),
    timeout et taille bornés, User-Agent honnête. Lève en cas d'échec."""
    acfg, dcfg = cfg.get("audit", {}), cfg.get("discovery", {})
    timeout = float(acfg.get("timeout_ms", 8000)) / 1000.0
    max_bytes = int(acfg.get("max_bytes", 2_000_000))
    ua = dcfg.get("user_agent", "GalaxiaBot/1.0 (+https://galaxia-os.com/bot)")
    block_private = acfg.get("block_private_ips", True)

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):  # on gère les redirections nous-mêmes
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    current = url
    for _ in range(max_redirects + 1):
        parsed = urlparse(current)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"schéma non autorisé: {parsed.scheme!r}")
        host, port = _host_port(parsed)
        if not host:
            raise ValueError("hôte manquant")
        if block_private:
            _assert_public_host(host, port)
        req = urllib.request.Request(current, headers={"User-Agent": ua})
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                current = urljoin(current, e.headers["Location"])
                continue
            raise
        body = resp.read(max_bytes + 1)[:max_bytes]
        return {"final_url": current, "status": resp.status, "body": body,
                "https": urlparse(current).scheme == "https"}
    raise ValueError("trop de redirections")


def _robots_allows(parsed, cfg: dict) -> bool:
    """True si robots.txt autorise l'audit de la page (défaut permissif si illisible)."""
    ua = (cfg.get("discovery", {}).get("user_agent", "GalaxiaBot")).split("/")[0] or "*"
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        r = _fetch(robots_url, cfg)
    except Exception:
        return True  # pas de robots lisible → on n'interdit pas
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(r["body"].decode("utf-8", "replace").splitlines())
    return rp.can_fetch(ua, parsed.path or "/")


def _looks_parked(body: str) -> bool:
    if len(body.strip()) < 200:
        return True
    return any(h in body for h in _PARK_HINTS)


def _audit_live(url: str | None, cfg: dict) -> dict:
    """Audit HTTP réel SSRF-safe d'un site existant. Renvoie un dict de signaux +
    `score` 0-100 (haut = bon site). Ne lève jamais : en cas de doute on renvoie un
    score qui NE qualifie PAS (on préfère ne pas contacter un site qu'on ne peut pas
    auditer sûrement). Un site absent ou mort = score bas = cible."""
    res = {"has_website": 0, "reachable": 0, "is_https": 0, "ssl_valid": 0,
           "mobile_friendly": 0, "is_parking_page": 0, "load_ms": None,
           "score": 0, "weakness_summary": "", "robots_allowed": 1}

    if not url or not str(url).strip():
        res["weakness_summary"] = "aucun site existant"
        return res  # score 0 → cible parfaite

    res["has_website"] = 1
    res["score"] = 100  # par défaut : on ne contacte pas, sauf preuve de faiblesse
    u = str(url).strip()
    if "://" not in u:
        u = "https://" + u
    parsed = urlparse(u)

    # 1) anti-SSRF : hôte public obligatoire
    try:
        host, port = _host_port(parsed)
        if not host:
            raise ValueError("hôte manquant")
        if cfg.get("audit", {}).get("block_private_ips", True):
            _assert_public_host(host, port)
    except Exception as e:
        res["weakness_summary"] = f"audit refusé (hôte non public): {str(e)[:80]}"
        return res

    # 2) robots.txt
    if cfg.get("audit", {}).get("respect_robots", True):
        if not _robots_allows(parsed, cfg):
            res["robots_allowed"] = 0
            res["weakness_summary"] = "robots.txt interdit l'audit"
            return res

    # 3) fetch + signaux
    t0 = time.monotonic()
    try:
        r = _fetch(u, cfg)
    except Exception as e:
        res["load_ms"] = int((time.monotonic() - t0) * 1000)
        res["score"] = 20  # site déclaré mais injoignable → souvent une cible
        res["weakness_summary"] = f"site injoignable: {str(e)[:80]}"
        return res

    res["load_ms"] = int((time.monotonic() - t0) * 1000)
    body = r["body"].decode("utf-8", "replace").lower()
    is_https = 1 if r["https"] else 0
    viewport = 1 if 'name="viewport"' in body or "name='viewport'" in body else 0
    parked = 1 if _looks_parked(body) else 0
    has_title = "<title" in body

    score = 25  # joignable
    score += 25 if is_https else 0
    score += 20 if viewport else 0
    score += 20 if (not parked and has_title and len(body) > 1500) else 0
    score += 10 if len(body) > 4000 else 0

    weak = []
    if not is_https:
        weak.append("pas de HTTPS")
    if not viewport:
        weak.append("pas adapté mobile")
    if parked:
        weak.append("page parking / en construction")
    if len(body) < 1500:
        weak.append("contenu très maigre")

    res.update(reachable=1, is_https=is_https, ssl_valid=is_https,
               mobile_friendly=viewport, is_parking_page=parked,
               score=min(score, 100),
               weakness_summary="; ".join(weak) or "site correct")
    return res
