# 06 — Modèle de données (schéma expliqué)

> Projet **`restaurant`** — explication du schéma `database/schema.sql` pour un **manager**
> (comprendre quoi/pourquoi) et un **développeur** (clés, statuts, vues).
> Ce document **ne redéfinit pas le SQL** : il le **référence**. Source de vérité = le fichier
> `database/schema.sql`. En cas d'écart, c'est le SQL qui fait foi.

Conventions du schéma (rappel) : SQLite **mode WAL**, `foreign_keys = ON`, timestamps en
**millisecondes epoch** (INTEGER), booléens en **INTEGER 0/1**, SQL **portable** (migration
Postgres possible plus tard). Versionnement via `schema_meta` (clé `schema_version`).

---

## 1. Vue d'ensemble des tables

| Table | Rôle (1 ligne) | Anneau | Sensibilité |
|-------|----------------|--------|-------------|
| `schema_meta` | Version du schéma (migrations idempotentes) | 0 | — |
| `businesses` | Prospects découverts + **provenance** + base légale | 0 | RGPD |
| `website_audits` | Pourquoi un prospect est qualifié (faiblesse du site) | 0 | — |
| `websites` | Sites générés + hébergement temporaire (TTL 7 j, `noindex`) | 0 | publication |
| `emails` | Messages outreach (**dry-run**, token unsub obligatoire) | 0 | RGPD/spam |
| `suppression_list` | Opt-out **irréversible**, vérifié avant tout envoi | 0 | RGPD (critique) |
| `replies` | Réponses entrantes classées → **brouillon** | 2 | — |
| `subscriptions` | Conversion payante (Stripe, **aucune carte stockée**) | 3 | paiement |
| `tasks` | File de travail des agents (claim atomique) | 0 | — |
| `agent_runs` | Observabilité + **coûts LLM** (`docs/07`) | 0 | — |
| `audit_log` | Journal RGPD/conformité — **source de vérité légale** | 0 | RGPD (critique) |

Vues : `v_contactable`, `v_expired_sites` (§5).

---

## 2. Tables centrales — but & colonnes clés

### `businesses` — le prospect
Cœur du système. Ne contient **que du public et du minimal** (`docs/01` §5).
- **Identité publique** : `name`, `category`, `address`, `city`, `postal_code`, `country`,
  `lat`/`lon`.
- **Contact public** : `phone`, `email`, et surtout **`email_is_generic`** (1 =
  `contact@`/`info@`… ; 0 = inconnu/nominatif). On ne contacte **que** les génériques.
- **Provenance & conformité** (traçabilité RGPD obligatoire) : `data_source` (NOT NULL, ex.
  `osm-overpass`), `source_url`, **`consent_basis`** (défaut `legitimate_interest_b2b`),
  `external_id` (dédup), `collected_at`, **`retention_until`** (purge auto).
- **Pipeline** : `status` (machine à états, §4), `qualified`, `reject_reason`.
- **Dédup** : `UNIQUE (data_source, external_id)`.
- Index : `status`, `city`, `email`.

### `website_audits` — la preuve de faiblesse
Une ligne par audit. `business_id` (FK `ON DELETE CASCADE`). Signaux : `has_website`,
`reachable`, `is_https`, `mobile_friendly`, `load_ms`, `ssl_valid`, `is_parking_page`,
`score` (0–100), `weakness_summary` (lisible), **`robots_allowed`** (l'audit a respecté
robots.txt). Justifie le passage à `qualified`.

### `websites` — le site généré & son hébergement
- `slug` (**UNIQUE**, identifiant URL `try.galaxia-os.com/{slug}`), `template`, `build_path`
  (dossier statique), `public_url` (NULL en dry-run).
- **`noindex` (défaut 1)** : **TOUJOURS 1** tant que le site n'est pas réclamé → pas
  d'indexation d'un site non officiel.
- `status` : `built → published → expired | claimed(permanent) | removed`.
- **`dry_run` (défaut 1)** : pas de publication réelle au MVP.
- TTL : `published_at`, **`expires_at` = published_at + 7 j**, `removed_at`.
- Index : `status`, `expires_at` (sert `v_expired_sites`).

### `emails` — l'outreach (dry-run par défaut)
- FK `business_id` (CASCADE), `website_id` (`ON DELETE SET NULL`).
- `kind` : `outreach | followup_1 | followup_2 | reply`.
- `to_email` (**générique pro uniquement**), `subject`, `body_text`, `body_html`.
- **`unsubscribe_token` (NOT NULL, UNIQUE)** : chaque e-mail **doit** porter un token
  unique non devinable — contrainte applicative **et** index unique `idx_emails_unsub`.
