// Galaxia Realtime cost tracking — Sprint 3 § D8.
//
// Reçoit du client (après chaque `response.done` du data channel OpenAI) la
// décomposition des tokens audio + texte de la session courante. Calcule le
// coût en micro-USD et l'insère dans la table `usage` (modèle `gpt-realtime`)
// pour le suivi global. Renvoie cost_micros au client pour qu'il affiche un
// cumul session côté UI.

import { error, json, type RequestHandler } from '@sveltejs/kit';
import { recordUsage } from '$lib/server/db';
import { computeRealtimeCostMicros, type RealtimeTokenUsage } from '$lib/server/pricing';
import { getOpenAIRealtimeModel } from '$lib/server/env';

function asNonNegativeInt(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let payload: Record<string, unknown>;
	try {
		payload = (await request.json()) as Record<string, unknown>;
	} catch {
		throw error(400, 'json invalide');
	}

	const usage: RealtimeTokenUsage = {
		input_audio_tokens: asNonNegativeInt(payload.input_audio_tokens),
		output_audio_tokens: asNonNegativeInt(payload.output_audio_tokens),
		input_text_tokens: asNonNegativeInt(payload.input_text_tokens),
		output_text_tokens: asNonNegativeInt(payload.output_text_tokens)
	};

	const total =
		usage.input_audio_tokens +
		usage.output_audio_tokens +
		usage.input_text_tokens +
		usage.output_text_tokens;
	if (total === 0) {
		// Rien à comptabiliser, on évite d'insérer une ligne vide.
		return json({ cost_micros: 0 });
	}

	const cost_micros = computeRealtimeCostMicros(usage);
	try {
		recordUsage({
			user_id: locals.user.id,
			conversation_id: null, // pas rattaché à une conv Claude — c'est une autre identité.
			model: getOpenAIRealtimeModel(),
			input_tokens: usage.input_audio_tokens + usage.input_text_tokens,
			output_tokens: usage.output_audio_tokens + usage.output_text_tokens,
			cost_micros
		});
	} catch (e) {
		console.error('[realtime/usage] insert failed', e);
		// On renvoie quand même le cost_micros — le client peut afficher un
		// cumul même si la persistance DB a foiré (signal d'erreur séparé).
	}

	return json({ cost_micros });
};
