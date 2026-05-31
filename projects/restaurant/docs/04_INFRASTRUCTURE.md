# 04 — Infrastructure : choix concrets et fichiers d'unité

> Projet **`restaurant`**, hôte **OpenJeff** (`188.34.188.200`). Source de vérité :
> `docs/00` (inventaire réel), `docs/01 §7` (choix d'infra), `database/schema.sql`.
> Principe : **réutiliser l'existant** (Caddy, systemd, SQLite, venv galaxia), zéro nouveau
> composant. État courant : **Anneau 0 — dry-run** ; l'infra e-mail/Stripe est **décidée
> ici mais non activée** (`docs/01 §6`, `§13`).

Arborescence projet (sous `/home/galaxia/galaxia-project/projects/restaurant/`) :

```
restaurant/
├── data/restaurant.db          # SQLite WAL (gitignored)
├── database/schema.sql         # DDL (source de vérité tables)
├── pipeline/                   # coordinator.py, worker.py, db.py, agents runtime
├── agents/*.md                 # 19 rôles (docs/02 §4)
├── ops/                        # *.service, *.timer (calqués sur ops/ racine)
├── logs/dry_run_emails/*.eml   # e-mails écrits sur disque (Anneau 0)
└── docs/                       # 00..09
# hors projet (servi par Caddy) :
/var/www/galaxia-restaurant-sites/{slug}/   # sites statiques (Anneau 1+)
```

---

## 1. SQLite — disposition

- **Fichier unique** `data/restaurant.db`, mode **WAL** (`PRAGMA journal_mode=WAL`,
  `foreign_keys=ON` — `schema.sql §17-18`). Pattern déjà en prod (`tg_tasks`, `docs/00 §5`).
- **Aucun serveur** : module Python `sqlite3` du venv galaxia
  (`/home/galaxia/.claude/galaxia/venv/bin/python`). Pas de Postgres, pas de Redis
  (`docs/00 §5`).
- **Concurrence** : un seul **writer** (le worker) via `BEGIN IMMEDIATE` pour le claim
  atomique des `tasks` ; lecteurs multiples grâce au WAL. Verrou → retries (`docs/01 §12`).
- **Tables** (DDL complet `schema.sql`) : `businesses`, `website_audits`, `websites`,
  `emails`, `suppression_list`, `replies`, `subscriptions`, `tasks`, `agent_runs`,
  `audit_log` + vues `v_contactable`, `v_expired_sites`.
- **Sauvegarde** : copie quotidienne (`.backup`) du fichier WAL-checkpointé (`docs/01 §12`,
  « DB corrompue → sauvegarde quotidienne »). Fichier **gitignored** (`docs/00 §10`).
- **Init** : `python pipeline/db.py --init` ou `sqlite3 data/restaurant.db < database/schema.sql`.

## 2. Worker résident + unité systemd

Calqué **trait pour trait** sur `ops/galaxia-tg-worker.service` (`docs/00 §9`, `docs/02 §3`).
Service `simple`, résident, `Restart=on-failure` (`docs/01 §12`, worker orphelin → relance).

`ops/galaxia-restaurant-worker.service` :

```ini
[Unit]
Description=Galaxia restaurant — worker résident (file SQLite → agents, Ollama/claude)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=galaxia
Group=galaxia
WorkingDirectory=/home/galaxia/galaxia-project/projects/restaurant
# Clés LLM (Ollama local sans clé ; ANTHROPIC_API_KEY pour claude ad hoc) + GH si besoin.
EnvironmentFile=-/opt/galaxia/config/.env
EnvironmentFile=-/home/galaxia/galaxia-project/projects/restaurant/.env
ExecStart=/home/galaxia/.claude/galaxia/venv/bin/python \
          /home/galaxia/galaxia-project/projects/restaurant/pipeline/worker.py
Restart=on-failure
RestartSec=5
Nice=10
StandardOutput=journal
StandardError=journal

# Garde-fous (cf. galaxia-coder.service, docs/01 §11)
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
# Le worker écrit la DB, les builds de sites locaux et les e-mails dry-run :
ReadWritePaths=/home/galaxia/galaxia-project/projects/restaurant/data \
               /home/galaxia/galaxia-project/projects/restaurant/logs \
               /var/www/galaxia-restaurant-sites

[Install]
WantedBy=multi-user.target
```

> Le worker exécute via `claude -p --permission-mode` / Ollama en `start_new_session`
> (groupe process isolé → kill-switch via `tasks.pgid`), timeout dur par tâche, statuts
> `pending→running→done|error|killed`, audit en base (`docs/00 §9`, `docs/02 §3`).

### Timers (oneshots) — calqués sur `galaxia-coder.timer`

`ops/galaxia-restaurant-discovery.timer` (exemple ; même gabarit pour `followup`, `purge`,
`retention`, cf. `docs/02 §3`) :

```ini
[Unit]
Description=Galaxia restaurant — enfile un lot de découverte (horaire)

[Timer]
OnCalendar=hourly
Persistent=true              # rattrape si la machine était éteinte
RandomizedDelaySec=5min      # jitter, étiquette envers Overpass
Unit=galaxia-restaurant-discovery.service

[Install]
WantedBy=timers.target
```

Le `.service` associé est un `Type=oneshot` (User `galaxia`, `NoNewPrivileges`,
`TimeoutStartSec` borné) qui lance `pipeline/coordinator.py --enqueue discovery`. Les
producteurs **enfilent** des `tasks` ; c'est le worker résident qui exécute (`docs/02 §1`).

| Unité | Cadence | Action |
|-------|---------|--------|
| `…-discovery.timer` | `hourly` | enfile lot découverte borné |
| `…-followup.timer` | quotidien | enfile relances (Anneau 2) |
| `…-purge.timer` | `hourly` | retire `v_expired_sites` (TTL 7 j) |
| `…-retention.timer` | quotidien | purge RGPD (`retention_until`) |

## 3. Caddy — hébergement des sites temporaires

Caddy est **déjà actif** (v2.11.3, `docs/00 §4`) et sert déjà des statiques
(`install.`/`updates.galaxia-os.com`) : pattern éprouvé, **zéro nouveau composant**.

- **Webroot** : `/var/www/galaxia-restaurant-sites/{slug}/` — un site = un dossier statique
  (`websites.build_path`/`slug`, `schema.sql §websites`). Servi par l'utilisateur `caddy`.
- **URL** : `try.galaxia-os.com/{slug}/` (ou `sites.galaxia-os.com/{slug}/`, `docs/00 §4`).
- **HTTPS auto** (ACME) + **`file_server`** + **`noindex`** obligatoire tant que non réclamé
  (`websites.noindex=1`, `docs/01 §3.2`).

Bloc Caddyfile (Anneau 1+, **non activé en Anneau 0**) :

```
try.galaxia-os.com {
    root * /var/www/galaxia-restaurant-sites
    file_server
    # noindex sur TOUT (docs/01 §3.2) : aperçu non officiel, non indexable
    header X-Robots-Tag "noindex, nofollow"
    header Cache-Control "no-store"
    # pas d'upload, pas d'exécution : statique pur (docs/01 §11)
}
```

- **TTL 7 jours** : à la publication, `published_at` est posé et `expires_at = published_at
  + 7 j` (`schema.sql §websites`). La vue `v_expired_sites` liste les sites publiés expirés.
- **Purge** : `galaxia-restaurant-purge.timer` (horaire) supprime le dossier `{slug}/`,
  passe `websites.status='removed'`, pose `removed_at`, trace `audit_log` — évite aussi le
  **disque plein** (`docs/01 §12`).
- **Takedown / retrait 1-clic** (`docs/01 §3.2`, `§5`) : le bandeau du site (« aperçu non
  officiel généré par Galaxia, non affilié — réclamez ou supprimez ») pointe un lien token ;
  un clic → suppression du dossier + `suppression_list` + purge < 72 h.
- **`claimed`** (Anneau 3) : à l'abonnement, le site bascule **permanent** (`noindex` levable,
  TTL annulé).

