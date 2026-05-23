import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteDocument } from '$lib/server/db';

export const DELETE: RequestHandler = ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convId = url.searchParams.get('conversation_id');
	if (!convId) throw error(400, 'missing conversation_id');
	if (!params.id) throw error(400, 'missing id');
	const ok = deleteDocument(params.id, convId);
	if (!ok) throw error(404, 'document not found');
	return json({ ok: true });
};
