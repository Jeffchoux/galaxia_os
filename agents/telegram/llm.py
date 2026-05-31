#!/usr/bin/env python3
"""Helpers LLM pour le bot Telegram Galaxia (conversation + routage d'intention).

- `groq_chat()`      : réponse conversationnelle via Groq (LLM gratuit, défaut Galaxia).
- `classify_intent()`: décide si un message est une simple CONVERSATION ou un ORDRE
                       à exécuter (coder, modifier le repo, lancer une commande…).

Dépendance unique : `requests` (déjà dans le venv). Politique de coût Galaxia :
Groq par défaut, jamais de modèle premium implicite (cf. CLAUDE.md / mémoire).
"""
from __future__ import annotations

import json
import os

import requests

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

SYSTEM_CHAT = (
    "Tu es Galaxia, l'assistant IA souverain de Jeff, joignable depuis Telegram et "
    "tournant sur son VPS (OpenJeff). Réponds en français, de façon concise et directe, "
    "sans markdown lourd (c'est lu dans Telegram). Si Jeff te demande d'EXÉCUTER une "
    "action sur le serveur ou le projet (coder, modifier des fichiers, lancer une "
    "commande, déployer), explique-lui qu'il peut préfixer par /do pour la lancer en "
    "autonomie ; ici, en conversation, tu réfléchis et tu aides."
)

SYSTEM_CLASSIFY = (
    "Tu es un routeur d'intention pour un assistant personnel. On te donne un message "
    "envoyé depuis Telegram. Réponds STRICTEMENT par un JSON "
    '{"intent":"chat"|"task","reason":"..."} et rien d\'autre.\n'
    '- "task" : l\'utilisateur demande d\'EXÉCUTER une action concrète sur le serveur '
    "ou le projet logiciel : coder, créer/modifier/supprimer des fichiers, lancer ou "
    "arrêter un service, déployer, builder, corriger un bug, committer, lancer un "
    "projet, installer un paquet, exécuter une commande shell.\n"
    '- "chat" : question, discussion, explication, brainstorming, info, salutation, '
    "ou tout ce qui n'exige PAS d'agir sur la machine.\n"
    'En cas de doute léger, penche vers "chat".'
)


def _post(messages: list[dict], *, temperature: float, max_tokens: int) -> str:
    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY manquante dans l'environnement du bot")
    res = requests.post(
        GROQ_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {GROQ_API_KEY}",
        },
        json={
            "model": GROQ_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        },
        timeout=60,
    )
    if not res.ok:
        raise RuntimeError(f"Groq {res.status_code}: {res.text[:300]}")
    return res.json()["choices"][0]["message"]["content"].strip()


def groq_chat(history: list[dict], user_text: str) -> str:
    """history = liste de {'role','content'} (tours précédents, sans system)."""
    messages = [{"role": "system", "content": SYSTEM_CHAT}]
    messages.extend(history[-12:])  # fenêtre courte
    messages.append({"role": "user", "content": user_text})
    return _post(messages, temperature=0.7, max_tokens=1024)


SYSTEM_SUMMARY = (
    "Tu résumes pour Jeff le contenu d'une vidéo (TikTok/YouTube/X) à partir de sa "
    "transcription. En français, concis et actionnable : 3 à 5 puces avec l'essentiel, "
    "puis une ligne « 🏷 » avec 3 tags. Pas de blabla d'intro. Si c'est une recette, "
    "une astuce, une idée business ou un tuto, extrais le concret (étapes, chiffres)."
)


def groq_summarize(transcript: str, *, title: str = "") -> str:
    """Résumé gratuit (Groq) d'une transcription média."""
    user = (f"Titre : {title}\n\n" if title else "") + f"Transcription :\n{transcript[:12000]}"
    return _post(
        [
            {"role": "system", "content": SYSTEM_SUMMARY},
            {"role": "user", "content": user},
        ],
        temperature=0.4,
        max_tokens=700,
    )


