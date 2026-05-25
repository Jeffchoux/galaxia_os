#!/usr/bin/env node
//
// Galaxia coder — daily entrypoint.
//
//   1. Locates today's veille report.
//   2. Pre-filters the report to PME-actionable items only (saves API tokens).
//   3. Bails out cheaply if nothing is worth proposing today (no API call).
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
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
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

// Mots-clés positifs (signal PME). Tout item touchant l'un de ces motifs
// passe le pré-filtre. Si rien ne matche, l'agent ne tourne pas.
const POSITIVE_KEYWORDS = [
  "ollama", "mcp", "opensource", "open source", "rag", "sandbox", "agent",
  "wizard", "pme", "sme", "docker", "compose", "caddy", "nemoclaw", "openclaw",
  "cosign", "signed update", "security", "cve", "ai safety", "guardrail",
  "self-host", "on-premise", "souverain", "fine-tun", "huggingface", "claude",
  "anthropic", "llm", "deepseek",
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

async function main() {
  const date = today();
  const veillePath = join(VEILLE_DIR, `${date}.md`);
  if (!existsSync(veillePath)) {
    log(`Veille report missing for ${date}: ${veillePath}`);
    log("Nothing to propose; exiting cleanly.");
    return 0;
  }
  const veille = readFileSync(veillePath, "utf8");
  if (veille.trim().length < 200) {
    log(`Veille report exists but is shorter than 200 chars — skipping.`);
    return 0;
  }

  const { total, kept } = prefilterVeille(veille);
  log(`Veille pre-filter: ${kept.length}/${total} items kept after keyword scan.`);
  if (kept.length === 0) {
    log("No PME-actionable items today. Skipping the API call entirely.");
    return 0;
  }
  // The user prompt carries the filtered items. The full veille is NOT sent.
  const filteredBody = kept.join("\n\n");

  if (!process.env.ANTHROPIC_API_KEY) {
    log("ANTHROPIC_API_KEY missing. Refusing to run.");
    return 1;
  }

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

  const userPrompt = [
    `Today is ${date} (UTC).`,
    `Working tree (already cloned and on \`main\`): ${repoPath}.`,
    `Default branch: main. Remote: origin.`,
    DRY_RUN
      ? `DRY_RUN=1 — perform git operations locally but skip \`git push\` and \`gh pr create\`. Still produce the <report>.`
      : ``,
    ``,
    `## Daily veille — filtered (${kept.length} items out of ${total})`,
    ``,
    `The orchestrator already removed items that don't carry PME-relevant signal. You don't need to filter further; pick from below.`,
    ``,
    filteredBody,
    ``,
    `## Your task`,
    ``,
    `Pick 1–3 actionable items from the filtered list above (or return an empty proposals array with reasons if none qualifies). For each chosen item, follow the workflow in the system prompt and open a PR. End your final assistant turn with the <report>...</report> block.`,
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
