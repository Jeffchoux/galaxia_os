#!/usr/bin/env python3
"""Worker autonome d'exécution des ordres Telegram (service galaxia-tg-worker).

Boucle infinie : prend la prochaine tâche `pending` dans tg_tasks, l'exécute via
Claude Code en headless (mêmes droits que l'agent coder, pleine autonomie choisie
par Jeff le 2026-05-30), renvoie le résultat à Jeff sur Telegram.

Filets (pleine autonomie AVEC garde-fous) :
- timeout dur par tâche (TG_TASK_TIMEOUT, défaut 1800 s)
- chaque job tourne dans sa propre session (setsid) → kill-switch /stop propre
- journal d'audit complet dans tg_tasks (prompt, statut, résultat)
- le bot reste séparé : lui n'a aucun droit d'écriture sur le repo.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tasks  # noqa: E402

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
REPO_DIR = os.environ.get("GALAXIA_REPO", "/home/galaxia/galaxia-project")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "/usr/local/bin/claude")
TIMEOUT = int(os.environ.get("TG_TASK_TIMEOUT", "1800"))
MAX_TURNS = os.environ.get("TG_TASK_MAX_TURNS", "80")
POLL_SEC = float(os.environ.get("TG_WORKER_POLL", "3"))
MODEL = os.environ.get("TG_TASK_MODEL", "")  # vide => modèle par défaut du CLI

SYSTEM_PREAMBLE = (
    "Tu es Galaxia en mode exécution autonome, déclenché par un ordre que Jeff a "
    "envoyé depuis Telegram. Tu travailles dans le dépôt du projet (répertoire courant). "
    "Exécute l'ordre de bout en bout. Respecte CLAUDE.md du repo. Termine TOUJOURS par "
    "un résumé de 3 à 6 lignes en français : ce que tu as fait, les fichiers touchés, "
    "l'état (succès / ce qui reste). N'invente jamais un succès : si tu n'as pas pu "
    "finir, dis-le clairement.\n\n=== ORDRE DE JEFF ===\n"
)


def tg_send(chat_id: int, text: str) -> None:
    if not BOT_TOKEN:
        return
    for i in range(0, max(len(text), 1), 3900):  # Telegram: 4096 car max/message
        try:
            requests.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={"chat_id": chat_id, "text": text[i : i + 3900] or "(vide)"},
                timeout=30,
            )
        except Exception:  # noqa: BLE001 — best effort
            pass


DIGEST_SCRIPT = os.environ.get(
    "GALAXIA_DIGEST_SCRIPT",
    "/home/galaxia/.claude/galaxia/pipeline/process_inbox.py",
)
BRIEFS_DIR = Path.home() / ".claude/galaxia/briefs"


def execute(task: dict) -> None:
    """Dispatch selon le type de tâche."""
    kind = task.get("kind")
    if kind == "media":
        _execute_media(task)
    elif kind == "digest":
        _execute_digest(task)
    else:
        _execute_order(task)


def _latest_brief() -> Path | None:
    if not BRIEFS_DIR.exists():
        return None
    briefs = sorted(
        (p for p in BRIEFS_DIR.glob("*.md") if "fallback" not in p.name and "raw" not in p.name),
        reverse=True,
    )
    return briefs[0] if briefs else None


def _execute_digest(task: dict) -> None:
    """Lance le pipeline digest (même user galaxia → pas de sudo) et renvoie le brief."""
    tid, chat_id = task["id"], task["chat_id"]
    before = _latest_brief()
    try:
        proc = subprocess.run(
            ["/home/galaxia/.claude/galaxia/venv/bin/python", DIGEST_SCRIPT],
            cwd=str(Path(DIGEST_SCRIPT).parent),
            capture_output=True, text=True, timeout=TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        tasks.set_status(tid, "error", result=f"digest timeout {TIMEOUT}s")
        tg_send(chat_id, f"⏱ Digest interrompu : délai dépassé ({TIMEOUT}s).")
        return
    except Exception as e:  # noqa: BLE001
        tasks.set_status(tid, "error", result=str(e))
        tg_send(chat_id, f"❌ Digest impossible à lancer : {e}")
        return

    brief = _latest_brief()
    if proc.returncode == 0 and brief and brief != before:
        content = brief.read_text(encoding="utf-8")[:3500]
        tasks.set_status(tid, "done", result=f"brief {brief.stem}")
        tg_send(chat_id, f"✅ Brief prêt — {brief.stem} :\n\n{content}\n\n"
                         f"📊 Détail complet : https://app.galaxia-os.com")
    elif proc.returncode == 0:
        # Tourné sans erreur mais pas de nouveau brief (inbox vide ?).
        tasks.set_status(tid, "done", result="digest sans nouveau brief")
        tg_send(chat_id, "✅ Digest terminé, mais aucun nouveau brief produit "
                         "(inbox vide ou rien de neuf à analyser).")
    else:
        err = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
        tasks.set_status(tid, "error", result=err[:2000])
        tg_send(chat_id, f"⚠️ Digest en échec (exit {proc.returncode}).\n\n{err[-1200:]}")


def _execute_media(task: dict) -> None:
    import media  # local : évite de charger requests/yt-dlp pour les ordres

    tid, chat_id = task["id"], task["chat_id"]
    url = task["prompt"].strip()
    try:
        reply = media.process_media(url)
        tasks.set_status(tid, "done", result=reply)
        tg_send(chat_id, reply)
    except Exception as e:  # noqa: BLE001
        tasks.set_status(tid, "error", result=str(e))
        tg_send(chat_id, f"⚠️ Traitement du lien échoué : {e}\n🔗 {url}")


def _execute_order(task: dict) -> None:
    tid, chat_id = task["id"], task["chat_id"]
    cmd = [CLAUDE_BIN, "-p", SYSTEM_PREAMBLE + task["prompt"],
           "--output-format", "text",
           "--permission-mode", "bypassPermissions",
           "--max-turns", str(MAX_TURNS)]
    if MODEL:
        cmd += ["--model", MODEL]

    try:
        proc = subprocess.Popen(
            cmd, cwd=REPO_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,  # propre groupe → kill-switch
        )
    except Exception as e:  # noqa: BLE001
        tasks.set_status(tid, "error", result=f"lancement claude impossible: {e}")
        tg_send(chat_id, f"❌ Impossible de lancer l'exécution : {e}")
        return

    # pgid = pid du leader de session (start_new_session)
    tasks.set_status(tid, "running", pgid=proc.pid)
    try:
        out, err = proc.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        _kill(proc.pid)
        proc.communicate()
        tasks.set_status(tid, "error", result=f"timeout {TIMEOUT}s")
        tg_send(chat_id, f"⏱ Tâche {tid[:8]} interrompue : délai dépassé ({TIMEOUT}s).")
        return

    # Si /stop est passé par là entre-temps, ne pas écraser le statut killed.
    if tasks.status_of(tid) == "killed":
        tg_send(chat_id, f"🛑 Tâche {tid[:8]} annulée.")
        return

    out = (out or "").strip()
    err = (err or "").strip()
    if proc.returncode == 0:
        tasks.set_status(tid, "done", result=out)
        tg_send(chat_id, f"✅ Terminé ({tid[:8]}).\n\n{out or '(pas de sortie)'}")
    else:
        body = out or err or f"exit {proc.returncode}"
        tasks.set_status(tid, "error", result=body)
        tg_send(chat_id, f"⚠️ Échec ({tid[:8]}, exit {proc.returncode}).\n\n{body[:1500]}")


def _kill(pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGTERM)
        time.sleep(2)
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception:  # noqa: BLE001
        pass


def main() -> None:
    print(f"[tg-worker] démarré (repo={REPO_DIR}, timeout={TIMEOUT}s)", flush=True)
    while True:
        try:
            task = tasks.claim_next()
        except Exception as e:  # noqa: BLE001 — DB momentanément verrouillée, on réessaie
            print(f"[tg-worker] claim err: {e}", file=sys.stderr, flush=True)
            time.sleep(POLL_SEC)
            continue
        if not task:
            time.sleep(POLL_SEC)
            continue
        print(f"[tg-worker] exécution {task['id'][:8]}", flush=True)
        try:
            execute(task)
        except Exception as e:  # noqa: BLE001
            tasks.set_status(task["id"], "error", result=str(e))
            tg_send(task["chat_id"], f"❌ Erreur worker : {e}")


if __name__ == "__main__":
    main()
