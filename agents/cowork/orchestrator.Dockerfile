# Galaxia Cowork — image de l'orchestrateur (profil compose `pme`).
#
# Daemon long qui sonde la file cowork_tasks (SQLite partagée avec le cockpit),
# planifie via le Claude Agent SDK, et lance UN bac à sable jetable par sous-tâche
# en appelant le socket Docker de l'HÔTE (le wrapper run-subtask.sh fait
# `docker run`/`docker kill`). Il a donc besoin :
#   - de Node 22 + les deps de agents/cowork (better-sqlite3 → build natif),
#   - du CLI `docker` (client seul) pour parler au socket monté,
#   - de bash (le wrapper est un script bash).
#
# Sécurité : ce conteneur a accès au socket Docker (== root hôte). Le durcissement
# réel est porté par les bacs à sable ENFANTS (--read-only, --cap-drop=ALL,
# --network=none, user non privilégié), cf. sandbox/run-subtask.sh.
FROM node:22-bookworm-slim

# Dépendances natives de better-sqlite3 (compilé au npm ci) + CLI docker + bash.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates curl gnupg bash \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && chmod a+r /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/agents/cowork

# Installe d'abord les deps (couche cachable) puis copie le code.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Code de l'orchestrateur + wrapper sandbox + schéma + prompt statique.
COPY . .

# Le wrapper bash doit être exécutable.
RUN chmod +x sandbox/run-subtask.sh

# Pas de build : démon Node pur. Les chemins (DB, run dir) viennent de l'env
# (docker-compose : COWORK_DB_PATH, COWORK_RUN_DIR — montés en volume/bind).
CMD ["node", "orchestrator.mjs"]
