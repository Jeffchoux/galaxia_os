#!/usr/bin/env python3
"""Bot Telegram personnel: capte les URLs TikTok/X partagées et les écrit dans inbox.md.

Pousse aussi les documents (PDF, MD, TXT) directement dans la SQLite du cockpit
Galaxia (data/cockpit.db, en mode WAL → multi-writer safe), dans une conversation
dédiée "📱 Inbox Telegram" auto-créée.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import signal
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import llm
import tasks

BOT_TOKEN = os.environ["BOT_TOKEN"]
ALLOWED_CHAT_ID = int(os.environ.get("ALLOWED_CHAT_ID", "0"))
INBOX_PATH = Path(
    os.environ.get("INBOX_PATH", Path.home() / ".claude/galaxia/inbox.md")
)

# Cockpit SQLite : par défaut sur OpenJeff (galaxie mère).
COCKPIT_DB = Path(
    os.environ.get(
        "COCKPIT_DB_PATH",
        "/home/galaxia/galaxia-project/apps/cockpit/data/cockpit.db",
    )
)
TELEGRAM_CONV_TITLE = "📱 Inbox Telegram"
# Limites alignées sur l'endpoint cockpit /api/documents
MAX_PDF_BYTES = 8 * 1024 * 1024
MAX_TEXT_BYTES = 2 * 1024 * 1024
ALLOWED_MIME = {
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/x-markdown": ".md",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 Mo (limite Anthropic vision)
# 20 Mo : plafond de téléchargement de l'API Bot Telegram (getFile).
MAX_AUDIO_BYTES = 20 * 1024 * 1024

URL_RE = re.compile(
    r"https?://(?:[a-z0-9.-]+\.)?"
    r"(?:tiktok\.com|x\.com|twitter\.com|youtube\.com|youtu\.be|instagram\.com)/[^\s]+",
    re.IGNORECASE,
)

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("galaxia-bot")


def classify(url: str) -> str:
    return "tiktok" if "tiktok.com" in url.lower() else "x"


def is_authorized(chat_id: int) -> bool:
    return ALLOWED_CHAT_ID != 0 and chat_id == ALLOWED_CHAT_ID


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    cid = update.effective_chat.id
    if ALLOWED_CHAT_ID == 0:
        msg = (
            f"🟡 Mode bootstrap.\n"
            f"Ton chat_id = {cid}\n"
            f"Ajoute-le dans .env (ALLOWED_CHAT_ID) puis relance le service."
        )
    elif cid == ALLOWED_CHAT_ID:
        msg = f"✅ Bot autorisé. chat_id={cid}. Envoie/forward des liens TikTok ou X."
    else:
        msg = f"❌ chat_id {cid} non autorisé."
    await update.effective_message.reply_text(msg)


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_authorized(update.effective_chat.id):
        return
    try:
        lines = [l for l in INBOX_PATH.read_text(encoding="utf-8").splitlines() if l.strip()]
        await update.effective_message.reply_text(
            f"📥 Inbox: {len(lines)} item(s) en attente."
        )
    except FileNotFoundError:
        await update.effective_message.reply_text("📥 Inbox vide.")


def _history_path(chat_id: int) -> Path:
    return Path.home() / f".claude/galaxia/tg_chat_{chat_id}.json"


def _load_history(chat_id: int) -> list[dict]:
    try:
        return json.loads(_history_path(chat_id).read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_history(chat_id: int, history: list[dict]) -> None:
    p = _history_path(chat_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(history[-40:], ensure_ascii=False), encoding="utf-8")


def _capture_urls(text: str) -> int:
    """Range les liens TikTok/X dans l'inbox. Retourne le nombre ajouté."""
    matches = list(URL_RE.finditer(text))
    if not matches:
        return 0
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    INBOX_PATH.parent.mkdir(parents=True, exist_ok=True)
    with INBOX_PATH.open("a", encoding="utf-8") as f:
        for m in matches:
            f.write(f"- {ts} | {classify(m.group(0))} | {m.group(0)}\n")
    return len(matches)


