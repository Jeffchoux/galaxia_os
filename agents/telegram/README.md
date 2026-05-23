# Bot Telegram Galaxia

Bot personnel qui ingère depuis Telegram vers Galaxia :

- **URLs TikTok / X** → ajoutées à `~/.claude/galaxia/inbox.md`, analysées
  par le pipeline `galaxia-digest.service` (Whisper + Claude) au prochain run
- **Documents PDF / Markdown / TXT** → poussés directement dans la SQLite du
  cockpit (`apps/cockpit/data/cockpit.db`, mode WAL → safe avec le cockpit Node)
- **Photos** (compressées par Telegram ou envoyées en fichier) → poussées
  comme images au cockpit, vues par Claude via les blocs vision Anthropic

Tous les documents et photos arrivent dans une conversation dédiée
**"📱 Inbox Telegram"** auto-créée à la première arrivée — Jeff la voit dans
la sidebar du cockpit avec un lien profond `?c=<id>` renvoyé dans chaque ACK.

## Commandes Telegram

- `/start` — vérifie l'autorisation, affiche le chat_id si non configuré
- `/status` — taille de l'inbox URLs
- `/digest` — déclenche le pipeline digest immédiatement (Whisper + Claude)
  et renvoie le brief produit
- `/brief` — renvoie le contenu du dernier brief

## Installation

### Dépendances Python (galaxie mère OpenJeff — venv partagée avec le digest)

```bash
sudo -u galaxia /home/galaxia/.claude/galaxia/venv/bin/pip install -r requirements.txt
```

Pour les galaxies filles PME, un venv dédié `./venv` est préférable :

```bash
python3 -m venv ./venv
./venv/bin/pip install -r requirements.txt
```

### Configuration

```bash
cp .env.example .env && chmod 600 .env
nano .env  # remplir BOT_TOKEN + ALLOWED_CHAT_ID
```

### Service systemd

```bash
sudo install -m 644 ../../ops/galaxia-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now galaxia-bot.service
sudo journalctl -u galaxia-bot.service -f  # logs live
```

## Accès SQLite cockpit

Le bot écrit directement dans la SQLite avec `sqlite3` stdlib + `PRAGMA
journal_mode = WAL`. Pas de risque de corruption en concurrent avec le
cockpit Node (better-sqlite3), c'est le scénario standard SQLite.

Variables d'environnement utiles :

| Var                | Défaut                                                          |
|--------------------|------------------------------------------------------------------|
| `BOT_TOKEN`        | (obligatoire — @BotFather)                                       |
| `ALLOWED_CHAT_ID`  | `0` au premier run, puis ton chat_id réel                        |
| `INBOX_PATH`       | `~/.claude/galaxia/inbox.md`                                     |
| `COCKPIT_DB_PATH`  | `/home/galaxia/galaxia-project/apps/cockpit/data/cockpit.db`     |
