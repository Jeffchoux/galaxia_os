"""Récepteur de webhooks Stripe (abonnement restaurant) — stdlib uniquement.

Petit serveur HTTP local (`http.server`) destiné à tourner derrière le Caddy de
la galaxie (reverse-proxy TLS public → `127.0.0.1:PORT`). Il :
  1. n'accepte que `POST` sur le chemin du webhook ;
  2. vérifie la **signature** `Stripe-Signature` (rejette tout webhook non signé) ;
  3. applique l'événement via `billing.handle_webhook_event` ;
  4. répond `200 {"received": true}` (ou `400` si signature/JSON invalide).

Garde Anneau 3 : si la facturation n'est pas active (`billing.billing_active`),
le serveur **refuse de démarrer** — rien n'écoute tant que la décision business
n'est pas prise. Souverain : aucune dépendance hors stdlib + le SDK `stripe`
(importé paresseusement par `billing`, requis seulement à l'exécution réelle).

Lancement :
    python -m pipeline.billing_webhook --host 127.0.0.1 --port 8787
Variables d'env requises : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
"""
from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline import billing, config as _cfg, db as _db  # noqa: E402

WEBHOOK_PATH = "/stripe/webhook"
_MAX_BODY = 1 << 20  # 1 Mio : un webhook Stripe est petit ; au-delà = rejet.


def _make_handler(cfg: dict):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GalaxiaBilling/1.0"

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):  # journald via stderr
            sys.stderr.write("[billing-webhook] " + (fmt % args) + "\n")

        def do_POST(self):  # noqa: N802 (API http.server)
            if self.path.split("?", 1)[0] != WEBHOOK_PATH:
                self._send(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
            except ValueError:
                length = 0
            if length <= 0 or length > _MAX_BODY:
                self._send(400, {"error": "bad content-length"})
                return
            payload = self.rfile.read(length)
            sig = self.headers.get("Stripe-Signature", "")
            try:
                event = billing.verify_and_parse_webhook(payload, sig)
            except Exception as e:  # signature invalide / JSON cassé → 400
                self.log_message("signature/parse rejeté: %s", e)
                self._send(400, {"error": "invalid signature"})
                return
            conn = _db.connect(cfg)
            try:
                result = billing.handle_webhook_event(conn, cfg, event)
            except Exception as e:  # erreur de traitement → 500 (Stripe re-livrera)
                self.log_message("traitement échoué: %s", e)
                self._send(500, {"error": "processing failed"})
                return
            finally:
                conn.close()
            self.log_message("ok type=%s -> %s", event.get("type"), result)
            self._send(200, {"received": True})

        def do_GET(self):  # noqa: N802 — simple sonde de vivacité
            if self.path == "/healthz":
                self._send(200, {"ok": True})
            else:
                self._send(404, {"error": "not found"})

    return Handler


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Récepteur de webhooks Stripe (restaurant)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--config", default=None, help="chemin config YAML")
    args = ap.parse_args(argv)

    cfg = _cfg.load_config(args.config)
    if not billing.billing_active(cfg):
        sys.stderr.write(
            "[billing-webhook] facturation inactive (Anneau 3 + billing.enabled "
            "requis) — refus de démarrer.\n"
        )
        return 2
    _db.init_db(cfg)  # garantit la table subscriptions
    httpd = ThreadingHTTPServer((args.host, args.port), _make_handler(cfg))
    sys.stderr.write(f"[billing-webhook] écoute sur {args.host}:{args.port}{WEBHOOK_PATH}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
