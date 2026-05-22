#!/usr/bin/env bash
#
# Galaxia — wizard de configuration (FR, manager-friendly)
#
# Conçu pour un manager non-développeur qui installe Galaxia sur sa machine.
# Pose 4-5 questions simples, écrit deux fichiers de config, c'est tout.
#
# Appelé automatiquement par scripts/install.sh après l'install système.
# Peut aussi tourner seul : `sudo bash scripts/wizard.sh`.
#
# Mode non-interactif (déploiements automatisés) :
#   GALAXIA_NON_INTERACTIVE=1 GALAXIA_PRIVACY_MODE=hybrid \
#   GALAXIA_LLM_PROVIDER=claude GALAXIA_LLM_API_KEY=sk-... \
#   bash scripts/wizard.sh
#
# Mode test (pas besoin de root) :
#   GALAXIA_CONFIG_DIR=/tmp/test-wizard bash scripts/wizard.sh

set -euo pipefail

# ---------- Configuration ----------
GALAXIA_CONFIG_DIR="${GALAXIA_CONFIG_DIR:-/opt/galaxia/config}"
GALAXIA_USER="${GALAXIA_USER:-galaxia}"
GALAXIA_NON_INTERACTIVE="${GALAXIA_NON_INTERACTIVE:-0}"
DEFAULT_WAKE_WORD="Hey Galaxia"
DEFAULT_SANDBOX_NAME="galaxia-main"

CONF_FILE="${GALAXIA_CONFIG_DIR}/galaxia.conf"
ENV_FILE="${GALAXIA_CONFIG_DIR}/.env"

# ---------- Helpers ----------
log()   { printf "\033[1;36m[galaxia]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[galaxia]\033[0m %s\n" "$*" >&2; }
die()   { printf "\033[1;31m[galaxia]\033[0m %s\n" "$*" >&2; exit 1; }
section() {
	# Toujours stderr : les sections sont de l'UI et ne doivent pas polluer
	# une éventuelle capture $(...) par la fonction appelante.
	printf "\n\033[1;35m─── %s ───\033[0m\n\n" "$*" >&2
}

is_root() { [ "$(id -u)" -eq 0 ]; }

# ask "Question" "default" — echoes the answer
ask() {
	local question="$1" default="${2:-}" answer prompt
	if [ "$GALAXIA_NON_INTERACTIVE" = "1" ]; then
		[ -n "$default" ] || die "Mode non-interactif et pas de valeur pour : $question"
		echo "$default"; return
	fi
	if [ -n "$default" ]; then
		prompt="$question [$default] : "
	else
		prompt="$question : "
	fi
	read -rp "$prompt" answer
	echo "${answer:-$default}"
}

# ask_secret "Question" — echoes a secret without printing it
ask_secret() {
	local question="$1" answer
	if [ "$GALAXIA_NON_INTERACTIVE" = "1" ]; then
		die "Mode non-interactif : secret manquant pour : $question"
	fi
	read -rsp "$question : " answer
	echo >&2
	echo "$answer"
}

