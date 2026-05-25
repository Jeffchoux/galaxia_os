// Galaxia Realtime session minting — Sprint 3 § D8.
//
// Mint un client_secret éphémère OpenAI (~60 s) pour que le navigateur du
// cockpit puisse établir une connexion WebRTC directement avec l'API
// Realtime. La clé serveur OPENAI_API_KEY ne quitte jamais le backend.
//
// Auth requise (l'endpoint coûte de l'argent, on ne mint pas pour les
// anonymes). Si OPENAI_API_KEY n'est pas configurée → 503 silencieux,
// le client cache simplement l'option 'realtime' dans le toggle voix.

import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	getOpenAIKey,
	getOpenAIRealtimeModel,
	getOpenAIRealtimeVoice
} from '$lib/server/env';

// Identité Galaxia injectée dans la session Realtime. On reprend la
// substance de BASE_SYSTEM (claude.ts) en l'adaptant au mode vocal :
// pas de tools, pas de memory.md (pas accessible côté GPT-4o), pas de
// markdown (la voix le lirait littéralement). Le style direct/sans
// flagornerie reste le même pour cohérence avec le mode cascade.
function buildRealtimeInstructions(): string {
	const now = new Date();
	const date = now.toLocaleDateString('fr-FR', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'Europe/Paris'
	});
	return [
		"Tu es Galaxia, l'assistante vocale de Jeff (créateur du projet Galaxia, manager non-développeur).",
		'',
		`Aujourd'hui : ${date}.`,
		'',
		"Tu réponds en français par défaut. Style : direct, sans flagornerie, sans phrases d'introduction inutiles, réponses courtes par défaut. Tu es à l'aise avec le tutoiement.",
		'',
		"Tu es en mode vocal pur : pas de markdown, pas de bullet points lus à voix haute, pas de listes formatées. Parle comme on parle à une personne. Si Jeff te demande de lui lister des trucs, énonce-les naturellement avec 'premièrement', 'ensuite', 'enfin'.",
		'',
		"Tu n'as pas accès au repo Galaxia ni à la mémoire persistante dans ce mode (c'est l'expérience temps réel OpenAI, séparée du mode cascade). Si Jeff te demande un fichier précis ou un brief, dis-lui qu'il doit basculer en mode cascade (toggle Kyutai/Piper) pour que tu retrouves tes outils."
	].join('\n');
}

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const apiKey = getOpenAIKey();
	if (!apiKey) {
		// Pas configuré côté serveur : le client retombera sur le mode cascade.
		throw error(503, 'openai realtime non configuré sur ce cockpit');
	}

	const model = getOpenAIRealtimeModel();
	const voice = getOpenAIRealtimeVoice();
	const instructions = buildRealtimeInstructions();

	let upstream: Response;
	try {
		upstream = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				session: {
					type: 'realtime',
					model,
					instructions,
					audio: {
						output: { voice }
					}
				}
			})
		});
	} catch (e) {
		console.error('[realtime] openai unreachable', e);
		throw error(502, 'openai injoignable');
	}

	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		console.error(`[realtime] openai ${upstream.status} : ${body.slice(0, 500)}`);
		// 401 / 403 / 429 — on remonte un code distinct au client.
		const code = upstream.status === 401 || upstream.status === 403 ? 502 : 502;
		throw error(code, `openai a refusé la session (${upstream.status})`);
	}

	const payload = (await upstream.json()) as {
		value?: string;
		expires_at?: number;
		session?: { id?: string };
	};

	if (!payload.value) {
		console.error('[realtime] openai response sans value', payload);
		throw error(502, 'openai a renvoyé une réponse invalide');
	}

	return json({
		client_secret: payload.value,
		expires_at: payload.expires_at ?? null,
		model,
		voice
	});
};
