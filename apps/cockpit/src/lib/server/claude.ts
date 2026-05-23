import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { getAnthropicKey, getModel } from './env';
import { loadMemory } from './memory';
import type { Conversation, Document, Message as DbMessage } from './db';

let _client: Anthropic | null = null;
function client(): Anthropic {
	if (!_client) _client = new Anthropic({ apiKey: getAnthropicKey() });
	return _client;
}

const BASE_SYSTEM = `Tu es Galaxia, l'IA du cockpit de Jeff (créateur du projet Galaxia, manager non-développeur).

Galaxia est un écosystème IA souverain, open-source et gratuit pour PME : chaque PME l'installe sur son propre serveur avec ses propres clés API. Tu es le cockpit de la galaxie mère (OpenJeff). Tu parles en français par défaut.

Style : direct, sans flagornerie, sans phrases d'introduction inutiles. Réponses courtes par défaut, longues seulement quand le sujet l'exige. Markdown standard supporté. Pas d'emoji sauf si Jeff en demande.`;

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

export function buildSystemPrompt(conversation: Conversation | null): string {
	const parts = [BASE_SYSTEM];
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

function documentBlock(doc: Document): ContentBlockParam {
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
	const blocks: ContentBlockParam[] = [
		...docs.map(documentBlock),
		{ type: 'text', text: userText }
	];
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
	history: DbMessage[]
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

	const result = await client().messages.create({
		model: 'claude-haiku-4-5-20251001',
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

	const block = result.content[0];
	const summary = block?.type === 'text' ? block.text.trim() : '';
	return { summary, until_idx: toIdx };
}

export async function* streamReply(
	conversation: Conversation | null,
	history: DbMessage[],
	docs: Document[] = []
): AsyncGenerator<string, void, unknown> {
	const stream = client().messages.stream({
		model: getModel(),
		max_tokens: 4096,
		system: buildSystemPrompt(conversation),
		messages: buildMessageParams(conversation, history, docs)
	});

	for await (const event of stream) {
		if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
			yield event.delta.text;
		}
	}
}

export async function generateTitle(firstUserMessage: string): Promise<string> {
	try {
		const result = await client().messages.create({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 40,
			messages: [
				{
					role: 'user',
					content: `Donne un titre court (4-7 mots, français, sans guillemets, sans ponctuation finale) qui résume ce message :\n\n${firstUserMessage.slice(0, 500)}`
				}
			]
		});
		const block = result.content[0];
		if (block?.type === 'text') {
			return block.text.trim().replace(/^["'«»]|["'«».]$/g, '').slice(0, 80);
		}
	} catch {
		// fallback below
	}
	return firstUserMessage.slice(0, 60).replace(/\s+/g, ' ').trim() || 'Nouvelle conversation';
}
