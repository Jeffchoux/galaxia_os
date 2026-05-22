import test from 'node:test';
import assert from 'node:assert/strict';

import { filterItems, groupBySource } from '../filter.js';
import { parseTrending } from '../sources/github-trending.js';
import { parseRss } from '../sources/arxiv.js';

test('filterItems keeps items matching at least one keyword', () => {
  const items = [
    { source: 'hn', title: 'New LLM agent framework released', summary: '' },
    { source: 'hn', title: 'Cats love cardboard boxes', summary: '' },
    { source: 'gh', title: 'foo/bar', summary: 'A self-hosted RAG demo' },
    { source: 'gh', title: 'baz/qux', summary: 'CSS animations' },
  ];
  const kept = filterItems(items);
  const titles = kept.map((i) => i.title);
  assert.ok(titles.includes('New LLM agent framework released'));
  assert.ok(titles.includes('foo/bar'));
  assert.ok(!titles.includes('Cats love cardboard boxes'));
  assert.ok(!titles.includes('baz/qux'));
});

test('filterItems preserves error entries (so they show up in the report)', () => {
  const items = [
    { source: 'arxiv-cs.AI', error: 'HTTP 503' },
    { source: 'hn', title: 'Random news with no keyword', summary: '' },
  ];
  const kept = filterItems(items);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].error, 'HTTP 503');
});

test('groupBySource groups items by source key', () => {
  const items = [
    { source: 'hn', title: 'a' },
    { source: 'gh', title: 'b' },
    { source: 'hn', title: 'c' },
  ];
  const groups = groupBySource(items);
  assert.equal(groups.get('hn').length, 2);
  assert.equal(groups.get('gh').length, 1);
});

test('parseTrending extracts repo + description from a minimal trending block', () => {
  const html = `
    <article class="Box-row">
      <h2 class="lh-condensed"><a href="/acme/llm-agent">acme / llm-agent</a></h2>
      <p class="col-9 color-fg-muted my-1 pr-4">A self-hosted agent runtime using Ollama.</p>
      <span itemprop="programmingLanguage">TypeScript</span>
    </article>
    <article class="Box-row">
      <h2 class="lh-condensed"><a href="/foo/bar">foo / bar</a></h2>
      <p class="col-9 color-fg-muted my-1 pr-4">Some other repo &amp; tooling.</p>
    </article>
  `;
  const items = parseTrending(html);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'acme/llm-agent');
  assert.equal(items[0].url, 'https://github.com/acme/llm-agent');
  assert.match(items[0].summary, /self-hosted agent/);
  assert.equal(items[0].language, 'TypeScript');
  assert.equal(items[1].summary, 'Some other repo & tooling.');
});

test('parseRss extracts title/link/description from a small RSS feed', () => {
  const xml = `<?xml version="1.0"?>
  <rss><channel>
    <item>
      <title>An LLM safety paper</title>
      <link>http://arxiv.org/abs/1234.5678</link>
      <description><![CDATA[<p>This work on RAG and sandboxing.</p>]]></description>
    </item>
    <item>
      <title>Another one</title>
      <link>http://arxiv.org/abs/2345.6789</link>
      <description>Plain &amp; simple.</description>
    </item>
  </channel></rss>`;
  const items = parseRss(xml, 'arxiv-cs.AI');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'An LLM safety paper');
  assert.equal(items[0].url, 'http://arxiv.org/abs/1234.5678');
  assert.match(items[0].summary, /RAG and sandboxing/);
  assert.equal(items[1].summary, 'Plain & simple.');
});
