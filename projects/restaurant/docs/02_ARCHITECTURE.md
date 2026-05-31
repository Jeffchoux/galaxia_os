# 02 — Architecture du système (Galaxia / projet « restaurant »)

> Système multi-agents autonome 24/7. Source de vérité : `docs/00` (inventaire réel),
> `docs/01` (analyse critique & anneaux), `database/schema.sql` (DDL).
> Ce document décrit **comment les pièces s'assemblent** : machine à états du prospect,
> orchestration par la table `tasks`, flux de données, et calque sur les patterns Galaxia
> déjà en production (`coder`, `veille`, `telegram-worker`).
> État courant : **Anneau 0 — dry-run total** (cf. `docs/01 §6`).

---

## 1. Vue d'ensemble — un seul principe

Le système n'invente **aucun nouveau composant runtime**. Il calque trois patterns déjà en
prod sur la mère OpenJeff (cf. `docs/00 §9`) :

| Pattern Galaxia existant | Ce qu'on en reprend | Où ça vit dans `restaurant` |
|--------------------------|---------------------|------------------------------|
| `agents/telegram` (bot)  | **producteur** : enqueue une tâche en SQLite, ne s'auto-exécute jamais | `pipeline/coordinator.py` enfile des `tasks` |
| `agents/telegram/worker.py` | **worker résident** : claim atomique `BEGIN IMMEDIATE`, exécution isolée, timeout/kill-switch, audit | `pipeline/worker.py` (`galaxia-restaurant-worker.service`) |
| `agents/coder` + timers | **boucle ordonnancée** : un timer systemd déclenche un oneshot qui produit un livrable | `ops/*.timer` (découverte, purge, relances) |

> Communication inter-agents **uniquement via la base** (pas de RPC, pas de socket).
> Chaque agent lit son entrée dans une table, écrit sa sortie dans une table, et change le
> `status`. C'est ce qui rend le système observable, rejouable et arrêtable.

## 2. Machine à états du prospect (`businesses.status`)

Le cœur du système est une **machine à états** sur la colonne `businesses.status`. Chaque
transition est déclenchée par un agent, validée par les garde-fous (`compliance`, `qa`), et
tracée dans `audit_log`. Aucune transition n'est implicite.

```
                            ┌─────────────┐
                            │  discovered │  (discovery : OSM/Overpass → row + provenance)
                            └──────┬──────┘
                                   │ enrichment (infos publiques minimales)
                            ┌──────▼──────┐
                            │  enriched   │
                            └──────┬──────┘
                                   │ website_audit (robots.txt, HTTP, score)
                            ┌──────▼──────┐
                            │   audited   │
                            └──────┬──────┘
              site déjà bon /      │ qualification (site faible/absent
              pas d'e-mail générique│   ET email_is_generic=1)
                    ┌──────────────┼──────────────┐
                    ▼              ▼                │
              ┌──────────┐   ┌───────────┐         │
              │ rejected │   │ qualified │         │
              └──────────┘   └─────┬─────┘         │
              (no_generic_email,   │ content+design+build (site statique)
               site_already_good)  ▼                │
                            ┌─────────────┐          │ veto compliance/qa
                            │ site_built  │──────────┘  → blocked (hors flux)
                            └──────┬──────┘
                                   │ email (génère + file ; DRY-RUN en Anneau 0)
                            ┌──────▼──────┐
                            │  contacted  │   ← (Anneau 1+ : hosting publie le site)
                            └──────┬──────┘
                                   │ reply (réponse entrante classée — Anneau 2)
                            ┌──────▼──────┐
                            │   replied   │
                            └──────┬──────┘
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                        ▼
     ┌────────────┐         ┌──────────┐            ┌────────────┐
     │ converted  │         │   lost   │            │ suppressed │
     │ (Anneau 3) │         │ (refus / │            │ (opt-out / │
     │  Stripe    │         │  silence)│            │  takedown) │
     └────────────┘         └──────────┘            └────────────┘
```

