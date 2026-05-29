<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	type ToolEvent = {
		kind: 'tool_use' | 'tool_result';
		id: string;
		name: string;
		input?: Record<string, unknown>;
		result?: string;
		is_error?: boolean;
	};
	type Turn = { role: 'user' | 'assistant'; content: string; tools?: ToolEvent[] };
	type DocChip = { id: string; filename: string; mime_type: string; size: number };

	// L'état conversationnel est mutée localement à chaque turn ; on capture
	// volontairement l'instantané initial du load, pas une dérivée réactive.
	// svelte-ignore state_referenced_locally
	let conversationId = $state<string | null>(data.active?.id ?? null);
	// svelte-ignore state_referenced_locally
	let turns = $state<Turn[]>(
		data.messages.map((m) => ({ role: m.role, content: m.content }))
	);
	// svelte-ignore state_referenced_locally
	let documents = $state<DocChip[]>(
		data.documents.map((d) => ({
			id: d.id,
			filename: d.filename,
			mime_type: d.mime_type,
			size: d.size
		}))
	);
	let uploading = $state(false);
	let dragOver = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();
	let previewDoc = $state<DocChip | null>(null);
	let draft = $state('');
	let sending = $state(false);
	let streamingIndex = $state<number | null>(null);
	let errorMsg = $state<string | null>(null);
	let scrollEl: HTMLElement | undefined = $state();
	let chatAbortController: AbortController | null = null;

	// ─── voix ──────────────────────────────────────────────────────────────
	let voiceMode = $state(false);
	let listening = $state(false);
	let speaking = $state(false);
	let interim = $state('');
	let voiceSupported = $state({ stt: false, tts: false });
	let recognition: any = null; // SpeechRecognition (browser-only)
	let ttsBuffer = ''; // accumulé pendant le stream pour découper en phrases TTS

	// VAD — détection d'interruption pendant que Galaxia parle
	let vadActive = $state(false);
	let micVad: { destroy: () => void; start?: () => void; pause?: () => void } | null = null;
	let speakingSinceMs = 0; // timestamp du début de l'utterance en cours
	// Cooldown de sécurité : les premières ms d'une utterance TTS sont parfois
	// captées même avec Silero — petit garde-fou (200ms suffisent vs 800 en RMS).
	const VAD_COOLDOWN_MS = 200;

	// Wake word — filtre les phrases qui ne commencent pas par "(Hey) Galaxia"
	let wakeWord = $state(false);
	let wakeFlash = $state(false); // mini feedback visuel quand le wake est détecté
	const WAKE_RE = /^\s*(hey\s+|hé\s+|eh\s+|ok\s+|salut\s+)?galaxia[\s,.!?:;]*(.*)$/i;

	// Wake word acoustique Porcupine (Sprint 3 § A.1, cf. docs/DECISIONS.md § D6).
	// Si `PUBLIC_PICOVOICE_ACCESS_KEY` est défini ET `/wake/hey_galaxia_fr.ppn`
	// + `/wake/porcupine_params_fr.pv` présents, on remplace le filtre regex
	// par une détection acoustique always-on qui démarre la STT à la volée.
	// Sinon : retombée silencieuse sur le mode regex existant — pas de régression.
	let porcupineHandle: { destroy: () => Promise<void> } | null = null;
	let porcupineActive = $state(false); // true quand le worker WASM tourne

	// Backend TTS :
	// - 'browser' : SpeechSynthesis natif (instant, voix Google côté Chrome)
	// - 'piper'   : daemon Piper fr_FR-siwis-medium (~2s/phrase, souverain CPU)
	// - 'kyutai'  : daemon Kyutai Pocket TTS french_24l int8 (RTF≈0.5 sur ce VPS,
	//               streaming chunked, qualité française nettement supérieure)
	// - 'realtime' (D8) : OpenAI Realtime API speech-to-speech direct via WebRTC.
	//   Bypasse Claude/Whisper/Kyutai — c'est une autre identité (GPT-4o vocal)
	//   à laquelle on injecte les instructions Galaxia côté serveur.
	// La queue serveur partagée (piperQueue, nom historique) gère piper ET kyutai.
	// Défaut = 'kyutai' depuis 2026-05-29 : exigence cross-browser (Mac+Windows
	// Safari/Firefox/Chrome/Edge). La cascade serveur ne dépend que de Web Audio
	// API et MediaSource, supportés partout, contrairement à SpeechSynthesis qui
	// est partiel sur Safari/Firefox.
	let ttsBackend = $state<'browser' | 'piper' | 'kyutai' | 'realtime'>('kyutai');
	let piperQueue: string[] = [];
	let piperPumpRunning = false;
	let currentPiperAudio: HTMLAudioElement | null = null;

	// Backend STT (Sprint 3 § A.3) :
	// - 'browser' : SpeechRecognition natif (instant, transcript via Google côté Chrome)
	// - 'whisper' : daemon Whisper local (galaxia-whisper.service, faster-whisper
	//               large-v3-turbo int8 sur CPU, souverain, RTF≈1.2 turn-based).
	// En mode 'whisper' on n'utilise PAS Web Speech ; la transcription part du
	// segment audio que Silero VAD nous livre via `onSpeechEnd`.
	// Défaut = 'whisper' depuis 2026-05-29 : SpeechRecognition n'existe pas sur
	// Firefox et est partiel sur Safari. Whisper local marche partout via getUserMedia.
	let sttBackend = $state<'browser' | 'whisper'>('whisper');

	// État de la session OpenAI Realtime (D8). `realtimeHandle` est null tant
	// qu'aucune session WebRTC n'est ouverte ; il est posé par startRealtime()
	// et nettoyé par stop(). `realtimeState` reflète la phase de connexion.
	// `realtimeSpeaking` indique si GPT-4o est en train de parler (au-delà de
	// l'indicateur global `speaking` qui sert au mode cascade).
	let realtimeHandle: { stop: () => void } | null = null;
	let realtimeState = $state<'idle' | 'connecting' | 'connected' | 'closed'>('idle');
	let realtimeSpeaking = $state(false);
	let realtimeLastUser = $state<string>('');
	let realtimeLastAssistant = $state<string>('');
	let realtimeUsageMicros = $state(0); // cumul approximatif € session courante en micros

	onMount(() => {
		if (typeof window === 'undefined') return;
		const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		voiceSupported.stt = !!SR;
		voiceSupported.tts = !!window.speechSynthesis;
		// Restaure les préférences voix
		try {
			wakeWord = localStorage.getItem('galaxia.wakeWord') === '1';
			const tb = localStorage.getItem('galaxia.ttsBackend');
			if (tb === 'piper' || tb === 'browser' || tb === 'kyutai' || tb === 'realtime') ttsBackend = tb;
			const sb = localStorage.getItem('galaxia.sttBackend');
			if (sb === 'browser' || sb === 'whisper') sttBackend = sb;
		} catch {
			/* localStorage indispo */
		}

		return () => {
			// cleanup quand le composant est démonté (HMR, navigation)
			porcupineHandle?.destroy().catch(() => {});
			porcupineHandle = null;
			porcupineActive = false;
		};
	});

	// Démarre/arrête le détecteur acoustique Porcupine selon l'état `wakeWord`.
	// Le worker mic Picovoice tourne en parallèle de la SpeechRecognition —
	// quand "Hey Galaxia" est détecté acoustiquement, on déclenche flashWake
	// + lance la STT pour capter la phrase qui suit.
	$effect(() => {
		if (typeof window === 'undefined') return;

		const key = (import.meta.env.PUBLIC_PICOVOICE_ACCESS_KEY as string | undefined) ?? '';
		if (!wakeWord || !key) {
			if (porcupineHandle) {
				porcupineHandle.destroy().catch(() => {});
				porcupineHandle = null;
				porcupineActive = false;
			}
			return;
		}

		// Activation paresseuse : on charge le module seulement si la clé est là
		let cancelled = false;
		(async () => {
			const { initPorcupine } = await import('$lib/client/porcupine');
			if (cancelled) return;
			const handle = await initPorcupine(
				{
					accessKey: key,
					keywordPath: '/wake/hey_galaxia_fr.ppn',
					keywordLabel: 'Hey Galaxia',
				},
				() => {
					// Déclenché à chaque détection acoustique
					flashWake();
					if (!listening && !speaking) {
						toggleListening();
					}
				},
			);
			if (cancelled) {
				await handle?.destroy().catch(() => {});
				return;
			}
			porcupineHandle = handle;
			porcupineActive = handle !== null;
		})();

		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		try {
			if (typeof window !== 'undefined') {
				localStorage.setItem('galaxia.wakeWord', wakeWord ? '1' : '0');
				localStorage.setItem('galaxia.ttsBackend', ttsBackend);
				localStorage.setItem('galaxia.sttBackend', sttBackend);
			}
		} catch {
			/* idem */
		}
	});

	// Pilote la session OpenAI Realtime (D8). On l'ouvre quand l'utilisateur a
	// choisi le backend 'realtime' ET activé le mode voix, et on la ferme dès
	// qu'une de ces deux conditions tombe (ou au démontage). Lazy-load de la
	// lib WebRTC pour ne pas payer son chargement quand le mode n'est pas utilisé.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const shouldRun = ttsBackend === 'realtime' && voiceMode;

		if (!shouldRun) {
			if (realtimeHandle) {
				realtimeHandle.stop();
				realtimeHandle = null;
			}
			realtimeSpeaking = false;
			return;
		}

		// shouldRun=true et pas encore de session ouverte → on ouvre.
		if (realtimeHandle) return;
		let cancelled = false;
		(async () => {
			const { startRealtime } = await import('$lib/client/realtime');
			if (cancelled) return;
			const handle = await startRealtime({
				onStateChange: (s) => {
					realtimeState = s;
				},
				onSpeakingChange: (s) => {
					realtimeSpeaking = s;
				},
				onUserTranscript: (t) => {
					realtimeLastUser = t;
				},
				onAssistantTranscript: (t) => {
					realtimeLastAssistant = t;
				},
				onUsage: (u) => {
					// Best-effort : on POST au backend pour persister dans la table usage.
					// Si l'endpoint n'existe pas ou échoue, on garde quand même le compteur
					// local de session pour informer Jeff.
					fetch('/api/realtime/usage', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(u)
					})
						.then((r) => (r.ok ? r.json() : null))
						.then((j: { cost_micros?: number } | null) => {
							if (j?.cost_micros) realtimeUsageMicros += j.cost_micros;
						})
						.catch(() => {
							/* persistance best-effort */
						});
				},
				onError: (e) => {
					errorMsg = `Realtime: ${e.message}`;
					ttsBackend = 'browser';
				}
			});
			if (cancelled) {
				handle?.stop();
				return;
			}
			realtimeHandle = handle;
		})();

		return () => {
			cancelled = true;
			if (realtimeHandle) {
				realtimeHandle.stop();
				realtimeHandle = null;
			}
		};
	});

	function toggleWakeWord() {
		wakeWord = !wakeWord;
	}

	function flashWake() {
		wakeFlash = true;
		setTimeout(() => (wakeFlash = false), 600);
	}

	function getRecognition(): any {
		if (recognition) return recognition;
		const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		if (!SR) return null;
		const r = new SR();
		r.lang = 'fr-FR';
		r.interimResults = true;
		r.continuous = false;
		r.maxAlternatives = 1;

		r.onresult = (event: any) => {
			let finalTranscript = '';
			let interimTranscript = '';
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const transcript = event.results[i][0].transcript;
				if (event.results[i].isFinal) finalTranscript += transcript;
				else interimTranscript += transcript;
			}
			if (interimTranscript) interim = interimTranscript;
			if (finalTranscript) {
				if (wakeWord && !porcupineActive) {
					// Mode regex : on n'accepte que ce qui suit "(Hey) Galaxia"
					const m = finalTranscript.match(WAKE_RE);
					if (m) {
						const stripped = (m[2] ?? '').trim();
						flashWake();
						draft = (draft + ' ' + stripped).trim();
					}
					// Si pas de match, on ignore — la voix qui ne s'adresse pas à Galaxia est filtrée
				} else {
					// Mode Porcupine (gating acoustique déjà fait amont) OU wake désactivé
					draft = (draft + ' ' + finalTranscript).trim();
				}
				interim = '';
			}
		};
		r.onend = () => {
			listening = false;
			interim = '';
			if (voiceMode && draft.trim()) {
				// Hands-free : envoi auto au silence final
				send();
			} else if (voiceMode && !speaking && !sending) {
				// Hands-free, rien entendu mais on reste à l'écoute : relance
				setTimeout(() => {
					if (voiceMode && !listening && !speaking && !sending) toggleListening();
				}, 150);
			}
		};
		r.onerror = (e: any) => {
			listening = false;
			interim = '';
			if (e.error !== 'no-speech' && e.error !== 'aborted') {
				errorMsg = `Micro: ${e.error}`;
			}
		};
		recognition = r;
		return r;
	}

	function toggleListening() {
		if (listening) {
			if (sttBackend === 'browser') recognition?.stop();
			else listening = false; // mode Whisper : on coupe juste l'UI, le VAD continue
			return;
		}
		stopSpeaking();
		errorMsg = null;
		listening = true;
		if (sttBackend === 'whisper') {
			// Le VAD Silero, déjà démarré par startAudioMonitor(), nous livrera
			// le segment audio via onSpeechEnd → postSpeechToWhisper.
			// On s'assure juste que le monitor tourne.
			void startAudioMonitor();
			return;
		}
		const r = getRecognition();
		if (!r) {
			// Pas de SpeechRecognition (Firefox, Safari < 14.1) → bascule auto sur
			// la cascade Whisper serveur qui marche sur tout navigateur via getUserMedia.
			sttBackend = 'whisper';
			void startAudioMonitor();
			return;
		}
		try {
			r.start();
		} catch (e) {
			listening = false;
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	}

	// Retire le balisage markdown du texte envoyé au TTS pour ne pas
	// entendre "astérisque astérisque gras astérisque astérisque" et autres
	// symboles dictés tels quels. Conserve la ponctuation (utile pour la prosodie).
	function stripMarkdownForSpeech(input: string): string {
		return input
			// Fences ```code``` et `inline code` → contenu seul
			.replace(/```[\s\S]*?```/g, ' ')
			.replace(/`([^`]+)`/g, '$1')
			// Images ![alt](url) → alt
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
			// Liens [texte](url) → texte
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			// Gras/italique **xxx** __xxx__ *xxx* _xxx_ → xxx
			.replace(/(\*\*|__)(.+?)\1/g, '$2')
			.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
			// Headings ###, ##, # en début de ligne
			.replace(/^\s{0,3}#{1,6}\s+/gm, '')
			// Blockquotes ">" en début de ligne
			.replace(/^\s*>\s?/gm, '')
			// Bullets et numéros de liste en début de ligne
			.replace(/^\s*[-*+]\s+/gm, '')
			.replace(/^\s*\d+\.\s+/gm, '')
			// Tildes barrés ~~xxx~~ → xxx
			.replace(/~~(.+?)~~/g, '$1')
			// Espaces multiples créés par les remplacements
			.replace(/[ \t]+/g, ' ')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	function speakChunk(rawText: string) {
		const text = stripMarkdownForSpeech(rawText);
		if (!voiceMode || !text.trim()) return;
		if (ttsBackend === 'piper' || ttsBackend === 'kyutai') {
			piperQueue.push(text);
			void pumpPiperQueue();
			return;
		}
		if (!voiceSupported.tts) return;
		const u = new SpeechSynthesisUtterance(text);
		u.lang = 'fr-FR';
		u.rate = 1.05;
		u.pitch = 1.0;
		u.onstart = () => {
			speaking = true;
			speakingSinceMs = Date.now();
		};
		u.onend = () => {
			// micro-délai pour laisser la queue se vider correctement entre 2 utterances
			setTimeout(() => {
				if (!window.speechSynthesis.pending && !window.speechSynthesis.speaking) {
					speaking = false;
					// Hands-free : Galaxia a fini de parler → on reprend l'écoute
					if (voiceMode && !listening && !sending) {
						toggleListening();
					}
				}
			}, 60);
		};
		window.speechSynthesis.speak(u);
	}

	async function pumpPiperQueue() {
		if (piperPumpRunning) return;
		piperPumpRunning = true;
		speaking = true;
		speakingSinceMs = Date.now();
		try {
			while (
				piperQueue.length > 0 &&
				(ttsBackend === 'piper' || ttsBackend === 'kyutai') &&
				voiceMode
			) {
				const text = piperQueue.shift()!;
				try {
					const res = await fetch('/api/tts', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ text, backend: ttsBackend })
					});
					if (!res.ok) {
						// Backend serveur down → fallback transparent vers TTS browser
						if (res.status === 503) {
							const downName = ttsBackend === 'kyutai' ? 'Kyutai' : 'Piper';
							ttsBackend = 'browser';
							errorMsg = `${downName} non disponible — bascule sur la voix navigateur.`;
						}
						continue;
					}
					const blob = await res.blob();
					const url = URL.createObjectURL(blob);
					const audio = new Audio(url);
					currentPiperAudio = audio;
					await new Promise<void>((resolve) => {
						audio.onended = () => resolve();
						audio.onerror = () => resolve();
						audio.play().catch(() => resolve());
					});
					URL.revokeObjectURL(url);
					currentPiperAudio = null;
				} catch (e) {
					errorMsg = e instanceof Error ? e.message : String(e);
				}
			}
		} finally {
			piperPumpRunning = false;
			speaking = false;
			if (voiceMode && !listening && !sending) {
				setTimeout(() => {
					if (voiceMode && !listening && !sending) toggleListening();
				}, 60);
			}
		}
	}

	function stopSpeaking(opts: { abortLLM?: boolean } = {}) {
		if (typeof window === 'undefined') return;
		window.speechSynthesis.cancel();
		piperQueue = [];
		if (currentPiperAudio) {
			currentPiperAudio.pause();
			currentPiperAudio.currentTime = 0;
			currentPiperAudio = null;
		}
		speaking = false;
		ttsBuffer = '';
		// Sur barge-in : couper aussi le flux LLM pour ne pas brûler de tokens à vide.
		// Sur send() / clic "Couper la voix" : on garde le flux (l'utilisateur veut juste le silence).
		if (opts.abortLLM && chatAbortController) {
			chatAbortController.abort();
			chatAbortController = null;
		}
	}

	// ─── VAD (interruption naturelle) ─────────────────────────────────────
	// Silero VAD via @ricky0123/vad-web : modèle ONNX 2.3MB, robuste à l'écho TTS,
	// multi-langues. Assets servis depuis /vad/ (cf. static/vad/).
	async function startAudioMonitor() {
		if (micVad || typeof window === 'undefined') return;
		try {
			const { MicVAD } = await import('@ricky0123/vad-web');
			micVad = await MicVAD.new({
				baseAssetPath: '/vad/',
				onnxWASMBasePath: '/vad/',
				model: 'v5',
				positiveSpeechThreshold: 0.6,
				negativeSpeechThreshold: 0.45,
				minSpeechMs: 128,
				onSpeechStart: () => {
					// Barge-in : si Galaxia parle ET le cooldown initial est passé,
					// on coupe son TTS + le flux LLM, et on bascule en écoute.
					const cooledDown = Date.now() - speakingSinceMs > VAD_COOLDOWN_MS;
					if (speaking && cooledDown) {
						stopSpeaking({ abortLLM: true });
						if (!listening && !sending) toggleListening();
					}
				},
				onSpeechEnd: (audio: Float32Array) => {
					// En mode STT Whisper : on encode le segment audio Silero (PCM 16 kHz
					// mono Float32) en WAV et on POST à `/api/stt` (Sprint 3 § A.3).
					// En mode 'browser', Web Speech a déjà tout fait via `r.onend`.
					if (sttBackend === 'whisper' && audio && audio.length > 800) {
						void postSpeechToWhisper(audio);
					}
				}
			});
			await micVad.start?.();
			vadActive = true;
		} catch (e) {
			errorMsg = "VAD Silero indisponible — fallback désactivé. " + (e instanceof Error ? e.message : '');
			vadActive = false;
		}
	}

	// Encode un Float32Array PCM 16 kHz mono en blob WAV 16-bit signé.
	// Pas de dépendance externe — header 44 octets + samples int16 little-endian.
	function float32ToWavBlob(samples: Float32Array, sampleRate = 16000): Blob {
		const bytesPerSample = 2;
		const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
		const view = new DataView(buffer);
		const writeStr = (offset: number, s: string) => {
			for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
		};
		writeStr(0, 'RIFF');
		view.setUint32(4, 36 + samples.length * bytesPerSample, true);
		writeStr(8, 'WAVE');
		writeStr(12, 'fmt ');
		view.setUint32(16, 16, true); // PCM chunk size
		view.setUint16(20, 1, true); // PCM format
		view.setUint16(22, 1, true); // mono
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * bytesPerSample, true);
		view.setUint16(32, bytesPerSample, true);
		view.setUint16(34, 16, true);
		writeStr(36, 'data');
		view.setUint32(40, samples.length * bytesPerSample, true);
		let offset = 44;
		for (let i = 0; i < samples.length; i++, offset += bytesPerSample) {
			const s = Math.max(-1, Math.min(1, samples[i]));
			view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		}
		return new Blob([buffer], { type: 'audio/wav' });
	}

	async function postSpeechToWhisper(samples: Float32Array): Promise<void> {
		// Ne transcrit pas pendant que Galaxia parle / pendant qu'on envoie déjà
		// un tour LLM — éviter les superpositions chaotiques.
		if (speaking || sending) return;
		const blob = float32ToWavBlob(samples, 16000);
		const form = new FormData();
		form.set('audio', blob, 'speech.wav');
		form.set('language', 'fr');
		try {
			const res = await fetch('/api/stt', { method: 'POST', body: form });
			if (!res.ok) {
				if (res.status === 503) {
					sttBackend = 'browser';
					errorMsg = 'Whisper non disponible — bascule sur Web Speech.';
				}
				return;
			}
			const { text } = (await res.json()) as { text?: string };
			const cleaned = (text ?? '').trim();
			if (!cleaned) return;

			// Mêmes règles que Web Speech : si wake-word actif (et Porcupine
			// pas en charge), on filtre les phrases qui ne commencent pas par Galaxia.
			if (wakeWord && !porcupineActive) {
				const m = cleaned.match(WAKE_RE);
				if (!m) return;
				const stripped = (m[2] ?? '').trim();
				flashWake();
				draft = (draft + ' ' + stripped).trim();
			} else {
				draft = (draft + ' ' + cleaned).trim();
			}
			if (voiceMode && draft.trim() && !sending && !speaking) {
				void send();
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	}

	function stopAudioMonitor() {
		if (micVad) {
			try {
				micVad.destroy();
			} catch {
				/* noop */
			}
			micVad = null;
		}
		vadActive = false;
	}

	// Premier chunk = découpe agressive sur la première virgule/point-virgule/saut de ligne
	// pour démarrer l'audio dans les 300-500ms au lieu d'attendre la fin de phrase.
	// Chunks suivants = phrases complètes (meilleure prosodie sur les suites).
	const FIRST_CHUNK_BREAK = /([,;:.!?…\n])\s+/;
	const NORMAL_CHUNK_BREAK = /([.!?…\n])\s+/;
	const FIRST_CHUNK_MIN_CHARS = 25;
	let firstChunkEmittedForCurrentResponse = false;

	function flushTtsBuffer(force = false) {
		while (true) {
			const useFirstChunkRule = !firstChunkEmittedForCurrentResponse;
			const re = useFirstChunkRule ? FIRST_CHUNK_BREAK : NORMAL_CHUNK_BREAK;
			const m = ttsBuffer.match(re);
			if (!m || m.index === undefined) break;
			// Sur le premier chunk, ne déclenche que si on a au moins 25 chars — pour éviter
			// de speak "Bonjour," tout seul. Au-delà, on speak dès qu'on a un break valide.
			if (useFirstChunkRule && m.index < FIRST_CHUNK_MIN_CHARS) break;
			const end = m.index + m[0].length;
			const sentence = ttsBuffer.slice(0, end).trim();
			ttsBuffer = ttsBuffer.slice(end);
			if (sentence) {
				speakChunk(sentence);
				firstChunkEmittedForCurrentResponse = true;
			}
		}
		if (force && ttsBuffer.trim()) {
			speakChunk(ttsBuffer.trim());
			ttsBuffer = '';
		}
	}

	// ─── chat ──────────────────────────────────────────────────────────────
	async function autoscroll() {
		await tick();
		if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
	}

	async function send(e?: Event) {
		e?.preventDefault();
		const text = draft.trim();
		if (!text || sending) return;
		draft = '';
		errorMsg = null;
		sending = true;
		stopSpeaking(); // au cas où Galaxia parlait encore d'avant
		ttsBuffer = '';
		firstChunkEmittedForCurrentResponse = false;

		turns = [...turns, { role: 'user', content: text }, { role: 'assistant', content: '' }];
		streamingIndex = turns.length - 1;
		autoscroll();

		chatAbortController = new AbortController();
		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: conversationId, message: text }),
				signal: chatAbortController.signal
			});
			if (!res.ok || !res.body) {
				throw new Error(`HTTP ${res.status}`);
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let sep;
				while ((sep = buffer.indexOf('\n\n')) !== -1) {
					const frame = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					handleFrame(frame);
				}
			}
			// Stream terminé : flush la queue TTS avec ce qu'il reste
			flushTtsBuffer(true);
		} catch (err) {
			// AbortError sur barge-in : pas une erreur user-facing
			if (!(err instanceof DOMException && err.name === 'AbortError')) {
				errorMsg = err instanceof Error ? err.message : String(err);
			}
		} finally {
			chatAbortController = null;
			sending = false;
			streamingIndex = null;
			await invalidateAll();
			// Filet de sécurité : si voiceMode actif et qu'aucun TTS n'a pris la main
			// (erreur réseau, response vide…), on relance l'écoute.
			if (voiceMode && !listening && !speaking) {
				setTimeout(() => {
					if (voiceMode && !listening && !speaking && !sending) toggleListening();
				}, 200);
			}
		}
	}

	function handleFrame(frame: string) {
		const lines = frame.split('\n');
		let event = 'message';
		let dataStr = '';
		for (const line of lines) {
			if (line.startsWith('event: ')) event = line.slice(7);
			else if (line.startsWith('data: ')) dataStr += line.slice(6);
		}
		if (!dataStr) return;
		let data: {
			id?: string;
			text?: string;
			title?: string;
			message?: string;
			name?: string;
			input?: Record<string, unknown>;
			result?: string;
			is_error?: boolean;
		};
		try {
			data = JSON.parse(dataStr);
		} catch {
			return;
		}

		if (event === 'conversation' && data.id) {
			conversationId = data.id;
			history.replaceState({}, '', `/?c=${data.id}`);
		} else if (event === 'delta' && data.text && streamingIndex !== null) {
			const t = turns[streamingIndex];
			turns[streamingIndex] = {
				role: 'assistant',
				content: t.content + data.text,
				tools: t.tools
			};
			ttsBuffer += data.text;
			flushTtsBuffer(false);
			autoscroll();
		} else if (event === 'tool_use' && data.id && data.name && streamingIndex !== null) {
			const t = turns[streamingIndex];
			const next: ToolEvent = {
				kind: 'tool_use',
				id: data.id,
				name: data.name,
				input: data.input
			};
			turns[streamingIndex] = {
				role: 'assistant',
				content: t.content,
				tools: [...(t.tools ?? []), next]
			};
			autoscroll();
		} else if (event === 'tool_result' && data.id && streamingIndex !== null) {
			const t = turns[streamingIndex];
			const tools = (t.tools ?? []).map((tool) =>
				tool.id === data.id && tool.kind === 'tool_use'
					? { ...tool, result: data.result, is_error: data.is_error }
					: tool
			);
			turns[streamingIndex] = { role: 'assistant', content: t.content, tools };
			autoscroll();
		} else if (event === 'error') {
			errorMsg = data.message ?? 'Erreur inconnue';
		}
	}

	async function newConversation() {
		conversationId = null;
		turns = [];
		documents = [];
		errorMsg = null;
		stopSpeaking();
		history.replaceState({}, '', '/');
	}

	// ─── documents ─────────────────────────────────────────────────────────
	async function ensureConversation(): Promise<string> {
		if (conversationId) return conversationId;
		const res = await fetch('/api/conversations', { method: 'POST' });
		if (!res.ok) throw new Error(`Impossible de créer une conversation (HTTP ${res.status})`);
		const { conversation } = await res.json();
		conversationId = conversation.id;
		history.replaceState({}, '', `/?c=${conversation.id}`);
		return conversation.id;
	}

	async function uploadFiles(files: FileList | File[]) {
		if (uploading) return;
		const list = Array.from(files);
		if (list.length === 0) return;

		let convId: string;
		try {
			convId = await ensureConversation();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
			return;
		}

		uploading = true;
		errorMsg = null;
		try {
			for (const f of list) {
				const fd = new FormData();
				fd.append('file', f);
				const res = await fetch(`/api/documents?conversation_id=${convId}`, {
					method: 'POST',
					body: fd
				});
				if (!res.ok) {
					const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
					throw new Error(`${f.name}: ${body.message ?? res.statusText}`);
				}
				const { document: doc } = await res.json();
				documents = [...documents, doc];
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			uploading = false;
			if (fileInput) fileInput.value = '';
		}
	}

	async function removeDoc(id: string) {
		if (!conversationId) return;
		try {
			const res = await fetch(`/api/documents/${id}?conversation_id=${conversationId}`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			documents = documents.filter((d) => d.id !== id);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	}

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		dragOver = true;
	}

	function onDragLeave(e: DragEvent) {
		// Évite le flicker quand on survole un enfant
		if (e.target === e.currentTarget) dragOver = false;
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (!e.dataTransfer?.files?.length) return;
		uploadFiles(e.dataTransfer.files);
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} o`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
		return `${(n / 1024 / 1024).toFixed(1)} Mo`;
	}

	function docIcon(mime: string): string {
		if (mime === 'application/pdf') return '📄';
		if (mime.startsWith('image/')) return '🖼️';
		if (mime.includes('markdown')) return '📝';
		return '📃';
	}

	function openPreview(doc: DocChip) {
		previewDoc = doc;
	}

	function closePreview() {
		previewDoc = null;
	}

	function onPreviewKey(e: KeyboardEvent) {
		if (e.key === 'Escape') closePreview();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function fmtDate(ts: number): string {
		return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
	}

	function toggleVoiceMode() {
		voiceMode = !voiceMode;
		if (voiceMode) {
			// En mode Realtime (D8), c'est l'effet dédié plus bas qui ouvre la
			// session WebRTC vers OpenAI — on ne démarre PAS le pipeline cascade
			// (VAD + Web Speech + Whisper), GPT-4o gère tout en interne.
			if (ttsBackend === 'realtime') return;
			// Hands-free : on démarre l'analyser (VAD) + on lance l'écoute tout de suite
			startAudioMonitor();
			if (!listening && !sending) {
				setTimeout(() => {
					if (voiceMode && !listening && !sending) toggleListening();
				}, 150);
			}
		} else {
			stopSpeaking();
			stopAudioMonitor();
			if (listening) recognition?.stop();
		}
	}
</script>

<svelte:head>
	<title>{data.active?.title ?? 'Galaxia'}</title>
</svelte:head>

<div class="app" class:arfa-open={!!previewDoc}>
	<aside class="sidebar">
		<div class="brand">
			<span class="dot"></span>
			<span>Galaxia</span>
		</div>
		<button class="new" onclick={newConversation}>+ Nouvelle conversation</button>
		<nav class="convlist">
			{#each data.conversations as conv (conv.id)}
				<a
					href="/?c={conv.id}"
					class:active={conv.id === conversationId}
					data-sveltekit-reload
				>
					<span class="title">{conv.title}</span>
					<span class="date">{fmtDate(conv.updated_at)}</span>
				</a>
			{/each}
			{#if data.conversations.length === 0}
				<p class="empty">Aucune conversation pour l'instant.</p>
			{/if}
		</nav>

		<div class="sidebar-extras">
			<a href="/documents" class="extras-link">📂 Tous les documents →</a>
		</div>

		<div class="briefs-section">
			<div class="briefs-head">
				<span>Briefs récents</span>
				<a href="/briefs" class="all-link">tous →</a>
			</div>
			{#each data.briefs as brief (brief.filename)}
				<a class="brief-item" class:fallback={brief.is_fallback} href={`/briefs/${brief.filename}`}>
					<span class="brief-title">{brief.title}</span>
					<span class="brief-date">{brief.date.slice(5)}</span>
				</a>
			{/each}
			{#if data.briefs.length === 0}
				<p class="empty">Aucun brief.</p>
			{/if}
		</div>

		<form method="POST" action="/logout" class="logout">
			<button type="submit" class="ghost">Se déconnecter</button>
		</form>
	</aside>

	<main class="main">
		<header>
			<h1>{data.active?.title ?? 'Hey Galaxia, on parle ?'}</h1>
			<div class="header-actions">
				{#if voiceMode || listening || speaking || sending}
					<span class="conv-state" class:listening class:speaking class:thinking={sending && !speaking}>
						{#if speaking}
							<span class="dot dot-speaking"></span> Galaxia parle
						{:else if listening}
							<span class="dot dot-listening"></span> Galaxia t'écoute
						{:else if sending}
							<span class="dot dot-thinking"></span> Galaxia réfléchit
						{:else}
							<span class="dot dot-idle"></span> en pause
						{/if}
					</span>
				{/if}
				{#if speaking}
					<button class="stop-speak" onclick={() => stopSpeaking()} title="Couper la voix">
						⏸ Silence
					</button>
				{/if}
				<button
					class="voice-toggle"
					class:on={ttsBackend !== 'browser'}
					onclick={() => {
						// Cycle browser → kyutai → piper → realtime → browser
						ttsBackend =
							ttsBackend === 'browser'
								? 'kyutai'
								: ttsBackend === 'kyutai'
									? 'piper'
									: ttsBackend === 'piper'
										? 'realtime'
										: 'browser';
					}}
					title={ttsBackend === 'kyutai'
						? 'Voix Kyutai Pocket TTS (français_24l, souverain CPU, qualité ChatGPT, ~2× temps réel) — clic pour Piper'
						: ttsBackend === 'piper'
							? 'Voix Piper local (souverain, ~2s/phrase, qualité simple) — clic pour OpenAI Realtime'
							: ttsBackend === 'realtime'
								? 'Mode OpenAI Realtime (GPT-4o speech-to-speech, ~500ms, ~0.10€/min, non-souverain) — clic pour revenir au navigateur'
								: 'Voix navigateur native (instant, mais transcrit côté Google chez Chrome) — clic pour Kyutai souverain'}
				>
					{ttsBackend === 'kyutai'
						? '✨ Kyutai'
						: ttsBackend === 'piper'
							? '🎵 Piper'
							: ttsBackend === 'realtime'
								? '⚡ Realtime'
								: '🔉 Browser'}
				</button>
				<button
					class="voice-toggle"
					class:on={sttBackend === 'whisper'}
					onclick={() => (sttBackend = sttBackend === 'whisper' ? 'browser' : 'whisper')}
					disabled={ttsBackend === 'realtime' || (sttBackend === 'whisper' && !voiceSupported.stt)}
					title={ttsBackend === 'realtime'
						? 'STT inutile en mode ⚡ Realtime — GPT-4o gère la transcription en interne'
						: sttBackend === 'whisper'
							? voiceSupported.stt
								? 'STT Whisper local (souverain, RTF~1.2 CPU, qualité française forte) — clic pour Web Speech navigateur'
								: 'STT Whisper local (seule option dispo : Web Speech non supporté par ce navigateur)'
							: 'STT Web Speech (instant mais transcrit côté Google chez Chrome) — clic pour Whisper local souverain'}
				>
					{sttBackend === 'whisper' ? '🎤 Whisper' : '🎙 Web'}
				</button>
				<button
					class="voice-toggle"
					class:on={wakeWord}
					class:flash={wakeFlash}
					onclick={toggleWakeWord}
					disabled={ttsBackend === 'realtime' || (sttBackend === 'browser' && !voiceSupported.stt)}
					title={ttsBackend === 'realtime'
						? 'Wake word inutile en mode ⚡ Realtime — la session est ouverte en continu tant que Voix est actif'
						: wakeWord
							? "Wake word actif — il faut commencer ton message par 'Galaxia' ou 'Hey Galaxia'"
							: 'Activer le wake word — seules les phrases commençant par Galaxia déclenchent l\'envoi'}
				>
					{wakeWord ? '👂 Wake on' : '👂 Wake'}
				</button>
				<button
					class="voice-toggle"
					class:on={voiceMode}
					onclick={toggleVoiceMode}
					disabled={ttsBackend === 'browser' && !voiceSupported.tts}
					title={ttsBackend === 'realtime'
						? voiceMode
							? 'Session Realtime ouverte — parle, GPT-4o écoute en continu (clic pour fermer)'
							: 'Activer pour ouvrir la session WebRTC vers OpenAI Realtime'
						: ttsBackend === 'browser' && !voiceSupported.tts
							? 'TTS navigateur non supporté — bascule sur Kyutai ou Piper'
							: voiceMode
								? 'Mode mains libres actif — tu peux interrompre Galaxia en parlant'
								: 'Activer le mode mains libres (TTS auto + interruption par la voix)'}
				>
					{#if voiceMode}
						{ttsBackend === 'realtime'
							? realtimeSpeaking
								? '🔊 Galaxia parle'
								: realtimeState === 'connecting'
									? '⏳ Connexion…'
									: '🎙️ Realtime ON'
							: vadActive
								? '🎙️ Mains libres'
								: '🔊 Voix'}
					{:else}
						🔇 Voix
					{/if}
				</button>
			</div>
		</header>

		<section class="transcript" bind:this={scrollEl}>
			{#if ttsBackend === 'realtime'}
				<div class="realtime-banner" class:speaking={realtimeSpeaking}>
					<div class="realtime-banner-title">
						⚡ Mode Realtime OpenAI {realtimeState === 'connecting'
							? '— connexion…'
							: realtimeState === 'connected'
								? voiceMode
									? realtimeSpeaking
										? '— Galaxia parle'
										: '— à l\'écoute'
									: '— en pause (active 🎙️ Mains libres)'
								: realtimeState === 'closed'
									? '— session fermée'
									: ''}
					</div>
					{#if realtimeLastUser || realtimeLastAssistant}
						<div class="realtime-transcripts">
							{#if realtimeLastUser}
								<div class="rt-line rt-user"><b>Jeff :</b> {realtimeLastUser}</div>
							{/if}
							{#if realtimeLastAssistant}
								<div class="rt-line rt-assistant"><b>Galaxia :</b> {realtimeLastAssistant}</div>
							{/if}
						</div>
					{/if}
					{#if realtimeUsageMicros > 0}
						<div class="realtime-cost">
							Session : ~{(realtimeUsageMicros / 1_000_000).toFixed(3)} $ cumulés (non-souverain)
						</div>
					{/if}
				</div>
			{/if}
			{#if turns.length === 0}
				<div class="welcome">
					<p>
						{#if ttsBackend === 'realtime'}
							Mode ⚡ Realtime — active <b>🎙️ Mains libres</b> et parle directement à GPT-4o.
						{:else if voiceMode}
							Clique sur 🎤 et parle.
						{:else}
							Pose ta question. Réponse en streaming.
						{/if}
					</p>
				</div>
			{/if}
			{#each turns as turn, i (i)}
				<article class="turn {turn.role}">
					<div class="role">
						{turn.role === 'user' ? 'Jeff' : 'Galaxia'}
						{#if turn.role === 'assistant' && speaking && i === turns.length - 1}
							<span class="speaking-dot"></span>
						{/if}
					</div>
					{#if turn.tools && turn.tools.length > 0}
						<div class="tool-events">
							{#each turn.tools as ev (ev.id)}
								<span class="tool-chip" class:err={ev.is_error}>
									🔧 {ev.name}
									{#if ev.name === 'update_memory' && ev.input?.section}
										: « {ev.input.section as string} »
									{:else if ev.name === 'read_brief' && ev.input?.date}
										: {ev.input.date as string}
									{/if}
									{#if ev.result === undefined}
										<span class="tool-pending">…</span>
									{/if}
								</span>
							{/each}
						</div>
					{/if}
					<div class="content">
						{#if turn.content}
							{turn.content}
						{:else if i === streamingIndex && (!turn.tools || turn.tools.length === 0)}
							<span class="thinking">…</span>
						{/if}
					</div>
				</article>
			{/each}
			{#if errorMsg}
				<div class="error">⚠ {errorMsg}</div>
			{/if}
		</section>

		<div
			class="composer-wrap"
			class:drag={dragOver}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
			role="region"
			aria-label="Zone de saisie"
		>
			{#if documents.length > 0}
				<div class="doc-chips">
					{#each documents as doc (doc.id)}
						<div class="chip" title="{doc.mime_type} · {fmtBytes(doc.size)}">
							<button
								type="button"
								class="chip-open"
								onclick={() => openPreview(doc)}
								aria-label="Aperçu de {doc.filename}"
							>
								<span class="icon">{docIcon(doc.mime_type)}</span>
								<span class="name">{doc.filename}</span>
							</button>
							<button
								type="button"
								class="remove"
								onclick={() => removeDoc(doc.id)}
								aria-label="Retirer {doc.filename}"
							>×</button>
						</div>
					{/each}
				</div>
			{/if}

			<form class="composer" onsubmit={send}>
				<input
					type="file"
					bind:this={fileInput}
					accept="application/pdf,text/plain,text/markdown,image/jpeg,image/png,image/webp,image/gif,.md,.markdown,.txt,.pdf,.jpg,.jpeg,.png,.webp,.gif"
					multiple
					style="display: none"
					onchange={(e) => {
						const t = e.currentTarget as HTMLInputElement;
						if (t.files) uploadFiles(t.files);
					}}
				/>
				<button
					type="button"
					class="attach"
					onclick={() => fileInput?.click()}
					disabled={uploading || sending}
					title="Joindre PDF / Markdown / TXT / Image (drag-drop accepté)"
					aria-label="Joindre un document"
				>
					{uploading ? '…' : '📎'}
				</button>
				<button
					type="button"
					class="mic"
					class:listening
					onclick={toggleListening}
					disabled={!voiceSupported.stt || sending}
					title={voiceSupported.stt
						? listening
							? 'Stop'
							: 'Parler (Chrome/Edge/Safari)'
						: 'Reconnaissance vocale non supportée par ce navigateur'}
					aria-label={listening ? 'Arrêter le micro' : 'Démarrer le micro'}
				>
					{listening ? '⏹' : '🎤'}
				</button>
				<div class="input-wrap">
					<textarea
						bind:value={draft}
						onkeydown={onKey}
						placeholder={listening
							? 'Écoute…'
							: voiceMode
								? 'Parle (🎤) ou écris…'
								: documents.length > 0
									? 'Pose ta question sur le(s) document(s) joint(s)…'
									: 'Écris à Galaxia… (Enter pour envoyer, Shift+Enter pour saut de ligne)'}
						rows="2"
						disabled={sending}
					></textarea>
					{#if interim}
						<div class="interim">{interim}</div>
					{/if}
				</div>
				<button type="submit" disabled={sending || !draft.trim()}>
					{sending ? '…' : 'Envoyer'}
				</button>
			</form>

			{#if dragOver}
				<div class="drag-overlay">Lâche ici — PDF / Markdown / TXT / Image</div>
			{/if}
		</div>
	</main>

	{#if previewDoc}
		<aside class="arfa" aria-label="Artefact : {previewDoc.filename}">
			<header class="arfa-head">
				<span class="arfa-icon">{docIcon(previewDoc.mime_type)}</span>
				<span class="arfa-name">{previewDoc.filename}</span>
				<span class="arfa-meta">{fmtBytes(previewDoc.size)}</span>
				<a
					class="arfa-dl"
					href={`/api/documents/${previewDoc.id}?conversation_id=${conversationId}`}
					target="_blank"
					rel="noopener"
					title="Ouvrir dans un nouvel onglet"
				>↗</a>
				<button class="arfa-close" onclick={closePreview} aria-label="Fermer le panneau">×</button>
			</header>
			<iframe
				class="arfa-iframe"
				title={previewDoc.filename}
				src={`/api/documents/${previewDoc.id}?conversation_id=${conversationId}`}
			></iframe>
		</aside>
	{/if}
</div>

<svelte:window onkeydown={onPreviewKey} />

<style>
	:global(body) {
		margin: 0;
		background: var(--g-bg);
		color: var(--g-fg);
		font-family: var(--g-font);
		height: 100vh;
		overflow: hidden;
	}
	:global(*) {
		box-sizing: border-box;
	}

	.app {
		display: grid;
		grid-template-columns: var(--g-sidebar-w) 1fr;
		height: 100vh;
		transition: grid-template-columns 0.18s ease-out;
	}
	.app.arfa-open {
		grid-template-columns: var(--g-sidebar-w) 1fr var(--g-arfa-w);
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		background: var(--g-surface);
		border-right: 1px solid var(--g-primary-15);
		padding: 1rem 0.75rem;
		gap: 0.75rem;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 600;
		padding: 0.25rem 0.5rem 0.5rem;
		border-bottom: 1px solid var(--g-primary-15);
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: radial-gradient(circle at 30% 30%, var(--g-primary-light), var(--g-primary) 60%, var(--g-primary-dark));
		box-shadow: 0 0 8px var(--g-primary-50);
	}
	.new {
		background: var(--g-primary-15);
		color: #ddd;
		border: 1px solid var(--g-primary-30);
		padding: 0.6rem;
		border-radius: 8px;
		font-size: 0.875rem;
		cursor: pointer;
		text-align: left;
	}
	.new:hover {
		background: var(--g-primary-25);
	}
	.convlist {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.convlist a {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		color: var(--g-fg-muted);
		text-decoration: none;
		font-size: 0.875rem;
	}
	.convlist a:hover {
		background: var(--g-primary-08);
		color: #fff;
	}
	.convlist a.active {
		background: var(--g-primary-20);
		color: #fff;
	}
	.convlist .title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.convlist .date {
		color: var(--g-fg-faint);
		font-size: 0.75rem;
		flex-shrink: 0;
	}
	.empty {
		padding: 0.5rem;
		color: #555;
		font-size: 0.85rem;
	}
	.sidebar-extras {
		padding-top: 0.5rem;
		border-top: 1px solid var(--g-primary-15);
	}
	.extras-link {
		display: block;
		padding: 0.5rem 0.6rem;
		font-size: 0.8rem;
		color: var(--g-fg-muted);
		text-decoration: none;
		border-radius: 6px;
	}
	.extras-link:hover {
		background: var(--g-primary-08);
		color: #fff;
	}
	.briefs-section {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--g-primary-15);
	}
	.briefs-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding: 0.4rem 0.5rem 0.2rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--g-fg-faint);
		font-weight: 600;
	}
	.all-link {
		color: var(--g-fg-faint);
		text-decoration: none;
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.75rem;
	}
	.all-link:hover {
		color: var(--g-primary-light);
	}
	.brief-item {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
		color: var(--g-fg-muted);
		text-decoration: none;
		font-size: 0.8rem;
	}
	.brief-item:hover {
		background: var(--g-primary-08);
		color: #fff;
	}
	.brief-item.fallback {
		opacity: 0.5;
	}
	.brief-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.brief-date {
		color: var(--g-fg-faint);
		font-size: 0.7rem;
		flex-shrink: 0;
	}
	.logout {
		margin-top: auto;
	}
	.ghost {
		background: transparent;
		color: var(--g-fg-faint);
		border: none;
		padding: 0.5rem;
		cursor: pointer;
		font-size: 0.8rem;
		width: 100%;
		text-align: left;
	}
	.ghost:hover {
		color: var(--g-fg);
	}

	.main {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1.5rem;
		border-bottom: 1px solid var(--g-primary-15);
	}
	header h1 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 500;
		color: #d9d9eb;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.header-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.voice-toggle {
		background: rgba(124, 58, 237, 0.1);
		color: var(--g-fg-muted);
		border: 1px solid var(--g-primary-25);
		padding: 0.4rem 0.75rem;
		border-radius: 8px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.15s;
	}
	.voice-toggle:hover:not(:disabled) {
		background: var(--g-primary-20);
		color: #fff;
	}
	.voice-toggle.on {
		background: var(--g-primary);
		color: #fff;
		border-color: var(--g-primary);
	}
	.voice-toggle.flash {
		background: var(--g-primary-light);
		border-color: var(--g-primary-light);
		animation: wake-flash 0.6s ease-out;
	}
	@keyframes wake-flash {
		0% {
			box-shadow: 0 0 0 0 rgba(192, 132, 252, 0.7);
		}
		100% {
			box-shadow: 0 0 0 14px rgba(192, 132, 252, 0);
		}
	}
	.voice-toggle:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.stop-speak {
		background: rgba(248, 113, 113, 0.15);
		color: #fca5a5;
		border: 1px solid rgba(248, 113, 113, 0.4);
		padding: 0.4rem 0.75rem;
		border-radius: 8px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.stop-speak:hover {
		background: rgba(248, 113, 113, 0.25);
	}

	.conv-state {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		font-size: 0.8rem;
		background: rgba(255, 255, 255, 0.05);
		color: rgba(255, 255, 255, 0.7);
		border: 1px solid rgba(255, 255, 255, 0.08);
		user-select: none;
	}
	.conv-state .dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		display: inline-block;
	}
	.conv-state .dot-listening {
		background: var(--g-state-listening);
		box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.6);
		animation: pulse-green 1.4s infinite;
	}
	.conv-state .dot-thinking {
		background: var(--g-state-thinking);
		animation: pulse-amber 1.2s infinite;
	}
	.conv-state .dot-speaking {
		background: var(--g-state-speaking);
		animation: pulse-blue 0.9s infinite;
	}
	.conv-state .dot-idle {
		background: rgba(255, 255, 255, 0.4);
	}
	@keyframes pulse-green {
		0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55); }
		70% { box-shadow: 0 0 0 8px rgba(52, 211, 153, 0); }
		100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
	}
	@keyframes pulse-amber {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
	@keyframes pulse-blue {
		0%, 100% { transform: scale(1); }
		50% { transform: scale(1.4); }
	}

	.transcript {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.welcome {
		display: grid;
		place-items: center;
		min-height: 200px;
		color: #5a5a76;
	}
	.realtime-banner {
		background: linear-gradient(135deg, var(--g-primary-15), rgba(59, 130, 246, 0.12));
		border: 1px solid rgba(124, 58, 237, 0.35);
		border-radius: 12px;
		padding: 0.85rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: 800px;
		width: 100%;
		align-self: center;
	}
	.realtime-banner.speaking {
		border-color: rgba(124, 58, 237, 0.8);
		box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.4);
		animation: rt-pulse 1.6s ease-in-out infinite;
	}
	@keyframes rt-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.4); }
		50% { box-shadow: 0 0 0 6px rgba(124, 58, 237, 0); }
	}
	.realtime-banner-title {
		font-weight: 600;
		font-size: 0.95rem;
		color: #c4b5fd;
	}
	.realtime-transcripts {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.92rem;
		color: #e5e7eb;
	}
	.rt-line b {
		opacity: 0.7;
		margin-right: 0.3rem;
	}
	.realtime-cost {
		font-size: 0.8rem;
		color: #94a3b8;
	}
	.turn {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-width: 800px;
		width: 100%;
		margin: 0 auto;
	}
	.turn.user .role {
		color: var(--g-primary-light);
	}
	.turn.assistant .role {
		color: var(--g-primary);
	}
	.role {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.speaking-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--g-primary);
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% {
			opacity: 0.4;
			transform: scale(1);
		}
		50% {
			opacity: 1;
			transform: scale(1.3);
		}
	}
	.content {
		white-space: pre-wrap;
		word-wrap: break-word;
		line-height: 1.55;
	}
	.thinking {
		color: #555;
	}
	.tool-events {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.2rem 0 0.4rem;
	}
	.tool-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.75rem;
		padding: 0.15rem 0.55rem;
		border-radius: 999px;
		background: var(--g-primary-15);
		border: 1px solid var(--g-primary-30);
		color: #c4c4d8;
	}
	.tool-chip.err {
		background: rgba(248, 113, 113, 0.12);
		border-color: rgba(248, 113, 113, 0.4);
		color: #fca5a5;
	}
	.tool-pending {
		opacity: 0.5;
	}
	.error {
		max-width: 800px;
		margin: 0 auto;
		padding: 0.5rem 0.75rem;
		background: rgba(248, 113, 113, 0.1);
		border: 1px solid rgba(248, 113, 113, 0.3);
		border-radius: 6px;
		color: #f87171;
		font-size: 0.875rem;
	}

	.composer {
		display: flex;
		gap: 0.5rem;
		padding: 1rem 1.5rem 1.25rem;
		border-top: 1px solid var(--g-primary-15);
		max-width: 800px;
		width: 100%;
		margin: 0 auto;
		align-items: end;
	}
	.mic {
		flex-shrink: 0;
		width: 2.7rem;
		height: 2.7rem;
		padding: 0;
		background: var(--g-primary-15);
		color: #fff;
		border: 1px solid var(--g-primary-30);
		border-radius: 10px;
		font-size: 1.1rem;
		cursor: pointer;
		display: grid;
		place-items: center;
		transition: all 0.15s;
	}
	.mic:hover:not(:disabled) {
		background: var(--g-primary-30);
	}
	.mic.listening {
		background: #ef4444;
		border-color: #ef4444;
		animation: pulse-ring 1.4s ease-in-out infinite;
	}
	.mic:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
	@keyframes pulse-ring {
		0%, 100% {
			box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
		}
		50% {
			box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
		}
	}
	.input-wrap {
		flex: 1;
		position: relative;
		display: flex;
		flex-direction: column;
	}
	textarea {
		flex: 1;
		min-height: 2.5rem;
		max-height: 200px;
		padding: 0.7rem 0.9rem;
		background: rgba(20, 18, 32, 0.5);
		border: 1px solid var(--g-primary-25);
		border-radius: 10px;
		color: #fff;
		font-size: 0.95rem;
		font-family: inherit;
		resize: vertical;
	}
	textarea:focus {
		outline: none;
		border-color: var(--g-primary);
	}
	textarea:disabled {
		opacity: 0.5;
	}
	.interim {
		position: absolute;
		bottom: -1.4rem;
		left: 0.5rem;
		font-size: 0.8rem;
		color: var(--g-primary);
		font-style: italic;
		pointer-events: none;
	}
	.composer > button[type='submit'] {
		padding: 0.75rem 1.25rem;
		background: var(--g-primary);
		color: white;
		border: none;
		border-radius: 10px;
		font-weight: 600;
		cursor: pointer;
		height: 2.7rem;
	}
	.composer > button[type='submit']:hover:not(:disabled) {
		background: #6d28d9;
	}
	.composer > button[type='submit']:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* — Cowork : documents joints — */
	.composer-wrap {
		position: relative;
		border-top: 1px solid var(--g-primary-15);
		transition: background 0.15s;
	}
	.composer-wrap.drag {
		background: var(--g-primary-08);
	}
	.composer-wrap > .composer {
		border-top: none;
	}
	.doc-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.75rem 1.5rem 0;
		max-width: 800px;
		margin: 0 auto;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		background: rgba(124, 58, 237, 0.12);
		border: 1px solid var(--g-primary-30);
		border-radius: 16px;
		padding: 0.15rem 0.4rem 0.15rem 0.15rem;
		font-size: 0.8rem;
		color: var(--g-fg);
		max-width: 280px;
		transition: background 0.15s;
	}
	.chip:hover {
		background: rgba(124, 58, 237, 0.22);
	}
	.chip-open {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
		padding: 0.1rem 0 0.1rem 0.5rem;
		text-align: left;
	}
	.chip .icon {
		font-size: 0.9rem;
	}
	.chip .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 200px;
	}
	.chip .remove {
		background: none;
		border: none;
		color: var(--g-fg-muted);
		cursor: pointer;
		font-size: 1rem;
		line-height: 1;
		padding: 0 0.15rem;
		border-radius: 50%;
	}
	.chip .remove:hover {
		color: #fff;
		background: rgba(248, 113, 113, 0.3);
	}
	.attach {
		flex-shrink: 0;
		width: 2.7rem;
		height: 2.7rem;
		padding: 0;
		background: rgba(124, 58, 237, 0.1);
		color: var(--g-fg-muted);
		border: 1px solid var(--g-primary-25);
		border-radius: 10px;
		font-size: 1.05rem;
		cursor: pointer;
		display: grid;
		place-items: center;
		transition: all 0.15s;
	}
	.attach:hover:not(:disabled) {
		background: var(--g-primary-25);
		color: #fff;
	}
	.attach:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.drag-overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgba(20, 18, 40, 0.85);
		color: var(--g-primary-light);
		font-weight: 600;
		font-size: 1.05rem;
		pointer-events: none;
		border: 2px dashed var(--g-primary);
		border-radius: 8px;
		margin: 0.5rem;
	}

	/* — Panneau Arfa (artefacts, docké à droite comme Claude Code) — */
	.arfa {
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--g-surface);
		border-left: 1px solid var(--g-border-strong);
		box-shadow: var(--g-shadow-panel);
		animation: arfa-slide 0.18s ease-out;
	}
	@keyframes arfa-slide {
		from { transform: translateX(20px); opacity: 0; }
		to { transform: translateX(0); opacity: 1; }
	}
	.arfa-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--g-primary-20);
		background: rgba(20, 18, 32, 0.5);
	}
	.arfa-icon {
		font-size: 1.1rem;
	}
	.arfa-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		color: #fff;
	}
	.arfa-meta {
		color: var(--g-fg-faint);
		font-size: 0.8rem;
		flex-shrink: 0;
	}
	.arfa-dl, .arfa-close {
		flex-shrink: 0;
		width: 2rem;
		height: 2rem;
		display: grid;
		place-items: center;
		background: var(--g-primary-15);
		color: var(--g-fg-muted);
		border: 1px solid var(--g-primary-25);
		border-radius: var(--g-radius-sm);
		text-decoration: none;
		font-size: 1.1rem;
		cursor: pointer;
		line-height: 1;
	}
	.arfa-dl:hover, .arfa-close:hover {
		background: var(--g-primary-30);
		color: #fff;
	}
	.arfa-iframe {
		flex: 1;
		width: 100%;
		border: none;
		background: var(--g-bg);
	}

	@media (max-width: 1100px) {
		/* Sous 1100px le panneau Arfa passe en overlay flottant plutôt que
		   de comprimer le chat. */
		.app.arfa-open {
			grid-template-columns: var(--g-sidebar-w) 1fr;
		}
		.arfa {
			position: fixed;
			top: 0;
			right: 0;
			bottom: 0;
			width: min(var(--g-arfa-w), 92vw);
			z-index: 100;
		}
	}
</style>
