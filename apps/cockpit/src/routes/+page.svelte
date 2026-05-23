<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	type Turn = { role: 'user' | 'assistant'; content: string };
	type DocChip = { id: string; filename: string; mime_type: string; size: number };

	let conversationId = $state<string | null>(data.active?.id ?? null);
	let turns = $state<Turn[]>(
		data.messages.map((m) => ({ role: m.role, content: m.content }))
	);
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
	let draft = $state('');
	let sending = $state(false);
	let streamingIndex = $state<number | null>(null);
	let errorMsg = $state<string | null>(null);
	let scrollEl: HTMLElement | undefined = $state();

	// ─── voix ──────────────────────────────────────────────────────────────
	let voiceMode = $state(false);
	let listening = $state(false);
	let speaking = $state(false);
	let interim = $state('');
	let voiceSupported = $state({ stt: false, tts: false });
	let recognition: any = null; // SpeechRecognition (browser-only)
	let ttsBuffer = ''; // accumulé pendant le stream pour découper en phrases TTS

	// VAD — détection d'interruption pendant que Galaxia parle
	let audioCtx: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let mediaStream: MediaStream | null = null;
	let monitorRaf: number | null = null;
	let voiceDetectedFrames = 0;
	let vadActive = $state(false);
	const VAD_THRESHOLD = 0.04; // RMS — ajusté empiriquement avec echoCancellation actif
	const VAD_TRIGGER_FRAMES = 4; // ~70ms à 60fps : debounce

	onMount(() => {
		if (typeof window === 'undefined') return;
		const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		voiceSupported.stt = !!SR;
		voiceSupported.tts = !!window.speechSynthesis;
	});

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
				draft = (draft + ' ' + finalTranscript).trim();
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
			recognition?.stop();
			return;
		}
		const r = getRecognition();
		if (!r) {
			errorMsg = "Reconnaissance vocale non disponible (Chrome / Edge / Safari requis).";
			return;
		}
		// Interrompre la voix de Galaxia si elle parle (pour pouvoir lui couper la parole)
		stopSpeaking();
		errorMsg = null;
		listening = true;
		try {
			r.start();
		} catch (e) {
			listening = false;
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	}

	function speakChunk(text: string) {
		if (!voiceMode || !voiceSupported.tts || !text.trim()) return;
		const u = new SpeechSynthesisUtterance(text);
		u.lang = 'fr-FR';
		u.rate = 1.05;
		u.pitch = 1.0;
		u.onstart = () => (speaking = true);
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

	function stopSpeaking() {
		if (typeof window === 'undefined') return;
		window.speechSynthesis.cancel();
		speaking = false;
		ttsBuffer = '';
	}

	// ─── VAD (interruption naturelle) ─────────────────────────────────────
	async function startAudioMonitor() {
		if (audioCtx || typeof window === 'undefined') return;
		try {
			mediaStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true
				}
			});
			const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
			const ctx: AudioContext = new Ctx();
			const source = ctx.createMediaStreamSource(mediaStream);
			const a = ctx.createAnalyser();
			a.fftSize = 1024;
			source.connect(a);
			audioCtx = ctx;
			analyser = a;
			vadActive = true;
			monitorLoop();
		} catch (e) {
			errorMsg = "Micro non autorisé — VAD désactivé. " + (e instanceof Error ? e.message : '');
			vadActive = false;
		}
	}

	function stopAudioMonitor() {
		if (monitorRaf !== null) {
			cancelAnimationFrame(monitorRaf);
			monitorRaf = null;
		}
		if (mediaStream) {
			mediaStream.getTracks().forEach((t) => t.stop());
			mediaStream = null;
		}
		if (audioCtx) {
			audioCtx.close().catch(() => {});
			audioCtx = null;
		}
		analyser = null;
		voiceDetectedFrames = 0;
		vadActive = false;
	}

	function monitorLoop() {
		if (!analyser) return;
		const buf = new Float32Array(analyser.fftSize);
		analyser.getFloatTimeDomainData(buf);
		let sum = 0;
		for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
		const rms = Math.sqrt(sum / buf.length);

		if (rms > VAD_THRESHOLD) {
			voiceDetectedFrames++;
			// Interruption : si Galaxia parle ET que Jeff dépasse le seuil
			// suffisamment longtemps (debounce), on coupe + on bascule en écoute.
			if (speaking && voiceDetectedFrames >= VAD_TRIGGER_FRAMES) {
				voiceDetectedFrames = 0;
				stopSpeaking();
				if (!listening && !sending) toggleListening();
			}
		} else {
			voiceDetectedFrames = 0;
		}

		monitorRaf = requestAnimationFrame(monitorLoop);
	}

	function flushTtsBuffer(force = false) {
		// extrait toutes les phrases complètes du buffer et les TTS-eue
		const sentenceEnd = /([.!?…\n])\s+/;
		while (true) {
			const m = ttsBuffer.match(sentenceEnd);
			if (!m || m.index === undefined) break;
			const end = m.index + m[0].length;
			const sentence = ttsBuffer.slice(0, end).trim();
			ttsBuffer = ttsBuffer.slice(end);
			if (sentence) speakChunk(sentence);
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

		turns = [...turns, { role: 'user', content: text }, { role: 'assistant', content: '' }];
		streamingIndex = turns.length - 1;
		autoscroll();

		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: conversationId, message: text })
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
			errorMsg = err instanceof Error ? err.message : String(err);
		} finally {
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
		let data: { id?: string; text?: string; title?: string; message?: string };
		try {
			data = JSON.parse(dataStr);
		} catch {
			return;
		}

		if (event === 'conversation' && data.id) {
			conversationId = data.id;
			history.replaceState({}, '', `/?c=${data.id}`);
		} else if (event === 'delta' && data.text && streamingIndex !== null) {
			turns[streamingIndex] = {
				role: 'assistant',
				content: turns[streamingIndex].content + data.text
			};
			ttsBuffer += data.text;
			flushTtsBuffer(false);
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
		if (mime.includes('markdown')) return '📝';
		return '📃';
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

<div class="app">
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
				{#if speaking}
					<button class="stop-speak" onclick={stopSpeaking} title="Couper la voix">
						⏸ Silence
					</button>
				{/if}
				<button
					class="voice-toggle"
					class:on={voiceMode}
					onclick={toggleVoiceMode}
					disabled={!voiceSupported.tts}
					title={voiceSupported.tts
						? voiceMode
							? 'Mode mains libres actif — tu peux interrompre Galaxia en parlant'
							: 'Activer le mode mains libres (TTS auto + interruption par la voix)'
						: 'TTS non supporté par ce navigateur'}
				>
					{#if voiceMode}
						{vadActive ? '🎙️ Mains libres' : '🔊 Voix'}
					{:else}
						🔇 Voix
					{/if}
				</button>
			</div>
		</header>

		<section class="transcript" bind:this={scrollEl}>
			{#if turns.length === 0}
				<div class="welcome">
					<p>
						{#if voiceMode}
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
					<div class="content">
						{#if turn.content}
							{turn.content}
						{:else if i === streamingIndex}
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
							<span class="icon">{docIcon(doc.mime_type)}</span>
							<span class="name">{doc.filename}</span>
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
					accept="application/pdf,text/plain,text/markdown,.md,.markdown,.txt,.pdf"
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
					title="Joindre PDF / Markdown / TXT (drag-drop accepté)"
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
				<div class="drag-overlay">Lâche ici — PDF / Markdown / TXT</div>
			{/if}
		</div>
	</main>
</div>

<style>
	:global(body) {
		margin: 0;
		background: #07060c;
		color: #e9e9f4;
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			Segoe UI,
			Roboto,
			sans-serif;
		height: 100vh;
		overflow: hidden;
	}
	:global(*) {
		box-sizing: border-box;
	}

	.app {
		display: grid;
		grid-template-columns: 280px 1fr;
		height: 100vh;
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		background: #0c0a18;
		border-right: 1px solid rgba(124, 58, 237, 0.15);
		padding: 1rem 0.75rem;
		gap: 0.75rem;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 600;
		padding: 0.25rem 0.5rem 0.5rem;
		border-bottom: 1px solid rgba(124, 58, 237, 0.15);
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: radial-gradient(circle at 30% 30%, #c084fc, #7c3aed 60%, #1a0e2e);
		box-shadow: 0 0 8px rgba(124, 58, 237, 0.5);
	}
	.new {
		background: rgba(124, 58, 237, 0.15);
		color: #ddd;
		border: 1px solid rgba(124, 58, 237, 0.3);
		padding: 0.6rem;
		border-radius: 8px;
		font-size: 0.875rem;
		cursor: pointer;
		text-align: left;
	}
	.new:hover {
		background: rgba(124, 58, 237, 0.25);
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
		color: #b9b9d0;
		text-decoration: none;
		font-size: 0.875rem;
	}
	.convlist a:hover {
		background: rgba(124, 58, 237, 0.08);
		color: #fff;
	}
	.convlist a.active {
		background: rgba(124, 58, 237, 0.2);
		color: #fff;
	}
	.convlist .title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.convlist .date {
		color: #6b6b85;
		font-size: 0.75rem;
		flex-shrink: 0;
	}
	.empty {
		padding: 0.5rem;
		color: #555;
		font-size: 0.85rem;
	}
	.briefs-section {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding-top: 0.5rem;
		border-top: 1px solid rgba(124, 58, 237, 0.15);
	}
	.briefs-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding: 0.4rem 0.5rem 0.2rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #6b6b85;
		font-weight: 600;
	}
	.all-link {
		color: #6b6b85;
		text-decoration: none;
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.75rem;
	}
	.all-link:hover {
		color: #c084fc;
	}
	.brief-item {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
		color: #b9b9d0;
		text-decoration: none;
		font-size: 0.8rem;
	}
	.brief-item:hover {
		background: rgba(124, 58, 237, 0.08);
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
		color: #6b6b85;
		font-size: 0.7rem;
		flex-shrink: 0;
	}
	.logout {
		margin-top: auto;
	}
	.ghost {
		background: transparent;
		color: #6b6b85;
		border: none;
		padding: 0.5rem;
		cursor: pointer;
		font-size: 0.8rem;
		width: 100%;
		text-align: left;
	}
	.ghost:hover {
		color: #e9e9f4;
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
		border-bottom: 1px solid rgba(124, 58, 237, 0.15);
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
		color: #b9b9d0;
		border: 1px solid rgba(124, 58, 237, 0.25);
		padding: 0.4rem 0.75rem;
		border-radius: 8px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.15s;
	}
	.voice-toggle:hover:not(:disabled) {
		background: rgba(124, 58, 237, 0.2);
		color: #fff;
	}
	.voice-toggle.on {
		background: #7c3aed;
		color: #fff;
		border-color: #7c3aed;
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
	.turn {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-width: 800px;
		width: 100%;
		margin: 0 auto;
	}
	.turn.user .role {
		color: #c084fc;
	}
	.turn.assistant .role {
		color: #7c3aed;
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
		background: #7c3aed;
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
		border-top: 1px solid rgba(124, 58, 237, 0.15);
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
		background: rgba(124, 58, 237, 0.15);
		color: #fff;
		border: 1px solid rgba(124, 58, 237, 0.3);
		border-radius: 10px;
		font-size: 1.1rem;
		cursor: pointer;
		display: grid;
		place-items: center;
		transition: all 0.15s;
	}
	.mic:hover:not(:disabled) {
		background: rgba(124, 58, 237, 0.3);
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
		border: 1px solid rgba(124, 58, 237, 0.25);
		border-radius: 10px;
		color: #fff;
		font-size: 0.95rem;
		font-family: inherit;
		resize: vertical;
	}
	textarea:focus {
		outline: none;
		border-color: #7c3aed;
	}
	textarea:disabled {
		opacity: 0.5;
	}
	.interim {
		position: absolute;
		bottom: -1.4rem;
		left: 0.5rem;
		font-size: 0.8rem;
		color: #7c3aed;
		font-style: italic;
		pointer-events: none;
	}
	.composer > button[type='submit'] {
		padding: 0.75rem 1.25rem;
		background: #7c3aed;
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
		border-top: 1px solid rgba(124, 58, 237, 0.15);
		transition: background 0.15s;
	}
	.composer-wrap.drag {
		background: rgba(124, 58, 237, 0.08);
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
		border: 1px solid rgba(124, 58, 237, 0.3);
		border-radius: 16px;
		padding: 0.25rem 0.55rem 0.25rem 0.65rem;
		font-size: 0.8rem;
		color: #e9e9f4;
		max-width: 280px;
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
		color: #b9b9d0;
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
		color: #b9b9d0;
		border: 1px solid rgba(124, 58, 237, 0.25);
		border-radius: 10px;
		font-size: 1.05rem;
		cursor: pointer;
		display: grid;
		place-items: center;
		transition: all 0.15s;
	}
	.attach:hover:not(:disabled) {
		background: rgba(124, 58, 237, 0.25);
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
		color: #c084fc;
		font-weight: 600;
		font-size: 1.05rem;
		pointer-events: none;
		border: 2px dashed #7c3aed;
		border-radius: 8px;
		margin: 0.5rem;
	}
</style>