async def _launch_task(update: Update, chat_id: int, order: str) -> None:
    """Enqueue un ordre ; le service galaxia-tg-worker le prendra en charge."""
    try:
        tid = await asyncio.to_thread(tasks.enqueue, chat_id, order)
    except Exception as e:  # noqa: BLE001
        await update.effective_message.reply_text(f"❌ Impossible d'enregistrer l'ordre : {e}")
        return
    await update.effective_message.reply_text(
        f"🛠️ Reçu, je m'y mets ({tid[:8]}). Je te réponds ici dès que c'est fait.\n"
        f"/tasks pour voir l'avancement · /stop pour tout annuler."
    )


async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not is_authorized(chat_id):
        log.warning("rejected message from chat_id=%s", chat_id)
        return

    text = (update.effective_message.text or update.effective_message.caption or "").strip()
    if not text:
        return

    await _route_text(update, ctx, chat_id, text)


async def _route_text(
    update: Update, ctx: ContextTypes.DEFAULT_TYPE, chat_id: int, text: str
) -> None:
    """Aiguille un texte (tapé ou transcrit depuis un vocal) : lien média,
    ordre à exécuter, ou simple conversation."""
    # 1) Lien média SEUL (sans vraie phrase autour) → traitement IMMÉDIAT (download +
    #    transcription + résumé) ET capture inbox pour le digest quotidien.
    urls = [m.group(0) for m in URL_RE.finditer(text)]
    if urls and len(URL_RE.sub("", text).strip()) < 4:
        _capture_urls(text)  # garde la trace pour le brief de 06:30
        for url in urls:
            try:
                await asyncio.to_thread(tasks.enqueue, chat_id, url, "media")
            except Exception as e:  # noqa: BLE001
                await update.effective_message.reply_text(f"❌ Impossible d'enregistrer le lien : {e}")
                return
        await update.effective_message.reply_text(
            f"🎬 {len(urls)} lien(s) reçu(s). Je télécharge, transcris et résume — "
            f"je t'envoie le résultat ici dans une minute."
        )
        return

    # 2) Sinon : conversation ou ordre. Groq (gratuit) tranche.
    await ctx.bot.send_chat_action(chat_id=chat_id, action="typing")
    intent, reason = await asyncio.to_thread(llm.classify_intent, text)
    log.info("intent=%s (%s) | %.60s", intent, reason, text)

    if intent == "task":
        await _launch_task(update, chat_id, text)
        return

    # 3) Conversation via Groq, avec mémoire courte par chat.
    history = _load_history(chat_id)
    try:
        reply = await asyncio.to_thread(llm.groq_chat, history, text)
    except Exception as e:  # noqa: BLE001
        log.exception("groq chat failed")
        await update.effective_message.reply_text(f"❌ LLM conversation indisponible : {e}")
        return
    history.append({"role": "user", "content": text})
    history.append({"role": "assistant", "content": reply})
    _save_history(chat_id, history)
    await update.effective_message.reply_text(reply)


