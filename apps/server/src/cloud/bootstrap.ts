import { shq } from '../installer/render.ts';

/**
 * A minisign verifier for the bootstrap (`node -e`, no dependency): `node -e "$VERIFY" <public key line> <manifest>
 * <minisig>` exits 0 only when the signature (`Ed` or pre-hashed `ED`) and the global signature over the trusted comment
 * verify with that key. Written without single quotes, because the script embeds it in a single-quoted shell string.
 */
export const BOOTSTRAP_VERIFY_JS = [
  'const c=require("node:crypto"),fs=require("node:fs");',
  'const [pub,mf,sf]=process.argv.slice(1);',
  'try{',
  'const k=Buffer.from(pub,"base64");if(k.length!==42||k.toString("latin1",0,2)!=="Ed")process.exit(2);',
  'const l=fs.readFileSync(sf,"utf8").split(/\\r?\\n/).filter(Boolean);',
  'const s=Buffer.from(l[1]||"","base64");if(s.length!==74)process.exit(3);',
  'const alg=s.toString("latin1",0,2);if(alg!=="Ed"&&alg!=="ED")process.exit(3);',
  'if(!s.subarray(2,10).equals(k.subarray(2,10)))process.exit(4);',
  'const key=c.createPublicKey({key:{kty:"OKP",crv:"Ed25519",x:k.subarray(10).toString("base64url")},format:"jwk"});',
  'const m=fs.readFileSync(mf);const d=alg==="ED"?c.createHash("blake2b512").update(m).digest():m;',
  'if(!c.verify(null,d,key,s.subarray(10)))process.exit(5);',
  'const t=(l[2]||"");if(!t.startsWith("trusted comment: "))process.exit(6);',
  'const g=Buffer.from(l[3]||"","base64");',
  'if(!c.verify(null,Buffer.concat([s.subarray(10),Buffer.from(t.slice(17),"utf8")]),key,g))process.exit(6);',
  '}catch{process.exit(7)}',
].join('');

/**
 * What a Codespace's `postStartCommand` runs (the generated devcontainer.json fetches it): installs the runner release
 * from this server, then starts `aom-runner up` in the background. `up` enrolls the codespace the first time (no pairing
 * code, no secret in the repository) and just connects on every later start. It contains no secret; the per-server
 * values are the public origin and the public key runner releases are signed with. Claude credentials come from the
 * user's own Codespaces secret `ANTHROPIC_API_KEY` (or a subscription token), which `up` stores on the codespace only.
 *
 * The release comes from the 1.10.0 paths (R18-U, R21): `manifest.json` and its `.minisig` are verified with the
 * server's trusted key, the tarball must match the signed sha256, and both files are kept beside the unpacked version
 * (`<root>/<version>/`), where the runner reads its signed-release proof for enrollment and `hello`. A server with no
 * signed release (a `dev` build, "Only signed runners" off) has no manifest: the legacy path is used as before.
 */
export function codespacesBootstrapScript(serverUrl: string, trustedKey: string | null = null): string {
  return `#!/usr/bin/env bash
# Guildwise HQ: starts the runner inside this Codespace. Safe to run on every start.
set -u -o pipefail
SERVER=\${GUILDWISE_SERVER:-${shq(serverUrl)}}
TRUSTED_KEY=${shq(trustedKey ?? '')}
VERIFY=${shq(BOOTSTRAP_VERIFY_JS)}
ROOT="\${HOME}/.aom-runner-install"
LOG="\${HOME}/.aom-runner-up.log"
say() { printf 'guildwise: %s\\n' "$*"; }
command -v node >/dev/null 2>&1 || { say "Node.js is missing; add the node dev container feature."; exit 1; }
command -v curl >/dev/null 2>&1 || { say "curl is missing."; exit 1; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
meta_dir="$(mktemp -d)"
code="$(curl -sSL --retry 3 -o "\${meta_dir}/manifest.json" -w '%{http_code}' "\${SERVER}/api/runner/releases/manifest.json")" || { say "cannot reach \${SERVER}"; exit 1; }
if [ "\${code}" = "200" ]; then
  # The signed release of 1.10.0: verified before anything is unpacked.
  sig="$(curl -sSL --retry 3 -o "\${meta_dir}/manifest.json.minisig" -w '%{http_code}' "\${SERVER}/api/runner/releases/manifest.json.minisig")" || sig=000
  if [ -n "\${TRUSTED_KEY}" ]; then
    [ "\${sig}" = "200" ] || { say "the runner release is not signed; not installing"; exit 1; }
    node -e "\${VERIFY}" "\${TRUSTED_KEY}" "\${meta_dir}/manifest.json" "\${meta_dir}/manifest.json.minisig" || { say "the runner release signature does not verify; not installing"; exit 1; }
  fi
  VERSION="$(json version <"\${meta_dir}/manifest.json")"; SHA="$(json sha256 <"\${meta_dir}/manifest.json")"
  URL="\${SERVER}/api/runner/releases/aom-runner-\${VERSION}.tgz"
elif [ "\${code}" = "404" ]; then
  # A server without a signed release (dev build): the release as before, checksum only.
  meta="$(curl -fsSL --retry 3 "\${SERVER}/api/runner/release")" || { say "this server offers no runner release"; exit 1; }
  VERSION="$(printf '%s' "\${meta}" | json version)"; SHA="$(printf '%s' "\${meta}" | json sha256)"
  URL="\${SERVER}/api/runner/release/aom-runner-\${VERSION}.tgz"
else
  say "cannot get the runner release from \${SERVER} (HTTP \${code})"; exit 1
fi
TARGET="\${ROOT}/\${VERSION}"
if [ ! -x "\${TARGET}/aom-runner/aom-runner" ] || [ "$(cat "\${TARGET}/.sha256" 2>/dev/null)" != "\${SHA}" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "\${tmp}/r.tgz" "\${URL}" || { say "download failed"; exit 1; }
  got="$(sha256sum "\${tmp}/r.tgz" | cut -d' ' -f1)"
  [ "\${got}" = "\${SHA}" ] || { say "checksum mismatch; not installing"; exit 1; }
  rm -rf "\${TARGET}"; mkdir -p "\${TARGET}"
  tar -xzf "\${tmp}/r.tgz" -C "\${TARGET}" && printf '%s' "\${SHA}" >"\${TARGET}/.sha256"
  rm -rf "\${tmp}"
fi
# The signed-release proof the runner sends when it enrolls and in every hello.
if [ "\${code}" = "200" ] && [ -s "\${meta_dir}/manifest.json.minisig" ]; then
  cp "\${meta_dir}/manifest.json" "\${meta_dir}/manifest.json.minisig" "\${TARGET}/"
fi
rm -rf "\${meta_dir}"
ln -sfn "\${TARGET}/aom-runner" "\${ROOT}/current"
mkdir -p "\${HOME}/.local/bin"
ln -sfn "\${ROOT}/current/aom-runner" "\${HOME}/.local/bin/aom-runner"
if pgrep -f 'aom-runner.* up' >/dev/null 2>&1; then say "the runner is already running"; exit 0; fi
export GUILDWISE_SERVER="\${SERVER}"
nohup "\${ROOT}/current/aom-runner" up --server "\${SERVER}" --name "Codespace \${CODESPACE_NAME:-workstation}" >>"\${LOG}" 2>&1 &
say "runner started (log: \${LOG})"
`;
}
