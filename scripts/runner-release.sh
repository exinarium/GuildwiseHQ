#!/usr/bin/env bash
# Puts the workstation runner release the image serves into <out-dir> (core DESIGN R18-U "Image build modes", R27, R30):
# aom-runner-<version>.tgz plus, for the signed modes, manifest.json and manifest.json.minisig, so the server can check its
# own release at boot ("Only signed runners" is locked on in Guildwise Cloud) and hand the proof to the installers.
# Called by the core Dockerfile's runner-release stage from the repository root (guildwise-cloud has the same script, with the
# core as a submodule in core/, and the same asset names):
#
#   scripts/runner-release.sh official|own-key|dev <out-dir>
#
# official  Downloads the owner-signed assets for the core's RUNNER_VERSION from the core GitHub release and verifies them
#           with the public key embedded in the core (apps/runner/release-key/guildwise-runner-release.pub). Refuses
#           the placeholder key. Fails naming the missing asset and the release: the owner signs after the merge and
#           uploads first (docs/DEPLOY-OPERATOR.md "Release order").
# own-key   Copies runner-release/ (tgz, manifest.json, manifest.json.minisig; packaged with the target's public key and
#           SIGNED BEFORE THE BUILD, outside it) and verifies it with AOM_RUNNER_RELEASE_PUBKEY (the key line of a minisign
#           .pub file, or the whole file's text). The UAT route (UAT key) and the self-hoster's own signing route.
# dev       Packages the runner from source, unsigned. Allowed by the build; refused at boot where "Only signed runners"
#           is on (always on Guildwise Cloud).
#
# This script only VERIFIES (minisign -V). It never signs and never reads a secret key: no secret key enters the build
# context (.dockerignore) or the image. Env: CORE_RELEASE_TAG (default v<newest dated release in core/CHANGELOG.md>),
# RUNNER_RELEASE_BASE_URL (default the core repository's GitHub release downloads), RUNNER_RELEASE_DIR (default
# runner-release), CORE_DIR (default the repository root). apps/runner/test/runner-release-scripts.test.ts covers it.
set -euo pipefail

MODE="${1:-}"
OUT="${2:-}"
[ -n "$MODE" ] && [ -n "$OUT" ] || { echo "usage: $0 official|own-key|dev <out-dir>" >&2; exit 2; }

CORE="${CORE_DIR:-.}"
BASE_URL="${RUNNER_RELEASE_BASE_URL:-https://github.com/exinarium/GuildwiseHQ/releases/download}"
SRC_DIR="${RUNNER_RELEASE_DIR:-runner-release}"
EMBEDDED_KEY="$CORE/apps/runner/release-key/guildwise-runner-release.pub"

die() {
  printf 'runner release (%s): %s\n' "$MODE" "$*" >&2
  exit 1
}

VERSION="$(sed -n "s/.*RUNNER_VERSION = '\(.*\)'.*/\1/p" "$CORE/apps/runner/src/version.ts")"
[ -n "$VERSION" ] || die "cannot read RUNNER_VERSION from $CORE/apps/runner/src/version.ts"
TGZ="aom-runner-$VERSION.tgz"

# The key line of a minisign public key (the base64 line after "untrusted comment:"), from a file's text or a bare line.
key_line() {
  printf '%s\n' "$1" | sed -e 's/\r$//' -e '/^untrusted comment:/d' -e '/^[[:space:]]*$/d' | tail -n 1
}

