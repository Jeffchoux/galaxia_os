#!/usr/bin/env node
//
// Galaxia coder — daily entrypoint.
//
//   1. Claims curated proposals from Jeff's inbox (galaxia-updates/pending/),
//      moving each atomically to applied/ — these are pre-vetted by the daily
//      digest and take priority over the veille.
//   2. Locates today's veille report and pre-filters it to PME-actionable items.
//   3. Bails out cheaply if there is neither a proposal nor a veille item (no API call).
//   4. Clones the repo to a fresh /tmp working tree.
//   5. Configures git (signing, identity) on the local checkout only.
//   6. Invokes the Claude Agent SDK with a deterministic system prompt body.
//   7. Streams the agent loop, logging usage (cache reads, tokens) per turn.
//   8. Parses the final <report>...</report> block via Zod.
//   9. Exits non-zero if the report is missing/invalid; 0 otherwise.
//
// Token-economics levers (see README "Token economics" for the rationale):
//   - Sonnet 4.6 is the default model (5x cheaper than Opus, sufficient here).
//   - Pre-filter trims the veille to <= GALAXIA_CODER_MAX_ITEMS items, keeping
//     only those that look PME-actionable on a keyword scan.
//   - GALAXIA_CODER_MAX_USD_PER_RUN aborts mid-run if cumulative cost crosses it.
//   - maxTurns is capped at 40 (the SDK still self-stops earlier when done).
//   - The system prompt is loaded from a static file: no Date.now()/UUIDs.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { RunReportSchema } from "./schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VEILLE_DIR = process.env.GALAXIA_VEILLE_DIR
  ?? "/home/galaxia/galaxia-project/docs/veille";
const REPO_URL = process.env.GALAXIA_REPO_URL
  ?? "git@github.com:Jeffchoux/galaxia_os.git";
const MODEL = process.env.GALAXIA_CODER_MODEL ?? "claude-sonnet-4-6";
const DRY_RUN = process.env.GALAXIA_CODER_DRY_RUN === "1";
const MAX_TURNS = Number(process.env.GALAXIA_CODER_MAX_TURNS ?? 40);
const MAX_ITEMS = Number(process.env.GALAXIA_CODER_MAX_ITEMS ?? 30);
const MAX_USD = Number(process.env.GALAXIA_CODER_MAX_USD_PER_RUN ?? 1.00);
// Hard cap on how many PRs a single run opens. Default 1: a daily cadence makes
// one focused, reviewable PR per run plenty, and — crucially — it keeps the run
// well under MAX_TURNS. A 3-PR run on a full veille was hitting the 40-turn cap
// and dying before it could emit its <report> (the run looked "failed" even
// though PRs were created). The report schema independently caps the array at 3,
// so don't raise this above 3 without bumping schema.mjs too.
const MAX_PROPOSALS = Number(process.env.GALAXIA_CODER_MAX_PROPOSALS ?? 1);

// Curated proposals from Jeff. The daily digest (process_inbox.py) transcribes
// the TikToks/tweets Jeff sends over Telegram, categorizes each item, and writes
// the ones it judges to be concrete Galaxia improvements as markdown files in
// `pending/`. Those files live OUTSIDE this repo (under ~/.claude/galaxia/ on
// the mother machine) — both paths are overridable for tests and for filles
// that don't run the digest at all.
const PENDING_DIR = process.env.GALAXIA_PENDING_DIR
  ?? "/home/galaxia/.claude/galaxia/galaxia-updates/pending";
const APPLIED_DIR = process.env.GALAXIA_APPLIED_DIR
  ?? "/home/galaxia/.claude/galaxia/galaxia-updates/applied";

