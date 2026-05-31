const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
// Défaut bumpé llama3.1:8b -> qwen3:8b (audit DG 2026-05-31, veille état-de-l'art :
// meilleur code/tool-use à empreinte RAM ~égale, Apache 2.0). Modèle pull sur la
// mère le 2026-05-31. Surchargeable par OLLAMA_MODEL. Dégradation gracieuse : si le
// modèle manque sur une fille, Ollama renvoie une erreur et l'item garde son fallback.
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';

// CPU inference (~2 tok/s). 40 tokens ≈ 20 s. We cap with
// `stop` sequences too — the model often keeps rambling past the period.
export async function synthesizeItem(item, { fetchImpl = fetch, timeoutMs = 120_000, numPredict = 50 } = {}) {
  const prompt = buildPrompt(item);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OLLAMA_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: numPredict,
          // \n\n catches the moment the model starts a new paragraph (bullet
          // list, second sentence). A bare \n stops too early when the model
          // emits a leading newline. Avoid stops that can legitimately appear
          // in a French sentence ("Exemple", etc.).
          stop: ['\n\n', '\n* ', '\n- ', '\n**', '\nTitre :', '\nDescription :', '\nLien :'],
        },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return cleanTldr(data.response || '');
  } finally {
    clearTimeout(t);
  }
}

function buildPrompt(item) {
  // Few-shot pour casser deux travers récurrents de llama3.1:8b sur ce job :
  // (1) inventer une définition de RAG ("Reconnaissance Automatique de Gestion"…),
  // (2) ignorer la consigne de longueur et partir en bullet list.
  return [
    'Tu es l\'agent de veille de Galaxia (IA souveraine pour PME française).',
    'Produis UNE seule phrase FR de 20 mots max, factuelle, sans bullet, sans markdown, sans définir d\'acronyme.',
    'Si pertinent, mentionne : on-premise, agents, RAG (génération augmentée), Ollama, sécurité, MCP.',
    '',
    'Exemple 1 :',
    'Titre : SnapState – Persistent state for AI agent workflows',
    'Description : Adds checkpoint/resume for long-running agents.',
    'TLDR : Outil OSS qui ajoute checkpoint/reprise aux agents IA longue durée — utile pour fiabiliser un agent PME on-premise.',
    '',
    'Exemple 2 :',
    'Titre : Antigravity 2.0 tops the OpenSCAD 3D LLM benchmark',
    'Description : New benchmark comparing LLMs on 3D modeling tasks.',
    'TLDR : Nouveau benchmark LLM sur modélisation 3D OpenSCAD ; peu de retombée directe pour une PME hors bureau d\'études.',
    '',
    'Maintenant :',
    `Titre : ${item.title}`,
    item.summary ? `Description : ${item.summary.slice(0, 400)}` : '',
    'TLDR :',
  ].filter(Boolean).join('\n');
}

function cleanTldr(text) {
  return String(text)
    .replace(/^\s*tldr\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function renderReport(groups, { date, fetchImpl = fetch, synth = synthesizeItem, maxPerSource = 8 } = {}) {
  const lines = [];
  lines.push(`# Veille Galaxia — ${date}`);
  lines.push('');
  lines.push('> Synthèse quotidienne via Ollama local. Mots-clés filtrés pour pertinence PME / IA souveraine.');
  lines.push('');

  const order = ['hackernews', 'github-trending', 'huggingface-blog', 'arxiv-cs.AI', 'arxiv-cs.LG'];
  const sourceKeys = [...new Set([...order, ...groups.keys()])].filter((k) => groups.has(k));

  for (const key of sourceKeys) {
    lines.push(`## ${humanSource(key)}`);
    lines.push('');
    const items = groups.get(key) ?? [];
    const errors = items.filter((i) => i.error);
    const ok = items.filter((i) => !i.error).slice(0, maxPerSource);

    for (const e of errors) {
      lines.push(`- _Erreur de récupération_ : \`${e.error}\``);
    }
    if (ok.length === 0 && errors.length === 0) {
      lines.push('_Aucun item pertinent aujourd\'hui._');
      lines.push('');
      continue;
    }

    for (const item of ok) {
      // Fallback en cascade : synth Ollama → summary tronqué → titre seul.
      // Évite les lignes vides quand l'item n'a ni summary ni LLM disponible.
      const summaryFallback = item.summary?.slice(0, 200) || '';
      let tldr = summaryFallback || item.title;
      try {
        const t = await synth(item, { fetchImpl });
        if (t && t.length > 5) tldr = t;
      } catch (err) {
        tldr = `(synth indisponible : ${err.message || err}) ${summaryFallback || item.title}`.trim();
      }
      lines.push(`- **[${item.title}](${item.url})**`);
      lines.push(`  ${tldr}`);
      if (item._matched?.length) {
        lines.push(`  _matches:_ ${item._matched.join(', ')}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`_Généré automatiquement par \`agents/veille\` le ${date}._`);
  return lines.join('\n');
}

function humanSource(key) {
  const map = {
    'hackernews': 'HackerNews — front page',
    'github-trending': 'GitHub Trending — daily',
    'huggingface-blog': 'Hugging Face — blog',
    'arxiv-cs.AI': 'arXiv — cs.AI',
    'arxiv-cs.LG': 'arXiv — cs.LG',
  };
  return map[key] || key;
}
