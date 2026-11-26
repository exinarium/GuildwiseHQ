#!/usr/bin/env bash
# The combined local e2e run (e2e/combined, DESIGN.md): a throwaway server, its own database and a scripted runner on this
# machine; one PASS/FAIL line per scenario id. Never touches UAT, the live runner or production; no sudo, no docker.
# Usage: pnpm -C e2e combined [-- <playwright args, e.g. --grep '\[A9\]'>]   (--keep leaves the temp dir for diagnosis)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$here/.." && pwd)"
keep=0
args=()
for a in "$@"; do
  if [ "$a" = "--keep" ]; then keep=1; else args+=("$a"); fi
done

# --- preflight: every line must be ready, nothing is started before it
bad=0
ready() { echo "ready      $1"; }
notready() { echo "NOT READY  $1" >&2; bad=1; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_open 5433 && ready "postgres 127.0.0.1:5433" || notready "postgres 127.0.0.1:5433 (docker compose -f docker-compose.dev.yml up -d postgres)"
port_open 1025 && ready "smtp 127.0.0.1:1025" || notready "mailpit smtp 127.0.0.1:1025"
port_open 8025 && ready "mailpit 127.0.0.1:8025" || notready "mailpit web 127.0.0.1:8025"
if port_open 4601; then notready "port 4601 is in use: a normal e2e server runs; Mailpit is shared, so the combined run will not start next to it"; else ready "port 4601 free (no normal e2e run)"; fi
PORT="${AOM_E2E_PORT:-4602}"
if port_open "$PORT"; then notready "port $PORT is in use"; else ready "port $PORT free"; fi
command -v git >/dev/null && ready "git" || notready "git"
# [A11]: the runner-built DevOps box bridges its egress proxy with socat
command -v socat >/dev/null && ready "socat" || notready "socat (apt install socat)"
if bwrap --unshare-all --ro-bind / / true 2>/dev/null; then ready "bwrap probe (--unshare-all --ro-bind / / true)"; else notready "bwrap probe failed (a user-namespace restriction passes 'which' and fails here)"; fi
[ -f "$root/apps/server/dist/main.mjs" ] && [ -f "$root/apps/runner/dist/aom-runner.mjs" ] && [ -d "$root/apps/web/dist" ] && ready "build outputs present" || notready "build outputs missing (pnpm build)"
[ "$bad" = 0 ] || { echo "preflight failed: nothing was started" >&2; exit 2; }

# --- stale build: rebuild only when a source is newer than the server bundle
if [ -n "$(find "$root/apps/server/src" "$root/apps/runner/src" "$root/packages/shared/src" "$root/apps/web/src" -newer "$root/apps/server/dist/main.mjs" -type f -print -quit 2>/dev/null)" ]; then
  echo "sources are newer than the build: pnpm build"
  (cd "$root" && pnpm build >/dev/null)
fi

# --- isolation: everything lives in one temp dir; the guards in combined/support/guards.ts refuse anything else
tmp="$(mktemp -d /tmp/aom-combined.XXXXXX)"
# the one folder outside /tmp: the install box hides /tmp, so a toolchain (A1) and the real-sandbox lane (A7 lane 2) live
# in a home folder of their own. Created here, removed on exit (also after a failure), holds no credentials.
tools="$(mktemp -d "$HOME/.aom-combined-tools.XXXXXX")"
chmod 700 "$tools"
[ "$(stat -c %a "$tools")" = 700 ] || { echo "$tools is not mode 700" >&2; rm -rf "$tools"; exit 2; }
cleanup() {
  rc=$?
  rm -rf "$tools"
  # the runner hosts the specs started are detached process groups, recorded in pids.json (support/host.ts): stopped below
  pkill -f -- "$tmp" 2>/dev/null || true
  # the server a spec restarted (E7) is not the one the global teardown knows: stop whatever pids.json names last
  if [ -f "$tmp/pids.json" ]; then node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of [p.server,p.runner,...Object.values(p.runners||{})])if(k){try{process.kill(-k,"SIGTERM")}catch{}try{process.kill(k,"SIGTERM")}catch{}}}catch{}' "$tmp/pids.json"; fi
  if [ "$keep" = 1 ] || [ "$rc" != 0 ]; then echo "temp dir kept for diagnosis: $tmp (logs: $tmp/server.log, $tmp/runner-*/host.out.log)"; else rm -rf "$tmp" "${tmp}-results" "${tmp}-combined-summary.txt"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export AOM_E2E_DIR="$tmp"
export AOM_COMBINED_TOOLS="$tools"
export AOM_E2E_DB="aom_combined"
export AOM_E2E_PORT="$PORT"
export AOM_E2E_RESULTS="${tmp}-results"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
export pnpm_config_verify_deps_before_run=false
cd "$here"
npx playwright test -c combined/playwright.combined.config.ts "${args[@]+"${args[@]}"}"
