#!/usr/bin/env python3
"""Bot Telegram personnel: capte les URLs TikTok/X partagées et les écrit dans inbox.md.

Pousse aussi les documents (PDF, MD, TXT) directement dans la SQLite du cockpit
Galaxia (data/cockpit.db, en mode WAL → multi-writer safe), dans une conversation
dédiée "📱 Inbox Telegram" auto-créée.
"""
from __future__ import annotations

import base64
import logging
import os
import re
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

URL_RE = re.compile(
    r"https?://(?:[a-z0-9.-]+\.)?(?:tiktok\.com|x\.com|twitter\.com)/[^\s]+",
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


async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not is_authorized(chat_id):
        log.warning("rejected message from chat_id=%s", chat_id)
        return

    text = update.effective_message.text or update.effective_message.caption or ""
    matches = list(URL_RE.finditer(text))
    if not matches:
        await update.effective_message.reply_text("❌ Aucune URL TikTok/X détectée.")
        return

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    added: list[str] = []
    INBOX_PATH.parent.mkdir(parents=True, exist_ok=True)
    with INBOX_PATH.open("a", encoding="utf-8") as f:
        for m in matches:
            url = m.group(0)
            kind = classify(url)
            f.write(f"- {ts} | {kind} | {url}\n")
            added.append(kind)

    # Compte total dans l'inbox pour le rappel
    try:
        pending = sum(1 for l in INBOX_PATH.read_text(encoding="utf-8").splitlines() if l.strip())
    except Exception:
        pending = len(added)

    summary = ", ".join(added)
    ack = (
        f"✅ {len(added)} lien(s) reçu(s) ({summary}). Galaxia va l'analyser au prochain digest "
        f"(quotidien 06:30 UTC) — utilise /digest pour déclencher tout de suite.\n"
        f"📥 Inbox actuelle : {pending} item(s) en attente.\n"
        f"📊 Dernier brief : https://app.galaxia-os.com"
    )
    await update.effective_message.reply_text(ack)


async def cmd_digest(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Déclenche le digest immédiat (transcription Whisper + analyse Claude)."""
    if not is_authorized(update.effective_chat.id):
        return
    import asyncio
    await update.effective_message.reply_text(
        "🔄 Digest déclenché… (transcription Whisper + analyse Claude, ~3-5 min). "
        "Je te ping quand le brief est prêt."
    )
    # Lance le digest en non-bloquant via systemctl start
    proc = await asyncio.create_subprocess_exec(
        "/usr/bin/sudo", "-n", "/usr/bin/systemctl", "start", "galaxia-digest.service",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        msg = stderr.decode(errors="replace").strip() or f"exit {proc.returncode}"
        await update.effective_message.reply_text(f"❌ Digest start a échoué : {msg}")
        return
    # Watch la complétion en arrière-plan (poll systemctl)
    asyncio.create_task(_watch_digest_completion(update))


async def _watch_digest_completion(update: Update) -> None:
    import asyncio
    for _ in range(120):  # max 10 min
        await asyncio.sleep(5)
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/systemctl", "is-active", "galaxia-digest.service",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        if out.decode().strip() != "active":
            # Service has finished (either success or failure)
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            brief_path = Path.home() / f".claude/galaxia/briefs/{today}.md"
            if brief_path.exists():
                # Read first 600 chars of the brief as preview
                content = brief_path.read_text(encoding="utf-8")[:600]
                await update.effective_message.reply_text(
                    f"✅ Brief prêt — {today} :\n\n{content}\n\n"
                    f"📊 Détail complet : https://app.galaxia-os.com"
                )
            else:
                await update.effective_message.reply_text(
                    "❌ Digest terminé mais aucun brief produit (voir logs systemd)."
                )
            return
    await update.effective_message.reply_text("⏱ Digest toujours en cours après 10 min, je lâche le watch.")


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
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    log.info(
        "Galaxia bot démarré (inbox=%s, allowed_chat_id=%s)",
        INBOX_PATH,
        ALLOWED_CHAT_ID or "<non défini>",
    )
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
