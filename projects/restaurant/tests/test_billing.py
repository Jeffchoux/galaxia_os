#!/usr/bin/env python3
"""Tests de la facturation Stripe (stdlib unittest, hermétique).

Aucune dépendance au paquet `stripe` ni au réseau : on **injecte un faux module
Stripe** (`stripe_mod=`) et on travaille sur une base SQLite temporaire bâtie
depuis `database/schema.sql`. Couvre :
  - garde Anneau 3 (inerte tant que ring<3 / billing.enabled=false) ;
  - création de Checkout → ligne `subscriptions` en `pending` + bons paramètres ;
  - vérification de signature webhook (rejet si invalide) ;
  - transitions d'état : active → business `converted` + site `claimed` ;
    payment_failed → `past_due` ; subscription.deleted → `canceled`.

Lancer :  python -m unittest discover -s tests   (depuis projects/restaurant/)
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
import sys  # noqa: E402
sys.path.insert(0, str(ROOT))

from pipeline import billing, db as _db  # noqa: E402

SCHEMA = (ROOT / "database" / "schema.sql").read_text(encoding="utf-8")


def make_fake_stripe(captured: dict):
    """Faux module Stripe minimal : capture les paramètres de Checkout et décode
    les webhooks (signature 'goodsig' acceptée, sinon levée)."""
    fake = types.SimpleNamespace(api_key=None)

    def create(**kw):
        captured["checkout_kwargs"] = kw
        return types.SimpleNamespace(
            id="cs_test_123",
            url="https://checkout.stripe.test/cs_test_123",
            customer="cus_test_1",
        )

    fake.checkout = types.SimpleNamespace(
        Session=types.SimpleNamespace(create=create)
    )

    def construct_event(payload, sig_header, secret):
        if sig_header != "goodsig":
            raise ValueError("signature invalide")
        raw = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        return json.loads(raw)

    fake.Webhook = types.SimpleNamespace(construct_event=construct_event)
    return fake


def cfg_active() -> dict:
    return {"ring": 3, "billing": {"enabled": True, "stripe_price_id": "price_test_x"},
            "compliance": {"retention_days": 90}}


class BillingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.dbfile = Path(self.tmp) / "t.db"
        self.conn = sqlite3.connect(self.dbfile, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        os.environ["STRIPE_SECRET_KEY"] = "sk_test_dummy"
        os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_dummy"
        ts = _db.now_ms()
        cur = self.conn.execute(
            "INSERT INTO businesses (name, email, email_is_generic, data_source,"
            " consent_basis, collected_at, retention_until, status, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("Le Petit Tournesol", "contact@tournesol.fr", 1, "manual-fixture",
             "legitimate_interest_b2b", ts, ts + 10**12, "emailed", ts, ts),
        )
        self.business_id = cur.lastrowid
        cur = self.conn.execute(
            "INSERT INTO websites (business_id, slug, status, noindex, dry_run,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (self.business_id, "le-petit-tournesol", "built", 1, 1, ts, ts),
        )
        self.website_id = cur.lastrowid

    def tearDown(self):
        self.conn.close()

    # ── garde Anneau 3 ─────────────────────────────────────────────────────
    def test_inactive_by_default(self):
        self.assertFalse(billing.billing_active({"ring": 0, "billing": {"enabled": True}}))
        self.assertFalse(billing.billing_active({"ring": 3, "billing": {"enabled": False}}))
        self.assertTrue(billing.billing_active(cfg_active()))

    def test_checkout_blocked_when_inactive(self):
        with self.assertRaises(billing.BillingDisabled):
            billing.create_checkout_session(
                self.conn, {"ring": 0, "billing": {"enabled": True}},
                self.business_id, success_url="https://x/ok", cancel_url="https://x/no",
                stripe_mod=make_fake_stripe({}),
            )

    # ── Checkout ───────────────────────────────────────────────────────────
    def test_create_checkout_session(self):
        captured: dict = {}
        out = billing.create_checkout_session(
            self.conn, cfg_active(), self.business_id,
            success_url="https://galaxia/ok", cancel_url="https://galaxia/no",
            stripe_mod=make_fake_stripe(captured),
        )
        self.assertIn("checkout.stripe.test", out["url"])
        # paramètres Stripe corrects
        kw = captured["checkout_kwargs"]
        self.assertEqual(kw["mode"], "subscription")
        self.assertEqual(kw["line_items"][0]["price"], "price_test_x")
        self.assertEqual(kw["customer_email"], "contact@tournesol.fr")
        self.assertEqual(kw["metadata"]["business_id"], str(self.business_id))
        # ligne subscriptions en pending, montant 10,00 €, références opaques
        row = self.conn.execute(
            "SELECT * FROM subscriptions WHERE id=?", (out["subscription_id"],)
        ).fetchone()
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["provider"], "stripe")
        self.assertEqual(row["amount_cents"], 1000)
        self.assertEqual(row["currency"], "EUR")
        self.assertEqual(row["website_id"], self.website_id)
        self.assertEqual(row["provider_customer_id"], "cus_test_1")

    # ── Webhooks ───────────────────────────────────────────────────────────
    def test_webhook_bad_signature_rejected(self):
        with self.assertRaises(Exception):
            billing.verify_and_parse_webhook(
                b'{"type":"x"}', "WRONG", stripe_mod=make_fake_stripe({})
            )

    def test_webhook_good_signature_parses(self):
        evt = billing.verify_and_parse_webhook(
            b'{"type":"ping","data":{"object":{}}}', "goodsig",
            stripe_mod=make_fake_stripe({}),
        )
        self.assertEqual(evt["type"], "ping")

    def test_subscription_active_converts(self):
        sub_id = billing.insert_subscription(
            self.conn, business_id=self.business_id, website_id=self.website_id,
            provider_customer_id="cus_test_1", provider_sub_id="sub_1", status="pending",
        )
        event = {"type": "customer.subscription.updated",
                 "data": {"object": {"id": "sub_1", "customer": "cus_test_1",
                                     "status": "active",
                                     "metadata": {"business_id": str(self.business_id)}}}}
        res = billing.handle_webhook_event(self.conn, cfg_active(), event)
        self.assertEqual(res["status"], "active")

        sub = self.conn.execute("SELECT * FROM subscriptions WHERE id=?", (sub_id,)).fetchone()
        self.assertEqual(sub["status"], "active")
        self.assertIsNotNone(sub["started_at"])
        biz = self.conn.execute("SELECT status FROM businesses WHERE id=?", (self.business_id,)).fetchone()
        self.assertEqual(biz["status"], "converted")
        site = self.conn.execute("SELECT * FROM websites WHERE id=?", (self.website_id,)).fetchone()
        self.assertEqual(site["status"], "claimed")
        self.assertEqual(site["noindex"], 0)
        self.assertEqual(site["dry_run"], 0)

    def test_payment_failed_sets_past_due(self):
        sub_id = billing.insert_subscription(
            self.conn, business_id=self.business_id, website_id=self.website_id,
            provider_customer_id="cus_test_1", provider_sub_id="sub_1", status="active",
        )
        event = {"type": "invoice.payment_failed",
                 "data": {"object": {"subscription": "sub_1", "customer": "cus_test_1"}}}
        billing.handle_webhook_event(self.conn, cfg_active(), event)
        sub = self.conn.execute("SELECT status FROM subscriptions WHERE id=?", (sub_id,)).fetchone()
        self.assertEqual(sub["status"], "past_due")

    def test_subscription_deleted_canceled(self):
        sub_id = billing.insert_subscription(
            self.conn, business_id=self.business_id, website_id=self.website_id,
            provider_customer_id="cus_test_1", provider_sub_id="sub_1", status="active",
        )
        event = {"type": "customer.subscription.deleted",
                 "data": {"object": {"id": "sub_1", "customer": "cus_test_1", "status": "canceled"}}}
        billing.handle_webhook_event(self.conn, cfg_active(), event)
        sub = self.conn.execute("SELECT * FROM subscriptions WHERE id=?", (sub_id,)).fetchone()
        self.assertEqual(sub["status"], "canceled")
        self.assertIsNotNone(sub["canceled_at"])


if __name__ == "__main__":
    unittest.main()