- `sender_identity` (transparence expéditeur).
- `status` : `drafted → queued → sent | dry_run | blocked | bounced | failed`.
- **`dry_run` (défaut 1)**, `dry_run_path` (fichier dans `logs/dry_run_emails/`),
  `blocked_reason` (ex. `suppressed`, `no_unsubscribe`).
- Index : `business`, `status`, unique `unsubscribe_token`.

### `suppression_list` — l'opt-out irréversible (table critique)
- **`email` UNIQUE COLLATE NOCASE** : insensible à la casse → `Contact@X` et `contact@x`
  sont la **même** entrée, impossible de recontacter via une variante de casse.
- `reason` : `unsubscribe | bounce | complaint | manual | takedown`.
- `source` : `link | reply | admin`. FK `business_id` (`SET NULL`). `created_at`.
- **Règle métier** : une fois ici, **plus jamais** recontacté ; vérifié **avant chaque**
  mise en file (jamais mis en cache).

### `replies` — réponses entrantes (Anneau 2)
`business_id`/`email_id`, `from_email`, `raw_text`, `intent`
(`interested | not_interested | unsubscribe | question | complaint`), `sentiment`,
**`draft_reply`** (brouillon), **`needs_human` (défaut 1)**, `handled`. L'agent **rédige**,
un humain **valide** (`docs/01` §3.5).

### `subscriptions` — conversion payante (Anneau 3)
`provider` (défaut `stripe`), `provider_customer_id`/`provider_sub_id` (références
**opaques**, jamais de carte), `currency` (défaut `EUR`), **`amount_cents` (défaut 1000 =
10,00)**, `status` (`pending | active | past_due | canceled`), `started_at`, `canceled_at`.

### `tasks` — la file des agents
`id` (uuid hex), `agent`, `business_id`, `payload` (JSON), `status`
(`pending → running → done | error | killed`), `result`, `priority` (défaut 100),
`attempts`, **`pgid`** (groupe process pour le **kill-switch**). Index composite
`(status, priority, created_at)` pour le claim. Pattern `agents/telegram/tasks.py`.

### `agent_runs` — observabilité & coûts
Un run = une exécution d'agent. `agent`, `task_id`, **`model`**
(`ollama:llama3.1:8b | claude:… | groq:…`), `input_tokens`, `output_tokens`,
**`cost_usd` (défaut 0 — 0 pour Ollama/local)**, `duration_ms`, `ok`, `error`. Base
chiffrée du modèle de coût (`docs/07`).

### `audit_log` — journal RGPD (source de vérité légale)
`entity` (`business | website | email | suppression | subscription`), `entity_id`,
`action` (`collected | published | queued | sent | suppressed | erased | blocked`),
`actor` (agent ou `human`), `detail` (JSON libre). Trace **toute** action sensible.

---

## 3. Diagramme relationnel (ASCII)

```
                         ┌────────────────────┐
                         │     businesses     │  (prospect, provenance, base légale)
                         │  PK id             │
                         └─────────┬──────────┘
        ┌──────────────┬───────────┼───────────┬───────────────┬──────────────┐
        │ 1:N          │ 1:N       │ 1:N       │ 1:N           │ 1:N          │ 0:N
        ▼              ▼           ▼           ▼               ▼              ▼
┌───────────────┐ ┌─────────┐ ┌────────┐ ┌──────────┐ ┌──────────────┐ ┌───────────┐
│website_audits │ │websites │ │ emails │ │ replies  │ │subscriptions │ │   tasks   │
│ FK business_id│ │FK biz_id│ │FK biz  │ │FK biz    │ │ FK biz_id    │ │FK biz_id  │
│   (CASCADE)   │ │(CASCADE)│ │(CASCADE)│ │(CASCADE) │ │  (CASCADE)   │ │ (CASCADE) │
└───────────────┘ └────┬────┘ └───┬────┘ └────┬─────┘ └──────┬───────┘ └─────┬─────┘
                       │ id        │ website_id│ email_id      │ website_id    │ id
                       └───────────┤ (SET NULL)│ (SET NULL)    │ (SET NULL)    │
                                   │           │               │               │
                                   └───────────┴───────────────┘          ┌────▼──────┐
                                                                          │ agent_runs│
┌──────────────────┐      business_id (SET NULL)      ┌────────────┐      │FK task_id │
│ suppression_list │◄─────────────────────────────────│ businesses │      │ (SET NULL)│
│ email UNIQUE     │   (opt-out lié au prospect)       └────────────┘      └───────────┘
│  COLLATE NOCASE  │
└──────────────────┘
        ▲
        │ vérifié AVANT chaque envoi (NOT EXISTS, COLLATE NOCASE)

┌────────────┐   (table journal, pas de FK dure — entity/entity_id génériques)
│ audit_log  │   trace business | website | email | suppression | subscription
└────────────┘
```