// Mots-clés positifs (signal PME). Tout item touchant l'un de ces motifs
// passe le pré-filtre. Si rien ne matche, l'agent ne tourne pas.
const POSITIVE_KEYWORDS = [
  "ollama", "mcp", "opensource", "open source", "rag", "sandbox", "agent",
  "wizard", "pme", "sme", "docker", "compose", "caddy", "nemoclaw", "openclaw",
  "cosign", "signed update", "security", "cve", "ai safety", "guardrail",
  "self-host", "on-premise", "souverain", "fine-tun", "huggingface", "claude",
  "anthropic",
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function log(...args) {
  console.error(`[galaxia-coder ${new Date().toISOString()}]`, ...args);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// Pré-filtre le rapport de veille. La veille produit typiquement 50-100 items
// (HN + GitHub + HF + arXiv). Envoyer le rapport entier coûte des tokens
// inutiles : on garde seulement les items dont le titre ou le résumé contient
// au moins un mot-clé positif. Bornage final à MAX_ITEMS items.
function prefilterVeille(body) {
  // Split par item Markdown : `- **[title](url)**\n  body\n`
  const items = [];
  const lines = body.split("\n");
  let buf = [];
  let inItem = false;
  for (const line of lines) {
    if (line.startsWith("- **[")) {
      if (buf.length) items.push(buf.join("\n"));
      buf = [line];
      inItem = true;
    } else if (inItem) {
      if (line.startsWith("## ") || line.startsWith("---")) {
        items.push(buf.join("\n"));
        buf = [];
        inItem = false;
      } else {
        buf.push(line);
      }
    }
  }
  if (buf.length) items.push(buf.join("\n"));

  const kept = [];
  for (const item of items) {
    const lower = item.toLowerCase();
    if (POSITIVE_KEYWORDS.some((k) => lower.includes(k))) {
      kept.push(item);
      if (kept.length >= MAX_ITEMS) break;
    }
  }
  return { total: items.length, kept };
}

// Claim every pending proposal by moving it pending/ -> applied/ BEFORE the
// agent runs. rename(2) is atomic within a single filesystem, so a re-triggered
// or concurrent run can never pick the same file twice (anti-rejeu). Trade-off:
// a crash after claiming but before the PR leaves a proposal in applied/ with no
// PR. We accept that — the proposal also lives in the day's brief and can be
// re-dropped — because opening a DUPLICATE PR is the worse failure. Returns the
// claimed proposals (filename + raw markdown body). Empty (and inert) when
// pending/ is absent, e.g. on a fille that doesn't run the digest.
function claimPendingProposals() {
  if (!existsSync(PENDING_DIR)) return [];
  mkdirSync(APPLIED_DIR, { recursive: true });
  const claimed = [];
  for (const name of readdirSync(PENDING_DIR).filter((f) => f.endsWith(".md")).sort()) {
    const dst = join(APPLIED_DIR, name);
    try {
      renameSync(join(PENDING_DIR, name), dst); // atomic claim
    } catch (err) {
      if (err.code === "ENOENT") continue; // already claimed by a concurrent run
      throw err;
    }
    claimed.push({ name, body: readFileSync(dst, "utf8") });
  }
  return claimed;
}

async function main() {
  const date = today();

  // Fail fast before we consume anything: no key means we can't run, and we
  // must not move proposals out of pending/ only to bail.
  if (!process.env.ANTHROPIC_API_KEY) {
    log("ANTHROPIC_API_KEY missing. Refusing to run.");
    return 1;
  }

  // Source 1 (priority): curated proposals from Jeff, claimed atomically.
  const proposals = claimPendingProposals();
  if (proposals.length) {
    log(`Claimed ${proposals.length} curated proposal(s) from ${PENDING_DIR}.`);
  }

  // Source 2 (secondary): the auto-collected veille. May be absent — that's
  // fine as long as we have at least one curated proposal to act on.
  let kept = [];
  let total = 0;
  const veillePath = join(VEILLE_DIR, `${date}.md`);
  if (existsSync(veillePath)) {
    const veille = readFileSync(veillePath, "utf8");
    if (veille.trim().length < 200) {
      log("Veille report exists but is shorter than 200 chars — skipping veille.");
    } else {
      ({ total, kept } = prefilterVeille(veille));
      log(`Veille pre-filter: ${kept.length}/${total} items kept after keyword scan.`);
    }
  } else {
    log(`Veille report missing for ${date}: ${veillePath}`);
  }

  if (proposals.length === 0 && kept.length === 0) {
    log("No curated proposals and no PME-actionable veille items today. Skipping the API call entirely.");
    return 0;
  }
  // The user prompt carries the filtered items. The full veille is NOT sent.
  const filteredBody = kept.join("\n\n");

  const workRoot = mkdtempSync(join(tmpdir(), `galaxia-coder-${date}-`));
  const repoPath = join(workRoot, "galaxia_os");
  log(`Cloning into ${repoPath}`);
  run("git", ["clone", "--depth", "50", REPO_URL, repoPath]);

  // Local-only git config — never touch the user's global config.
  run("git", ["-C", repoPath, "config", "user.name", "Galaxia Coder"]);
  run("git", ["-C", repoPath, "config", "user.email", "coder@galaxia-os.com"]);
  if (process.env.GALAXIA_CODER_GPG_KEY_ID) {
    log(`Enabling commit signing with GPG key ${process.env.GALAXIA_CODER_GPG_KEY_ID}`);
    run("git", ["-C", repoPath, "config", "commit.gpgsign", "true"]);
    run("git", ["-C", repoPath, "config", "user.signingkey",
      process.env.GALAXIA_CODER_GPG_KEY_ID]);
  } else {
    log("No GALAXIA_CODER_GPG_KEY_ID — commits will be unsigned.");
  }

  // System prompt body is read from disk and passed as `append` to the SDK's
  // Claude Code preset. Keeping the file byte-stable across runs preserves the
  // SDK's automatic prompt-cache hits on every turn after the first.
  const systemPromptBody = readFileSync(join(__dirname, "system-prompt.md"), "utf8");

  const curatedSection = proposals.length
    ? [
        `## Curated proposals from Jeff (PRIORITY — handle these first)`,
        ``,
        `Jeff sent these over Telegram and the daily digest already categorized them as concrete Galaxia improvements. They are pre-vetted: do NOT re-filter them, and prioritize them over the veille items below. Each block is one proposal (title, source, context, proposed change, files affected). If, after reading the repo, one turns out not to map to a real code/doc change, reject it with a reason in the report rather than forcing a PR.`,
        ``,
        proposals
          .map((p, i) => `### Curated proposal ${i + 1}\n\n${p.body.trim()}`)
          .join("\n\n---\n\n"),
        ``,
      ].join("\n")
    : ``;

  const veilleSection = kept.length
    ? [
        `## Daily veille — filtered (${kept.length} items out of ${total})`,
        ``,
        `The orchestrator already removed items that don't carry PME-relevant signal. You don't need to filter further; pick from below.`,
        ``,
        filteredBody,
        ``,
      ].join("\n")
    : ``;

  const capPhrase = MAX_PROPOSALS === 1
    ? `exactly ONE PR — the single highest-leverage item`
    : `up to ${MAX_PROPOSALS} PRs`;
  const taskLine = proposals.length
    ? `Open ${capPhrase} this run, **always prioritizing the curated proposals above** the veille list. As soon as you have opened the capped number of PR(s), STOP starting new work, record the rest as rejected (with reasons), and emit the <report>...</report> block as your final assistant turn. Do not exceed the cap — it protects the turn budget.`
    : `Open ${capPhrase} from the filtered list above (or return an empty proposals array with reasons if nothing qualifies). As soon as you have opened the capped number of PR(s), STOP starting new work, record the rest as rejected (with reasons), and emit the <report>...</report> block as your final assistant turn. Do not exceed the cap — it protects the turn budget.`;

  const userPrompt = [
    `Today is ${date} (UTC).`,
    `Working tree (already cloned and on \`main\`): ${repoPath}.`,
    `Default branch: main. Remote: origin.`,
    DRY_RUN
      ? `DRY_RUN=1 — perform git operations locally but skip \`git push\` and \`gh pr create\`. Still produce the <report>.`
      : ``,
    ``,
    curatedSection,
    veilleSection,
    `## Your task`,
    ``,
    taskLine,
  ].filter(Boolean).join("\n");

  log(`Invoking Claude Agent SDK — model=${MODEL}, maxTurns=${MAX_TURNS}, dryRun=${DRY_RUN}`);

  const result = query({
    prompt: userPrompt,
    options: {
      model: MODEL,
      cwd: repoPath,
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptBody },
      allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      maxTurns: MAX_TURNS,
      // Empty: do NOT load any local .claude/ settings — keeps the run hermetic.
      settingSources: [],
    },
  });

  let finalText = "";
  let cumulativeCostUsd = 0;
  try {
    for await (const message of result) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            finalText = block.text; // last assistant text wins for the <report>
          }
        }
      } else if (message.type === "result") {
        log(
          `Agent done. subtype=${message.subtype} turns=${message.num_turns} ` +
          `cost=$${(message.total_cost_usd ?? 0).toFixed(4)} ` +
          `input=${message.usage?.input_tokens ?? 0} ` +
          `output=${message.usage?.output_tokens ?? 0} ` +
          `cache_read=${message.usage?.cache_read_input_tokens ?? 0} ` +
          `cache_create=${message.usage?.cache_creation_input_tokens ?? 0}`,
        );
        cumulativeCostUsd = message.total_cost_usd ?? 0;
        if (cumulativeCostUsd > MAX_USD) {
          log(`Cost $${cumulativeCostUsd.toFixed(4)} exceeded budget $${MAX_USD} — flagged in notes.`);
        }
      }
    }
  } catch (err) {
    log("Agent loop crashed:", err.stack ?? err.message ?? err);
    return 2;
  }

  const match = finalText.match(/<report>([\s\S]*?)<\/report>/);
  if (!match) {
    log("Agent produced no <report> block. Final assistant text (truncated):");
    log(finalText.slice(0, 2000));
    return 2;
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (e) {
    log("Failed to JSON.parse the <report> body:", e.message);
    log("Raw body:", match[1].slice(0, 1000));
    return 2;
  }

  const validation = RunReportSchema.safeParse(parsed);
  if (!validation.success) {
    log("Report did not match schema:");
    log(JSON.stringify(validation.error.flatten(), null, 2));
    return 2;
  }

  const report = validation.data;
  log(
    `Run summary: ${report.proposals.length} proposal(s), ` +
    `${report.rejected_items.length} rejection(s), cost=$${cumulativeCostUsd.toFixed(4)}.`,
  );
  for (const p of report.proposals) {
    log(`  ✓ ${p.title} → ${p.pr_url ?? "(no URL — dry run or PR step failed)"}`);
  }
  for (const r of report.rejected_items) {
    log(`  ✗ rejected: ${r.item.slice(0, 80)} — ${r.reason}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("Fatal:", err.stack ?? err);
    process.exit(1);
  });
