<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	function fmtDate(date: string): string {
		try {
			return new Date(date).toLocaleDateString('fr-FR', {
				weekday: 'short',
				day: '2-digit',
				month: 'long',
				year: 'numeric'
			});
		} catch {
			return date;
		}
	}
</script>

<svelte:head>
	<title>Briefs Galaxia</title>
</svelte:head>

<div class="wrap">
	<header class="page-header">
		<a href="/" class="back">← Cockpit</a>
		<h1>Briefs Galaxia</h1>
		<p class="sub">
			{data.briefs.length} brief{data.briefs.length > 1 ? 's' : ''} produits par le pipeline digest.
		</p>
	</header>

	{#if data.briefs.length === 0}
		<div class="empty">
			<p>Aucun brief produit pour l'instant.</p>
			<p class="hint">
				Envoie un TikTok ou X sur le bot Telegram, puis attends le prochain digest (06:30 UTC), ou
				déclenche <code>/digest</code> via Telegram.
			</p>
		</div>
	{:else}
		<ul class="briefs">
			{#each data.briefs as brief (brief.filename)}
				<li class:fallback={brief.is_fallback}>
					<a href={`/briefs/${brief.filename}`}>
						<div class="head">
							<span class="date">{fmtDate(brief.date)}</span>
							{#if brief.is_fallback}
								<span class="tag">fallback</span>
							{/if}
						</div>
						<div class="title">{brief.title}</div>
						<p class="preview">{brief.preview}</p>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
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
		min-height: 100vh;
	}
	.wrap {
		max-width: 800px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	.page-header {
		margin-bottom: 2rem;
	}
	.back {
		color: #b9b9d0;
		text-decoration: none;
		font-size: 0.9rem;
		display: inline-block;
		margin-bottom: 1rem;
	}
	.back:hover {
		color: #fff;
	}
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.75rem;
		font-weight: 600;
	}
	.sub {
		margin: 0;
		color: #8e8ea8;
		font-size: 0.9rem;
	}
	.briefs {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.briefs li {
		background: rgba(20, 18, 32, 0.5);
		border: 1px solid rgba(124, 58, 237, 0.2);
		border-radius: 12px;
		transition: all 0.15s;
	}
	.briefs li.fallback {
		opacity: 0.55;
	}
	.briefs li:hover {
		border-color: rgba(124, 58, 237, 0.5);
		background: rgba(30, 25, 50, 0.6);
	}
	.briefs a {
		display: block;
		padding: 1rem 1.25rem;
		color: inherit;
		text-decoration: none;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
	}
	.date {
		font-size: 0.8rem;
		color: #b9b9d0;
		text-transform: capitalize;
	}
	.tag {
		font-size: 0.7rem;
		background: rgba(248, 113, 113, 0.15);
		color: #fca5a5;
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.title {
		font-size: 1.05rem;
		font-weight: 500;
		color: #fff;
		margin-bottom: 0.4rem;
	}
	.preview {
		margin: 0;
		font-size: 0.875rem;
		color: #8e8ea8;
		line-height: 1.5;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
	}
	.empty {
		text-align: center;
		padding: 4rem 1rem;
		color: #6b6b85;
	}
	.empty .hint {
		font-size: 0.875rem;
		max-width: 480px;
		margin: 1rem auto 0;
	}
	code {
		background: rgba(124, 58, 237, 0.2);
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		font-size: 0.85em;
	}
</style>
