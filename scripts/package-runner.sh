#!/usr/bin/env bash
# Builds the workstation runner as a self-contained tarball plus its UNSIGNED release manifest (core DESIGN R18-U, R30):
#   <out>/aom-runner-<version>.tgz
#   <out>/manifest.json   {version, file, sha256, minRunner, floor, allowDowngrade: false, nodeRuntime}
# Contents of the tgz: aom-runner/{aom-runner, aom-runner.cmd, guildwise-runner.cmd, dist/ (with dist/grammars), node_modules/,
# package.json, README.md, THIRD_PARTY_NOTICES}
#
#   scripts/package-runner.sh [--pubkey <file.pub>] [--out <dir>] [--node-runtime <file.json> | --no-node-runtime] [--check]
#
# --pubkey        compile THIS minisign public key in as the release key the runner trusts (own-key and per-target builds,
#                 e.g. --pubkey ~/.config/guildwise/signing/uat/guildwise-uat.pub --out release/uat/). Default: the official
#                 key in apps/runner/release-key/ (a placeholder until the owner runs scripts/set-runner-release-key.sh).
# --out           where to write (default release/).
# --node-runtime  the pinned Node builds for the root-owned admin tools, {"<platform>-<arch>": {"url", "sha256"}} [rv7-12],
#                 for linux-x64, linux-arm64, darwin-x64 and darwin-arm64 (also AOM_RUNNER_NODE_RUNTIME). Default: the pinned
#                 scripts/node-runtime.json (Node 22, sha256 from nodejs.org SHASUMS256.txt). A build never gets an empty
#                 nodeRuntime by accident: without one `--runner-user dedicated` cannot install (UAT R25 F5).
# --no-node-runtime  build without one anyway (dev and test builds: the dedicated runner user cannot install from it).
# --check         check the options and print the Node runtime file that would be used; builds nothing.
#
# Signing is a separate step on the machine that holds the secret key (scripts/sign-runner-release.sh, or the release-flow
# `release.sign`): this script never signs and never reads a secret key. Any machine may run it.
# Requires: pnpm, node >= 22, npm and network access (to install production dependencies).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(sed -n "s/.*RUNNER_VERSION = '\(.*\)'.*/\1/p" apps/runner/src/version.ts)"
FLOOR="$(sed -n "s/.*MIN_TRUSTED_RUNNER = '\(.*\)'.*/\1/p" apps/runner/src/update/floor.ts)"
[ -n "$VERSION" ] && [ -n "$FLOOR" ] || { echo "package-runner: cannot read RUNNER_VERSION or MIN_TRUSTED_RUNNER" >&2; exit 1; }
OUT="$ROOT/release"
PUBKEY_FILE=""
NODE_RUNTIME="${AOM_RUNNER_NODE_RUNTIME:-}"
NO_NODE_RUNTIME=0
CHECK_ONLY=0
USAGE="usage: $0 [--pubkey <file.pub>] [--out <dir>] [--node-runtime <file.json> | --no-node-runtime] [--check]"
while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey) PUBKEY_FILE="${2:?--pubkey needs a file}"; shift 2 ;;
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --node-runtime) NODE_RUNTIME="${2:?--node-runtime needs a file}"; shift 2 ;;
    --no-node-runtime) NO_NODE_RUNTIME=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
# Checked before anything is built: a release without the pinned Node cannot install the dedicated runner user.
if [ -z "$NODE_RUNTIME" ] && [ "$NO_NODE_RUNTIME" = 0 ] && [ -f "$ROOT/scripts/node-runtime.json" ]; then
  NODE_RUNTIME="$ROOT/scripts/node-runtime.json"
fi
if [ "$NO_NODE_RUNTIME" = 1 ]; then
  [ -z "$NODE_RUNTIME" ] || { echo "package-runner: --node-runtime and --no-node-runtime exclude each other" >&2; exit 2; }
  echo "package-runner: WARNING: --no-node-runtime: this release lists no Node runtime; \`--runner-user dedicated\` cannot install from it (dev and test builds only)" >&2
elif [ -z "$NODE_RUNTIME" ]; then
  echo "package-runner: no scripts/node-runtime.json here, and --node-runtime <file.json> is required (the pinned Node 22 builds with their sha256 for linux-x64, linux-arm64, darwin-x64 and darwin-arm64); without it a dedicated runner install fails. A dev or test build: --no-node-runtime." >&2
  echo "$USAGE" >&2
  exit 2
