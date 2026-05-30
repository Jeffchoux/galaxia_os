import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { getAnthropicKey, getModel } from './env';
import { loadMemory } from './memory';
import { recordUsage, type Conversation, type Document, type Message as DbMessage } from './db';
import { computeCostMicros, type TokenUsage } from './pricing';
import { executeTool, loadAllTools, loadFreeModeTools } from './tools';
import { streamGroqReply } from './groq';

// Persiste un appel Anthropic dans la table `usage` pour le cost tracking.
// Best-effort : on log et avale les erreurs (l'enregistrement ne doit JAMAIS
// faire échouer le flow utilisateur). user_id null = appel anonyme (cas qui
// ne devrait pas arriver en prod mais possible si tracking depuis un script).
function track(
	model: string,
	usage: TokenUsage,
	user_id: string | null,
	conversation_id: string | null
): void {
	try {
		recordUsage({
			user_id,
			conversation_id,
			model,
			input_tokens: usage.input_tokens,
			output_tokens: usage.output_tokens,
			cost_micros: computeCostMicros(model, usage)
		});
	} catch (e) {
		console.error('[usage] tracking failed', e);
	}
}

let _client: Anthropic | null = null;
function client(): Anthropic {
	if (!_client) _client = new Anthropic({ apiKey: getAnthropicKey() });
	return _client;
}

// Tronc commun aux deux modes (pro = Opus 4.8 + outils ; free = Groq, chat nu).
const BASE_SYSTEM_CORE = `Tu es Galaxia, l'IA du cockpit de Jeff (créateur du projet Galaxia, manager non-développeur).

Galaxia est un écosystème IA souverain, open-source et gratuit pour PME : chaque PME l'installe sur son propre serveur avec ses propres clés API. Tu es le cockpit de la galaxie mère (OpenJeff). Tu parles en français par défaut.

Style : direct, sans flagornerie, sans phrases d'introduction inutiles. Réponses courtes par défaut, longues seulement quand le sujet l'exige. Markdown standard supporté. Pas d'emoji sauf si Jeff en demande.`;

// N'est ajouté qu'en mode "pro" : en mode gratuit (Groq) il n'y a aucun outil, donc
// on ne doit pas promettre à Galaxia des capacités qu'elle n'a pas.
const TOOLS_SECTION = `Tu disposes de tools (function calling) :
- update_memory : utilise-le PROACTIVEMENT dès que Jeff t'apprend quelque chose qu'il faudrait retenir entre sessions (préférence, projet, contact, décision). Ne lui demande pas la permission, écris simplement la note et continue. Reste sobre — note ce qui est durable, pas chaque détail conversationnel.
- read_brief / list_briefs : pour récupérer un brief du pipeline digest si Jeff y fait référence ou si c'est utile au contexte.
- Filesystem (via MCP) : tu peux lire et explorer les fichiers de /home/galaxia/galaxia-project (le repo Galaxia), /home/galaxia/.claude/galaxia/briefs et /home/galaxia/.claude/galaxia/knowledge. Sers-t'en quand Jeff te demande d'aller voir un fichier, d'expliquer une partie du code, ou de chercher quelque chose dans le projet.

Tu n'as pas besoin d'annoncer chaque tool call ; agis et continue.`;

// Mode "rapide" / gratuit : depuis 2026-05-30 (choix Jeff) il a des outils EN LECTURE
// (filesystem read-only sur le repo + briefs + mémoire). On le lui annonce, et on
// précise qu'il ne peut PAS écrire dans le repo (coder = mode Opus).
const FREE_MODE_NOTE = `Tu tournes en mode "rapide" (modèle léger et gratuit), mais tu disposes d'outils EN LECTURE :
- update_memory : note PROACTIVEMENT ce qu'il faut retenir entre sessions (préférence, projet, contact, décision). N'attends pas la permission, écris la note et continue.
- read_brief / list_briefs : pour récupérer un brief du pipeline digest si Jeff y fait référence ou si c'est utile.
- Filesystem (via MCP, LECTURE SEULE) : tu peux lire et explorer les fichiers de /home/galaxia/galaxia-project (le repo Galaxia), des briefs et de la knowledge base. Sers-t'en dès que Jeff te demande d'aller voir un fichier, d'expliquer une partie du projet, ou de chercher quelque chose dans le code.

Tu ne peux PAS modifier de fichiers du repo en mode rapide (lecture seule). Si Jeff veut éditer, coder, ou une tâche lourde, dis-lui en une phrase de basculer en mode Opus (bouton modèle dans la barre de saisie). N'annonce pas chaque tool call ; agis et continue.`;

