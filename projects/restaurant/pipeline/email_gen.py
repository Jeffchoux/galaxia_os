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


def resolve_send_target(ecfg: dict, to_email: str, subject: str):
    """Garde-fou destinataire pour un envoi RÉEL (dry=0).

    - si `email.redirect_all_to` est défini → CANARI : tout part UNIQUEMENT vers
      cette adresse, et le sujet est préfixé pour tracer le destinataire prévu ;
    - sinon, envoi vers le vrai prospect SEULEMENT si `email.allow_production_send` ;
    - sinon bloqué.

    Retourne (destinataire_réel | None, sujet_à_envoyer, raison_blocage | None).
    Si raison_blocage n'est pas None, NE PAS expédier.
    """
    redirect = (ecfg.get("redirect_all_to") or "").strip()
    if redirect:
        return redirect, f"[CANARI → {to_email}] {subject}", None
    if ecfg.get("allow_production_send", False):
        return to_email, subject, None
    return None, subject, "production_send_not_allowed"


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

    if dry:
        cur = conn.execute(
            "INSERT INTO emails (business_id, website_id, kind, to_email, subject,"
            " body_text, body_html, unsubscribe_token, sender_identity, status,"
            " dry_run, dry_run_path, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?, 'dry_run', ?, ?, ?, ?)",
            (business["id"], website["website_id"], kind, to_email, subject, text,
             html_body, token, sender, dry, dry_path, ts, ts),
        )
        eid = cur.lastrowid
        _db.set_business_status(conn, business["id"], "contacted")
        _db.audit(conn, "email", eid, "dry_run",
                  detail={"to": to_email, "lang": lang, "path": dry_path})
        return {"email_id": eid, "status": "dry_run", "path": dry_path, "token": token}

    # --- Envoi RÉEL (dry=0) : garde-fou destinataire AVANT toute expédition ---
    actual_to, send_subject, blocked_reason = resolve_send_target(ecfg, to_email, subject)
    if blocked_reason:
        cur = conn.execute(
            "INSERT INTO emails (business_id, website_id, kind, to_email, subject,"
            " body_text, body_html, unsubscribe_token, sender_identity, status,"
            " dry_run, blocked_reason, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?, 'blocked', ?, ?, ?, ?)",
            (business["id"], website["website_id"], kind, to_email, subject, text,
             html_body, token, sender, dry, blocked_reason, ts, ts),
        )
        _db.audit(conn, "email", cur.lastrowid, "blocked",
                  detail={"reason": blocked_reason, "to": to_email})
        return {"email_id": cur.lastrowid, "status": "blocked", "reason": blocked_reason}

    cur = conn.execute(
        "INSERT INTO emails (business_id, website_id, kind, to_email, subject,"
        " body_text, body_html, unsubscribe_token, sender_identity, status,"
        " dry_run, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?, 'queued', ?, ?, ?)",
        (business["id"], website["website_id"], kind, to_email, subject, text,
         html_body, token, sender, dry, ts, ts),
    )
    eid = cur.lastrowid

    from . import mailer
    try:
        r = mailer.send_email(cfg, actual_to, send_subject, text, html_body)
    except mailer.MailerError as e:
        conn.execute("UPDATE emails SET status='failed', blocked_reason=?, updated_at=?"
                     " WHERE id=?", (str(e)[:200], _db.now_ms(), eid))
        _db.audit(conn, "email", eid, "failed",
                  detail={"error": str(e)[:200], "to_actual": actual_to})
        return {"email_id": eid, "status": "failed", "error": str(e)}

    conn.execute("UPDATE emails SET status='sent', sent_at=?, updated_at=? WHERE id=?",
                 (_db.now_ms(), _db.now_ms(), eid))
    _db.set_business_status(conn, business["id"], "contacted")
    _db.audit(conn, "email", eid, "sent",
              detail={"to_intended": to_email, "to_actual": actual_to,
                      "redirected": actual_to != to_email,
                      "provider_id": r.get("provider_id")})
    return {"email_id": eid, "status": "sent", "to_actual": actual_to,
            "provider_id": r.get("provider_id"), "token": token}
