#!/usr/bin/env bash
# Builds the workstation runner as a self-contained tarball: release/aom-runner-<version>.tgz
# Contents: aom-runner/{aom-runner, aom-runner.cmd, dist/, node_modules/, package.json, README.md}
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

# package.json with only the real runtime dependencies (@aom/shared is bundled into dist/).
node -e '
const p = require("./apps/runner/package.json");
const deps = { ...p.dependencies };
delete deps["@aom/shared"];
const out = {
  name: "aom-runner", version: process.argv[1], type: "module", private: true,
  bin: { "aom-runner": "./dist/aom-runner.mjs", aom: "./dist/aom.mjs" },
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
exec node "$(cd "$(dirname "$SELF")" && pwd)/dist/aom-runner.mjs" "$@"
LAUNCH
chmod +x "$PKG/aom-runner" "$PKG/dist/"*.mjs
printf '@echo off\r\nnode "%%~dp0dist\\aom-runner.mjs" %%*\r\n' > "$PKG/aom-runner.cmd"

mkdir -p "$OUT"
tar -C "$STAGE" -czf "$OUT/aom-runner-$VERSION.tgz" aom-runner
echo "wrote $OUT/aom-runner-$VERSION.tgz"
