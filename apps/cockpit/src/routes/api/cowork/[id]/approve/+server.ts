import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	approveAllCoworkSubtasks,
	approveCoworkSubtask,
	getCoworkTask
} from '$lib/server/db';

// POST /api/cowork/[id]/approve — porte d'approbation humaine (APPROVAL GATE).
//   req: { subtask_id?: string }
//     - avec subtask_id : approuve UNE sous-tâche en attente (awaiting_approval).
//     - sans subtask_id : approuve TOUTES les sous-tâches awaiting_approval de la tâche.
//   res: 200 { approved: number }  (nb de sous-tâches sorties de la porte)
// L'orchestrateur reprend l'exécution des sous-tâches approuvées (approved=1) au
// prochain poll. Posture souveraine : rien de « consequential » ne part sans ce feu vert.
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id requis');

	// Garde de propriété : la tâche doit appartenir à l'utilisateur.
	const task = getCoworkTask(id, locals.user.id);
	if (!task) throw error(404, 'tâche introuvable');

	const body = (await request.json().catch(() => ({}))) as { subtask_id?: unknown };
	const subtaskId = typeof body.subtask_id === 'string' ? body.subtask_id : null;

	let approved: number;
	if (subtaskId) {
		approved = approveCoworkSubtask(subtaskId, locals.user.id) ? 1 : 0;
	} else {
		approved = approveAllCoworkSubtasks(task.id, locals.user.id);
	}
	return json({ approved });
};
