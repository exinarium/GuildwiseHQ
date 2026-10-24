#!/usr/bin/env bash
# Tells whether media/videos changed since the media image was built (so a deploy can skip the media rebuild).
#   scripts/media-changed.sh [image-tag]      (default tag: aom-media:latest)
# Exit 0 = changed (or no image / no recorded hash yet): rebuild with scripts/media-build.sh.
# Exit 1 = unchanged: skip the rebuild.  Exit 2 = error.   Prints "changed" or "unchanged" and both hashes.
set -uo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-aom-media:latest}"
CURRENT="$(node media/build-manifest.mjs media/videos --hash)" || { echo "cannot hash media/videos" >&2; exit 2; }
BUILT="$(docker image inspect --format '{{ index .Config.Labels "org.guildwise.media-hash" }}' "$TAG" 2>/dev/null || true)"
echo "current: $CURRENT"
echo "image:   ${BUILT:-(none)}"
if [ -n "$BUILT" ] && [ "$BUILT" = "$CURRENT" ]; then echo unchanged; exit 1; fi
echo changed
exit 0
