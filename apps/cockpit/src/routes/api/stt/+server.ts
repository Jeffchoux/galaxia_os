// Galaxia STT proxy — Sprint 3 § A.3.
//
// Reçoit un blob audio (WAV/WebM/Opus) depuis le client, le transmet au
// daemon Whisper local (galaxia-whisper.service, port 5502) et renvoie le
// transcript JSON. Auth requise — pas d'usage anonyme du modèle (et pas
// d'enrichissement Google contrairement à Web Speech).
//
// Si le daemon est down ou pas configuré, on renvoie 503 et le client
// retombe sur le SpeechRecognition navigateur natif (comportement actuel).

import { error, type RequestHandler } from '@sveltejs/kit';
import { getWhisperUrl } from '$lib/server/env';

// 8 MB de buffer audio max — environ 4 min de WebM/Opus mono à 32 kbps.
// Coupe les usages abusifs sans gêner les phrases vocales normales.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const ct = request.headers.get('content-type') ?? '';
	if (!ct.startsWith('multipart/form-data')) {
		throw error(400, 'multipart/form-data attendu');
	}

	const form = await request.formData();
	const audio = form.get('audio');
	if (!(audio instanceof Blob)) throw error(400, 'champ audio manquant');
	if (audio.size === 0) throw error(400, 'audio vide');
	if (audio.size > MAX_AUDIO_BYTES) throw error(413, 'audio trop volumineux');

	const language = String(form.get('language') ?? 'fr');

	// Le daemon attend une multipart form aussi — on peut juste forwarder.
	const upstream = new FormData();
	upstream.set('audio', audio, (audio as File).name ?? 'audio.webm');
	upstream.set('language', language);

	const target = `${getWhisperUrl().replace(/\/$/, '')}/transcribe`;
	let res: Response;
	try {
		res = await fetch(target, { method: 'POST', body: upstream });
	} catch {
		throw error(503, 'whisper daemon injoignable');
	}
	if (!res.ok) {
		throw error(res.status, `whisper daemon ${res.status}`);
	}

	const payload = (await res.json()) as {
		text: string;
		language: string;
		duration: number;
		latency_s: number;
	};
	return new Response(JSON.stringify(payload), {
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
};