else
  [ -f "$NODE_RUNTIME" ] || { echo "package-runner: --node-runtime $NODE_RUNTIME does not exist" >&2; exit 2; }
  # shellcheck disable=SC2016 # JavaScript, expanded by node
  node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].filter(
  (k) => !r[k] || !/^https:\/\//.test(String(r[k].url)) || !/^[0-9a-f]{64}$/.test(String(r[k].sha256)));
if (bad.length) { console.error(`package-runner: --node-runtime needs an https url and a sha256 for ${bad.join(", ")}`); process.exit(2); }
' "$NODE_RUNTIME" || exit 2
fi
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac

BUILD_PUBKEY=""
if [ -n "$PUBKEY_FILE" ]; then
  # a minisign PUBLIC key only: "untrusted comment:" then one base64 line of 42 bytes starting with "Ed"
  BUILD_PUBKEY="$(node "$ROOT/scripts/runner-key-check.mjs" "$PUBKEY_FILE")" || exit 1
  echo "package-runner: this build trusts release key $(node "$ROOT/scripts/runner-key-check.mjs" --id "$PUBKEY_FILE")"
fi
if [ "$CHECK_ONLY" = 1 ]; then
  echo "package-runner: node runtime ${NODE_RUNTIME:-none}"
  exit 0
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

AOM_RUNNER_BUILD_PUBKEY="$BUILD_PUBKEY" pnpm --filter @aom/runner build
PKG="$STAGE/aom-runner"
mkdir -p "$PKG"
cp -r apps/runner/dist "$PKG/dist"
cp apps/runner/README.md "$PKG/README.md"
# Licences of the tree-sitter parser and grammars in dist/grammars (docs/design/project-graphs.md owner decision 7).
cp apps/runner/THIRD_PARTY_NOTICES "$PKG/THIRD_PARTY_NOTICES"
# The root-owned admin tools (R20: guildwise-admin, deploy-compose): the installer copies them out of the verified package.
if [ -d apps/runner/admin ]; then cp -r apps/runner/admin "$PKG/admin"; fi

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
# The version floor (core DESIGN R18-U): the launcher never rolls back below it either.
FLOOR='@FLOOR@'
ver_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, /[.-]/); split(b, y, /[.-]/);
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'
}

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
       && [ "$now" -gt "$deadline" ] && [ -f "$ROOT/$from/aom-runner/dist/aom-runner.mjs" ] && ver_ge "$from" "$FLOOR"; then
      ln -sfn "$ROOT/$from/aom-runner" "$ROOT/current"
      printf 'version=%s\nat=%s\nreason=%s\n' "$to" "$now" "did not start or connect in time" >"$ROOT/update-failed"
      rm -f "$PENDING"
      exec "$ROOT/$from/aom-runner/aom-runner" "$@"
    fi
  fi
fi
exec node "$HERE/dist/aom-runner.mjs" "$@"
LAUNCH
sed -i.bak "s/@FLOOR@/$FLOOR/" "$PKG/aom-runner" && rm -f "$PKG/aom-runner.bak"
chmod +x "$PKG/aom-runner" "$PKG/dist/"*.mjs
printf '@echo off\r\nnode "%%~dp0dist\\aom-runner.mjs" %%*\r\n' > "$PKG/aom-runner.cmd"
cp "$PKG/aom-runner.cmd" "$PKG/guildwise-runner.cmd"  # alias; on Linux and macOS the installer links both names to the aom-runner launcher

mkdir -p "$OUT"
tar -C "$STAGE" -czf "$OUT/aom-runner-$VERSION.tgz" aom-runner
# The manifest the key holder signs (the signature covers these bytes; the runner and the server check it). A signature
# left from an earlier build belongs to another manifest: it goes.
# manifest-<v>.json is the same bytes, kept per version so the server can serve a pin to a retained release (R18-U).
rm -f "$OUT/manifest.json.minisig" "$OUT/manifest-$VERSION.json.minisig"
node "$ROOT/scripts/runner-manifest.mjs" "$OUT/aom-runner-$VERSION.tgz" "$VERSION" "$FLOOR" "$NODE_RUNTIME" >"$OUT/manifest.json"
cp "$OUT/manifest.json" "$OUT/manifest-$VERSION.json"
echo "wrote $OUT/aom-runner-$VERSION.tgz and $OUT/manifest.json (unsigned: sign it with scripts/sign-runner-release.sh on the key holder's machine)"
