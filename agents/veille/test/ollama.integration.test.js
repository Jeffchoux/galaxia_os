import test from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeItem } from '../synthesize.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';

async function ollamaUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const probe = OLLAMA_URL.replace(/\/api\/generate$/, '/api/tags');
    const res = await fetch(probe, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// CPU inference on llama3.1:8b is slow (~2 tok/s). Use numPredict=30 to keep
// the test under ~20 s; node:test would kill the suite if we waited 60 s+ here.
test('synthesizeItem produces a non-empty FR tldr via local Ollama', { timeout: 180_000 }, async (t) => {
  if (!(await ollamaUp())) {
    t.skip('Ollama not reachable at ' + OLLAMA_URL);
    return;
  }
  const item = {
    title: 'A new on-premise RAG agent framework with Ollama support',
    summary: 'Adds local guardrails, sandboxed execution, MCP tools.',
    url: 'https://example.com/x',
  };
  const tldr = await synthesizeItem(item, { numPredict: 30 });
  assert.equal(typeof tldr, 'string');
  assert.ok(tldr.length > 10, `expected non-trivial tldr, got: "${tldr}"`);
});