# choose "Question" "label1|val1" "label2|val2" ... — echoes the chosen value
choose() {
	local question="$1"; shift
	local i=1 default_val="" choice
	local labels=() values=()
	while [ $# -gt 0 ]; do
		labels+=("${1%%|*}")
		values+=("${1##*|}")
		shift
	done
	default_val="${values[0]}"
	if [ "$GALAXIA_NON_INTERACTIVE" = "1" ]; then
		echo "$default_val"; return
	fi
	echo "$question" >&2
	for i in "${!labels[@]}"; do
		printf "  %d) %s\n" "$((i+1))" "${labels[$i]}" >&2
	done
	while :; do
		read -rp "Votre choix [1] : " choice
		choice="${choice:-1}"
		if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#values[@]}" ]; then
			echo "${values[$((choice-1))]}"
			return
		fi
		echo "  Réponse invalide. Tapez un nombre entre 1 et ${#values[@]}." >&2
	done
}

# confirm "Question" "y|n" — exit 0 if yes
confirm() {
	local question="$1" default="${2:-n}" answer
	if [ "$GALAXIA_NON_INTERACTIVE" = "1" ]; then
		[ "$default" = "y" ]
		return
	fi
	if [ "$default" = "y" ]; then
		read -rp "$question [O/n] : " answer
		answer="${answer:-o}"
	else
		read -rp "$question [o/N] : " answer
		answer="${answer:-n}"
	fi
	[[ "$answer" =~ ^[oOyY]$ ]]
}

# ---------- Sections ----------

welcome() {
	cat <<'BANNER'

╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║              Bienvenue dans l'installation Galaxia           ║
║                                                              ║
║   On va vous poser 4 questions simples pour configurer       ║
║   votre Galaxia. Comptez 2 minutes.                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

BANNER
}

check_existing_config() {
	[ -f "$CONF_FILE" ] || return 0

	section "Configuration existante détectée"
	log "Fichier : $CONF_FILE"
	echo
	# shellcheck source=/dev/null
	. "$CONF_FILE"
	cat <<SUMMARY
  Mode confidentialité  : ${GALAXIA_PRIVACY_MODE:-?}
  LLM choisi            : ${GALAXIA_LLM_PROVIDER:-?}
  Domaine               : ${GALAXIA_DOMAIN:-aucun}
  Accès dashboard       : ${GALAXIA_DASHBOARD_MODE:-?}
  Mot-clé d'éveil       : ${GALAXIA_WAKE_WORD:-?}
  Configurée le         : ${GALAXIA_CONFIGURED_AT:-?}

SUMMARY
	if confirm "Reconfigurer ?" "n"; then
		local ts
		ts="$(date +%Y%m%d-%H%M%S)"
		cp "$CONF_FILE" "${CONF_FILE}.bak.${ts}"
		log "Backup : ${CONF_FILE}.bak.${ts}"
		[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "${ENV_FILE}.bak.${ts}" && log "Backup : ${ENV_FILE}.bak.${ts}"
		return 0
	fi
	log "Configuration conservée. Rien à faire."
	exit 0
}

ask_privacy_mode() {
	section "1/4 — Confidentialité des données"

	cat >&2 <<'EXPLAIN'
Galaxia peut traiter vos données de 3 façons. Plus c'est local, plus
c'est privé, mais aussi plus c'est limité (modèles moins puissants).

EXPLAIN
	local mode
	mode="$(choose "Quel mode choisir ?" \
		"Cloud anonymisé — modèles cloud (Claude/GPT/Gemini), données sensibles masquées avant envoi (recommandé pour démarrer)|cloud" \
		"Hybride — tâches sensibles en local, le reste cloud (équilibre vie privée / puissance)|hybrid" \
		"100% local — tout sur votre serveur via Ollama, zéro fuite réseau (souverain total)|local")"
	echo "$mode"
}

ask_llm_provider() {
	local privacy="$1" provider

	section "2/4 — Choix du fournisseur LLM"

	if [ "$privacy" = "local" ]; then
		log "Mode 100% local → Ollama (déjà installé) est imposé." >&2
		echo "ollama"; return
	fi

	cat >&2 <<'EXPLAIN'
Quel modèle Galaxia doit-il utiliser pour le cloud ? Vous aurez besoin
d'une clé API du fournisseur choisi (compte payant chez eux).

EXPLAIN
	provider="$(choose "Fournisseur ?" \
		"Claude (Anthropic) — recommandé pour le raisonnement long|claude" \
		"GPT (OpenAI) — recommandé pour les tâches courtes|openai" \
		"Gemini (Google) — moins cher, large contexte|gemini" \
		"Ollama local (pas de clé, mais moins puissant)|ollama")"
	echo "$provider"
}

ask_api_key() {
	local provider="$1" key

	[ "$provider" = "ollama" ] && { echo ""; return; }

	section "3/4 — Clé API ${provider}"

	case "$provider" in
		claude)
			cat >&2 <<'EXPLAIN'
Récupérez votre clé sur : https://console.anthropic.com/settings/keys
Elle commence par "sk-ant-...". On la stockera dans /opt/galaxia/config/.env
(lecture seule, accessible uniquement à l'utilisateur galaxia).

EXPLAIN
			;;
		openai)
			cat >&2 <<'EXPLAIN'
Récupérez votre clé sur : https://platform.openai.com/api-keys
Elle commence par "sk-...". Stockée chmod 600 chez vous, ne sort jamais.

EXPLAIN
			;;
		gemini)
			cat >&2 <<'EXPLAIN'
Récupérez votre clé sur : https://aistudio.google.com/app/apikey
Stockée chmod 600 chez vous, ne sort jamais.

EXPLAIN
			;;
	esac

	if [ -n "${GALAXIA_LLM_API_KEY:-}" ]; then
		key="$GALAXIA_LLM_API_KEY"
	else
		key="$(ask_secret "Collez votre clé API (la saisie ne s'affiche pas)")"
	fi
	[ -n "$key" ] || die "Clé API vide — impossible de continuer."
	echo "$key"
}

ask_domain() {
	section "4/4 — Nom de domaine (optionnel)"

	cat >&2 <<'EXPLAIN'
Si vous avez un nom de domaine (ex: galaxia.ma-pme.fr) pointé vers cette
machine, Galaxia configurera HTTPS automatiquement (Caddy + Let's Encrypt)
et exposera le dashboard à cette adresse.

Si vous n'en avez pas, c'est OK : Galaxia créera un tunnel sécurisé via
Cloudflare et vous donnera une URL temporaire (zéro config DNS).

EXPLAIN
	local domain
	domain="$(ask "Nom de domaine (entrée vide = tunnel Cloudflare)" "")"
	echo "$domain"
}

ask_wake_word() {
	section "Bonus — Mot-clé d'éveil"

	cat >&2 <<'EXPLAIN'
Comme "Hey Siri" ou "Alexa", votre Galaxia répond à un mot-clé.
La valeur par défaut convient à la plupart des PME.

EXPLAIN
	local ww
	ww="$(ask "Mot-clé d'éveil" "$DEFAULT_WAKE_WORD")"
	echo "$ww"
}

# Pas de question, calcul automatique selon Q8 (DECISIONS.md 2026-05-22)
compute_dashboard_mode() {
	local domain="$1"
	if [ -n "$domain" ]; then
		echo "caddy"
	else
		echo "tunnel"
	fi
}

write_config() {
	local privacy="$1" provider="$2" api_key="$3" domain="$4" dashboard_mode="$5" wake_word="$6"

	mkdir -p "$GALAXIA_CONFIG_DIR"

	cat > "$CONF_FILE" <<CONF
# Galaxia — configuration locale
# Généré par scripts/wizard.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Ne pas éditer à la main de préférence — relancez le wizard pour modifier.

GALAXIA_PRIVACY_MODE=${privacy}
GALAXIA_LLM_PROVIDER=${provider}
GALAXIA_DOMAIN=${domain}
GALAXIA_DASHBOARD_MODE=${dashboard_mode}
GALAXIA_WAKE_WORD="${wake_word}"
GALAXIA_SANDBOX_NAME=${DEFAULT_SANDBOX_NAME}
GALAXIA_CONFIGURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
GALAXIA_CONFIGURED_BY=wizard
CONF

	# .env : un seul provider rempli selon le choix
	{
		echo "# Galaxia — secrets locaux"
		echo "# Généré par scripts/wizard.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "# Ne JAMAIS commit ce fichier. Ne JAMAIS le partager."
		echo
		case "$provider" in
			claude)  echo "ANTHROPIC_API_KEY=${api_key}" ;;
			openai)  echo "OPENAI_API_KEY=${api_key}" ;;
			gemini)  echo "GOOGLE_API_KEY=${api_key}" ;;
			ollama)  echo "# Mode local — pas de clé API requise." ;;
		esac
	} > "$ENV_FILE"

	chmod 600 "$ENV_FILE"
	chmod 644 "$CONF_FILE"

	if is_root && id "$GALAXIA_USER" >/dev/null 2>&1; then
		chown "$GALAXIA_USER:$GALAXIA_USER" "$CONF_FILE" "$ENV_FILE"
		chown "$GALAXIA_USER:$GALAXIA_USER" "$GALAXIA_CONFIG_DIR" 2>/dev/null || true
	fi
}

