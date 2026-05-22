const GH_URL = 'https://github.com/trending?since=daily';

export async function fetchGithubTrending({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(GH_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'galaxia-veille/0.1 (+https://galaxia-os.com)',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) throw new Error(`GH HTTP ${res.status}`);
    const html = await res.text();
    return parseTrending(html);
  } finally {
    clearTimeout(t);
  }
}

export function parseTrending(html) {
  const items = [];
  const articleRe = /<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    const block = m[1];
    const hrefMatch = block.match(/<h2[\s\S]*?<a[^>]*href="([^"]+)"/);
    if (!hrefMatch) continue;
    const path = hrefMatch[1].trim();
    const repo = path.replace(/^\//, '');
    const descMatch = block.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch ? cleanText(descMatch[1]) : '';
    const langMatch = block.match(/<span itemprop="programmingLanguage">([^<]+)<\/span>/);
    const language = langMatch ? cleanText(langMatch[1]) : '';
    items.push({
      source: 'github-trending',
      title: repo,
      url: `https://github.com${path}`,
      summary: description,
      language,
    });
  }
  return items;
}

function cleanText(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
