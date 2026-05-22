#!/usr/bin/env bash
#
# Galaxia — publication d'une mise à jour signée depuis la galaxie mère.
#
# Tourne sur la mère (OpenJeff) après chaque release. Construit le manifeste
# JSON, le signe avec la clé privée Galaxia, et le dépose dans le webroot
# qui sera servi par Caddy à updates.galaxia-os.com/manifests/.
#
# Usage :
#   bash scripts/galaxia-publish.sh v0.1.0
#   bash scripts/galaxia-publish.sh v0.2.0-rc1 --channel beta
#
# Variables :
#   GALAXIA_KEY_DIR   /opt/galaxia/keys
#   COSIGN_PASSWORD   passphrase de cosign.key (vide si générée sans password)
#   GALAXIA_WEBROOT   /var/www/galaxia-updates (ou racine du registry Caddy)
#   GALAXIA_COMPOSE_REF  référence (sha256, tag) du compose à pousser
#
# Le script ne pousse rien sur le réseau : il écrit dans GALAXIA_WEBROOT.
# C'est Caddy / le hosting statique qui exposera l'arborescence.

set -euo pipefail

if [ $# -lt 1 ]; then
	echo "Usage: $0 <version> [--channel stable|beta|edge]" >&2
	exit 2
fi

VERSION="$1"; shift
CHANNEL="stable"
while [ $# -gt 0 ]; do
	case "$1" in
		--channel) CHANNEL="$2"; shift 2 ;;
		*) echo "Argument inconnu : $1" >&2; exit 2 ;;
	esac
done

GALAXIA_KEY_DIR="${GALAXIA_KEY_DIR:-/opt/galaxia/keys}"
COSIGN_KEY="${COSIGN_KEY:-$GALAXIA_KEY_DIR/cosign.key}"
GALAXIA_WEBROOT="${GALAXIA_WEBROOT:-/var/www/galaxia-updates}"
GALAXIA_COMPOSE_REF="${GALAXIA_COMPOSE_REF:-}"

log()   { printf '\033[1;36m[galaxia-publish]\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m[galaxia-publish]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- Sanity ----------
command -v cosign >/dev/null 2>&1 || die "cosign manquant — voir scripts/install.sh § install_cosign"
[ -f "$COSIGN_KEY" ] || die "Clé privée absente : $COSIGN_KEY (générer via cosign generate-key-pair)"
case "$CHANNEL" in stable|beta|edge) ;; *) die "Canal invalide : $CHANNEL" ;; esac
# SemVer souple : vX.Y.Z avec préfixe -rc.N ou -poc / -ci possibles
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || die "Version mal formée : $VERSION (attendu vX.Y.Z[-suffixe])"

mkdir -p "$GALAXIA_WEBROOT/manifests"

# ---------- Construction du manifeste ----------
manifest="$GALAXIA_WEBROOT/manifests/${CHANNEL}.json"
sig="$GALAXIA_WEBROOT/manifests/${CHANNEL}.json.sig"
released_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log "Construction du manifeste : channel=$CHANNEL version=$VERSION"
# JSON construit via python3 pour échapper proprement les éventuels caractères
# spéciaux dans GALAXIA_COMPOSE_REF (sha256:..., tag complexe, etc.)
python3 - "$VERSION" "$CHANNEL" "$released_at" "$GALAXIA_COMPOSE_REF" > "$manifest" <<'PY'
import json, sys
version, channel, released_at, compose_ref = sys.argv[1:5]
manifest = {
    "schema": 1,
    "version": version,
    "channel": channel,
    "released_at": released_at,
    "images": {
        "core": compose_ref or f"registry.galaxia-os.com/galaxia/core:{version}",
    },
    "notes_url": f"https://docs.galaxia-os.com/releases/{version}",
}
json.dump(manifest, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
PY

# ---------- Signature ----------
log "Signature avec $COSIGN_KEY"
# COSIGN_PASSWORD lu de l'env — vide par défaut si la clé a été générée sans pwd.
# --tlog-upload=false : modèle air-gapped, on ne touche pas Rekor.
COSIGN_PASSWORD="${COSIGN_PASSWORD:-}" \
	cosign sign-blob --yes --tlog-upload=false \
		--key "$COSIGN_KEY" \
		--output-signature "$sig" \
		"$manifest"

# ---------- Sanity check post-sign ----------
pub="${COSIGN_KEY%.key}.pub"
if [ -f "$pub" ]; then
	log "Vérification immédiate avec $pub"
	cosign verify-blob --insecure-ignore-tlog --key "$pub" --signature "$sig" "$manifest" \
		|| die "Vérification immédiate échouée — manifeste/signature incohérents"
fi

log "Publié dans $GALAXIA_WEBROOT/manifests/ :"
ls -la "$GALAXIA_WEBROOT/manifests/${CHANNEL}.json"* >&2

cat <<NEXT
Prochaines étapes :
  - Vérifier la lisibilité publique : curl -fsS \$GALAXIA_WEBROOT_URL/manifests/${CHANNEL}.json
  - Suivre la diffusion : journalctl -u galaxia-veille -f (côté mère, optionnel)
  - Côté galaxie fille : le cron galaxia-update pickera la nouvelle version au prochain tir.
NEXT
