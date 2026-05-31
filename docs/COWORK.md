# Galaxia Cowork — architecture

> **Doc de référence du chantier Cowork.** Écrite pour deux lecteurs : un
> manager non-dev qui veut comprendre **ce que fait le produit**, et un dev
> qui doit **l'exploiter**. Au 2026-05-31 le code vit sur la branche
> `feat/cockpit-cowork-autonomous` (worktree `/home/galaxia/cowork-build`),
> **pas encore déployé, vérification en attente** — cf. [`STATUS.md`](STATUS.md).

---

## 1. Ce que c'est, en une phrase

Le manager donne un **objectif** (« prépare une synthèse comparative de nos
trois fournisseurs à partir des PDF dans le projet »), et Galaxia s'en charge
**toute seule** : elle découpe le travail, demande la validation humaine pour
les étapes à conséquence, exécute chaque étape dans une boîte étanche, puis
rend un **livrable** unique. Le manager suit l'avancement en direct dans le
cockpit, comme une conversation.

Là où le **chat** répond à un message et où le **mode Code** édite le repo,
**Cowork** prend en charge un objectif **multi-étapes** de bout en bout, sans
que le manager ait à piloter chaque sous-tâche.

---

## 2. Le cycle de vie d'une tâche (goal → plan → gate → exécution → livrable)

```
  Objectif (goal)
       │
       ▼
  ┌─────────┐   le planner (LLM) décompose l'objectif en un DAG de sous-tâches
  │  PLAN   │   ordonnées, chacune étiquetée d'un niveau de risque
  └────┬────┘
       │
       ▼
  ┌─────────┐   APPROBATION HUMAINE pour les sous-tâches « conséquentes »
  │  GATE   │   (irréversibles / sortent de la boîte). Le reste passe seul.
  └────┬────┘
       │
       ▼
  ┌─────────┐   chaque sous-tâche tourne dans un conteneur Docker jetable,
  │ EXECUTE │   isolé, sans réseau par défaut ; les sorties s'enchaînent
  └────┬────┘   selon les dépendances (DAG)
       │
       ▼
  ┌──────────────┐  un dernier appel LLM agrège les sorties en un seul
  │  SYNTHESIZE  │  livrable, stocké et renvoyé au manager
  └──────┬───────┘
         │
         ▼
     Livrable (result)
```

Les statuts d'une **tâche** :
`pending → planning → awaiting_approval → running → synthesizing → done`
(ou `error`, ou `killed` si le manager coupe).

Les statuts d'une **sous-tâche** :
`pending → blocked → awaiting_approval → running → done`
(ou `error`, `skipped`, `killed`).

### 2.1. PLAN — décomposition en DAG

Le **planner** est un appel au Claude Agent SDK (`query()`) avec un modèle
**gratuit/peu cher par défaut** (`COWORK_PLANNER_MODEL`, défaut
`claude-sonnet-4-6` ; jamais Opus par défaut, cf. politique modèle Galaxia).
Il a un accès **lecture seule** (`Read`, `Grep`, `Glob`) pour comprendre le
contexte, et rend une liste **ordonnée** de sous-tâches dans un bloc
`<plan>…</plan>` JSON. Chaque sous-tâche déclare :

- un `title` et une `description`,
- un niveau de `risk` (`safe` / `mutating` / `consequential`),
- ses `depends_on` (indices de sous-tâches **antérieures** dans la liste).

Le plan est validé par un schéma **Zod** (`CoworkPlanSchema`) : 1 à 20
sous-tâches, et **toute dépendance vers une sous-tâche d'indice ≥ à soi est
rejetée** → le graphe est acyclique **par construction**. Plan invalide ⇒ la
tâche passe en `error` (on ne devine pas, on refuse).

### 2.2. GATE — le garde-fou humain

C'est le cœur de la posture **souveraine et conservatrice** de Galaxia. Trois
niveaux de risque, classés par le planner et **re-validés** par
l'orchestrateur :

