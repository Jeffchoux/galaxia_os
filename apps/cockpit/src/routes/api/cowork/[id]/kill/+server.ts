import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getCoworkTask, killCoworkTask } from '$lib/server/db';

// POST /api/cowork/[id]/kill — kill-switch. Marque la tâche 'killed' ; au prochain
// poll l'orchestrateur fait `docker kill cowork-<subtaskId>` sur les conteneurs en
// cours et arrête l'avancement. Idempotent : renvoie killed=false si la tâche était
// déjà terminale (done|error|killed).
//   res: 200 { ok: true, killed: boolean }
export const POST: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id requis');

	// Garde de propriété.
	const task = getCoworkTask(id, locals.user.id);
	if (!task) throw error(404, 'tâche introuvable');

	const killed = killCoworkTask(task.id, locals.user.id);
	return json({ ok: true, killed });
};
