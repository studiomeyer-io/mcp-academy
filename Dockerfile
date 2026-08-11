# mcp-academy — public HTTP server (anonymous, read-only).
# Multi-stage: build TS + bake the content bundle, then ship a slim runtime.
# The content bundle is generated from the academy content dir at BUILD context,
# so it must be present in the build context (see docker-compose: build args / context).

FROM node:22-slim AS build
WORKDIR /app

# deps (incl. gray-matter devDep needed for the bundle step)
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# Pre-generated bundle (committed). If you want to regenerate at build time,
# mount the academy content and run `npm run bundle` before this stage.
COPY data ./data

RUN npm run build

# ── runtime ──
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# prod deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
# Schema + migration run at container start; without these the version guard
# ships as a promise the image cannot keep.
COPY --from=build /app/dist-scripts ./dist-scripts
COPY scripts/schema.sql ./scripts/schema.sql

# The code reads ACADEMY_MCP_HOST / ACADEMY_MCP_PORT (core/base-url.ts).
# Plain HOST/PORT were left over from v0.3.0 and did nothing in v0.4.0: the
# server would have bound 127.0.0.1:3116 while compose published 3221 —
# healthcheck red, nginx dead, and `restart: unless-stopped` does not restart
# an unhealthy container. It would have looked like a broken deploy.
ENV MCP_TRANSPORT=http
ENV ACADEMY_MCP_HOST=0.0.0.0
ENV ACADEMY_MCP_PORT=3221

EXPOSE 3221

# Healthcheck hits the built-in /health endpoint (no external deps).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ACADEMY_MCP_PORT||3221)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrate first, then serve. A failed migration must stop the start, not
# get skipped — that is the whole point of the version guard.
CMD ["sh", "-c", "node dist-scripts/scripts/migrate.js && node dist/index.js --http"]
