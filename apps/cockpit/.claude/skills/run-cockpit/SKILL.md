---
name: run-cockpit
description: Build, run, and drive the Galaxia cockpit (SvelteKit web app). Use when asked to start the cockpit, log in, screenshot the chat/login UI, drive the authenticated app headless with Playwright, run its browser smoke, or check the auth gate.
---

The cockpit is a SvelteKit (adapter-node) web app. In prod on OpenJeff it runs
as a systemd service (`galaxia-cockpit.service`, user `galaxia`) on
`127.0.0.1:3001` behind Caddy. It is **auth-gated** — every route except
`/login` and `/auth/verify` 303-redirects to `/login`.

Drive it **headless** with the Playwright + Chromium already installed in
`../../ops/browser-smoke/`. Three harnesses, by intent:

- **Drive the *authenticated* app** (chat UI, sidebar, screenshot the real
  thing): `.claude/skills/run-cockpit/auth-smoke.sh` — boots a throwaway
  instance with a known password, logs in, screenshots. **Start here.**
- **Health-check the public surface** (auth gate, login render, no JS errors):
  `../../ops/browser-smoke/test.mjs`.
- **One-shot screenshot of any URL** (authed or not):
  `.claude/skills/run-cockpit/driver.mjs`.

All paths below are relative to `apps/cockpit/` (the SvelteKit unit).

## Prerequisites

Node 22+ (the build has native deps — `better-sqlite3`, `@node-rs/argon2`).

```bash
sudo apt-get update
sudo apt-get install -y python3 build-essential ca-certificates curl
node -v   # must be >= 22.0.0  (verified: v22.22.2)
```

Playwright + Chromium (one-time, in `../../ops/browser-smoke/`):

```bash
cd ../../ops/browser-smoke
npm install
npm run install:browser      # downloads Chromium into ~/.cache/ms-playwright
sudo npm run install:deps    # apt: libnss3 libnspr4 libxkbcommon0 …
```

The driver and `auth-smoke.sh` locate this Playwright by walking up the tree to
`ops/browser-smoke/node_modules` — **don't** `npm install playwright` inside
`apps/cockpit/` (it bloats the prod Docker image).

## Build

```bash
npm ci                     # prod + dev deps, compiles native modules
npm run build              # vite build → ./build/ (adapter-node bundle), ~6s
```

## Run (agent path)

### a) Drive the authenticated cockpit — `auth-smoke.sh` (start here)

Boots a **throwaway** instance (own port `:3099`, fresh SQLite DB in a
tempdir, a password it picks itself), logs in via the admin password form,
screenshots the real authenticated chat UI, then tears everything down — all
in **one process**, so nothing is left running.

```bash
bash .claude/skills/run-cockpit/auth-smoke.sh
# · booting throwaway cockpit on 127.0.0.1:3099 …
# · up. driving authenticated login…
# login=ok as admin (cookie set)
# status=200 final=http://127.0.0.1:3099/
# shot=/tmp/cockpit-shots/cockpit-authenticated.png
```

The screenshot (`/tmp/cockpit-shots/cockpit-authenticated.png`) shows the
logged-in app: sidebar (conversations, projects, briefs, "Se déconnecter"),
the "Hey Galaxia, on parle ?" header with voice toggles, and the composer
with the `⚡ Rapide` / `🧠 Opus` model switch. Override `SHOT_DIR` or `PORT` via
env.

Why a throwaway and not the prod `:3001`: prod sets
`ORIGIN=https://app.galaxia-os.com` (Caddy fronts it), so a browser form POST
from `127.0.0.1` fails SvelteKit's CSRF check — and we don't have Jeff's real
password. The throwaway sets `ORIGIN=http://127.0.0.1:3099` and a password we
chose, so login actually works.

### b) Public-surface smoke — "is it healthy?"

Needs an instance already up. On OpenJeff that's prod on `:3001`:

```bash
systemctl is-active galaxia-cockpit.service                      # → active
( cd ../../ops/browser-smoke && BASE_URL=http://127.0.0.1:3001 node test.mjs )
# → 17 passed, 0 failed ; screenshots in ops/browser-smoke/out/
```

Covers: `/` → 303 `/login`, login page renders (title, h1, email field, admin
toggle reveals the password field), guarded routes (`/documents`, `/briefs`,
`/api/conversations`) bounce to `/login`, `/api/tts` + `/api/realtime/*` refuse
without a cookie, static assets serve, 0 JS console errors. Stops at the login
page on purpose (no secret in the repo) — for the authed app use (a).

### c) One-shot screenshot of any route — `driver.mjs`

```bash
# unauthenticated (any guarded route just shows /login):
node .claude/skills/run-cockpit/driver.mjs http://127.0.0.1:3001/ 'input[type=email]' /tmp/login.png
# → status=200 final=http://127.0.0.1:3001/login?next=%2F  /  shot=/tmp/login.png

# authenticated: set COCKPIT_PASSWORD → it logs in first, then screenshots <url>
COCKPIT_PASSWORD=galaxia-test-pw \
  node .claude/skills/run-cockpit/driver.mjs http://127.0.0.1:3099/documents body /tmp/docs.png
# → login=ok …  status=200 final=http://127.0.0.1:3099/documents  (the real authed page, not /login)
```

| arg | default | purpose |
|---|---|---|
| `<url>` | (required) | route to navigate to |
| `[selector]` | `body` | CSS selector to wait for before the shot (15s) |
| `[out.png]` | `/tmp/cockpit-shot.png` | screenshot destination (a `*-crash.png` is written on failure) |

