import { error, json, type RequestHandler } from '@sveltejs/kit';
import { marked } from 'marked';
import { deleteDocument, getDocument } from '$lib/server/db';

function htmlPreview(filename: string, body: string, isMarkdown: boolean): string {
	const inner = isMarkdown
		? (marked.parse(body, { gfm: true, breaks: true }) as string)
		: `<pre>${body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)}</pre>`;
	const safeTitle = filename.replace(/[<>&]/g, '');
	return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; padding: 2rem 1.75rem; background: #ffffff; color: #1a1a1a;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.6; }
h1 { font-size: 1.7rem; margin: 0 0 1rem; letter-spacing: -0.01em; }
h2 { font-size: 1.2rem; color: #e8380d; margin: 1.75rem 0 0.5rem;
  border-bottom: 1px solid rgba(232,56,13,0.16); padding-bottom: 0.3rem; }
h3 { font-size: 1.02rem; margin: 1.2rem 0 0.4rem; }
p { margin: 0 0 0.9rem; }
strong { color: #1a1a1a; }
a { color: #e8380d; text-decoration: underline; text-decoration-color: rgba(232,56,13,0.5); }
a:hover { text-decoration-color: #e8380d; }
ul, ol { padding-left: 1.4rem; }
li { margin-bottom: 0.35rem; }
code { background: rgba(232,56,13,0.12); padding: 0.12rem 0.35rem; border-radius: 4px; font-size: 0.88em; }
pre { background: #f5f5f5; border: 1px solid rgba(232,56,13,0.16); border-radius: 8px;
  padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid rgba(232,56,13,0.5); padding-left: 0.9rem; margin-left: 0;
  color: #6b6b6b; font-style: italic; }
hr { border: none; border-top: 1px solid rgba(232,56,13,0.16); margin: 1.5rem 0; }
</style></head><body>${inner}</body></html>`;
}

// Sert le document pour preview : PDF en binaire (iframe natif),
// markdown/txt rendu en HTML stylé (iframe également).
export const GET: RequestHandler = ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convId = url.searchParams.get('conversation_id');
	if (!convId) throw error(400, 'missing conversation_id');
	if (!params.id) throw error(400, 'missing id');
	const doc = getDocument(params.id, locals.user.id);
	if (!doc || doc.conversation_id !== convId) throw error(404, 'document not found');

	// Mode brut (?raw=1) : renvoie le texte du document en JSON pour un rendu
	// inline côté client (onglet Doc du panneau Arfa). Réservé au texte/code —
	// les binaires (PDF, images) restent servis en natif via l'iframe.
	if (url.searchParams.get('raw')) {
		if (doc.content_text === null) throw error(415, 'document binaire');
		return json({ filename: doc.filename, mime_type: doc.mime_type, content: doc.content_text });
	}

	// Binaires (PDF + images) → on sert le contenu natif, le browser sait afficher
	if (doc.content_b64 && (doc.mime_type === 'application/pdf' || doc.mime_type.startsWith('image/'))) {
		const buf = Buffer.from(doc.content_b64, 'base64');
		return new Response(buf, {
			headers: {
				'content-type': doc.mime_type,
				'content-disposition': `inline; filename="${doc.filename.replace(/"/g, '')}"`,
				'cache-control': 'private, max-age=300'
			}
		});
	}

	const isMd = doc.mime_type.includes('markdown') || doc.filename.toLowerCase().endsWith('.md');
	const html = htmlPreview(doc.filename, doc.content_text ?? '', isMd);
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'private, max-age=300'
		}
	});
};

export const DELETE: RequestHandler = ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convId = url.searchParams.get('conversation_id');
	if (!convId) throw error(400, 'missing conversation_id');
	if (!params.id) throw error(400, 'missing id');
	const ok = deleteDocument(params.id, convId, locals.user.id);
	if (!ok) throw error(404, 'document not found');
	return json({ ok: true });
};
