# Galaxia — état du projet

> **Doc vivante.** Mise à jour à chaque fin de session ou changement d'état.
> Dernière révision : **2026-05-22** (session root@OpenJeff).

## Bootstrap éclair pour un nouvel agent

Si tu viens d'ouvrir une session dans ce repo, lis dans cet ordre (5 min) :

1. **Ce fichier** — état réel des services et du travail
2. [`../CLAUDE.md`](../CLAUDE.md) — conventions, garde-fous, piège mémoire
3. [`STACK.md`](STACK.md) — composition technique (OpenClaw + NemoClaw + Ollama)
4. [`ARCHITECTURE.md`](ARCHITECTURE.md) — schéma Hub & Spoke
5. [`UPDATES.md`](UPDATES.md) — mécanisme de release proposé
6. **Ta mémoire Claude** (voir CLAUDE.md § mémoire — attention au double compte root/galaxia)

Tout le reste découle de là.

## Services qui tournent (galaxie mère, OpenJeff)

| Service          | État    | Notes                                                                     |
|------------------|---------|---------------------------------------------------------------------------|
| Docker           | active  | Daemon OK, 1 container `n8n_n8n_1`                                        |
| Caddy v2.11.3    | active  | vhosts `app.galaxia-os.com` + redirect apex, TLS Let's Encrypt OK         |
| Ollama 0.24.0    | active  | `localhost:11434`, modèle `llama3.1:8b` (4.9 GB) chargé                   |
| fail2ban + UFW   | active  | Ports ouverts : 22, 80, 443, **5678** (à fermer après mise derrière Caddy) |
| n8n (legacy)     | running | `/opt/n8n/docker-compose.yml`, exposé en clair :5678 (PAS de TLS)          |

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
