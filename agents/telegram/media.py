#!/usr/bin/env python3
"""Route média du worker Telegram : lien TikTok/YouTube/X → résumé.

Pipeline : yt-dlp (métadonnées + audio mp3) → daemon Whisper résident (5502) →
résumé Groq (gratuit). Tout local/souverain. Réutilise la logique éprouvée de
~/.claude/galaxia/pipeline/process_inbox.py.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import requests

import llm

WHISPER_URL = os.environ.get("GALAXIA_WHISPER_URL", "http://127.0.0.1:5502")
YTDLP = os.environ.get("YTDLP_BIN", "/home/galaxia/.claude/galaxia/venv/bin/yt-dlp")


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _info(url: str) -> dict:
    try:
        proc = _run([YTDLP, "--dump-single-json", "--no-warnings", url], timeout=60)
        if proc.returncode != 0:
            return {}
        return json.loads(proc.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return {}


def _audio(url: str, out_dir: Path) -> tuple[Path | None, str]:
    """Retourne (chemin_mp3 | None, message_erreur)."""
    out_tmpl = str(out_dir / "%(id)s.%(ext)s")
    try:
        proc = _run(
            [YTDLP, "-x", "--audio-format", "mp3", "--no-warnings", "-o", out_tmpl, url],
            timeout=300,
        )
        if proc.returncode != 0:
            return None, _short_err(proc.stderr)
        mp3s = list(out_dir.glob("*.mp3"))
        return (mp3s[0], "") if mp3s else (None, "aucun fichier audio produit")
    except subprocess.TimeoutExpired:
        return None, "téléchargement trop long (timeout 300s)"


def _short_err(stderr: str) -> str:
    """Traduit les erreurs yt-dlp courantes en message lisible."""
    s = (stderr or "").strip()
    low = s.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return ("la plateforme bloque le serveur (vérif anti-bot sur l'IP du VPS). "
                "Souvent le cas pour YouTube ; les liens TikTok passent mieux.")
    if "private" in low or "login required" in low:
        return "contenu privé ou nécessitant une connexion."
    if "unavailable" in low or "removed" in low:
        return "vidéo indisponible ou supprimée."
    return s.splitlines()[-1][:200] if s else "erreur yt-dlp inconnue"


def transcribe_audio(data: bytes, filename: str = "voice.ogg", language: str = "fr") -> str:
    """Transcrit un blob audio brut via le daemon Whisper. Retourne le texte.

    Utilisé pour les messages vocaux / fichiers audio reçus directement sur
    Telegram (OGG/Opus, mp3, m4a…) — pyav côté daemon gère la quasi-totalité
    des formats, on conserve juste l'extension d'origine pour aider le sniff.
    """
    res = requests.post(
        f"{WHISPER_URL.rstrip('/')}/transcribe",
        files={"audio": (filename, data, "application/octet-stream")},
        data={"language": language},
        timeout=600,
    )
    res.raise_for_status()
    return (res.json().get("text") or "").strip()


def _transcribe(audio: Path) -> str:
    with audio.open("rb") as f:
        return transcribe_audio(f.read(), filename=audio.name)


def process_media(url: str) -> str:
    """Traite un lien média de bout en bout. Retourne le texte à renvoyer à Jeff."""
    info = _info(url)
    title = info.get("title") or info.get("description", "")[:80] or "(sans titre)"
    author = info.get("uploader") or info.get("channel") or info.get("creator") or ""
    duration = info.get("duration")
    header = f"🎬 {title}"
    if author:
        header += f"\n👤 {author}"
    if duration:
        header += f" · ⏱ {int(duration // 60)}min{int(duration % 60):02d}"

    with tempfile.TemporaryDirectory() as td:
        audio, audio_err = _audio(url, Path(td))
        if not audio:
            # Pas d'audio téléchargeable : on résume au moins la description.
            desc = (info.get("description") or "").strip()
            if not desc:
                return (f"{header}\n\n⚠️ Audio non téléchargeable : {audio_err}\n"
                        f"(aucune description non plus à résumer)\n🔗 {url}")
            summary = llm.groq_summarize(desc, title=title)
            return (f"{header}\n\n⚠️ Audio non téléchargeable ({audio_err}), "
                    f"résumé d'après la description :\n{summary}\n🔗 {url}")
        try:
            transcript = _transcribe(audio)
        except Exception as e:  # noqa: BLE001
            return f"{header}\n\n⚠️ Transcription indisponible ({e}).\n🔗 {url}"

    if not transcript:
        return f"{header}\n\n⚠️ Transcription vide (vidéo sans parole ?).\n🔗 {url}"

    try:
        summary = llm.groq_summarize(transcript, title=title)
    except Exception as e:  # noqa: BLE001
        summary = f"(résumé indisponible : {e})\n\nTranscription :\n{transcript[:1500]}"

    idea = _evaluate_idea_section(transcript, title)
    return f"{header}\n\n📝 Résumé :\n{summary}\n{idea}\n🔗 {url}"


def _evaluate_idea_section(transcript: str, title: str) -> str:
    """Bloc « idée pour Galaxia » : verdict + brief codeur prêt à lancer via /do.

    Best effort : un échec d'évaluation ne doit jamais masquer le résumé.
    """
    try:
        verdict = llm.groq_evaluate_idea(transcript, title=title)
    except Exception as e:  # noqa: BLE001
        return f"\n💡 Idée pour Galaxia : évaluation indisponible ({e}).\n"

    out = f"\n💡 Idée pour Galaxia ?\n{verdict.strip()}\n"
    # Si l'évaluateur a proposé un brief codeur, invite Jeff à le lancer en un geste.
    brief = _extract_brief(verdict)
    if brief:
        out += f"\n👉 Pour le coder : réponds  /do {brief}\n"
    return out


def _extract_brief(verdict: str) -> str:
    """Extrait la ligne « Brief: … » produite par l'évaluateur (vide si verdict ❌)."""
    for line in verdict.splitlines():
        low = line.strip().lower()
        if low.startswith("brief:"):
            return line.split(":", 1)[1].strip()
    return ""
