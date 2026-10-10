import { shq } from '../installer/render.ts';

/**
 * What a Codespace's `postStartCommand` runs (the generated devcontainer.json fetches it): installs the runner release
 * from this server (checksum verified), then starts `aom-runner up` in the background. `up` enrolls the codespace the
 * first time (no pairing code, no secret in the repository) and just connects on every later start. It contains no
 * secret; the only per-server value is the public origin. Claude credentials come from the user's own Codespaces
 * secret `ANTHROPIC_API_KEY` (or a subscription token), which `up` stores on the codespace and nowhere else.
 */
export function codespacesBootstrapScript(serverUrl: string): string {
  return `#!/usr/bin/env bash
# Guildwise HQ: starts the runner inside this Codespace. Safe to run on every start.
set -u -o pipefail
SERVER=\${GUILDWISE_SERVER:-${shq(serverUrl)}}
ROOT="\${HOME}/.aom-runner-install"
LOG="\${HOME}/.aom-runner-up.log"
say() { printf 'guildwise: %s\\n' "$*"; }
command -v node >/dev/null 2>&1 || { say "Node.js is missing; add the node dev container feature."; exit 1; }
command -v curl >/dev/null 2>&1 || { say "curl is missing."; exit 1; }
meta="$(curl -fsSL --retry 3 "\${SERVER}/api/runner/release")" || { say "cannot reach \${SERVER}"; exit 1; }
field() { printf '%s' "\${meta}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
VERSION="$(field version)"; SHA="$(field sha256)"
TARGET="\${ROOT}/\${VERSION}"
if [ ! -x "\${TARGET}/aom-runner/aom-runner" ] || [ "$(cat "\${TARGET}/.sha256" 2>/dev/null)" != "\${SHA}" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "\${tmp}/r.tgz" "\${SERVER}/api/runner/release/aom-runner-\${VERSION}.tgz" || { say "download failed"; exit 1; }
  got="$(sha256sum "\${tmp}/r.tgz" | cut -d' ' -f1)"
  [ "\${got}" = "\${SHA}" ] || { say "checksum mismatch; not installing"; exit 1; }
  rm -rf "\${TARGET}"; mkdir -p "\${TARGET}"
  tar -xzf "\${tmp}/r.tgz" -C "\${TARGET}" && printf '%s' "\${SHA}" >"\${TARGET}/.sha256"
  rm -rf "\${tmp}"
fi
ln -sfn "\${TARGET}/aom-runner" "\${ROOT}/current"
mkdir -p "\${HOME}/.local/bin"
ln -sfn "\${ROOT}/current/aom-runner" "\${HOME}/.local/bin/aom-runner"
if pgrep -f 'aom-runner.* up' >/dev/null 2>&1; then say "the runner is already running"; exit 0; fi
export GUILDWISE_SERVER="\${SERVER}"
nohup "\${ROOT}/current/aom-runner" up --server "\${SERVER}" --name "Codespace \${CODESPACE_NAME:-workstation}" >>"\${LOG}" 2>&1 &
say "runner started (log: \${LOG})"
`;
}
