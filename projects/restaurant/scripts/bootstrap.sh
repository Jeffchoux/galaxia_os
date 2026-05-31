#!/usr/bin/env bash
# Galaxia / restaurant — bootstrap idempotent du projet (dry-run, zéro effet externe).
# Initialise la base SQLite à partir du schéma. Aucune install réseau requise
# (pipeline 100% stdlib). Réexécutable sans risque.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # projects/restaurant/
cd "$HERE"

log()  { printf '\033[0;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[bootstrap] WARN\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[bootstrap] ERREUR\033[0m %s\n' "$*" >&2; exit 1; }

# Interpréteur : venv galaxia si présent, sinon python3 système.
PY="/home/galaxia/.claude/galaxia/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "python3 introuvable."
log "interpréteur : $PY"

mkdir -p data logs/dry_run_emails sites
log "dossiers de travail prêts."

log "initialisation de la base SQLite (idempotent)…"
"$PY" -m pipeline.db --init

log "vérification de la config…"
"$PY" -m pipeline.config >/dev/null && log "config OK."

log "bootstrap terminé. Lancer le dry-run :  scripts/run_dry_pipeline.sh"
