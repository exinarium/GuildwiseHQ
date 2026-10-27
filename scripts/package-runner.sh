#!/usr/bin/env bash
# Builds the workstation runner as a self-contained tarball: release/aom-runner-<version>.tgz
# Contents: aom-runner/{aom-runner, aom-runner.cmd, guildwise-runner.cmd, dist/ (with dist/grammars), node_modules/, package.json, README.md, THIRD_PARTY_NOTICES}
# Requires: pnpm, node >= 22, npm and network access (to install production dependencies).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(sed -n "s/.*RUNNER_VERSION = '\(.*\)'.*/\1/p" apps/runner/src/version.ts)"
OUT="$ROOT/release"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

pnpm --filter @aom/runner build
PKG="$STAGE/aom-runner"
mkdir -p "$PKG"
cp -r apps/runner/dist "$PKG/dist"
cp apps/runner/README.md "$PKG/README.md"
# Licences of the tree-sitter parser and grammars in dist/grammars (docs/design/project-graphs.md owner decision 7).
cp apps/runner/THIRD_PARTY_NOTICES "$PKG/THIRD_PARTY_NOTICES"

# package.json with only the real runtime dependencies (@aom/shared is bundled into dist/).
node -e '
const p = require("./apps/runner/package.json");
const deps = { ...p.dependencies };
delete deps["@aom/shared"];
const out = {
  name: "aom-runner", version: process.argv[1], type: "module", private: true,
  bin: { "guildwise-runner": "./dist/aom-runner.mjs", "aom-runner": "./dist/aom-runner.mjs", aom: "./dist/aom.mjs" },
  engines: { node: ">=22" }, dependencies: deps,
};
require("fs").writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
' "$VERSION" "$PKG/package.json"
(cd "$PKG" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

cat > "$PKG/aom-runner" <<'LAUNCH'
#!/bin/sh
# Resolve symlinks so the launcher works when linked into a PATH directory.
SELF="$0"
while [ -L "$SELF" ]; do
  DIR="$(cd "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$DIR/$SELF" ;; esac
done
HERE="$(cd "$(dirname "$SELF")" && pwd -P)"

# Update guard (docs/RUNNER.md "Updates"). Layout: <root>/<version>/aom-runner (this folder), <root>/current -> it.
# After a self-update the runner writes <root>/update-pending (from=, to=, deadline=). If this version is the one that was
# switched to and it has not cleared that file by the deadline (it crashes on start, or never connects), the service
# keeps restarting it: here the previous version is put back instead. Only the service's `start` is guarded.
if [ "$1" = start ]; then
  ROOT="$(dirname "$(dirname "$HERE")")"
  PENDING="$ROOT/update-pending"
  if [ -f "$PENDING" ]; then
    to="$(sed -n 's/^to=//p' "$PENDING" | head -n1)"
    from="$(sed -n 's/^from=//p' "$PENDING" | head -n1)"
    deadline="$(sed -n 's/^deadline=//p' "$PENDING" | head -n1)"
    now="$(date +%s)"
    case "$deadline" in ''|*[!0-9]*) deadline="" ;; esac
    if [ -n "$to" ] && [ -n "$from" ] && [ -n "$deadline" ] && [ "$(basename "$(dirname "$HERE")")" = "$to" ] \
       && [ "$now" -gt "$deadline" ] && [ -f "$ROOT/$from/aom-runner/dist/aom-runner.mjs" ]; then
      ln -sfn "$ROOT/$from/aom-runner" "$ROOT/current"
      printf 'version=%s\nat=%s\nreason=%s\n' "$to" "$now" "did not start or connect in time" >"$ROOT/update-failed"
      rm -f "$PENDING"
      exec "$ROOT/$from/aom-runner/aom-runner" "$@"
    fi
  fi
fi
exec node "$HERE/dist/aom-runner.mjs" "$@"
LAUNCH
chmod +x "$PKG/aom-runner" "$PKG/dist/"*.mjs
printf '@echo off\r\nnode "%%~dp0dist\\aom-runner.mjs" %%*\r\n' > "$PKG/aom-runner.cmd"
cp "$PKG/aom-runner.cmd" "$PKG/guildwise-runner.cmd"  # alias; on Linux and macOS the installer links both names to the aom-runner launcher

mkdir -p "$OUT"
tar -C "$STAGE" -czf "$OUT/aom-runner-$VERSION.tgz" aom-runner
echo "wrote $OUT/aom-runner-$VERSION.tgz"
