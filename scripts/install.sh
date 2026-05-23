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
	if id "$GALAXIA_USER" >/dev/null 2>&1; then
		return
	fi
	log "Création de l'utilisateur $GALAXIA_USER..."
	# adduser (Debian-friendly) absent dans certaines images minimales —
	# fallback sur useradd qui fait partie de shadow-utils (toujours présent).
	if command -v adduser >/dev/null 2>&1; then
		adduser --system --group --home "$GALAXIA_DIR" --shell /bin/bash "$GALAXIA_USER"
	else
		useradd --system --user-group --home-dir "$GALAXIA_DIR" --create-home --shell /bin/bash "$GALAXIA_USER"
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

install_piper() {
	# Piper TTS local FR (souverain) — daemon HTTP résident sur 127.0.0.1:5500.
	# Cohérent avec le code cockpit (apps/cockpit/src/routes/api/tts/+server.ts)
	# qui attend par défaut un daemon à PIPER_DAEMON_URL=http://127.0.0.1:5500/.
	#
	# Strictement optionnel : si Piper n'est pas là, le cockpit retombe sur la
	# synthèse vocale du navigateur (Web Speech API). On l'installe quand même
	# par défaut pour offrir la voix souveraine annoncée dans PRODUCT-VISION.
	#
	# Skip via env var (utile en CI E2E où on n'a ni Python venv ni 60MB de modèle) :
	#   GALAXIA_SKIP_PIPER=1
	if [ "${GALAXIA_SKIP_PIPER:-0}" = "1" ]; then
		warn "Piper TTS sauté (GALAXIA_SKIP_PIPER=1)."
		return
	fi

	local venv_dir="${GALAXIA_PIPER_VENV:-/opt/galaxia/venv}"
	local voices_dir="${GALAXIA_PIPER_VOICES:-/opt/galaxia/piper-voices}"
	local model_url="https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx"
	local json_url="${model_url}.json"
	local model_path="${voices_dir}/fr_FR-siwis-medium.onnx"
	local json_path="${model_path}.json"

	# Skip si déjà installé (idempotent — vérifie venv + binaire piper + modèle).
	if [ -x "${venv_dir}/bin/piper" ] && [ -s "$model_path" ] && [ -s "$json_path" ]; then
		log "Piper TTS déjà présent (${venv_dir} + modèle FR siwis-medium)."
		# S'assure quand même que l'unit est en place pour les nouvelles installs
		# qui auraient le venv mais pas encore le service.
		install_piper_systemd "$venv_dir" "$model_path"
		return
	fi

	log "Installation de Piper TTS (≈ 80 MB, modèle ONNX FR siwis-medium)..."
	apt-get install -y python3-venv python3-pip >/dev/null

	mkdir -p "$venv_dir" "$voices_dir"
	chown "$GALAXIA_USER:$GALAXIA_USER" "$venv_dir" "$voices_dir"

	# Le venv et le pip install tournent en compte galaxia pour que les
	# fichiers soient bien possédés par l'utilisateur qui fera tourner le daemon.
	sudo -u "$GALAXIA_USER" bash -lc "
		set -euo pipefail
		python3 -m venv '$venv_dir'
		'$venv_dir/bin/pip' install --quiet --upgrade pip
		'$venv_dir/bin/pip' install --quiet piper-tts
	" || die "Échec création venv / install piper-tts dans $venv_dir"

	# Téléchargement du modèle (≈ 60 MB) et de son JSON de phonèmes.
	if [ ! -s "$model_path" ]; then
		log "Téléchargement du modèle voix FR (siwis-medium, ~60MB)..."
		curl -fsSL "$model_url" -o "$model_path" \
			|| die "Échec téléchargement modèle Piper ($model_url)"
	fi
	if [ ! -s "$json_path" ]; then
		curl -fsSL "$json_url" -o "$json_path" \
			|| die "Échec téléchargement JSON Piper ($json_url)"
	fi
	chown "$GALAXIA_USER:$GALAXIA_USER" "$model_path" "$json_path"

	install_piper_systemd "$venv_dir" "$model_path"

	log "Piper TTS installé. Daemon : http://127.0.0.1:5500/"
}

