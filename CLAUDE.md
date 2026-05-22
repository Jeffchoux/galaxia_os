# Galaxia — guide pour Claude Code

Ce fichier est lu automatiquement par Claude Code dans toute conversation
ouverte dans ce dépôt. Il sert de mémoire partagée du projet et de garde-fous
pour les décisions techniques.

## ⚡ Bootstrap (à lire en premier par tout nouvel agent)

1. **Ce fichier** — projet, conventions, garde-fous (5 min)
2. [`docs/STATUS.md`](docs/STATUS.md) — état réel des services, ce qui marche, ce qui bloque, ce qu'il reste à faire
3. [`docs/STACK.md`](docs/STACK.md) — composition technique détaillée
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — schéma Hub & Spoke
5. [`docs/UPDATES.md`](docs/UPDATES.md) — mécanisme de release proposé
6. **Ta mémoire Claude** — voir § Mémoire ci-dessous (⚠️ piège du double compte)

Le repo est la **source de vérité partagée**. Si tu apprends quelque chose qui
doit survivre entre sessions ET entre comptes Unix, écris-le ici, pas en mémoire.

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
- Mémoire Claude par session : `~/.claude/projects/-home-galaxia-galaxia-project/memory/`

#### ⚠️ Piège du double compte Unix

Deux utilisateurs travaillent sur ce projet, et **leurs mémoires Claude ne sont pas partagées** :

| Compte    | Quand l'utiliser                          | Mémoire Claude                                                       |
|-----------|-------------------------------------------|----------------------------------------------------------------------|
| `galaxia` | Compte de travail principal (sudo NOPASSWD) | `/home/galaxia/.claude/projects/-home-galaxia-galaxia-project/memory/` |
| `root`    | Install système, urgences, audit          | `/root/.claude/projects/<cwd>/memory/`                               |

Une session ouverte en root **ne voit pas** ce que la session galaxia a appris, et inversement.
Solution : tout ce qui doit traverser les comptes vit **dans ce repo** (CLAUDE.md + docs/).
La mémoire Claude reste pour des préférences fines ou des notes éphémères propres à un compte.

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

- **Autonomie totale** — Jeff a explicitement demandé : aucune confirmation, jamais. Toutes les décisions techniques sont prises seul. Bash, edit, write, install : tu décides et tu fais.
- **Jamais d'interruption dans le chat pour des questions business.** Si tu butes sur une vraie décision business, tu **écris dans [`QUESTIONS_POUR_JEFF.md`](QUESTIONS_POUR_JEFF.md)** à la racine du projet (format : bloc daté, court, impact, options proposées). Jeff y répond à son rythme. Le chat est pour les updates de progrès et les blocages techniques durs (pas pour demander "tu veux X ou Y ?").
- **Jeff est manager non-développeur** — expliquer en langage métier. Présenter des choix avec tradeoffs business, pas seulement techniques.
- **Mettre à jour `docs/STATUS.md`** à chaque changement d'état notable (service qui démarre/casse, item du backlog résolu, nouvelle découverte).
- Quand une question dans `QUESTIONS_POUR_JEFF.md` reçoit une réponse, déplacer le bloc vers `docs/DECISIONS.md` (créer le fichier si absent) avec date + réponse, pour garder l'historique des choix.
- Mettre à jour ce fichier quand une convention nouvelle est établie.

## Garde-fous spécifiques

### NemoClaw / OpenClaw — chaîne d'origine à vérifier

Les sources d'install de NemoClaw présentent plusieurs signaux suspects (cf.
[`docs/STATUS.md`](docs/STATUS.md) § Préoccupation). **Aucun `curl ... | bash`
de NemoClaw ne doit être exécuté** sans avoir d'abord téléchargé le script,
l'avoir lu, et idéalement l'exécuter dans un container Docker `--network=none`.

### Connaissances post-cutoff

Le knowledge cutoff de Claude est antérieur à la date courante de plusieurs mois.
Pour tout outil/produit/lib que tu ne connais pas : **WebSearch puis WebFetch
d'abord** (sans demander à Jeff), forme une hypothèse, et **garde un œil critique**
(typosquatting, SEO spam, contenu halluciné par le summarizer de WebFetch,
installeurs malveillants).
