#!/usr/bin/env node
//
// Galaxia Cowork — orchestrateur autonome (daemon).
//
// Boucle infinie (service systemd galaxia-cowork.service). À chaque tour :
//
//   POLL        claimNextCoworkTask() prend atomiquement (BEGIN IMMEDIATE) la
//               plus vieille tâche 'pending' et la passe en 'planning'. Reprend
//               aussi les tâches déjà passées en 'awaiting_approval' pour détecter
//               les sous-tâches fraîchement approuvées (approved=1). Sinon dort
//               COWORK_POLL_SEC.
//   PLAN        query() (SDK Claude) avec COWORK_PLANNER_MODEL, outils en lecture
//               seule, décompose task.goal en un DAG de sous-tâches. Parse le bloc
//               <plan>...</plan>, valide via CoworkPlanSchema (Zod). insertCoworkSubtask
//               pour chacune, setCoworkTaskPlan, émet 'plan'.
//   GATE        calcule le besoin d'approbation par politique de risque. Les
//               sous-tâches 'consequential' passent 'awaiting_approval' ; si l'une
//               existe, la tâche → 'awaiting_approval' et on ne l'avance plus tant
//               que /approve n'a pas mis approved=1 (re-poll à chaque tour).
//   EXECUTE     tant qu'il reste des sous-tâches exécutables : claimRunnableCoworkSubtask
//               prend atomiquement une sous-tâche dont depends_on sont 'done' et le
//               gate franchi, la passe 'running'. spawn run-subtask.sh (detached /
//               start_new_session), pipe description + sorties amont sur stdin,
//               stream stdout/stderr → SSE 'log', updateCoworkSubtaskStatus. Honore
//               COWORK_SUBTASK_TIMEOUT (docker kill). Concurrence ≤ COWORK_MAX_CONCURRENCY.
//               Abandonne la tâche si cost_micros franchit COWORK_MAX_USD_PER_TASK.
//   SYNTHESIZE  toutes les sous-tâches done|skipped → tâche 'synthesizing'. Un dernier
//               query() agrège les sorties en livrable final → 'done'. Émet 'done'.
//
//   Kill-switch : une tâche passée 'killed' par /api/cowork/[id]/kill fait que le
//   daemon docker-kill cowork-<subtaskId> pour les enfants en cours et s'arrête.
//
// Économie de tokens (cf. agents/coder/index.mjs) : modèles GRATUITS/peu chers par
// défaut (Sonnet/Groq), Opus jamais en défaut ; prompt système statique → cache ;
// cap de coût dur ; pas de Date.now()/UUID dans le prompt système.

import { query } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { CoworkPlanSchema } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration (env, valeurs par défaut = politique « gratuit par défaut ») ──
// Accepte COWORK_DB_PATH (nom utilisé par l'unit systemd et docker-compose) ET
// COCKPIT_DB_PATH (alias historique). Sinon, chemin par défaut de la mère.
const DB_PATH =
  process.env.COWORK_DB_PATH ??
  process.env.COCKPIT_DB_PATH ??
  '/home/galaxia/galaxia-project/apps/cockpit/data/cockpit.db';
// Modèle du planner et de la synthèse : Sonnet par défaut (jamais Opus en défaut).
const PLANNER_MODEL = process.env.COWORK_PLANNER_MODEL ?? 'claude-sonnet-4-6';
// Modèle d'exécution in-sandbox (passé au wrapper, qui le passe au conteneur).
const EXEC_MODEL = process.env.COWORK_EXEC_MODEL ?? 'claude-sonnet-4-6';
const POLL_SEC = Number(process.env.COWORK_POLL_SEC ?? 3);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.COWORK_MAX_CONCURRENCY ?? 2));
const SUBTASK_TIMEOUT = Number(process.env.COWORK_SUBTASK_TIMEOUT ?? 600); // s
const MAX_USD_PER_TASK = Number(process.env.COWORK_MAX_USD_PER_TASK ?? 1.0);
const MAX_PLAN_TURNS = Number(process.env.COWORK_MAX_PLAN_TURNS ?? 20);
// Racine des run-dirs : un dossier par tâche, un sous-dossier /workspace par sous-tâche.
// COWORK_RUN_DIR : nom EXACT du contrat, posé par l'unit systemd et compose. Le
// défaut est un chemin inscriptible sous $HOME (déclaré en ReadWritePaths), pas
// sous le repo (qui est read-only avec ProtectSystem=strict + ProtectHome).
const RUN_ROOT = process.env.COWORK_RUN_DIR ?? '/home/galaxia/.local/share/galaxia/cowork';
const WRAPPER =
  process.env.COWORK_WRAPPER ??
  join(__dirname, 'sandbox', 'run-subtask.sh');

