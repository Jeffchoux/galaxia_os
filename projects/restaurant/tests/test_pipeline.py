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
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import config, content, db, discovery, email_gen, run_dry  # noqa: E402


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


class ContentEnrichment(unittest.TestCase):
    """Enrichissement Ollama du texte neutre — opt-in, fact-safe, sans réseau ici."""

    BUSINESS = {"name": "Chez Test", "city": "Tours", "category": "italien",
                "address": "1 rue des Tests", "phone": "0102030405"}

    def test_disabled_by_default_no_network(self):
        # Sentinelle : si le réseau était sollicité, le test casserait.
        import pipeline.llm as llm_mod

        def _boom(*a, **k):
            raise AssertionError("aucun appel LLM ne doit avoir lieu quand désactivé")

        orig = llm_mod.generate
        llm_mod.generate = _boom
        try:
            cfg = config.load_config()
            cfg.setdefault("llm", {})["content_enrichment"] = False
            c = content.build_content(self.BUSINESS, cfg)
        finally:
            llm_mod.generate = orig
        self.assertFalse(c["enrichment"]["used"])
        self.assertEqual(c["enrichment"]["model"], "deterministic")
        self.assertIn("Chez Test vous accueille", c["about"])

    def test_validate_rejects_invented_facts(self):
        original = "Chez Test vous accueille à Tours. Page générée automatiquement."
        # chiffre halluciné (faux horaire/prix/année)
        ok, why = content._validate_enrichment(original, original + " Ouvert depuis 1990.")
        self.assertFalse(ok)
        self.assertIn(why, ("chiffre inventé", "allégation invérifiable"))
        # superlatif invérifiable
        ok2, _ = content._validate_enrichment(original, "Le meilleur restaurant de Tours.")
        self.assertFalse(ok2)
        # vide
        self.assertFalse(content._validate_enrichment(original, "   ")[0])

    def test_validate_accepts_clean_rephrase(self):
        original = "Chez Test vous accueille à Tours. Page générée automatiquement."
        clean = "Bienvenue chez Chez Test, à Tours. Cette page a été générée automatiquement."
        ok, why = content._validate_enrichment(original, clean)
        self.assertTrue(ok, why)

    def test_enabled_uses_clean_output_and_falls_back(self):
        import pipeline.llm as llm_mod
        cfg = config.load_config()
        cfg.setdefault("llm", {})["content_enrichment"] = True
        orig = llm_mod.generate

        # 1) sortie propre acceptée (longueur comparable à l'original, sans fait inventé)
        def _clean(prompt, c, **k):
            return {"text": ("Bienvenue chez Chez Test, à Tours. Cette page est un aperçu de "
                             "site web généré automatiquement à partir d'informations publiques. "
                             "Le restaurateur peut la personnaliser et la compléter en quelques "
                             "instants."),
                    "model": "ollama:test", "provider": "ollama", "duration_ms": 5,
                    "cost_usd": 0.0, "ok": True, "error": None}
        llm_mod.generate = _clean
        try:
            c = content.build_content(self.BUSINESS, cfg)
        finally:
            llm_mod.generate = orig
        self.assertTrue(c["enrichment"]["used"])
        self.assertEqual(c["enrichment"]["cost_usd"], 0.0)
        self.assertIn("automatiquement", c["about"])

        # 2) sortie hallucinée rejetée -> repli déterministe
        def _hallu(prompt, c, **k):
            return {"text": "Le meilleur restaurant, étoilé depuis 1985 !",
                    "model": "ollama:test", "provider": "ollama", "duration_ms": 5,
                    "cost_usd": 0.0, "ok": True, "error": None}
        llm_mod.generate = _hallu
        try:
            c2 = content.build_content(self.BUSINESS, cfg)
        finally:
            llm_mod.generate = orig
        self.assertFalse(c2["enrichment"]["used"])
        self.assertIn("Chez Test vous accueille", c2["about"])

    def test_generate_returns_safe_dict_on_failure(self):
        import pipeline.llm as llm_mod
        cfg = {"llm": {"ollama": {"base_url": "http://127.0.0.1:1", "model": "x"}}}
        res = llm_mod.generate("ping", cfg, timeout=0.2)
        self.assertFalse(res["ok"])
        self.assertEqual(res["cost_usd"], 0.0)
        self.assertEqual(res["text"], "")