async def cmd_do(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Force l'exécution d'un ordre (court-circuite le classifieur)."""
    if not is_authorized(update.effective_chat.id):
        return
    order = (update.effective_message.text or "").partition(" ")[2].strip()
    if not order:
        await update.effective_message.reply_text("Usage : /do <ordre à exécuter>")
        return
    await _launch_task(update, update.effective_chat.id, order)


async def cmd_stop(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Kill-switch : annule toutes les tâches actives (même user → pas de sudo)."""
    if not is_authorized(update.effective_chat.id):
        return
    active = await asyncio.to_thread(tasks.active_tasks)
    if not active:
        await update.effective_message.reply_text("Rien en cours.")
        return
    killed = 0
    for t in active:
        tasks.set_status(t["id"], "killed")
        pgid = t.get("pgid")
        if pgid:
            try:
                os.killpg(int(pgid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, ValueError):
                pass
        killed += 1
    await update.effective_message.reply_text(f"🛑 {killed} tâche(s) annulée(s).")


async def cmd_tasks(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Liste les tâches actives."""
    if not is_authorized(update.effective_chat.id):
        return
    active = await asyncio.to_thread(tasks.active_tasks)
    if not active:
        await update.effective_message.reply_text("Aucune tâche en cours.")
        return
    lines = "\n".join(
        f"• {t['id'][:8]} — {t['status']} — {t['prompt'][:40]}" for t in active
    )
    await update.effective_message.reply_text(f"🛠️ Tâches :\n{lines}")


async def cmd_digest(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Déclenche le digest immédiat via le worker (le bot ne peut pas sudo :
    NoNewPrivileges). Le worker lance process_inbox.py et renvoie le brief."""
    if not is_authorized(update.effective_chat.id):
        return
    chat_id = update.effective_chat.id
    try:
        tid = await asyncio.to_thread(tasks.enqueue, chat_id, "digest", "digest")
    except Exception as e:  # noqa: BLE001
        await update.effective_message.reply_text(f"❌ Impossible de lancer le digest : {e}")
        return
    await update.effective_message.reply_text(
        f"🔄 Digest lancé ({tid[:8]}) — transcription Whisper + analyse Claude (~3-5 min). "
        f"Je t'envoie le brief ici dès qu'il est prêt."
    )


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _ensure_telegram_conversation(db: sqlite3.Connection) -> str:
    """Retourne l'id de la conversation '📱 Inbox Telegram', la crée si absente."""
    row = db.execute(
        "SELECT id FROM conversations WHERE title = ? ORDER BY created_at ASC LIMIT 1",
        (TELEGRAM_CONV_TITLE,),
    ).fetchone()
    if row:
        return row[0]
    cid = str(uuid.uuid4())
    now = _now_ms()
    db.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, summary_until_idx) VALUES (?, ?, ?, ?, 0)",
        (cid, TELEGRAM_CONV_TITLE, now, now),
    )
    db.commit()
    return cid


def _infer_mime(filename: str, declared: str | None) -> str:
    if declared and declared in ALLOWED_MIME:
        return declared
    lower = (filename or "").lower()
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith(".md") or lower.endswith(".markdown"):
        return "text/markdown"
    if lower.endswith(".txt"):
        return "text/plain"
    return declared or ""


def _push_doc_to_cockpit(
    *, filename: str, mime: str, payload: bytes
) -> tuple[str, str]:
    """Insère un document dans la SQLite cockpit. Retourne (doc_id, conv_id)."""
    if not COCKPIT_DB.exists():
        raise RuntimeError(f"DB cockpit absente : {COCKPIT_DB}")
    is_pdf = mime == "application/pdf"
    db = sqlite3.connect(COCKPIT_DB, isolation_level=None, timeout=10)
    try:
        # WAL est déjà activé par le cockpit ; on s'aligne juste sur les pragmas.
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA foreign_keys = ON")
        conv_id = _ensure_telegram_conversation(db)
        doc_id = str(uuid.uuid4())
        now = _now_ms()
        db.execute(
            """INSERT INTO documents
               (id, conversation_id, filename, mime_type, content_text, content_b64, size, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                doc_id,
                conv_id,
                filename[:200],
                mime,
                None if is_pdf else payload.decode("utf-8", errors="replace"),
                base64.b64encode(payload).decode("ascii") if is_pdf else None,
                len(payload),
                now,
            ),
        )
        db.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id)
        )
        db.commit()
        return doc_id, conv_id
    finally:
        db.close()


async def handle_document(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Réceptionne un fichier Telegram (document) et le pousse au cockpit."""
    if not is_authorized(update.effective_chat.id):
        log.warning("rejected document from chat_id=%s", update.effective_chat.id)
        return

    msg = update.effective_message
    tg_doc = msg.document
    if not tg_doc:
        return

    filename = tg_doc.file_name or f"untitled-{int(datetime.now(timezone.utc).timestamp())}"
    mime = _infer_mime(filename, tg_doc.mime_type)
    if mime not in ALLOWED_MIME:
        await msg.reply_text(
            f"❌ Type non supporté ({mime or 'inconnu'}). Accepté : PDF / Markdown / TXT."
        )
        return

    size = tg_doc.file_size or 0
    if mime == "application/pdf":
        limit = MAX_PDF_BYTES
    elif mime in IMAGE_MIMES:
        limit = MAX_IMAGE_BYTES
    else:
        limit = MAX_TEXT_BYTES
    if size and size > limit:
        await msg.reply_text(
            f"❌ Fichier trop gros ({size // 1024} Ko). Max {limit // 1024 // 1024} Mo."
        )
        return

    try:
        file = await tg_doc.get_file()
        payload = bytes(await file.download_as_bytearray())
    except Exception as e:  # noqa: BLE001 — on veut tout attraper et le dire à Jeff
        log.exception("telegram download failed")
        await msg.reply_text(f"❌ Téléchargement Telegram a échoué : {e}")
        return

    if len(payload) > limit:
        await msg.reply_text(
            f"❌ Fichier reçu trop gros ({len(payload) // 1024} Ko). Max {limit // 1024 // 1024} Mo."
        )
        return

    try:
        doc_id, conv_id = _push_doc_to_cockpit(
            filename=filename, mime=mime, payload=payload
        )
    except Exception as e:  # noqa: BLE001
        log.exception("cockpit insert failed")
        await msg.reply_text(f"❌ Insert cockpit a échoué : {e}")
        return

    if mime == "application/pdf":
        pretty_kind, icon = "PDF", "📄"
    elif mime in IMAGE_MIMES:
        pretty_kind, icon = "Image", "🖼️"
    elif "markdown" in mime:
        pretty_kind, icon = "Markdown", "📝"
    else:
        pretty_kind, icon = "TXT", "📃"
    await msg.reply_text(
        f"{icon} {pretty_kind} ingéré dans Galaxia : « {filename} » ({len(payload) // 1024} Ko)\n"
        f"💬 Conversation : « {TELEGRAM_CONV_TITLE} »\n"
        f"🔗 https://app.galaxia-os.com/?c={conv_id}"
    )


async def handle_photo(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Réceptionne une photo Telegram (compressée). Pour qualité max,
    Jeff doit envoyer en 'document'."""
    if not is_authorized(update.effective_chat.id):
        return

    msg = update.effective_message
    photos = msg.photo
    if not photos:
        return

    # photo[-1] est la résolution la plus haute disponible
    largest = photos[-1]
    ts = int(datetime.now(timezone.utc).timestamp())
    filename = f"photo-{ts}.jpg"
    mime = "image/jpeg"
    size = largest.file_size or 0
    if size and size > MAX_IMAGE_BYTES:
        await msg.reply_text(
            f"❌ Image trop grosse ({size // 1024} Ko). Max {MAX_IMAGE_BYTES // 1024 // 1024} Mo."
        )
        return

    try:
        file = await largest.get_file()
        payload = bytes(await file.download_as_bytearray())
    except Exception as e:  # noqa: BLE001
        log.exception("telegram photo download failed")
        await msg.reply_text(f"❌ Téléchargement Telegram a échoué : {e}")
        return

    if len(payload) > MAX_IMAGE_BYTES:
        await msg.reply_text(
            f"❌ Image trop grosse ({len(payload) // 1024} Ko)."
        )
        return

    try:
        _doc_id, conv_id = _push_doc_to_cockpit(
            filename=filename, mime=mime, payload=payload
        )
    except Exception as e:  # noqa: BLE001
        log.exception("cockpit insert failed for photo")
        await msg.reply_text(f"❌ Insert cockpit a échoué : {e}")
        return

    caption = (msg.caption or "").strip()
    extra = f"\n💬 Note : {caption}" if caption else ""
    await msg.reply_text(
        f"🖼️ Image ingérée dans Galaxia ({len(payload) // 1024} Ko).{extra}\n"
        f"💬 Conversation : « {TELEGRAM_CONV_TITLE} »\n"
        f"🔗 https://app.galaxia-os.com/?c={conv_id}"
    )


def _audio_filename(media_obj) -> str:
    """Déduit un nom de fichier (avec extension) pour aider le daemon Whisper.

    Telegram : Voice → audio/ogg (opus), Audio → file_name/mime, VideoNote → mp4.
    """
    fname = getattr(media_obj, "file_name", None)
    if fname:
        return fname
    mime = (getattr(media_obj, "mime_type", None) or "").lower()
    ext = {
        "audio/ogg": ".ogg",
        "audio/opus": ".ogg",
        "audio/mpeg": ".mp3",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "video/mp4": ".mp4",
    }.get(mime, ".ogg")
    return f"voice{ext}"


async def handle_voice(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Réceptionne un vocal / fichier audio / note vidéo Telegram, le transcrit
    (daemon Whisper local) puis route le texte comme un message ordinaire :
    Jeff peut ainsi donner un ordre ou converser à la voix."""
    if not is_authorized(update.effective_chat.id):
        log.warning("rejected voice from chat_id=%s", update.effective_chat.id)
        return

    chat_id = update.effective_chat.id
    msg = update.effective_message
    media_obj = msg.voice or msg.audio or msg.video_note
    if not media_obj:
        return

    size = getattr(media_obj, "file_size", 0) or 0
    if size and size > MAX_AUDIO_BYTES:
        await msg.reply_text(
            f"❌ Audio trop long ({size // 1024 // 1024} Mo). "
            f"Max {MAX_AUDIO_BYTES // 1024 // 1024} Mo (limite Telegram). "
            f"Pour un long enregistrement, envoie-le en plusieurs morceaux."
        )
        return

    await ctx.bot.send_chat_action(chat_id=chat_id, action="typing")
    try:
        file = await media_obj.get_file()
        payload = bytes(await file.download_as_bytearray())
    except Exception as e:  # noqa: BLE001
        log.exception("telegram voice download failed")
        await msg.reply_text(f"❌ Téléchargement Telegram a échoué : {e}")
        return

    import media  # local : ne charge requests qu'au besoin

    filename = _audio_filename(media_obj)
    try:
        text = await asyncio.to_thread(media.transcribe_audio, payload, filename)
    except Exception as e:  # noqa: BLE001
        log.exception("whisper transcription failed")
        await msg.reply_text(
            f"❌ Transcription indisponible ({e}). "
            f"Le daemon Whisper (port 5502) tourne-t-il ?"
        )
        return

    if not text:
        await msg.reply_text("🎙️ Audio reçu mais transcription vide (silence ou bruit ?).")
        return

    # Montre à Jeff ce qui a été compris, puis agit dessus.
    await msg.reply_text(f"🎙️ J'ai entendu :\n« {text} »")
    await _route_text(update, ctx, chat_id, text)


async def cmd_brief(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Renvoie le dernier brief disponible."""
    if not is_authorized(update.effective_chat.id):
        return
    briefs_dir = Path.home() / ".claude/galaxia/briefs"
    if not briefs_dir.exists():
        await update.effective_message.reply_text("📊 Aucun brief produit pour l'instant.")
        return
    briefs = sorted(
        [p for p in briefs_dir.glob("*.md") if "fallback" not in p.name and "raw" not in p.name],
        reverse=True,
    )
    if not briefs:
        await update.effective_message.reply_text("📊 Aucun brief produit pour l'instant.")
        return
    latest = briefs[0]
    content = latest.read_text(encoding="utf-8")[:3500]
    await update.effective_message.reply_text(
        f"📊 Brief le plus récent ({latest.stem}) :\n\n{content}\n\n"
        f"🔗 Détail complet : https://app.galaxia-os.com"
    )


def main() -> None:
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("digest", cmd_digest))
    app.add_handler(CommandHandler("brief", cmd_brief))
    app.add_handler(CommandHandler("do", cmd_do))
    app.add_handler(CommandHandler("stop", cmd_stop))
    app.add_handler(CommandHandler("tasks", cmd_tasks))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(
        MessageHandler(
            filters.VOICE | filters.AUDIO | filters.VIDEO_NOTE, handle_voice
        )
    )
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    log.info(
        "Galaxia bot démarré (inbox=%s, allowed_chat_id=%s)",
        INBOX_PATH,
        ALLOWED_CHAT_ID or "<non défini>",
    )
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
