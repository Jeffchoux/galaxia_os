#!/usr/bin/env python3
"""Tests du pipeline dry-run restaurant (stdlib unittest, zéro dépendance).

Couvre les exigences de validation du brief :
  - le dry-run tourne de bout en bout ;
  - chaque e-mail généré contient un lien de désinscription + adresse postale ;
  - la liste de suppression bloque l'e-mail (status='blocked') ;
  - le site généré porte noindex + le bandeau de transparence ;
  - rejets attendus : adresse nominative (no_generic_email), site déjà bon.

Lancer :  python -m unittest discover -s tests   (depuis projects/restaurant/)
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import config, db, discovery, email_gen, run_dry  # noqa: E402


class DryRunPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.summary = run_dry.run(reset=True)
        cls.cfg = config.load_config()
        cls.conn = db.connect(cls.cfg)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_pipeline_runs(self):
        self.assertTrue(self.summary["dry_run"])
        self.assertEqual(self.summary["discovered"], 4)
        # 2 cibles valides (Tournesol sans site, Trattoria site faible)
        self.assertEqual(self.summary["qualified"], 2)
        self.assertEqual(self.summary["sites_built"], 2)
        self.assertEqual(self.summary["emails_written"], 2)

    def test_rejections(self):
        rows = self.conn.execute(
            "SELECT name, reject_reason FROM businesses WHERE status='rejected'"
        ).fetchall()
        reasons = {r["name"]: r["reject_reason"] for r in rows}
        self.assertEqual(reasons.get("Sushi Loire"), "no_generic_email")
        self.assertEqual(reasons.get("Brasserie du Château"), "site_already_good")

    def test_every_email_has_unsubscribe_and_postal(self):
        rows = self.conn.execute(
            "SELECT body_text, body_html, unsubscribe_token FROM emails "
            "WHERE status='dry_run'"
        ).fetchall()
        self.assertGreater(len(rows), 0)
        for r in rows:
            self.assertTrue(r["unsubscribe_token"])
            self.assertIn(r["unsubscribe_token"], r["body_text"])
            self.assertIn(r["unsubscribe_token"], r["body_html"])
            # adresse postale présente (chaîne de config injectée)
            self.assertIn("Adresse postale", r["body_text"] + r["body_html"])

    def test_generic_email_detection(self):
        self.assertTrue(discovery.is_generic_email("contact@resto.fr"))
        self.assertTrue(discovery.is_generic_email("info@resto.fr"))
        self.assertTrue(discovery.is_generic_email("reservation.midi@resto.fr"))
        self.assertFalse(discovery.is_generic_email("jean.dupont@gmail.com"))
        self.assertFalse(discovery.is_generic_email(None))

    def test_suppression_list_blocks_email(self):
        # On supprime une adresse cible puis on rejoue : l'e-mail doit être bloqué.
        target = self.conn.execute(
            "SELECT * FROM businesses WHERE email_is_generic=1 AND qualified=1 LIMIT 1"
        ).fetchone()
        self.assertIsNotNone(target)
        db.add_suppression(self.conn, target["email"], reason="unsubscribe")
        self.assertTrue(db.is_suppressed(self.conn, target["email"]))
        self.assertTrue(db.is_suppressed(self.conn, target["email"].upper()))  # casse

        fake_site = {"website_id": None, "slug": "supp-test"}
        res = email_gen.generate_email(self.conn, self.cfg, dict(target), fake_site)
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(res["reason"], "suppressed")

    def test_site_has_noindex_and_banner(self):
        site = self.conn.execute(
            "SELECT build_path, noindex FROM websites LIMIT 1"
        ).fetchone()
        self.assertEqual(site["noindex"], 1)
        html = (Path(site["build_path"]) / "index.html").read_text(encoding="utf-8")
        self.assertIn("noindex", html)
        self.assertIn("Aperçu non officiel généré par Galaxia", html)
        self.assertIn("Supprimer ce site", html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