const MAX_USD_MICROS = Math.round(MAX_USD_PER_TASK * 1_000_000);

function log(...args) {
  console.error(`[cowork-orch ${new Date().toISOString()}]`, ...args);
}

// ─── Couche DB : SQL brut sur le MÊME fichier que le cockpit (db.ts). On mirroir
// exactement les fonctions/atomicité du contrat (BEGIN IMMEDIATE via .immediate()).
// Le daemon a besoin de l'écriture (claims, status) → pas de readonly. ───────────
function openDb() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`DB introuvable : ${DB_PATH} (le cockpit doit avoir migré au boot)`);
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 15000');
  return db;
}

const db = openDb();
const now = () => Date.now();

const q = {
  oldestPending: db.prepare(
    "SELECT id FROM cowork_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
  ),
  setTaskStatus: db.prepare('UPDATE cowork_tasks SET status = ?, updated_at = ? WHERE id = ?'),
  setTaskStatusFields: db.prepare(
    `UPDATE cowork_tasks SET status = ?,
     plan_json = COALESCE(?, plan_json),
     result    = COALESCE(?, result),
     error     = COALESCE(?, error),
     updated_at = ? WHERE id = ?`
  ),
  setTaskPlan: db.prepare('UPDATE cowork_tasks SET plan_json = ?, updated_at = ? WHERE id = ?'),
  addTaskCost: db.prepare(
    'UPDATE cowork_tasks SET cost_micros = cost_micros + ?, updated_at = ? WHERE id = ?'
  ),
  getTaskById: db.prepare('SELECT * FROM cowork_tasks WHERE id = ?'),
  awaitingTaskIds: db.prepare(
    "SELECT id FROM cowork_tasks WHERE status = 'awaiting_approval' ORDER BY created_at ASC"
  ),
  killedTaskIds: db.prepare(
    "SELECT id FROM cowork_tasks WHERE status = 'killed'"
  ),
  insertSubtask: db.prepare(
    'INSERT INTO cowork_subtasks (id, task_id, seq, title, description, risk, depends_on, status, approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  listSubtasks: db.prepare('SELECT * FROM cowork_subtasks WHERE task_id = ? ORDER BY seq ASC'),
  getSubtask: db.prepare('SELECT * FROM cowork_subtasks WHERE id = ?'),
  setSubtaskStatus: db.prepare(
    `UPDATE cowork_subtasks SET status = ?,
     output       = COALESCE(?, output),
     error        = COALESCE(?, error),
     container_id = COALESCE(?, container_id),
     updated_at = ? WHERE id = ?`
  ),
  runnableSubtasks: db.prepare(
    `SELECT * FROM cowork_subtasks WHERE task_id = ? AND status = 'pending'
     AND (risk = 'safe' OR approved = 1) ORDER BY seq ASC`
  ),
  claimSubtask: db.prepare(
    "UPDATE cowork_subtasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'"
  )
};

// Claim atomique de la plus vieille tâche pending → planning (BEGIN IMMEDIATE).
const _claimNextTask = db.transaction(() => {
  const row = q.oldestPending.get();
  if (!row) return null;
  q.setTaskStatus.run('planning', now(), row.id);
  return row.id;
});
function claimNextCoworkTask() {
  const id = _claimNextTask.immediate();
  return id ? q.getTaskById.get(id) : undefined;
}

// Claim atomique d'une sous-tâche exécutable : depends_on (index 0-based résolus
// via seq) tous 'done', gate franchi, pending→running.
const _claimRunnable = db.transaction((taskId) => {
  const all = q.listSubtasks.all(taskId);
  const doneSeqs = new Set(all.filter((s) => s.status === 'done').map((s) => s.seq));
  for (const st of q.runnableSubtasks.all(taskId)) {
    let deps = [];
    try {
      deps = JSON.parse(st.depends_on);
    } catch {
      deps = [];
    }
    if (deps.every((d) => doneSeqs.has(d))) {
      q.claimSubtask.run(now(), st.id);
      return st.id;
    }
  }
  return null;
});
function claimRunnableCoworkSubtask(taskId) {
  const id = _claimRunnable.immediate(taskId);
  return id ? q.getSubtask.get(id) : undefined;
}

function updateCoworkTaskStatus(id, status, fields) {
  if (fields && (fields.plan_json !== undefined || fields.result !== undefined || fields.error !== undefined)) {
    q.setTaskStatusFields.run(
      status,
      fields.plan_json ?? null,
      fields.result ?? null,
      fields.error ?? null,
      now(),
      id
    );
    return;
  }
  q.setTaskStatus.run(status, now(), id);
}

function updateCoworkSubtaskStatus(id, status, fields) {
  q.setSubtaskStatus.run(
    status,
    fields?.output ?? null,
    fields?.error ?? null,
    fields?.container_id ?? null,
    now(),
    id
  );
}

// ─── Bus SSE intra-processus. La route GET /api/cowork/[id]/stream s'abonne au
// même bus (via un module partagé côté cockpit) ; ici le daemon est un process
// séparé, donc on n'émet PAS directement vers les clients HTTP : on écrit l'état
// en base (source de vérité) et la route SSE relit la base à chaque transition.
// Cet émetteur reste utile pour le log local et un éventuel pont futur. ───────────
const bus = new EventEmitter();
function emit(taskId, event, data) {
  bus.emit('frame', { taskId, event, data });
  // Trace lisible côté journalctl, granularité « delta ».
  if (event === 'log') {
    log(`task=${taskId.slice(0, 8)} [${data.stream}] ${data.subtask_id.slice(0, 8)}: ${data.line}`);
  } else {
    log(`task=${taskId.slice(0, 8)} event=${event}`);
  }
}

function taskSnapshot(task) {
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    cost_micros: task.cost_micros,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function planFrame(subtasks) {
  return {
    subtasks: subtasks.map((s) => ({
      id: s.id,
      seq: s.seq,
      title: s.title,
      description: s.description,
      risk: s.risk,
      depends_on: safeParseDeps(s.depends_on),
      status: s.status,
      approved: s.approved === 1
    }))
  };
}

function safeParseDeps(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function isKilled(taskId) {
  const t = q.getTaskById.get(taskId);
  return !t || t.status === 'killed';
}

// ─── PLAN ─────────────────────────────────────────────────────────────────────
// Le prompt système est statique (fichier sur disque) → cache-friendly comme le
// coder. Tout le volatile (l'objectif) passe dans le prompt utilisateur.
const SYSTEM_PROMPT = readFileSync(join(__dirname, 'system-prompt.md'), 'utf8');

async function planTask(task) {
  emit(task.id, 'task', taskSnapshot(task));

  const userPrompt = [
    `## Objectif à décomposer`,
    ``,
    task.goal,
    ``,
    `Décompose cet objectif en un plan de 1 à 20 sous-tâches ordonnées, chacune`,
    `exécutable en autonomie dans un bac à sable jetable. Classe le risque de chaque`,
    `sous-tâche (safe / mutating / consequential) et déclare les dépendances par index`,
    `0-based vers des sous-tâches ANTÉRIEURES. Termine par le bloc <plan>...</plan>.`
  ].join('\n');

  log(`PLAN task=${task.id.slice(0, 8)} model=${PLANNER_MODEL}`);

  const result = query({
    prompt: userPrompt,
    options: {
      model: PLANNER_MODEL,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT },
      allowedTools: ['Read', 'Grep', 'Glob'], // lecture seule : on planifie, on n'exécute pas
      permissionMode: 'bypassPermissions',
      maxTurns: MAX_PLAN_TURNS,
      settingSources: [] // hermétique : aucun .claude/ local
    }
  });

  let finalText = '';
  let costUsd = 0;
  for await (const message of result) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') finalText = block.text;
      }
    } else if (message.type === 'result') {
      costUsd = message.total_cost_usd ?? 0;
    }
  }
  if (costUsd > 0) q.addTaskCost.run(Math.round(costUsd * 1_000_000), now(), task.id);

  const match = finalText.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!match) throw new Error('Le planner n\'a produit aucun bloc <plan>.');

  let parsed;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (e) {
    throw new Error(`Bloc <plan> illisible (JSON invalide) : ${e.message}`);
  }
  const validation = CoworkPlanSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      'Plan invalide : ' + JSON.stringify(validation.error.flatten().fieldErrors ?? validation.error.issues)
    );
  }
  const plan = validation.data;

  // Persiste les sous-tâches (seq = index dans la liste ; depends_on stocke les
  // index 0-based tels quels, résolus en seq à l'exécution).
  const insertAll = db.transaction(() => {
    plan.subtasks.forEach((st, i) => {
      const ts = now();
      q.insertSubtask.run(
        randomUUID(),
        task.id,
        i,
        st.title,
        st.description,
        st.risk,
        JSON.stringify(st.depends_on ?? []),
        'pending',
        0,
        ts,
        ts
      );
    });
  });
  insertAll();
  q.setTaskPlan.run(JSON.stringify(plan), now(), task.id);

  const subtasks = q.listSubtasks.all(task.id);
  emit(task.id, 'plan', planFrame(subtasks));
  return subtasks;
}