# Checks the signature over manifest.json, then that the manifest names this version's tgz with its sha256.
verify() {
  local dir="$1" pub="$2" file sha version
  case "$pub" in
    *PLACEHOLDER*) die "the runner release key is the placeholder: an official build needs the owner's public key (core scripts/set-runner-release-key.sh), or build with RUNNER_RELEASE=own-key" ;;
  esac
  printf '%s' "$pub" | grep -Eq '^RW[A-Za-z0-9+/]{54}$' || die "not a minisign public key (expected the base64 line starting with RW)"
  for f in manifest.json manifest.json.minisig; do [ -f "$dir/$f" ] || die "$f is missing in $dir"; done
  minisign -V -q -P "$pub" -m "$dir/manifest.json" -x "$dir/manifest.json.minisig" \
    || die "the signature of manifest.json does not verify with the trusted key"
  read -r file sha version < <(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log([m.file, m.sha256, m.version].map((v) => String(v ?? "")).join(" "));
  ' "$dir/manifest.json")
  [ "$version" = "$VERSION" ] || die "manifest.json is for runner $version, this core builds $VERSION"
  [ "$file" = "$TGZ" ] || die "manifest.json names $file, expected $TGZ"
  [ -f "$dir/$TGZ" ] || die "$TGZ is missing in $dir"
  printf '%s  %s\n' "$sha" "$dir/$TGZ" | sha256sum -c --status - || die "$TGZ does not match the sha256 in manifest.json"
}

mkdir -p "$OUT"
case "$MODE" in
  official)
    [ -f "$EMBEDDED_KEY" ] || die "$EMBEDDED_KEY is missing: this core has no runner release key"
    PUB="$(key_line "$(cat "$EMBEDDED_KEY")")"
    case "$(cat "$EMBEDDED_KEY")" in *PLACEHOLDER*) PUB="PLACEHOLDER" ;; esac
    TAG="${CORE_RELEASE_TAG:-}"
    if [ -z "$TAG" ]; then
      TAG="v$(sed -n 's/^## \[\([0-9][0-9.]*\)\] - [0-9].*/\1/p' "$CORE/CHANGELOG.md" | head -n 1)"
      [ "$TAG" != v ] || die "no dated release in $CORE/CHANGELOG.md: set CORE_RELEASE_TAG"
    fi
    STAGE="$(mktemp -d)"
    trap 'rm -rf "$STAGE"' EXIT
    for f in "$TGZ" manifest.json manifest.json.minisig; do
      curl -fsSL --retry 3 -o "$STAGE/$f" "$BASE_URL/$TAG/$f" \
        || die "signed runner asset $f not found on core release $TAG ($BASE_URL/$TAG/$f): sign and upload first (docs/DEPLOY-OPERATOR.md \"Release order\")"
    done
    verify "$STAGE" "$PUB"
    cp "$STAGE/$TGZ" "$STAGE/manifest.json" "$STAGE/manifest.json.minisig" "$OUT/"
    ;;
  own-key)
    [ -n "${AOM_RUNNER_RELEASE_PUBKEY:-}" ] || die "AOM_RUNNER_RELEASE_PUBKEY is not set: pass the public key of the key that signed $SRC_DIR (--build-arg AOM_RUNNER_RELEASE_PUBKEY=...)"
    [ -d "$SRC_DIR" ] || die "$SRC_DIR/ is missing: package the runner with the target's public key and sign manifest.json before the build"
    verify "$SRC_DIR" "$(key_line "$AOM_RUNNER_RELEASE_PUBKEY")"
    cp "$SRC_DIR/$TGZ" "$SRC_DIR/manifest.json" "$SRC_DIR/manifest.json.minisig" "$OUT/"
    ;;
  dev)
    "$CORE/scripts/package-runner.sh"
    cp "$CORE/release/$TGZ" "$OUT/"
    echo "runner release (dev): UNSIGNED $TGZ; refused at boot where \"Only signed runners\" is on (Guildwise Cloud)" >&2
    ;;
  *) die "unknown mode (official, own-key or dev)" ;;
esac
# The verified manifest also under its per-version name, so pins to this release stay servable (core R18-U, W12).
if [ -f "$OUT/manifest.json" ]; then
  cp "$OUT/manifest.json" "$OUT/manifest-$VERSION.json"
  [ ! -f "$OUT/manifest.json.minisig" ] || cp "$OUT/manifest.json.minisig" "$OUT/manifest-$VERSION.json.minisig"
fi
echo "runner release ($MODE): $(find "$OUT" -maxdepth 1 -type f -printf '%f ')"
