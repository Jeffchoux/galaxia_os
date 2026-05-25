# Galaxia Whisper STT daemon

Mini-serveur FastAPI qui charge un modèle Whisper (via faster-whisper /
CTranslate2) et expose `POST /transcribe` consommé par `/api/stt` du cockpit.

Cf. Sprint 3 § A.3 dans `docs/ROADMAP-Q3-2026.md` et `docs/DECISIONS.md` § D7.

## API

| Méthode | Path           | Format                                                                                         | Réponse                                                                |
|---------|----------------|------------------------------------------------------------------------------------------------|------------------------------------------------------------------------|
| GET     | `/health`      | —                                                                                              | `{ status, model, loaded }`                                            |
| POST    | `/transcribe`  | multipart : `audio` (fichier WAV/WebM/Opus/MP3), `language` (optionnel, défaut `fr`)            | `{ text, language, duration, latency_s }`                              |

## Variables d'environnement

| Var                  | Défaut           | Note                                                              |
|----------------------|------------------|-------------------------------------------------------------------|
| `GALAXIA_STT_MODEL`  | `large-v3-turbo` | Tout modèle reconnu par faster-whisper, ou un chemin local CT2    |
| `GALAXIA_STT_DEVICE` | `cpu`            | `cuda` quand le GPU mère arrive                                   |
| `GALAXIA_STT_COMPUTE`| `int8`           | `int8_float16` ou `float16` sur GPU                               |
| `GALAXIA_STT_WORKERS`| `1`              | augmenter si forte concurrence (rare en mode dogfooding mère)     |
| `GALAXIA_STT_LANG`   | `fr`             | Langue par défaut si le client ne précise rien                    |

## Installation (galaxie mère uniquement, cf. D6)

Le venv `tts-venv` est partagé avec Kyutai TTS (les deux dépendent de
PyTorch) — économise ~5 Go de disque.

```bash
sudo -u galaxia /home/galaxia/.claude/galaxia/tts-venv/bin/pip install \
    faster-whisper fastapi uvicorn python-multipart
sudo install -m 644 ops/galaxia-whisper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now galaxia-whisper.service
sudo journalctl -u galaxia-whisper -f
```

Le premier démarrage télécharge le modèle (~1,5 Go pour `large-v3-turbo`)
dans le cache HF de `galaxia`. Suite = quasi instantané.

## Benchmarks mai 2026 (VPS OpenJeff, 8 vCPU, no GPU, int8)

Mesurés sur un échantillon TTS Kyutai de 5,0s en français :

| Modèle            | RTF (CPU) | WER FR perçu          | Note                                       |
|-------------------|-----------|-----------------------|--------------------------------------------|
| `medium`          | 0.86      | acceptable            | viable si latence prioritaire              |
| `large-v3-turbo`  | 1.21      | bon                   | **choix par défaut** — accuracy > latence  |
| `distil-large-v3` | 1.25      | catastrophique en FR  | distill EN-only, à éviter                  |

`large-v3-turbo` rajoute environ +1s de latence par phrase de 5s vs Web
Speech — acceptable pour turn-based STT, à condition que le client coupe
l'enregistrement sur silence (Silero VAD déjà en place dans le cockpit).