print_final_summary() {
	local privacy="$1" provider="$2" domain="$3" dashboard_mode="$4" wake_word="$5"

	cat <<SUMMARY

╔══════════════════════════════════════════════════════════════╗
║              Configuration enregistrée                       ║
╚══════════════════════════════════════════════════════════════╝

  Mode confidentialité  : ${privacy}
  LLM choisi            : ${provider}
  Domaine               : ${domain:-aucun (tunnel Cloudflare)}
  Accès dashboard       : ${dashboard_mode}
  Mot-clé d'éveil       : ${wake_word}

  Config publique       : ${CONF_FILE}
  Secrets (chmod 600)   : ${ENV_FILE}

  Prochaines étapes :
SUMMARY

	case "$dashboard_mode" in
		tunnel)
			cat <<TUNNEL
    1. Lancer le tunnel : sudo -u ${GALAXIA_USER} nemoclaw tunnel start
    2. Noter l'URL .trycloudflare.com affichée
    3. L'ouvrir dans votre navigateur — c'est l'accès au dashboard Galaxia
TUNNEL
			;;
		caddy)
			cat <<CADDY
    1. Vérifier que ${domain} pointe bien vers l'IP de ce serveur
    2. Caddy s'occupe du HTTPS tout seul à la première requête
    3. Ouvrir https://${domain} dans votre navigateur
CADDY
			;;
	esac

	echo
}

# ---------- Main ----------

main() {
	welcome
	check_existing_config

	local privacy provider api_key domain dashboard_mode wake_word

	# Mode non-interactif : tout doit venir des env vars
	privacy="${GALAXIA_PRIVACY_MODE:-$(ask_privacy_mode)}"
	provider="${GALAXIA_LLM_PROVIDER:-$(ask_llm_provider "$privacy")}"
	api_key="$(ask_api_key "$provider")"
	domain="${GALAXIA_DOMAIN-$(ask_domain)}"
	wake_word="${GALAXIA_WAKE_WORD:-$(ask_wake_word)}"
	dashboard_mode="$(compute_dashboard_mode "$domain")"

	# Récap avant écriture
	section "Récapitulatif"
	cat <<RECAP
  Confidentialité  : $privacy
  LLM              : $provider $([ "$provider" != "ollama" ] && echo "(clé fournie : oui)" || echo "")
  Domaine          : ${domain:-aucun}
  Dashboard        : $dashboard_mode
  Mot-clé          : $wake_word

RECAP
	if ! confirm "Valider et enregistrer ?" "y"; then
		warn "Annulé. Aucun fichier modifié."
		exit 1
	fi

	write_config "$privacy" "$provider" "$api_key" "$domain" "$dashboard_mode" "$wake_word"
	print_final_summary "$privacy" "$provider" "$domain" "$dashboard_mode" "$wake_word"
}

main "$@"
