#!/usr/bin/env bash
# Builds the media image (help videos) labelled with the content hash of media/videos.
#   scripts/media-build.sh [image-tag]        (default tag: aom-media:latest)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-aom-media:latest}"
HASH="$(node media/build-manifest.mjs media/videos --hash)"
docker build --build-arg "MEDIA_HASH=$HASH" -t "$TAG" media/
echo "built $TAG (media hash $HASH)"
