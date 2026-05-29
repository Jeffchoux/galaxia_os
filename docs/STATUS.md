# Galaxia — état du projet

> **Doc vivante.** Mise à jour à chaque fin de session ou changement d'état.
> Dernière révision : **2026-05-29** — **Galaxia 2.0 increment 2** livré et **déployé** (build + restart faits) : **WS3 Projets** (regroupement des conversations dans la sidebar) + **WS4 Vue Code** (onglet Code dans Arfa branché sur l'arborescence réelle du repo, lecture seule). Détail § « refonte UI » ci-dessous. Avant : voix cockpit **cross-browser par défaut** (cascade serveur Whisper + Kyutai) + **sélecteur de modèle** gratuit (Groq) / Opus à la demande. Sprint 3 (Voix Jarvis) toujours en cours — détail dans [`DECISIONS.md`](DECISIONS.md) § D6.

## Sélecteur de modèle chat : gratuit par défaut / Opus à la demande (2026-05-29, session root)

Demande Jeff : Opus 4.8 réservé à « coder/améliorer Galaxia + ma com », LLM **gratuit**
pour toutes les petites tâches, bascule **depuis le browser**. Aligne la politique
« pas de modèle premium par défaut » (le défaut Opus précédent la violait).

Livré (build OK, `svelte-check` 0 erreur) :
- **Deux modes** côté serveur (`streamReply(..., mode)` dans `claude.ts`) :
  - `free` (**défaut**) : **Groq**, API compatible OpenAI, chat **nu** (pas d'outils,
    pas de docs/vision, pas de mémoire persistante injectée). Nouveau module
    `src/lib/server/groq.ts` (streaming SSE en `fetch` direct, zéro nouvelle dép).
  - `pro` : **Opus 4.8 + outils** (comportement existant inchangé).
- **Prompt système** scindé : tronc commun + section outils (pro uniquement) +
  note « mode rapide » qui invite Jeff à passer en Opus pour les tâches lourdes.
- **Toggle dans le composer** (`+page.svelte`, bouton `⚡ Rapide` / `🧠 Opus`),
  persistant en `localStorage` (`galaxia.chatMode`), envoyé dans le POST `/api/chat`.
- **Coût** : Groq enregistré dans `usage` à **coût 0** (suivi du volume). Le défaut
  serveur est `free` même si le client n'envoie pas `mode` (jamais de premium par défaut).
- **Tracking résiduel** : `generateTitle`/résumé restent sur Haiku (micro-coût) quel
  que soit le mode.

**À faire par Jeff :**
1. Créer une clé gratuite sur https://console.groq.com → la poser dans
   `apps/cockpit/.env` (`GROQ_API_KEY=...`). Tant qu'elle est vide, le mode rapide
   renvoie une erreur claire et le mode Opus marche.
2. `sudo systemctl restart galaxia-cockpit.service`.

**Limite connue :** en mode rapide, un document joint est ignoré (chat nu) — la note
système dit à Galaxia de suggérer le mode Opus si la tâche touche un fichier.

## Galaxia 2.0 — refonte UI « copie conforme Claude Code » (2026-05-29, session root)

Chantier lancé : faire du cockpit une interface type Claude Code (chat + artefacts
+ projets + vue code) avec une **identité violette** distincte du terracotta de Claude.

Livré (increment 1) :
- **Design system** : `apps/cockpit/src/lib/theme.css` — tokens CSS (palette violette
  `--g-primary` #7c3aed, surfaces, états voix, rayons, ombres). Importé dans
  `+layout.svelte`. Les couleurs hardcodées du monolithe `+page.svelte` ont été
  migrées vers ces variables (le thème se change désormais en un seul endroit).
- **Layout 3 panneaux** : la grille passe de 2 à 3 colonnes
  (`sidebar | chat | Arfa`). Le panneau **Arfa** (artefacts) remplace l'ancienne
  modale d'aperçu document : docké à droite, animé, repli sous 1100px en overlay.

Livré (increment 2 — 2026-05-29, session root) :
- **WS3 Projets** : table `projects` + colonne `conversations.project_id` (migration
  idempotente, `ON DELETE SET NULL` → supprimer un projet conserve ses conversations).
  Helpers DB (`listProjects/createProject/renameProject/deleteProject/setConversationProject`),
  routes `/api/projects` (POST/PATCH/DELETE) et `/api/conversations` (POST accepte
  `project_id`, nouveau PATCH pour ranger une conv). Sidebar : projets repliables
  (état persisté en `localStorage`), `＋`/`✎`/`🗑` par projet, section « Hors projet »,
  sélecteur de projet dans l'entête du chat. Tout vérifié de bout en bout.
- **WS4 Vue Code** (lecture seule, choix Jeff) : onglet **Code** dans Arfa branché
  sur l'**arborescence réelle du repo** (`getCodeRoot()`, défaut `/home/galaxia/galaxia-project`)
  — la même que l'agent coder édite via MCP. Endpoint `/api/code` (tree + lecture
  fichier) avec gardes : auth, anti-traversée (realpath + containment, symlinks
  compris), filtre `node_modules/.git/build/data/…`, rejet binaire et > 512 Kio.
  Rendu fichier avec numéros de ligne ; bouton ⟳ pour resynchroniser après édition
  agent ; panneau élargi (`--g-arfa-w-wide`) en mode Code. `svelte-check` 0 erreur.
  L'édition depuis le browser reste volontairement hors périmètre (l'agent édite).