// ─── GATE ───────────────────────────────────────────────────────────────────────
// Politique de risque : 'consequential' force la porte d'approbation. On marque ces
// sous-tâches 'awaiting_approval' ; s'il en existe, la tâche passe 'awaiting_approval'
// et le daemon cesse de l'avancer jusqu'à ce que /approve mette approved=1.
// Retourne true si la tâche est mise en attente (gate actif), false sinon.
function applyGate(taskId) {
  const subtasks = q.listSubtasks.all(taskId);
  let gated = 0;
  const gate = db.transaction(() => {
    for (const st of subtasks) {
      if (st.risk === 'consequential' && st.approved !== 1 && st.status === 'pending') {
        q.setSubtaskStatus.run('awaiting_approval', null, null, null, now(), st.id);
        gated++;
      }
    }
  });
  gate();
  if (gated > 0) {
    updateCoworkTaskStatus(taskId, 'awaiting_approval');
    const refreshed = q.getTaskById.get(taskId);
    emit(taskId, 'task', taskSnapshot(refreshed));
    emit(taskId, 'plan', planFrame(q.listSubtasks.all(taskId)));
    log(`GATE task=${taskId.slice(0, 8)} : ${gated} sous-tâche(s) en attente d'approbation`);
    return true;
  }
  return false;
}