# --- Évaluation d'une idée vue dans une vidéo comme amélioration de Galaxia ---

SYSTEM_IDEA = (
    "Tu es l'architecte produit de Galaxia, un écosystème IA SOUVERAIN, open-source et "
    "gratuit pour PME. Galaxia n'est PAS un SaaS : c'est un produit fini que chaque PME "
    "installe sur SON propre serveur avec SES clés API (analogie iPhone). Contraintes dures "
    "qui gouvernent toute décision :\n"
    "- Pas de dépendance à un service SaaS tiers propriétaire obligatoire.\n"
    "- Doit pouvoir tourner offline, packagé en Docker, redéployable à l'identique sur N "
    "serveurs (modèle Hub & Spoke : galaxie mère → galaxies filles chez les PME).\n"
    "- Stack existante : cockpit web (chat+voix+code, SvelteKit), bot Telegram, Whisper STT "
    "local, Piper/Kyutai TTS local, Ollama (LLM local), Claude Opus pour coder, MCP.\n\n"
    "On te donne la transcription d'une vidéo (TikTok/YouTube/X) que Jeff a repérée. "
    "Ta mission : dire si l'IDÉE de cette vidéo vaut le coup d'être codée DANS Galaxia. "
    "Sois honnête et critique : la plupart des vidéos ne contiennent PAS d'idée pertinente "
    "pour un assistant IA souverain — dans ce cas dis-le franchement (❌).\n\n"
    "Réponds en français, concis, SANS markdown lourd (lu dans Telegram), au format EXACT :\n"
    "Verdict: <✅ à coder | ⚠️ à creuser | ❌ hors-sujet> — <une phrase>\n"
    "Idée: <l'idée concrète extraite, 1 phrase ; ou 'aucune idée logicielle exploitable'>\n"
    "Fit Galaxia: <pourquoi ça colle ou pas aux contraintes souveraines/offline/Docker, 1-2 phrases>\n"
    "Pour coder: <où ça s'insère dans la stack + approche en 1-2 phrases ; ou pourquoi infaisable>\n"
    "Brief: <SI verdict ✅ ou ⚠️ : un ordre impératif court et autonome que l'agent coder "
    "pourrait exécuter tel quel ; SINON laisse vide>"
)


def groq_evaluate_idea(transcript: str, *, title: str = "") -> str:
    """Évalue (Groq, gratuit) si l'idée d'une vidéo mérite d'être codée dans Galaxia."""
    user = (f"Titre : {title}\n\n" if title else "") + f"Transcription :\n{transcript[:12000]}"
    return _post(
        [
            {"role": "system", "content": SYSTEM_IDEA},
            {"role": "user", "content": user},
        ],
        temperature=0.3,
        max_tokens=600,
    )


def classify_intent(user_text: str) -> tuple[str, str]:
    """Retourne (intent, reason). intent ∈ {'chat','task'}. Robuste aux pannes."""
    low = user_text.strip().lower()
    if low.startswith(("lance ", "exécute", "execute", "déploie", "deploie", "code ",
                       "corrige", "installe", "crée un", "cree un", "build")):
        return "task", "verbe d'action explicite"
    if low.startswith(("?", "comment ", "pourquoi ", "qu'est", "explique", "c'est quoi")):
        return "chat", "question explicite"
    try:
        out = _post(
            [
                {"role": "system", "content": SYSTEM_CLASSIFY},
                {"role": "user", "content": user_text[:2000]},
            ],
            temperature=0.0,
            max_tokens=120,
        )
        start, end = out.find("{"), out.rfind("}")
        data = json.loads(out[start : end + 1])
        intent = "task" if data.get("intent") == "task" else "chat"
        return intent, str(data.get("reason", ""))
    except Exception as e:  # noqa: BLE001 — en cas de doute, on cause (pas d'action)
        return "chat", f"classif indisponible ({e}), repli chat"
