# 00 — Inventaire technique du système (Galaxia / OpenJeff)

> Projet **`restaurant`** — système multi-agents autonome 24/7.
> Inventaire produit par détection réelle sur le VPS le **2026-05-28** (révisé 2026-05-31).
> Hôte : **OpenJeff** (`188.34.188.200`), galaxie **mère** du modèle Hub & Spoke.

Ce document est la photographie de ce qui est **réellement installé et actif** sur la
machine au moment du démarrage du projet. Toute décision d'architecture (doc `01`) s'appuie
dessus. Rien n'est supposé : chaque ligne vient d'une commande (`command -v`, `systemctl`,
`ss -tlnp`, `curl`).

## 1. Résolution des noms du brief

Le brief parle de « Molos » et « Open Clos ». Confirmé avec Jeff : ce sont des
transcriptions phonétiques. Mapping retenu :

| Nom du brief | Outil réel        | Rôle                                              | État |
|--------------|-------------------|---------------------------------------------------|------|
| **Molos**    | **Ollama**        | Runtime LLM **local** (souverain, gratuit)        | ✅ actif |
| **Open Clos**| **OpenClaw**      | Moteur agentic (sortie janv. 2026)                | ⚠️ à intégrer, pas en PATH |
| —            | **NemoClaw**      | Sécurité / tunnel + dashboard (NVIDIA enterprise) | ⚠️ présent (`~/.nemoclaw`), partiel |

> **Conséquence projet :** on ne dépend PAS d'OpenClaw pour démarrer. Le runtime d'agents
> du MVP réutilise le pattern Galaxia déjà éprouvé : **`claude` headless + Ollama local +
> systemd + SQLite**. OpenClaw/NemoClaw sont notés comme cibles d'intégration futures, pas
> comme prérequis.

## 2. Langages & runtimes

| Outil      | Version détectée            | Dispo | Usage projet restaurant |
|------------|-----------------------------|-------|--------------------------|
| Python     | 3.12.3                      | ✅    | **Langage principal du pipeline** (cohérent avec agents/telegram, pipeline/) |
| Node.js    | v22.22.2                    | ✅    | Cockpit SvelteKit, agents veille/coder ; dispo pour outillage web |
| npm        | 10.9.7                      | ✅    | — |
| pnpm       | absent                      | ❌    | non requis |
| pip3       | 24.0                        | ✅    | venv dédié : `/home/galaxia/.claude/galaxia/venv` |

Venv Galaxia (`/home/galaxia/.claude/galaxia/venv/bin/`) : `python3.12`, `pip`, `yt-dlp`,
`piper`. C'est l'interpréteur que le pipeline restaurant réutilisera (déjà branché dans les
services systemd existants).

## 3. Conteneurisation & déploiement

| Outil          | Version / état                    | Rôle pour le projet |
|----------------|-----------------------------------|----------------------|
| **Docker**     | 29.5.2 — `docker.service` actif   | Packaging galaxie fille ; isolation des builds de sites si besoin |
| docker compose | v2 (plugin)                       | `docker-compose.yml` racine (profils `cockpit`/`pme`) |
| **systemd**    | actif (init)                      | **Process manager de référence** sur la mère (pas PM2) |
| **PM2**        | absent                            | ❌ non utilisé — on suit systemd |

Conteneur actif détecté : `openshell-galaxia-main-*` (sandbox openshell, sans rapport projet).

## 4. Reverse proxy & hébergement web

| Outil       | Version / état                          | Rôle pour le projet |
|-------------|------------------------------------------|----------------------|
| **Caddy**   | v2.11.3 — `caddy.service` **actif**     | **Reverse proxy + HTTPS auto (ACME)** + `file_server` statique. C'est le moteur d'hébergement des sites restaurants. |
| nginx       | présent mais `nginx.service` **failed** | ❌ ne pas utiliser (conflit ports 80/443 avec Caddy) |
| Traefik     | absent                                   | ❌ |

