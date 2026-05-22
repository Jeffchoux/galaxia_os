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
# Source de repli quand on est en mode curl|bash : pas de sibling wizard.sh
# accessible, on le récupère depuis le repo.
GALAXIA_REPO_RAW="${GALAXIA_REPO_RAW:-https://raw.githubusercontent.com/Jeffchoux/galaxia_os/main}"
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

install_nemoclaw() {
	# Recipe découverte le 2026-05-22 sur OpenJeff. Voir docs/STATUS.md §NemoClaw.
	# L'installer crée son propre subnet Docker (172.19.0.0/16) et expose le
	# gateway OpenShell sur 172.19.0.1:8080 + auth proxy Ollama sur 172.19.0.1:11435.
	# UFW doit explicitement autoriser le trafic du subnet vers ces deux ports
	# sinon les sandboxes ne peuvent pas atteindre leur propre gateway.

	local target_user="${GALAXIA_USER}"
	local home_dir
	home_dir="$(getent passwd "${target_user}" | cut -d: -f6)"
	[ -n "$home_dir" ] || die "Utilisateur ${target_user} sans home dir."

	# Skip si déjà installé (idempotent)
	if [ -x "${home_dir}/.local/bin/nemoclaw" ]; then
		log "NemoClaw déjà présent ($("${home_dir}/.local/bin/nemoclaw" --version 2>&1))."
		return
	fi

	# Prérequis Node 22.19+ (l'installer NemoClaw vérifie et installe NVM sinon)
	if ! command -v node >/dev/null 2>&1; then
		log "Node absent — NemoClaw installer va installer NVM + Node 24."
	fi

	log "Pré-ouverture UFW pour le subnet sandbox NemoClaw (172.19.0.0/16)..."
	# 8080 = OpenShell gateway ; 11435 = Ollama auth proxy
	ufw allow from 172.19.0.0/16 to 172.19.0.1 port 8080 proto tcp comment "NemoClaw OpenShell gateway" >/dev/null
	ufw allow from 172.19.0.0/16 to 172.19.0.1 port 11435 proto tcp comment "NemoClaw Ollama auth proxy" >/dev/null

	log "Installation de NemoClaw (peut prendre 5-15 min, sandbox build inclus)..."
	# L'installer doit tourner en compte non-root avec sudo NOPASSWD (cf. CLAUDE.md).
	# Heredoc quoted-EOF: no expansion in this block (we want literal env vars to
	# survive across the sudo boundary).
	sudo -u "${target_user}" bash -l <<-'NEMOCLAW_INSTALL_EOF'
		set -e
		export NEMOCLAW_NON_INTERACTIVE=1
		export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
		export NEMOCLAW_PROVIDER=ollama
		export NEMOCLAW_NO_EXPRESS=1
		export NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-galaxia-main}"
		# Download script before exec so a failed curl is retryable without
		# half-running the install.
		curl -fsSL https://www.nvidia.com/nemoclaw.sh -o /tmp/nemoclaw-install.sh
		bash /tmp/nemoclaw-install.sh
	NEMOCLAW_INSTALL_EOF

	# Ajouter ~/.local/bin au PATH du user (NemoClaw installe les binaires là)
	if [ -f "${home_dir}/.bashrc" ] && ! grep -q '.local/bin' "${home_dir}/.bashrc"; then
		echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${home_dir}/.bashrc"
	fi

	log "NemoClaw installé. Binaires : ${home_dir}/.local/bin/{nemoclaw,openshell}"
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
	# Source la config produite par le wizard (le wizard a déjà demandé le domaine)
	local conf="$GALAXIA_DIR/config/galaxia.conf"
	if [ -f "$conf" ]; then
		# shellcheck source=/dev/null
		. "$conf"
	fi

	local domain="${GALAXIA_DOMAIN:-}"
	if [ -z "$domain" ]; then
		log "Pas de domaine — accès dashboard via tunnel Cloudflare (cf. wizard)."
		return
	fi

	log "Configuration Caddy pour $domain..."
	cat > /etc/caddy/Caddyfile.galaxia <<CADDY
