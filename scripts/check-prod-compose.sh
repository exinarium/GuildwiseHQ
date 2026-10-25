#!/usr/bin/env bash
# AC10: the production compose stack serves the app over HTTPS (Caddy internal CA), migrates on boot, /api/health is
# green, and a runner pairs and connects against it. Uses its own compose project and free ports; tears everything down.
#   scripts/check-prod-compose.sh            (HTTPS 9443, HTTP 9080, mail UI 9025 by default)
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${AOM_PROD_TEST_PROJECT:-aom-prod-test}"
HTTPS_PORT="${AOM_PROD_TEST_HTTPS_PORT:-9443}"
HTTP_PORT="${AOM_PROD_TEST_HTTP_PORT:-9080}"
MAIL_PORT="${AOM_PROD_TEST_MAIL_PORT:-9025}"
WORK="$(mktemp -d)"
ENVFILE="$WORK/.env"
ORIGIN="https://localhost:$HTTPS_PORT"
cat > "$ENVFILE" <<ENV
POSTGRES_PASSWORD=test-password-123
AOM_SECRET_KEY=test-secret-key-0123456789abcdef
AOM_DOMAIN=localhost
AOM_PUBLIC_ORIGIN=$ORIGIN
AOM_HTTP_PORT=$HTTP_PORT
AOM_HTTPS_PORT=$HTTPS_PORT
AOM_MAILPIT_PORT=$MAIL_PORT
AOM_SMTP_URL=smtp://mailpit:1025
ENV
dc() { docker compose -p "$PROJECT" --env-file "$ENVFILE" -f docker-compose.prod.yml --profile mail "$@"; }
RUNNER_PID=""
cleanup() {
  [ -n "$RUNNER_PID" ] && kill "$RUNNER_PID" 2>/dev/null || true
  dc down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

dc up -d --build
for _ in $(seq 1 60); do
  docker cp "$PROJECT-caddy-1:/data/caddy/pki/authorities/local/root.crt" "$WORK/root.crt" 2>/dev/null && break
  sleep 1
done
CURL=(curl -fsS --cacert "$WORK/root.crt")
for _ in $(seq 1 30); do "${CURL[@]}" "$ORIGIN/api/health" >"$WORK/health.json" 2>/dev/null && break; sleep 1; done
echo "health: $(cat "$WORK/health.json")"
grep -q '"ok":true' "$WORK/health.json"
dc logs app | grep -q "applied .* migration" && echo "migrations applied on boot"

# The help videos come from the media container through the app: manifest, and a Range request (seeking).
# (read the manifest into a variable first: `curl | grep -q` fails with curl exit 23 under pipefail when grep exits early)
MANIFEST="$("${CURL[@]}" "$ORIGIN/videos/manifest.json")"
grep -q '"videos"' <<<"$MANIFEST"
SLUG="$(sed -n 's/.*"path": "\/videos\/\([a-z0-9-]*\)\.mp4".*/\1/p' <<<"$MANIFEST" | head -1)"
if [ -n "$SLUG" ]; then
  "${CURL[@]}" -s -o /dev/null -D "$WORK/range.txt" -H 'Range: bytes=0-99' "$ORIGIN/videos/$SLUG.mp4"
  grep -qi '^HTTP/[0-9.]* 206' "$WORK/range.txt" && grep -qi '^content-range: bytes 0-99/' "$WORK/range.txt"
  echo "media: manifest served and Range request answered with 206 ($SLUG.mp4)"
fi

dc exec -T app node dist/admin-create.mjs --email prod@test.local --name Prod --password prod-password-1234
J=(-c "$WORK/jar" -b "$WORK/jar" -H "Origin: $ORIGIN" -H "content-type: application/json")
"${CURL[@]}" "${J[@]}" -X POST "$ORIGIN/api/auth/login" -d '{"email":"prod@test.local","password":"prod-password-1234"}' >/dev/null
CODE="$("${CURL[@]}" "${J[@]}" -X POST "$ORIGIN/api/workstations/pairing-codes" -d '{}' | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"

export NODE_EXTRA_CA_CERTS="$WORK/root.crt"
RUNNER="node apps/runner/dist/aom-runner.mjs"
[ -f apps/runner/dist/aom-runner.mjs ] || pnpm --filter @aom/runner build
$RUNNER pair --server "$ORIGIN" --code "$CODE" --name ProdBox --mock --data-dir "$WORK/runner"
$RUNNER start --data-dir "$WORK/runner" >"$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
for _ in $(seq 1 30); do
  if "${CURL[@]}" "${J[@]}" "$ORIGIN/api/workstations" | grep -q '"connected":true'; then
    echo "AC10 OK: HTTPS via Caddy, migrations on boot, /api/health green, runner paired and connected"
    exit 0
  fi
  sleep 1
done
echo "runner did not connect"; cat "$WORK/runner.log"; exit 1
