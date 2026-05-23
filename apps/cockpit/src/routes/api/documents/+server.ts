import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	createDocument,
	getConversation,
	listConversationDocuments
} from '$lib/server/db';

const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (limite Anthropic vision)

const IMAGE_MIMES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif'
]);

const ALLOWED_MIME = new Set([
	'application/pdf',
	'text/plain',
	'text/markdown',
	'text/x-markdown',
	...IMAGE_MIMES
]);

function inferMime(filename: string, declared: string): string {
	if (declared && ALLOWED_MIME.has(declared)) return declared;
	const lower = filename.toLowerCase();
	if (lower.endsWith('.pdf')) return 'application/pdf';
	if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
	if (lower.endsWith('.txt')) return 'text/plain';
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
	if (lower.endsWith('.png')) return 'image/png';
	if (lower.endsWith('.webp')) return 'image/webp';
	if (lower.endsWith('.gif')) return 'image/gif';
	return declared;
}

export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convId = url.searchParams.get('conversation_id');
	if (!convId) throw error(400, 'missing conversation_id');
	const conv = getConversation(convId);
	if (!conv) throw error(404, 'conversation not found');
	return json({ documents: listConversationDocuments(convId) });
};

export const POST: RequestHandler = async ({ request, url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convId = url.searchParams.get('conversation_id');
	if (!convId) throw error(400, 'missing conversation_id');
	const conv = getConversation(convId);
	if (!conv) throw error(404, 'conversation not found');

	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File)) throw error(400, 'no file');

	const mime = inferMime(file.name, file.type);
	if (!ALLOWED_MIME.has(mime)) {
		throw error(
			415,
			`type non supporté : ${mime || 'inconnu'} (PDF / Markdown / TXT / Image)`
		);
	}

	const isPdf = mime === 'application/pdf';
	const isImage = IMAGE_MIMES.has(mime);
	const isBinary = isPdf || isImage;
	const max = isImage ? MAX_IMAGE_BYTES : isPdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
	if (file.size > max) {
		throw error(413, `fichier trop gros (max ${Math.floor(max / 1024 / 1024)} Mo)`);
	}

	const buf = Buffer.from(await file.arrayBuffer());
	const filename = file.name.slice(0, 200);

	const doc = createDocument({
		conversation_id: convId,
		filename,
		mime_type: mime,
		content_text: isBinary ? null : buf.toString('utf-8'),
		content_b64: isBinary ? buf.toString('base64') : null,
		size: file.size
	});

	return json({ document: doc });
};
