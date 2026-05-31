"""Agent email — génère l'e-mail d'approche (DRY-RUN : écrit sur disque, jamais envoyé).

Garde-fous durs (docs/01 §3, §4) :
- vérifie la liste de suppression AVANT toute mise en file (sinon status=blocked) ;
- chaque e-mail porte un token de désinscription unique + l'adresse postale + l'identité ;
- en dry-run (défaut), l'e-mail est ÉCRIT dans logs/dry_run_emails/, status='dry_run' ;
- refuse de produire un e-mail sans lien de désinscription (invariant testé).
"""
from __future__ import annotations

import html
import secrets

from . import db as _db


def _make_token() -> str:
    return secrets.token_urlsafe(24)


def _bodies(business: dict, site_url: str, unsub_url: str, postal: str,
            sender: str, lang: str) -> tuple[str, str, str]:
    name = business["name"]
    if lang == "en":
        subject = f"A free website preview for {name}"
        text = (
            f"Hello {name} team,\n\n"
            f"We noticed your restaurant has little or no website, so we built a free "
            f"preview for you — no strings attached:\n  {site_url}\n\n"
            f"If you like it, you can keep it online for 10 EUR/month. If not, simply "
            f"ignore this message, or have the preview removed in one click.\n\n"
            f"This is a commercial message from {sender}.\n"
            f"Postal address: {postal}\n"
            f"Unsubscribe (no more emails from us): {unsub_url}\n"
        )
    else:
        subject = f"Un aperçu de site web gratuit pour {name}"
        text = (
            f"Bonjour l'équipe de {name},\n\n"
            f"Nous avons remarqué que votre restaurant a peu ou pas de site web. "
            f"Nous en avons préparé un aperçu gratuit, sans engagement :\n  {site_url}\n\n"
            f"S'il vous plaît, vous pouvez le garder en ligne pour 10 €/mois. Sinon, "
            f"ignorez simplement ce message — ou demandez sa suppression en un clic.\n\n"
            f"Message commercial envoyé par {sender}.\n"
            f"Adresse postale : {postal}\n"
            f"Se désinscrire (plus aucun e-mail de notre part) : {unsub_url}\n"
        )
    e = lambda s: html.escape(s, quote=True)
    html_body = (
        f"<div style='font-family:sans-serif;max-width:560px'>"
        f"<p>{e(text).splitlines()[0]}</p>"
        + "".join(f"<p>{e(line)}</p>" for line in text.split('\n\n')[1:-1])
        + f"<hr><p style='font-size:12px;color:#666'>{e(sender)}<br>{e(postal)}<br>"
        f"<a href='{e(unsub_url)}'>Se désinscrire / Unsubscribe</a></p></div>"
    )
    return subject, text, html_body


def generate_email(conn, cfg: dict, business: dict, website: dict,
                   lang: str = "fr", kind: str = "outreach") -> dict:
    ecfg = cfg.get("email", {})
    to_email = business.get("email")
    sender = ecfg.get("sender_identity", "Galaxia")
    postal = ecfg.get("sender_postal_address", "")
    base = cfg.get("site", {}).get("base_domain", "try.galaxia-os.com")
    site_url = f"https://{base}/{website['slug']}/"
    token = _make_token()
    unsub_url = f"{ecfg.get('unsubscribe_base_url', 'https://'+base+'/u')}/{token}"

    subject, text, html_body = _bodies(business, site_url, unsub_url, postal, sender, lang)

    # INVARIANT : pas de lien de désinscription -> on refuse.
    if unsub_url not in text or unsub_url not in html_body:
        raise AssertionError("e-mail sans lien de désinscription — refusé")

    ts = _db.now_ms()
    dry = 1 if cfg.get("dry_run", True) or not ecfg.get("send_enabled", False) else 0

    # GARDE-FOU : liste de suppression vérifiée avant toute mise en file.
    if _db.is_suppressed(conn, to_email):
        cur = conn.execute(
            "INSERT INTO emails (business_id, website_id, kind, to_email, subject,"
            " body_text, body_html, unsubscribe_token, sender_identity, status,"
            " dry_run, blocked_reason, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?, 'blocked', ?, 'suppressed', ?, ?)",
            (business["id"], website["website_id"], kind, to_email, subject, text,
             html_body, token, sender, dry, ts, ts),
        )
        _db.audit(conn, "email", cur.lastrowid, "blocked",
                  detail={"reason": "suppressed", "to": to_email})
        return {"email_id": cur.lastrowid, "status": "blocked", "reason": "suppressed"}

    dry_path = None
    if dry:
        out_dir = _db._cfg.resolve_path(cfg, "dry_run_emails")
        out_dir.mkdir(parents=True, exist_ok=True)
        fname = f"{website['slug']}__{lang}__{kind}.txt"
        dry_path = str(out_dir / fname)
        (out_dir / fname).write_text(
            f"To: {to_email}\nSubject: {subject}\nX-Galaxia-DryRun: true\n"
            f"X-Galaxia-Lang: {lang}\n\n{text}", encoding="utf-8",
        )

    status = "dry_run" if dry else "queued"
    cur = conn.execute(
        "INSERT INTO emails (business_id, website_id, kind, to_email, subject,"
        " body_text, body_html, unsubscribe_token, sender_identity, status,"
        " dry_run, dry_run_path, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (business["id"], website["website_id"], kind, to_email, subject, text,
         html_body, token, sender, status, dry, dry_path, ts, ts),
    )
    eid = cur.lastrowid
    _db.set_business_status(conn, business["id"], "contacted")
    _db.audit(conn, "email", eid, "queued" if not dry else "dry_run",
              detail={"to": to_email, "lang": lang, "path": dry_path})
    return {"email_id": eid, "status": status, "path": dry_path, "token": token}
