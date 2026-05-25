export const DEFAULT_KEYWORDS = [
  'llm', 'agent', 'agentic', 'ollama', 'openclaw', 'nemoclaw', 'rag', 'mcp',
  'sécurité ia', 'security ai', 'ai security', 'souveraineté', 'sovereign',
  'on-premise', 'on premise', 'self-host', 'sandbox', 'guardrail',
  'small language model', 'slm', 'fine-tun', 'quantization', 'inference',
  'deepseek',
];

export function filterItems(items, { keywords = DEFAULT_KEYWORDS, minScore = 1 } = {}) {
  const kws = keywords.map((k) => k.toLowerCase());
  return items
    .map((it) => {
      if (it.error) return { ...it, _matched: [], _score: 0 };
      const hay = `${it.title ?? ''} ${it.summary ?? ''}`.toLowerCase();
      const matched = kws.filter((k) => hay.includes(k));
      return { ...it, _matched: matched, _score: matched.length };
    })
    .filter((it) => it.error || it._score >= minScore);
}

export function groupBySource(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.source || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return groups;
}