| Niveau          | Exemples                                                                 | Comportement                                                                                  |
|-----------------|--------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `safe`          | lire le repo, résumer, rédiger un brouillon                              | **autonome**, pas de gate, conteneur **sans réseau**                                          |
| `mutating`      | écrire/éditer des fichiers dans `/workspace`, lancer un build           | **autonome par défaut** (la boîte est jetable, le rayon d'action = le workspace) ; surfacé dans le plan pour que l'humain puisse couper |
| `consequential` | envoyer un mail/message, ouvrir une PR, déployer, dépenser de l'argent, tout effet de bord réseau, tout ce qui est **irréversible** | **gate forcé** : la sous-tâche (et la tâche) passent en `awaiting_approval` et **ne démarrent jamais** sans `POST /api/cowork/[id]/approve` |

Une sous-tâche `consequential` jamais approuvée reste bloquée indéfiniment ;
à la finalisation de la tâche, l'orchestrateur la marque `skipped` plutôt que
de l'exécuter. **Par défaut, on ne fait jamais l'action à conséquence sans un
« oui » humain explicite.**

### 2.3. EXECUTE — exécution sandboxée

Tant qu'il reste des sous-tâches exécutables (dépendances toutes `done`, et
`risk==safe` **ou** `approved==1`), l'orchestrateur en réclame une de façon
**atomique** (`claimRunnableCoworkSubtask`, `BEGIN IMMEDIATE` → jamais de
double-claim même en concurrence), la passe `running`, et lance le conteneur.
Les sous-tâches indépendantes peuvent tourner **en parallèle** jusqu'à
`COWORK_MAX_CONCURRENCY`. Si le coût cumulé dépasse
`COWORK_MAX_USD_PER_TASK` (défaut 1,00 $), la tâche est **avortée**.

### 2.4. SYNTHESIZE — le livrable

Quand toutes les sous-tâches sont `done` ou `skipped`, la tâche passe en
`synthesizing` : un dernier `query()` (même modèle que le planner) agrège les
sorties des sous-tâches en un **livrable unique**, stocké dans `result`, et la
tâche passe `done`. L'événement SSE `done` porte le livrable au cockpit.

---

## 3. L'orchestrateur (le démon)

Fichier : `agents/cowork/orchestrator.mjs` — service systemd
`galaxia-cowork.service`. C'est un **démon unique, à longue durée de vie**,
qui boucle indéfiniment. Il **mime** le pattern éprouvé de la file de tâches du
bot Telegram (`agents/telegram/tasks.py` / `worker.py`), porté en JS :

- **POLL** : `claimNextCoworkTask()` prend atomiquement (`BEGIN IMMEDIATE`) la
  plus ancienne tâche `pending` et la passe `planning`. File vide ⇒ sommeil de
  `COWORK_POLL_SEC` (défaut 3 s).
- **PLAN / GATE / EXECUTE / SYNTHESIZE** : cf. §2.
- Pour une tâche déjà en `awaiting_approval`, **chaque tour de boucle**
  re-lit `listCoworkSubtasks` pour détecter les sous-tâches fraîchement
  approuvées (`approved=1`) et reprend l'exécution.
- **Kill-switch** : une tâche passée en `killed` par
  `POST /api/cowork/[id]/kill` provoque un `docker kill cowork-<subtaskId>`
  pour chaque conteneur en cours, puis l'arrêt de la tâche.

Le démon partage la même base SQLite que le cockpit
(`apps/cockpit/data/cockpit.db`) ; il lit/écrit via les helpers de `db.ts`
(file de tâches et de sous-tâches, statuts, coût, plan).

---

## 4. La sandbox Docker (une boîte jetable par sous-tâche)

Chaque sous-tâche s'exécute dans **son propre conteneur Docker jetable**,
créé puis détruit (`--rm`). C'est le périmètre de confiance : tout ce qu'une
sous-tâche peut casser se limite à un dossier `/workspace` éphémère.