export type ChatMode = 'pro' | 'free';

export interface ChatTurn {
	role: 'user' | 'assistant';
	content: string;
}

// Combien de messages récents on garde toujours non-résumés.
const KEEP_RECENT = 8;
// Au-delà de ce seuil de messages dans la conversation, on déclenche le résumé.
const SUMMARIZE_THRESHOLD = 20;
// Au-delà de ce seuil de tokens d'historique, idem (heuristique : ~4 chars/token).
const SUMMARIZE_CHAR_THRESHOLD = 32_000;

// Sans cette injection, Claude répond à "quelle est la date ?" avec sa date
// d'entraînement (hallucination courante). On calcule à chaque appel pour rester
// juste même après plusieurs jours de cache de prompt.
function buildDateLine(now: Date = new Date()): string {
	const date = now.toLocaleDateString('fr-FR', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'Europe/Paris'
	});
	const time = now.toLocaleTimeString('fr-FR', {
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'Europe/Paris'
	});
	return `Date et heure actuelles côté serveur (Europe/Paris) : ${date}, ${time}. Réfère-toi à cette date plutôt qu'à ta date d'entraînement quand Jeff te demande "on est quel jour" ou raisonne sur des échéances.`;
}

export function buildSystemPrompt(
	conversation: Conversation | null,
	mode: ChatMode = 'pro'
): string {
	const base =
		mode === 'pro' ? `${BASE_SYSTEM_CORE}\n\n${TOOLS_SECTION}` : `${BASE_SYSTEM_CORE}\n\n${FREE_MODE_NOTE}`;
	const parts = [base, buildDateLine()];
	// La mémoire persistante est servie dans les deux modes : depuis 2026-05-30 le
	// mode gratuit a aussi update_memory + accès lecture, donc il doit voir l'existant.
	const memory = loadMemory();
	if (memory) {
		parts.push(`---\n\nMémoire persistante (édite via le fichier memory.md sur le serveur) :\n\n${memory}`);
	}
	if (conversation?.summary) {
		parts.push(`---\n\nRésumé de la partie ancienne de cette conversation (les messages plus récents suivent en clair) :\n\n${conversation.summary}`);
	}
	return parts.join('\n\n');
}

export function buildClaudeMessages(
	conversation: Conversation | null,
	history: DbMessage[]
): ChatTurn[] {
	const fromIdx = conversation?.summary_until_idx ?? 0;
	const slice = fromIdx > 0 ? history.slice(fromIdx) : history;
	return slice.map((m) => ({ role: m.role, content: m.content }));
}

const IMAGE_MIMES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif'
]);

function documentBlock(doc: Document): ContentBlockParam {
	if (doc.content_b64 && IMAGE_MIMES.has(doc.mime_type)) {
		// Bloc vision Claude. Pas de `title` sur les images (le SDK ne le supporte
		// pas), donc on rajoute juste le filename dans le texte qui suit en aval
		// si nécessaire — pour l'instant Claude voit l'image seule.
		return {
			type: 'image',
			source: {
				type: 'base64',
				media_type: doc.mime_type as
					| 'image/jpeg'
					| 'image/png'
					| 'image/webp'
					| 'image/gif',
				data: doc.content_b64
			},
			cache_control: { type: 'ephemeral' }
		} as ContentBlockParam;
	}
	if (doc.content_b64 && doc.mime_type === 'application/pdf') {
		return {
			type: 'document',
			source: {
				type: 'base64',
				media_type: 'application/pdf',
				data: doc.content_b64
			},
			title: doc.filename,
			cache_control: { type: 'ephemeral' }
		} as ContentBlockParam;
	}
	const text = doc.content_text ?? '';
	return {
		type: 'document',
		source: {
			type: 'text',
			media_type: 'text/plain',
			data: text
		},
		title: doc.filename,
		cache_control: { type: 'ephemeral' }
	} as ContentBlockParam;
}