// ─── EXECUTE ─────────────────────────────────────────────────────────────────────
// Construit le prompt d'une sous-tâche : sa description + les sorties des amont (done).
function renderSubtaskInput(taskId, subtask) {
  const all = q.listSubtasks.all(taskId);
  const bySeq = new Map(all.map((s) => [s.seq, s]));
  const deps = safeParseDeps(subtask.depends_on);
  const upstream = deps
    .map((d) => bySeq.get(d))
    .filter((s) => s && s.output)
    .map((s) => `### Sortie de l'étape « ${s.title} »\n\n${s.output}`)
    .join('\n\n');
  return [
    `# Sous-tâche : ${subtask.title}`,
    ``,
    subtask.description,
    upstream ? `\n## Contexte des étapes précédentes\n\n${upstream}` : ``
  ]
    .filter(Boolean)
    .join('\n');
}

// Lance une sous-tâche dans le sandbox via le wrapper. Résout quand le process se
// termine. Stream stdout/stderr → SSE 'log'. La dernière ligne stdout DOIT être un
// JSON {ok,summary} → stocké comme output. Honore le timeout (docker kill via le
// nom déterministe cowork-<subtaskId>).
function runSubtask(task, subtask) {
  return new Promise((resolve) => {
    const workspace = join(RUN_ROOT, task.id, subtask.id);
    // Le wrapper exige un /workspace existant (il `die` sinon) : on le crée AVANT
    // le spawn. Échec de mkdir → la sous-tâche part en erreur proprement.
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (e) {
      updateCoworkSubtaskStatus(subtask.id, 'error', { error: `mkdir workspace: ${e.message}` });
      emit(task.id, 'subtask', { id: subtask.id, seq: subtask.seq, status: 'error', risk: subtask.risk, error: String(e.message) });
      resolve({ ok: false, summary: `mkdir workspace: ${e.message}` });
      return;
    }
    const containerName = `cowork-${subtask.id}`;
    // Réseau SOUVERAIN PAR DÉFAUT : coupé (`none`) pour TOUTES les sous-tâches,
    // safe comme mutating. L'egress n'est jamais accordé automatiquement (pas de
    // champ « besoin réseau » déclaré dans le plan) → aucune sous-tâche jetable ne
    // peut exfiltrer /workspace ni tirer un payload arbitraire. L'egress filtré
    // reste un opt-in explicite futur (cf. docs/COWORK.md).
    const net = 'none';

    updateCoworkSubtaskStatus(subtask.id, 'running', { container_id: containerName });
    emit(task.id, 'subtask', {
      id: subtask.id,
      seq: subtask.seq,
      status: 'running',
      risk: subtask.risk
    });

    const childEnv = {
      ...process.env,
      COWORK_WORKSPACE: workspace,
      COWORK_EXEC_MODEL: EXEC_MODEL,
      COWORK_NET: net,
      COWORK_SUBTASK_TIMEOUT: String(SUBTASK_TIMEOUT)
    };

    let child;
    try {
      child = spawn('bash', [WRAPPER, subtask.id], {
        cwd: RUN_ROOT,
        env: childEnv,
        detached: true, // start_new_session → groupe propre, kill-switch net
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      updateCoworkSubtaskStatus(subtask.id, 'error', { error: `spawn wrapper: ${e.message}` });
      emit(task.id, 'subtask', {
        id: subtask.id,
        seq: subtask.seq,
        status: 'error',
        risk: subtask.risk,
        error: e.message
      });
      resolve({ ok: false });
      return;
    }

    // Pipe la consigne rendue + contexte amont sur stdin du wrapper.
    try {
      child.stdin.write(renderSubtaskInput(task.id, subtask));
      child.stdin.end();
    } catch {
      /* le wrapper peut fermer stdin tôt — ignoré */
    }

    let lastJsonLine = null;
    let stdoutBuf = '';
    let stderrBuf = '';

    const onLine = (line, stream) => {
      if (!line.length) return;
      if (stream === 'stdout') {
        // La DERNIÈRE ligne JSON {ok,summary} fait foi pour l'output.
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed.ok === 'boolean') lastJsonLine = parsed;
          } catch {
            /* pas une ligne de résultat → simple log */
          }
        }
      }
      emit(task.id, 'log', {
        subtask_id: subtask.id,
        line,
        stream,
        ts: now()
      });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        onLine(stdoutBuf.slice(0, idx), 'stdout');
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        onLine(stderrBuf.slice(0, idx), 'stderr');
        stderrBuf = stderrBuf.slice(idx + 1);
      }
    });

    // Timeout dur : docker kill par nom (le wrapper a lancé `docker run --name
    // cowork-<id>`), puis SIGKILL du groupe en filet.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      dockerKill(containerName);
      killGroup(child);
    }, (SUBTASK_TIMEOUT + 15) * 1000);

    // Surveille le kill-switch tâche pendant l'exécution.
    const killWatch = setInterval(() => {
      if (isKilled(task.id)) {
        dockerKill(containerName);
        killGroup(child);
      }
    }, 1000);

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(killWatch);
      if (stdoutBuf.trim()) onLine(stdoutBuf, 'stdout');
      if (stderrBuf.trim()) onLine(stderrBuf, 'stderr');

      if (isKilled(task.id)) {
        updateCoworkSubtaskStatus(subtask.id, 'killed', { error: 'task killed' });
        emit(task.id, 'subtask', { id: subtask.id, seq: subtask.seq, status: 'killed', risk: subtask.risk });
        resolve({ ok: false, killed: true });
        return;
      }
      if (timedOut) {
        updateCoworkSubtaskStatus(subtask.id, 'error', { error: `timeout ${SUBTASK_TIMEOUT}s` });
        emit(task.id, 'subtask', {
          id: subtask.id,
          seq: subtask.seq,
          status: 'error',
          risk: subtask.risk,
          error: `timeout ${SUBTASK_TIMEOUT}s`
        });
        resolve({ ok: false });
        return;
      }
      const output = lastJsonLine ? JSON.stringify(lastJsonLine) : null;
      if (code === 0 && lastJsonLine && lastJsonLine.ok) {
        updateCoworkSubtaskStatus(subtask.id, 'done', { output });
        emit(task.id, 'subtask', {
          id: subtask.id,
          seq: subtask.seq,
          status: 'done',
          risk: subtask.risk,
          output: lastJsonLine.summary
        });
        resolve({ ok: true });
      } else {
        const err =
          lastJsonLine?.summary ?? stderrBuf.trim().slice(-500) ?? `exit ${code}`;
        updateCoworkSubtaskStatus(subtask.id, 'error', { output, error: err });
        emit(task.id, 'subtask', {
          id: subtask.id,
          seq: subtask.seq,
          status: 'error',
          risk: subtask.risk,
          error: err
        });
        resolve({ ok: false });
      }
    });
  });
}

