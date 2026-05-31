#!/usr/bin/env python3
"""Désinscription & retrait — le maillon de conformité (docs/01 §3, §4).

C'est le PRÉREQUIS technique à tout envoi réel : tant que ce mécanisme n'existe
pas et n'est pas testé, on n'envoie rien. Idempotent et irréversible.

- handle_unsubscribe(token) : retrouve l'e-mail via emails.unsubscribe_token,
  l'ajoute à suppression_list (insensible à la casse, jamais retiré), passe le
  prospect en 'suppressed'. Effet immédiat. Honore une demande sous 10 j (CAN-SPAM)
  / sans délai (ePrivacy).
- handle_takedown(slug)     : retire le site (status='removed') et, si une adresse
  est connue, supprime aussi le contact.

Ces fonctions seront appelées par un endpoint HTTP (page /u/{token}, /{slug}/takedown)
quand l'Anneau 1 sera activé ; ici elles sont testées en local.
"""
from __future__ import annotations

from . import config, db


def handle_unsubscribe(conn, token: str) -> dict:
    row = conn.execute(
        "SELECT id, business_id, to_email FROM emails WHERE unsubscribe_token=?",
        (token,),
    ).fetchone()
    if not row:
        return {"ok": False, "reason": "token inconnu"}

    email = row["to_email"]
    db.add_suppression(conn, email, reason="unsubscribe", source="link",
                       business_id=row["business_id"])
    if row["business_id"]:
        db.set_business_status(conn, row["business_id"], "suppressed")
    db.audit(conn, "email", row["id"], "unsubscribed",
             actor="recipient", detail={"email": email})
    return {"ok": True, "email": email, "business_id": row["business_id"]}


def handle_takedown(conn, slug: str, *, suppress_contact: bool = True) -> dict:
    row = conn.execute(
        "SELECT w.id AS wid, w.business_id, b.email"
        " FROM websites w LEFT JOIN businesses b ON b.id = w.business_id"
        " WHERE w.slug=?", (slug,),
    ).fetchone()
    if not row:
        return {"ok": False, "reason": "site inconnu"}

    conn.execute(
        "UPDATE websites SET status='removed', removed_at=?, updated_at=? WHERE id=?",
        (db.now_ms(), db.now_ms(), row["wid"]),
    )
    db.audit(conn, "website", row["wid"], "removed",
             actor="owner", detail={"slug": slug})
    if suppress_contact and row["email"]:
        db.add_suppression(conn, row["email"], reason="takedown", source="link",
                           business_id=row["business_id"])
    if row["business_id"]:
        db.set_business_status(conn, row["business_id"], "suppressed")
    return {"ok": True, "slug": slug, "business_id": row["business_id"]}


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="Désinscription / retrait")
    ap.add_argument("--token", help="token de désinscription")
    ap.add_argument("--takedown", help="slug du site à retirer")
    args = ap.parse_args()
    cfg = config.load_config()
    conn = db.connect(cfg)
    try:
        if args.token:
            print(handle_unsubscribe(conn, args.token))
        elif args.takedown:
            print(handle_takedown(conn, args.takedown))
        else:
            ap.error("préciser --token ou --takedown")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
