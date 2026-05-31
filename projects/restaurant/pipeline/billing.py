"""Facturation Stripe de l'abonnement restaurant (Anneau 3).

Conversion payante : un prospect qualifié décide de garder son site en ligne pour
**10 €/mois**. Le paiement, la facturation, la TVA et la rétractation sont
**entièrement délégués à Stripe** : Galaxia ne stocke JAMAIS de numéro de carte
ni de donnée PCI — seulement des **références opaques** (`provider_customer_id`,
`provider_sub_id`) dans la table `subscriptions`. Cf. `docs/04 §5`,
`agents/billing_agent.md`, `docs/01 §3.6`.

Posture souveraine / sûre par défaut :
  - **Garde Anneau 3** : tant que `ring < 3` OU `billing.enabled == false`, AUCUN
    appel à Stripe n'est émis (les fonctions lèvent `BillingDisabled`). Le système
    démarre en Anneau 0 (dry-run) : inerte ici par construction.
  - **Zéro dépendance au chargement** : le paquet `stripe` n'est importé que dans
    les fonctions qui appellent réellement l'API (import paresseux). La suite de
    tests reste donc stdlib/hermétique (on injecte un faux module Stripe).
  - **Secrets hors dépôt** : `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` sont
    lus dans l'environnement (posés dans `/opt/galaxia/config/.env`), jamais
    committés. Le `stripe_price_id` (config) n'est PAS secret.

Le flux complet :
  create_checkout_session()  -> URL Stripe Checkout (mode abonnement) + ligne
                                `subscriptions` en `pending`.
  [Stripe encaisse, envoie des webhooks signés]
  verify_and_parse_webhook() -> vérifie la signature, renvoie l'événement.
  handle_webhook_event()     -> applique l'événement : à `active`, l'abonnement
                                passe `active`, la `business` -> `converted` et le
                                `website` -> `claimed` (permanent, `noindex` levé).
"""
from __future__ import annotations

import os
from typing import Any

from . import db as _db


# Devise et montant figés par le contrat produit (10,00 €/mois). Stripe reste la
# source de vérité du prix (price_id) ; on ne duplique le montant que pour la
# colonne `subscriptions.amount_cents` (lisibilité/reporting).
DEFAULT_CURRENCY = "EUR"
DEFAULT_AMOUNT_CENTS = 1000


class BillingError(Exception):
    """Erreur de facturation (config manquante, garde Anneau 3, etc.)."""


class BillingDisabled(BillingError):
    """La facturation n'est pas activée (ring < 3 ou billing.enabled=false)."""


# ─── Garde Anneau 3 ───────────────────────────────────────────────────────────
def billing_active(cfg: dict) -> bool:
    """Vrai seulement si l'Anneau 3 est atteint ET la facturation explicitement
    activée. Sûr par défaut : tout faux tant que la décision business n'est pas
    prise (cf. QUESTIONS_POUR_JEFF §15.3)."""
    try:
        ring = int(cfg.get("ring", 0))
    except (TypeError, ValueError):
        ring = 0
    enabled = bool(cfg.get("billing", {}).get("enabled", False))
    return ring >= 3 and enabled


def _require_active(cfg: dict) -> None:
    if not billing_active(cfg):
        raise BillingDisabled(
            "facturation inactive (Anneau 3 requis + billing.enabled=true) — "
            "aucun appel Stripe émis"
        )


def _price_id(cfg: dict) -> str:
    pid = cfg.get("billing", {}).get("stripe_price_id")
    if not pid:
        raise BillingError("billing.stripe_price_id absent de la config")
    return str(pid)


def _secret_key() -> str:
    key = os.environ.get("STRIPE_SECRET_KEY", "").strip()
    if not key:
        raise BillingError("STRIPE_SECRET_KEY absente de l'environnement")
    return key


def _webhook_secret() -> str:
    sec = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
    if not sec:
        raise BillingError("STRIPE_WEBHOOK_SECRET absente de l'environnement")
    return sec


def _load_stripe(stripe_mod: Any | None = None, *, with_key: bool = True) -> Any:
    """Import paresseux du SDK Stripe. `stripe_mod` permet l'injection en test
    (faux module) sans installer la dépendance ni toucher au réseau."""
    if stripe_mod is None:
        try:
            import stripe as stripe_mod  # type: ignore
        except ImportError as e:  # pragma: no cover - dépend de l'install
            raise BillingError(
                "le paquet `stripe` n'est pas installé (pip install stripe) — "
                "requis uniquement à l'exécution réelle, pas pour les tests"
            ) from e
    if with_key:
        stripe_mod.api_key = _secret_key()
    return stripe_mod