> En **Anneau 0** : `dry_run=1`, `public_url=NULL` ; les sites sont **bâtis localement** mais
> **non publiés publiquement** (`docs/01 §6`). Le bloc Caddy ci-dessus n'est ajouté qu'en
> Anneau 1.

## 4. Infrastructure e-mail — DÉCISION (activée quand le dry-run est levé)

> **Anneau 0 = aucun envoi.** Les e-mails sont **écrits sur disque** dans
> `logs/dry_run_emails/*.eml` (`emails.dry_run=1`, `dry_run_path`). Ce qui suit est la
> **décision d'architecture** pour l'Anneau 1, à acter par Jeff (`docs/01 §13`).

Contrainte absolue (`docs/01 §2`, `§7`, `§13`) : **NE JAMAIS envoyer depuis l'IP ou le
domaine de Galaxia** (`galaxia-os.com` / `188.34.188.200`). Une plainte spam brûlerait la
réputation de tout le domaine, dont `app.galaxia-os.com`.

| Décision | Choix | Pourquoi |
|----------|-------|----------|
| **Domaine d'envoi** | **domaine dédié distinct** (ex. `mg.galaxia-resto.com`) | isole la réputation ; protège `galaxia-os.com` (`docs/01 §2`) |
| **Transport** | **prestataire transactionnel réputé** (API), pas de MTA maison | délègue la délivrabilité ; pas de Postfix à durcir (`docs/00 §12` manque MTA) |
| **SPF** | enregistrement TXT autorisant le prestataire | anti-usurpation |
| **DKIM** | clé signée par le prestataire sur le domaine dédié | intégrité du message |
| **DMARC** | politique `p=quarantine` puis `reject` après réchauffe | alignement, rapports |
| **Réchauffe** | volume faible croissant (`docs/01 §4`, `§6` Anneau 1) | construire la réputation |
| **Conformité message** | lien **unsubscribe** (token unique, `emails.unsubscribe_token`), **adresse postale physique** dans le pied, identité claire | RGPD/ePrivacy + CAN-SPAM (`docs/01 §4`) |
| **Garde-fou pré-envoi** | `suppression_list` vérifiée avant **chaque** mise en file (`v_contactable`) | opt-out irréversible (`docs/01 §3.7`) |
| **Seuils** | bounce/plaintes > seuil → **kill-switch** + pause + alerte | anti-blacklist (`docs/01 §12`) |