- **Image** : `galaxia/cowork-sandbox`.
- **Wrapper** : `agents/cowork/sandbox/run-subtask.sh`. Argument positionnel 1
  = `SUBTASK_ID` (sert au `--name` et au tag de log) ; les **instructions de la
  sous-tâche arrivent par STDIN** (l'orchestrateur pipe la description rendue +
  le contexte accumulé des sous-tâches amont).
- **Sorties** : la sortie de l'agent in-sandbox arrive **ligne par ligne sur
  STDOUT** (chaque ligne devient un événement SSE `log`) ; les diagnostics du
  wrapper sur STDERR. La **dernière ligne de STDOUT DOIT être** un seul objet
  JSON `{"ok":boolean,"summary":string}`, stocké comme sortie de la sous-tâche.
- **Code de sortie** : 0 = succès, non-zéro = échec.

### 4.1. Drapeaux d'isolation (le `docker run`)

```
docker run --rm --name cowork-${SUBTASK_ID} \
  --read-only --tmpfs /tmp:rw,size=64m,noexec,nosuid \
  --network=${DOCKER_NET} \
  --cap-drop=ALL --security-opt no-new-privileges \
  --pids-limit=256 --memory=1g --memory-swap=1g --cpus=1.0 \
  --user $(stat -c '%u:%g' ${COWORK_WORKSPACE}) -i \
  -v ${COWORK_WORKSPACE}:/workspace:rw -w /workspace \
  -e COWORK_EXEC_MODEL -e ANTHROPIC_API_KEY -e COWORK_API_KEY -e GROQ_API_KEY -e COWORK_SUBTASK_TIMEOUT \
  ${PROXY_ENV} \
  galaxia/cowork-sandbox
```

où `DOCKER_NET` = `none` (mode `COWORK_NET=none`) **ou** le réseau interne
`cowork-egress` (mode `COWORK_NET=egress`, défaut de la mère), et `PROXY_ENV`
injecte alors `HTTPS_PROXY=http://cowork-proxy:8888` vers le proxy filtré.

| Drapeau                              | Ce qu'il garantit                                                            |
|--------------------------------------|------------------------------------------------------------------------------|
| `--rm`                               | conteneur détruit en fin de course — rien ne survit                          |
| `--read-only` + `--tmpfs /tmp`       | racine du conteneur en lecture seule ; seul `/tmp` (64 Mo, `noexec,nosuid`) et `/workspace` sont inscriptibles |
| `--network=cowork-egress` (mode egress, défaut mère) | réseau docker **interne** (sans NAT) ; seul chemin sortant = le **proxy filtré** `cowork-proxy` qui n'autorise que l'API du modèle (allowlist). `none` reste possible pour une sous-tâche sans appel modèle |
| `--cap-drop=ALL`                     | aucune capability Linux                                                       |
| `--security-opt no-new-privileges`   | pas d'escalade de privilèges (mime le durcissement systemd Galaxia)          |
| `--pids-limit=256`                   | anti fork-bomb                                                                |
| `--memory=1g --memory-swap=1g --cpus=1.0` | plafonds mémoire/CPU, pas de swap                                       |
| `--user $(stat -c '%u:%g' …)`        | jamais root ; uid:gid = **propriétaire du workspace hôte** (l'utilisateur `galaxia`, uid variable — 1001 sur la mère ; surtout pas 1000 en dur) → accès rw garanti au bind-mount |
| `-v …/workspace:/workspace:rw`       | **seul** montage hôte : le workspace de la sous-tâche, rien d'autre          |

L'agent in-sandbox utilise `COWORK_EXEC_MODEL` (même défaut **gratuit/peu
cher** que le planner) avec `COWORK_API_KEY` / `GROQ_API_KEY`, et est coupé net
au-delà de `COWORK_SUBTASK_TIMEOUT` (défaut 600 s, `docker kill`).

---

## 5. API & streaming vers le cockpit

Toutes les routes sont **scopées `locals.user`** (401 sinon), comme le reste du
cockpit.

