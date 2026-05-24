<script lang="ts">
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	type Doc = (typeof data.documents)[number];
	let previewDoc = $state<Doc | null>(null);

	function fmtDate(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleString('fr-FR', {
			day: '2-digit',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
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

	function shortType(mime: string): string {
		if (mime === 'application/pdf') return 'PDF';
		if (mime === 'image/jpeg') return 'JPEG';
		if (mime === 'image/png') return 'PNG';
		if (mime === 'image/webp') return 'WebP';
		if (mime === 'image/gif') return 'GIF';
		if (mime.includes('markdown')) return 'Markdown';
		if (mime === 'text/plain') return 'TXT';
		return mime;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') previewDoc = null;
	}
</script>

<svelte:head>
	<title>Documents Galaxia</title>
</svelte:head>

<div class="wrap">
	<header class="page-header">
		<a href="/" class="back">← Cockpit</a>
		<h1>Documents</h1>
		<p class="sub">
			{data.documents.length} document{data.documents.length > 1 ? 's' : ''} attaché{data
				.documents.length > 1
				? 's'
				: ''} à des conversations Galaxia.
		</p>
	</header>

	{#if data.documents.length === 0}
		<div class="empty">
			<p>Aucun document pour l'instant.</p>
			<p class="hint">
				Drag-drop un fichier dans une conversation, ou envoie-le via le bot Telegram.
			</p>
		</div>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th class="col-icon"></th>
						<th>Nom</th>
						<th class="col-meta">Type</th>
						<th class="col-meta">Taille</th>
						<th>Conversation</th>
						<th class="col-meta">Date</th>
					</tr>
				</thead>
				<tbody>
					{#each data.documents as doc (doc.id)}
						<tr onclick={() => (previewDoc = doc)} class="row">
							<td class="col-icon">{docIcon(doc.mime_type)}</td>
							<td class="col-name" title={doc.filename}>{doc.filename}</td>
							<td class="col-meta mono">{shortType(doc.mime_type)}</td>
							<td class="col-meta mono">{fmtBytes(doc.size)}</td>
							<td class="col-conv">
								<a href="/?c={doc.conversation_id}" onclick={(e) => e.stopPropagation()}>
									{doc.conversation_title}
								</a>
							</td>
							<td class="col-meta mono">{fmtDate(doc.uploaded_at)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

{#if previewDoc}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="preview-backdrop" onclick={() => (previewDoc = null)} tabindex="-1">
		<div
			class="preview-modal"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-label="Aperçu de {previewDoc.filename}"
			tabindex="-1"
		>
			<header class="preview-head">
				<span class="preview-icon">{docIcon(previewDoc.mime_type)}</span>
				<span class="preview-name">{previewDoc.filename}</span>
				<span class="preview-meta">{fmtBytes(previewDoc.size)}</span>
				<a
					class="preview-dl"
					href={`/api/documents/${previewDoc.id}?conversation_id=${previewDoc.conversation_id}`}
					target="_blank"
					rel="noopener"
					title="Ouvrir dans un nouvel onglet"
				>↗</a>
				<button class="preview-close" onclick={() => (previewDoc = null)} aria-label="Fermer">×</button>
			</header>
			<iframe
				class="preview-iframe"
				title={previewDoc.filename}
				src={`/api/documents/${previewDoc.id}?conversation_id=${previewDoc.conversation_id}`}
			></iframe>
		</div>
	</div>
{/if}

<svelte:window onkeydown={onKey} />

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
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	.page-header {
		margin-bottom: 1.5rem;
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

	.table-wrap {
		background: rgba(20, 18, 32, 0.4);
		border: 1px solid rgba(124, 58, 237, 0.15);
		border-radius: 12px;
		overflow: hidden;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	thead th {
		text-align: left;
		padding: 0.75rem 0.85rem;
		background: rgba(20, 18, 32, 0.7);
		color: #b9b9d0;
		font-weight: 600;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-bottom: 1px solid rgba(124, 58, 237, 0.2);
	}
	tbody td {
		padding: 0.6rem 0.85rem;
		border-bottom: 1px solid rgba(124, 58, 237, 0.08);
		vertical-align: middle;
	}
	tbody tr.row {
		cursor: pointer;
		transition: background 0.1s;
	}
	tbody tr.row:hover {
		background: rgba(124, 58, 237, 0.08);
	}
	.col-icon {
		width: 32px;
		font-size: 1.05rem;
	}
	.col-name {
		font-weight: 500;
		color: #fff;
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.col-meta {
		color: #8e8ea8;
		white-space: nowrap;
	}
	.col-conv a {
		color: #c084fc;
		text-decoration: none;
	}
	.col-conv a:hover {
		text-decoration: underline;
	}
	.mono {
		font-feature-settings: 'tnum';
		font-variant-numeric: tabular-nums;
	}
	.empty {
		text-align: center;
		padding: 4rem 1rem;
		color: #6b6b85;
	}
	.empty .hint {
		font-size: 0.875rem;
		max-width: 420px;
		margin: 0.75rem auto 0;
	}

	/* preview modal — copié-collé du cockpit (V2 : factoriser) */
	.preview-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(5, 5, 12, 0.78);
		backdrop-filter: blur(4px);
		display: grid;
		place-items: center;
		z-index: 100;
		padding: 2rem;
	}
	.preview-modal {
		display: flex;
		flex-direction: column;
		width: min(900px, 96vw);
		height: min(85vh, 900px);
		background: #0c0a18;
		border: 1px solid rgba(124, 58, 237, 0.3);
		border-radius: 12px;
		overflow: hidden;
	}
	.preview-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid rgba(124, 58, 237, 0.2);
		background: rgba(20, 18, 32, 0.5);
	}
	.preview-icon {
		font-size: 1.1rem;
	}
	.preview-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		color: #fff;
	}
	.preview-meta {
		color: #6b6b85;
		font-size: 0.8rem;
	}
	.preview-dl,
	.preview-close {
		width: 2rem;
		height: 2rem;
		display: grid;
		place-items: center;
		background: rgba(124, 58, 237, 0.15);
		color: #b9b9d0;
		border: 1px solid rgba(124, 58, 237, 0.25);
		border-radius: 6px;
		text-decoration: none;
		font-size: 1.1rem;
		cursor: pointer;
		line-height: 1;
	}
	.preview-dl:hover,
	.preview-close:hover {
		background: rgba(124, 58, 237, 0.3);
		color: #fff;
	}
	.preview-iframe {
		flex: 1;
		width: 100%;
		border: none;
		background: #07060c;
	}
</style>