Légende : flèche pleine = clé étrangère ; `CASCADE` = la suppression du prospect supprime
les enfants ; `SET NULL` = on garde l'enfant mais on coupe le lien. `audit_log` et
`suppression_list` sont volontairement **faiblement couplés** (références génériques /
`SET NULL`) pour **survivre à l'effacement** d'un prospect — l'opt-out et la trace légale
ne doivent jamais disparaître avec la donnée effacée.

---

## 4. Enums de cycle de vie (statuts)

| Table | Colonne | Valeurs | Terminaux |
|-------|---------|---------|-----------|
| `businesses` | `status` | `discovered → enriched → audited → qualified \| rejected → site_built → contacted → replied → converted \| lost \| suppressed`, + `blocked` (veto) | `converted`, `lost`, `suppressed`, `rejected` |
| `websites` | `status` | `built → published → expired \| claimed \| removed` | `claimed`, `removed` |
| `emails` | `status` | `drafted → queued → sent \| dry_run \| blocked \| bounced \| failed` | `sent`, `dry_run`, `blocked`, `bounced`, `failed` |
| `suppression_list` | `reason` | `unsubscribe \| bounce \| complaint \| manual \| takedown` | (entrée = terminale) |
| `subscriptions` | `status` | `pending → active → past_due \| canceled` | `canceled` |
| `tasks` | `status` | `pending → running → done \| error \| killed` | `done`, `error`, `killed` |

> `blocked` (businesses/websites/emails) n'est posé que par **compliance** ou **qa**
> (`docs/05` §3). `suppressed` est **irréversible**.

---

## 5. Les deux vues

| Vue | But | Filtre | Consommée par |
|-----|-----|--------|----------------|
| **`v_contactable`** | Prospects sûrs à contacter | `qualified=1` ET `email` non NULL ET `email_is_generic=1` ET `status NOT IN (suppressed, rejected, lost)` ET **`NOT EXISTS` dans `suppression_list` (COLLATE NOCASE)** | agent `email` (jamais hors de cette vue) |
| **`v_expired_sites`** | Sites publiés expirés à purger | `status='published'` ET `expires_at` non NULL ET `expires_at < maintenant` | agent `hosting` (purge TTL 7 j) |

`v_contactable` est le **garde-fou en lecture** : la conformité (générique + non supprimé)
est garantie par la vue elle-même, pas seulement par le code applicatif.

---

## 6. Comment la conformité est gravée dans les données

| Exigence (`docs/01`) | Mécanisme en base |
|----------------------|--------------------|
| Opt-out irréversible, insensible à la casse | `suppression_list.email UNIQUE **COLLATE NOCASE**` + re-check `NOT EXISTS` avant chaque envoi |
| Seules les adresses **génériques** contactées | `businesses.email_is_generic` + filtre dur de `v_contactable` |
| Traçabilité de la provenance (RGPD) | `data_source` (NOT NULL), `source_url`, `external_id`, `collected_at` |
| Base légale documentée | `consent_basis` (défaut `legitimate_interest_b2b`) |
| Droit à l'oubli / conservation limitée | `retention_until` (purge auto) + `audit_log.action='erased'` |
| Chaque e-mail désinscriptible | `emails.unsubscribe_token` NOT NULL + index UNIQUE |
| Aucun envoi/paiement involontaire au MVP | `emails.dry_run` / `websites.dry_run` défaut **1** |
| Trace légale survivant à l'effacement | `audit_log` (générique) + `suppression_list` (`business_id` `SET NULL`) |
| Pas de donnée de carte | `subscriptions` ne stocke que des **références opaques** Stripe |

---

## 7. Pour le développeur — règles d'accès

- Toujours ouvrir la base en **WAL** avec `PRAGMA foreign_keys = ON`.
- Claim de tâche : `BEGIN IMMEDIATE` + `UPDATE … WHERE status='pending'` (anti double-claim).
- **Ne jamais** sélectionner des prospects à contacter en dehors de **`v_contactable`**.
- **Ne jamais** insérer un `email` sans `unsubscribe_token` ni `sender_identity`/adresse.
- Toute action sensible → une ligne `audit_log` dans la **même** transaction si possible.
- Init/migration : `python pipeline/db.py --init` (idempotent via `schema_meta`).