function dockerKill(name) {
  try {
    const k = spawn('docker', ['kill', name], { stdio: 'ignore' });
    k.on('error', () => {});
  } catch {
    /* docker absent / conteneur déjà parti — best effort */
  }
}

function killGroup(child) {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL'); // -pid = groupe (detached)
  } catch {
    /* déjà mort */
  }
}

// Exécute toutes les sous-tâches runnables, jusqu'à MAX_CONCURRENCY en parallèle.
// S'arrête si la tâche est killed ou si le cap de coût est franchi.
async function executeTask(task) {
  const running = new Set();

  for (;;) {
    if (isKilled(task.id)) {
      log(`EXECUTE task=${task.id.slice(0, 8)} : kill-switch détecté, arrêt`);
      await Promise.allSettled([...running]);
      return { killed: true };
    }

    const fresh = q.getTaskById.get(task.id);
    if (fresh.cost_micros >= MAX_USD_MICROS) {
      log(`EXECUTE task=${task.id.slice(0, 8)} : cap de coût atteint ($${MAX_USD_PER_TASK}), abandon`);
      await Promise.allSettled([...running]);
      return { costAborted: true };
    }

    // Démarre autant de sous-tâches que la concurrence le permet.
    while (running.size < MAX_CONCURRENCY) {
      const subtask = claimRunnableCoworkSubtask(task.id);
      if (!subtask) break;
      const p = runSubtask(task, subtask).finally(() => running.delete(p));
      running.add(p);
    }

    if (running.size === 0) {
      // Aucune en cours et aucune à démarrer → soit tout est fini, soit on est
      // bloqué (sous-tâches en attente d'approbation ou amont en échec).
      const subs = q.listSubtasks.all(task.id);
      const pendingWork = subs.some((s) =>
        ['pending', 'running', 'blocked'].includes(s.status)
      );
      if (!pendingWork) return { done: true };
      // Reste des 'pending' non démarrables (gate non franchi) → on rend la main au
      // POLL, qui re-vérifiera après une éventuelle approbation. On ne boucle pas à vide.
      return { gated: true };
    }

    // Attend qu'au moins une sous-tâche se termine avant de re-tenter un claim.
    await Promise.race([...running]);
  }
}

