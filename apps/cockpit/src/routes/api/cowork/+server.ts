import { error, json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createCoworkTask, listCoworkTasks } from '$lib/server/db';

// Cowork (orchestrateur autonome) — création & listing des tâches, derrière l'auth
// cockpit. La tâche est créée en statut 'pending' ; le daemon orchestrateur
// (galaxia-cowork.service) la récupère via claimNextCoworkTask() et la fait passer
// par PLAN → GATE → EXECUTE → SYNTHESIZE. Le suivi temps réel se fait via le SSE
// /api/cowork/[id]/stream. Cf. contrat figé (FROZEN SHARED CONTRACT).

// Modèle planner par défaut. Politique de Jeff : « pas de modèle premium par
// défaut » → Sonnet (gratuit/peu cher). Opus uniquement sur escalade explicite
// (le client passe alors model dans le POST). Lu paresseusement de l'env.
const defaultPlannerModel = () => env.COWORK_PLANNER_MODEL ?? 'claude-sonnet-4-6';

// POST /api/cowork — crée une tâche Cowork à partir d'un objectif.
//   req:  { goal: string, model?: string }
//   res:  201 { task: CoworkTask }  (statut 'pending')
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const body = (await request.json().catch(() => ({}))) as {
		goal?: unknown;
		model?: unknown;
	};
	const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
	if (!goal) throw error(400, 'goal requis');

	// model optionnel : si absent/vide on retombe sur COWORK_PLANNER_MODEL.
	const model =
		typeof body.model === 'string' && body.model.trim()
			? body.model.trim()
			: defaultPlannerModel();

	const task = createCoworkTask(locals.user.id, goal, model);
	return json({ task }, { status: 201 });
};

// GET /api/cowork — liste les tâches Cowork de l'utilisateur (les plus récentes
// d'abord, limite 50).
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const tasks = listCoworkTasks(locals.user.id, 50);
	return json({ tasks });
};
