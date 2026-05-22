const FEEDS = [
  { name: 'arxiv-cs.AI', url: 'http://export.arxiv.org/rss/cs.AI' },
  { name: 'arxiv-cs.LG', url: 'http://export.arxiv.org/rss/cs.LG' },
];

export async function fetchArxiv({ fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const results = [];
  for (const feed of FEEDS) {
    try {
      const items = await fetchOne(feed, { fetchImpl, timeoutMs });
      results.push(...items);
    } catch (err) {
      results.push({ source: feed.name, error: String(err.message || err) });
    }
  }
  return results;
}

async function fetchOne(feed, { fetchImpl, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feed.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${feed.name} HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml, feed.name);
  } finally {
    clearTimeout(t);
  }
}

export function parseRss(xml, sourceName) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = pickTag(block, 'title');
    const link = pickTag(block, 'link');
    const desc = pickTag(block, 'description');
    if (!title) continue;
    items.push({
      source: sourceName,
      title: cleanText(title),
      url: link,
      summary: stripTags(desc).slice(0, 500),
    });
  }
  return items;
}

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decode(stripCdata(m[1])).trim() : '';
}

function stripCdata(s) {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

function stripTags(s) {
  return cleanText(String(s).replace(/<[^>]+>/g, ' '));
}

function cleanText(s) {
  return decode(String(s)).replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