**Webroots existants** (`/var/www/`, servis par l'utilisateur `caddy`, mode 750 sur `/home`
donc le contenu public vit sous `/var/www/*`) :
`galaxia`, `galaxia-docs`, `galaxia-install`, `galaxia-updates`, `html`.
→ Le projet ajoutera **`/var/www/galaxia-restaurant-sites/`** pour les sites temporaires
(voir doc `04` hébergement). Caddy sert déjà des sites statiques de cette façon
(`install.galaxia-os.com`, `updates.galaxia-os.com`) : pattern éprouvé, zéro nouveau composant.

Sous-domaines `galaxia-os.com` déjà câblés dans Caddy : `app.`, `install.`, `updates.`,
`docs.`, `nemoclaw.`. Le projet propose `try.galaxia-os.com` (ou chemin
`sites.galaxia-os.com/{slug}/`) — voir doc `04`.

## 5. Bases de données

| Moteur      | État      | Décision projet |
|-------------|-----------|------------------|
| **SQLite**  | ✅ via module Python `sqlite3` + DB cockpit `apps/cockpit/data/cockpit.db` | **Base du projet** : `projects/restaurant/data/restaurant.db`. Mode WAL (déjà le pattern de `agents/telegram/tasks.py`). |
| PostgreSQL  | `psql` **absent**, aucun service | ❌ pas installé. Pas de dépendance Postgres au MVP (souveraineté + simplicité fille PME). Schéma écrit en SQL portable, migration Postgres possible plus tard. |
| Redis       | `redis-cli`/`redis-server` **absents** | ❌ pas de broker. La file de tâches passe par une **table SQLite** (pattern `tg_tasks` déjà en prod), pas par Redis. |
| `sqlite3` (CLI) | binaire absent | non bloquant : on passe par le module Python `sqlite3`. |

## 6. LLM disponibles

| Fournisseur            | Accès                                  | Coût | Usage projet |
|------------------------|----------------------------------------|------|--------------|
| **Ollama** (local)     | `http://127.0.0.1:11434` — actif       | **gratuit / souverain** | Classification, tri, rédaction de masse, audits → **défaut** (politique « pas de premium par défaut ») |
| Modèle Ollama présent  | `llama3.1:8b` (Q4_K_M, 4.9 Go)         | —    | Modèle local par défaut |
| **Claude Code** (`claude`) | CLI 2.1.158, headless `-p`         | payant (Opus/Sonnet) | Génération de sites + raisonnement complexe, **ad hoc** (coût maîtrisé) |
| Groq (cloud, gratuit)  | clé dans `/opt/galaxia/config/.env`    | gratuit (free tier) | Chat/rédaction rapide (déjà branché ailleurs) |
| Anthropic API          | clé dans `/opt/galaxia/config/.env`    | payant | via `claude` |

> **Règle de coût Galaxia (CLAUDE.md + mémoire) :** jamais de modèle premium par défaut.
> Ollama/Groq pour le volume, Claude/Opus uniquement quand la qualité l'exige (génération
> de site finale). Le doc `06` (modèle de coût) chiffre cet arbitrage.

## 7. Voix / multimodal (déjà en place, réutilisable)

| Daemon         | Port  | Rôle |
|----------------|-------|------|
| Whisper STT    | 5502 (uvicorn, `faster-whisper large-v3-turbo`) | transcription audio |
| Piper TTS      | 5500  | synthèse vocale fr |
| Kyutai TTS     | 5501  | synthèse vocale fr (alt.) |

Non requis pour le MVP restaurant, mais disponibles (ex. futurs appels vocaux de relance).

## 8. Ordonnancement (scheduler)

**systemd timers** — pattern de référence, déjà utilisé par 3 agents Galaxia :

| Timer                   | Cadence  | Service activé |
|-------------------------|----------|----------------|
| `galaxia-digest.timer`  | quotidien 06:00 UTC | digest inbox |
| `galaxia-veille.timer`  | quotidien 06:30 UTC | veille IA |
| `galaxia-coder.timer`   | quotidien 07:04 UTC | coder agent (PRs) |

→ Le projet restaurant utilisera **ses propres timers systemd** (`ops/`) pour les boucles
24/7 (découverte, relances, facturation), plus un **worker résident** (modèle
`galaxia-tg-worker.service`) pour les tâches longues. Pas de cron classique : on s'aligne
sur l'existant.

