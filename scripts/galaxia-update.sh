#!/usr/bin/env bash
#
# Galaxia — pull + verify + apply d'une mise à jour depuis la galaxie mère.
#
# Conçu pour tourner via cron quotidien sur une galaxie fille. Le script :
#   1. Récupère le manifeste de version JSON depuis $UPDATES_URL/manifests/<channel>.json
#   2. Récupère sa signature détachée .sig + vérifie avec cosign (clé publique embarquée)
#   3. Compare la version annoncée à celle installée (/opt/galaxia/VERSION)
#   4. Si différente : docker compose pull && up -d, puis met à jour VERSION
#   5. Logue tout dans /opt/galaxia/logs/update.log
#
# POC initial : structure pleine, dépendances vérifiées, fixture locale testable.
# Le côté serveur (registry / static manifests + signature) viendra avec la
# décision de Jeff sur Q3 (option A/B/C dans docs/UPDATES.md).
#
# Mode test (sans serveur réel) :
#   GALAXIA_UPDATE_FIXTURE=/path/to/fixture-dir bash scripts/galaxia-update.sh
#
# Variables d'environnement :
#   UPDATES_URL    URL racine (défaut https://updates.galaxia-os.com)
#   UPDATE_CHANNEL stable / beta / edge (défaut stable)
#   GALAXIA_DIR    /opt/galaxia
#   COSIGN_PUBKEY  Chemin vers la clé publique cosign (défaut $GALAXIA_DIR/keys/galaxia-os.pub)
#   GALAXIA_UPDATE_FIXTURE  Si défini, lit le manifeste depuis ce répertoire local
#                           au lieu du réseau (utile pour les tests).

set -euo pipefail

UPDATES_URL="${UPDATES_URL:-https://updates.galaxia-os.com}"
UPDATE_CHANNEL="${UPDATE_CHANNEL:-stable}"
GALAXIA_DIR="${GALAXIA_DIR:-/opt/galaxia}"
COSIGN_PUBKEY="${COSIGN_PUBKEY:-$GALAXIA_DIR/keys/galaxia-os.pub}"
LOG_FILE="${LOG_FILE:-$GALAXIA_DIR/logs/update.log}"
VERSION_FILE="${VERSION_FILE:-$GALAXIA_DIR/VERSION}"
FIXTURE="${GALAXIA_UPDATE_FIXTURE:-}"

log()   { printf '[%s] [galaxia-update] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG_FILE" >&2; }
die()   { log "FATAL $*"; exit 1; }
warn()  { log "WARN  $*"; }

# ---------- Pré-requis ----------
require_tool() {
	command -v "$1" >/dev/null 2>&1 || die "Outil manquant : $1"
}

require_tool curl
require_tool python3
# cosign et docker peuvent manquer côté POC mode fixture : on déférera.

mkdir -p "$(dirname "$LOG_FILE")"

# ---------- Étape 1 : récupérer manifest + signature ----------
tmp=$(mktemp -d -t galaxia-update-XXXXXX)
# shellcheck disable=SC2064
trap "rm -rf '$tmp'" EXIT

manifest="$tmp/manifest.json"
signature="$tmp/manifest.json.sig"

if [ -n "$FIXTURE" ]; then
	log "Mode fixture : lecture depuis $FIXTURE"
	[ -f "$FIXTURE/${UPDATE_CHANNEL}.json" ] || die "Fixture manquante : $FIXTURE/${UPDATE_CHANNEL}.json"
	cp "$FIXTURE/${UPDATE_CHANNEL}.json" "$manifest"
	if [ -f "$FIXTURE/${UPDATE_CHANNEL}.json.sig" ]; then
		cp "$FIXTURE/${UPDATE_CHANNEL}.json.sig" "$signature"
	fi
else
	log "Téléchargement du manifeste : $UPDATES_URL/manifests/${UPDATE_CHANNEL}.json"
	curl -fsSL --max-time 30 "$UPDATES_URL/manifests/${UPDATE_CHANNEL}.json" -o "$manifest" \
		|| die "Téléchargement manifeste échoué"
	log "Téléchargement de la signature"
	curl -fsSL --max-time 30 "$UPDATES_URL/manifests/${UPDATE_CHANNEL}.json.sig" -o "$signature" \
		|| die "Téléchargement signature échouée"
fi

# ---------- Étape 2 : vérification signature ----------
if [ -f "$signature" ] && [ -f "$COSIGN_PUBKEY" ] && command -v cosign >/dev/null 2>&1; then
	log "Vérification signature cosign avec $COSIGN_PUBKEY"
	# `--insecure-ignore-tlog` est intentionnel : on est en modèle air-gapped
	# (PMEs hors-ligne ou en réseau d'entreprise). La confiance vient de la
	# clé publique embarquée dans l'installeur, pas de la transparence Rekor.
	# Requiert cosign v2.x — v3 a un autre flow (signing-config) à adresser
	# quand on figera la version dans install.sh.
	if cosign verify-blob --insecure-ignore-tlog --key "$COSIGN_PUBKEY" --signature "$signature" "$manifest" >/dev/null 2>&1; then
		log "Signature OK"
	else
		die "Signature INVALIDE — abort"
	fi
else
	# Cas POC / dev : on warning fort mais on continue, pour pouvoir tester
	# le reste du flow sans clé publique en place.
	warn "Signature non vérifiée (cosign=$(command -v cosign >/dev/null && echo present || echo absent), key=$([ -f "$COSIGN_PUBKEY" ] && echo present || echo absent), sig=$([ -f "$signature" ] && echo present || echo absent))"
	if [ "${GALAXIA_UPDATE_ALLOW_UNSIGNED:-0}" != "1" ]; then
		die "Refus de poursuivre sans signature. Mettre GALAXIA_UPDATE_ALLOW_UNSIGNED=1 pour passer outre (POC uniquement)."
	fi
fi

# ---------- Étape 3 : parse version + comparaison ----------
new_version=$(python3 -c "import json,sys; print(json.load(open('$manifest'))['version'])" 2>/dev/null) \
	|| die "Manifest JSON invalide ou clé 'version' absente"
log "Version annoncée : $new_version"

current_version=""
if [ -f "$VERSION_FILE" ]; then
	current_version=$(cat "$VERSION_FILE")
fi
log "Version installée : ${current_version:-<aucune>}"

if [ "$new_version" = "$current_version" ]; then
	log "Aucune mise à jour à appliquer."
	exit 0
fi

# ---------- Étape 4 : apply ----------
log "Mise à jour : ${current_version:-<aucune>} → $new_version"

# Pull (dépend de docker compose et d'un docker-compose.yml préalablement
# déployé dans $GALAXIA_DIR/current). Étape stubée pour le POC tant que le
# layout côté fille n'est pas figé.
if [ -d "$GALAXIA_DIR/current" ] && command -v docker >/dev/null 2>&1; then
	(cd "$GALAXIA_DIR/current" && docker compose pull && docker compose up -d) \
		|| die "docker compose pull/up failed"
else
	warn "Pas de $GALAXIA_DIR/current ou docker absent — saut du compose pull (POC)"
fi

# Étape 5 : enregistrer la nouvelle version
mkdir -p "$(dirname "$VERSION_FILE")"
echo "$new_version" > "$VERSION_FILE"
log "VERSION mis à jour : $new_version"

log "Mise à jour terminée avec succès."
