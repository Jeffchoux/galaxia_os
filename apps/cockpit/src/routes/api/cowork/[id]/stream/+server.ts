import { error, type RequestHandler } from '@sveltejs/kit';
import {
	getCoworkTask,
	listCoworkSubtasks,
	type CoworkSubtask,
	type CoworkTask
} from '$lib/server/db';

// SSE de progression Cowork — réutilise EXACTEMENT le pattern ReadableStream /
// text-event-stream de /api/chat (event:/data:\n\n, headers no-cache + x-accel-
// buffering no, Caddy a flush_interval -1). Comme l'orchestrateur tourne dans un
// process séparé (galaxia-cowork.service) et écrit son avancement en base, ce
// endpoint POLLE les tables cowork et émet une frame à chaque transition d'état.
//
// Cf. contrat figé (SSE EVENTS) :
//   task    : snapshot complet, à la connexion + à chaque transition de statut tâche.
//   plan    : liste ordonnée des sous-tâches (DAG), après validation du PLAN, et
//             ré-émise quand l'état du gate change (approbations).
//   subtask : une frame par transition de statut de sous-tâche.
//   log     : une ligne brute du sandbox (stdout/stderr). Source live = process
//             orchestrateur ; tant qu'aucun canal de logs partagé n'est exposé en
//             base, ce endpoint n'en émet pas (le polling DB ne voit que les états).
//   done    : tâche en SYNTHESIZE réussie ; result = livrable final.
//   error   : tâche/sous-tâche en échec ; le stream se ferme ensuite.
//
// Le stream se ferme quand la tâche atteint un état terminal (done|error|killed).

// Intervalle de poll (ms). Court pour un suivi quasi temps réel sans surcharger
// la DB SQLite (lectures locales, WAL). Aligné sur la granularité d'un tick d'UI.
const POLL_MS = 700;

// Snapshot « projeté » d'une sous-tâche tel qu'envoyé au client (depends_on parsé,
// approved en booléen). On garde aussi output/error pour les frames de transition.
function projectSubtask(st: CoworkSubtask) {
	let depends_on: number[] = [];
	try {
		const parsed = JSON.parse(st.depends_on);
		if (Array.isArray(parsed)) depends_on = parsed.filter((n) => typeof n === 'number');
	} catch {
		/* depends_on malformé → [] */
	}
	return {
		id: st.id,
		seq: st.seq,
		title: st.title,
		description: st.description,
		risk: st.risk,
		depends_on,
		status: st.status,
		approved: st.approved === 1,
		output: st.output ?? undefined,
		error: st.error ?? undefined
	};
}

function taskSnapshot(task: CoworkTask) {
	return {
		id: task.id,
		goal: task.goal,
		status: task.status,
		cost_micros: task.cost_micros,
		created_at: task.created_at,
		updated_at: task.updated_at
	};
}

const TERMINAL: ReadonlySet<string> = new Set(['done', 'error', 'killed']);

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const userId = locals.user.id;
	const id = params.id;
	if (!id) throw error(400, 'id requis');

	// Garde de propriété : on refuse tôt si la tâche n'est pas à l'utilisateur.
	const initial = getCoworkTask(id, userId);
	if (!initial) throw error(404, 'tâche introuvable');

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			let timer: ReturnType<typeof setInterval> | null = null;

			const close = () => {
				if (closed) return;
				closed = true;
				if (timer) clearInterval(timer);
				try {
					controller.close();
				} catch {
					/* déjà fermé */
				}
			};

			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
					);
				} catch {
					// Le consommateur a coupé (navigation, fermeture d'onglet) → on stoppe le poll.
					close();
				}
			};

			// État précédent mémorisé pour ne diffuser QUE les transitions (mirroir
			// de la granularité « delta » du chat : une frame par changement).
			let lastTaskStatus: string | null = null;
			let lastTaskCost = -1;
			const lastSubStatus = new Map<string, string>();
			const lastSubApproved = new Map<string, boolean>();
			let planEmitted = false;

			const emitPlan = (subs: CoworkSubtask[]) => {
				send('plan', { subtasks: subs.map(projectSubtask) });
			};

			const poll = () => {
				if (closed) return;
				// Re-lecture scopée user à chaque tick : si la tâche disparaît (purge)
				// on ferme proprement.
				const task = getCoworkTask(id, userId);
				if (!task) {
					send('error', { message: 'tâche introuvable' });
					close();
					return;
				}

				const subs = listCoworkSubtasks(task.id);

				// 1) Transition de statut tâche (ou tout premier tick) → snapshot 'task'.
				if (task.status !== lastTaskStatus || task.cost_micros !== lastTaskCost) {
					send('task', taskSnapshot(task));
					lastTaskStatus = task.status;
					lastTaskCost = task.cost_micros;
				}

				// 2) Plan : émis dès qu'il y a des sous-tâches (PLAN validé), puis ré-émis
				// quand une approbation bascule (l'état du gate a changé).
				const gateChanged = subs.some(
					(st) => lastSubApproved.get(st.id) !== (st.approved === 1)
				);
				if (subs.length > 0 && (!planEmitted || gateChanged)) {
					emitPlan(subs);
					planEmitted = true;
				}

				// 3) Transitions de sous-tâches → une frame 'subtask' par changement.
				for (const st of subs) {
					const prev = lastSubStatus.get(st.id);
					if (prev !== st.status) {
						send('subtask', {
							id: st.id,
							seq: st.seq,
							status: st.status,
							risk: st.risk,
							output: st.output ?? undefined,
							error: st.error ?? undefined
						});
						lastSubStatus.set(st.id, st.status);
					}
					lastSubApproved.set(st.id, st.approved === 1);
				}

				// 4) États terminaux → frame finale puis fermeture.
				if (TERMINAL.has(task.status)) {
					if (task.status === 'done') {
						send('done', {
							ok: true,
							result: task.result ?? '',
							cost_micros: task.cost_micros
						});
					} else if (task.status === 'error') {
						send('error', { message: task.error ?? 'échec de la tâche' });
					} else {
						// killed : on l'a déjà reflété via la frame 'task' ; on signale la fin.
						send('error', { message: 'tâche interrompue (kill-switch)' });
					}
					close();
				}
			};

			// Tick immédiat (snapshot + plan à la connexion) puis poll périodique.
			poll();
			if (!closed) {
				timer = setInterval(poll, POLL_MS);
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			'x-accel-buffering': 'no'
		}
	});
};
