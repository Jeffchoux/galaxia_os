#!/usr/bin/env bash
# Galaxia / restaurant — healthcheck des dépendances et de l'état du projet.
# Sort 0 si tout est OK pour un dry-run ; signale (sans échouer) les briques
# de production absentes (Ollama, etc.). Utilisable par monitoring/systemd.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

ok()   { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
miss() { printf '  \033[0;33m–\033[0m %s\n' "$*"; }
bad()  { printf '  \033[0;31m✗\033[0m %s\n' "$*"; }

rc=0
echo "== Galaxia restaurant — healthcheck =="

PY="/home/galaxia/.claude/galaxia/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
if [ -n "$PY" ]; then ok "python : $PY"; else bad "python introuvable"; rc=1; fi

# Base + config (requis pour le dry-run)
if [ -n "$PY" ] && "$PY" -m pipeline.config >/dev/null 2>&1; then ok "config lisible"; else bad "config illisible"; rc=1; fi
if [ -f data/restaurant.db ]; then ok "base data/restaurant.db présente"; else miss "base absente (lancer bootstrap.sh)"; fi

# Espace disque (sites temporaires)
free_gb="$(df -Pk . | awk 'NR==2{printf "%.1f", $4/1024/1024}')"
ok "espace disque libre : ${free_gb} Go"

# Briques de PRODUCTION (non requises en dry-run) — informatif
if command -v curl >/dev/null && curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  ok "Ollama joignable (génération locale dispo)"
else
  miss "Ollama non joignable — OK en dry-run (génération par gabarit)"
fi

# Garde-fou : la config doit être en dry-run tant que l'envoi réel n'est pas validé
if [ -n "$PY" ]; then
  dr="$("$PY" -c 'from pipeline.config import load_config as l; print(l().get("dry_run"))' 2>/dev/null || echo "?")"
  if [ "$dr" = "True" ]; then ok "mode dry-run actif (sûr)"; else bad "dry_run != True — envoi potentiellement actif !"; rc=1; fi
fi

echo "== fin (code $rc) =="
exit $rc
