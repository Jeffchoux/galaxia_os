#!/usr/bin/env bash
# Galaxia / restaurant — exécute le pipeline DRY-RUN de bout en bout.
# Découverte → audit → contenu → site statique → e-mails sur disque. Zéro envoi.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

PY="/home/galaxia/.claude/galaxia/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "python3 introuvable" >&2; exit 1; }

# S'assure que la base existe (bootstrap idempotent).
"$PY" -m pipeline.db --init >/dev/null

# --reset par défaut pour un run reproductible ; passer NO_RESET=1 pour cumuler.
RESET_FLAG="--reset"
[ "${NO_RESET:-0}" = "1" ] && RESET_FLAG=""

exec "$PY" -m pipeline.run_dry $RESET_FLAG "$@"
