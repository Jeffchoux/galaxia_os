-- ============================================================================
-- Galaxia / projet « restaurant » — schéma de base (SQLite, mode WAL)
-- ----------------------------------------------------------------------------
-- Souverain, sans dépendance serveur (cf. docs/00 §5 : pas de PostgreSQL/Redis).
-- Conformité INTÉGRÉE au schéma (cf. docs/01 §4-5) : provenance des données,
-- base légale, liste de suppression irréversible, journal d'audit, TTL/purge.
--
-- Conventions :
--   * timestamps en millisecondes epoch (INTEGER) — cohérent avec agents/telegram/tasks.py
--   * booléens : INTEGER 0/1
--   * SQL volontairement portable (migration Postgres possible plus tard)
--
-- Appliquer :  sqlite3 data/restaurant.db < database/schema.sql
--          ou  python pipeline/db.py --init   (helper du pipeline)
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- meta : versionnement du schéma (migrations idempotentes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')
    ON CONFLICT(key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- businesses : prospects découverts (données PUBLIQUES et MINIMALES uniquement)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- identité publique
    name            TEXT NOT NULL,
    category        TEXT,                 -- ex : restaurant, pizzeria, café
    address         TEXT,
    city            TEXT,
    postal_code     TEXT,
    country         TEXT,
    lat             REAL,
    lon             REAL,
    -- contact PUBLIC (on ne stocke QUE des e-mails génériques — cf. docs/01 §4)
    phone           TEXT,
    email           TEXT,                 -- doit être générique : contact@, info@, ...
    email_is_generic INTEGER NOT NULL DEFAULT 0,  -- 1 = contact@/info@... ; 0 = inconnu/nominatif
    existing_website TEXT,                -- URL du site existant si trouvé

    -- provenance & conformité RGPD (traçabilité obligatoire — docs/01 §5)
    data_source     TEXT NOT NULL,        -- ex : 'osm-overpass', 'manual-fixture'
    source_url      TEXT,                 -- URL d'origine exacte
    consent_basis   TEXT NOT NULL DEFAULT 'legitimate_interest_b2b',
    external_id     TEXT,                 -- id OSM/source pour dédup
    collected_at    INTEGER NOT NULL,
    retention_until INTEGER,              -- purge auto après cette date (NULL = défaut config)

    -- pipeline
    status          TEXT NOT NULL DEFAULT 'discovered',
        -- discovered → enriched → audited → qualified | rejected
        --   → site_built → contacted → replied → converted | lost | suppressed
    qualified       INTEGER NOT NULL DEFAULT 0,  -- 1 si cible pertinente (site faible/absent)
    reject_reason   TEXT,                 -- ex : 'no_generic_email', 'site_already_good'

    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,

    UNIQUE (data_source, external_id)     -- dédup par source
);
CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_city   ON businesses(city);
CREATE INDEX IF NOT EXISTS idx_businesses_email  ON businesses(email);

-- ---------------------------------------------------------------------------
-- website_audits : pourquoi un prospect est qualifié (site faible/absent/lent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS website_audits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    has_website     INTEGER NOT NULL DEFAULT 0,
    reachable       INTEGER,              -- a répondu HTTP
    is_https        INTEGER,
    mobile_friendly INTEGER,
    load_ms         INTEGER,              -- temps de réponse approx
    ssl_valid       INTEGER,
    is_parking_page INTEGER,              -- page « domaine à vendre » / vide
    score           INTEGER,              -- 0=catastrophique … 100=excellent
    weakness_summary TEXT,                -- raison lisible de la faiblesse
    robots_allowed  INTEGER,              -- robots.txt autorisait l'audit
    audited_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_business ON website_audits(business_id);

-- ---------------------------------------------------------------------------
-- websites : sites générés + hébergement temporaire (TTL 7 j) — docs/01 §3,§7
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS websites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL UNIQUE, -- identifiant URL : try.galaxia-os.com/{slug}
    template        TEXT,                 -- gabarit utilisé
    build_path      TEXT,                 -- dossier statique généré
    public_url      TEXT,                 -- URL publique (NULL en dry-run)
    noindex         INTEGER NOT NULL DEFAULT 1,  -- TOUJOURS 1 tant que non réclamé
    status          TEXT NOT NULL DEFAULT 'built',
        -- built → published → expired | claimed(permanent) | removed
    dry_run         INTEGER NOT NULL DEFAULT 1,
    published_at    INTEGER,
    expires_at      INTEGER,              -- published_at + 7 j
    removed_at      INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_websites_status  ON websites(status);
CREATE INDEX IF NOT EXISTS idx_websites_expires ON websites(expires_at);

-- ---------------------------------------------------------------------------
-- emails : messages d'outreach (DRY-RUN par défaut, jamais d'envoi au MVP)
-- Chaque e-mail DOIT porter un token de désinscription (contrainte applicative).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emails (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    website_id      INTEGER REFERENCES websites(id) ON DELETE SET NULL,
    kind            TEXT NOT NULL DEFAULT 'outreach',  -- outreach | followup_1 | followup_2 | reply
    to_email        TEXT NOT NULL,        -- générique pro uniquement
    subject         TEXT NOT NULL,
    body_text       TEXT NOT NULL,
    body_html       TEXT,
    unsubscribe_token TEXT NOT NULL,      -- token unique non devinable (obligatoire)
    sender_identity TEXT,                 -- expéditeur affiché (transparence)
    status          TEXT NOT NULL DEFAULT 'drafted',
        -- drafted → queued → sent | dry_run | blocked | bounced | failed
    dry_run         INTEGER NOT NULL DEFAULT 1,
    dry_run_path    TEXT,                 -- fichier écrit dans logs/dry_run_emails/
    blocked_reason  TEXT,                 -- ex : 'suppressed', 'no_unsubscribe'
    scheduled_at    INTEGER,
    sent_at         INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_business ON emails(business_id);
CREATE INDEX IF NOT EXISTS idx_emails_status   ON emails(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_unsub ON emails(unsubscribe_token);

-- ---------------------------------------------------------------------------
-- suppression_list : opt-out IRRÉVERSIBLE — vérifié AVANT toute mise en file
-- (cf. docs/01 §3.7, §4). Une fois ici, plus jamais recontacté.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppression_list (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- insensible à la casse
    reason          TEXT NOT NULL DEFAULT 'unsubscribe',  -- unsubscribe | bounce | complaint | manual | takedown
    source          TEXT,                 -- 'link', 'reply', 'admin'
    business_id     INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suppression_email ON suppression_list(email);

-- ---------------------------------------------------------------------------
-- replies : réponses entrantes classées (Anneau 2) — l'agent rédige un BROUILLON
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS replies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    email_id        INTEGER REFERENCES emails(id) ON DELETE SET NULL,
    from_email      TEXT,
    raw_text        TEXT,
    intent          TEXT,                 -- interested | not_interested | unsubscribe | question | complaint
    sentiment       TEXT,
    draft_reply     TEXT,                 -- BROUILLON — validation humaine requise (docs/01 §3.5)
    needs_human     INTEGER NOT NULL DEFAULT 1,
    handled         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- subscriptions : conversion payante (Anneau 3) — paiement délégué (Stripe)
-- Galaxia ne stocke JAMAIS de donnée de carte (docs/01 §3.6, §11).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id         INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    website_id          INTEGER REFERENCES websites(id) ON DELETE SET NULL,
    provider            TEXT NOT NULL DEFAULT 'stripe',
    provider_customer_id TEXT,            -- référence opaque chez le prestataire
    provider_sub_id     TEXT,
    currency            TEXT NOT NULL DEFAULT 'EUR',
    amount_cents        INTEGER NOT NULL DEFAULT 1000,  -- 10,00
    status              TEXT NOT NULL DEFAULT 'pending', -- pending | active | past_due | canceled
    started_at          INTEGER,
    canceled_at         INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_business ON subscriptions(business_id);

-- ---------------------------------------------------------------------------
-- tasks : file de travail des agents (pattern agents/telegram/tasks.py)
-- claim atomique BEGIN IMMEDIATE ; pending → running → done | error | killed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,         -- uuid hex
    agent       TEXT NOT NULL,            -- discovery | audit | content | build | email | ...
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    payload     TEXT,                     -- JSON
    status      TEXT NOT NULL DEFAULT 'pending',
    result      TEXT,
    priority    INTEGER NOT NULL DEFAULT 100,
    attempts    INTEGER NOT NULL DEFAULT 0,
    pgid        INTEGER,                  -- groupe process (kill-switch)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);

-- ---------------------------------------------------------------------------
-- agent_runs : observabilité + coûts LLM (docs/06) — un run = une exécution d'agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent           TEXT NOT NULL,
    task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    model           TEXT,                 -- ollama:llama3.1:8b | claude:... | groq:...
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_usd        REAL DEFAULT 0,       -- 0 pour Ollama/local
    duration_ms     INTEGER,
    ok              INTEGER NOT NULL DEFAULT 1,
    error           TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent, created_at);

-- ---------------------------------------------------------------------------
-- audit_log : journal RGPD / conformité — toute action sensible y est tracée
-- (collecte, publication, envoi, opt-out, effacement). Source de vérité légale.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity      TEXT NOT NULL,            -- business | website | email | suppression | subscription
    entity_id   TEXT,
    action      TEXT NOT NULL,            -- collected | published | queued | sent | suppressed | erased | blocked
    actor       TEXT NOT NULL DEFAULT 'system', -- agent ou 'human'
    detail      TEXT,                     -- JSON libre
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ============================================================================
-- Vues pratiques
-- ============================================================================

-- Prospects prêts à être contactés ET non supprimés ET avec e-mail générique.
CREATE VIEW IF NOT EXISTS v_contactable AS
SELECT b.*
FROM businesses b
WHERE b.qualified = 1
  AND b.email IS NOT NULL
  AND b.email_is_generic = 1
  AND b.status NOT IN ('suppressed', 'rejected', 'lost')
  AND NOT EXISTS (
        SELECT 1 FROM suppression_list s
        WHERE s.email = b.email COLLATE NOCASE
  );

-- Sites publiés expirés (à purger par l'agent hosting).
CREATE VIEW IF NOT EXISTS v_expired_sites AS
SELECT * FROM websites
WHERE status = 'published'
  AND expires_at IS NOT NULL
  AND expires_at < CAST(strftime('%s','now') AS INTEGER) * 1000;
