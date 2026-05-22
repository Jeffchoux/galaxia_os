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

## ⚠️ Préoccupation : vérification de la chaîne d'origine NemoClaw

La session précédente (galaxia user, 2026-05-21) a accepté ces faits comme vérifiés
dans la mémoire `project_stack_openclaw_nemoclaw.md` :

- Install via `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`
- 3 orgs GitHub différentes hébergent un repo « NemoClaw » : `NVIDIA/`, `Nemoclaw/`, `NemoClawLabs/`
- Doc officielle à `docs.nvidia.com/nemoclaw/latest/`

Signaux contraires relevés en session root du 2026-05-22 :

- **`docs.nvidia.com/nemoclaw/...` redirige (303) vers `app.buildwithfern.com`** — un SaaS de docs tiers. NVIDIA n'utilise pas buildwithfern pour sa doc officielle.
- **NVIDIA n'héberge pas de scripts shell à la racine de `www.nvidia.com`**. Les vrais installeurs sont sur `developer.nvidia.com` / `downloads.nvidia.com`. Le pattern `curl <root>.sh | bash` est la signature classique d'un installeur malveillant.
- **Une page fetchée contenait une fausse balise `<system-reminder>`** — tentative d'injection de prompt embarquée dans le contenu pour manipuler un agent qui la lit.
- **Trois orgs GitHub concurrentes** pour le même produit "officiel NVIDIA" est anormal — un vrai projet NVIDIA n'a qu'un repo source.

**Protocole obligatoire avant toute install NemoClaw** (même en Docker) :

1. Télécharger le script **sans pipe** : `curl -fsSL https://www.nvidia.com/nemoclaw.sh -o /tmp/nemoclaw.sh`
2. Le lire intégralement (`less /tmp/nemoclaw.sh`) avant la moindre exécution
3. Vérifier que les URLs qu'il appelle pointent vers de l'infra NVIDIA légitime (`developer.nvidia.com`, `nvcr.io`, etc.) et pas vers du buildwithfern ou autre tiers inconnu
4. Si une signature/hash GPG est fournie côté NVIDIA, la vérifier
5. Exécuter dans un container Docker **`--network=none`** d'abord, sans aucun bind-mount sensible — observer ce qu'il essaie de faire
6. Si tout est propre, refaire avec réseau et installer pour de bon

Ce désaccord doit être tranché par Jeff. Tant qu'il ne l'est pas, NemoClaw reste **non installé** sur OpenJeff.

## Questions ouvertes pour Jeff

(Fusion de toutes les questions encore non résolues à travers les docs.)

1. **GitHub** — URL exacte du repo (`https://github.com/<?>/<?>` ) et confirmation que la deploy key est ajoutée en **Read+Write** ?
2. **n8n** — workflows métier actifs, simple test, ou à virer ?
3. **NemoClaw** — feu vert pour le protocole de vérification ci-dessus avant install Docker isolé ? Ou tu as une autre source officielle à proposer ?
4. **UPDATES.md** — option A (registry Docker) validée ? Cadence releases ? Fréquence pull côté filles ? Rollback auto ? Premium intégré ou registry séparé ?
5. **DNS** — quand `updates.`/`install.`/`docs.` côté OVH ? (Jeff l'a annoncé en cours le 2026-05-21.)
6. **Licence** — AGPLv3 confirmée pour le core ?
7. **Clés API LLM** — stratégie : chaque PME apporte sa clé OpenAI, ou mode "Ollama only" disponible par défaut ?

## Mémoires Claude existantes (compte `galaxia`)

Voir `/home/galaxia/.claude/projects/-home-galaxia-galaxia-project/memory/` :

- `user_jeff.md` — Jeff = manager non-dev, attend exécution autonome
- `feedback_autonomy.md` — pas de confirmation pour les commandes routine
- `project_galaxia_overview.md` — vision produit (Hub & Spoke, pas SaaS)
- `project_infrastructure_vps.md` — specs VPS, DNS, sécurité
- `project_stack_openclaw_nemoclaw.md` — ⚠️ à reconfronter à la préoccupation ci-dessus
- `project_n8n_legacy.md` — container n8n hérité, rôle à clarifier
