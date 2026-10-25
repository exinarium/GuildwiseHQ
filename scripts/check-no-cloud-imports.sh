#!/usr/bin/env bash
# The open-source core must never depend on the hosted extension (Guildwise Cloud): the dependency points one way, from
# the extension to the core. Fails when core source imports or requires anything from `@guildwise/cloud*`, a `cloud/`
# or `guildwise-cloud` path, or lists such a package as a dependency. Run in CI (.github/workflows/ci.yml).
#   scripts/check-no-cloud-imports.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CORE_DIRS=(apps packages e2e scripts)
EXISTING=()
for d in "${CORE_DIRS[@]}"; do [ -d "$d" ] && EXISTING+=("$d"); done

# imports, dynamic imports, requires and `vi.mock` of a cloud module. (`src/cloud/` of the core is the cloud-workstations
# feature, not the hosted extension: only the extension's package names and its `cloud/server`, `cloud/web` folders count.)
PATTERN="['\"](@guildwise/cloud[^'\"]*|[^'\"]*(^|/)cloud/(server|web)(/[^'\"]*)?|[^'\"]*guildwise-cloud[^'\"]*)['\"]"
BAD=$(grep -rnE "(from|import|require|mock)\\s*\\(?\\s*${PATTERN}" "${EXISTING[@]}" \
  --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' --include='*.cjs' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.dev --exclude-dir=test-results \
  --exclude='check-no-cloud-imports.sh' || true)

# dependencies on a cloud package in any core package.json
DEPS=$(grep -rnE '"@guildwise/cloud[^"]*"' "${EXISTING[@]}" --include=package.json --exclude-dir=node_modules || true)

if [ -n "$BAD$DEPS" ]; then
  echo "The core imports from the hosted extension. The dependency must point from the extension to the core:" >&2
  [ -n "$BAD" ] && echo "$BAD" >&2
  [ -n "$DEPS" ] && echo "$DEPS" >&2
  exit 1
fi
echo "ok: the core imports nothing from the hosted extension"
