#!/usr/bin/env bash
#
# Script lancé à l'intérieur du container E2E.
#
# Étapes :
#  1. Lancer install.sh en mode test (skip docker/caddy/ollama/nemoclaw, skip systemd live)
#  2. Vérifier que tous les artefacts attendus sont en place :
#     - user galaxia
#     - /opt/galaxia/{config,current,data,logs,backups,keys}
#     - /opt/galaxia/config/galaxia.conf + .env (chmod 600) (produits par le wizard)
#     - /usr/local/bin/galaxia
#     - /usr/local/bin/galaxia-update
#     - /usr/local/bin/cosign (v2.4.3)
#     - /etc/systemd/system/galaxia-update.{service,timer}
#  3. Smoke-tester quelques commandes du CLI : galaxia help, galaxia version
#
# Exit 0 = tout vert, 1 = au moins une assertion fail.

set -euo pipefail

PASS=0
FAIL=0

ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
ko()   { printf '  \033[1;31m✗\033[0m %s\n' "$1" >&2; FAIL=$((FAIL+1)); }
must() {
	local label="$1"; shift
	if "$@" >/dev/null 2>&1; then ok "$label"; else ko "$label"; fi
}

printf '\n=== Phase 1 : install.sh en mode test ===\n'
GALAXIA_INSTALL_TEST_MODE=1 \
GALAXIA_NON_INTERACTIVE=1 \
GALAXIA_PRIVACY_MODE=local \
GALAXIA_LLM_PROVIDER=ollama \
GALAXIA_DOMAIN='' \
GALAXIA_DASHBOARD_MODE=tunnel \
GALAXIA_WAKE_WORD='Hey Galaxia' \
	bash /src/scripts/install.sh

printf '\n=== Phase 2 : assertions filesystem ===\n'

# User
must 'user galaxia exists'                       id galaxia

# Layout /opt/galaxia
for d in config current data logs backups keys; do
	must "/opt/galaxia/$d exists"                  test -d "/opt/galaxia/$d"
done

# Wizard outputs
must '/opt/galaxia/config/galaxia.conf exists'   test -f /opt/galaxia/config/galaxia.conf
must '/opt/galaxia/config/.env exists'           test -f /opt/galaxia/config/.env
must '/opt/galaxia/config/.env is chmod 600'     bash -c '[ "$(stat -c %a /opt/galaxia/config/.env)" = 600 ]'
must 'galaxia.conf has the chosen provider'      grep -q '^GALAXIA_LLM_PROVIDER=ollama$' /opt/galaxia/config/galaxia.conf

# CLI + helpers
must '/usr/local/bin/galaxia is executable'      test -x /usr/local/bin/galaxia
must '/usr/local/bin/galaxia-update executable'  test -x /usr/local/bin/galaxia-update
must '/usr/local/share/galaxia/wizard.sh exists' test -f /usr/local/share/galaxia/wizard.sh
must '/usr/local/share/galaxia/health.sh exists' test -f /usr/local/share/galaxia/health.sh

# cosign
must '/usr/local/bin/cosign is executable'       test -x /usr/local/bin/cosign
v=$(/usr/local/bin/cosign version 2>&1 | awk '/GitVersion/ {print $2}' | tr -d ' ')
case "$v" in v2.*) ok "cosign $v (v2.x)";; *) ko "cosign version '$v' is not v2.x";; esac

# systemd units (posées, pas forcément activées)
must 'galaxia-update.service file present'       test -f /etc/systemd/system/galaxia-update.service
must 'galaxia-update.timer file present'         test -f /etc/systemd/system/galaxia-update.timer

# CLI smoke
printf '\n=== Phase 3 : CLI smoke ===\n'
out=$(galaxia help 2>&1)
echo "$out" | grep -q 'galaxia status'            && ok 'galaxia help lists "status"'             || ko 'galaxia help missing "status"'
echo "$out" | grep -q 'galaxia update'            && ok 'galaxia help lists "update"'             || ko 'galaxia help missing "update"'
out=$(galaxia version 2>&1)
echo "$out" | grep -q 'version inconnue'          && ok 'galaxia version handles no VERSION'      || ko 'galaxia version unexpected output'

# Rapport
printf '\n=== Résultat ===\n'
printf 'passed: %d  /  failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
