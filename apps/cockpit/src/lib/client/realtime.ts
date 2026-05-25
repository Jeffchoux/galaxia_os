// Galaxia Realtime WebRTC client — Sprint 3 § D8.
//
// Ouvre une connexion WebRTC vers l'API OpenAI Realtime. Le navigateur
// envoie son micro et reçoit la voix de GPT-4o-realtime en streaming.
// Tout passe directement par OpenAI : pas de Claude, pas de Kyutai, pas
// de Whisper. Le serveur cockpit ne sert qu'à minter un client_secret
// éphémère via /api/realtime/session (sa clé OPENAI_API_KEY reste serveur).
//
// Le data channel `oai-events` reçoit les events JSON (transcripts, usage,
// turn start/end). On les remonte au composant via callbacks.

export interface RealtimeUsage {
	input_audio_tokens: number;
	output_audio_tokens: number;
	input_text_tokens: number;
	output_text_tokens: number;
}

export interface RealtimeCallbacks {
	// true quand GPT-4o commence à parler, false quand sa réponse est terminée.
	// Le composant peut s'en servir pour afficher un indicateur "Galaxia parle".
	onSpeakingChange?: (speaking: boolean) => void;
	// Transcription de la dernière phrase de Jeff (côté OpenAI Whisper interne).
	onUserTranscript?: (text: string) => void;
	// Transcript texte de la réponse audio de GPT-4o (dispo en fin de tour).
	onAssistantTranscript?: (text: string) => void;
	// Émis sur `response.done` — utilisé pour le cost tracking.
	onUsage?: (usage: RealtimeUsage) => void;
	// Erreurs fatales (session ratée, SDP refusé, connexion fermée).
	onError?: (err: Error) => void;
	// État de la connexion WebRTC (utile pour afficher un spinner pendant l'init).
	onStateChange?: (state: 'connecting' | 'connected' | 'closed') => void;
}

export interface RealtimeHandle {
	stop: () => void;
}

export async function startRealtime(
	cb: RealtimeCallbacks
): Promise<RealtimeHandle | null> {
	cb.onStateChange?.('connecting');

	// 1. Mint un client_secret côté serveur (la clé OpenAI ne quitte jamais le backend).
	const sessionRes = await fetch('/api/realtime/session', { method: 'POST' });
	if (!sessionRes.ok) {
		const msg = await sessionRes.text().catch(() => '');
		cb.onError?.(new Error(`/api/realtime/session ${sessionRes.status}: ${msg.slice(0, 200)}`));
		cb.onStateChange?.('closed');
		return null;
	}
	const { client_secret, model } = (await sessionRes.json()) as {
		client_secret: string;
		model: string;
	};

	// 2. Crée la connexion WebRTC + un <audio> caché pour autoplay la voix distante.
	const pc = new RTCPeerConnection();
	const audioEl = document.createElement('audio');
	audioEl.autoplay = true;
	audioEl.style.display = 'none';
	document.body.appendChild(audioEl);

	pc.ontrack = (ev) => {
		audioEl.srcObject = ev.streams[0] ?? null;
	};

	// 3. Demande le micro local et ajoute la piste à la connexion.
	let micStream: MediaStream;
	try {
		micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (e) {
		cb.onError?.(e instanceof Error ? e : new Error(String(e)));
		pc.close();
		audioEl.remove();
		cb.onStateChange?.('closed');
		return null;
	}
	for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

	// 4. Data channel pour les events JSON OpenAI (transcripts, usage, etc.).
	const dc = pc.createDataChannel('oai-events');
	dc.onmessage = (e) => {
		try {
			handleEvent(JSON.parse(e.data), cb);
		} catch {
			/* event non-JSON, on ignore */
		}
	};

	// 5. Négocie SDP avec l'API Realtime (POST direct, pas de TURN/STUN custom).
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);

	// GA API depuis mai 2026 : l'endpoint d'établissement WebRTC est
	// /v1/realtime/calls (l'ancien /v1/realtime renvoie "Beta API no longer
	// supported"). Pas de header OpenAI-Beta non plus.
	const sdpRes = await fetch(
		`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${client_secret}`,
				'Content-Type': 'application/sdp'
			},
			body: offer.sdp ?? ''
		}
	);
	if (!sdpRes.ok) {
		const msg = await sdpRes.text().catch(() => '');
		cb.onError?.(new Error(`openai SDP ${sdpRes.status}: ${msg.slice(0, 200)}`));
		pc.close();
		micStream.getTracks().forEach((t) => t.stop());
		audioEl.remove();
		cb.onStateChange?.('closed');
		return null;
	}
	const answerSdp = await sdpRes.text();
	await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

	pc.onconnectionstatechange = () => {
		if (
			pc.connectionState === 'failed' ||
			pc.connectionState === 'disconnected' ||
			pc.connectionState === 'closed'
		) {
			cb.onStateChange?.('closed');
		} else if (pc.connectionState === 'connected') {
			cb.onStateChange?.('connected');
		}
	};

	return {
		stop: () => {
			try {
				dc.close();
			} catch {
				/* noop */
			}
			pc.close();
			micStream.getTracks().forEach((t) => t.stop());
			audioEl.remove();
			cb.onStateChange?.('closed');
		}
	};
}

interface OpenAIRealtimeEvent {
	type: string;
	transcript?: string;
	response?: {
		usage?: {
			input_token_details?: {
				audio_tokens?: number;
				text_tokens?: number;
			};
			output_token_details?: {
				audio_tokens?: number;
				text_tokens?: number;
			};
		};
	};
}

function handleEvent(ev: OpenAIRealtimeEvent, cb: RealtimeCallbacks): void {
	switch (ev.type) {
		case 'response.created':
		case 'response.output_audio.started':
		case 'response.audio.started':
			cb.onSpeakingChange?.(true);
			break;
		case 'response.done':
			cb.onSpeakingChange?.(false);
			if (ev.response?.usage) {
				cb.onUsage?.({
					input_audio_tokens: ev.response.usage.input_token_details?.audio_tokens ?? 0,
					output_audio_tokens: ev.response.usage.output_token_details?.audio_tokens ?? 0,
					input_text_tokens: ev.response.usage.input_token_details?.text_tokens ?? 0,
					output_text_tokens: ev.response.usage.output_token_details?.text_tokens ?? 0
				});
			}
			break;
		case 'conversation.item.input_audio_transcription.completed':
			if (ev.transcript) cb.onUserTranscript?.(ev.transcript);
			break;
		case 'response.audio_transcript.done':
		case 'response.output_audio_transcript.done':
			if (ev.transcript) cb.onAssistantTranscript?.(ev.transcript);
			break;
	}
}
