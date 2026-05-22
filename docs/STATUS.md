# Galaxia — état du projet

> **Doc vivante.** Mise à jour à chaque fin de session ou changement d'état.
> Dernière révision : **2026-05-22** (session galaxia@OpenJeff — veille en production, compose env_file câblé).

## Bootstrap éclair pour un nouvel agent

Si tu viens d'ouvrir une session dans ce repo, lis dans cet ordre (5 min) :

1. [`../BRIEFING.md`](../BRIEFING.md) — ⭐ briefing officiel de Jeff (vision + règles de travail)
2. **Ce fichier** — état réel des services et du travail à date
3. [`../CLAUDE.md`](../CLAUDE.md) — conventions techniques, garde-fous, piège mémoire
4. [`../QUESTIONS_POUR_JEFF.md`](../QUESTIONS_POUR_JEFF.md) — questions business ouvertes
5. [`STACK.md`](STACK.md) — composition technique (OpenClaw + NemoClaw + Ollama)
6. [`ARCHITECTURE.md`](ARCHITECTURE.md) — schéma Hub & Spoke
7. [`UPDATES.md`](UPDATES.md) — mécanisme de release proposé
8. **Ta mémoire Claude** (voir CLAUDE.md § mémoire — attention au double compte root/galaxia)

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

## Endpoints publics actifs

- `https://app.galaxia-os.com/` — page placeholder (file_server)
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
| `app.`        | ✅         | ✅ file_server |
| `updates.`    | ❌         | placeholder commenté |
| `install.`    | ❌         | placeholder commenté |
| `docs.`       | ❌         | placeholder commenté |

→ Quand `updates.`/`install.`/`docs.` propagent, décommenter dans [`../caddy/Caddyfile`](../caddy/Caddyfile) et `sudo systemctl reload caddy`.

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
| 1   | Brancher `updates.`/`install.`/`docs.` dans Caddy        | DNS OVH (Jeff, Q4)                                              |
| 2   | Valider option A pour les updates (registry Docker)     | Jeff : 4 questions ouvertes dans Q3 (POC livré, prêt à câbler) |
| 3   | Q10 — frontière OSS / premium (CLA, licence modules)    | Jeff (pas bloquant court terme)                                  |
| ✅  | E2E install.sh dans container Ubuntu fresh              | Résolu 2026-05-22 — `ops/e2e/Dockerfile` + `run-test.sh`, 22/22 assertions, job CI `install-e2e` |
| 5   | Quand 1er module appelant Claude API arrive : skill `/claude-api` | Pas de code Anthropic SDK dans le repo au 2026-05-22 — rappel pour quand un module premium ou un agent PME consommera Claude (prompt caching obligatoire dès le J1) |

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