# ─── Couche DB subscriptions (mappée sur database/schema.sql) ──────────────────
def insert_subscription(conn, *, business_id: int, website_id: int | None,
                        provider_customer_id: str | None, provider_sub_id: str | None,
                        currency: str = DEFAULT_CURRENCY,
                        amount_cents: int = DEFAULT_AMOUNT_CENTS,
                        status: str = "pending") -> int:
    ts = _db.now_ms()
    cur = conn.execute(
        "INSERT INTO subscriptions (business_id, website_id, provider,"
        " provider_customer_id, provider_sub_id, currency, amount_cents, status,"
        " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (business_id, website_id, "stripe", provider_customer_id, provider_sub_id,
         currency, amount_cents, status, ts, ts),
    )
    sid = cur.lastrowid
    _db.audit(conn, "subscription", sid, "created", actor="billing",
              detail={"business_id": business_id, "status": status})
    return sid


def find_subscription(conn, *, provider_sub_id: str | None = None,
                      provider_customer_id: str | None = None,
                      business_id: int | None = None):
    """Retrouve une ligne subscriptions par référence opaque (priorité au sub_id),
    sinon par customer, sinon par business. Renvoie la plus récente."""
    if provider_sub_id:
        row = conn.execute(
            "SELECT * FROM subscriptions WHERE provider_sub_id=? ORDER BY id DESC LIMIT 1",
            (provider_sub_id,),
        ).fetchone()
        if row:
            return row
    if provider_customer_id:
        row = conn.execute(
            "SELECT * FROM subscriptions WHERE provider_customer_id=? ORDER BY id DESC LIMIT 1",
            (provider_customer_id,),
        ).fetchone()
        if row:
            return row
    if business_id is not None:
        return conn.execute(
            "SELECT * FROM subscriptions WHERE business_id=? ORDER BY id DESC LIMIT 1",
            (business_id,),
        ).fetchone()
    return None


def set_subscription_status(conn, sub_id: int, status: str, **extra) -> None:
    sets, vals = ["status=?", "updated_at=?"], [status, _db.now_ms()]
    for k, v in extra.items():
        sets.append(f"{k}=?")
        vals.append(v)
    vals.append(sub_id)
    conn.execute(f"UPDATE subscriptions SET {','.join(sets)} WHERE id=?", vals)
    _db.audit(conn, "subscription", sub_id, f"status:{status}", actor="billing")


# ─── Checkout (création de l'abonnement côté Stripe) ───────────────────────────
def create_checkout_session(conn, cfg: dict, business_id: int, *,
                            success_url: str, cancel_url: str,
                            stripe_mod: Any | None = None) -> dict:
    """Crée une session Stripe Checkout (mode abonnement) pour un prospect et pose
    une ligne `subscriptions` en `pending`. Renvoie {url, session_id, subscription_id}.

    Le client paie sur la page hébergée par Stripe (Galaxia ne voit jamais la
    carte). L'activation réelle de l'abonnement est confirmée plus tard par
    webhook (`handle_webhook_event`)."""
    _require_active(cfg)
    biz = conn.execute(
        "SELECT id, name, email, email_is_generic FROM businesses WHERE id=?",
        (business_id,),
    ).fetchone()
    if not biz:
        raise BillingError(f"business {business_id} introuvable")

    stripe = _load_stripe(stripe_mod)
    site = conn.execute(
        "SELECT id FROM websites WHERE business_id=? ORDER BY id DESC LIMIT 1",
        (business_id,),
    ).fetchone()
    website_id = site["id"] if site else None

    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": _price_id(cfg), "quantity": 1}],
        customer_email=biz["email"] or None,
        success_url=success_url,
        cancel_url=cancel_url,
        client_reference_id=str(business_id),
        metadata={"business_id": str(business_id),
                  "website_id": str(website_id) if website_id else ""},
        subscription_data={"metadata": {"business_id": str(business_id)}},
    )
    # `customer` peut être absent à la création (rempli au paiement) — on stocke ce
    # qu'on a ; le webhook complétera provider_sub_id / provider_customer_id.
    customer_id = getattr(session, "customer", None) or _sget(session, "customer")
    sub_id = insert_subscription(
        conn, business_id=business_id, website_id=website_id,
        provider_customer_id=customer_id, provider_sub_id=None, status="pending",
    )
    url = getattr(session, "url", None) or _sget(session, "url")
    session_id = getattr(session, "id", None) or _sget(session, "id")
    _db.audit(conn, "subscription", sub_id, "checkout_created", actor="billing",
              detail={"session_id": session_id})
    return {"url": url, "session_id": session_id, "subscription_id": sub_id}


# ─── Webhooks Stripe (source de vérité de l'état de l'abonnement) ──────────────
def verify_and_parse_webhook(payload: bytes, sig_header: str, *,
                             stripe_mod: Any | None = None) -> dict:
    """Vérifie la signature Stripe-Signature et renvoie l'événement décodé.
    Lève si la signature est invalide (on ne traite jamais un webhook non signé)."""
    stripe = _load_stripe(stripe_mod, with_key=False)
    event = stripe.Webhook.construct_event(payload, sig_header, _webhook_secret())
    # `construct_event` renvoie un objet façon-dict ; on normalise en dict.
    return event if isinstance(event, dict) else dict(event)