// Construit les MessageParam pour l'API Claude, en injectant les documents
// attachés à la conversation dans le DERNIER user message (ils suivent ainsi
// la conv via le cache de prompt + l'historique).
export function buildMessageParams(
	conversation: Conversation | null,
	history: DbMessage[],
	docs: Document[]
): MessageParam[] {
	const turns = buildClaudeMessages(conversation, history);
	const params: MessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));
	if (docs.length === 0 || params.length === 0) return params;

	const lastIdx = params.length - 1;
	const last = params[lastIdx];
	if (last.role !== 'user') return params;

	const userText = typeof last.content === 'string' ? last.content : '';
	const blocks: ContentBlockParam[] = [];
	for (const doc of docs) {
		// Pour les images, on précède le bloc image d'un label texte (le bloc image
		// SDK n'accepte pas de `title`) — Claude voit ainsi le filename associé.
		if (IMAGE_MIMES.has(doc.mime_type)) {
			blocks.push({ type: 'text', text: `[Image jointe : ${doc.filename}]` });
		}
		blocks.push(documentBlock(doc));
	}
	blocks.push({ type: 'text', text: userText });
	params[lastIdx] = { role: 'user', content: blocks };
	return params;
}

export function shouldSummarize(
	conversation: Conversation | null,
	history: DbMessage[]
): boolean {
	if (!conversation) return false;
	const unsummarized = history.length - (conversation.summary_until_idx ?? 0);
	if (unsummarized < KEEP_RECENT + 4) return false;
	if (history.length < SUMMARIZE_THRESHOLD) {
		// Test secondaire : taille caractères des unsummarized
		const chars = history.slice(conversation.summary_until_idx ?? 0)
			.reduce((acc, m) => acc + m.content.length, 0);
		if (chars < SUMMARIZE_CHAR_THRESHOLD) return false;
	}
	return true;
}

export async function summarizeHistory(
	conversation: Conversation,
	history: DbMessage[],
	userId: string | null = null
): Promise<{ summary: string; until_idx: number }> {
	const fromIdx = conversation.summary_until_idx ?? 0;
	const toIdx = history.length - KEEP_RECENT; // on garde KEEP_RECENT récents
	if (toIdx <= fromIdx) return { summary: conversation.summary ?? '', until_idx: fromIdx };

	const toSummarize = history.slice(fromIdx, toIdx);
	const previousSummary = conversation.summary
		? `Résumé précédent à intégrer :\n\n${conversation.summary}\n\n---\n\n`
		: '';

	const transcript = toSummarize
		.map((m) => `${m.role === 'user' ? 'Jeff' : 'Galaxia'} : ${m.content}`)
		.join('\n\n');

	const summaryModel = 'claude-haiku-4-5-20251001';
	const result = await client().messages.create({
		model: summaryModel,
		max_tokens: 1500,
		system:
			'Tu résumes des échanges entre Jeff et Galaxia pour préserver le contexte sans dépasser le budget tokens. Garde : (1) les faits décidés/actés, (2) les préférences exprimées, (3) les chantiers ouverts et leur état. Style : puces, dense, factuel, français. Pas de meta-commentaire.',
		messages: [
			{
				role: 'user',
				content: `${previousSummary}Échanges à condenser (du plus ancien au plus récent) :\n\n${transcript}`
			}
		]
	});

	track(summaryModel, result.usage, userId, conversation.id);

	const block = result.content[0];
	const summary = block?.type === 'text' ? block.text.trim() : '';
	return { summary, until_idx: toIdx };
}

