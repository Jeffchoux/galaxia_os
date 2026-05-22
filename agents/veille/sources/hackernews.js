const HN_URL = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50';

export async function fetchHackerNews({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(HN_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HN HTTP ${res.status}`);
    const data = await res.json();
    return (data.hits ?? []).map(normalize).filter(Boolean);
  } finally {
    clearTimeout(t);
  }
}

function normalize(hit) {
  const url = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
  const title = hit.title || hit.story_title;
  if (!title) return null;
  return {
    source: 'hackernews',
    title,
    url,
    summary: hit.story_text ? stripHtml(hit.story_text).slice(0, 400) : '',
    score: hit.points ?? 0,
    publishedAt: hit.created_at ?? null,
  };
}

function stripHtml(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Algolia returns HN comments with numeric entities (`&#x27;`, `&amp;`…).
// Decode the common subset; the LLM trips on them otherwise.
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n] ?? m);
}
