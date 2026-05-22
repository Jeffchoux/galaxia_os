// Sources blogs IA majeures — RSS / Atom uniquement (pas de scrape HTML).
// Si une source n'expose pas de flux, on l'écrit ici en commentaire pour la
// trouver à la prochaine itération plutôt que de la coder à moitié.
//
//   - Anthropic (anthropic.com/news) : pas de RSS public connu au 2026-05-22.
//   - OpenAI (openai.com/blog) : flux retiré ces dernières années.
//   - Mistral : page news sans RSS standardisé.
//
// Pour rester respectueux, on garde les sources à 1 par feed, timeout serré,
// et on ne fetch pas en parallèle sur le même domaine.

import { parseRss } from './arxiv.js';

const FEEDS = [
  { name: 'huggingface-blog', url: 'https://huggingface.co/blog/feed.xml', max: 20 },
];

export async function fetchBlogs({ fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const results = [];
  for (const feed of FEEDS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(feed.url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`${feed.name} HTTP ${res.status}`);
        const xml = await res.text();
        const items = parseRss(xml, feed.name).slice(0, feed.max ?? 20);
        results.push(...items);
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      results.push({ source: feed.name, error: String(err.message || err) });
    }
  }
  return results;
}
