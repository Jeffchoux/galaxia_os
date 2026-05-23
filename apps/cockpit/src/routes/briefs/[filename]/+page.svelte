<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	function fmtDate(date: string): string {
		try {
			return new Date(date).toLocaleDateString('fr-FR', {
				weekday: 'long',
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
	<title>{data.brief.title} — Galaxia</title>
</svelte:head>

<div class="wrap">
	<header class="page-header">
		<a href="/briefs" class="back">← Tous les briefs</a>
		<div class="date">{fmtDate(data.brief.date)}{data.brief.is_fallback ? ' (fallback)' : ''}</div>
	</header>

	<article class="brief">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html data.html}
	</article>
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
		line-height: 1.6;
	}
	.wrap {
		max-width: 760px;
		margin: 0 auto;
		padding: 2rem 1.5rem 5rem;
	}
	.page-header {
		margin-bottom: 1.5rem;
	}
	.back {
		color: #b9b9d0;
		text-decoration: none;
		font-size: 0.9rem;
	}
	.back:hover {
		color: #fff;
	}
	.date {
		color: #6b6b85;
		font-size: 0.85rem;
		margin-top: 0.5rem;
		text-transform: capitalize;
	}

	.brief :global(h1) {
		font-size: 1.85rem;
		margin: 0 0 1.25rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.brief :global(h2) {
		font-size: 1.25rem;
		margin: 2rem 0 0.75rem;
		font-weight: 600;
		color: #c084fc;
		border-bottom: 1px solid rgba(124, 58, 237, 0.2);
		padding-bottom: 0.4rem;
	}
	.brief :global(h3) {
		font-size: 1.05rem;
		margin: 1.5rem 0 0.5rem;
		font-weight: 600;
	}
	.brief :global(p) {
		margin: 0 0 1rem;
		color: #d9d9eb;
	}
	.brief :global(strong) {
		color: #fff;
	}
	.brief :global(em) {
		color: #8e8ea8;
		font-style: normal;
		font-size: 0.875rem;
	}
	.brief :global(a) {
		color: #c084fc;
		text-decoration: underline;
		text-decoration-color: rgba(192, 132, 252, 0.4);
	}
	.brief :global(a:hover) {
		text-decoration-color: #c084fc;
	}
	.brief :global(ul),
	.brief :global(ol) {
		padding-left: 1.5rem;
		color: #d9d9eb;
	}
	.brief :global(li) {
		margin-bottom: 0.5rem;
	}
	.brief :global(code) {
		background: rgba(124, 58, 237, 0.15);
		padding: 0.15rem 0.4rem;
		border-radius: 4px;
		font-size: 0.875em;
	}
	.brief :global(pre) {
		background: rgba(20, 18, 32, 0.7);
		border: 1px solid rgba(124, 58, 237, 0.2);
		border-radius: 8px;
		padding: 1rem;
		overflow-x: auto;
	}
	.brief :global(pre code) {
		background: none;
		padding: 0;
	}
	.brief :global(blockquote) {
		border-left: 3px solid rgba(124, 58, 237, 0.6);
		padding-left: 1rem;
		margin-left: 0;
		color: #b9b9d0;
		font-style: italic;
	}
	.brief :global(hr) {
		border: none;
		border-top: 1px solid rgba(124, 58, 237, 0.2);
		margin: 2rem 0;
	}
</style>
