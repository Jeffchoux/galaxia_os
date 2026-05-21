# Galaxia — guide pour Claude Code

Ce fichier est lu automatiquement par Claude Code dans toute conversation
ouverte dans ce dépôt. Il sert de mémoire partagée du projet et de garde-fous
pour les décisions techniques.

## Projet

**Galaxia** = écosystème IA souverain, open-source et gratuit pour PME.
**Ce n'est pas un SaaS.** C'est un produit fini distribuable (analogie iPhone) :
chaque PME l'installe sur son propre serveur avec ses propres clés API.

Cette contrainte gouverne TOUTES les décisions :

- ❌ Pas de dépendance à des services SaaS tiers propriétaires
- ❌ Pas de cloud-call obligatoire pour fonctionner
- ✅ Tout doit pouvoir s'empaqueter dans des images Docker et tourner offline
- ✅ Si une fonctionnalité ne peut pas se redéployer sur N serveurs identiques, elle n'a pas sa place

## Architecture — Hub & Spoke

- **Galaxia mère** = ce serveur (OpenJeff, `188.34.188.200`). Reçoit les mises à jour, les signe, les publie sur `updates.galaxia-os.com`.
- **Galaxies filles** = installations chez les PME. Cron quotidien qui pull depuis la mère.

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour le détail et [`docs/UPDATES.md`](docs/UPDATES.md) (en cours) pour le mécanisme de mise à jour.

## Stack

| Composant   | Rôle                                    | État sur OpenJeff           |
|-------------|-----------------------------------------|-----------------------------|
| OpenClaw    | Moteur agentic (sortie janv. 2026)      | À intégrer                  |
| NemoClaw    | Sécurité NVIDIA enterprise              | À intégrer                  |
| Ollama      | LLM local                               | Actif, llama3.1:8b présent  |
| Caddy       | Reverse proxy + HTTPS auto              | Actif, vhost app. live      |
| Docker      | Packaging / déploiement                 | Actif                       |

## Sous-domaines (galaxia-os.com)

| Sous-domaine                | Rôle                              | DNS  | Caddy vhost |
|-----------------------------|-----------------------------------|------|-------------|
| `app.galaxia-os.com`        | Interface utilisateur (mère)      | OK   | actif       |
| `updates.galaxia-os.com`    | Endpoint des updates pour filles  | TBD  | placeholder |
| `install.galaxia-os.com`    | Script d'install public           | TBD  | placeholder |
| `docs.galaxia-os.com`       | Documentation                     | TBD  | placeholder |

## Conventions

### Commits

Format court, anglais, conventional-ish (`area: short description`). Exemples :
- `caddy: enable updates.galaxia-os.com vhost`
- `install: bail out early on missing Docker`
- `docs: clarify hub&spoke trust model`

Toujours signer avec `Co-Authored-By: Claude Opus 4.7 ...` quand Claude Code commit.

### Bash

- `set -euo pipefail` en tête de tout script
- Helpers `log/warn/die` (cf. `scripts/install.sh`)
- Idempotent : un script doit pouvoir être relancé sans casser

### Docker

- Tout service Galaxia doit pouvoir tourner dans un container
- Images : tags sémantiques (`v1.2.3`), jamais `latest` en prod
- Volumes nommés, pas de bind-mounts d'hôte sauf cas justifié

### Caddy

- Source de vérité : `caddy/Caddyfile` du repo
- Le fichier déployé est `/etc/caddy/Caddyfile` (synchro manuelle pour l'instant)
- À automatiser plus tard via systemd path unit ou docker

### Mémoire & docs

- Documentation produit : `docs/`
- Mémoire Claude (par session) : `~/.claude/projects/-home-galaxia-galaxia-project/memory/`

## Commandes utiles

```bash
# État des services
systemctl status docker caddy ollama

# Reload Caddy après modification du Caddyfile système
sudo systemctl reload caddy

# Tester Ollama
curl -sS http://localhost:11434/api/generate \
  -d '{"model":"llama3.1:8b","prompt":"Bonjour","stream":false}'

# Compose stack Galaxia (à venir)
cd /home/galaxia/galaxia-project
docker-compose ps

# n8n hérité (à clarifier avec Jeff)
cd /opt/n8n && docker-compose ps
```

## Pour Claude Code dans ce projet

- **Autonomie totale** demandée par Jeff (cf. `feedback_autonomy` en mémoire) — exécuter sans demander confirmation pour les commandes bash/edit/write usuelles
- **Jeff est manager non-développeur** — expliquer les décisions techniques en langage métier, présenter des choix avec tradeoffs business
- En cas de blocage qui nécessite une action que seul Jeff peut faire (compte tiers, DNS, paiement), exposer clairement quoi faire et continuer sur d'autres fronts en attendant
- Mettre à jour ce fichier quand une convention nouvelle est établie
