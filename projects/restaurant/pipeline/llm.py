"""Client LLM souverain — Ollama local (gratuit, hors-ligne, zéro dépendance).

Politique projet (config/default.yaml §llm + DECISIONS « pas de premium par défaut ») :
le moteur par défaut est Ollama en local. Aucun appel réseau sortant : on parle au
daemon `http://127.0.0.1:11434`. Coût = 0 €. Si le daemon est absent/lent, l'appelant
reçoit `ok=False` et retombe sur le comportement déterministe (jamais d'échec dur).

Stdlib uniquement (`urllib`) — reste empaquetable tel quel dans les galaxies filles.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request


def _ollama_cfg(cfg: dict) -> tuple[str, str]:
    llm = (cfg or {}).get("llm", {}) or {}
    o = llm.get("ollama", {}) or {}
    base_url = (o.get("base_url") or "http://127.0.0.1:11434").rstrip("/")
    model = o.get("model") or "llama3.1:8b"
    return base_url, model


def generate(prompt: str, cfg: dict, *, system: str | None = None,
             timeout: float = 30.0, temperature: float = 0.3) -> dict:
    """Appelle Ollama en mode génération non-stream.

    Retourne toujours un dict (jamais d'exception levée vers l'appelant) :
      {text, model, provider, duration_ms, cost_usd, ok, error}
    `ok=False` => l'appelant doit utiliser son repli déterministe.
    """
    base_url, model = _ollama_cfg(cfg)
    payload: dict = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": temperature},
    }
    if system:
        payload["system"] = system

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/api/generate", data=data,
        headers={"Content-Type": "application/json"},
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        text = (body.get("response") or "").strip()
        duration_ms = int((time.time() - started) * 1000)
        return {
            "text": text, "model": f"ollama:{model}", "provider": "ollama",
            "duration_ms": duration_ms, "cost_usd": 0.0,
            "ok": bool(text), "error": None if text else "réponse vide",
        }
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        duration_ms = int((time.time() - started) * 1000)
        return {
            "text": "", "model": f"ollama:{model}", "provider": "ollama",
            "duration_ms": duration_ms, "cost_usd": 0.0,
            "ok": False, "error": f"{type(e).__name__}: {e}",
        }
