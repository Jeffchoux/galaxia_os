"""Galaxia Whisper STT daemon — Sprint 3 § A.3 (dogfooding mère).

Mini-serveur FastAPI qui charge un modèle Whisper via faster-whisper et
expose `POST /transcribe` (multipart audio) -> JSON `{text, language,
duration, latency_s}`. Pensé comme drop-in pour `/api/stt` côté cockpit.

Pourquoi pas Kyutai STT (initialement plan A.3) : le plus petit modèle
Kyutai STT est 1B (stt-1b-en_fr), pensé GPU. Ce VPS n'a pas de GPU.
faster-whisper + large-v3-turbo int8 tourne sur CPU à RTF ≈ 1.2 (turn-based
viable) et le français est correctement transcrit. Quand le procurement GPU
de la galaxie mère se concrétisera, swap d'un coup : changer
`GALAXIA_STT_MODEL`/script. Cf. `docs/DECISIONS.md` § D7.
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

LOG = logging.getLogger("galaxia.whisper")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

MODEL_NAME = os.environ.get("GALAXIA_STT_MODEL", "large-v3-turbo")
COMPUTE_TYPE = os.environ.get("GALAXIA_STT_COMPUTE", "int8")
DEVICE = os.environ.get("GALAXIA_STT_DEVICE", "cpu")
NUM_WORKERS = int(os.environ.get("GALAXIA_STT_WORKERS", "1"))
DEFAULT_LANG = os.environ.get("GALAXIA_STT_LANG", "fr")

model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model
    LOG.info("loading %s (device=%s, compute=%s)...", MODEL_NAME, DEVICE, COMPUTE_TYPE)
    t0 = time.time()
    model = WhisperModel(
        MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE, num_workers=NUM_WORKERS
    )
    LOG.info("loaded in %.1fs", time.time() - t0)
    yield


app = FastAPI(title="Galaxia Whisper STT", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3001", "https://app.galaxia-os.com"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "healthy", "model": MODEL_NAME, "loaded": model is not None}


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str | None = Form(None),
):
    if model is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    lang = (language or DEFAULT_LANG).strip().lower() or None
    # pyav accepte la plupart des formats (webm/opus, ogg, wav, mp3...).
    # On écrit dans un tmpfile pour préserver l'extension d'origine — pyav
    # sniffe parfois mal sur stdin.
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        t0 = time.time()
        segments, info = model.transcribe(
            tmp_path,
            language=lang,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        text = " ".join(s.text for s in segments).strip()
        latency = time.time() - t0
        LOG.info(
            "transcribed lang=%s dur=%.2fs lat=%.2fs RTF=%.2f text=%r",
            info.language,
            info.duration,
            latency,
            latency / info.duration if info.duration else 0,
            text[:80],
        )
        return {
            "text": text,
            "language": info.language,
            "duration": info.duration,
            "latency_s": latency,
        }
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
