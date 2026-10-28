# syntax=docker/dockerfile:1
# Guildwise HQ: one image with the API server and the built web app (served by the server).

FROM node:22.23-bookworm-slim AS build
RUN npm install -g pnpm@12.8.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# The help videos' metadata (media/videos/*.json and *.vtt; the MP4s and WebMs stay out of the build context, see .dockerignore) is
# all the app needs: the library manifest (dist/video-library.json) lists the videos and their chapters. The manifest builder
# wants an MP4 next to each JSON, so an empty placeholder stands in for it in this stage only.
RUN for j in media/videos/*.json; do [ -e "${j%.json}.mp4" ] || : > "${j%.json}.mp4"; done
RUN pnpm --filter @aom/web build && pnpm --filter @aom/server build
# The runner release the "Add a workstation" installers download from this app (release/aom-runner-<version>.tgz).
RUN scripts/package-runner.sh && mkdir -p /out/release && cp release/aom-runner-*.tgz /out/release/
# Production-only node_modules for the server (@aom/shared is bundled into dist/main.mjs).
RUN pnpm --filter @aom/server deploy --prod /out/server \
 && rm -rf /out/server/src /out/server/test /out/server/scripts /out/server/tsconfig.json \
           /out/server/tsup.config.ts /out/server/vitest.config.ts /out/server/pnpm-lock.yaml /out/server/pnpm-workspace.yaml \
 && cp -r apps/web/dist /out/web

# The video worker (docker compose --profile video): the same server bundle with Chromium, ffmpeg and the offline voice.
# Renders the videos of the YouTube push and uploads the approved ones (docs/SELF-HOSTING.md "YouTube videos"). Not part of the
# default build: `docker build .` still builds the runtime stage below. It needs the help videos (the clips are cut from them) from
# the media folder as a named build context, because the context itself leaves the MP4s out (.dockerignore):
#   docker build --target video-worker --build-context media=media -t aom-video-worker .
# (docker-compose.prod.yml passes it as additional_contexts.)
FROM node:22.23-bookworm-slim AS video-worker
ENV NODE_ENV=production \
    AOM_VIDEO_DIR=/data/video \
    AOM_VIDEO_HOME=/opt/aom-video \
    AOM_MEDIA_VIDEOS_DIR=/opt/media-videos \
    AOM_COVER_DIR=/opt/covers \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-venv fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY --from=build /out/server /app/server
# Chromium for the scene cards (the browsers go to PLAYWRIGHT_BROWSERS_PATH, their system libraries are installed too).
RUN node node_modules/playwright-core/cli.js install --with-deps chromium && rm -rf /var/lib/apt/lists/*
# The voice (Kokoro, af_heart), a static ffmpeg and Python 3.12 for it: the same script the development machines use.
COPY e2e/video/setup-voice.sh /tmp/setup-voice.sh
# uv's cache stays out of the image; its managed Python goes under AOM_VIDEO_HOME (not /root, which the worker's USER node cannot read).
RUN UV_CACHE_DIR=/tmp/uv-cache bash /tmp/setup-voice.sh && rm -rf /tmp/setup-voice.sh /tmp/uv-cache
# The help videos the clips are cut from, and the blog covers for image scenes.
COPY --from=media videos/*.mp4 videos/*.json videos/*.vtt /opt/media-videos/
COPY apps/web/public/blog/cover /opt/covers
RUN mkdir -p /data/video && chown -R node:node /data/video /opt/aom-video && chmod -R a+rX /opt/aom-video
USER node
CMD ["node", "dist/video-worker.mjs", "--loop"]

FROM node:22.23-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AOM_HOST=0.0.0.0 \
    AOM_PORT=4600 \
    AOM_SERVE_WEB=true \
    AOM_WEB_DIST=/app/web \
    AOM_RUNNER_RELEASE_DIR=/app/release \
    AOM_MIGRATE_ON_BOOT=true
# Simulation organizations: the server creates local throwaway repositories and unpacks the runner release.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tar && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY --from=build --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /out/web /app/web
COPY --from=build --chown=node:node /out/release /app/release
# Where simulation organizations keep their runner data and local repositories (mount a volume here: AOM_SIMULATION_DIR).
RUN mkdir -p /data/simulation && chown node:node /data/simulation
# The video volume is mounted read-only here (the app serves the rendered videos) and read-write in the video worker (USER node).
# A fresh named volume copies this directory's ownership on first mount, so it must exist and belong to node, or the worker
# (started after the app) gets EACCES.
RUN mkdir -p /data/video && chown node:node /data/video
USER node
EXPOSE 4600
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.AOM_PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations run on boot (AOM_MIGRATE_ON_BOOT). First owner: node dist/admin-create.mjs ...; platform account: node dist/superadmin-create.mjs ...; preview the data migrations: node dist/orgs-migrate.mjs --dry-run and node dist/restructure-migrate.mjs --dry-run and node dist/ranking-migrate.mjs --dry-run; one-off Lean Team v3 rollout: node dist/ledger-cleanup.mjs and node dist/lean-rollout.mjs (both dry runs unless --apply)
CMD ["node", "dist/main.mjs"]
