import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getCoworkTask, listCoworkSubtasks } from '$lib/server/db';

// GET /api/cowork/[id] — détail d'une tâche Cowork (scopée à l'utilisateur) +
// la liste de ses sous-tâches (le DAG du plan). 404 si la tâche n'existe pas ou
// n'appartient pas à l'utilisateur. Cf. contrat figé.
export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id requis');
	const task = getCoworkTask(id, locals.user.id);
	if (!task) throw error(404, 'tâche introuvable');
	const subtasks = listCoworkSubtasks(task.id);
	return json({ task, subtasks });
};