install_piper_systemd() {
	local venv_dir="$1" model_path="$2"
	local voices_dir
	voices_dir="$(dirname "$model_path")"

	# Génère l'unit en substituant les chemins (le fichier dans ops/ est
	# la version mère, avec un venv dans /home/galaxia/.claude/galaxia/venv).
	cat > /etc/systemd/system/galaxia-piper.service <<UNIT
[Unit]
Description=Galaxia — Piper TTS daemon (HTTP server résident, voix fr_FR-siwis-medium)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${GALAXIA_USER}
Group=${GALAXIA_USER}
WorkingDirectory=${voices_dir}
ExecStart=${venv_dir}/bin/python -m piper.http_server \\
    --host 127.0.0.1 \\
    --port 5500 \\
    --model ${model_path}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${voices_dir} /tmp
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

	systemctl daemon-reload >/dev/null 2>&1 \
		|| warn "systemctl daemon-reload indisponible (container sans PID 1 ?) — unit posée."
	systemctl enable --now galaxia-piper.service >/dev/null 2>&1 \
		|| warn "systemctl enable --now galaxia-piper.service indisponible — activera au prochain boot."
}

install_cosign() {
	# cosign v2 — vérifie les manifestes de mise à jour signés par la mère.
	# Voir scripts/galaxia-update.sh + docs/UPDATES.md § POC pour le contexte.
	# On pin une version connue plutôt que "latest" — la chaîne de confiance
	# de Galaxia se brise si cosign change de format de signature en silence.
	local target_version="v2.4.3"
	if command -v cosign >/dev/null 2>&1; then
		local current
		current=$(cosign version 2>&1 | awk -F: '/GitVersion/ {print $2}' | tr -d ' ')
		if [ "$current" = "$target_version" ]; then
			log "cosign $target_version déjà présent."
			return
		fi
		warn "cosign $current présent mais on vise $target_version — remplacement."
	fi
	log "Installation de cosign $target_version..."
	curl -fsSL "https://github.com/sigstore/cosign/releases/download/${target_version}/cosign-linux-amd64" \
		-o /tmp/cosign-galaxia
	install -m 0755 /tmp/cosign-galaxia /usr/local/bin/cosign
	rm -f /tmp/cosign-galaxia
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
	# `current/` recevra le checkout actif (docker-compose.yml + manifeste de
	# la version installée). `keys/` héberge la clé publique cosign qui sert
	# de racine de confiance pour vérifier les manifestes (cf. docs/UPDATES.md).
	mkdir -p "$GALAXIA_DIR"/{config,current,data,logs,backups,keys}
	chown -R "$GALAXIA_USER:$GALAXIA_USER" "$GALAXIA_DIR"
	install_update_runtime
}

install_cli() {
	# CLI manager-friendly /usr/local/bin/galaxia — wrappe wizard, health,
	# update, journalctl derrière des commandes courtes.
	local self_dir cli_src
	self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P || echo "")"
	cli_src="${self_dir}/galaxia"

	if [ -z "$self_dir" ] || [ ! -f "$cli_src" ]; then
		cli_src="$(mktemp -t galaxia-cli-XXXXXX)"
		log "Téléchargement du CLI galaxia depuis le repo..."
		curl -fsSL "${GALAXIA_REPO_RAW}/scripts/galaxia" -o "$cli_src" \
			|| { warn "Téléchargement CLI échoué — installation incomplète mais non bloquante."; return; }
		head -1 "$cli_src" | grep -q '^#!.*bash' \
			|| { warn "CLI téléchargé non reconnu — saut."; rm -f "$cli_src"; return; }
	fi
	# Helpers utilisés par le CLI : health.sh + wizard.sh — déposés en
	# /usr/local/share/galaxia/ pour rester accessibles même hors checkout.
	mkdir -p /usr/local/share/galaxia
	install -m 0755 "$cli_src" /usr/local/bin/galaxia
	if [ -f "${self_dir}/health.sh" ]; then
		install -m 0755 "${self_dir}/health.sh" /usr/local/share/galaxia/health.sh
	fi
	if [ -f "${self_dir}/wizard.sh" ]; then
		install -m 0755 "${self_dir}/wizard.sh" /usr/local/share/galaxia/wizard.sh
	fi
	log "CLI installé : /usr/local/bin/galaxia (galaxia help)"
}