// ─── SYNTHESIZE ──────────────────────────────────────────────────────────────────
async function synthesizeTask(task) {
  updateCoworkTaskStatus(task.id, 'synthesizing');
  emit(task.id, 'task', taskSnapshot(q.getTaskById.get(task.id)));

  const subtasks = q.listSubtasks.all(task.id);
  const outputs = subtasks
    .map((s) => {
      const status = s.status === 'done' ? 'OK' : s.status;
      let summary = '(pas de sortie)';
      if (s.output) {
        try {
          summary = JSON.parse(s.output).summary ?? s.output;
        } catch {
          summary = s.output;
        }
      }
      return `### Étape ${s.seq + 1} — ${s.title} [${status}]\n\n${summary}`;
    })
    .join('\n\n');

  const userPrompt = [
    `## Objectif initial`,
    ``,
    task.goal,
    ``,
    `## Résultats des sous-tâches`,
    ``,
    outputs,
    ``,
    `## Ta tâche`,
    ``,
    `Agrège les résultats ci-dessus en UN livrable final clair et directement`,
    `utilisable, rédigé en français pour un dirigeant non technique. Pas de bloc`,
    `<plan> ici : produis le livrable en texte. Si certaines étapes ont échoué ou`,
    `n'ont pas été approuvées, dis honnêtement ce qui manque.`
  ].join('\n');

  log(`SYNTHESIZE task=${task.id.slice(0, 8)} model=${PLANNER_MODEL}`);
  const result = query({
    prompt: userPrompt,
    options: {
      model: PLANNER_MODEL,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT },
      allowedTools: [], // synthèse pure : aucun outil
      permissionMode: 'bypassPermissions',
      maxTurns: 4,
      settingSources: []
    }
  });

  let finalText = '';
  let costUsd = 0;
  for await (const message of result) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') finalText += block.text;
      }
    } else if (message.type === 'result') {
      costUsd = message.total_cost_usd ?? 0;
    }
  }
  if (costUsd > 0) q.addTaskCost.run(Math.round(costUsd * 1_000_000), now(), task.id);

  const deliverable = finalText.trim() || '(synthèse vide)';
  updateCoworkTaskStatus(task.id, 'done', { result: deliverable });
  const finalTask = q.getTaskById.get(task.id);
  emit(task.id, 'task', taskSnapshot(finalTask));
  emit(task.id, 'done', { ok: true, result: deliverable, cost_micros: finalTask.cost_micros });
}

