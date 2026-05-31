#!/usr/bin/env python3
"""Tests du runtime 24/7 : file de tâches, worker, coordinator, désinscription.

Lancer :  python -m unittest discover -s tests   (depuis projects/restaurant/)
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import config, coordinator, db, tasks, unsubscribe, worker  # noqa: E402


class Runtime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = config.load_config()
        db.init_db(cls.cfg)
        # base vierge
        p = db.db_path(cls.cfg)
        cls.conn = db.connect(cls.cfg)
        for t in ("tasks", "emails", "websites", "website_audits",
                  "suppression_list", "businesses", "audit_log", "agent_runs"):
            cls.conn.execute(f"DELETE FROM {t}")

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_01_coordinator_enqueues_cycle(self):
        ids = coordinator.plan_cycle(self.conn, self.cfg)
        self.assertEqual(len(ids), 2)
        self.assertEqual(tasks.pending_count(self.conn), 2)

    def test_02_worker_drains_full_cycle(self):
        # drain traite purge + discover, et les tâches 'process' générées en cours de route.
        processed = worker.drain(self.cfg)
        self.assertGreaterEqual(processed, 4)  # purge + discover + 2 process
        self.assertEqual(tasks.pending_count(self.conn), 0)
        # 2 cibles qualifiées → 2 sites + 2 e-mails dry-run
        n_sites = self.conn.execute("SELECT COUNT(*) c FROM websites").fetchone()["c"]
        n_mails = self.conn.execute(
            "SELECT COUNT(*) c FROM emails WHERE status='dry_run'").fetchone()["c"]
        self.assertEqual(n_sites, 2)
        self.assertEqual(n_mails, 2)
        # toutes les tâches terminées sans erreur
        err = self.conn.execute(
            "SELECT COUNT(*) c FROM tasks WHERE status='error'").fetchone()["c"]
        self.assertEqual(err, 0)

    def test_03_unsubscribe_token_suppresses(self):
        row = self.conn.execute(
            "SELECT unsubscribe_token, to_email, business_id FROM emails "
            "WHERE status='dry_run' LIMIT 1").fetchone()
        res = unsubscribe.handle_unsubscribe(self.conn, row["unsubscribe_token"])
        self.assertTrue(res["ok"])
        self.assertTrue(db.is_suppressed(self.conn, row["to_email"]))
        st = self.conn.execute(
            "SELECT status FROM businesses WHERE id=?", (row["business_id"],)
        ).fetchone()["status"]
        self.assertEqual(st, "suppressed")

    def test_04_unknown_token_is_safe(self):
        res = unsubscribe.handle_unsubscribe(self.conn, "token-bidon")
        self.assertFalse(res["ok"])

    def test_05_takedown_removes_site(self):
        slug = self.conn.execute("SELECT slug FROM websites LIMIT 1").fetchone()["slug"]
        res = unsubscribe.handle_takedown(self.conn, slug)
        self.assertTrue(res["ok"])
        st = self.conn.execute(
            "SELECT status FROM websites WHERE slug=?", (slug,)).fetchone()["status"]
        self.assertEqual(st, "removed")

    def test_06_suppressed_contact_not_recontacted(self):
        # Un prospect dont l'e-mail est sur la liste de suppression, remis en file
        # 'process', ne doit PAS être re-contacté : le worker le re-supprime.
        row = self.conn.execute(
            "SELECT business_id FROM suppression_list WHERE business_id IS NOT NULL LIMIT 1"
        ).fetchone()
        bid = row["business_id"]
        db.set_business_status(self.conn, bid, "qualified", qualified=1)  # force re-éligible
        mails_before = self.conn.execute(
            "SELECT COUNT(*) c FROM emails WHERE business_id=?", (bid,)).fetchone()["c"]
        tasks.enqueue(self.conn, "process", business_id=bid)
        worker.drain(self.cfg)
        st = self.conn.execute(
            "SELECT status FROM businesses WHERE id=?", (bid,)).fetchone()["status"]
        self.assertEqual(st, "suppressed")
        mails_after = self.conn.execute(
            "SELECT COUNT(*) c FROM emails WHERE business_id=?", (bid,)).fetchone()["c"]
        self.assertEqual(mails_before, mails_after)  # aucun nouvel e-mail


if __name__ == "__main__":
    unittest.main(verbosity=2)
