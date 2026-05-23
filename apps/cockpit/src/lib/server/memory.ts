import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getDbPath } from './env';

// Le fichier memory.md vit à côté de cockpit.db pour partager le même volume
// Docker côté PME. Édité à la main par Jeff (façon Karpathy LLM Wiki) ; un V2
// pourra exposer un endpoint pour que Galaxia y écrive elle-même.
function memoryPath(): string {
	return resolve(dirname(getDbPath()), 'memory.md');
}

let _cache: { content: string; mtime: number } | null = null;

const DEFAULT_TEMPLATE = `# Mémoire persistante — Galaxia

> Ce fichier est injecté dans le system prompt de toutes les conversations.
> Édite-le à la main pour donner à Galaxia ce qu'elle doit savoir sur toi en permanence.

## Profil

- Jeff Choux — créateur de Galaxia, manager non-développeur
- Email : jeffchoux@hotmail.com
- VPS : OpenJeff (Hetzner, 188.34.188.200)

## Préférences de travail

- Réponses directes, sans flagornerie, sans intro inutile
- Français par défaut
- Courtes par défaut, longues si le sujet l'exige
- Markdown OK, emoji seulement si demandé

## Projets en cours

- **Galaxia** — écosystème IA souverain open-source pour PME (priorité absolue)
- **BabyRun / Lina** — agent vocal call center (Twilio + OpenAI Realtime, projet client)

## Notes libres

(édite ici tes notes au fil de l'eau)
`;

function ensureMemoryFile(): string {
	const p = memoryPath();
	if (!existsSync(p)) {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, DEFAULT_TEMPLATE, 'utf-8');
	}
	return p;
}

export function loadMemory(): string {
	const p = ensureMemoryFile();
	try {
		const st = statSync(p);
		if (_cache && _cache.mtime === st.mtimeMs) return _cache.content;
		const content = readFileSync(p, 'utf-8').trim();
		_cache = { content, mtime: st.mtimeMs };
		return content;
	} catch {
		return '';
	}
}