// À la finalisation, les sous-tâches conséquentes jamais approuvées passent
// 'skipped' (politique : ne jamais exécuter sans approbation explicite).
function skipUnapproved(taskId) {
  const subs = q.listSubtasks.all(taskId);
  const skip = db.transaction(() => {
    for (const s of subs) {
      if (s.status === 'awaiting_approval' && s.approved !== 1) {
        q.setSubtaskStatus.run('skipped', null, 'jamais approuvée', null, now(), s.id);
      }
    }
  });
  skip();
}

// Pilote une tâche du PLAN jusqu'à done|error, en respectant le gate.
async function advanceTask(task) {
  try {
    // PLAN (uniquement si on vient de la claimer → status 'planning' sans plan).
    if (task.status === 'planning') {
      await planTask(task);
    }

    // GATE : si des sous-tâches conséquentes attendent, on met en attente et on
    // rend la main (le POLL reprendra après approbation).
    if (applyGate(task.id)) return;

    // EXECUTE.
    updateCoworkTaskStatus(task.id, 'running');
    emit(task.id, 'task', taskSnapshot(q.getTaskById.get(task.id)));
    const exec = await executeTask(task);

    if (exec.killed) return; // kill-switch : le statut 'killed' a déjà été posé par /kill
    if (exec.costAborted) {
      updateCoworkTaskStatus(task.id, 'error', { error: `cap de coût $${MAX_USD_PER_TASK} dépassé` });
      emit(task.id, 'error', { message: `cap de coût $${MAX_USD_PER_TASK} dépassé` });
      return;
    }
    if (exec.gated) {
      // Il reste des sous-tâches en attente d'approbation → on remet la tâche en
      // attente et on rend la main au POLL.
      updateCoworkTaskStatus(task.id, 'awaiting_approval');
      emit(task.id, 'task', taskSnapshot(q.getTaskById.get(task.id)));
      return;
    }

    // Tout est done|skipped|error. Si une sous-tâche a échoué (hors skipped),
    // la tâche est en erreur ; sinon on synthétise.
    skipUnapproved(task.id);
    const subs = q.listSubtasks.all(task.id);
    const failed = subs.find((s) => s.status === 'error');
    if (failed) {
      updateCoworkTaskStatus(task.id, 'error', {
        error: `sous-tâche « ${failed.title} » en échec : ${failed.error ?? 'inconnue'}`
      });
      emit(task.id, 'error', {
        message: failed.error ?? `sous-tâche ${failed.title} en échec`,
        subtask_id: failed.id
      });
      return;
    }
    await synthesizeTask(task);
  } catch (e) {
    log(`task=${task.id.slice(0, 8)} ERREUR: ${e.stack ?? e.message ?? e}`);
    updateCoworkTaskStatus(task.id, 'error', { error: String(e.message ?? e) });
    emit(task.id, 'error', { message: String(e.message ?? e) });
  }
}

