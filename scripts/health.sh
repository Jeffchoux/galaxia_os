#!/usr/bin/env bash
#
# Galaxia — bilan de santé de la galaxie (mère ou fille)
#
# Affiche en une page l'état de tout ce qui doit tourner pour qu'une
# galaxie fonctionne : services système, sandbox NemoClaw, API Ollama,
# rapport de veille (mère), config wizard.
#
# Sortie : 0 si tout vert, 1 si au moins un check critique fail.
# Avertissements (jaune) ne font pas échouer le script.
#
# Usage :
#   bash scripts/health.sh             # output console coloré
#   bash scripts/health.sh --quiet     # uniquement la ligne finale
#   bash scripts/health.sh --json      # sortie machine-readable

set -euo pipefail

MODE="${1:-}"
QUIET=0
JSON=0
case "$MODE" in
	--quiet) QUIET=1 ;;
	--json)  JSON=1 ;;
	'') ;;
	*) echo "Usage: $0 [--quiet|--json]" >&2; exit 2 ;;
esac

GALAXIA_DIR="${GALAXIA_DIR:-/opt/galaxia}"
CONFIG_DIR="${GALAXIA_CONFIG_DIR:-$GALAXIA_DIR/config}"
VEILLE_DIR="${VEILLE_DIR:-/home/galaxia/galaxia-project/docs/veille}"

# Compteurs et journal pour le mode JSON
CRIT_FAIL=0
WARN=0
declare -a CHECKS

# `return 0` indispensable : sans ça, le &&-chain renvoie non-zero quand
# QUIET/JSON est actif et `set -e` quitte le script en silence.
ok()    { CHECKS+=("ok|$1|$2"); [ "$QUIET" -eq 0 ] && [ "$JSON" -eq 0 ] && printf '\033[1;32m  ✓\033[0m %-32s %s\n' "$1" "$2"; return 0; }
warn()  { CHECKS+=("warn|$1|$2"); WARN=$((WARN+1)); [ "$QUIET" -eq 0 ] && [ "$JSON" -eq 0 ] && printf '\033[1;33m  ‼\033[0m %-32s %s\n' "$1" "$2"; return 0; }
fail()  { CHECKS+=("fail|$1|$2"); CRIT_FAIL=$((CRIT_FAIL+1)); [ "$QUIET" -eq 0 ] && [ "$JSON" -eq 0 ] && printf '\033[1;31m  ✗\033[0m %-32s %s\n' "$1" "$2"; return 0; }
section() { [ "$QUIET" -eq 0 ] && [ "$JSON" -eq 0 ] && printf '\n\033[1;35m── %s ──\033[0m\n' "$1"; return 0; }

# ---------- Checks ----------
section "Services système"

for svc in docker caddy ollama; do
	if systemctl is-active --quiet "$svc" 2>/dev/null; then
		ok "$svc" "$(systemctl show -p ActiveEnterTimestamp --value "$svc" 2>/dev/null || echo actif)"
	else
		fail "$svc" "inactif (systemctl status $svc)"
	fi
done

# Timer veille — uniquement attendu sur la galaxie mère
if systemctl list-unit-files galaxia-veille.timer >/dev/null 2>&1 \
		&& systemctl is-enabled --quiet galaxia-veille.timer 2>/dev/null; then
	next=$(systemctl show -p NextElapseUSecRealtime --value galaxia-veille.timer 2>/dev/null || echo '?')
	ok "galaxia-veille.timer" "prochain tir : ${next}"
fi

section "API Ollama (:11434)"

if curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
	models=$(curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags 2>/dev/null \
		| python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(m["name"] for m in d.get("models", [])))' 2>/dev/null \
		|| echo '(parse échoué)')
	ok "ollama API" "modèles : ${models:-aucun}"
else
	fail "ollama API" "ne répond pas sur :11434"
fi

section "Configuration wizard"

if [ -f "$CONFIG_DIR/galaxia.conf" ]; then
	# shellcheck source=/dev/null
	. "$CONFIG_DIR/galaxia.conf"
	ok "galaxia.conf" "provider=${GALAXIA_LLM_PROVIDER:-?} mode=${GALAXIA_PRIVACY_MODE:-?}"
else
	warn "galaxia.conf" "absent — wizard pas encore lancé ?"
fi

if [ -f "$CONFIG_DIR/.env" ]; then
	perms=$(stat -c '%a' "$CONFIG_DIR/.env" 2>/dev/null || echo '?')
	if [ "$perms" = "600" ]; then
		ok ".env" "chmod 600 OK"
	else
		warn ".env" "chmod $perms — devrait être 600"
	fi
else
	warn ".env" "absent — pas de secrets enregistrés"
fi

section "Veille IA (galaxie mère)"

if [ -d "$VEILLE_DIR" ]; then
	today=$(date -u +%F)
	if [ -f "$VEILLE_DIR/$today.md" ]; then
		lines=$(wc -l < "$VEILLE_DIR/$today.md")
		ok "rapport du jour" "$VEILLE_DIR/$today.md (${lines} lignes)"
	else
		latest=$(ls -1t "$VEILLE_DIR"/[0-9]*.md 2>/dev/null | head -1)
		if [ -n "$latest" ]; then
			warn "rapport du jour" "absent ; dernier : $(basename "$latest")"
		else
			warn "rapport du jour" "aucun rapport généré"
		fi
	fi
else
	warn "veille" "répertoire $VEILLE_DIR inexistant"
fi

# ---------- Verdict ----------
if [ "$JSON" -eq 1 ]; then
	# Émission JSON minimaliste sans dépendance externe
	printf '{"crit_fail":%d,"warn":%d,"checks":[' "$CRIT_FAIL" "$WARN"
	first=1
	for c in "${CHECKS[@]}"; do
		IFS='|' read -r status name detail <<<"$c"
		[ "$first" -eq 0 ] && printf ','
		first=0
		printf '{"status":"%s","name":"%s","detail":"%s"}' "$status" "$name" "${detail//\"/\\\"}"
	done
	printf ']}\n'
elif [ "$QUIET" -eq 1 ]; then
	printf 'galaxia health: crit_fail=%d warn=%d\n' "$CRIT_FAIL" "$WARN"
else
	echo
	if [ "$CRIT_FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
		printf '\033[1;32m✓ Galaxia OK\033[0m\n'
	elif [ "$CRIT_FAIL" -eq 0 ]; then
		printf '\033[1;33m‼ Galaxia OK avec %d avertissement(s)\033[0m\n' "$WARN"
	else
		printf '\033[1;31m✗ %d check(s) critique(s) en échec\033[0m\n' "$CRIT_FAIL"
	fi
fi

[ "$CRIT_FAIL" -eq 0 ]
