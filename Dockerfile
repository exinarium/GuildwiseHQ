# syntax=docker/dockerfile:1
# Agent Org Manager: one image with the API server and the built web app (served by the server).

FROM node:22.23-bookworm-slim AS build
RUN npm install -g pnpm@12.8.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @aom/web build && pnpm --filter @aom/server build
# Production-only node_modules for the server (@aom/shared is bundled into dist/main.mjs).
RUN pnpm --filter @aom/server deploy --prod /out/server \
 && rm -rf /out/server/src /out/server/test /out/server/scripts /out/server/tsconfig.json \
           /out/server/tsup.config.ts /out/server/vitest.config.ts /out/server/pnpm-lock.yaml /out/server/pnpm-workspace.yaml \
 && cp -r apps/web/dist /out/web

FROM node:22.23-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AOM_HOST=0.0.0.0 \
    AOM_PORT=4600 \
    AOM_SERVE_WEB=true \
    AOM_WEB_DIST=/app/web \
    AOM_MIGRATE_ON_BOOT=true
WORKDIR /app/server
COPY --from=build --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /out/web /app/web
USER node
EXPOSE 4600
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.AOM_PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations run on boot (AOM_MIGRATE_ON_BOOT). First admin: docker compose exec app node dist/admin-create.mjs ...
CMD ["node", "dist/main.mjs"]