| Statut | Posé par | Précondition / garde-fou | Effet de bord |
|--------|----------|--------------------------|----------------|
| `discovered` | `discovery` | source licite + `external_id` unique (dédup) | row `businesses` + `audit_log:collected` |
| `enriched` | `enrichment` | données **publiques minimales** seulement (`docs/01 §5`) | maj champs contact public |
| `audited` | `website_audit` | `robots.txt` respecté, anti-SSRF (`docs/01 §11`) | row `website_audits` |
| `qualified` | `coordinator` | site faible/absent **ET** `email_is_generic=1` | éligible `v_contactable` |
| `rejected` | `coordinator` | `reject_reason` (`no_generic_email`, `site_already_good`) | sort du flux |
| `site_built` | `build` | passe la QA (pas d'info inventée, `noindex=1`) | row `websites` (`dry_run=1`) |
| `contacted` | `email` | **suppression list vérifiée**, token unsub présent | row `emails` (`dry_run`) |
| `replied` | `reply` | réponse entrante (Anneau 2) | row `replies`, `needs_human=1` |
| `converted` | `billing` | abonnement Stripe actif (Anneau 3) | site → `claimed` permanent |
| `lost` | `sales` | refus explicite ou fin de séquence de relance | site purgé à expiration |
| `suppressed` | `compliance` | opt-out / takedown — **irréversible** | `suppression_list` + purge site < 72 h |

> `blocked` n'est pas un état du cycle de vie mais un **veto** : `compliance` ou `qa`
> bloquent une sortie (e-mail sans unsubscribe, contenu non vérifiable). Le `coordinator`
> ne franchit jamais une transition sortante (publication/envoi) sans leur OK (`docs/01 §8`).

## 3. Orchestration — coordinator + tasks + worker + timers

Quatre rouages, calqués 1:1 sur l'existant Galaxia :

```
   systemd timers (ops/*.timer)          coordinator (pipeline/coordinator.py)
   ───────────────────────────           ─────────────────────────────────────
   « réveille la boucle »                « décide la prochaine action,
   - découverte (horaire)        ──┐      applique garde-fous, enfile »
   - relances (quotidien)          │              │
   - purge sites expirés (horaire) │              │ INSERT INTO tasks(...)
   - purge RGPD/rétention (quotid.)│              ▼
                                   │      ┌───────────────────┐
                                   └─────▶│   tasks (SQLite)  │  pending
                                          │  pattern tg_tasks │
                                          └─────────┬─────────┘
                                                    │ claim atomique
                                                    │ BEGIN IMMEDIATE
                                                    ▼
                                   worker résident (pipeline/worker.py)
                                   galaxia-restaurant-worker.service
                                   ──────────────────────────────────
                                   - claim 1 tâche pending → running
                                   - dispatch vers l'agent (agents/*.md)
                                   - exécute via Ollama (défaut) / claude (ad hoc)
                                   - écrit résultat + agent_runs (coûts)
                                   - status: done | error | killed (timeout/kill)
                                   - tout tracé dans audit_log
```

**`tasks` (file SQLite).** Schéma `schema.sql §tasks` : `id` (uuid), `agent`, `business_id`,
`payload` (JSON), `status` (`pending→running→done|error|killed`), `priority`, `attempts`,
`pgid` (groupe process pour le kill-switch). Index `(status, priority, created_at)` =
prochaine tâche à prendre. C'est **exactement** le modèle `tg_tasks` (`docs/00 §9`).

**Claim atomique.** Le worker ouvre `BEGIN IMMEDIATE`, sélectionne la première `pending` par
priorité, la passe `running` et commit — deux workers ne peuvent pas réclamer la même tâche
(verrou écrivain SQLite + WAL). Tâche `running` orpheline (worker tué) → requeue par timeout
(`docs/01 §12`).

**Coordinator (producteur).** Comme le bot Telegram, **il ne s'exécute pas lui-même** : il
lit l'état (`businesses.status`, vues `v_contactable`, `v_expired_sites`) et **enfile** la
prochaine action. Il porte la logique de garde-fous (ne jamais enfiler un `email` pour une
adresse en `suppression_list`, ne jamais publier sans `noindex`).

**Worker (consommateur résident).** Service `simple`, `Restart=on-failure`, tourne en
permanence. Pour chaque tâche il charge le rôle d'agent (`agents/{agent}.md`), choisit le
modèle (Ollama `llama3.1:8b` par défaut, `claude` headless ad hoc pour la génération de site
premium — règle « pas de premium par défaut », `docs/00 §6`), exécute en `start_new_session`
(groupe process isolé pour le kill-switch), borne par un timeout dur, et journalise coût +
durée dans `agent_runs`.

**Timers (réveils périodiques).** Oneshots calqués sur `galaxia-coder.timer` :

| Timer | Cadence | Service oneshot | Rôle |
|-------|---------|-----------------|------|
| `galaxia-restaurant-discovery.timer` | horaire (jitter) | `…-discovery.service` | enfile un lot de découverte borné |
| `galaxia-restaurant-followup.timer` | quotidien | `…-followup.service` | enfile relances (Anneau 2, borné) |
| `galaxia-restaurant-purge.timer` | horaire | `…-purge.service` | retire sites `v_expired_sites` (TTL 7 j) |
| `galaxia-restaurant-retention.timer` | quotidien | `…-retention.service` | purge RGPD (`retention_until`) |

> Détail des unit files : `docs/04`. Pas de cron classique (`docs/00 §8`).

## 4. Les 19 agents (rôles `.md`, pas des process)

Un agent = un **fichier de rôle** (`agents/{nom}.md` : mission, entrées DB, sorties DB,
garde-fous), exécuté **par le worker** via le runtime LLM. Ce ne sont pas 19 daemons : c'est
1 worker qui endosse 19 rôles selon `tasks.agent`. Chaîne (cf. `docs/01 §8`) :

```
coordinator ─▶ discovery ─▶ enrichment ─▶ website_audit ─▶ content ─▶ design
     ▲                                                                    │
     │                                                                    ▼
  monitoring   compliance(veto) ◀── qa(veto) ◀── email ◀── hosting ◀── build
  finance      security                          │
  strategy                                       ▼
                                          reply ─▶ sales ─▶ billing(Anneau 3)
```

Transversaux (peuvent bloquer ou alerter, jamais dans le flux nominal) : `compliance` et
`qa` ont un **droit de veto** matérialisé (`blocked`) ; `security`, `finance`, `monitoring`,
`strategy` observent et priorisent.

## 5. Flux de données (data flow)

```
 OSM / Overpass API (ODbL)                    Ollama 127.0.0.1:11434 (gratuit)
        │  (HTTP, rate-limited, UA honnête)            ▲   │
        ▼                                              │   │ claude -p (ad hoc, premium)
 ┌─────────────┐   tasks   ┌──────────────┐  appels LLM│   ▼
 │ discovery   │──────────▶│   worker     │────────────┘  ┌──────────────┐
 └─────────────┘           │  (résident)  │──────────────▶│ agents/*.md  │
                           └──────┬───────┘   charge rôle └──────────────┘
                                  │
        écrit/lit (sqlite3, WAL)  ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  data/restaurant.db                                                         │
 │  businesses · website_audits · websites · emails · suppression_list ·       │
 │  replies · subscriptions · tasks · agent_runs · audit_log                   │
 └───────────┬───────────────────────────┬───────────────────────┬───────────┘
             │ build_path                 │ dry_run_path           │ (Anneau 3)
             ▼                            ▼                        ▼
  /var/www/galaxia-restaurant-sites/  logs/dry_run_emails/    Stripe API
   {slug}/  (Caddy file_server,        *.eml  (Anneau 0 :     (paiement délégué,
    noindex, HTTPS auto, Anneau 1+)     ZÉRO envoi réel)       jamais de carte stockée)
```

En **Anneau 0** : la branche site reste locale (consultable mais pas publiée publiquement),
la branche e-mail s'arrête à `logs/dry_run_emails/`, la branche Stripe n'existe pas. Seules
les sources entrantes (OSM) sont réelles.

## 6. Où tourne chaque composant

| Composant | Hôte | Utilisateur | Démarrage |
|-----------|------|-------------|-----------|
| `worker.py` (résident) | OpenJeff | `galaxia` | `galaxia-restaurant-worker.service` (simple, Restart) |
| timers + oneshots | OpenJeff | `galaxia` | `ops/*.timer` → `*.service` |
| `data/restaurant.db` | OpenJeff (disque) | `galaxia` | fichier WAL |
| sites statiques | `/var/www/galaxia-restaurant-sites/` | servis par `caddy` | Caddy `file_server` (déjà actif) |
| Ollama | OpenJeff `127.0.0.1:11434` | service système | déjà actif (`docs/00 §6`) |
| `claude` headless | OpenJeff | `galaxia` | invoqué ad hoc par le worker |

Tous les services tournent sous l'utilisateur **`galaxia`** (jamais root), avec
`NoNewPrivileges` — comme `galaxia-coder.service` (`docs/01 §11`). Le réseau git/`gh` est
réservé au compte `galaxia` (`docs/00 §10`).

## 7. Anneaux de déploiement (rollout)

L'architecture est unique ; seuls des **drapeaux de config** ouvrent des branches. État
courant **Anneau 0**. (Détail des anneaux : `docs/01 §6`.)

| Anneau | Drapeau | Ce qui s'active | Branche du flux concernée |
|--------|---------|-----------------|---------------------------|
| **0** (courant) | `dry_run: true` | tout sur disque, aucun envoi/publication/paiement | jusqu'à `logs/dry_run_emails/` |
| 1 | `hosting.publish: true` | sites publiés `try.galaxia-os.com` (`noindex`+bandeau+retrait), envoi **revu par humain** via prestataire+domaine dédié | hosting + email (manuel) |
| 2 | `followup: true` | relances bornées, `reply` rédige des brouillons (`needs_human=1`) | reply + sales |
| 3 | `billing: true` | Stripe, abonnement 10 €/mois, site → permanent | billing |
| 4 | `autonomy: supervised` | levée progressive des validations, sous métriques + kill-switch | tout, surveillé |

> Le code de ce livrable **s'arrête à l'Anneau 0** ; tables et drapeaux sont déjà prêts pour
> activer les suivants sans refonte (`docs/01 §6` dernière note).

## 8. Mapping sur les patterns Galaxia existants

| Brique `restaurant` | Patron Galaxia | Héritage concret |
|---------------------|----------------|------------------|
| `coordinator.py` | `agents/telegram` (bot producteur) | enqueue en SQLite, **ne s'auto-exécute pas** |
| `worker.py` | `agents/telegram/worker.py` | claim `BEGIN IMMEDIATE`, `pending→running→done\|error\|killed`, `start_new_session`, timeout dur, audit |
| génération de site | `agents/coder` | boucle « lit entrées → produit livrable », system-prompt cacheable, `claude` headless |
| `discovery`/`enrichment` | `agents/veille` | collecte multi-sources → filtre → synthèse |
| timers | `galaxia-coder.timer` / `veille` | `OnCalendar` + `Persistent=true` + `RandomizedDelaySec` |
| hébergement | webroots Caddy (`install.`/`updates.`) | `file_server` statique + HTTPS auto, zéro nouveau composant |
| secrets | `agents/coder` | `EnvironmentFile=/opt/galaxia/config/.env`, jamais committé/logué |

En résumé : **aucune dépendance nouvelle**. Le système restaurant est une **instanciation
métier** du trio producteur/file-SQLite/worker-résident déjà éprouvé sur la mère, plus les
timers et l'hébergement Caddy déjà en production.
