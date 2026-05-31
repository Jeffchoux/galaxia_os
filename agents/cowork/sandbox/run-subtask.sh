#!/usr/bin/env bash
# Galaxia Cowork — wrapper d'exécution d'UNE sous-tâche dans un conteneur jetable.
#
# Chemin déployé attendu par le CONTRAT / l'orchestrateur :
#   /home/galaxia/galaxia-project/agents/cowork/sandbox/run-subtask.sh
# (ce fichier vit dans le worktree de build cowork-build et sera intégré là).
#
# Rôle : l'orchestrateur (orchestrator.mjs) appelle ce script par sous-tâche via
# child_process.spawn(detached). Le script lance le bac à sable galaxia/cowork-sandbox
# avec l'invocation `docker run` EXACTE et durcie du CONTRAT, pipe les
# instructions reçues sur STDIN vers le conteneur, relaie la sortie ligne par
# ligne (STDOUT -> SSE 'log' stream=stdout, STDERR -> SSE 'log' stream=stderr),
# applique un timeout dur (docker kill au dépassement) et sort 0 si la sous-tâche
# a réussi, non-zéro sinon.
#
# CLI :
#   run-subtask.sh <SUBTASK_ID>
#   - $1 = SUBTASK_ID : sert au --name du conteneur (cowork-<id>) et au tag de log.
#   - Les instructions (description rendue + contexte amont accumulé) sont lues
#     sur STDIN et pipées telles quelles dans le conteneur.
#
# Environnement (transmis au conteneur, cf. CONTRAT) :
#   COWORK_WORKSPACE        chemin HÔTE du workspace de la sous-tâche (créé par
#                           l'orchestrateur sous le run dir de la tâche). REQUIS.
#                           Monté en rw sur /workspace ; SEUL point d'écriture.
#   COWORK_EXEC_MODEL       modèle d'exécution in-sandbox (défaut sonnet/groq).
#   COWORK_API_KEY          clé de l'agent in-container (sinon GROQ_API_KEY).
#   GROQ_API_KEY            clé alternative (mode chat rapide gratuit).
#   COWORK_SUBTASK_TIMEOUT  mur en secondes (défaut 600). docker kill au-delà.
#   COWORK_NET              'none' (défaut, sous-tâches safe) ou 'egress'
#                           (sous-tâches qui ont légitimement besoin du réseau ;
#                           l'orchestrateur décide selon le risque).
#   COWORK_SANDBOX_IMAGE    nom de l'image (défaut galaxia/cowork-sandbox).
#
# Idempotent : avant de lancer, on retire tout conteneur résiduel du même nom
# (cowork-<SUBTASK_ID>) — un re-spawn après crash ne bute pas sur un nom occupé.
#
# Souverain : aucune dépendance hors `docker` et coreutils. Tout tourne offline
# (sauf mode egress explicite).

set -euo pipefail

# --- helpers -----------------------------------------------------------------

# Les diagnostics partent sur STDERR : l'orchestrateur les relaie en SSE 'log'
# avec stream='stderr'. STDOUT est RÉSERVÉ à la sortie brute de l'agent
# in-container (relayée en stream='stdout'), donc on n'y écrit jamais nous-mêmes.
log()  { printf '[run-subtask %s] %s\n' "${SUBTASK_ID:-?}" "$*" >&2; }
warn() { printf '[run-subtask %s] WARN: %s\n' "${SUBTASK_ID:-?}" "$*" >&2; }
die()  { printf '[run-subtask %s] FATAL: %s\n' "${SUBTASK_ID:-?}" "$*" >&2; exit 1; }

# --- arguments & environnement ----------------------------------------------

SUBTASK_ID="${1:-}"
[ -n "$SUBTASK_ID" ] || die "SUBTASK_ID manquant (usage: run-subtask.sh <SUBTASK_ID>)"

# Garde-fou anti-injection : le SUBTASK_ID alimente --name et `docker kill`.
# On n'accepte que des identifiants sûrs (alphanum, tiret, underscore).
case "$SUBTASK_ID" in
  *[!A-Za-z0-9_-]*) die "SUBTASK_ID invalide (caractères interdits): $SUBTASK_ID" ;;
esac

COWORK_WORKSPACE="${COWORK_WORKSPACE:-}"
[ -n "$COWORK_WORKSPACE" ] || die "COWORK_WORKSPACE manquant (chemin hôte du workspace)"
[ -d "$COWORK_WORKSPACE" ] || die "COWORK_WORKSPACE n'est pas un répertoire: $COWORK_WORKSPACE"

