// Mode "rapide" / gratuit du cockpit (choix Jeff 2026-05-29) : Groq, API compatible
// OpenAI. Depuis 2026-05-30, ce mode dispose d'outils EN LECTURE (choix Jeff) :
// filesystem MCP read-only sur le repo Galaxia + briefs + mémoire persistante. Le
// modèle Groq (llama-3.3-70b) supporte le function calling OpenAI ; on lui passe la
// liste d'outils lecture (cf. loadFreeModeTools) et on déroule la même boucle
// tool_use → tool_result que le mode pro. Le mode "pro" (Opus 4.8 + tous les outils,
// écriture comprise) reste dans claude.ts.
//
// On parle à Groq en HTTP direct (fetch) plutôt qu'en ajoutant le SDK openai :
// le contrat /chat/completions en streaming SSE est stable et ça évite une dépendance.
import { getGroqBaseUrl, getGroqKey, getGroqModel } from './env';
import { recordUsage } from './db';
import { computeCostMicros } from './pricing';
import { executeTool } from './tools';
import type { GalaxiaTool } from './tools';
import type { ChatTurn, StreamEvent } from './claude';

// Au-delà de ce nombre de rounds d'outils, on arrête (garde-fou anti-boucle, comme
// le mode pro). Un round = un appel Groq qui finit en tool_calls.
const MAX_TOOL_ROUNDS = 6;

// Format de message OpenAI/Groq (system | user | assistant | tool). `tool_calls`
// et `tool_call_id` ne sont présents que sur les tours d'outils.
interface OAMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

interface OAStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

// Accumulateur d'un appel tool_call streamé : id + name arrivent dans le 1er delta,
// arguments (JSON) arrivent en morceaux sur les deltas suivants.
interface AccTool {
	index: number;
	id: string;
	name: string;
	arguments: string;
}

interface RoundState {
	toolCalls: Map<number, AccTool>;
	usage: { prompt_tokens?: number; completion_tokens?: number } | null;
	finishReason: string | null;
	assistantText: string;
}

// Convertit nos outils (format Anthropic / MCP : input_schema) vers le format
// function-calling d'OpenAI/Groq (parameters).
function toOpenAITools(tools: GalaxiaTool[]) {
	return tools.map((t) => ({
		type: 'function' as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.input_schema
		}
	}));
}

// Déroule UN appel Groq en streaming. Yield les deltas texte ; accumule les
// tool_calls / usage / finish_reason dans `state` (un générateur ne peut pas à la
// fois yield et retourner une valeur riche, d'où l'accumulateur passé en argument).
async function* streamRound(
	key: string,
	model: string,
	messages: OAMessage[],
	oaTools: ReturnType<typeof toOpenAITools>,
	state: RoundState
): AsyncGenerator<StreamEvent, void, unknown> {
	const body: Record<string, unknown> = {
		model,
		messages,
		max_tokens: 4096,
		stream: true,
		stream_options: { include_usage: true }
	};
	if (oaTools.length > 0) {
		body.tools = oaTools;
		body.tool_choice = 'auto';
	}

	const res = await fetch(`${getGroqBaseUrl()}/chat/completions`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${key}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!res.ok || !res.body) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Groq HTTP ${res.status}${detail ? ' : ' + detail.slice(0, 200) : ''}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		// SSE : lignes séparées par \n, événements utiles préfixés "data:".
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') continue;
			let json: OAStreamChunk;
			try {
				json = JSON.parse(data) as OAStreamChunk;
			} catch {
				// chunk partiel ou ligne non-JSON : on ignore, le reste suivra.
				continue;
			}

			const choice = json.choices?.[0];
			const delta = choice?.delta;
			if (delta?.content) {
				yield { kind: 'delta', text: delta.content };
				state.assistantText += delta.content;
			}
			if (delta?.tool_calls) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index ?? 0;
					let cur = state.toolCalls.get(idx);
					if (!cur) {
						cur = { index: idx, id: tc.id ?? '', name: '', arguments: '' };
						state.toolCalls.set(idx, cur);
					}
					if (tc.id) cur.id = tc.id;
					if (tc.function?.name) cur.name = tc.function.name;
					if (tc.function?.arguments) cur.arguments += tc.function.arguments;
				}
			}
			if (choice?.finish_reason) state.finishReason = choice.finish_reason;
			if (json.usage) state.usage = json.usage;
		}
	}
}

// Yield les deltas texte de Groq sous le même type StreamEvent que claude.ts. Si des
// outils sont fournis, déroule la boucle tool_use → tool_result (mode free outillé).
export async function* streamGroqReply(
	system: string,
	turns: ChatTurn[],
	userId: string | null,
	conversationId: string | null,
	tools: GalaxiaTool[] = []
): AsyncGenerator<StreamEvent, void, unknown> {
	const key = getGroqKey();
	if (!key) {
		throw new Error(
			'Mode gratuit indisponible : GROQ_API_KEY non configurée sur le serveur. Bascule en mode Opus, ou ajoute la clé dans apps/cockpit/.env.'
		);
	}
	const model = getGroqModel();
	const oaTools = toOpenAITools(tools);
	const messages: OAMessage[] = [
		{ role: 'system', content: system },
		...turns.map((t) => ({ role: t.role, content: t.content }))
	];

	let totalInput = 0;
	let totalOutput = 0;

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const state: RoundState = {
			toolCalls: new Map(),
			usage: null,
			finishReason: null,
			assistantText: ''
		};
		yield* streamRound(key, model, messages, oaTools, state);

		if (state.usage) {
			totalInput += state.usage.prompt_tokens ?? 0;
			totalOutput += state.usage.completion_tokens ?? 0;
		}

		// Pas de tool_calls (ou aucun outil) → réponse finale, on s'arrête.
		if (state.finishReason !== 'tool_calls' || state.toolCalls.size === 0) break;

		const calls = [...state.toolCalls.values()].sort((a, b) => a.index - b.index);
		// Le message assistant doit reporter ses tool_calls pour que Groq retrouve le fil.
		messages.push({
			role: 'assistant',
			content: state.assistantText || null,
			tool_calls: calls.map((c) => ({
				id: c.id,
				type: 'function',
				function: { name: c.name, arguments: c.arguments || '{}' }
			}))
		});

		for (const c of calls) {
			let input: Record<string, unknown> = {};
			try {
				input = c.arguments ? JSON.parse(c.arguments) : {};
			} catch {
				input = {};
			}
			yield { kind: 'tool_use', id: c.id, name: c.name, input };
			const r = await executeTool(c.name, input);
			yield {
				kind: 'tool_result',
				id: c.id,
				name: c.name,
				result: r.result,
				is_error: r.is_error
			};
			messages.push({ role: 'tool', tool_call_id: c.id, content: r.result });
		}
	}

	// Tracking best-effort, à coût 0 (free tier) — même table `usage` que le mode pro.
	// On agrège tous les rounds en une ligne (input/output cumulés).
	if (totalInput || totalOutput) {
		try {
			recordUsage({
				user_id: userId,
				conversation_id: conversationId,
				model,
				input_tokens: totalInput,
				output_tokens: totalOutput,
				cost_micros: computeCostMicros(model, {
					input_tokens: totalInput,
					output_tokens: totalOutput
				})
			});
		} catch (e) {
			console.error('[usage] groq tracking failed', e);
		}
	}
}
