#!/usr/bin/env bash
#
# Galaxia — installeur de galaxie fille
#
# Usage (depuis une PME, sur un serveur Ubuntu/Debian fraîchement provisionné) :
#   curl -fsSL https://install.galaxia-os.com | sudo bash
#
# Ce script :
#   1. Vérifie les prérequis (OS, droits root, espace disque, RAM)
#   2. Installe Docker, docker-compose, Caddy, Ollama si absents
#   3. Crée la structure /opt/galaxia et y copie la dernière révision
#   4. Demande le nom de domaine de la galaxie (optionnel : peut tourner en LAN)
#   5. Lance les services
#   6. Installe un cron de mise à jour quotidien pointant sur updates.galaxia-os.com
#
# Ce script est volontairement défensif et idempotent : on peut le relancer.

set -euo pipefail

# ---------- Configuration ----------
GALAXIA_DIR="${GALAXIA_DIR:-/opt/galaxia}"
GALAXIA_USER="${GALAXIA_USER:-galaxia}"
UPDATES_URL="${UPDATES_URL:-https://updates.galaxia-os.com}"
MIN_RAM_MB=4096
MIN_DISK_GB=20

# ---------- Helpers ----------
log()   { printf "\033[1;36m[galaxia]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[galaxia]\033[0m %s\n" "$*" >&2; }
die()   { printf "\033[1;31m[galaxia]\033[0m %s\n" "$*" >&2; exit 1; }

require_root() {
	[ "$(id -u)" -eq 0 ] || die "Ce script doit tourner en root (sudo)."
}

require_ubuntu_debian() {
	[ -f /etc/os-release ] || die "OS non reconnu (pas de /etc/os-release)."
	# shellcheck source=/dev/null
	. /etc/os-release
	case "${ID:-}" in
		ubuntu|debian) log "OS détecté : $PRETTY_NAME — OK" ;;
		*) die "OS non supporté : ${ID:-inconnu}. Galaxia requiert Ubuntu ou Debian." ;;
	esac
}

check_resources() {
	local ram_mb disk_gb
	ram_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
	disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
	[ "$ram_mb" -ge "$MIN_RAM_MB" ] || warn "RAM faible : ${ram_mb}MB (recommandé ≥ ${MIN_RAM_MB}MB)"
	[ "$disk_gb" -ge "$MIN_DISK_GB" ] || warn "Disque faible : ${disk_gb}GB libre (recommandé ≥ ${MIN_DISK_GB}GB)"
}

ensure_user() {
	if ! id "$GALAXIA_USER" >/dev/null 2>&1; then
		log "Création de l'utilisateur $GALAXIA_USER..."
		adduser --system --group --home "$GALAXIA_DIR" --shell /bin/bash "$GALAXIA_USER"
	fi
}

install_docker() {
	if command -v docker >/dev/null 2>&1; then
		log "Docker déjà présent ($(docker --version))."
		return
	fi
	log "Installation de Docker via le script officiel..."
	curl -fsSL https://get.docker.com | sh
	systemctl enable --now docker
	usermod -aG docker "$GALAXIA_USER" || true
}

install_caddy() {
	if command -v caddy >/dev/null 2>&1; then
		log "Caddy déjà présent ($(caddy version | head -1))."
		return
	fi
	log "Installation de Caddy..."
	apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update
	apt-get install -y caddy
}

install_ollama() {
	if command -v ollama >/dev/null 2>&1; then
		log "Ollama déjà présent ($(ollama --version 2>&1 | head -1))."
		return
	fi
	log "Installation d'Ollama via le script officiel..."
	curl -fsSL https://ollama.com/install.sh | sh
}

bootstrap_galaxia_dir() {
	log "Préparation de $GALAXIA_DIR..."
	mkdir -p "$GALAXIA_DIR"/{config,data,logs,backups}
	chown -R "$GALAXIA_USER:$GALAXIA_USER" "$GALAXIA_DIR"
	# TODO : pull du dernier snapshot Galaxia depuis $UPDATES_URL
	# (compose files, manifestes de version, signatures)
	warn "Pull des artefacts Galaxia : TODO (mécanisme updates pas encore implémenté)"
}

configure_domain() {
	local domain="${GALAXIA_DOMAIN:-}"
	if [ -z "$domain" ] && [ -t 0 ]; then
		read -rp "Nom de domaine pour cette galaxie (ENTRÉE pour LAN seulement) : " domain
	fi
	if [ -n "$domain" ]; then
		log "Configuration Caddy pour $domain..."
		cat > /etc/caddy/Caddyfile.galaxia <<CADDY
$domain {
	reverse_proxy localhost:3000
	encode gzip zstd
}
CADDY
		# TODO : merger avec /etc/caddy/Caddyfile existant proprement
		systemctl reload caddy || true
	else
		log "Pas de domaine fourni — galaxie en LAN only (accès http://<ip>:3000)."
	fi
}

install_update_cron() {
	log "Installation du cron de mise à jour quotidien..."
	cat > /etc/cron.d/galaxia-update <<CRON
# Mise à jour quotidienne de la galaxie fille depuis la galaxie mère
# Heure pseudo-aléatoire pour éviter les pics de charge côté hub
30 3 * * * $GALAXIA_USER /usr/local/bin/galaxia-update >> $GALAXIA_DIR/logs/update.log 2>&1
CRON
	chmod 644 /etc/cron.d/galaxia-update
	# Le binaire galaxia-update sera déposé par le pull initial.
	warn "Binaire /usr/local/bin/galaxia-update : TODO (à fournir par le pull initial)"
}

print_summary() {
	cat <<SUMMARY

──────────────────────────────────────────────────────────────
 Galaxia — installation terminée
──────────────────────────────────────────────────────────────
 Répertoire   : $GALAXIA_DIR
 Utilisateur  : $GALAXIA_USER
 Updates      : cron quotidien à 03:30 depuis $UPDATES_URL
 Logs         : $GALAXIA_DIR/logs/

 Prochaines étapes :
   - Vérifier que les services démarrent : systemctl status docker caddy ollama
   - Tester l'interface : https://<votre-domaine>/  (ou http://<ip>:3000 en LAN)
   - Configurer vos clés API : $GALAXIA_DIR/config/
──────────────────────────────────────────────────────────────
SUMMARY
}

main() {
	log "Démarrage de l'installation Galaxia (galaxie fille)."
	require_root
	require_ubuntu_debian
	check_resources
	apt-get update
	ensure_user
	install_docker
	install_caddy
	install_ollama
	bootstrap_galaxia_dir
	configure_domain
	install_update_cron
	print_summary
}

main "$@"