export type StreamEvent =
	| { kind: 'delta'; text: string }
	| { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { kind: 'tool_result'; id: string; name: string; result: string; is_error?: boolean };

const MAX_TOOL_ROUNDS = 6;

export async function* streamReply(
	conversation: Conversation | null,
	history: DbMessage[],
	docs: Document[] = [],
	userId: string | null = null,
	mode: ChatMode = 'pro'
): AsyncGenerator<StreamEvent, void, unknown> {
	const convId = conversation?.id ?? null;
	const system = buildSystemPrompt(conversation, mode);

	// Mode "rapide" / gratuit : Groq + outils EN LECTURE (filesystem read-only, briefs,
	// mémoire). Pas de documents/vision (le chat free ignore les pièces jointes). On
	// délègue au générateur Groq, qui déroule sa propre boucle tool_use → tool_result.
	if (mode === 'free') {
		const turns = buildClaudeMessages(conversation, history);
		const freeTools = await loadFreeModeTools();
		yield* streamGroqReply(system, turns, userId, convId, freeTools);
		return;
	}

	const messages = buildMessageParams(conversation, history, docs);
	const allTools = await loadAllTools();
	const model = getModel();

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const stream = client().messages.stream({
			model,
			max_tokens: 4096,
			system,
			messages,
			// allTools = natifs Galaxia + tous les MCP servers connectés. Schema
			// JSON commun, donc cast safe.
			tools: allTools as unknown as Anthropic.Tool[]
		});

		let currentText = '';
		const collected: ContentBlockParam[] = [];
		const pendingTool: { id?: string; name?: string; partial: string } = { partial: '' };

		for await (const event of stream) {
			if (event.type === 'content_block_start') {
				const cb = event.content_block;
				if (cb.type === 'text') {
					currentText = '';
				} else if (cb.type === 'tool_use') {
					pendingTool.id = cb.id;
					pendingTool.name = cb.name;
					pendingTool.partial = '';
				}
			} else if (event.type === 'content_block_delta') {
				if (event.delta.type === 'text_delta') {
					yield { kind: 'delta', text: event.delta.text };
					currentText += event.delta.text;
				} else if (event.delta.type === 'input_json_delta') {
					pendingTool.partial += event.delta.partial_json;
				}
			} else if (event.type === 'content_block_stop') {
				if (pendingTool.id && pendingTool.name) {
					let input: Record<string, unknown> = {};
					try {
						input = pendingTool.partial ? JSON.parse(pendingTool.partial) : {};
					} catch {
						input = {};
					}
					collected.push({
						type: 'tool_use',
						id: pendingTool.id,
						name: pendingTool.name,
						input
					} as ContentBlockParam);
					yield { kind: 'tool_use', id: pendingTool.id, name: pendingTool.name, input };
					pendingTool.id = undefined;
					pendingTool.name = undefined;
					pendingTool.partial = '';
				} else if (currentText) {
					collected.push({ type: 'text', text: currentText });
					currentText = '';
				}
			}
		}

		const finalMsg = await stream.finalMessage();
		// Tracking par round : chaque appel Anthropic est une ligne distincte
		// dans `usage`. Permet de voir le coût détaillé des conversations
		// multi-rounds (chaque round de tool use est facturé séparément).
		track(model, finalMsg.usage, userId, convId);
		if (finalMsg.stop_reason !== 'tool_use') return;

		// Execute tool calls et reboucle
		messages.push({ role: 'assistant', content: collected });
		const toolResults: ContentBlockParam[] = [];
		for (const block of collected) {
			if (block.type !== 'tool_use') continue;
			const r = await executeTool(block.name, block.input as Record<string, unknown>);
			yield {
				kind: 'tool_result',
				id: block.id,
				name: block.name,
				result: r.result,
				is_error: r.is_error
			};
			toolResults.push({
				type: 'tool_result',
				tool_use_id: block.id,
				content: r.result,
				is_error: r.is_error
			} as ContentBlockParam);
		}
		messages.push({ role: 'user', content: toolResults });
	}
}

export async function generateTitle(
	firstUserMessage: string,
	userId: string | null = null,
	conversationId: string | null = null
): Promise<string> {
	const titleModel = 'claude-haiku-4-5-20251001';
	try {
		const result = await client().messages.create({
			model: titleModel,
			max_tokens: 40,
			messages: [
				{
					role: 'user',
					content: `Donne un titre court (4-7 mots, français, sans guillemets, sans ponctuation finale) qui résume ce message :\n\n${firstUserMessage.slice(0, 500)}`
				}
			]
		});
		track(titleModel, result.usage, userId, conversationId);
		const block = result.content[0];
		if (block?.type === 'text') {
			return block.text.trim().replace(/^["'«»]|["'«».]$/g, '').slice(0, 80);
		}
	} catch {
		// fallback below
	}
	return firstUserMessage.slice(0, 60).replace(/\s+/g, ' ').trim() || 'Nouvelle conversation';
}
