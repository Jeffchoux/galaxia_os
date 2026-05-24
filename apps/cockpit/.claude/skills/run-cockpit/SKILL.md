---
name: run-cockpit
description: Build, run, and drive the Galaxia cockpit (SvelteKit web app on :3001). Use when asked to start the cockpit, take a screenshot of the login/UI, run its browser smoke, check that the auth gate is up, or drive it headless with Playwright.
---

The cockpit is a SvelteKit (adapter-node) app served on `127.0.0.1:3001`
behind Caddy. On OpenJeff it runs as a systemd service
(`galaxia-cockpit.service`, user `galaxia`); on a fresh machine you
build it with `npm` and start `node build/` yourself. Drive it
**headless** via the existing Playwright install in `ops/browser-smoke/`
— either the full surface smoke (`ops/browser-smoke/test.mjs`) or the
ad-hoc one-shot at `.claude/skills/run-cockpit/driver.mjs`.

All paths below are relative to `apps/cockpit/` (the SvelteKit unit).
Browser smoke + Playwright deps live in `../../ops/browser-smoke/`.

## Prerequisites

Node 22+ (the build pulls native deps — `better-sqlite3`, `@node-rs/argon2`).

```bash
sudo apt-get update
sudo apt-get install -y python3 build-essential ca-certificates curl
node -v   # must be >= 22.0.0
```

For browser smoke (one-time, in `../../ops/browser-smoke/`):

```bash
cd ../../ops/browser-smoke
npm install
npm run install:browser      # downloads Chromium (~115 MB) into ~/.cache/ms-playwright
sudo npm run install:deps    # apt: libnss3 libnspr4 libxkbcommon0 …
```

## Setup

Secrets the cockpit reads at runtime — without them the SvelteKit
process throws on the first request:

| var | role |
|---|---|
| `ANTHROPIC_API_KEY` | required — Claude API |
| `JEFF_PASS_HASH` | required — argon2id hash, gates `/login` |
| `SESSION_SECRET` | required — HMAC key for the `galaxia_session` cookie (32+ bytes b64) |
| `COCKPIT_DB_PATH` | optional — defaults to `./data/cockpit.db` |
| `COCKPIT_MODEL` | optional — defaults to `claude-opus-4-7` |

In prod the systemd unit reads them from `apps/cockpit/.env`
(`EnvironmentFile=…/apps/cockpit/.env`). Generate the hash and secret:

