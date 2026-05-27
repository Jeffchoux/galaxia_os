# agents/coder — Galaxia daily improvement agent

The **first paying consumer of the Anthropic API in Galaxia.** Once a day at 07:00 UTC, this agent reads the night's veille report, picks 1 to 3 actionable items, and opens improvement PRs on `Jeffchoux/galaxia_os`. Because it's the first, it also acts as the **reference for token economics** that every future Galaxia agent should copy.

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
- `gh` CLI authenticated on the host, **or** `GH_TOKEN` env var set (auto-passed through by systemd).
- Git configured with SSH access to `Jeffchoux/galaxia_os` (true on OpenJeff via the existing deploy key).
- The day's veille report exists at `/home/galaxia/galaxia-project/docs/veille/<today>.md` (the `galaxia-veille.timer` writes it at 06:30 UTC).

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
| `GALAXIA_CODER_GPG_KEY_ID`        | unset                                                | If set, commits in the clone are signed with that GPG key.                                      |
| `GALAXIA_VEILLE_DIR`              | `/home/galaxia/galaxia-project/docs/veille`          | Where to look for the day's report.                                                              |
| `GALAXIA_CODER_RUN_DIR`           | `<GALAXIA_VEILLE_DIR>/../coder-runs`                 | Où écrire/lire les journaux de run (un `.json` par jour). Créé automatiquement si absent.        |
| `GALAXIA_REPO_URL`                | `git@github.com:Jeffchoux/galaxia_os.git`            | Override for forks / testing.                                                                    |

## How a run proceeds

1. `galaxia-coder.timer` fires at ~07:00 UTC (+ up to 5 min jitter).
2. `index.mjs` checks for `<today>.md` in the veille directory:
   - Missing or empty → exit `0` immediately, **no API call**.
3. Pre-filter the veille body in pure Node:
   - Split into bullet items, keep only those whose text matches the PME keyword list (`ollama`, `mcp`, `rag`, `agent`, `docker`, `cosign`, `souverain`, etc.).
   - Bail out cleanly if zero items match — **still no API call**.
4. Clone `Jeffchoux/galaxia_os` shallow (`--depth 50`) to `/tmp/galaxia-coder-<date>-XXXXXX/galaxia_os`.
5. Set **local** git identity and (optionally) GPG signing on that checkout. Global config is never touched.
6. Invoke the Claude Agent SDK with the filtered veille body in the **user prompt**, the persona in the **system prompt append**, and `cwd` pinned to the clone.
7. The agent reads `BRIEFING.md` / `CLAUDE.md` as needed, branches, edits, commits, pushes, opens PRs via `gh`.
8. The agent emits one `<report>…</report>` JSON block as its final assistant text.
9. `index.mjs` parses the block, validates with Zod, writes `<date>.json` to `RUN_DIR`, logs the PR URLs.

Branches follow `coder/YYYY-MM-DD-<kebab-slug>`. PRs carry the `coder` label.

## Token economics — the reference for future Galaxia agents

This agent is the first Galaxia code that calls the paid Anthropic API. Every future agent should follow the same playbook. The levers, in order of impact:

### 1. Don't call the API unless there's work to do

`index.mjs` does **two cheap, local short-circuits** before the API is touched:
- Veille file missing or `< 200` chars → exit `0`.
- Veille file present but **zero keyword matches** in the pre-filter → exit `0`.

A daily run on a quiet day costs **zero tokens**.

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
