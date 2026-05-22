#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchHackerNews } from './sources/hackernews.js';
import { fetchGithubTrending } from './sources/github-trending.js';
import { fetchArxiv } from './sources/arxiv.js';
import { filterItems, groupBySource } from './filter.js';
import { renderReport } from './synthesize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'veille');

async function safe(name, fn) {
  try {
    const data = await fn();
    return { name, data };
  } catch (err) {
    return { name, error: err.message || String(err) };
  }
}

export async function run({ date = today(), outDir = OUT_DIR } = {}) {
  console.log(`[veille] start ${date}`);

  const results = await Promise.all([
    safe('hackernews', () => fetchHackerNews()),
    safe('github-trending', () => fetchGithubTrending()),
    safe('arxiv', () => fetchArxiv()),
  ]);

  const allItems = [];
  for (const r of results) {
    if (r.error) {
      allItems.push({ source: r.name, error: r.error });
      console.warn(`[veille] ${r.name} failed: ${r.error}`);
    } else {
      allItems.push(...r.data);
      console.log(`[veille] ${r.name}: ${r.data.length} items`);
    }
  }

  const filtered = filterItems(allItems);
  console.log(`[veille] kept ${filtered.filter((i) => !i.error).length} items after filter`);

  const groups = groupBySource(filtered);
  const md = await renderReport(groups, { date });

  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.md`);
  await writeFile(outPath, md, 'utf8');
  console.log(`[veille] wrote ${outPath}`);
  return outPath;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error('[veille] fatal:', err);
    process.exit(1);
  });
}
