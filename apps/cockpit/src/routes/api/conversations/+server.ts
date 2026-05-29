import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createConversation, setConversationProject } from '$lib/server/db';

// Crée une conversation vide. Utilisé par le client quand on veut attacher
// un document avant d'avoir échangé un premier message, ou démarrer une
// conversation directement dans un projet (project_id optionnel).
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const body = await request.json().catch(() => ({}));
	const projectId = typeof body?.project_id === 'string' ? body.project_id : null;
	const conv = createConversation(locals.user.id, undefined, projectId);
	return json({ conversation: conv });
};

// Range (ou sort, si project_id = null) une conversation dans un projet.
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const { id, project_id } = await request.json().catch(() => ({}));
	if (typeof id !== 'string') throw error(400, 'id requis');
	const pid = typeof project_id === 'string' ? project_id : null;
	setConversationProject(id, locals.user.id, pid);
	return json({ ok: true });
};
