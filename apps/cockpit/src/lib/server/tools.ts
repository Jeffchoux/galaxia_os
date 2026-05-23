import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getAnthropicKey, getDbPath } from './env';
import { listBriefs, readBrief } from './briefs';
import { callMcpTool, listMcpTools, hasMcpTool } from './mcp';

let _haiku: Anthropic | null = null;
function haiku(): Anthropic {
	if (!_haiku) _haiku = new Anthropic({ apiKey: getAnthropicKey() });
	return _haiku;
}

const REORGANIZE_SYSTEM = `Tu reçois le contenu actuel d'un fichier memory.md et une nouvelle note à intégrer. Tu renvoies UNIQUEMENT le nouveau contenu complet du fichier, sans préambule, sans bloc code markdown autour.

Règles :
1. Si la note est déjà couverte (texte identique ou information redondante), retourne le fichier inchangé (économise les écritures inutiles).
2. Si la note précise/complète une ligne existante, remplace cette ligne (ne duplique pas).
3. Sinon, ajoute la note à la section indiquée. Crée la section h2 si elle n'existe pas.
4. Ne réécris pas ce que tu n'as pas besoin de toucher. Préserve la structure h1, l'ordre des sections, le ton et le style.
5. Format : markdown, sections h2 (##), puces ou phrases courtes. Pas de bloc code, pas de méta-commentaire.
6. Limite : ne grossis pas le fichier de plus de 30% en une fois. Si tu détectes du contenu redondant en cumul, tu peux dédoublonner.`;

