# syntax=docker/dockerfile:1
# Guildwise HQ: one image with the API server and the built web app (served by the server).

# The NVENC-capable ffmpeg of the video worker (DESIGN R19): a pinned static BtbN FFmpeg-Builds linux64-gpl build, by
# default downloaded from its mirror, a release asset of this repository (`ffmpeg-gpu-<BtbN tag>`), because BtbN prunes
# older autobuilds. FFMPEG_GPU_URL may point elsewhere (for example the upstream BtbN URL of the same file while the mirror
# is not published), but the SHA-256 pin is checked before unpacking whatever the URL: only the exact pinned file is
# accepted. Keep the tag, file and SHA-256 equal to the cloud Dockerfile's. The image carries no NVIDIA driver: NVENC loads
# libnvidia-encode.so.1 from the host at run time (the container needs --gpus all). GPL build: see NOTICE.
FROM node:26.13-bookworm-slim AS ffmpeg-gpu
ARG FFMPEG_GPU_TAG=autobuild-2026-11-20-12-40
ARG FFMPEG_GPU_FILE=ffmpeg-n8.1.3-39-g660b5aa7db-linux64-gpl-8.1.tar.xz
ARG FFMPEG_GPU_SHA256=1fb59ca0ad9cf1de48e4c7196b245c5e45e9dc1f494ff2e763cfb6a3ab37a347
ARG FFMPEG_GPU_URL=https://github.com/exinarium/GuildwiseHQ/releases/download/ffmpeg-gpu-${FFMPEG_GPU_TAG}/${FFMPEG_GPU_FILE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN echo "${FFMPEG_GPU_SHA256}" | grep -Eq '^[0-9a-f]{64}$' \
      || { echo "FFMPEG_GPU_SHA256 must be the 64-hex SHA-256 of the pinned file" >&2; exit 1; } \
    && curl -fsSL --retry 3 -o /tmp/ffmpeg-gpu.tar.xz "${FFMPEG_GPU_URL}" \
    && echo "${FFMPEG_GPU_SHA256}  /tmp/ffmpeg-gpu.tar.xz" | sha256sum -c - \
    && mkdir -p /opt/ffmpeg-gpu \
    && tar -xJf /tmp/ffmpeg-gpu.tar.xz -C /opt/ffmpeg-gpu --strip-components=1 \
    && rm -f /tmp/ffmpeg-gpu.tar.xz \
    && /opt/ffmpeg-gpu/bin/ffmpeg -hide_banner -encoders | grep -q h264_nvenc

FROM node:26.13-bookworm-slim AS build
RUN npm install -g pnpm@12.8.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# The help videos' metadata (media/videos/*.json and *.vtt; the MP4s and WebMs stay out of the build context, see .dockerignore) is
# all the app needs: the library manifest (dist/video-library.json) lists the videos and their chapters. The manifest builder
# wants an MP4 next to each JSON, so an empty placeholder stands in for it in this stage only.
RUN for j in media/videos/*.json; do [ -e "${j%.json}.mp4" ] || : > "${j%.json}.mp4"; done
RUN pnpm --filter @aom/web build && pnpm --filter @aom/server build
# Production-only node_modules for the server (@aom/shared is bundled into dist/main.mjs).
RUN pnpm --filter @aom/server deploy --prod /out/server \
 && rm -rf /out/server/src /out/server/test /out/server/scripts /out/server/tsconfig.json \
           /out/server/tsup.config.ts /out/server/vitest.config.ts /out/server/pnpm-lock.yaml /out/server/pnpm-workspace.yaml \
 && cp -r apps/web/dist /out/web

# The runner release the "Add a workstation" installers download from this app (core DESIGN R18-U "Image build modes", R27, R30):
# release/aom-runner-<version>.tgz with manifest.json and manifest.json.minisig. Its own stage, so only the runtime image
# runs it (the video worker never does).
#   RUNNER_RELEASE=official  (default) the owner-signed assets of this RUNNER_VERSION from the core GitHub release, verified with
#                            the key in apps/runner/release-key/ (refused while it is the placeholder; CORE_RELEASE_TAG overrides
#                            the release, default v<newest dated version in CHANGELOG.md>)
#   RUNNER_RELEASE=own-key   runner-release/ in the build context (packaged with `scripts/package-runner.sh --pubkey <your.pub>
#                            --out runner-release` and SIGNED BEFORE THE BUILD), verified with AOM_RUNNER_RELEASE_PUBKEY (the
#                            public key line); set the same key on the server
#   RUNNER_RELEASE=dev       built from source, unsigned: refused at boot while "Only signed runners" is on
# The build only verifies (minisign -V): no secret key enters the build context (.dockerignore) or the image.
FROM build AS runner-release
ARG RUNNER_RELEASE=official
ARG AOM_RUNNER_RELEASE_PUBKEY=
ARG CORE_RELEASE_TAG=
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl minisign && rm -rf /var/lib/apt/lists/*
RUN AOM_RUNNER_RELEASE_PUBKEY="$AOM_RUNNER_RELEASE_PUBKEY" CORE_RELEASE_TAG="$CORE_RELEASE_TAG" \
    scripts/runner-release.sh "$RUNNER_RELEASE" /out/release

# The video worker (docker compose --profile video): the same server bundle with Chromium, ffmpeg and the offline voice.
# Renders the videos of the YouTube push and uploads the approved ones (docs/SELF-HOSTING.md "YouTube videos"). Not part of the
# default build: `docker build .` still builds the runtime stage below. It needs the help videos (the clips are cut from them) from
# the media folder as a named build context, because the context itself leaves the MP4s out (.dockerignore):
#   docker build --target video-worker --build-context media=media -t aom-video-worker .
# (docker-compose.prod.yml passes it as additional_contexts.)
FROM node:26.13-bookworm-slim AS video-worker
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
# The GPU ffmpeg (stage ffmpeg-gpu); the CPU ffmpeg of the voice script stays exactly as it is. `video-worker --remote`
# picks NVENC when the host's GPU passes the test encode and reports `cpu` with the reason otherwise (AOM_VIDEO_GPU=off
# forces the CPU). The in-process `--loop` keeps rendering on the CPU.
COPY --from=ffmpeg-gpu /opt/ffmpeg-gpu /opt/ffmpeg-gpu
ENV AOM_FFMPEG_GPU=/opt/ffmpeg-gpu/bin/ffmpeg
RUN mkdir -p /data/video && chown -R node:node /data/video /opt/aom-video && chmod -R a+rX /opt/aom-video
USER node
CMD ["node", "dist/video-worker.mjs", "--loop"]

FROM node:26.13-bookworm-slim AS runtime
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
COPY --from=runner-release --chown=root:root --chmod=0555 /out/release /app/release
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
# Migrations run on boot (AOM_MIGRATE_ON_BOOT). First owner: node dist/admin-create.mjs ...; platform account: node dist/superadmin-create.mjs ...; preview the data migrations: node dist/orgs-migrate.mjs --dry-run and node dist/restructure-migrate.mjs --dry-run and node dist/ranking-migrate.mjs --dry-run; one-off Lean Team v3 rollout: node dist/ledger-cleanup.mjs and node dist/lean-rollout.mjs (both dry runs unless --apply); carry blog articles over from an old install: node dist/blog-bundle-import.mjs --bundle DIR --author EMAIL (a dry run unless --apply)
CMD ["node", "dist/main.mjs"]
