export const DEFAULT_KEYWORDS = [
  'llm', 'agent', 'agentic', 'ollama', 'openclaw', 'nemoclaw', 'rag', 'mcp',
  'sécurité ia', 'security ai', 'ai security', 'souveraineté', 'sovereign',
  'on-premise', 'on premise', 'self-host', 'sandbox', 'guardrail',
  'small language model', 'slm', 'fine-tun', 'quantization', 'inference',
];

// Items dont le titre OU le résumé contient l'un de ces motifs sont exclus,
// quelle que soit leur pertinence par mot-clé. But : éviter le bruit des
// papiers arXiv purement théoriques et des contenus AWS/SaaS-only qui ne
// correspondent à aucun touchpoint code dans Galaxia.
export const DEFAULT_EXCLUDE_KEYWORDS = [
  // Contenus cloud / SaaS propriétaires sans équivalent on-premise
  'amazon web services', 'aws sagemaker', 'google cloud', 'azure machine learning',
  // Maths / physique purement théoriques (typiquement arXiv cs.LG hors sujet)
  'diffusion model', 'hopfield', 'federated reinforcement learning',
  'symmetric attention', 'gradient transformer',
  // Benchmark / évaluation académique sans touchpoint produit
  'dynaschedbench', 'causal discovery', 'graph anomaly detection',
];

export function filterItems(
  items,
  { keywords = DEFAULT_KEYWORDS, excludeKeywords = DEFAULT_EXCLUDE_KEYWORDS, minScore = 1 } = {},
) {
  const kws = keywords.map((k) => k.toLowerCase());
  const excl = excludeKeywords.map((k) => k.toLowerCase());
  return items
    .map((it) => {
      if (it.error) return { ...it, _matched: [], _score: 0 };
      const hay = `${it.title ?? ''} ${it.summary ?? ''}`.toLowerCase();
      if (excl.some((k) => hay.includes(k))) return { ...it, _matched: [], _score: -1 };
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