install_update_runtime() {
	# Pose galaxia-update.sh comme binaire système et active le timer
	# systemd quotidien. Le script peut tourner sans manifeste en place
	# (il échoue proprement avec une signature absente).
	local self_dir wrapper_src
	self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P || echo "")"
	wrapper_src="${self_dir}/galaxia-update.sh"

	if [ -z "$self_dir" ] || [ ! -f "$wrapper_src" ]; then
		# Mode curl|bash — pull depuis le repo public
		wrapper_src="$(mktemp -t galaxia-update-XXXXXX.sh)"
		log "Téléchargement de galaxia-update.sh depuis le repo..."
		curl -fsSL "${GALAXIA_REPO_RAW}/scripts/galaxia-update.sh" -o "$wrapper_src" \
			|| { warn "Téléchargement galaxia-update.sh échoué — mécanisme d'update non installé."; return; }
		head -1 "$wrapper_src" | grep -q '^#!.*bash' \
			|| { warn "galaxia-update.sh téléchargé n'est pas un script bash — saut."; rm -f "$wrapper_src"; return; }
	fi

	install -m 0755 "$wrapper_src" /usr/local/bin/galaxia-update

	# Units systemd : disponibles dans le repo pour le mode dev, à télécharger
	# en mode curl|bash. Volontairement écrites en clair dans /etc/systemd/system/
	# (pas de symlink vers /opt/galaxia/) pour rester valides même si on
	# bouge /opt/galaxia/.
	local svc_src tmr_src
	svc_src="${self_dir%/scripts}/ops/systemd/galaxia-update.service"
	tmr_src="${self_dir%/scripts}/ops/systemd/galaxia-update.timer"
	if [ ! -f "$svc_src" ]; then
		svc_src="$(mktemp -t galaxia-update-svc-XXXXXX.service)"
		curl -fsSL "${GALAXIA_REPO_RAW}/ops/systemd/galaxia-update.service" -o "$svc_src" \
			|| { warn "Téléchargement galaxia-update.service échoué."; return; }
	fi
	if [ ! -f "$tmr_src" ]; then
		tmr_src="$(mktemp -t galaxia-update-tmr-XXXXXX.timer)"
		curl -fsSL "${GALAXIA_REPO_RAW}/ops/systemd/galaxia-update.timer" -o "$tmr_src" \
			|| { warn "Téléchargement galaxia-update.timer échoué."; return; }
	fi
	install -m 0644 "$svc_src" /etc/systemd/system/galaxia-update.service
	install -m 0644 "$tmr_src" /etc/systemd/system/galaxia-update.timer
	# `daemon-reload` peut échouer dans un container sans systemd live (CI E2E).
	# Best-effort : si systemd ne tourne pas, les units sont posées et seront
	# activées au prochain boot avec un vrai PID 1.
	systemctl daemon-reload >/dev/null 2>&1 || warn "systemctl daemon-reload indisponible — units posées mais pas chargées."
	systemctl enable --now galaxia-update.timer >/dev/null 2>&1 \
		|| warn "systemctl enable --now galaxia-update.timer indisponible — activera au prochain boot."

	log "galaxia-update installé (binaire /usr/local/bin/galaxia-update, timer 03:30 +rand 15 min)"
	if [ ! -s "$GALAXIA_DIR/keys/galaxia-os.pub" ]; then
		warn "Clé publique cosign absente — déposer la clé dans $GALAXIA_DIR/keys/galaxia-os.pub"
		warn "(distribuée via install.galaxia-os.com une fois la chaîne d'updates en service)"
	fi
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
 Updates      : timer systemd galaxia-update.timer (quotidien 03:30 UTC + rand 15 min) → $UPDATES_URL
 Logs         : $GALAXIA_DIR/logs/  /  journalctl -u galaxia-update.service

 Prochaines étapes :
   - Vérifier que les services démarrent : systemctl status docker caddy ollama
   - Tester l'interface : https://<votre-domaine>/  (ou http://<ip>:3000 en LAN)
   - Configurer vos clés API : $GALAXIA_DIR/config/
──────────────────────────────────────────────────────────────
SUMMARY
}

main() {
	# Mode test : utilisé par le CI E2E pour valider le câblage de install.sh
	# (layout /opt/galaxia, /usr/local/bin, etc.) sans lancer docker/caddy/ollama/nemoclaw
	# qui sont impossibles à exécuter dans un container Docker simple.
	if [ "${GALAXIA_INSTALL_TEST_MODE:-0}" = "1" ]; then
		warn "GALAXIA_INSTALL_TEST_MODE=1 — skip docker/caddy/ollama/piper/nemoclaw + skip verify."
		require_root
		require_ubuntu_debian
		check_resources || true
		apt-get update >/dev/null
		ensure_user
		install_cosign
		bootstrap_galaxia_dir
		install_cli
		# run_wizard utilise NON_INTERACTIVE — laissé au CI de fournir les env vars
		run_wizard
		log "Test mode terminé — pas de verify_services (services non installés)."
		return 0
	fi

	log "Démarrage de l'installation Galaxia (galaxie fille)."
	require_root
	require_ubuntu_debian
	check_resources
	apt-get update
	ensure_user
	install_docker
	install_caddy
	install_ollama
	install_piper
	install_cosign
	install_nemoclaw
	bootstrap_galaxia_dir
	install_cli
	run_wizard
	configure_domain
	verify_services || warn "Certains services ne tournent pas — installation marquée 'à vérifier'."
	print_summary
}

main "$@"
