# agents/coder — Galaxia daily improvement agent

The **first paying consumer of the Anthropic API in Galaxia.** Once a day at 07:00 UTC, this agent reads two sources — **curated proposals Jeff sent over Telegram** (priority) and the **auto-collected IA veille** (secondary) — picks the highest-leverage item (one PR per run by default, see `GALAXIA_CODER_MAX_PROPOSALS`), and opens an improvement PR on `Jeffchoux/galaxia_os`. Because it's the first, it also acts as the **reference for token economics** that every future Galaxia agent should copy.

## The two input sources

| Source                | Where it comes from                                                                                                                                                  | Priority |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| **Curated proposals** | Jeff forwards TikToks / tweets to the Telegram bot → the daily digest (`~/.claude/galaxia/pipeline/process_inbox.py`) transcribes + categorizes them and writes the `galaxia-update` ones as markdown in `~/.claude/galaxia/galaxia-updates/pending/`. | **High** — handled first. |
| **Daily veille**      | `galaxia-veille.timer` writes `docs/veille/<today>.md` (HackerNews, GitHub, arXiv, HF), keyword pre-filtered here.                                                   | Lower — only after curated. |

At startup, `index.mjs` **claims** every pending proposal by moving it `pending/ → applied/` with an atomic `rename(2)`. This is the anti-replay guard: a re-triggered or concurrent run can never pick the same proposal twice. A proposal that fails mid-run is **not** put back (it stays in `applied/`); we accept losing it over the worse failure of opening a duplicate PR — it also lives in the day's brief and can be re-dropped by hand. The digest pipeline lives **outside this repo** (it's mother-machine-only); a fille that doesn't run it simply has no `pending/` dir, and the bridge stays inert.

## Stack