class OverpassDiscovery(unittest.TestCase):
    """Découverte OSM/Overpass — parsing, routage opt-in, rate-limit, sans réseau ici."""

    SAMPLE = {
        "elements": [
            {"type": "node", "id": 1, "lat": 47.39, "lon": 0.69,
             "tags": {"name": "Resto Node", "amenity": "restaurant",
                      "addr:housenumber": "12", "addr:street": "rue Tests",
                      "addr:city": "Tours", "addr:postcode": "37000",
                      "contact:email": "contact@resto-node.fr",
                      "website": "http://resto-node.fr", "phone": "0247000000"}},
            {"type": "way", "id": 2, "center": {"lat": 47.40, "lon": 0.70},
             "tags": {"name": "Resto Way", "amenity": "restaurant",
                      "email": "jean.dupont@resto-way.fr"}},  # nominatif -> generic=0
            {"type": "node", "id": 3, "lat": 47.41, "lon": 0.71,
             "tags": {"amenity": "restaurant"}},  # sans nom -> ignoré
        ]
    }

    def _temp_cfg(self):
        cfg = config.load_config()
        tmp = tempfile.mkdtemp(prefix="resto-test-")
        cfg.setdefault("paths", {})["database"] = str(Path(tmp) / "t.db")
        db.init_db(cfg)
        return cfg

    def test_parse_element_minimal_fields(self):
        rec = discovery._parse_element(self.SAMPLE["elements"][0])
        self.assertEqual(rec["external_id"], "node/1")
        self.assertEqual(rec["address"], "12 rue Tests")
        self.assertEqual(rec["data_source"], "osm-overpass")
        self.assertIn("openstreetmap.org/node/1", rec["source_url"])
        self.assertEqual(rec["email_is_generic"], 1)       # contact@ -> générique
        self.assertEqual(rec["attribution"], discovery.ODBL_ATTRIBUTION)
        # way -> géométrie depuis center, e-mail nominatif -> non générique
        way = discovery._parse_element(self.SAMPLE["elements"][1])
        self.assertEqual((way["lat"], way["lon"]), (47.40, 0.70))
        self.assertEqual(way["email_is_generic"], 0)
        # sans nom -> None
        self.assertIsNone(discovery._parse_element(self.SAMPLE["elements"][2]))

    def test_query_targets_amenity_and_city(self):
        q = discovery._overpass_query("Tours", "restaurant")
        self.assertIn('"amenity"="restaurant"', q)
        self.assertIn('"name"="Tours"', q)
        self.assertIn("out center tags", q)

    def test_routing_opt_in(self):
        orig_fx, orig_op = discovery._discover_from_fixtures, discovery._discover_from_overpass
        discovery._discover_from_fixtures = lambda conn, cfg: ["FX"]
        discovery._discover_from_overpass = lambda conn, cfg: ["OP"]
        try:
            cfg = {"discovery": {"source": "osm-overpass", "live": False}}
            self.assertEqual(discovery.discover(None, cfg), ["FX"])  # défaut = fixtures
            cfg["discovery"]["live"] = True
            self.assertEqual(discovery.discover(None, cfg), ["OP"])  # opt-in = overpass
        finally:
            discovery._discover_from_fixtures = orig_fx
            discovery._discover_from_overpass = orig_op

    def test_overpass_inserts_dedups_and_caps(self):
        cfg = self._temp_cfg()
        cfg["discovery"].update(cities=["Tours"], max_per_run=1, request_delay_ms=0)
        orig = discovery._overpass_fetch
        discovery._overpass_fetch = lambda q, c: self.SAMPLE
        conn = db.connect(cfg)
        try:
            ids = discovery._discover_from_overpass(conn, cfg)
            self.assertEqual(len(ids), 1)  # cap respecté
            row = conn.execute("SELECT data_source, source_url FROM businesses WHERE id=?",
                               (ids[0],)).fetchone()
            self.assertEqual(row["data_source"], "osm-overpass")
        finally:
            discovery._overpass_fetch = orig
            conn.close()

    def test_overpass_unavailable_does_not_crash(self):
        cfg = self._temp_cfg()
        cfg["discovery"].update(cities=["Tours"], request_delay_ms=0)
        orig = discovery._overpass_fetch
        discovery._overpass_fetch = lambda q, c: None  # quota/panne
        conn = db.connect(cfg)
        try:
            self.assertEqual(discovery._discover_from_overpass(conn, cfg), [])
        finally:
            discovery._overpass_fetch = orig
            conn.close()

    def test_query_sanitizes_quotes_in_city(self):
        # un nom de ville avec guillemets ne doit pas casser/échapper la requête QL
        q = discovery._overpass_query('Saint-"X"', "restaurant")
        self.assertNotIn('"X"', q)
        self.assertIn('"name"="Saint-X"', q)

    def test_dedup_skips_repeated_osm_id(self):
        # deux fois le même way/2 -> une seule insertion (seen_ext)
        sample = {"elements": [
            self.SAMPLE["elements"][1],
            {"type": "way", "id": 2, "center": {"lat": 47.40, "lon": 0.70},
             "tags": {"name": "Resto Way (doublon)", "amenity": "restaurant"}},
        ]}
        cfg = self._temp_cfg()
        cfg["discovery"].update(cities=["Tours"], max_per_run=20, request_delay_ms=0)
        orig = discovery._overpass_fetch
        discovery._overpass_fetch = lambda q, c: sample
        conn = db.connect(cfg)
        try:
            ids = discovery._discover_from_overpass(conn, cfg)
            self.assertEqual(len(ids), 1)  # le doublon way/2 est écarté
        finally:
            discovery._overpass_fetch = orig
            conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
