# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Builder (compile TypeScript + native better-sqlite3 addon)
# ==============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Native build toolchain for better-sqlite3 fallback compilation
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Runtime (non-root, minimal attack surface)
# ==============================================================================
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SQLITE_DB_PATH=/app/data/monitor.db

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data \
  && chown -R node:node /app

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