$domain {
	reverse_proxy localhost:3000
	encode gzip zstd
}
CADDY
	# TODO : merger avec /etc/caddy/Caddyfile existant proprement
	systemctl reload caddy || true
}

run_wizard() {
	if [ "${GALAXIA_SKIP_WIZARD:-0}" = "1" ]; then
		warn "Wizard sauté (GALAXIA_SKIP_WIZARD=1). Vous devrez créer $GALAXIA_DIR/config/galaxia.conf à la main."
		return
	fi

	# Mode repo : wizard.sh est à côté d'install.sh.
	# Mode curl|bash : $BASH_SOURCE est un descripteur (/dev/stdin, /dev/fd/63…),
	# pas de sibling possible — on télécharge depuis le repo public.
	local self_dir wizard_path
	self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P || echo "")"
	wizard_path="${self_dir}/wizard.sh"

	if [ -z "$self_dir" ] || [ ! -f "$wizard_path" ]; then
		wizard_path="$(mktemp -t galaxia-wizard-XXXXXX.sh)"
		log "Téléchargement du wizard depuis ${GALAXIA_REPO_RAW}/scripts/wizard.sh ..."
		if ! curl -fsSL "${GALAXIA_REPO_RAW}/scripts/wizard.sh" -o "$wizard_path"; then
			warn "Téléchargement du wizard échoué — config à compléter manuellement."
			warn "Pour relancer : sudo GALAXIA_CONFIG_DIR=$GALAXIA_DIR/config bash <(curl -fsSL ${GALAXIA_REPO_RAW}/scripts/wizard.sh)"
			rm -f "$wizard_path"
			return
		fi
		# Petite vérif de cohérence pour éviter d'exécuter un HTML 404 si le path bouge.
		if ! head -1 "$wizard_path" | grep -q '^#!.*bash'; then
			warn "Contenu téléchargé pas reconnu comme un script bash — wizard sauté."
			rm -f "$wizard_path"
			return
		fi
	fi

	log "Lancement du wizard de configuration..."
	GALAXIA_CONFIG_DIR="$GALAXIA_DIR/config" \
	GALAXIA_USER="$GALAXIA_USER" \
		bash "$wizard_path"
}

install_update_cron() {
	# On n'écrit le cron QUE si le binaire existe — sinon cron lance un truc
	# manquant tous les jours et pollue les logs / mailx pendant des semaines.
	if [ ! -x /usr/local/bin/galaxia-update ]; then
		warn "Binaire /usr/local/bin/galaxia-update absent → cron de mise à jour pas installé."
		warn "Sera mis en place automatiquement quand le mécanisme updates sera livré (cf. docs/UPDATES.md)."
		return
	fi
	log "Installation du cron de mise à jour quotidien..."
	cat > /etc/cron.d/galaxia-update <<CRON
# Mise à jour quotidienne de la galaxie fille depuis la galaxie mère
# Heure pseudo-aléatoire pour éviter les pics de charge côté hub
30 3 * * * $GALAXIA_USER /usr/local/bin/galaxia-update >> $GALAXIA_DIR/logs/update.log 2>&1
CRON
	chmod 644 /etc/cron.d/galaxia-update
}

verify_services() {
	log "Vérification des services post-install..."
	local svc rc=0
	for svc in docker caddy ollama; do
		if systemctl is-active --quiet "$svc"; then
			log "  ✓ $svc actif"
		else
			warn "  ✗ $svc inactif — vérifier : systemctl status $svc"
			rc=1
		fi
	done
	# Ollama doit répondre sur 11434 pour que la suite marche
	if curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
		log "  ✓ Ollama API joignable sur :11434"
	else
		warn "  ✗ Ollama API ne répond pas sur :11434 (peut être en cours de chargement)"
		rc=1
	fi
	return $rc
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
	install_nemoclaw
	bootstrap_galaxia_dir
	run_wizard
	configure_domain
	install_update_cron
	verify_services || warn "Certains services ne tournent pas — installation marquée 'à vérifier'."
	print_summary
}

main "$@"