Bind dans l'unité worker : la clé API du prestataire arrive via `EnvironmentFile`
(`/opt/galaxia/config/.env`), jamais committée, jamais écrite dans un e-mail/site, jamais
loguée (`docs/01 §11`). Tant que ces points (`docs/01 §13`) ne sont pas tranchés, le système
**reste en dry-run** — défaut sûr.

## 5. Stripe — facturation (Anneau 3, non activé)

`docs/01 §3.6`, `§7`, `§10` ; mappé sur `subscriptions` (`schema.sql`).

- **Paiement entièrement délégué à Stripe** : Galaxia **ne stocke JAMAIS** de numéro de
  carte ni de donnée PCI. On ne conserve que des **références opaques**
  (`provider_customer_id`, `provider_sub_id`).
- Abonnement **10 €/$ / mois** (`amount_cents=1000`, `currency`), statut
  `pending→active→past_due|canceled`.
- **Webhooks Stripe** reçus sur un endpoint dédié (signé) → met à jour `subscriptions` ; à
  `active`, le `coordinator` bascule le site en `claimed` (permanent) et passe la `business`
  en `converted` (`docs/02 §2`).
- Factures, TVA, droit de rétractation, mandats : **gérés par Stripe** (`docs/01 §3.6`).
- Marge : ~9,60 €/client/mois après frais Stripe (`docs/01 §10`).

## 6. Packaging Docker — galaxie fille PME

Modèle **Hub & Spoke** (`docs/00 §3`, `docs/01 §7`). Docker 29.5.2 actif ; compose v2 ;
profil `pme` du `docker-compose.yml` racine.

- **Image** : Python 3.12-slim + le `pipeline/` + `agents/*.md` + `schema.sql`. SQLite
  embarqué (volume monté pour persistance). Ollama **externe** (sidecar ou hôte) pour rester
  léger.
- **Volumes** : `./data` (DB), `./logs`, `./sites` (servis par un Caddy du compose, ou le
  Caddy hôte). Secrets via `.env` monté (jamais dans l'image).
- **Compose (esquisse, profil `pme`)** :

```yaml
services:
  restaurant-worker:
    image: galaxia/restaurant:latest
    profiles: ["pme"]
    env_file: [./config/.env]          # secrets hors image
    volumes:
      - ./data:/app/data               # restaurant.db (WAL)
      - ./logs:/app/logs               # dry_run_emails
      - ./sites:/var/www/galaxia-restaurant-sites
    restart: on-failure
    user: "galaxia"                     # jamais root (docs/01 §11)
```

- La fille démarre **en Anneau 0** (dry-run) par défaut : sûr out-of-the-box. L'activation
  des anneaux supérieurs (envoi, Stripe) reste une **décision explicite** par installation,
  avec son propre domaine d'envoi dédié (`docs/01 §6`, `§13`).
- Manifests signés **cosign** comme le reste de Hub & Spoke (`docs/00 §10`).

## 7. Récapitulatif des chemins

| Élément | Chemin |
|---------|--------|
| Base | `/home/galaxia/galaxia-project/projects/restaurant/data/restaurant.db` |
| Schéma | `…/restaurant/database/schema.sql` |
| Worker | `…/restaurant/pipeline/worker.py` |
| Venv Python | `/home/galaxia/.claude/galaxia/venv/bin/python` |
| Secrets | `/opt/galaxia/config/.env` (root:600) + `…/restaurant/.env` (gitignored) |
| Unités | `…/restaurant/ops/galaxia-restaurant-*.{service,timer}` |
| E-mails dry-run | `…/restaurant/logs/dry_run_emails/*.eml` |
| Sites (Anneau 1+) | `/var/www/galaxia-restaurant-sites/{slug}/` |
