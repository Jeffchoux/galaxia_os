// Mode "rapide" / gratuit du cockpit (choix Jeff 2026-05-29) : Groq, API compatible
// OpenAI. Chat NU — pas d'outils (function calling) ni de vision : c'est le mode
// petites tâches. Le mode "pro" (Opus 4.8 + outils) reste dans claude.ts.
//
// On parle à Groq en HTTP direct (fetch) plutôt qu'en ajoutant le SDK openai :
// le contrat /chat/completions en streaming SSE est stable et ça évite une dépendance.
import { getGroqBaseUrl, getGroqKey, getGroqModel } from './env';
import { recordUsage } from './db';
import { computeCostMicros } from './pricing';
import type { ChatTurn, StreamEvent } from './claude';

interface GroqStreamChoiceDelta {
	choices?: Array<{ delta?: { content?: string | null } }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

// Yield les deltas texte de Groq sous le même type StreamEvent que claude.ts, pour
// que la route /api/chat traite les deux modes de façon identique (le mode gratuit
// n'émet jamais de tool_use / tool_result).
export async function* streamGroqReply(
	system: string,
	turns: ChatTurn[],
	userId: string | null,
	conversationId: string | null
): AsyncGenerator<StreamEvent, void, unknown> {
	const key = getGroqKey();
	if (!key) {
		throw new Error(
			'Mode gratuit indisponible : GROQ_API_KEY non configurée sur le serveur. Bascule en mode Opus, ou ajoute la clé dans apps/cockpit/.env.'
		);
	}
	const model = getGroqModel();
	const messages = [
		{ role: 'system', content: system },
		...turns.map((t) => ({ role: t.role, content: t.content }))
	];

	const res = await fetch(`${getGroqBaseUrl()}/chat/completions`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${key}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			model,
			messages,
			max_tokens: 4096,
			stream: true,
			// Groq renvoie l'usage final dans le dernier chunk si on le demande.
			stream_options: { include_usage: true }
		})
	});

	if (!res.ok || !res.body) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Groq HTTP ${res.status}${detail ? ' : ' + detail.slice(0, 200) : ''}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

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
			try {
				const json = JSON.parse(data) as GroqStreamChoiceDelta;
				const delta = json.choices?.[0]?.delta?.content;
				if (delta) yield { kind: 'delta', text: delta };
				if (json.usage) usage = json.usage;
			} catch {
				// chunk partiel ou ligne non-JSON : on ignore, le reste suivra.
			}
		}
	}

	// Tracking best-effort, à coût 0 (free tier) — même table `usage` que le mode pro.
	if (usage) {
		try {
			const input_tokens = usage.prompt_tokens ?? 0;
			const output_tokens = usage.completion_tokens ?? 0;
			recordUsage({
				user_id: userId,
				conversation_id: conversationId,
				model,
				input_tokens,
				output_tokens,
				cost_micros: computeCostMicros(model, { input_tokens, output_tokens })
			});
		} catch (e) {
			console.error('[usage] groq tracking failed', e);
		}
	}
}
