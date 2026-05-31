# Galaxia Cowork — image du bac à sable d'exécution d'une sous-tâche.
#
# Image : galaxia/cowork-sandbox
#
# Chaque sous-tâche d'une tâche Cowork tourne dans UN conteneur jetable bâti
# sur cette image. Le conteneur est lancé par le wrapper run-subtask.sh avec un
# durcissement maximal (cf. ce script et le CONTRAT) : --read-only, --cap-drop=ALL,
# --network=none par défaut, user non privilégié, /workspace comme seul point
# d'écriture. L'image elle-même reste donc volontairement minimale et souveraine :
# Node 22 (déjà le runtime du reste de Galaxia), la CLI `claude` (agent SDK en
# mode headless), et quelques outils fichiers POSIX courants pour que l'agent
# in-container puisse lire/écrire/chercher dans /workspace sans réseau.
#
# Souveraineté / packageable : aucune dépendance à un service externe au build.
# La clé du modèle est injectée à l'exécution (COWORK_API_KEY / GROQ_API_KEY),
# JAMAIS au build. Pinner la version de la CLI rend l'image reproductible pour
# les galaxies filles.

FROM node:22-slim AS runtime

# Version de la CLI Claude Code (agent headless dans le bac à sable). Surchargée
# au build via --build-arg pour les filles qui veulent pinner différemment.
ARG CLAUDE_CLI_VERSION=latest

ENV NODE_ENV=production \
    # Pas de télémétrie / pas de mises à jour réseau à l'exécution : le conteneur
    # tourne le plus souvent en --network=none.
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    # Valeurs par défaut alignées sur le CONTRAT (surchargées par -e à l'exécution).
    COWORK_EXEC_MODEL=claude-sonnet-4-6 \
    COWORK_SUBTASK_TIMEOUT=600

# Outils fichiers POSIX courants pour l'agent in-container (recherche, diff,
# archives, json). ca-certificates sert UNIQUEMENT au mode egress opt-in ;
# en --network=none il est inerte. On nettoie les listes apt pour garder l'image
# légère et reproductible.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      ripgrep \
      git \
      jq \
      less \
      file \
      tar \
      gzip \
      coreutils \
      findutils \
      sed \
      grep \
    && rm -rf /var/lib/apt/lists/*

# CLI Claude Code installée globalement (mode headless `claude -p`). Le `npm
# cache clean` garde l'image mince.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    && npm cache clean --force

# Utilisateur non privilégié : l'image node:22-slim fournit DÉJÀ l'utilisateur
# `node` en UID/GID 1000 — on le réutilise (un `useradd --uid 1000` échouerait :
# « UID 1000 is not unique »). Le wrapper lance --user 1000:1000 et monte le
# workspace hôte (lui aussi propriété de l'uid 1000 côté galaxia). Le conteneur
# tourne --read-only ; la CLI écrit sa config dans /tmp (tmpfs monté par le wrapper).
RUN mkdir -p /workspace \
    && chown 1000:1000 /workspace

# HOME + XDG vers /tmp : seul emplacement inscriptible quand --read-only est actif
# (le wrapper monte un tmpfs sur /tmp). Empêche la CLI d'échouer en voulant créer
# ~/.claude sur un FS en lecture seule.
ENV HOME=/tmp \
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_CACHE_HOME=/tmp/.cache \
    CLAUDE_CONFIG_DIR=/tmp/.claude

USER 1000:1000
WORKDIR /workspace
VOLUME ["/workspace"]

# Entrée par défaut : un agent headless qui lit ses instructions sur STDIN et
# émet sa sortie ligne par ligne sur STDOUT. Le wrapper passe les instructions
# via STDIN (echo|docker run -i ...). On utilise le format texte : chaque ligne
# de sortie est relayée telle quelle en SSE 'log'. La DERNIÈRE ligne STDOUT doit
# être l'objet JSON {"ok":...,"summary":...} — c'est l'agent (pilote par le
# system prompt fourni par l'équipe orchestrateur) qui en est responsable, pas
# l'image. Le bac à sable ne fait qu'exposer la CLI.
#
# --print : mode headless (lit le prompt depuis l'argument OU STDIN si "-")
# --permission-mode bypassPermissions : pas d'humain dans le conteneur ; la
#   sécurité vient du durcissement Docker (read-only, cap-drop, network=none),
#   pas d'un gate interne.
# --model : modèle d'exécution in-sandbox (défaut sonnet/groq, cf. COWORK_EXEC_MODEL).
ENTRYPOINT ["claude", "--print", "--permission-mode", "bypassPermissions"]