Env: `COCKPIT_PASSWORD` (enables the admin-password login), `COCKPIT_LOGIN_URL`
(defaults to `<url>`'s origin + `/login`). The driver prints `login=ok`,
`status=`, `final=`, `shot=`, and any `pageerror` / `console.error`.

To boot your own instance for (c) by hand, copy the `env … node build &` block
out of `auth-smoke.sh` (or use that script). The prod path is:

```bash
sudo systemctl start galaxia-cockpit.service   # systemd, reads apps/cockpit/.env, port 3001
```

The prod cockpit owns `/data/cockpit.db` (conversations, projects, usage).
`auth-smoke.sh` never touches it (separate temp DB); a hand-rolled instance
should point `COCKPIT_DB_PATH` at a throwaway too.

## Setup (env the cockpit reads)

| var | role |
|---|---|
| `ADMIN_EMAIL` | **required at boot** — provisioned as the admin user; missing → crash on start |
| `ANTHROPIC_API_KEY` | required for `/api/chat` (lazy — boot/login work without it) |
| `JEFF_PASS_HASH` | required for password login — argon2id hash |
| `SESSION_SECRET` | required to mint/verify the `galaxia_session` cookie (32+ bytes b64) |
| `COCKPIT_DB_PATH` | optional — defaults to `./data/cockpit.db` |
| `COCKPIT_MODEL` | optional — defaults to `claude-opus-4-7` |
| `ORIGIN` | must equal the URL you hit (CSRF on POST), see Gotchas |

Prod reads these from `apps/cockpit/.env` via the systemd unit's
`EnvironmentFile=`. Generate a hash + secret:

```bash
node -e "import('@node-rs/argon2').then(a=>a.hash(process.argv[1]).then(console.log))" -- '<password>'
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## Run (human path)

`npm run dev` runs Vite hot-reload on `127.0.0.1:3001` — **the same port as the
systemd service**, so it fails `EADDRINUSE` while prod is up. Stop prod first
(`sudo systemctl stop galaxia-cockpit`) or pick another port
(`npx vite dev --port 3002 --host 127.0.0.1`), then open it in a browser.
Useless headless — use the agent path.

## Test

No in-tree unit suite. The "tests" are the browser smoke (above) and the
type-check:

```bash
npm run check        # svelte-kit sync + svelte-check → 0 errors, 0 warnings
```

## Gotchas

- **Never `source`/`set -a; . .env` with these values.** The argon2 hash and
  some secrets contain literal `$` (`$argon2id$v=19$m=…`). systemd's
  `EnvironmentFile` keeps them literal, but a bash `source` **expands**
  `$argon2id`/`$v`/`$m` to empty → corrupted hash → login silently returns
  `401 Mot de passe incorrect`. Pass env to `node build` directly (`env VAR=…`
  with single-quoted values), as `auth-smoke.sh` does.
- **Port 3001, not 3000.** The Dockerfile/SvelteKit default is `3000`; the
  systemd unit overrides to `3001` and Caddy proxies `app.galaxia-os.com` →
  `127.0.0.1:3001`. The throwaway smoke uses `3099` to avoid the clash.
- **`ORIGIN` must match the URL you hit** under `NODE_ENV=production`, or
  SvelteKit's CSRF check 403s form POSTs (i.e. login). Prod is
  `https://app.galaxia-os.com` (behind Caddy); a local instance must be
  `http://127.0.0.1:<port>`. This is exactly why the authed drive uses its own
  instance, not prod.
- **The `galaxia_session` cookie is `Secure`** — but Chromium treats
  `127.0.0.1` as a secure context, so login over plain `http://127.0.0.1`
  works headless. (`curl` won't store it; use the browser driver.)
- **`auth-smoke.sh` isolates the DB + auth only.** Briefs and the Code view
  still read the real host dirs (`COCKPIT_BRIEFS_DIR` defaults to
  `~/.claude/galaxia/briefs`, `COCKPIT_CODE_ROOT` to the repo) — that's why the
  throwaway's sidebar shows real briefs. Don't be surprised; it's read-only.
- **`/api/tts` without a cookie returns `200 + text/html`** (the SvelteKit
  error page), not `401`. The smoke asserts on content-type, not status —
  don't "fix" it to expect 401.
- **Playwright lives in `ops/browser-smoke/`, not here.** `driver.mjs` walks up
  to find it. If you move the driver outside the repo, set `NODE_PATH` to that
  `node_modules` or the import fails.

## Troubleshooting

- **`login=ok` never prints / login lands back on `/login`**: wrong password,
  almost always the `$`-expansion trap above. Verify with
  `node -e 'import("@node-rs/argon2").then(a=>a.verify(process.env.H,"<pw>").then(console.log))'`
  run from `apps/cockpit/` (so `@node-rs/argon2` resolves).
- **`Cannot find package '@node-rs/argon2'`** from a `node -e` one-liner: run
  it with cwd `apps/cockpit/` (module resolves from the nearest `node_modules`).
- **`net::ERR_CONNECTION_REFUSED`** from the smoke/driver: no cockpit on that
  port. `systemctl start galaxia-cockpit` (prod :3001) or use `auth-smoke.sh`
  (boots its own :3099).
- **`Executable doesn't exist at …chromium-…/chrome`**: Playwright browser not
  downloaded → `cd ../../ops/browser-smoke && npm run install:browser`.
- **`Error: Missing env var ADMIN_EMAIL`** at boot: the instance has no env.
  Source/populate `apps/cockpit/.env` (prod) or pass env inline (ad-hoc).
- **`EADDRINUSE :3001`** on `npm run dev`: the systemd prod build holds the
  port. Stop it or use a different `--port`.
- **Don't `pkill -f 'node build'`** to clean up strays — that pattern can match
  and kill unrelated shells/processes. Kill by port instead: `fuser -k 3099/tcp`.
