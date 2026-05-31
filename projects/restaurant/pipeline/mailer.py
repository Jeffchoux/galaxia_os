"""Envoi e-mail réel via Scaleway TEM (région fr-par).

N'est appelé QUE pour les e-mails non-dry (dry=0). La décision d'envoyer et
SURTOUT le choix du destinataire réel (garde-fou canari/production) sont pris en
amont par `email_gen.resolve_send_target` ; ce module se contente d'expédier ce
qu'on lui passe.

Secrets lus dans l'environnement (jamais en config committée) :
  SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID, SCW_DEFAULT_REGION (défaut fr-par).
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

_API = "https://api.scaleway.com/transactional-email/v1alpha1/regions/{region}/emails"


class MailerError(RuntimeError):
    """Échec d'expédition (config secret absente, HTTP non-2xx, réseau)."""


def send_email(cfg: dict, to_email: str, subject: str, text: str,
               html: str | None = None) -> dict:
    """Expédie un e-mail via l'API Scaleway TEM. Lève MailerError en cas d'échec."""
    secret = os.environ.get("SCW_SECRET_KEY")
    project = os.environ.get("SCW_DEFAULT_PROJECT_ID")
    region = os.environ.get("SCW_DEFAULT_REGION", "fr-par")
    if not secret or not project:
        raise MailerError(
            "SCW_SECRET_KEY / SCW_DEFAULT_PROJECT_ID absents de l'environnement"
        )
    ecfg = cfg.get("email", {})
    payload = {
        "from": {
            "email": ecfg.get("sender_address", "contact@mail.galaxia-os.com"),
            "name": ecfg.get("sender_identity", "Galaxia"),
        },
        "to": [{"email": to_email}],
        "subject": subject,
        "text": text,
        "project_id": project,
    }
    if html:
        payload["html"] = html
    req = urllib.request.Request(
        _API.format(region=region),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"X-Auth-Token": secret, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise MailerError(f"Scaleway HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:  # réseau, DNS, timeout
        raise MailerError(f"réseau Scaleway: {e}") from e
    emails = body.get("emails") or [{}]
    return {"provider_id": emails[0].get("id"),
            "provider_status": emails[0].get("status")}
