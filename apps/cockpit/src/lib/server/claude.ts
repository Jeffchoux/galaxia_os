import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicKey, getModel } from './env';
import type { Message as DbMessage } from './db';

let _client: Anthropic | null = null;
function client(): Anthropic {
	if (!_client) _client = new Anthropic({ apiKey: getAnthropicKey() });
	return _client;
}

const SYSTEM_PROMPT = `Tu es Galaxia, l'IA du cockpit de Jeff (créateur du projet Galaxia, manager non-développeur).

Galaxia est un écosystème IA souverain, open-source et gratuit pour PME : chaque PME l'installe sur son propre serveur avec ses propres clés API. Tu es le cockpit de la galaxie mère (OpenJeff). Tu parles en français par défaut.

Style : direct, sans flagornerie, sans phrases d'introduction inutiles. Réponses courtes par défaut, longues seulement quand le sujet l'exige. Markdown standard supporté. Pas d'emoji sauf si Jeff en demande.`;

export interface ChatTurn {
	role: 'user' | 'assistant';
	content: string;
}

export function toClaudeMessages(history: DbMessage[]): ChatTurn[] {
	return history.map((m) => ({ role: m.role, content: m.content }));
}

export async function* streamReply(
	messages: ChatTurn[]
): AsyncGenerator<string, void, unknown> {
	const stream = client().messages.stream({
		model: getModel(),
		max_tokens: 4096,
		system: SYSTEM_PROMPT,
		messages
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