| Route                              | Méthode | Rôle                                                                 |
|------------------------------------|---------|----------------------------------------------------------------------|
| `/api/cowork`                      | POST    | crée une tâche (`{ goal, model? }`) → `201 { task }`, statut `pending` |
| `/api/cowork`                      | GET     | liste les tâches du user (50 max, plus récentes d'abord)             |
| `/api/cowork/[id]`                 | GET     | détail tâche + sous-tâches (`404` si non possédée)                   |
| `/api/cowork/[id]/stream`          | GET     | abonnement **SSE** (text/event-stream)                              |
| `/api/cowork/[id]/approve`         | POST    | approuve une sous-tâche (`{ subtask_id? }`) ou **toutes** si omis    |
| `/api/cowork/[id]/kill`            | POST    | kill-switch → `{ ok, killed }`                                      |

Le flux **SSE** reprend le contrat de bout en bout du chat (`+server.ts` →
`+page.svelte`, frames `event:` / `data:`, `flush_interval -1` déjà en place
côté Caddy). Événements émis :

- `task` — snapshot complet de la tâche (à la connexion + à chaque transition).
- `plan` — la liste des sous-tâches après validation (re-émis quand l'état du
  gate change).
- `subtask` — une frame par transition de statut de sous-tâche.
- `log` — une ligne de sortie de la sandbox (`stdout`/`stderr`), granularité
  identique aux `delta` du chat.
- `done` — la tâche a réussi : `{ ok, result, cost_micros }`.
- `error` — échec tâche ou sous-tâche ; le flux se ferme ensuite.

Le flux se ferme quand la tâche atteint `done` / `error` / `killed`.

---

## 6. Persistance

Deux tables, ajoutées par `ensureMigrated()` au boot (CREATE TABLE IF NOT
EXISTS, comme le reste de `db.ts`) :

- `cowork_tasks` — une ligne par objectif (`goal`, `status`, `plan_json`,
  `result`, `error`, `cost_micros`, `model`, horodatages).
- `cowork_subtasks` — une ligne par sous-tâche (`seq`, `title`, `description`,
  `risk`, `depends_on` JSON, `status`, `approved`, `container_id`, `output`,
  `error`). `ON DELETE CASCADE` depuis la tâche parente.

Les helpers exportés par `db.ts` (création, claim atomique, mise à jour de
statut, approbation, kill) sont listés dans le contrat figé du chantier.

---

## 7. Packaging Hub & Spoke

Cowork suit la même contrainte que tout Galaxia : **produit fini distribuable,
pas un SaaS** (cf. [`ARCHITECTURE.md`](ARCHITECTURE.md)). Conséquences :

- Le démon `galaxia-cowork.service` se déploie sur **chaque galaxie fille** à
  l'identique, durci par le même gabarit systemd que `galaxia-coder.service`
  (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `ReadWritePaths`
  restreints au run-dir des tâches).
- L'image `galaxia/cowork-sandbox` est buildée localement et descend par le
  mécanisme de mises à jour signées (cf. [`UPDATES.md`](UPDATES.md)) — aucune
  PME ne dépend d'un registre tiers pour exécuter une sous-tâche.
- L'utilisateur `galaxia` est dans le groupe `docker` (déjà le cas sur la mère)
  → le démon peut lancer `docker run` / `docker kill` sans root.
- Par défaut, le modèle planner **et** le modèle d'exécution sont
  **gratuits/peu chers** ; chaque PME garde ses clés et ses données chez elle.

---

## 8. Variables d'environnement

| Variable                   | Défaut               | Rôle                                                            |
|----------------------------|----------------------|-----------------------------------------------------------------|
| `COWORK_PLANNER_MODEL`     | `claude-sonnet-4-6`  | modèle de planification + synthèse (gratuit/peu cher par défaut) |
| `COWORK_EXEC_MODEL`        | sonnet/groq          | modèle de l'agent in-sandbox                                    |
| `COWORK_MAX_USD_PER_TASK`  | `1.00`               | plafond de coût ; avorte la tâche à mi-course si dépassé        |
| `COWORK_POLL_SEC`          | `3`                  | sommeil du démon entre deux polls à vide                        |
| `COWORK_MAX_CONCURRENCY`   | —                    | nb max de sous-tâches en parallèle                             |
| `COWORK_SUBTASK_TIMEOUT`   | `600`                | mur de temps (s) par sous-tâche (`docker kill` à l'échéance)   |
| `COWORK_NET`               | `none`               | réseau du conteneur (`none` / `egress`, décidé par risque)     |
| `COWORK_API_KEY` / `GROQ_API_KEY` | —             | clé de l'agent in-sandbox                                       |
| `COWORK_WORKSPACE`         | —                    | dossier hôte monté en `/workspace` (par sous-tâche)            |

---

## 9. Exploitation (pour un dev)

> ⚠️ **Rien n'est déployé au 2026-05-31.** Les commandes ci-dessous décrivent
> l'exploitation **cible**, une fois le chantier mergé, l'image buildée et le
> service installé. À adapter/vérifier au déploiement.

```bash
# état du démon
sudo systemctl status galaxia-cowork.service
# logs live (le démon trace les transitions de phase)
sudo journalctl -u galaxia-cowork.service -f
# redémarrer le démon (après edit de config / code)
sudo systemctl restart galaxia-cowork.service
# build de l'image sandbox (à faire une fois, et à republier pour les filles)
# docker build -t galaxia/cowork-sandbox agents/cowork/sandbox/
# build de l'image du proxy d'egress filtré
# docker build -t galaxia/cowork-egress-proxy agents/cowork/egress-proxy/
# proxy d'egress (réseau interne cowork-egress + allowlist api du modèle)
sudo systemctl status galaxia-cowork-egress.service
sudo journalctl -u galaxia-cowork-egress.service -f
```

Diagnostic rapide :

- une tâche reste en `awaiting_approval` → une sous-tâche `consequential`
  attend `POST /api/cowork/[id]/approve` ; c'est **normal et voulu**.
- une sous-tâche en `error` → lire son `output`/`error` (sortie JSON finale du
  wrapper) et les frames `log` correspondantes.
- un conteneur orphelin → `docker ps --filter name=cowork-` puis
  `docker kill <name>` ; le kill-switch de l'API le fait normalement seul.

---

## 10. État d'activation (mère, 2026-05-31)

**Cowork est activé de bout en bout sur la mère.** L'egress des sous-tâches a été
résolu en **egress filtré** (choix Jeff) plutôt qu'en `network=none` : l'agent
in-sandbox a besoin de joindre l'API du modèle, incompatible avec un réseau coupé.

Fait :

- Code mergé sur `main` (orchestrateur, schéma, prompt, wrapper, routes API, UI).
- Images buildées : `galaxia/cowork-sandbox` **et** `galaxia/cowork-egress-proxy`.
- Réseau docker **interne** `cowork-egress` + service `galaxia-cowork-egress.service`
  (tinyproxy, allowlist `api.anthropic.com` / `api.groq.com`).
- Service `galaxia-cowork.service` installé, `COWORK_NET=egress`.
- Deux correctifs trouvés en vérification e2e :
  1. le wrapper transmet désormais `ANTHROPIC_API_KEY` au conteneur (la CLI le lit) ;
  2. la sandbox tourne sous l'uid:gid **propriétaire du workspace** (galaxia = 1001
     ici), pas un `1000` en dur — sinon `/workspace` est en `EACCES`.
- Vérifié : filtrage egress (hôte hors allowlist → `403 Filtered`), et une
  sous-tâche complète (écriture `/workspace` + sortie JSON) via le proxy.

Reste (suivi) :

- Packaging Hub & Spoke du proxy + du réseau interne pour les galaxies filles
  (image `cowork-egress-proxy` + unit + création réseau via le mécanisme d'updates).
- Egress par-sous-tâche modulé selon le risque (aujourd'hui : egress filtré pour
  toutes ; `none` reste disponible par config).
