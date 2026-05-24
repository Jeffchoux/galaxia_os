#!/usr/bin/env bash
#
# Galaxia — sync des contenus statiques servis par Caddy depuis ce repo.
#
# Caddy tourne en utilisateur `caddy` et ne peut pas lire /home/galaxia/
# (mode 750). On copie donc les artefacts servis publiquement dans
# /var/www/galaxia-*. À relancer après toute modification de scripts/install.sh.
#
# À automatiser plus tard via systemd path unit ou git post-merge hook, comme
# pour le Caddyfile (cf. docs/STATUS.md).

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '[sync-www] %s\n' "$*"; }

require_sudo() {
	if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
		log "ce script écrit dans /var/www — relance avec sudo"
		exec sudo -E bash "$0" "$@"
	fi
}
require_sudo "$@"

install_file() {
	local src="$1" dst="$2"
	install -o caddy -g caddy -m 0644 "$src" "$dst"
	log "  $src → $dst"
}

mkdir -p /var/www/galaxia-install /var/www/galaxia-updates /var/www/galaxia-docs
chown caddy:caddy /var/www/galaxia-install /var/www/galaxia-updates /var/www/galaxia-docs

log "→ install.galaxia-os.com"
install_file "$REPO_ROOT/scripts/install.sh" /var/www/galaxia-install/install.sh

log "→ updates.galaxia-os.com (webroot prêt — manifests publiés par galaxia-publish.sh)"

log "→ docs.galaxia-os.com (redir vers GitHub, aucun fichier à sync)"

log "OK"