## 9. Process managers & agents existants (gabarits à copier)

Le projet n'invente rien : il calque les patterns d'agents déjà en production.

| Agent existant            | Techno      | Pattern réutilisé |
|---------------------------|-------------|--------------------|
| `agents/coder`            | Node + `claude` headless | Boucle « lit des entrées → produit un livrable → ouvre une PR », system-prompt statique cacheable, branche+PR jamais sur main |
| `agents/veille`           | Node        | Collecte multi-sources → filtre → synthèse |
| `agents/telegram` (bot)   | Python      | Enqueue SQLite (`tg_tasks`) ; **le producteur ne s'auto-exécute pas** |
| `agents/telegram/worker.py` | Python    | **Worker résident** qui claim atomiquement une tâche `pending`, l'exécute via `claude -p --permission-mode`, garde-fous timeout/kill-switch, journal d'audit en base |
| `agents/whisper`          | Python (FastAPI) | Daemon HTTP résident |

**Le worker Telegram est le gabarit direct du coordinator/worker restaurant** : file SQLite,
claim atomique `BEGIN IMMEDIATE`, statuts `pending→running→done|error|killed`, exécution
isolée `start_new_session`, timeout dur, audit complet.

## 10. Git, CI, secrets

| Élément       | État |
|---------------|------|
| Git           | 2.43.0 ✅. Repo `Jeffchoux/galaxia_os`, remote SSH. Réseau git **uniquement en compte `galaxia`** ; push direct sur `main` **bloqué par policy** → toujours brancher + PR. |
| GitHub CLI    | `gh` authentifié côté `galaxia` |
| Secrets       | `/opt/galaxia/config/.env` (root:600) : `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `BOT_TOKEN`, `GH_TOKEN`, etc. **Jamais committés.** Le projet lit ses secrets depuis ce fichier + un `.env` local gitignored. |
| `.gitignore`  | couvre `.env`, `node_modules/`, `data/*.db` (à confirmer/étendre pour ce projet) |
| cosign        | présent (signature manifests Hub & Spoke) |

## 11. Outils médias / divers

| Outil    | État | Note |
|----------|------|------|
| ffmpeg   | ✅ présent | conversions audio |
| yt-dlp   | ✅ dans le venv galaxia | non requis ici |
| jq       | ❌ binaire absent | parsing JSON via Python, pas de dépendance jq dans les scripts |
| curl     | ✅ | healthchecks |

## 12. Synthèse — briques retenues pour le projet `restaurant`

| Besoin                | Brique choisie (réelle, déjà active) |
|-----------------------|---------------------------------------|
| Langage pipeline      | Python 3.12 (venv galaxia) |
| Base de données       | SQLite (WAL) |
| File de tâches        | Table SQLite (pas de Redis) |
| LLM volume / tri      | Ollama `llama3.1:8b` (local, gratuit) + Groq |
| LLM génération site   | `claude` headless (Opus/Sonnet, ad hoc) |
| Ordonnancement        | systemd timers + worker résident |
| Hébergement sites     | Caddy `file_server` sous `/var/www/galaxia-restaurant-sites/` + HTTPS auto |
| Process manager       | systemd |
| Packaging fille PME   | Docker / docker-compose |
| Envoi e-mail          | **à provisionner** (aucun MTA/API détecté) → voir doc `01` §infra et `04` ; **dry-run d'abord, zéro envoi réel.** |

### Manques identifiés (à traiter dans `01_CRITICAL_ANALYSIS.md`)
- **Aucun service d'envoi d'e-mail** (pas de Postfix actif, pas d'API transactionnelle
  configurée) → c'est la dépendance externe n°1. Le MVP fonctionne en **dry-run** (écrit les
  e-mails sur disque), l'envoi réel est une décision séparée (domaine dédié, SPF/DKIM/DMARC,
  réputation IP).
- **Aucune source de données business** branchée (pas de clé Google Places/OSM configurée).
- **OpenClaw absent** : ne pas bloquer dessus.
- **Pas de système de paiement** (Stripe non détecté) → abonnement = décision infra (doc `01`).
