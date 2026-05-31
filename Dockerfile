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

ENV MCP_TRANSPORT=http
ENV HOST=0.0.0.0
ENV PORT=3221

EXPOSE 3221

# Healthcheck hits the built-in /health endpoint (no external deps).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3221)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js", "--http"]