// Reprend une tâche déjà en 'awaiting_approval' : si des sous-tâches ont été
// approuvées (approved=1, repassées 'pending' par /approve), on relance EXECUTE.
async function resumeAwaitingTask(taskId) {
  const subs = q.listSubtasks.all(taskId);
  const stillGated = subs.some((s) => s.status === 'awaiting_approval' && s.approved !== 1);
  const hasRunnable = subs.some((s) => s.status === 'pending');
  if (hasRunnable) {
    const task = q.getTaskById.get(taskId);
    // applyGate ne remettra plus en attente les approuvées (elles sont 'pending').
    await advanceTask({ ...task, status: 'running' });
    return;
  }
  if (!stillGated) {
    // Plus rien en attente ni runnable : finalise (skip + synth/error).
    const task = q.getTaskById.get(taskId);
    await advanceTask({ ...task, status: 'running' });
  }
  // Sinon : encore en attente d'approbation → on ne fait rien, prochain poll.
}

// ─── Boucle daemon ──────────────────────────────────────────────────────────────
let stopping = false;

async function loop() {
  log(`démarré — db=${DB_PATH} planner=${PLANNER_MODEL} exec=${EXEC_MODEL} poll=${POLL_SEC}s`);
  await mkdir(RUN_ROOT, { recursive: true }).catch(() => {});

  while (!stopping) {
    try {
      // 1) Tâches killed avec conteneurs en cours : docker kill best-effort.
      for (const { id } of q.killedTaskIds.all()) {
        for (const s of q.listSubtasks.all(id)) {
          if (s.status === 'running' && s.container_id) dockerKill(s.container_id);
        }
      }

      // 2) Reprend les tâches en attente d'approbation (approbations fraîches ?).
      for (const { id } of q.awaitingTaskIds.all()) {
        await resumeAwaitingTask(id);
      }

      // 3) Claim une nouvelle tâche pending → planning.
      const task = claimNextCoworkTask();
      if (task) {
        await advanceTask(task);
        continue; // enchaîne sans dormir tant qu'il y a du travail
      }
    } catch (e) {
      log(`boucle: ${e.stack ?? e.message ?? e}`);
    }
    await sleep(POLL_SEC * 1000);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`signal ${sig} reçu — arrêt propre`);
    stopping = true;
    setTimeout(() => process.exit(0), 500);
  });
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.COWORK_API_KEY) {
  log('ATTENTION : ni ANTHROPIC_API_KEY ni COWORK_API_KEY dans l\'env — le planner échouera.');
}

loop().catch((e) => {
  log('Fatal:', e.stack ?? e);
  process.exit(1);
});
