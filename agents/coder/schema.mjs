// Zod schemas for the coder agent's final structured output.
// Imported by index.mjs to validate the <report>...</report> block.

import { z } from "zod";

const ProposalSchema = z.object({
  title: z.string().min(5).max(120),
  branch: z.string().regex(
    /^coder\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/,
    "branch must match coder/YYYY-MM-DD-<kebab-slug>",
  ),
  rationale: z.string().min(20),
  // Optional — absent in dry-run mode or when the PR-create step failed.
  pr_url: z.string().url().optional(),
  files_changed: z.array(z.string()).min(1),
});

const RejectedSchema = z.object({
  item: z.string().min(1),
  reason: z.string().min(1),
});

export const RunReportSchema = z.object({
  proposals: z.array(ProposalSchema).max(3),
  rejected_items: z.array(RejectedSchema).default([]),
  notes: z.string().optional(),
});
