# Galaxia — état du projet

> **Doc vivante.** Mise à jour à chaque fin de session ou changement d'état.
> Dernière révision : **2026-05-22** (session root@OpenJeff).

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

- 4 commits sur `main`, working tree clean
- Remote : `git@github.com:galaxia-os/galaxia.git`
- **Push bloqué** au 2026-05-21 : `Permission denied (publickey)` — la deploy key SSH n'est pas encore en write sur le repo GitHub

```
ddde365 docs: technical breakdown of the OpenClaw/NemoClaw/Galaxia stack
a2773e5 scaffold: install script, updates design doc, project CLAUDE.md
44a97e1 caddy: enable app.galaxia-os.com vhost (TLS auto verified)
d300e23 Initial scaffold for Galaxia mother galaxy
```

Clé publique à coller dans `https://github.com/<org>/<repo>/settings/keys` (Read/Write) :
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJv64EzJXt45JQgxdOjWDeDshz2qXHYu0i1iu6zfTzhK galaxia-vps-openjeff
```

## Travail à faire (priorisé)

| Pri | Item                                                    | Bloqué sur                                                    |
|-----|---------------------------------------------------------|---------------------------------------------------------------|
| 1   | Push GitHub des 4 commits                                | Jeff : confirmer URL exacte du repo + deploy key en Read+Write |
| 2   | Décision sur n8n : sécuriser derrière Caddy ou virer ?  | Jeff : rôle du container                                       |
| 3   | Installer NemoClaw — d'abord en Docker isolé             | Vérification de la source (voir ⚠️ ci-dessous)                  |
| 4   | Brancher `updates.`/`install.`/`docs.` dans Caddy        | DNS OVH (Jeff)                                                 |
| 5   | Valider option A pour les updates (registry Docker)     | Jeff : 4 questions ouvertes dans `UPDATES.md`                  |
| 6   | Wizard CLI manager-friendly (FR, choix LLM/wake word)   | Pas commencé                                                   |
| 7   | Module de veille IA quotidien (HN, GitHub, arxiv)        | Pas commencé                                                   |
| 8   | Implémenter `bootstrap_galaxia_dir` (pull updates)       | Dépend du choix updates (A/B/C)                                |

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

3. **Dashboard non exposé à l'hôte par design.** L'accès passe par :
   - `nemoclaw tunnel start` (cloudflared tunnel — pattern NemoClaw natif)
   - OU port-forward via `docker exec` / openshell port-forward
   - OU configuration Caddy pour proxy via openshell gateway

   **Implication pour Galaxia** : le briefing prévoyait `app.galaxia-os.com` comme UI principale. Soit on intègre cloudflared, soit on configure un reverse proxy Caddy qui pointe vers le sandbox interne via openshell. Question pour Jeff dans `QUESTIONS_POUR_JEFF.md`.

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
