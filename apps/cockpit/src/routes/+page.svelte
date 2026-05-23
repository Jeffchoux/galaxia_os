<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	type Turn = { role: 'user' | 'assistant'; content: string };

	let conversationId = $state<string | null>(data.active?.id ?? null);
	let turns = $state<Turn[]>(
		data.messages.map((m) => ({ role: m.role, content: m.content }))
	);
	let draft = $state('');
	let sending = $state(false);
	let streamingIndex = $state<number | null>(null);
	let errorMsg = $state<string | null>(null);
	let scrollEl: HTMLElement | undefined = $state();

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
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
		} finally {
			sending = false;
			streamingIndex = null;
			await invalidateAll();
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
			autoscroll();
		} else if (event === 'error') {
			errorMsg = data.message ?? 'Erreur inconnue';
		}
	}

	async function newConversation() {
		conversationId = null;
		turns = [];
		errorMsg = null;
		history.replaceState({}, '', '/');
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
		<form method="POST" action="/logout" class="logout">
			<button type="submit" class="ghost">Se déconnecter</button>
		</form>
	</aside>

	<main class="main">
		<header>
			<h1>{data.active?.title ?? 'Hey Galaxia, on parle ?'}</h1>
		</header>

		<section class="transcript" bind:this={scrollEl}>
			{#if turns.length === 0}
				<div class="welcome">
					<p>Pose ta question. Réponse en streaming.</p>
				</div>
			{/if}
			{#each turns as turn, i (i)}
				<article class="turn {turn.role}">
					<div class="role">{turn.role === 'user' ? 'Jeff' : 'Galaxia'}</div>
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

		<form class="composer" onsubmit={send}>
			<textarea
				bind:value={draft}
				onkeydown={onKey}
				placeholder="Écris à Galaxia… (Enter pour envoyer, Shift+Enter pour saut de ligne)"
				rows="2"
				disabled={sending}
			></textarea>
			<button type="submit" disabled={sending || !draft.trim()}>
				{sending ? '…' : 'Envoyer'}
			</button>
		</form>
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
		padding: 1rem 1.5rem;
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
	.composer button {
		padding: 0.75rem 1.25rem;
		background: #7c3aed;
		color: white;
		border: none;
		border-radius: 10px;
		font-weight: 600;
		cursor: pointer;
		height: 2.7rem;
	}
	.composer button:hover:not(:disabled) {
		background: #6d28d9;
	}
	.composer button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
