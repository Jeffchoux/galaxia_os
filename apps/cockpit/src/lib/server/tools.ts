import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getDbPath } from './env';
import { listBriefs, readBrief } from './briefs';

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

function doUpdateMemory(section: string, note: string): string {
	const path = memoryPath();
	const safeSection = section.trim() || 'Notes libres';
	const safeNote = note.trim();
	if (!safeNote) return 'Note vide, rien écrit.';

	const initial = existsSync(path) ? readFileSync(path, 'utf-8') : '# Mémoire persistante — Galaxia\n';
	const sectionHeader = `## ${safeSection}`;
	const sectionRegex = new RegExp(`^${escapeRegex(sectionHeader)}\\s*$`, 'm');

	let next: string;
	if (sectionRegex.test(initial)) {
		// Insère la note à la fin de la section (avant la prochaine section h2 ou EOF)
		next = initial.replace(
			new RegExp(
				`(^${escapeRegex(sectionHeader)}\\s*$[\\s\\S]*?)(?=^##\\s|\\Z)`,
				'm'
			),
			(block) => block.trimEnd() + `\n\n${safeNote}\n`
		);
	} else {
		next = initial.trimEnd() + `\n\n${sectionHeader}\n\n${safeNote}\n`;
	}

	writeFileSync(path, next, 'utf-8');
	return `Mémoire mise à jour, section « ${safeSection} ».`;
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

export async function executeTool(
	name: string,
	input: Record<string, unknown>
): Promise<{ result: string; is_error?: boolean }> {
	try {
		if (name === 'update_memory') {
			return {
				result: doUpdateMemory(String(input.section ?? ''), String(input.note ?? ''))
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
		return { result: `Tool inconnu : ${name}`, is_error: true };
	} catch (e) {
		return { result: e instanceof Error ? e.message : String(e), is_error: true };
	}
}