- Node.js 22 (ESM, no TypeScript build step — pure `.mjs`)
- `@anthropic-ai/claude-agent-sdk` — drives the agent loop. Brings the full Claude Code built-in toolset (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`). The SDK handles automatic prompt caching for the system prompt + tool definitions.
- `zod` — schema for the agent's final structured `<report>` block.
- `gh` CLI on the host — used by the agent for `gh pr create` (no Octokit dependency).

## Files

| File              | Purpose                                                                             |
|-------------------|-------------------------------------------------------------------------------------|
| `index.mjs`       | Entrypoint: pre-filter veille → clone repo → configure git → invoke agent → parse report. |
| `system-prompt.md`| Deterministic, byte-stable persona appended to the SDK's Claude Code preset.        |
| `schema.mjs`      | Zod schema for the `<report>...</report>` block.                                    |
| `package.json`    | Two runtime deps only (`@anthropic-ai/claude-agent-sdk`, `zod`).                    |

## Prerequisites on the host

- `ANTHROPIC_API_KEY` exported (the wizard writes it to `/opt/galaxia/config/.env`; the systemd unit sources that file).
- `GH_TOKEN` set in `/opt/galaxia/config/.env` so the agent's `gh pr create` authenticates non-interactively under systemd. **Caveat:** on OpenJeff this currently reuses the cockpit PAT, scope `public_repo` only — enough because `galaxia_os` is public, but it **cannot push to `.github/workflows/`** (no `workflow` scope). A proposal that touches CI will fail at push; the agent records that in the report. (Planned: a dedicated `repo`-scoped token.)
- Git configured with SSH access to `Jeffchoux/galaxia_os` (true on OpenJeff via the existing deploy key) — push uses SSH, PR creation uses `GH_TOKEN`.
- The `coder` and `discussion` labels exist on the repo (the agent passes `--label coder`; missing labels make `gh pr create` fail).
- Optionally, the day's veille report at `docs/veille/<today>.md`. With curated proposals waiting, the veille is **not** required for a run to happen.
- The unit grants `ReadWritePaths=/home/galaxia/.claude/galaxia/galaxia-updates` (otherwise `ProtectSystem=strict` makes the claim-`mv` fail with `EROFS`).

## Install on the host (one-time)

```bash
cd /home/galaxia/galaxia-project/agents/coder
npm install --omit=dev

# Symlink + enable the timer
sudo ln -sf /home/galaxia/galaxia-project/ops/systemd/galaxia-coder.service \
            /etc/systemd/system/galaxia-coder.service
sudo ln -sf /home/galaxia/galaxia-project/ops/systemd/galaxia-coder.timer \
            /etc/systemd/system/galaxia-coder.timer
sudo systemctl daemon-reload
sudo systemctl enable --now galaxia-coder.timer
systemctl list-timers galaxia-coder.timer
```

## Run manually

```bash
cd agents/coder
ANTHROPIC_API_KEY=… node index.mjs
```

Dry-run mode (do everything **except** `git push` and `gh pr create`):

```bash
GALAXIA_CODER_DRY_RUN=1 node index.mjs
```

### Tester la boucle curée

Pour vérifier le chemin complet Telegram → digest → `pending/` → coder sans passer par Telegram :

1. Déposez un fichier `.md` de test dans `~/.claude/galaxia/galaxia-updates/pending/`, par exemple `2026-05-29-test.md`, avec un contenu de proposition valide (titre, contexte, fichiers concernés).
2. Lancez un run manuel du service :
   ```bash
   sudo systemctl start galaxia-coder.service
   ```
3. Vérifiez que le fichier a migré vers `applied/` (signe que le run l'a bien réclamé) :
   ```bash
   ls ~/.claude/galaxia/galaxia-updates/applied/
   ```
4. Vérifiez qu'une PR a été ouverte sur `Jeffchoux/galaxia_os` :
   ```bash
   journalctl -u galaxia-coder --since "1 min ago" | grep pr_url
   ```

> Note : si `GALAXIA_CODER_DRY_RUN=1` est actif, le run consomme la proposition mais n'ouvre pas de PR. Ôter la variable pour un test bout en bout complet.

## Environment variables

All optional unless noted.

| Variable                          | Default                                              | Effect                                                                                          |
|-----------------------------------|------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `ANTHROPIC_API_KEY`               | (required)                                           | API auth.                                                                                       |
| `GALAXIA_CODER_MODEL`             | `claude-sonnet-4-6`                                  | Override to `claude-opus-4-7` if you want higher-quality PRs at ~5x the cost.                  |
| `GALAXIA_CODER_DRY_RUN`           | `0`                                                  | `1` = skip `git push` and `gh pr create`. Still produce a `<report>`.                          |
| `GALAXIA_CODER_MAX_TURNS`         | `40`                                                 | Hard cap on agent loop iterations.                                                              |
| `GALAXIA_CODER_MAX_ITEMS`         | `30`                                                 | Items kept after the keyword pre-filter (the agent sees at most this many).                     |
| `GALAXIA_CODER_MAX_USD_PER_RUN`   | `1.00`                                               | Logged + flagged in the report `notes` when crossed. Not a hard kill (the SDK is already running). |
| `GALAXIA_CODER_MAX_PROPOSALS`     | `1`                                                  | How many PRs one run opens. Default 1 keeps the run well under `maxTurns`. Don't exceed 3 without bumping the schema cap in `schema.mjs`. |
| `GALAXIA_CODER_GPG_KEY_ID`        | unset                                                | If set, commits in the clone are signed with that GPG key.                                      |
| `GALAXIA_VEILLE_DIR`              | `/home/galaxia/galaxia-project/docs/veille`          | Where to look for the day's report.                                                              |
| `GALAXIA_REPO_URL`                | `git@github.com:Jeffchoux/galaxia_os.git`            | Override for forks / testing.                                                                    |
| `GALAXIA_PENDING_DIR`             | `/home/galaxia/.claude/galaxia/galaxia-updates/pending`  | Where the digest drops curated proposals. Absent dir → bridge inert.                         |
| `GALAXIA_APPLIED_DIR`             | `/home/galaxia/.claude/galaxia/galaxia-updates/applied`  | Where claimed proposals are atomically moved before the run.                                  |

## How a run proceeds

1. `galaxia-coder.timer` fires at ~07:00 UTC (+ up to 5 min jitter).
2. `index.mjs` **claims** the curated proposals: every `*.md` in `pending/` is moved to `applied/` with an atomic `rename(2)` and read into memory.
3. It then checks for `<today>.md` in the veille directory and pre-filters it in pure Node:
   - Missing / `< 200` chars → no veille items this run.
   - Otherwise: split into bullet items, keep only those whose text matches the PME keyword list (`ollama`, `mcp`, `rag`, `agent`, `docker`, `cosign`, `souverain`, etc.).
   - **If there are zero curated proposals AND zero kept veille items → exit `0`, no API call.**
4. Clone `Jeffchoux/galaxia_os` shallow (`--depth 50`) to `/tmp/galaxia-coder-<date>-XXXXXX/galaxia_os`.
5. Set **local** git identity and (optionally) GPG signing on that checkout. Global config is never touched.
6. Invoke the Claude Agent SDK with the filtered veille body in the **user prompt**, the persona in the **system prompt append**, and `cwd` pinned to the clone.
7. The agent reads `BRIEFING.md` / `CLAUDE.md` as needed, branches, edits, commits, pushes, opens PRs via `gh`.
8. The agent emits one `<report>…</report>` JSON block as its final assistant text.
9. `index.mjs` parses the block, validates with Zod, logs the PR URLs.

Branches follow `coder/YYYY-MM-DD-<kebab-slug>`. PRs carry the `coder` label.

## Token economics — the reference for future Galaxia agents

This agent is the first Galaxia code that calls the paid Anthropic API. Every future agent should follow the same playbook. The levers, in order of impact:

### 1. Don't call the API unless there's work to do

`index.mjs` short-circuits **before the API is touched** whenever there is genuinely nothing to do — i.e. **no curated proposal claimed AND** the veille is missing, `< 200` chars, or yields **zero keyword matches**. On a quiet day (no Telegram input, dull veille) that means a daily run costs **zero tokens**. A single curated proposal is enough on its own to make the run proceed, even with an empty veille.

### 2. Send the API only what it needs

The pre-filter cuts the veille from typically 50–100 items down to ≤ `GALAXIA_CODER_MAX_ITEMS` (default 30). The full veille body is **never** sent to the model. This alone trims input tokens by 60–80% on a typical day.

### 3. Pick the right model

`claude-sonnet-4-6` is the default. Sonnet 4.6 produces solid PRs for documentation, config, scripts, and small Bash/JS changes — which is 90% of what this agent does. **Reach for `claude-opus-4-7` only when the change requires deeper reasoning** (large refactor, security-sensitive code review). Set `GALAXIA_CODER_MODEL=claude-opus-4-7` per-run via the systemd override drop-in if you need it.

Cost reference (as of 2026-05): Sonnet 4.6 = $3 input / $15 output per 1M tokens; Opus 4.7 = $5 / $25.

### 4. Keep the cached prefix byte-stable

The Claude Agent SDK caches the **system prompt + tool definitions** automatically. To preserve that cache across the turns *within a single run*:

- `system-prompt.md` contains **no timestamp, no UUID, no per-run data**. It is byte-identical between runs.
- All volatile content (today's date, the working-tree path, the filtered veille body) is in the **user prompt**, not the system prompt.
- The `allowedTools` list is fixed at construction time. Changing it mid-run would invalidate the cache.

Cache hits are visible in the `result` message — `index.mjs` logs `cache_read=...` per run. If you ever see `cache_read=0` across multiple turns, a silent invalidator has crept in (someone added a `Date.now()` to the system prompt, the tool list changed, etc.). The `claude-api` skill bundled with Claude Code has a `shared/prompt-caching.md` audit table for this.

Runs are 24 h apart and the cache TTL is at most 1 h — caching does **not** help across days. The win is within each run (every turn after turn 1 reads the cached system prompt at ~0.1× cost).

### 5. Cap the loop

`maxTurns: 40` is a hard ceiling. The agent stops earlier when it's done. Even if it goes off the rails, the loop can't burn unbounded tokens.

`GALAXIA_CODER_MAX_PROPOSALS` (default **1**) is the more important lever in practice: it caps how many PRs a single run opens. A 3-PR run on a busy veille was hitting the 40-turn ceiling *mid-third-PR* and dying before it could emit its `<report>` — the run got marked "failed" even though it had already opened real PRs, and it left orphan branches behind. One focused PR per day is plenty at this cadence, finishes in ~10–15 turns, and keeps cost near ~$0.30. The task line in the user prompt is built from this value and tells the agent to **emit the report and stop the moment the cap is reached**.

### 6. Track and threshold cost per run

`index.mjs` reads `total_cost_usd` from the SDK's `result` message and warns if it crosses `GALAXIA_CODER_MAX_USD_PER_RUN` (default $1.00). The warning lands in the report's `notes` field — alert worthy if it happens twice in a week.

### Patterns we **don't** use (and why)

- **Cross-run prompt caching** — TTL of 1 h cannot survive 24 h. Skipped.
- **`@octokit/rest`** — `gh` CLI via the agent's Bash tool covers all PR / issue operations, with one fewer npm dep and no token to manage in code.
- **Pre-warming the cache** — only useful when the **first** real request's latency matters (chat, voice). Daily background cron doesn't care about TTFT.
- **Custom MCP servers** — the SDK's built-in tools cover everything this agent needs. A custom MCP server would add complexity, a process boundary, and no token win.

## Failure modes

| Symptom                                | What it means                                                                                                |
|----------------------------------------|--------------------------------------------------------------------------------------------------------------|
| Exit 0, no PRs                         | Veille file missing/short, or every item rejected by the pre-filter, or the agent itself rejected them all.  |
| Exit 1, `ANTHROPIC_API_KEY missing`    | Wizard hasn't run, or systemd `EnvironmentFile` is wrong.                                                    |
| Branch pushed, but no PR created      | `GH_TOKEN` is absent from `/opt/galaxia/config/.env`. The service never runs an interactive `gh auth login`, so without a token gh has no identity for `gh pr create` (the push itself works — it uses the SSH deploy key). Add `GH_TOKEN=ghp_…` (scope `public_repo`) to that file and `sudo systemctl daemon-reload`. |
| Exit 2, `no <report> block`            | Agent hit `maxTurns` or crashed mid-run. Inspect `journalctl -u galaxia-coder` for context.                  |
| Exit 2, schema validation failure      | Agent's report JSON is malformed. Same — read the journal.                                                   |
| PR opened but CI fails immediately     | Agent broke something. Cost: one human review-and-close. Document the failure in this README's "Known quirks" when it happens. |

The systemd unit doesn't auto-retry; the next firing tomorrow will try again with a fresh veille.

## Why this is "the reference"

Future Galaxia agents that call the Anthropic API will follow this layout:
- Local short-circuit before the first API byte is sent.
- Pre-filter the input to what the model genuinely needs.
- Static, byte-stable system prompt file.
- Volatile content in the user prompt only.
- Fixed tool surface for the run.
- `total_cost_usd` logged on every run, with a threshold alert.
- Sonnet by default, Opus only when the task demands it.

If you find yourself writing a new agent that diverges from this pattern, document the reason in the new agent's README so the divergence is visible.
