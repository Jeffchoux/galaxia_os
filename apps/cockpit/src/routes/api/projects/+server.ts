import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createProject, deleteProject, renameProject } from '$lib/server/db';

// Crée un projet (regroupement de conversations, style Claude Code).
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const { name } = await request.json().catch(() => ({ name: '' }));
	const project = createProject(locals.user.id, typeof name === 'string' ? name : '');
	return json({ project });
};

// Renomme un projet existant.
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const { id, name } = await request.json().catch(() => ({}));
	if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) {
		throw error(400, 'id et name requis');
	}
	renameProject(id, locals.user.id, name);
	return json({ ok: true });
};

// Supprime un projet ; ses conversations repassent « hors projet ».
export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const { id } = await request.json().catch(() => ({}));
	if (typeof id !== 'string') throw error(400, 'id requis');
	const ok = deleteProject(id, locals.user.id);
	return json({ ok });
};