```bash
node -e "import('@node-rs/argon2').then(a=>a.hash(process.argv[1]).then(console.log))" -- '<password>'
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## Build

```bash
npm ci                     # installs prod + dev deps, builds native modules
npm run build              # vite build → ./build/ (SvelteKit adapter-node bundle)
```

## Run (agent path)

**First check whether it's already running** — on OpenJeff it always
is, via systemd:

```bash
systemctl is-active galaxia-cockpit.service   # → active
curl -sf -o /dev/null -w 'status=%{http_code}\n' http://127.0.0.1:3001/login
```

If not active, start it (needs the `.env` populated as above):

```bash
sudo systemctl start galaxia-cockpit.service     # prod path (systemd, port 3001)
# OR, ad-hoc without systemd:
( cd apps/cockpit && set -a && . ./.env && set +a \
  && HOST=127.0.0.1 PORT=3001 ORIGIN=http://127.0.0.1:3001 node build & )
timeout 20 bash -c 'until curl -sf http://127.0.0.1:3001/login >/dev/null; do sleep 0.5; done'
```

**Then drive it.** Two harnesses, pick by intent:

### a) Full public-surface smoke (preferred for "is it healthy?")

```bash
( cd ../../ops/browser-smoke && BASE_URL=http://127.0.0.1:3001 node test.mjs )
# → 12 checks pass, screenshots in ops/browser-smoke/out/01-login.png + 02-login-final.png
```

Covers: auth-gate (`/` → 303 `/login`), login page renders (title, h1,
password input, submit), guarded routes (`/documents`, `/briefs`,
`/api/conversations`) all bounce to `/login`, `/api/tts` refuses
without cookie, static assets (favicon, manifest), 0 JS console error.

### b) Ad-hoc one-shot screenshot (preferred for "show me /X")

```bash
node .claude/skills/run-cockpit/driver.mjs <url> [selector] [out.png]
# example: screenshot the login form
node .claude/skills/run-cockpit/driver.mjs \
  http://127.0.0.1:3001/ 'input[type=password]' /tmp/cockpit-login.png
# → status=200 final=http://127.0.0.1:3001/login?next=%2F
# → shot=/tmp/cockpit-login.png
```

| arg | default | purpose |
|---|---|---|
| `<url>` | (required) | what to navigate to — `http://127.0.0.1:3001/<route>` |
| `[selector]` | `body` | CSS selector to `waitForSelector` before shot (15s timeout) |
| `[out.png]` | `/tmp/cockpit-shot.png` | screenshot destination |

The driver prints `status=…` `final=…` `shot=…`, plus any
`pageerror` / `console.error` it caught.

The cockpit owns `/data/cockpit.db` (SQLite, conversations + memory).
Any agent test that mutates state should either point at a throwaway
`COCKPIT_DB_PATH` or accept that it's writing to the live DB.

## Run (human path)

`npm run dev` starts a hot-reload Vite server on `127.0.0.1:3001` —
**will fail with `EADDRINUSE` while the systemd service is running.**
Stop the service first (`sudo systemctl stop galaxia-cockpit`) or run
dev on a different port (`npx vite dev --port 3002 --host 127.0.0.1`).
Then open the URL in a browser; Ctrl-C to stop.

Useless headless — use the agent path above.

## Test

There is no in-tree unit-test suite for the cockpit. The "tests" are
the browser smoke (above) and `npm run check` (TypeScript + Svelte
type-check):

```bash
npm run check        # svelte-kit sync + svelte-check
# → 0 errors, ~7 pre-existing warnings (a11y autofocus, derived/state hints).
#   Treat a new error as the chantier's regression; warnings stay flat.
```

## Gotchas

- **Port 3001, not 3000.** The Dockerfile and SvelteKit defaults say
  `PORT=3000`, but the systemd unit overrides to `3001` (and Caddy
  proxies `app.galaxia-os.com` → `127.0.0.1:3001`). Always hit `:3001`
  on this host.
- **The dev port and the prod port are the same.** `package.json`'s
  `scripts.dev` is `vite dev --port 3001`, so dev and systemd fight.
  Stop systemd or override `--port` when running `npm run dev`.
- **Playwright is installed in `ops/browser-smoke/`, not here.** The
  ad-hoc `driver.mjs` does `createRequire('…/ops/browser-smoke/')`
  to locate it — don't try to `npm install playwright` in
  `apps/cockpit/`, it bloats the prod image. If you move the driver
  out of `apps/cockpit/`, update the absolute path inside it.
- **`/api/tts` returns `200 + text/html` (the SvelteKit error page),
  not `401`,** when called without a cookie. The smoke asserts on the
  content-type, not the status. Don't "fix" this by changing the
  smoke to expect 401.
- **Login is gated by an argon2id hash, not a plaintext password.**
  Without `JEFF_PASS_HASH` in the env the process dies on the first
  `verifyPassword` call. For authenticated drive-by, the cleanest path
  is to grab the `galaxia_session` cookie from a logged-in browser and
  inject it via `ctx.addCookies(…)` — `driver.mjs` does not currently
  do this; extend it if you need authenticated routes.
- **`ORIGIN` must match the URL you hit** when `NODE_ENV=production`,
  or SvelteKit's CSRF check refuses form POSTs. The systemd unit sets
  `ORIGIN=https://app.galaxia-os.com` because Caddy fronts it; if you
  start `node build` yourself on `127.0.0.1:3001`, set
  `ORIGIN=http://127.0.0.1:3001` or login POSTs will 403.

## Troubleshooting

- **`SyntaxError: Named export 'chromium' not found`** when running
  the driver: that means you `import { chromium } from 'playwright'`
  with an ESM import. Playwright ships as CJS — use the
  `createRequire(...)` pattern already in `driver.mjs`.
- **`browserType.launch: Executable doesn't exist at …chromium-…/chrome-linux/chrome`**:
  the Playwright browser binaries aren't downloaded. `cd ops/browser-smoke && npm run install:browser`.
- **`Error: Missing env var SESSION_SECRET` (or `JEFF_PASS_HASH`, or `ANTHROPIC_API_KEY`)**:
  `apps/cockpit/.env` is missing or incomplete. Source `.env.example`,
  fill the three required vars, restart.
- **`EADDRINUSE :3001`** on `npm run dev`: the systemd-managed prod
  build is already on that port. `sudo systemctl stop galaxia-cockpit`
  or use a different `--port`.
