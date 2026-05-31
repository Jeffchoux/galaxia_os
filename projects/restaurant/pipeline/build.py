"""Agent build — assemble le site statique à partir des blocs de contenu.

Rend le gabarit templates/site/index.html.tmpl (remplacement de jetons {{...}}),
copie le CSS, écrit le dossier sous sites/{slug}/, et enregistre la ligne
`websites` (dry_run, noindex, TTL 7 j). Aucun appel réseau.
"""
from __future__ import annotations

import html
import shutil

from . import db as _db


def _esc(v) -> str:
    return html.escape(str(v if v is not None else ""), quote=True)


def _render_sections(content: dict) -> str:
    out = []
    for s in content["sections"]:
        cls = "section" if s.get("is_factual") else "section section--placeholder"
        out.append(
            f'    <section class="{cls}">\n'
            f'      <h2>{_esc(s["title"])}</h2>\n'
            f'      <p>{_esc(s["body"])}</p>\n'
            f'    </section>'
        )
    return "\n".join(out)


def build_site(conn, cfg: dict, business: dict, content: dict) -> dict:
    site_cfg = cfg.get("site", {})
    tmpl_dir = _db._cfg.resolve_path(cfg, "site_template")
    tmpl = (tmpl_dir / "index.html.tmpl").read_text(encoding="utf-8")

    slug = content["slug"]
    base = site_cfg.get("base_domain", "try.galaxia-os.com")
    city = content["facts"]["city"]["value"]
    tokens = {
        "ROBOTS": "noindex,nofollow" if site_cfg.get("noindex", True) else "index,follow",
        "NAME": _esc(content["facts"]["name"]["value"]),
        "TITLE_CITY": f" — {_esc(city)}" if city else "",
        "FOOTER_CITY": f" · {_esc(city)}" if city else "",
        "META_DESCRIPTION": _esc(content["meta_description"]),
        "BANNER": _esc(site_cfg.get("banner", "")),
        "HERO_TAGLINE": _esc(content["hero_tagline"]),
        "CUISINE": _esc(content["facts"]["cuisine"]["value"]),
        "ABOUT": _esc(content["about"]),
        "SECTIONS": _render_sections(content),
        "CTA": _esc(content["cta"]),
        "CLAIM_URL": f"https://{base}/{slug}/claim",
        "TAKEDOWN_URL": f"https://{base}/{slug}/takedown",
    }
    rendered = tmpl
    for k, v in tokens.items():
        rendered = rendered.replace("{{" + k + "}}", v)

    out_dir = _db._cfg.resolve_path(cfg, "sites_output") / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(rendered, encoding="utf-8")
    shutil.copyfile(tmpl_dir / "styles.css", out_dir / "styles.css")

    ts = _db.now_ms()
    ttl_ms = int(site_cfg.get("ttl_days", 7)) * 86400 * 1000
    dry = 1 if cfg.get("dry_run", True) else 0
    cur = conn.execute(
        "INSERT INTO websites (business_id, slug, template, build_path, public_url,"
        " noindex, status, dry_run, expires_at, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(slug) DO UPDATE SET build_path=excluded.build_path,"
        " updated_at=excluded.updated_at",
        (business["id"], slug, "default", str(out_dir),
         None if dry else f"https://{base}/{slug}/",
         1 if site_cfg.get("noindex", True) else 0,
         "built", dry, ts + ttl_ms, ts, ts),
    )
    wid = cur.lastrowid
    _db.set_business_status(conn, business["id"], "site_built")
    _db.audit(conn, "website", wid, "built", detail={"slug": slug, "dry_run": bool(dry)})
    return {"website_id": wid, "slug": slug, "path": str(out_dir)}