# Mappe un statut d'abonnement Stripe vers nos statuts internes figés (schema.sql).
_STRIPE_STATUS = {
    "active": "active", "trialing": "active",
    "past_due": "past_due", "unpaid": "past_due",
    "canceled": "canceled", "incomplete_expired": "canceled",
}


def handle_webhook_event(conn, cfg: dict, event: dict) -> dict:
    """Applique un événement Stripe à l'état local. Idempotent par nature (re-jouer
    le même événement aboutit au même état). Renvoie un résumé {handled, ...}."""
    etype = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}

    if etype == "checkout.session.completed":
        return _on_checkout_completed(conn, obj)
    if etype in ("customer.subscription.created", "customer.subscription.updated"):
        return _on_subscription_change(conn, cfg, obj)
    if etype == "customer.subscription.deleted":
        return _on_subscription_change(conn, cfg, {**obj, "status": "canceled"})
    if etype == "invoice.payment_failed":
        return _on_payment_failed(conn, obj)
    return {"handled": False, "type": etype}


def _on_checkout_completed(conn, obj: dict) -> dict:
    """À la fin du Checkout : on rattache les références opaques Stripe
    (customer + subscription) à notre ligne `subscriptions`."""
    business_id = _meta_business_id(obj)
    customer = obj.get("customer")
    sub_ref = obj.get("subscription")
    row = find_subscription(conn, provider_customer_id=customer,
                            business_id=business_id)
    if not row:
        return {"handled": True, "type": "checkout.session.completed",
                "matched": False}
    set_subscription_status(conn, row["id"], row["status"],
                            provider_customer_id=customer or row["provider_customer_id"],
                            provider_sub_id=sub_ref or row["provider_sub_id"])
    return {"handled": True, "type": "checkout.session.completed",
            "subscription_id": row["id"]}


def _on_subscription_change(conn, cfg: dict, obj: dict) -> dict:
    """Transition d'état de l'abonnement Stripe. À `active`, on convertit le
    prospect et on rend son site permanent (`claimed`)."""
    sub_ref = obj.get("id")
    customer = obj.get("customer")
    business_id = _meta_business_id(obj)
    internal = _STRIPE_STATUS.get(obj.get("status", ""), "pending")
    row = find_subscription(conn, provider_sub_id=sub_ref,
                            provider_customer_id=customer, business_id=business_id)
    if not row:
        return {"handled": True, "type": "subscription.change", "matched": False}

    extra = {}
    if not row["provider_sub_id"] and sub_ref:
        extra["provider_sub_id"] = sub_ref
    if internal == "active":
        extra["started_at"] = row["started_at"] or _db.now_ms()
    if internal == "canceled":
        extra["canceled_at"] = _db.now_ms()
    set_subscription_status(conn, row["id"], internal, **extra)

    if internal == "active":
        _activate_conversion(conn, row["business_id"], row["website_id"])
    return {"handled": True, "type": "subscription.change",
            "subscription_id": row["id"], "status": internal}


def _on_payment_failed(conn, obj: dict) -> dict:
    sub_ref = obj.get("subscription")
    customer = obj.get("customer")
    row = find_subscription(conn, provider_sub_id=sub_ref, provider_customer_id=customer)
    if not row:
        return {"handled": True, "type": "invoice.payment_failed", "matched": False}
    # Pas de double débit : on signale juste l'état, Stripe gère les relances.
    set_subscription_status(conn, row["id"], "past_due")
    return {"handled": True, "type": "invoice.payment_failed",
            "subscription_id": row["id"]}


def _activate_conversion(conn, business_id: int, website_id: int | None) -> None:
    """Abonnement actif → prospect `converted` + site `claimed` (permanent,
    `noindex` levé). Cf. docs/02 §2 et docs/04 §5."""
    _db.set_business_status(conn, business_id, "converted")
    if website_id is not None:
        conn.execute(
            "UPDATE websites SET status='claimed', noindex=0, dry_run=0,"
            " expires_at=NULL, updated_at=? WHERE id=?",
            (_db.now_ms(), website_id),
        )
        _db.audit(conn, "website", website_id, "claimed", actor="billing",
                  detail={"business_id": business_id})


# ─── petits utilitaires ────────────────────────────────────────────────────────
def _meta_business_id(obj: dict) -> int | None:
    """Extrait business_id de la metadata Stripe (string -> int) si présent."""
    meta = obj.get("metadata") or {}
    raw = meta.get("business_id")
    try:
        return int(raw) if raw not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _sget(obj: Any, key: str):
    """Lecture tolérante objet-ou-dict (les objets Stripe supportent l'indexation)."""
    try:
        return obj[key]
    except (KeyError, TypeError, IndexError):
        return None
