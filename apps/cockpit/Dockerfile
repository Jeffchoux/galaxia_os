# Cockpit Galaxia — SvelteKit + adapter-node, prêt pour les galaxies filles PME.
# Image minimale (node 22 slim), data persistée via volume.

# -- stage 1 : build ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 + @node-rs/argon2 ont des binaires natifs. node:22 fournit déjà
# python3 + build-essential dans les premières layers, mais slim ne les a pas :
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY svelte.config.js vite.config.ts tsconfig.json ./
COPY src ./src
COPY static ./static
RUN npm run build

# -- stage 2 : runtime -------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    COCKPIT_DB_PATH=/app/data/cockpit.db

# Copier uniquement le build + les deps prod
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
    && npm ci --omit=dev --no-audit --no-fund \
    && apt-get purge -y python3 build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/build ./build
COPY --from=build /app/static ./static

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "build"]
