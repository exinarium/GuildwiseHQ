# syntax=docker/dockerfile:1
# Guildwise HQ help videos: a small static server (Caddy: HTTP Range, correct MIME types, no directory listing).
# Build context is this folder:  docker build -t aom-media media/   (scripts/media-build.sh also labels the image)
# The app server forwards /videos/* to this service (AOM_MEDIA_URL=http://media:80).

FROM node:22.23-alpine AS manifest
WORKDIR /videos
COPY videos/ /videos/
COPY build-manifest.mjs /build-manifest.mjs
RUN node /build-manifest.mjs /videos

FROM caddy:2-alpine
# The content hash of media/videos (scripts/media-build.sh passes it): scripts/media-changed.sh compares it.
ARG MEDIA_HASH=""
LABEL org.guildwise.media-hash="${MEDIA_HASH}"
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=manifest /videos/ /srv/videos/
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
