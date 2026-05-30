#!/usr/bin/env bash
# Authenticated cockpit smoke — boots a THROWAWAY cockpit instance with a known
# admin password, logs in via Playwright, screenshots the real (authenticated)
# app, then tears everything down. Self-contained: server + driver live in this
# one process, so no orphaned background server for the sandbox to reap.
#
# Why throwaway: the prod systemd instance (:3001) sets
# ORIGIN=https://app.galaxia-os.com (Caddy fronts it), so a browser POST from
# 127.0.0.1 fails SvelteKit's CSRF check — and we don't know Jeff's real
# password. We boot our own instance with ORIGIN=http://127.0.0.1:<port>, a
# fresh DB, and a password WE chose.
#
# Usage:   bash auth-smoke.sh
# Output:  screenshots in $SHOT_DIR (default /tmp/cockpit-shots/)
# Requires: the build exists (npm run build) and ops/browser-smoke deps (see SKILL.md).
set -euo pipefail

# --- locate paths (script lives in apps/cockpit/.claude/skills/run-cockpit/) ---
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT="$(cd "$HERE/../../.." && pwd)"          # apps/cockpit
DRIVER="$HERE/driver.mjs"
PORT="${PORT:-3099}"
SHOT_DIR="${SHOT_DIR:-/tmp/cockpit-shots}"
PASSWORD="galaxia-test-pw"
WORK="$(mktemp -d /tmp/cockpit-authsmoke.XXXXXX)"
mkdir -p "$SHOT_DIR"

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

if [ ! -f "$COCKPIT/build/index.js" ]; then
	echo "no build found — run 'npm run build' in $COCKPIT first" >&2; exit 1
fi

# argon2id hash of $PASSWORD, generated with the app's own dependency.
# IMPORTANT: pass env vars to node directly (env / export of a single-quoted
# value) — NEVER `source` an .env file with these, because bash would expand
# the $argon2id$v$m... segments and corrupt the hash.
HASH="$(cd "$COCKPIT" && node -e 'import("@node-rs/argon2").then(a=>a.hash(process.argv[1]).then(h=>process.stdout.write(h)))' "$PASSWORD")"
SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64"))')"

echo "· booting throwaway cockpit on 127.0.0.1:$PORT (db in $WORK)…"
env ADMIN_EMAIL='test@galaxia.local' \
    JEFF_PASS_HASH="$HASH" \
    SESSION_SECRET="$SECRET" \
    ANTHROPIC_API_KEY='sk-ant-dummy-not-used-for-ui' \
    COCKPIT_DB_PATH="$WORK/cockpit.db" \
    MAIL_PROVIDER='console' HOST='127.0.0.1' PORT="$PORT" \
    ORIGIN="http://127.0.0.1:$PORT" NODE_ENV='production' \
    node "$COCKPIT/build" >"$WORK/cockpit.log" 2>&1 &
SRV=$!

# wait for ready (fails loudly if it dies)
for i in $(seq 1 40); do
	curl -sf "http://127.0.0.1:$PORT/login" >/dev/null && break
	kill -0 "$SRV" 2>/dev/null || { echo "server died:" >&2; cat "$WORK/cockpit.log" >&2; exit 1; }
	sleep 0.25
done
echo "· up. driving authenticated login…"

COCKPIT_PASSWORD="$PASSWORD" node "$DRIVER" \
	"http://127.0.0.1:$PORT/" 'textarea' "$SHOT_DIR/cockpit-authenticated.png"

echo "· done. screenshot → $SHOT_DIR/cockpit-authenticated.png"