Reste à faire :
- Refinement : rendu inline markdown/code dans Arfa onglet Doc (actuellement iframe `/api/documents/[id]`).
- Coloration syntaxique dans la vue Code (actuellement mono + numéros de ligne, sans tokenizer).

## Audit système — 2026-05-29 (session root)

État réel vérifié sur OpenJeff, à jour de la fin du Sprint 3 (PR #19). Corrige
plusieurs points devenus faux dans la table « Services qui tournent » ci-dessous.

- **Pas de GPU sur le VPS** (`nvidia-smi` absent). La stack voix tourne en **int8 CPU**,
  pas « GPU mère » comme l'indique la roadmap : Whisper STT (`faster-whisper large-v3-turbo`,
  `127.0.0.1:5500/5502`) + Kyutai Pocket TTS (`french_24l`, `127.0.0.1:5501`) + Piper. Les trois
  daemons sont **actifs**. Latence/débit voix plafonnés par le CPU — à garder en tête pour la 2.0.
- **Services actifs confirmés** : caddy, docker, ollama, `galaxia-cockpit` (`127.0.0.1:3001`),
  `galaxia-bot` (Telegram), `galaxia-piper`, `galaxia-kyutai-tts`, `galaxia-whisper`.
- **Timers daily** : `galaxia-digest` (06:00), `galaxia-veille` (06:32), `galaxia-coder` (07:01).
- **`galaxia-update.timer` : introuvable** (`systemctl is-enabled` → not-found) alors que ce doc le
  disait `enabled`. À investiguer (supprimé ? renommé ?).
- **Ollama** : `llama3.1:8b` présent mais **0 modèle chargé en RAM** (`ollama ps` vide) → cold start
  à chaque appel local.
- **Réseau sain** : UFW restrictif (22/80/443 publics ; 8080/11435 scopés `172.19.0.0/16`),
  tout le reste en `127.0.0.1`, Caddyfile système == repo (aucun drift), fail2ban actif.
- **Sécurité corrigée ce jour** : `/opt/agents/telegram-bot/.env` était en `644` (world-readable)
  → repassé `600`. Repo Galaxia avait de nombreux fichiers `root`-owned (piège double-compte) →
  `chown -R galaxia:galaxia` appliqué.
- **Cockpit** : `COCKPIT_MODEL=claude-opus-4-8` (défaut codé `env.ts` aussi `opus-4-8` depuis 2026-05-29).
  ⚠️ Toujours incohérent avec D3 (Sonnet par défaut pour le coût) — défaut premium maintenu à la
  demande de Jeff pour la session Voix Jarvis (2026-05-29). À retrancher après dogfooding voix.
- **Voix cockpit — bascule cross-browser 2026-05-29** : défauts STT/TTS passés à `whisper` + `kyutai`
  (cascade serveur). SpeechRecognition / SpeechSynthesis restent disponibles via toggle mais ne
  sont plus indispensables → l'UI fonctionne désormais sur Firefox et Safari (exigence Jeff
  « Mac + Windows, n'importe quel navigateur »). Auto-bascule de `browser` vers `whisper` si
  Web Speech absent au moment du clic 🎤. Restart `galaxia-cockpit.service` nécessaire pour activer.

