# EmDash for Railway: an EmDash site on Node.js, backed by PostgreSQL, with
# media and sessions on a persistent volume.
#
# The site is built from an official EmDash starter template at a pinned
# commit of github.com/emdash-cms/templates. Every version below is pinned so
# each deploy is reproducible. The update workflow
# (.github/workflows/update.yml) bumps them after a smoke test passes.
ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS build

ARG TEMPLATES_COMMIT=1930243108073ebb41ff48533678af7635b01c37
ARG EMDASH_VERSION=1.2.0
ARG ASTRO_VERSION=7.3.8
ARG ASTRO_NODE_VERSION=11.1.7
ARG ASTRO_REACT_VERSION=6.0.6
ARG PG_VERSION=8.23.1
# npm resolves transitive dependencies as they were at this time, so a rebuild
# months later installs the same tree that passed the smoke test.
ARG NPM_BEFORE=2026-10-13T00:00:00Z

# Which starter to build: blog, starter, marketing or portfolio.
ARG EMDASH_TEMPLATE=blog
# The public origin. Railway passes the service variable of the same name.
# Astro needs it at build time to optimize images stored on the volume.
ARG EMDASH_SITE_URL=""

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN case "$EMDASH_TEMPLATE" in blog|starter|marketing|portfolio) ;; \
      *) echo "EMDASH_TEMPLATE must be blog, starter, marketing or portfolio (got '$EMDASH_TEMPLATE')" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://codeload.github.com/emdash-cms/templates/tar.gz/${TEMPLATES_COMMIT}" \
       | tar -xz --strip-components=2 "templates-${TEMPLATES_COMMIT}/${EMDASH_TEMPLATE}" \
    && rm -rf .agents .claude .cursor .vscode .mcp.json pnpm-workspace.yaml

COPY railway/ /railway/

# Pin the shared dependencies and add the PostgreSQL driver. Dev-only tooling
# (astro check) is dropped to keep the install small. If another package forces
# npm to nest one of EmDash's own dependencies, that dependency is promoted to
# the top level and installed again (see railway/hoist-emdash-deps.mjs).
RUN npm pkg delete packageManager devDependencies \
    && npm pkg set \
       "dependencies.emdash=${EMDASH_VERSION}" \
       "dependencies.astro=${ASTRO_VERSION}" \
       "dependencies.@astrojs/node=${ASTRO_NODE_VERSION}" \
       "dependencies.@astrojs/react=${ASTRO_REACT_VERSION}" \
       "dependencies.pg=${PG_VERSION}" \
    && npm install --no-audit --no-fund --before="${NPM_BEFORE}" \
    && node /railway/hoist-emdash-deps.mjs | tee /tmp/hoist.log \
    && if grep -q added /tmp/hoist.log; then npm install --no-audit --no-fund --before="${NPM_BEFORE}"; fi \
    && node /railway/hoist-emdash-deps.mjs --check \
    && npm cache clean --force

# Switch the template from SQLite and ./uploads to PostgreSQL, /data/uploads
# and file sessions in /data/sessions, and add the setup password gate.
RUN node /railway/patch-astro-config.mjs astro.config.mjs \
    && if [ -e src/middleware.ts ] || [ -e src/middleware.js ]; then \
         echo "The template now ships its own middleware. Merge railway/setup-gate.ts into it." >&2; exit 1; \
       fi \
    && cp /railway/setup-gate.ts src/middleware.ts

ENV NODE_OPTIONS=--max-old-space-size=3072 \
    ASTRO_TELEMETRY_DISABLED=1
RUN EMDASH_SITE_URL="$EMDASH_SITE_URL" npm run build \
    && npm prune --omit=dev --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    EMDASH_TRUSTED_PROXY_HEADERS=x-real-ip

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "./dist/server/entry.mjs"]