COWORK_NET="${COWORK_NET:-none}"
case "$COWORK_NET" in
  none|egress) : ;;
  *) die "COWORK_NET invalide (attendu 'none' ou 'egress'): $COWORK_NET" ;;
esac

COWORK_SUBTASK_TIMEOUT="${COWORK_SUBTASK_TIMEOUT:-600}"
case "$COWORK_SUBTASK_TIMEOUT" in
  ''|*[!0-9]*) die "COWORK_SUBTASK_TIMEOUT doit être un entier (secondes): $COWORK_SUBTASK_TIMEOUT" ;;
esac

COWORK_SANDBOX_IMAGE="${COWORK_SANDBOX_IMAGE:-galaxia/cowork-sandbox}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

command -v "$DOCKER_BIN" >/dev/null 2>&1 || die "binaire docker introuvable: $DOCKER_BIN"

CONTAINER_NAME="cowork-${SUBTASK_ID}"

# --- nettoyage idempotent ----------------------------------------------------

# Un conteneur résiduel du même nom (re-spawn après crash de l'orchestrateur)
# ferait échouer `docker run --name`. On le supprime au mieux. --rm devrait déjà
# l'avoir retiré, mais on se protège.
cleanup_stale() {
  if "$DOCKER_BIN" inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    warn "conteneur résiduel $CONTAINER_NAME — suppression"
    "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
cleanup_stale

# --- timeout / kill-switch ---------------------------------------------------

# Tué par l'orchestrateur (SIGTERM/SIGINT) ou par le watchdog de timeout : on
# docker kill le conteneur pour ne pas le laisser tourner orphelin.
on_term() {
  warn "signal reçu — docker kill $CONTAINER_NAME"
  "$DOCKER_BIN" kill "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap on_term TERM INT

# Watchdog : au-delà du mur, docker kill (le conteneur n'a pas de timeout interne
# fiable, surtout en --network=none).
WATCHDOG_PID=""
start_watchdog() {
  (
    sleep "$COWORK_SUBTASK_TIMEOUT"
    printf '[run-subtask %s] WARN: timeout %ss dépassé — docker kill %s\n' \
      "$SUBTASK_ID" "$COWORK_SUBTASK_TIMEOUT" "$CONTAINER_NAME" >&2
    "$DOCKER_BIN" kill "$CONTAINER_NAME" >/dev/null 2>&1 || true
  ) &
  WATCHDOG_PID=$!
}
stop_watchdog() {
  [ -n "${WATCHDOG_PID:-}" ] || return 0
  kill "$WATCHDOG_PID" >/dev/null 2>&1 || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  WATCHDOG_PID=""
}

# --- exécution ---------------------------------------------------------------

log "lancement bac à sable image=$COWORK_SANDBOX_IMAGE net=$COWORK_NET timeout=${COWORK_SUBTASK_TIMEOUT}s"

start_watchdog

# Invocation EXACTE et durcie du CONTRAT. Les instructions arrivent sur STDIN
# (pipées par l'orchestrateur) et sont transmises au conteneur via `-i`.
# STDOUT du conteneur -> notre STDOUT (relayé en SSE log stdout).
# STDERR du conteneur -> notre STDERR (relayé en SSE log stderr).
set +e
"$DOCKER_BIN" run --rm --name "$CONTAINER_NAME" \
  --read-only \
  --tmpfs /tmp:rw,size=64m,noexec,nosuid \
  --network="${COWORK_NET:-none}" \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --pids-limit=256 \
  --memory=1g \
  --memory-swap=1g \
  --cpus=1.0 \
  --user 1000:1000 \
  -i \
  -v "${COWORK_WORKSPACE}:/workspace:rw" \
  -w /workspace \
  -e COWORK_EXEC_MODEL \
  -e COWORK_API_KEY \
  -e GROQ_API_KEY \
  -e COWORK_SUBTASK_TIMEOUT \
  "$COWORK_SANDBOX_IMAGE"
EXIT_CODE=$?
set -e

stop_watchdog

# Code 137 = SIGKILL (timeout/kill-switch via docker kill) — on le signale.
if [ "$EXIT_CODE" -eq 137 ]; then
  warn "conteneur tué (137) — timeout ou kill-switch"
elif [ "$EXIT_CODE" -ne 0 ]; then
  warn "sous-tâche en échec (exit $EXIT_CODE)"
else
  log "sous-tâche terminée (exit 0)"
fi

exit "$EXIT_CODE"