## Bootstrap éclair pour un nouvel agent

Si tu viens d'ouvrir une session dans ce repo, lis dans cet ordre (5 min) :

1. [`../BRIEFING.md`](../BRIEFING.md) — ⭐ briefing officiel de Jeff (vision + règles de travail)
2. **Ce fichier** — état réel des services et du travail à date
3. [`ROADMAP-Q3-2026.md`](ROADMAP-Q3-2026.md) — plan trimestriel (sprints, décisions, anti-patterns)
4. [`../CLAUDE.md`](../CLAUDE.md) — conventions techniques, garde-fous, piège mémoire
5. [`../QUESTIONS_POUR_JEFF.md`](../QUESTIONS_POUR_JEFF.md) — questions business ouvertes
6. [`STACK.md`](STACK.md) — composition technique (OpenClaw + NemoClaw + Ollama)
7. [`ARCHITECTURE.md`](ARCHITECTURE.md) — schéma Hub & Spoke
8. [`UPDATES.md`](UPDATES.md) — mécanisme de release proposé
9. **Ta mémoire Claude** (voir CLAUDE.md § mémoire — attention au double compte root/galaxia)

Tout le reste découle de là.

## Services qui tournent (galaxie mère, OpenJeff)

| Service                 | État        | Notes                                                                              |
|-------------------------|-------------|------------------------------------------------------------------------------------|
| Docker                  | active      | Daemon OK ; 2 containers (n8n + sandbox NemoClaw `openshell-galaxia-main-*`)      |
| Caddy v2.11.3           | active      | vhosts `app.galaxia-os.com` + redirect apex, TLS Let's Encrypt OK                  |
| Ollama 0.24.0           | active      | `localhost:11434`, llama3.1:8b chargé, override systemd `OLLAMA_HOST=127.0.0.1:11434` |
| NemoClaw v0.0.48        | installed   | CLI `/home/galaxia/.local/bin/nemoclaw`, version 0.0.48                            |
| OpenShell v0.0.39       | running     | Gateway sur `127.0.0.1:8080` et `172.19.0.1:8080`, sandbox `galaxia-main` Ready    |
| Ollama auth proxy       | running     | Sur `172.19.0.1:11435`, pid `~/.nemoclaw/ollama-auth-proxy.pid`                    |
| fail2ban + UFW          | active      | Ports publics : 22, 80, 443, **5678** + 2 rules scopées 172.19.0.0/16 → 8080/11435 |
| n8n (legacy)            | stopped     | Arrêté le 2026-05-22 (Jeff ne se souvenait pas de l'usage), volume `n8n_n8n_data` conservé |
| Cockpit Galaxia         | active      | `galaxia-cockpit.service` SvelteKit prod sur `127.0.0.1:3001`, exposé via Caddy sur `app.galaxia-os.com`, DB SQLite `apps/cockpit/data/cockpit.db`. **Multi-user (Sprint 2)** : magic link via mail (provider Brevo ou Console), allow-list silencieuse, password admin secondaire, scoping `user_id` sur toute la DB, cost tracking par appel Anthropic dans table `usage`. Voix Web Speech STT/TTS + wake word + VAD Silero v5 + barge-in + cowork V1 + memory + MCP. |
| Piper TTS daemon        | active      | `galaxia-piper.service` daemon HTTP local FR souverain consommé par `/api/tts` (≈5× plus rapide que spawn shell par requête) |
| Cockpit dashboard NemoClaw | enabled (inactive — pas rebooté depuis création de l'unit 2026-05-23 08:12) | `galaxia-nemoclaw-dashboard.service` doit restaurer le tunnel SSH `127.0.0.1:18789` au prochain boot ; le tunnel actuel a été démarré à la main et `nemoclaw.galaxia-os.com` répond 200 OK |

## Endpoints publics actifs

- `https://app.galaxia-os.com/` — **Cockpit Galaxia V1** (SvelteKit), login magic link primary + mot de passe admin secondaire, chat Claude streaming, persistance SQLite, cost tracking par user
- `https://app.galaxia-os.com/login` — page de login (magic link + admin)
- `https://app.galaxia-os.com/auth/verify?token=…` — consomme un magic link envoyé par mail (single-use, validité 15 min)
- `https://nemoclaw.galaxia-os.com/` — dashboard NemoClaw (reverse_proxy souverain, token dans le fragment URL)
- `https://install.galaxia-os.com/` — sert `scripts/install.sh` (text/x-shellscript) pour `curl … | sudo bash`. Re-sync manuel via `sudo bash scripts/sync-www.sh` après toute modif de `install.sh`.
- `https://updates.galaxia-os.com/` — webroot Hub & Spoke (`/var/www/galaxia-updates`). 404 tant que `scripts/galaxia-publish.sh` n'a pas posé sa première publication (et c'est OK : `galaxia-update.sh` côté fille traite ça comme "rien à faire").
- `https://docs.galaxia-os.com/` — redirection permanente vers le repo GitHub (en attendant un vrai site doc).
- `https://galaxia-os.com/` → 301 vers `https://app.galaxia-os.com/`

## Co-locataires sur OpenJeff (hors repo Galaxia)

OpenJeff héberge aussi des projets clients de Jeff, séparés de Galaxia mais
partageant le même Caddy/UFW. Documentés ici pour qu'une future session ne
soit pas surprise de voir un service inconnu.

| Projet           | Service systemd | Frontal              | Code           | Logs / rapport build              |
|------------------|-----------------|----------------------|----------------|-----------------------------------|
| BabyRun **Lina** (call center vocal Twilio↔OpenAI) | `lina.service` (loaded; disabled; inactive — attend `/opt/lina/.env`) | Caddy vhost `lina.babyrun.re` (auto-TLS) | `/opt/lina/` (owner `lina:lina`) | `/var/log/lina-build.log` (trace pas-à-pas) + `/root/RAPPORT-LINA.md` (rapport final, clés à coller, procédure de démarrage) |

Règle : **rien de spécifique à un projet client ne va dans le repo Galaxia**.
Les liens ci-dessus pointent sur des chemins du VPS, pas sur le repo.

## DNS galaxia-os.com (registrar OVH)

| Sous-domaine  | Propagé ?  | Caddy vhost   |
|---------------|------------|---------------|
| @ (apex)      | ✅         | ✅ redirect    |
| `app.`        | ✅         | ✅ reverse_proxy → cockpit (3001) |
| `nemoclaw.`   | ✅         | ✅ reverse_proxy → dashboard NemoClaw (18789) |
| `updates.`    | ✅         | ✅ file_server `/var/www/galaxia-updates` (404 jusqu'à 1re publication) |
| `install.`    | ✅         | ✅ file_server `/var/www/galaxia-install/install.sh` (Content-Type shellscript) |
| `docs.`       | ✅         | ✅ redir 301 → `https://github.com/Jeffchoux/galaxia_os` |

## Repo Git

- 12 commits sur `main`, working tree clean
- Remote : `git@github.com:Jeffchoux/galaxia_os.git`
- **Push OK** au 2026-05-22 (deploy key `galaxia-vps-openjeff` ajoutée par Jeff sur le repo, Read/Write)
- Voir l'historique via `git log --oneline` (12 commits depuis le scaffold initial)

## Travail à faire (priorisé)

| Pri | Item                                                    | Bloqué sur                                                    |
|-----|---------------------------------------------------------|---------------------------------------------------------------|
| ✅  | Push GitHub                                              | Résolu 2026-05-22 (deploy key OK)                              |
| ✅  | Décision n8n                                             | Résolu 2026-05-22 (arrêté, volume conservé)                    |
| ✅  | Installer NemoClaw — d'abord en Docker isolé             | Résolu 2026-05-22 (sandbox `galaxia-main` Ready)               |
| ✅  | Q8 accès dashboard NemoClaw                              | Résolu 2026-05-22 (A par défaut, B en cible)                   |
| ✅  | Wizard CLI manager-friendly (FR, install PME)           | Résolu 2026-05-22 — `scripts/wizard.sh` (4 scénarios testés)    |
| ✅  | Q6 stockage clés API                                     | Résolu 2026-05-22 (.env chmod 600 par défaut, autonomie)        |
| ✅  | Câbler `docker-compose.yml` services + `env_file: .env`  | Résolu 2026-05-22 (ancre YAML `x-galaxia-env`, `required: false`, smoke-test OK) |
| ✅  | Module de veille IA quotidien (HN, GitHub, arxiv, HF)    | Résolu 2026-05-22 — systemd timer actif (06:30 UTC) + 4 sources |
| ✅  | CI GitHub Actions (shellcheck + tests + compose + wizard) | Résolu 2026-05-22 — 4 jobs verts + 1 job cosign round-trip      |
| ✅  | `scripts/install.sh` durci pour `curl \| bash` public      | Résolu 2026-05-22 — wizard download fallback, healthcheck, cron sécurisé |
| ✅  | `scripts/health.sh` — bilan santé une page (console/quiet/json) | Résolu 2026-05-22                                         |
| ✅  | POC mécanisme d'updates (client + serveur + cosign)      | Résolu 2026-05-22 — `galaxia-update.sh` (fille) + `galaxia-publish.sh` (mère) + CI round-trip |
| ✅  | `bootstrap_galaxia_dir` + timer `galaxia-update.timer`   | Résolu 2026-05-22 — `install_update_runtime()` pose binaire+units, daemon-reload, enable timer |
| ✅  | Brancher `updates.`/`install.`/`docs.` dans Caddy        | Résolu 2026-05-24 — DNS propagés, vhosts actifs, certs LE OK (PR #6) |
| 2   | Valider option A pour les updates (registry Docker)     | Jeff : 4 questions ouvertes dans Q3 (POC livré, prêt à câbler) |
| 3   | Q10 — frontière OSS / premium (CLA, licence modules)    | Jeff (pas bloquant court terme)                                  |
| ✅  | E2E install.sh dans container Ubuntu fresh              | Résolu 2026-05-22 — `ops/e2e/Dockerfile` + `run-test.sh`, 22/22 assertions, job CI `install-e2e` |
| ✅  | Quand 1er module appelant Claude API arrive : skill `/claude-api` | Résolu 2026-05-23 — cockpit V1 (`apps/cockpit/`) consomme `@anthropic-ai/sdk` en streaming SSE |
| ✅  | Cockpit V1 (texte) sur `app.galaxia-os.com`             | Résolu 2026-05-23 — SvelteKit + adapter-node, auth password+session HMAC, chat Claude streaming, persistance SQLite, Dockerfile pour les filles |
| ✅  | Memory tool + MCP côté cockpit (étape 2 de PRODUCT-VISION) | Résolu 2026-05-23 — auto-résumé conversations + `memory.md`, organisation Haiku v2.1, MCP servers filesystem (fixe) + GitHub/Brave (conditionnels) + Galaxia maison (stdio) |
| ✅  | Voix in/out + wake word (étape 4 de PRODUCT-VISION)     | Résolu 2026-05-23 — Web Speech STT fr-FR, TTS streaming par phrase, wake word « Hey Galaxia » (regex sur SpeechRecognition), VAD hands-free, TTS premium Piper local FR via daemon HTTP |
| ✅  | Cowork V1 (étape 5 de PRODUCT-VISION)                   | Résolu 2026-05-23 — upload PDF/Markdown/TXT attaché à la conversation, vision Claude pour photos (JPG/PNG/WEBP/GIF), preview docs joints (modal iframe), onglet Documents + onglet Briefs |
| ✅  | Browser smoke test cockpit                              | Résolu 2026-05-23 — `ops/browser-smoke/test.mjs` Playwright headless 12 assertions vertes. Branché en CI le 2026-05-24 — job `cockpit-smoke` (boot cockpit stub `SESSION_SECRET`, surface publique seulement) |
| ✅  | Bot Telegram dans le repo                               | Résolu 2026-05-23 — `agents/telegram/` (était hors repo, désormais versionné)                                                  |
| 1   | Installation PME pilote (1ère galaxie fille réelle)     | Pré-req tous livrés (Docker packaging, install.sh, wizard, cockpit complet). Bloque sur identification d'une PME pilote (cf. décision D2 de la roadmap Q3) |
| 1   | Coder agent — `gh pr create` échoue depuis systemd (pas de GH_TOKEN dans l'env du service) | Push de branche OK via SSH deploy key, mais la PR n'est jamais créée. Soit poser un PAT scope `repo` dans l'env du service (avec `Environment=GH_TOKEN=…`), soit basculer le coder vers `gh auth login` avec son propre compte technique. Sprint 4. |
| 3   | Valider option A pour les updates (registry Docker)     | Jeff : 4 questions ouvertes dans Q3 (POC livré, prêt à câbler) |
| 4   | Q10 — frontière OSS / premium (CLA, licence modules)    | Jeff (pas bloquant court terme)                                  |
| 5   | Plugin `nemoclaw` du gateway — bug JSON                 | Pas bloquant ; à reporter upstream NVIDIA quand on en a besoin pour une feature (cf. Q9) |

## Cockpit — détail d'exploitation (2026-05-23 fin de journée)

**Cockpit complet livré en une journée.** Couvre les 5 couches de [`PRODUCT-VISION.md`](PRODUCT-VISION.md) §4 en V1.

### Stack

- **SvelteKit 2 + Svelte 5** (runes `$state` / `$props`), `@sveltejs/adapter-node` → binaire Node standalone derrière Caddy.
- **`@anthropic-ai/sdk`** en streaming SSE (modèle par défaut `claude-opus-4-7`, surchargeable via `COCKPIT_MODEL`). Le coder agent reste sur `claude-agent-sdk` car il a besoin de tools ; le cockpit chat-only utilise le SDK basique, plus léger.
- **`@modelcontextprotocol/sdk`** + serveurs MCP officiels (filesystem, GitHub, Brave) + serveur Galaxia maison (`apps/mcp-galaxia/`).
- **`better-sqlite3`** pour la persistance des conversations (`data/cockpit.db`, mode WAL).
- **`@node-rs/argon2`** pour le hash du mot de passe, **HMAC SHA-256** maison pour signer le cookie de session (pas de JWT lib).
- **`marked`** pour le rendu Markdown (briefs + memory).
- **Web Speech API** côté navigateur pour STT (fr-FR) et TTS streaming par phrase ; **Piper TTS** local FR via daemon HTTP pour TTS souverain premium.

### Fonctionnalités V1 (toutes livrées 2026-05-23)

| Couche PRODUCT-VISION §4   | Couverture cockpit                                                                                                                                                     |
|----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Module client Claude (1)   | Streaming SSE Claude Opus 4.7, modèle surchargeable                                                                                                                    |
| Memory + MCP (2)           | Memory tool : auto-résumé des conversations dans `memory.md`, Haiku v2.1 réorganise les sections au lieu d'append. Tools : `update_memory`, `read_brief`, `list_briefs`. MCP servers : filesystem (toujours), GitHub + Brave (conditionnels sur PAT/clé), Galaxia maison (stdio) |
| Interface web cockpit (3)  | Routes : `/` (chat principal), `/briefs` (sidebar + viewer markdown), `/documents` (onglet dédié), `/login`, `/logout`, `/api/{chat,conversations,documents,tts}`     |
| Voix in/out + wake word (4)| STT Web Speech fr-FR, TTS streaming phrase par phrase, wake word « Hey Galaxia » (regex sur SpeechRecognition), VAD hands-free (interruption naturelle), TTS premium Piper FR via daemon |
| Cowork V1 (5)              | Upload PDF/Markdown/TXT attaché à la conversation, vision Claude pour photos (JPG/PNG/WEBP/GIF), preview docs joints (modal iframe natif)                              |

### Composants

| Bloc                          | Chemin                                                          |
|-------------------------------|-----------------------------------------------------------------|
| Code cockpit                  | `apps/cockpit/`                                                 |
| MCP server Galaxia            | `apps/mcp-galaxia/` (stdio, expose Galaxia au monde MCP)        |
| Bot Telegram                  | `agents/telegram/`                                              |
| Agent coder                   | `agents/coder/`                                                 |
| Agent veille IA               | `agents/veille/`                                                |
| Service systemd cockpit       | `/etc/systemd/system/galaxia-cockpit.service` (source : `ops/galaxia-cockpit.service`) |
| Service systemd Piper         | `/etc/systemd/system/galaxia-piper.service`                     |
| Caddy vhost                   | `app.galaxia-os.com` (reverse_proxy 127.0.0.1:3001)             |
| Image Docker (filles PME)     | `galaxia/cockpit:latest` — service `cockpit` dans `docker-compose.yml` (profile `cockpit`) |
| Secrets                       | `apps/cockpit/.env` (chmod 600, owner galaxia, **gitignored**)  |
| DB                            | `apps/cockpit/data/cockpit.db` (créée au premier démarrage)     |
| Memory persistante            | `apps/cockpit/data/memory.md`                                   |
| Smoke test                    | `ops/browser-smoke/test.mjs` (Playwright headless, 12 assertions) |

### Accès

URL : <https://app.galaxia-os.com>
Mot de passe par défaut (2026-05-23) : **`alpha-nova-galaxia-signal-55`** — à changer par Jeff via le hash dans `.env` :

```bash
sudo -u galaxia bash -lc 'cd /home/galaxia/galaxia-project/apps/cockpit && node -e "
import(\"@node-rs/argon2\").then(a=>a.hash(process.argv[1],{memoryCost:19456,timeCost:2}).then(console.log))
" -- "MonNouveauPasse"'
# Coller la sortie dans JEFF_PASS_HASH= du fichier .env, puis :
sudo systemctl restart galaxia-cockpit.service
```

### Commandes utiles

```bash
sudo systemctl status galaxia-cockpit.service       # état
sudo journalctl -u galaxia-cockpit.service -f       # logs live
sudo systemctl restart galaxia-cockpit.service      # restart (kick deploy après edit .env)
sudo -u galaxia bash -lc 'cd ~/galaxia-project/apps/cockpit && npm run build'  # rebuild après edit du code
```

### Limites restantes V1 (couches V2 à venir selon PRODUCT-VISION)

- **Cowork** = upload de fichiers attachés au chat seulement. Pas encore d'édition multi-fichiers live, pas de screenshare API, pas d'observation de l'écran (étape la plus complexe d'après §3.4)
- **Voix** repose sur Web Speech API du navigateur (Chrome/Edge OK, Safari partiel, Firefox limité). Pour souveraineté totale côté STT, prochaine étape : Whisper local (whisper.cpp) en remplacement de SpeechRecognition côté serveur
- **Wake word** = filtre regex sur SpeechRecognition (suffit en V1) ; Picovoice Porcupine prévu en V2 pour wake word natif basse latence
- **Multi-user** = Jeff seul (single password). Quand on ouvre aux PME, basculer sur magic link / OAuth
- **Memory** côté Claude est `memory.md` global, pas par projet / par conversation (suffit pour V1, à compartimenter quand la PME a plusieurs collaborateurs)

## NemoClaw — état d'install détaillé (2026-05-22)

**Install réussi** sur OpenJeff (compte `galaxia`) après vérif chaîne d'origine.

### Composants opérationnels

- `nemoclaw v0.0.48` installé via `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash` (env vars : `NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1`, `NEMOCLAW_PROVIDER=ollama`, `NEMOCLAW_SANDBOX_NAME=galaxia-main`)
- `openshell v0.0.39` (CLI rust) à `~/.local/bin/openshell`, déjà avec verif SHA-256 lors du download
- Sandbox `galaxia-main` créé (image `openshell/sandbox-from:1779412425`, 74 steps de build, ~15 min)
- Gateway OpenClaw tournant dans le sandbox, modèle `inference/llama3.1:8b`, 4 plugins chargés (browser, device-pair, phone-control, talk-voice)
- Inference routée vers Ollama local via `inference.local` (DNS alias géré par le gateway)

### Quirks observés

1. **Docker healthcheck reporte "unhealthy"** : la healthcheck `curl 127.0.0.1:18789/health` tourne dans le namespace réseau du wrapper container, mais le gateway tourne dans le sub-namespace OpenShell. Le 18789 est volontairement non exposé sur l'hôte. À débugger ou à accepter comme normal.

2. **Plugin `nemoclaw` échoue à se charger dans le gateway** : `SyntaxError: Unexpected end of JSON input` sur `/sandbox/.openclaw/extensions/nemoclaw/dist/index.js`. Les 4 autres plugins fonctionnent. Bug à reporter upstream ou à investiguer.

3. **Dashboard non exposé à l'hôte par design.** Décision Q8 (2026-05-22) :
   - **Défaut wizard** : `nemoclaw tunnel start` (pattern natif NemoClaw) → URL `<sub>.trycloudflare.com` accessible en zéro config DNS
   - **Cible une fois domaine PME branché** : openshell port-forward + Caddy reverse proxy sur `<domaine-pme>` → souverain
   - Détail dans [`DECISIONS.md`](DECISIONS.md) § Q8

### UFW rules ajoutées (à reproduire côté galaxies filles)

```
ufw allow from 172.19.0.0/16 to 172.19.0.1 port 8080 proto tcp   # OpenShell gateway
ufw allow from 172.19.0.0/16 to 172.19.0.1 port 11435 proto tcp  # Ollama auth proxy
```

Ces deux règles sont désormais dans `scripts/install.sh` → `install_nemoclaw()` pour les galaxies filles.

### Logs d'install

`ops/logs/nemoclaw-*.log` (4 fichiers, root-owned car lancés depuis cette session root).

## Vérification de la chaîne d'origine NemoClaw (2026-05-22)

**Résolu :** la chaîne d'origine est légitime. Détail de la vérif :

- `curl -fsSL https://www.nvidia.com/nemoclaw.sh` retourne **HTTP 301 d'Akamai** (CDN officiel NVIDIA, header `nv-defunct-locale-redirection`, `server: AkamaiGHost`) vers `https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/install.sh`. C'est une **vanity URL Akamai** maintenue par NVIDIA.
- Le bootstrap (5852 octets) est court, signé `Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES`, licence Apache 2.0, code défensif (`set -euo pipefail`, validation du shebang + hash optionnel, trap cleanup).
- Le bootstrap clone `https://github.com/NVIDIA/NemoClaw.git` et exécute `scripts/install.sh` interne. Ce dernier (2451 lignes) installe : NVM → Node → Docker (via `get.docker.com` officiel) → NemoClaw via npm. Aucune URL externe non-officielle, aucune lecture de credentials sensibles.

**Préoccupations restantes (mineures) :**

- `docs.nvidia.com/nemoclaw/...` redirige (303) vers `app.buildwithfern.com` — atypique pour NVIDIA mais buildwithfern est un SaaS de docs légitime, c'est sans doute un choix produit NemoClaw (early preview). Pas un signal d'attaque.
- Une page fetchée précédemment contenait une fausse balise `<system-reminder>` — venait probablement d'un site SEO-spam tiers (pas du repo officiel), pas du vrai installer.

**Conclusion :** install dans Docker isolé OK pour la session du 2026-05-22.
Côté hôte OpenJeff : attendre le résultat du test sandbox avant d'engager.

## Questions ouvertes pour Jeff

→ Toutes les questions business en attente vivent désormais dans
[`../QUESTIONS_POUR_JEFF.md`](../QUESTIONS_POUR_JEFF.md) à la racine du projet
(format : bloc daté, options proposées, impact). Jeff y répond à son rythme.
Quand une question est tranchée, son bloc migre vers `docs/DECISIONS.md`.

**Règle :** ne jamais demander à Jeff dans le chat pour une décision business —
écrire dans `QUESTIONS_POUR_JEFF.md` et continuer sur autre chose.

## Mémoires Claude existantes (compte `galaxia`)

Voir `/home/galaxia/.claude/projects/-home-galaxia-galaxia-project/memory/` :

- `user_jeff.md` — Jeff = manager non-dev, attend exécution autonome
- `feedback_autonomy.md` — pas de confirmation pour les commandes routine
- `project_galaxia_overview.md` — vision produit (Hub & Spoke, pas SaaS)
- `project_infrastructure_vps.md` — specs VPS, DNS, sécurité
- `project_stack_openclaw_nemoclaw.md` — ⚠️ à reconfronter à la préoccupation ci-dessus
- `project_n8n_legacy.md` — container n8n hérité, rôle à clarifier