// Schéma MCP-compatible (Anthropic tools = MCP tools, même format JSON Schema).
export interface GalaxiaTool {
	name: string;
	description: string;
	input_schema: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export const GALAXIA_TOOLS: GalaxiaTool[] = [
	{
		name: 'update_memory',
		description:
			"Ajoute ou met à jour une note dans la mémoire persistante (memory.md). À utiliser PROACTIVEMENT quand Jeff t'apprend quelque chose qu'il faut retenir entre les sessions : préférence de travail, projet en cours, contact, fait personnel, décision actée. Tu peux préciser une section existante ou en créer une nouvelle. Si tu hésites, mieux vaut écrire que rien.",
		input_schema: {
			type: 'object',
			properties: {
				section: {
					type: 'string',
					description:
						"Titre de la section où ajouter (ex: 'Préférences de travail', 'Projets en cours', 'Contacts', 'Notes libres'). Créée si elle n'existe pas."
				},
				note: {
					type: 'string',
					description:
						"Le texte à ajouter, format markdown bref (1-3 lignes, puce ou phrase). Pas de méta-commentaire ('je me souviens que…'), juste le fait."
				}
			},
			required: ['section', 'note']
		}
	},
	{
		name: 'read_brief',
		description:
			"Lit le contenu complet d'un brief quotidien produit par le pipeline digest (analyse des TikToks/X envoyés par Jeff). À utiliser quand Jeff fait référence à un brief, demande un récap d'une date, ou que le contexte de la conversation en a besoin.",
		input_schema: {
			type: 'object',
			properties: {
				date: {
					type: 'string',
					description:
						"Date du brief au format YYYY-MM-DD (ex: '2026-05-23'). Si absent, prend le plus récent."
				}
			}
		}
	},
	{
		name: 'list_briefs',
		description:
			"Liste les briefs disponibles (date + titre). Utile pour savoir quels briefs existent avant de demander read_brief.",
		input_schema: {
			type: 'object',
			properties: {
				limit: {
					type: 'number',
					description: 'Nombre maximum de briefs à retourner (défaut 10).'
				}
			}
		}
	}
];

function memoryPath(): string {
	return resolve(dirname(getDbPath()), 'memory.md');
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fallbackAppend(initial: string, safeSection: string, safeNote: string): string {
	const sectionHeader = `## ${safeSection}`;
	const sectionRegex = new RegExp(`^${escapeRegex(sectionHeader)}\\s*$`, 'm');
	if (sectionRegex.test(initial)) {
		return initial.replace(
			new RegExp(`(^${escapeRegex(sectionHeader)}\\s*$[\\s\\S]*?)(?=^##\\s|\\Z)`, 'm'),
			(block) => block.trimEnd() + `\n\n${safeNote}\n`
		);
	}
	return initial.trimEnd() + `\n\n${sectionHeader}\n\n${safeNote}\n`;
}

async function doUpdateMemory(section: string, note: string): Promise<string> {
	const path = memoryPath();
	const safeSection = section.trim() || 'Notes libres';
	const safeNote = note.trim();
	if (!safeNote) return 'Note vide, rien écrit.';

	const initial = existsSync(path)
		? readFileSync(path, 'utf-8')
		: '# Mémoire persistante — Galaxia\n';

	let next = initial;
	let viaHaiku = false;

	// Tentative Haiku : réorganisation intelligente (dédoublonnage, fusion,
	// remplacement). Échec → fallback append simple.
	try {
		const result = await haiku().messages.create({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 4000,
			system: REORGANIZE_SYSTEM,
			messages: [
				{
					role: 'user',
					content: `Section visée : ${safeSection}\n\nNote à intégrer :\n${safeNote}\n\n---\n\nContenu actuel de memory.md :\n\n${initial}`
				}
			]
		});
		const block = result.content[0];
		if (block?.type === 'text') {
			const text = block.text.trim();
			// Garde-fous : doit ressembler à un memory.md (h1 présent, taille
			// raisonnable). Sinon on garde l'initial puis fallback append.
			if (text.startsWith('# ') && text.length < initial.length * 2 + 1000) {
				next = text.endsWith('\n') ? text : text + '\n';
				viaHaiku = true;
			}
		}
	} catch {
		// silencieux : on tombe en fallback
	}

	if (!viaHaiku) {
		next = fallbackAppend(initial, safeSection, safeNote);
	}

	// Court-circuit : si Haiku a décidé que rien ne change, ne re-write pas
	// (préserve mtime pour le cache de loadMemory()).
	if (next.trim() === initial.trim()) {
		return 'Mémoire inchangée (Haiku a estimé que la note était déjà couverte).';
	}

	writeFileSync(path, next, 'utf-8');
	return viaHaiku
		? `Mémoire mise à jour intelligemment (Haiku, section « ${safeSection} »).`
		: `Mémoire mise à jour (append simple, section « ${safeSection} »).`;
}

function doReadBrief(date?: string): string {
	const all = listBriefs();
	if (all.length === 0) return 'Aucun brief disponible pour le moment.';
	let target = date ? all.find((b) => b.date === date || b.filename === date) : all[0];
	if (!target && date) {
		return `Aucun brief pour ${date}. Dates dispos : ${all.slice(0, 10).map((b) => b.date).join(', ')}.`;
	}
	if (!target) target = all[0];
	const full = readBrief(target.filename);
	return full?.content ?? `Brief ${target.filename} introuvable.`;
}

function doListBriefs(limit?: number): string {
	const n = typeof limit === 'number' ? Math.max(1, Math.min(50, Math.floor(limit))) : 10;
	const all = listBriefs().slice(0, n);
	if (all.length === 0) return 'Aucun brief disponible.';
	return all.map((b) => `- ${b.date} — ${b.title}${b.is_fallback ? ' [fallback]' : ''}`).join('\n');
}

const NATIVE_NAMES = new Set(['update_memory', 'read_brief', 'list_briefs']);

export async function executeTool(
	name: string,
	input: Record<string, unknown>
): Promise<{ result: string; is_error?: boolean }> {
	try {
		if (name === 'update_memory') {
			return {
				result: await doUpdateMemory(
					String(input.section ?? ''),
					String(input.note ?? '')
				)
			};
		}
		if (name === 'read_brief') {
			const date = input.date ? String(input.date) : undefined;
			return { result: doReadBrief(date) };
		}
		if (name === 'list_briefs') {
			const lim = typeof input.limit === 'number' ? input.limit : undefined;
			return { result: doListBriefs(lim) };
		}
		// Pas un tool natif : on délègue à MCP si un serveur l'expose.
		if (!NATIVE_NAMES.has(name) && (await hasMcpTool(name))) {
			return await callMcpTool(name, input);
		}
		return { result: `Tool inconnu : ${name}`, is_error: true };
	} catch (e) {
		return { result: e instanceof Error ? e.message : String(e), is_error: true };
	}
}

// Liste fusionnée native + MCP. Async parce que la découverte MCP fait du I/O.
export async function loadAllTools(): Promise<GalaxiaTool[]> {
	const mcp = await listMcpTools();
	return [...GALAXIA_TOOLS, ...mcp];
}
