#!/usr/bin/env bash
# Sandbox NemoClaw — build + run avec capture du log
#
# Usage : ./run.sh [--rebuild]
#
# - Build l'image galaxia/nemoclaw-test:isolated (si absente ou --rebuild)
# - Lance l'installer dans un container jetable
# - Capture la sortie complète dans ./logs/run-<timestamp>.log
# - Container : pas de --privileged, pas de volume mount sensible,
#   pas de socket Docker partagé, juste le réseau bridge par défaut

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="galaxia/nemoclaw-test:isolated"
LOG_DIR="${SCRIPT_DIR}/logs"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_DIR}/run-${TS}.log"

mkdir -p "${LOG_DIR}"

# Build si nécessaire
if [[ "${1:-}" == "--rebuild" ]] || ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
    echo "[sandbox] Build de ${IMAGE_TAG}..."
    docker build -t "${IMAGE_TAG}" "${SCRIPT_DIR}"
fi

echo "[sandbox] Lancement de l'installer NemoClaw dans le container isolé."
echo "[sandbox] Log : ${LOG_FILE}"
echo "[sandbox] ----------------------------------------------------------"

# Note sur les options :
#   --rm                 conteneur jetable
#   --network bridge     réseau standard (l'installer a besoin de github/nvidia)
#   --name               nommé pour kill facile si ça hang
#   -e NEMOCLAW_*=...    non-interactif + accept third-party + provider Ollama
#   timeout 600          coupe au bout de 10 min, ce n'est qu'une observation
#
# Pas de bind-mount du repo, pas de /var/run/docker.sock, pas de --privileged.

timeout --foreground 600 docker run --rm \
    --name "nemoclaw-test-${TS}" \
    --network bridge \
    -e NEMOCLAW_NON_INTERACTIVE=1 \
    -e NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    -e NEMOCLAW_PROVIDER=ollama \
    -e NEMOCLAW_NO_EXPRESS=1 \
    "${IMAGE_TAG}" \
    bash -lc 'set -x; curl -fsSL https://www.nvidia.com/nemoclaw.sh -o /tmp/nemoclaw.sh && bash /tmp/nemoclaw.sh; echo "Exit code: $?"; echo "--- HOME contents ---"; ls -la $HOME; echo "--- ~/.openshell ---"; ls -la $HOME/.openshell 2>/dev/null || echo "(absent)"; echo "--- ~/.nvm ---"; ls -d $HOME/.nvm 2>/dev/null || echo "(absent)"' \
    2>&1 | tee "${LOG_FILE}"

echo ""
echo "[sandbox] Terminé. Log conservé : ${LOG_FILE}"
