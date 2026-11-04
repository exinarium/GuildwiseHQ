#!/usr/bin/env bash
# Copies the cached dependencies (node_modules) into this worktree instead of installing them.
# The cache is GWP_CORE_CACHE, or the gwp-core-* folder found through a node_modules/.bin entry on PATH.
# It never runs `pnpm install`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${GWP_CORE_CACHE:-}"
if [ -z "$cache" ]; then
  IFS=':' read -ra parts <<<"$PATH"
  for p in "${parts[@]}"; do
    case "$p" in
      */gwp-core-*/node_modules/.bin) cache="${p%/node_modules/.bin}"; break ;;
    esac
  done
fi
if [ -z "$cache" ] || [ ! -d "$cache/node_modules" ]; then
  echo "no cached dependencies found: set GWP_CORE_CACHE or use the gwp-core toolchain (ask DevOps: aom devops \"gwp-core cache missing\")" >&2
  exit 1
fi

if [ -f "$cache/pnpm-lock.yaml" ] && ! cmp -s "$cache/pnpm-lock.yaml" "$root/pnpm-lock.yaml"; then
  echo "the cache's pnpm-lock.yaml differs from this worktree's:" >&2
  echo "  cache:    $(sha256sum "$cache/pnpm-lock.yaml" | cut -c1-16)" >&2
  echo "  worktree: $(sha256sum "$root/pnpm-lock.yaml" | cut -c1-16)" >&2
  echo "ask DevOps to refresh the gwp-core cache (aom devops \"refresh the gwp-core cache\")" >&2
  exit 1
fi

for dir in . apps/* packages/* e2e; do
  if [ -d "$cache/$dir/node_modules" ] && [ -d "$root/$dir" ]; then
    # no owner/group: the sandbox refuses chgrp
    rsync -rlt --perms --no-owner --no-group --ignore-existing --exclude .git "$cache/$dir/node_modules/" "$root/$dir/node_modules/"
    echo "copied $dir/node_modules"
  fi
done
