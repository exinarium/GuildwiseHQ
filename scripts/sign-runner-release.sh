#!/usr/bin/env bash
# Signs a runner release manifest with minisign (core DESIGN R18-U "Release step", step 3). Run it ONLY on the machine that
# holds the secret key (the owner's laptop, ideally offline): never on the DevBox, a server or CI, and never by an agent.
#
#   scripts/sign-runner-release.sh <manifest.json> [--key <secret key>] [--pub <public key>]
#
# Default key ~/.minisign/guildwise-runner-release.key (minisign asks for its passphrase). Writes <manifest.json>.minisig with
# the trusted comment "guildwise-runner <version>", then verifies it with --pub (default ~/guildwise-runner-release.pub) when
# that file exists. Upload the tgz, manifest.json and manifest.json.minisig to the core release afterwards, for example:
#   gh release upload v<release> release/aom-runner-<v>.tgz release/manifest.json release/manifest.json.minisig
set -euo pipefail
MANIFEST="${1:-}"
[ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] || { echo "usage: $0 <manifest.json> [--key <secret key>] [--pub <public key>]" >&2; exit 2; }
shift
KEY="$HOME/.minisign/guildwise-runner-release.key"
PUB="$HOME/guildwise-runner-release.pub"
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:?--key needs a file}"; shift 2 ;;
    --pub) PUB="${2:?--pub needs a file}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
command -v minisign >/dev/null || { echo "minisign is not installed (sudo apt install minisign, or brew install minisign)" >&2; exit 1; }
[ -f "$KEY" ] || { echo "no secret key at $KEY (give --key)" >&2; exit 1; }
VERSION="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || ""))' "$MANIFEST")"
[ -n "$VERSION" ] || { echo "$MANIFEST has no version: is it a runner release manifest?" >&2; exit 1; }
minisign -S -s "$KEY" -m "$MANIFEST" -x "$MANIFEST.minisig" -t "guildwise-runner $VERSION"
if [ -f "$PUB" ]; then
  minisign -V -p "$PUB" -m "$MANIFEST" -x "$MANIFEST.minisig"
else
  echo "signed; verify it yourself: minisign -V -p <your .pub> -m $MANIFEST -x $MANIFEST.minisig" >&2
fi
# The per-version copy (manifest-<v>.json, written by package-runner.sh) has the same bytes: the same signature covers it,
# so a pin to this release can still be served after a newer release is packaged next to it.
DIR="$(dirname "$MANIFEST")"
if [ "$(basename "$MANIFEST")" = manifest.json ]; then
  [ -f "$DIR/manifest-$VERSION.json" ] || cp "$MANIFEST" "$DIR/manifest-$VERSION.json"
  if cmp -s "$MANIFEST" "$DIR/manifest-$VERSION.json"; then
    cp "$MANIFEST.minisig" "$DIR/manifest-$VERSION.json.minisig"
  else
    echo "$DIR/manifest-$VERSION.json differs from $MANIFEST: not signed (package again)" >&2
  fi
fi
echo "wrote $MANIFEST.minisig (guildwise-runner $VERSION)"
