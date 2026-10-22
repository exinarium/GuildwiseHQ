#!/usr/bin/env bash
# Records one or more help videos, one after the other, each on a fresh demo stack.
#   e2e/video/record.sh backlog
#   e2e/video/record.sh backlog desk intake
#   AOM_VIDEO_PORT=4672 AOM_VIDEO_DB=aom_video_b e2e/video/record.sh ledger vaults     # beside another recording
# Needs `pnpm build` once (the stack serves apps/web/dist and runs apps/server/dist and apps/runner/dist) and
# e2e/video/setup-voice.sh once. Two recordings at the same time need their own AOM_VIDEO_PORT and AOM_VIDEO_DB.
# Environment: AOM_VIDEO_PORT (4671), AOM_VIDEO_DB (aom_onboard_video), AOM_VIDEO_DIR_BASE (TMPDIR),
# AOM_VIDEO_OUT (apps/web/public/videos), AOM_VIDEO_PACE (1), AOM_VIDEO_VOICE, AOM_VIDEO_HOME.
set -uo pipefail
cd "$(dirname "$0")/../.."
[ "$#" -gt 0 ] || { echo "usage: e2e/video/record.sh <slug>..." >&2; exit 2; }
for slug in "$@"; do
  [[ "$slug" =~ ^[a-z0-9-]+$ && -f "e2e/video/$slug.spec.ts" ]] || { echo "no such video: $slug (e2e/video/$slug.spec.ts)" >&2; exit 2; }
done
failed=()
for slug in "$@"; do
  echo "== recording $slug (port ${AOM_VIDEO_PORT:-4671}, db ${AOM_VIDEO_DB:-aom_onboard_video})"
  start=$(date +%s)
  if AOM_VIDEO_SLUG="$slug" pnpm --filter @aom/e2e video; then
    echo "== $slug done in $(( $(date +%s) - start )) s"
  else
    echo "== $slug FAILED" >&2
    failed+=("$slug")
  fi
done
[ "${#failed[@]}" -eq 0 ] || { echo "failed: ${failed[*]}" >&2; exit 1; }
