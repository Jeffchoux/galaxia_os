# Installer Galaxia chez une PME

Ce guide vise une **galaxie fille PME** sur un serveur Linux dédié.
Pour la galaxie mère OpenJeff, voir [`STATUS.md`](STATUS.md) (services
systemd directs, pas Docker).

## Pré-requis

- Linux récent (Ubuntu 24.04 / Debian 12 / Fedora 41+) avec Docker
  Engine 24+ et Docker Compose plugin.
- Domaine pointant vers l'IP du serveur (champ A DNS).
- Clé API Anthropic (https://console.anthropic.com).
- Bot Telegram créé via @BotFather (token).

## Étapes

### 1. Cloner le repo

```bash
git clone https://github.com/Jeffchoux/galaxia_os.git /opt/galaxia/repo
cd /opt/galaxia/repo
```

### 2. Produire la config

Le wizard `scripts/wizard.sh` interroge interactivement et écrit
`/opt/galaxia/config/.env` (chmod 600) et `/opt/galaxia/config/galaxia.conf`.

```bash
sudo ./scripts/wizard.sh
```

Variables à renseigner :

| Variable                       | Origine                                              |
|--------------------------------|------------------------------------------------------|
| `ANTHROPIC_API_KEY`            | console.anthropic.com                                |
| `JEFF_PASS_HASH`               | hash argon2id du mot de passe cockpit (cf. ci-dessous) |
| `SESSION_SECRET`               | `openssl rand -base64 48`                            |
| `BOT_TOKEN`                    | @BotFather sur Telegram                              |
| `ALLOWED_CHAT_ID`              | Ton chat_id (le bot l'affiche au 1er /start)         |
| `COCKPIT_DOMAIN`               | app.tapme.fr (ou ton domaine)                        |
| `COCKPIT_ORIGIN`               | https://${COCKPIT_DOMAIN}                            |
| `ACME_EMAIL`                   | email valide pour Let's Encrypt                      |

Optionnels (MCP servers) :

| Variable                       | Effet                                                |
|--------------------------------|------------------------------------------------------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Active le MCP GitHub                                 |
| `BRAVE_API_KEY`                | Active le MCP Brave Search (web)                     |
| `COCKPIT_MODEL`                | Override modèle Claude (défaut `claude-opus-4-7`)    |

### 3. Générer le hash du mot de passe

```bash
docker run --rm node:22-bookworm-slim sh -c \
  "npm install --silent @node-rs/argon2 && node -e \"
  import('@node-rs/argon2').then(a=>a.hash(process.argv[1],{
    memoryCost:19456,timeCost:2
  }).then(console.log))\" -- 'MonPasseChoisi'"
```

Coller la sortie dans `JEFF_PASS_HASH=...`.

### 4. Démarrer la stack

```bash
docker compose --profile pme up -d
docker compose --profile pme logs -f cockpit  # vérifier
```

Trois services tournent :

- **cockpit** (interface web SvelteKit) — non exposé en direct, derrière Caddy
- **bot** (Telegram, ingest URL + documents + photos vers le cockpit)
- **caddy** (TLS auto Let's Encrypt + reverse proxy)

### 5. Tester

- Browser sur `https://${COCKPIT_DOMAIN}` → page login → mot de passe
- Sur Telegram, message au bot : `/start` → il confirme l'autorisation
- Envoie un TikTok au bot → ACK reçu

## Mise à jour

```bash
cd /opt/galaxia/repo
git pull
docker compose --profile pme build
docker compose --profile pme up -d --force-recreate
```

Ou automatique via le mécanisme Hub & Spoke (cf. [`UPDATES.md`](UPDATES.md)).

## Données

| Donnée                   | Volume Docker            |
|--------------------------|---------------------------|
| Conversations cockpit    | `cockpit_data`           |
| Mémoire persistante      | `cockpit_data` (memory.md) |
| Documents/photos joints  | `cockpit_data` (dans SQLite) |
| Inbox URL (TikTok/X)     | `bot_data`               |
| Certificats Let's Encrypt | `caddy_data`             |

Backup recommandé : `docker run --rm -v cockpit_data:/d -v $PWD:/b alpine tar czf /b/cockpit-$(date +%F).tgz /d`

## Réseaux

Caddy expose 80 + 443 (HTTPS auto). Les autres services ne sortent pas
sur le réseau public — communication interne via le bridge default
docker-compose.
