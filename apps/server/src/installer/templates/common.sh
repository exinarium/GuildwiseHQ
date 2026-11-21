# ---------------------------------------------------------------------------------------------------------------------
# Shared helpers (screen output, progress reports, questions, downloads, the runner itself).
# Everything below runs as your own user. Administrator rights (sudo) are used to install system packages and, for the
# dedicated runner user, to run the root-owned tool guildwise-admin, copied from the verified runner release.
# ---------------------------------------------------------------------------------------------------------------------
# Everything this installer creates (the runner tree above all) is writable by its owner only: the runner's start-up check
# refuses a runner whose files another user can change, and a stock Ubuntu account has umask 0002 (UAT R25 F3). Only the
# group and other write bits are added: a stricter umask (077) stays as strict.
umask "$(printf '%04o' $(( 8#$(umask) | 8#022 )))"
STEP_N=0
STEP_TOTAL=0
WARNINGS=()
FAILED=0
SERVICE_MODE=""
# Where a runner installed for your own user lives (and where every runner before 1.10.0 lived).
H_RUNNER_ROOT="${HOME}/.local/share/guildwise/runner"
H_BIN_DIR="${HOME}/.local/bin"
H_DATA_DIR="${AOM_RUNNER_HOME:-${HOME}/.aom-runner}"
# Where the runner of this install lives: the paths above, or the same paths in the dedicated user's home.
RUNNER_ROOT="${H_RUNNER_ROOT}"
BIN_DIR="${H_BIN_DIR}"
DATA_DIR="${H_DATA_DIR}"
CHOOSE_FOLDERS="${GUILDWISE_CHOOSE_FOLDERS:-${EXPERT_MODE:-0}}"
export PATH="${BIN_DIR}:${PATH}"

# The account the runner runs as (R20): "dedicated" (the guildwise-runner system user) or "current" (you).
RUNNER_MODE=""
RUNNER_AS=""
RUNNER_NAME="$(id -un)"
RUNNER_HOME="${HOME}"
DEDICATED_USER="guildwise-runner"
# Root-owned, read-only tools (guildwise-admin, deploy-compose) and the pinned Node they run on. The runner can never
# change them; they change only when you run this installer again.
ADMIN_DIR="/usr/local/lib/guildwise"
ADMIN="${ADMIN_DIR}/guildwise-admin"
BUNDLED_NODE_BIN="${ADMIN_DIR}/node/bin"
ADMIN_TOOLS_READY=0
# The first signed runner release: an install below it, or one this installer did not verify, is an "older runner".
SIGNED_RUNNER_FLOOR="1.10.0"
LEGACY_RESULT=none
QUARANTINE_DIR=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_BOLD=''; C_DIM=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi

have() { command -v "$1" >/dev/null 2>&1; }

json_escape() {
  # Escapes backslashes, quotes and newlines; drops other control characters.
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN { ORS = "\\n" } { print }' | sed -e 's/\\n$//'
}

# report <step> <status: start|ok|warn|fail|info|done> [detail]: tells the Add a workstation page how far we are.
report() {
  [ -n "${SESSION_TOKEN}" ] || return 0
  have curl || return 0
  local detail="${3:-}"
  detail="${detail:0:400}"
  curl -fsS -m 6 -X POST -H 'content-type: application/json' \
    --data "{\"step\":\"$(json_escape "$1")\",\"status\":\"$2\",\"detail\":\"$(json_escape "${detail}")\"}" \
    "${SERVER_URL}/install/${SESSION_TOKEN}/progress" >/dev/null 2>&1 || true
}

say() { printf '%s\n' "$*"; }
note() { printf '    %s%s%s\n' "${C_DIM}" "$*" "${C_RESET}"; }
good() { printf '    %s[ok]%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '    %s[!]%s  %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; WARNINGS+=("$*"); }

step() {
  STEP_N=$((STEP_N + 1))
  CURRENT_STEP="$1"
  printf '\n%s[%d/%d] %s%s\n' "${C_BOLD}" "${STEP_N}" "${STEP_TOTAL}" "$1" "${C_RESET}"
  report "$1" start
}
step_ok() { good "$1"; report "${CURRENT_STEP}" ok "$1"; }
step_warn() { warn "$1"; report "${CURRENT_STEP}" warn "$1"; }

help_footer() {
  say ""
  say "  Help:        ${SERVER_URL}/help#install-troubleshooting"
  say "  Contact us:  ${SERVER_URL}/contact?from=installer"
}

# die <what went wrong> [what to do about it]
die() {
  FAILED=1
  printf '\n%s[x] %s%s\n' "${C_RED}" "$1" "${C_RESET}" >&2
  [ -n "${2:-}" ] && printf '    %s\n' "$2" >&2
  report "${CURRENT_STEP:-installer}" fail "$1"
  report "summary" "done" "failed: $1"
  printf '\n%s%s did not finish.%s Nothing is broken: run the same command again and it carries on where it stopped.\n' "${C_BOLD}" "${APP_NAME}" "${C_RESET}" >&2
  help_footer >&2
  exit 1
}

# ---- questions. Without a keyboard (or with GUILDWISE_YES=1) the default answer is used. ---------------------------------
interactive() { [ "${GUILDWISE_YES:-}" != 1 ] && [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; }

# ask_yn <question> <default y|n> [env override name]; returns 0 for yes
ask_yn() {
  local q="$1" def="$2" envname="${3:-}" ans=""
  if [ -n "${envname}" ] && [ -n "${!envname:-}" ]; then
    case "${!envname}" in 1|y|Y|yes|true) return 0 ;; *) return 1 ;; esac
  fi
  if ! interactive; then [ "${def}" = y ]; return; fi
  local hint="[y/N]"; [ "${def}" = y ] && hint="[Y/n]"
  read -r -p "    ${q} ${hint} " ans </dev/tty || ans=""
  [ -z "${ans}" ] && ans="${def}"
  case "${ans}" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# ask_text <question> <default> -> prints the answer
ask_text() {
  local q="$1" def="$2" ans=""
  if ! interactive; then printf '%s' "${def}"; return; fi
  read -r -p "    ${q} [${def}] " ans </dev/tty || ans=""
  printf '%s' "${ans:-${def}}"
}

ask_secret() {
  local q="$1" ans=""
  interactive || return 1
  read -r -s -p "    ${q} " ans </dev/tty || return 1
  printf '\n' >&2
  printf '%s' "${ans}"
}

# ---- flags (R20 "Non-interactive"). Each one also has a GUILDWISE_* variable. Nothing here comes from the server: the
# installer passes them on to guildwise-runner setup and guildwise-admin, which ask for anything not given. ----------------
OPT_YES="${GUILDWISE_YES:-0}"
OPT_RUNNER_USER="${GUILDWISE_RUNNER_USER:-}"
OPT_LEGACY="${GUILDWISE_LEGACY:-}"
OPT_LEGACY_ONLY=0
OPT_ACCEPT_ROOT_EQ="${GUILDWISE_ACCEPT_ROOT_EQUIVALENT:-0}"
OPT_DEVOPS_ORGS="${GUILDWISE_DEVOPS_ORGS:-}"
OPT_SUDO="${GUILDWISE_SUDO:-}"
OPT_SUDO_PW_STDIN=0
OPT_DOCKER="${GUILDWISE_DOCKER:-}"
OPT_APPROVE_APPS=()
read -r -a OPT_APPROVE_APPS <<<"${GUILDWISE_APPROVE_APPS:-}"
OPT_DEPLOY="${GUILDWISE_DEPLOY:-}"
OPT_DEPLOY_PIN_COMMIT="${GUILDWISE_DEPLOY_PIN_COMMIT:-0}"
OPT_ALLOW_UNSIGNED_FROM="${GUILDWISE_ALLOW_UNSIGNED_FROM:-}"
OPT_FROM_FILE="${GUILDWISE_FROM_FILE:-}"
# A private certificate authority (PEM) the runner service trusts besides the system ones, for a server with its own CA
# (Caddy `tls internal`, a company CA): Node's NODE_EXTRA_CA_CERTS. TLS checks stay on.
OPT_CA_FILE="${GUILDWISE_CA_FILE:-}"
RUNNER_CA=""
SUDO_PASSWORD=""

bad_flag() {
  die "$1" "Options: --yes, --runner-user dedicated|current, --legacy quarantine|remove, --accept-root-equivalent, --devops-orgs none|<id,...>, --sudo off|on, --sudo-password-stdin, --docker none|narrow|group, --approve-app <app>=<folder>, --deploy ask|off, --deploy-pin-commit, --allow-unsigned-from <origin>, --from-file <folder>, --ca-file <pem file>, --choose-folders."
}

set_flag() {
  case "$1" in
    --runner-user) OPT_RUNNER_USER="$2" ;;
    --legacy) OPT_LEGACY="$2" ;;
    --devops-orgs) OPT_DEVOPS_ORGS="$2" ;;
    --sudo) OPT_SUDO="$2" ;;
    --docker) OPT_DOCKER="$2" ;;
    --approve-app) OPT_APPROVE_APPS+=("$2") ;;
    --deploy) OPT_DEPLOY="$2" ;;
    --allow-unsigned-from) OPT_ALLOW_UNSIGNED_FROM="$2" ;;
    --from-file) OPT_FROM_FILE="$2" ;;
    --ca-file) OPT_CA_FILE="$2" ;;
    *) bad_flag "Unknown option: $1" ;;
  esac
}

is_uuid() { [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; }

parse_flags() {
  local a
  while [ "$#" -gt 0 ]; do
    a="$1"; shift
    case "${a}" in
      --yes|-y) OPT_YES=1 ;;
      --choose-folders) CHOOSE_FOLDERS=1 ;;
      --legacy-only) OPT_LEGACY_ONLY=1 ;;
      --accept-root-equivalent) OPT_ACCEPT_ROOT_EQ=1 ;;
      --deploy-pin-commit) OPT_DEPLOY_PIN_COMMIT=1 ;;
      --sudo-password-stdin) OPT_SUDO_PW_STDIN=1 ;;
      --runner-user|--legacy|--devops-orgs|--sudo|--docker|--approve-app|--deploy|--allow-unsigned-from|--from-file|--ca-file)
        [ "$#" -gt 0 ] || bad_flag "${a} needs a value."
        set_flag "${a}" "$1"; shift ;;
      --*=*) set_flag "${a%%=*}" "${a#*=}" ;;
      *) bad_flag "Unknown option: ${a}" ;;
    esac
  done
  validate_flags
}

validate_flags() {
  case "${OPT_YES}" in 1|y|yes|true) OPT_YES=1; export GUILDWISE_YES=1 ;; *) OPT_YES=0 ;; esac
  case "${OPT_ACCEPT_ROOT_EQ}" in 1|y|yes|true) OPT_ACCEPT_ROOT_EQ=1 ;; *) OPT_ACCEPT_ROOT_EQ=0 ;; esac
  case "${OPT_DEPLOY_PIN_COMMIT}" in 1|y|yes|true) OPT_DEPLOY_PIN_COMMIT=1 ;; *) OPT_DEPLOY_PIN_COMMIT=0 ;; esac
  case "${OPT_RUNNER_USER}" in ''|dedicated|current) ;; *) bad_flag "--runner-user is dedicated or current (got ${OPT_RUNNER_USER})." ;; esac
  case "${OPT_LEGACY}" in ''|quarantine|remove) ;; *) bad_flag "--legacy is quarantine or remove (got ${OPT_LEGACY})." ;; esac
  case "${OPT_SUDO}" in ''|on|off) ;; *) bad_flag "--sudo is on or off (got ${OPT_SUDO})." ;; esac
  case "${OPT_DOCKER}" in ''|none|narrow|group) ;; *) bad_flag "--docker is none, narrow or group (got ${OPT_DOCKER})." ;; esac
  case "${OPT_DEPLOY}" in ''|ask|off) ;; *) bad_flag "--deploy is ask or off (got ${OPT_DEPLOY})." ;; esac
  if [ "${OPT_DOCKER}" = group ] && [ "${OPT_ACCEPT_ROOT_EQ}" != 1 ]; then
    bad_flag "--docker group makes the runner root-equivalent: it needs --accept-root-equivalent as well."
  fi
  if [ "${#OPT_APPROVE_APPS[@]}" -gt 0 ] && [ -n "${OPT_DOCKER}" ] && [ "${OPT_DOCKER}" != narrow ]; then
    bad_flag "--approve-app needs --docker narrow."
  fi
  if [ -n "${OPT_DEVOPS_ORGS}" ] && [ "${OPT_DEVOPS_ORGS}" != none ]; then
    local id ids
    IFS=, read -r -a ids <<<"${OPT_DEVOPS_ORGS}"
    for id in "${ids[@]}"; do
      is_uuid "${id}" || bad_flag "--devops-orgs is none or organization ids separated by commas (got ${id})."
    done
  fi
  local app
  for app in "${OPT_APPROVE_APPS[@]+"${OPT_APPROVE_APPS[@]}"}"; do
    [[ "${app}" =~ ^[a-z0-9][a-z0-9-]{0,47}=/.+$ ]] || bad_flag "--approve-app is <app>=<absolute folder>, the app name in lowercase letters, digits and - (got ${app})."
  done
  if [ -n "${OPT_ALLOW_UNSIGNED_FROM}" ] && ! [[ "${OPT_ALLOW_UNSIGNED_FROM}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
    bad_flag "--allow-unsigned-from is an exact origin such as https://hq.example.com (got ${OPT_ALLOW_UNSIGNED_FROM})."
  fi
  if [ -n "${OPT_FROM_FILE}" ] && [ ! -f "${OPT_FROM_FILE}/manifest.json" ]; then
    bad_flag "--from-file is a folder holding manifest.json, manifest.json.minisig and the runner .tgz (no manifest.json in ${OPT_FROM_FILE})."
  fi
  if [ -n "${OPT_CA_FILE}" ]; then
    [ -f "${OPT_CA_FILE}" ] && [ -r "${OPT_CA_FILE}" ] || bad_flag "--ca-file is a readable PEM certificate file (cannot read ${OPT_CA_FILE})."
    grep -q -- '-----BEGIN CERTIFICATE-----' "${OPT_CA_FILE}" || bad_flag "--ca-file holds no PEM certificate (-----BEGIN CERTIFICATE-----): ${OPT_CA_FILE}."
  fi
  if [ "${OPT_SUDO_PW_STDIN}" = 1 ]; then
    IFS= read -r SUDO_PASSWORD || true
    [ -n "${SUDO_PASSWORD}" ] || bad_flag "--sudo-password-stdin was given, but no password came on standard input."
  fi
}

# ---- running things as root (guildwise-admin only) and as the runner's account -------------------------------------------
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif have sudo; then sudo "$@"
  else return 127; fi
}

runner_path() { printf '%s' "${RUNNER_HOME}/.local/bin:${BUNDLED_NODE_BIN}:/usr/local/bin:/usr/bin:/bin"; }

# as_runner <command...>: runs it as the runner's account (yourself in "current" mode), in its home, with its PATH.
# shellcheck disable=SC2016 # the inner sh expands $HOME and $@ itself
as_runner() {
  if [ -z "${RUNNER_AS}" ]; then
    if [ -n "${RUNNER_CA}" ]; then NODE_EXTRA_CA_CERTS="${RUNNER_CA}" "$@"; else "$@"; fi
    return
  fi
  if [ "$(id -u)" -eq 0 ] && have runuser; then
    runuser -u "${RUNNER_AS}" -- env HOME="${RUNNER_HOME}" PATH="$(runner_path)" ${RUNNER_CA:+NODE_EXTRA_CA_CERTS="${RUNNER_CA}"} sh -c 'cd "${HOME}" 2>/dev/null || cd /; exec "$@"' guildwise "$@"
  else
    sudo -u "${RUNNER_AS}" -H env HOME="${RUNNER_HOME}" PATH="$(runner_path)" ${RUNNER_CA:+NODE_EXTRA_CA_CERTS="${RUNNER_CA}"} sh -c 'cd "${HOME}" 2>/dev/null || cd /; exec "$@"' guildwise "$@"
  fi
}

# write_as_runner <file>: standard input into that file, owned by the runner's account.
# shellcheck disable=SC2016
write_as_runner() { as_runner sh -c 'cat >"$1.tmp" && mv -f "$1.tmp" "$1"' guildwise "$1"; }

# ---- the runner release ------------------------------------------------------------------------------------------------
sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}

# verify_minisig <public key line> <file> <signature file>: checks a minisign signature (Ed25519, plain or pre-hashed with
# BLAKE2b) and its signed trusted comment, with Node's own crypto. Prints the trusted comment.
verify_minisig() {
  have node || { printf 'node is needed to check the signature\n' >&2; return 2; }
  GW_PUB="$1" GW_FILE="$2" GW_SIG="$3" node -e '
const fs = require("fs"), crypto = require("crypto");
const fail = (m) => { process.stderr.write(m + "\n"); process.exit(1); };
const pk = Buffer.from(String(process.env.GW_PUB).trim(), "base64");
if (pk.length !== 42 || pk[0] !== 0x45 || pk[1] !== 0x64) fail("the release key is not a minisign public key");
const lines = fs.readFileSync(process.env.GW_SIG, "utf8").split(/\r?\n/);
if (!/^untrusted comment:/.test(lines[0] || "") || !/^trusted comment: /.test(lines[2] || "")) fail("not a minisign signature file");
const sig = Buffer.from(lines[1] || "", "base64");
if (sig.length !== 74) fail("not a minisign signature");
const alg = sig.subarray(0, 2).toString("latin1");
if (alg !== "Ed" && alg !== "ED") fail("unknown signature algorithm");
if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) fail("signed by another key than the one this server trusts");
const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10)]), format: "der", type: "spki" });
let msg = fs.readFileSync(process.env.GW_FILE);
if (alg === "ED") msg = crypto.createHash("blake2b512").update(msg).digest();
if (!crypto.verify(null, msg, key, sig.subarray(10))) fail("the signature does not match the file");
const comment = lines[2].slice("trusted comment: ".length);
const global = Buffer.from(lines[3] || "", "base64");
if (global.length !== 64 || !crypto.verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment, "utf8")]), key, global)) fail("the trusted comment was changed");
process.stdout.write(comment + "\n");'
}

# manifest_get <manifest.json> <version|floor|sha256|file|node:<platform>>: one checked value (fails on anything else).
manifest_get() {
  have node || return 2
  GW_FILE="$1" GW_FIELD="$2" node -e '
const fs = require("fs");
let m;
try { m = JSON.parse(fs.readFileSync(process.env.GW_FILE, "utf8")); } catch (e) { process.exit(1); }
const f = process.env.GW_FIELD, sha = /^[0-9a-f]{64}$/, ver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const ok = (v, re) => typeof v === "string" && re.test(v);
let out = null;
if (f === "version" || f === "floor") out = ok(m[f], ver) ? m[f] : null;
else if (f === "sha256") out = ok(m.sha256, sha) ? m.sha256 : null;
else if (f === "file") out = ok(m.file, /^aom-runner-[0-9A-Za-z.+-]+\.tgz$/) ? m.file : null;
else if (f.startsWith("node:")) {
  const r = (m.nodeRuntime || {})[f.slice(5)];
  out = r && ok(r.url, /^https:\/\/[^\s"]+$/) && ok(r.sha256, sha) ? r.url + " " + r.sha256 : null;
}
if (!out) process.exit(1);
process.stdout.write(out + "\n");'
}

# The version of the runner installed in RUNNER_ROOT (empty: none), from the folder `current` points at
# (<root>/<version>/aom-runner). The installed runner is never executed for this: an old one may not be trusted (R21).
existing_runner_version() {
  local target v
  target="$(as_runner readlink "${RUNNER_ROOT}/current" 2>/dev/null)" || return 0
  v="$(basename "$(dirname "${target}")")"
  [[ "${v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] && printf '%s' "${v}"
  return 0
}

# 0 when version $1 is newer than version $2 (plain dotted numbers, optional suffix after a dash).
version_newer() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

# The layout the runner updates itself in (docs/RUNNER.md "Updates"), the same for a fresh install and for an upgrade of a
# 0.1.0 install (which already has <root>/<version>/aom-runner and <root>/current):
#   <root>/<version>/aom-runner   one unpacked release each
#   <root>/current  -> <version>/aom-runner   what the service starts
#   <root>/previous -> <version>/aom-runner   what an automatic rollback goes back to
#   <root>/manifest.json(.minisig)            the verified release manifest and its signature (the signed-release proof)
# switch_current <new package dir>: points `current` at it, remembers the old one as `previous`, clears the self-update
# markers (this is a deliberate install, so an earlier rolled-back version may be tried again) and removes every other
# unpacked version and half-finished download.
switch_current() {
  local new="$1" old=""
  [ -L "${RUNNER_ROOT}/current" ] && old="$(readlink "${RUNNER_ROOT}/current" 2>/dev/null || true)"
  if [ -n "${old}" ] && [ "${old}" != "${new}" ] && [ -d "${old}" ]; then
    ln -sfn "${old}" "${RUNNER_ROOT}/previous"
  fi
  ln -sfn "${new}" "${RUNNER_ROOT}/current"
  rm -f "${RUNNER_ROOT}/update-pending" "${RUNNER_ROOT}/update-failed"
  rm -rf "${RUNNER_ROOT}"/.update-* 2>/dev/null || true
  local keep_prev="" d
  [ -L "${RUNNER_ROOT}/previous" ] && keep_prev="$(readlink "${RUNNER_ROOT}/previous" 2>/dev/null || true)"
  for d in "${RUNNER_ROOT}"/*/aom-runner; do
    [ -d "${d}" ] || continue
    [ "${d}" = "${new}" ] && continue
    [ "${d}" = "${keep_prev}" ] && continue
    rm -rf "$(dirname "${d}")"
  done
}

# Tells the runner how it is kept running, so a self-update knows how to restart it (systemd | launchd | background; the
# dedicated user's system service and LaunchDaemon restart the same way as the user ones, so they are systemd and launchd).
record_service_mode() {
  printf '%s\n' "$1" | write_as_runner "${RUNNER_ROOT}/service-mode" 2>/dev/null || true
}

# ---- an older runner (R21) -------------------------------------------------------------------------------------------
# Where runners before 1.10.0 (and 1.10.0 runners installed for your own user) keep their files.
legacy_paths() {
  local p
  for p in "${H_RUNNER_ROOT}" "${H_DATA_DIR}" "${HOME}/.config/aom-runner" "${H_BIN_DIR}/guildwise-runner" \
    "${H_BIN_DIR}/aom-runner" "${H_BIN_DIR}/aom" "${HOME}/.config/systemd/user/aom-runner.service" \
    "${HOME}/Library/LaunchAgents/com.guildwisehq.runner.plist"; do
    if [ "${p}" = "${H_DATA_DIR}" ] && [ "${p}" != "${HOME}/.aom-runner" ]; then
      # A custom AOM_RUNNER_HOME is only taken when it looks like runner data and does not hold your home folder.
      case "${HOME}/" in "${p%/}/"*) continue ;; esac
      if [ -e "${p}/config.json" ] || [ -d "${p}/pairings" ]; then printf '%s\n' "${p}"; fi
      continue
    fi
    if [ "${p}" = "${H_BIN_DIR}/aom" ]; then
      # ~/.local/bin/aom is only ours when it points into the runner.
      if [ -L "${p}" ]; then case "$(readlink "${p}")" in *guildwise/runner/*) printf '%s\n' "${p}" ;; esac; fi
      continue
    fi
    if [ -e "${p}" ] || [ -L "${p}" ]; then printf '%s\n' "${p}"; fi
  done
}

# The process ids of an old runner of this user that is still running (one per line).
legacy_pids() {
  have pgrep || return 0
  { pgrep -u "$(id -u)" -f "${H_RUNNER_ROOT}/" 2>/dev/null; pgrep -u "$(id -u)" -f 'aom-runner start' 2>/dev/null; } | grep -vx "$$" | sort -u
}

# 0 when the runner installed for your user is one this installer verified: 1.10.0 or newer, with a kept manifest and
# signature that verify with this server's key and match the installed version and tarball.
existing_install_trusted() {
  local root="${H_RUNNER_ROOT}" v mv msha
  [ -n "${RELEASE_PUBKEY}" ] || return 1
  [ -x "${root}/current/aom-runner" ] && [ -s "${root}/manifest.json" ] && [ -s "${root}/manifest.json.minisig" ] || return 1
  verify_minisig "${RELEASE_PUBKEY}" "${root}/manifest.json" "${root}/manifest.json.minisig" >/dev/null 2>&1 || return 1
  v="$(RUNNER_ROOT="${root}" existing_runner_version)"
  mv="$(manifest_get "${root}/manifest.json" version)" || return 1
  msha="$(manifest_get "${root}/manifest.json" sha256)" || return 1
  [ -n "${v}" ] && [ "${v}" = "${mv}" ] || return 1
  [ "$(cat "${root}/${v}/.sha256" 2>/dev/null)" = "${msha}" ] || return 1
  ! version_newer "${SIGNED_RUNNER_FLOOR}" "${v}"
}

# Stops the old runner (service first, then any process left). The installer never goes on while one still runs.
stop_legacy_runner() {
  stop_legacy_services
  local pids i
  pids="$(legacy_pids)"
  [ -n "${pids}" ] || return 0
  note "Stopping the old runner (process $(printf '%s' "${pids}" | tr '\n' ' ')) ..."
  # shellcheck disable=SC2086 # one process id per word
  kill ${pids} 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    pids="$(legacy_pids)"
    [ -n "${pids}" ] || return 0
    [ "${i}" = 10 ] || sleep 1
  done
  # shellcheck disable=SC2086
  kill -9 ${pids} 2>/dev/null || true
  sleep 1
  pids="$(legacy_pids)"
  [ -z "${pids}" ] || die "The old runner is still running (process $(printf '%s' "${pids}" | tr '\n' ' '))." "Stop it yourself (or restart the computer), then run the command again. The installer does not go on while it runs."
}

# write_quarantine_manifest <out file> <paths...>: every file and link with its size and sha256.
write_quarantine_manifest() {
  local out="$1" p f
  shift
  {
    printf '# Old %s runner files, quarantined %s by the installer from %s.\n' "${APP_NAME}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SERVER_URL}"
    printf '# Nothing in old-runner.tgz was read or reused. Columns: type, size in bytes, sha256, path.\n'
    for p in "$@"; do
      find "${p}" \( -type f -o -type l \) -print 2>/dev/null | while IFS= read -r f; do
        if [ -L "${f}" ]; then printf 'link\t-\t-\t%s -> %s\n' "${f}" "$(readlink "${f}")"
        else printf 'file\t%s\t%s\t%s\n' "$(wc -c <"${f}" 2>/dev/null | tr -d ' ')" "$(sha256_of "${f}" 2>/dev/null || echo '?')" "${f}"; fi
      done
    done
  } >"${out}"
}

# quarantine_paths <quarantine|remove> <paths...>: one tar under ~/.guildwise-quarantine/<UTC time>/ (folder 700, files
# 600, execute bits stripped) with a MANIFEST.txt, then the originals are removed. "remove" deletes them without a copy.
quarantine_paths() {
  local mode="$1" p
  shift
  for p in "$@"; do
    case "${p}" in ""|/|"${HOME}"|"${HOME}/") die "Refusing to move ${p:-an empty path} away as an old runner folder." "Check AOM_RUNNER_HOME, then run the command again." ;; esac
  done
  if [ "${mode}" = remove ]; then
    rm -rf -- "$@" || die "Could not remove the old runner files." "Remove them yourself: $*"
    good "Removed the old runner: $*"
    return
  fi
  local base="${HOME}/.guildwise-quarantine" dir rel=() tar_mode=()
  dir="${base}/$(date -u +%Y%m%dT%H%M%SZ)"
  (umask 077 && mkdir -p "${dir}") || die "Could not create ${dir}." "Free some disk space, then run the command again."
  chmod 700 "${base}" "${dir}"
  (umask 077 && write_quarantine_manifest "${dir}/MANIFEST.txt" "$@")
  for p in "$@"; do rel+=("${p#/}"); done
  # GNU tar strips the execute bits and the group/other bits inside the archive (bsdtar on macOS cannot; the archive and
  # its folder are still readable only by you).
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then tar_mode=(--mode='a-x,go-rwx'); fi
  (umask 077 && tar -C / -czf "${dir}/old-runner.tgz" ${tar_mode[@]+"${tar_mode[@]}"} -- "${rel[@]}") ||
    die "Could not pack the old runner into ${dir}." "Nothing was removed. Free some disk space, then run the command again."
  chmod 600 "${dir}/old-runner.tgz" "${dir}/MANIFEST.txt"
  rm -rf -- "$@" || die "The old runner was packed into ${dir}, but the originals could not be removed." "Remove them yourself: $*"
  QUARANTINE_DIR="${dir}"
  good "Old runner moved to ${dir} (old-runner.tgz and MANIFEST.txt, readable only by you)"
  note "Nothing from it is read or reused: no token, key, sealed sudo password, policy or clone. Delete the folder after you have looked at it."
}

# "Looking for an older runner": keeps it where the server does not require signed runners (the self-hosted default) and
# the user did not ask otherwise; stops and quarantines it where it is not a runner this installer verified and the server
# requires signed runners, or when --legacy quarantine|remove asks for it. Sets LEGACY_RESULT: none|kept|quarantined|removed.
handle_legacy() {
  local found=() p pids v what mode="${OPT_LEGACY}"
  while IFS= read -r p; do [ -n "${p}" ] && found+=("${p}"); done < <(legacy_paths)
  pids="$(legacy_pids)"
  if [ "${#found[@]}" -eq 0 ] && [ -z "${pids}" ]; then
    LEGACY_RESULT=none
    step_ok "No older runner on this computer"
    return
  fi
  v="$(existing_runner_version)"
  what="runner files"; [ -n "${v}" ] && what="runner ${v}"
  if [ -z "${mode}" ]; then
    if [ "${REQUIRE_SIGNED_RUNNERS}" != 1 ]; then
      LEGACY_RESULT=kept
      step_ok "Found an existing ${what}: keeping it and its settings (to replace it instead, run the installer with --legacy quarantine)"
      return
    fi
    if existing_install_trusted; then
      LEGACY_RESULT=kept
      step_ok "Found the signed runner ${v} this installer set up: keeping it (upgrading it if this server offers a newer one)"
      return
    fi
    mode=quarantine
    note "This server accepts only signed runners (${SIGNED_RUNNER_FLOOR} or newer, set up by this installer). The ${what} found here cannot be trusted, so it is stopped and replaced; nothing from it is reused."
  else
    note "You asked to ${mode} the ${what} found here."
  fi
  stop_legacy_runner
  [ "${#found[@]}" -gt 0 ] && quarantine_paths "${mode}" "${found[@]}"
  if [ "${mode}" = remove ]; then LEGACY_RESULT=removed; else LEGACY_RESULT=quarantined; fi
  warn "If sudo was granted to the old runner, change this user's password now: the old runner's sealed sudo password may be known."
  step_ok "The old runner is stopped and ${LEGACY_RESULT}"
}

# ---- the runner's account (R20) ------------------------------------------------------------------------------------------
root_equivalent_user() {
  { have sudo && sudo -n true 2>/dev/null; } || id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker
}

# Picks dedicated or current, without asking: --runner-user decides; otherwise a runner kept for your user stays yours (an
# upgrade changes nothing), and a new install gets the dedicated user. Inside the dedicated WSL distro (root) it is always
# the dedicated user.
choose_runner_user() {
  local mode="${OPT_RUNNER_USER}" kept_mine=0
  [ "${LEGACY_RESULT}" = kept ] && [ -n "$(existing_runner_version)" ] && kept_mine=1
  if [ "$(id -u)" -eq 0 ]; then
    [ "${mode}" = current ] && die "The runner cannot run as root." "Run the installer as your normal user, or use --runner-user dedicated."
    mode=dedicated
  elif [ -z "${mode}" ]; then
    if [ "${kept_mine}" = 1 ]; then mode=current; else mode=dedicated; fi
  fi
  if [ "${mode}" = dedicated ] && [ "${kept_mine}" = 1 ]; then
    die "A runner is already installed for your own user (${H_RUNNER_ROOT})." "Keep it: run the installer with --runner-user current. Move it to the dedicated user: sudo ${ADMIN} migrate-user. Replace it: run the installer with --legacy quarantine."
  fi
  if [ "${mode}" = dedicated ]; then
    dedicated_supported
    note "The runner gets its own user, ${DEDICATED_USER}: no sudo, not in the docker group, its own clones of your repositories. Your folders stay yours; its work reaches you through git."
  else
    note "The runner runs as you ($(id -un)). To give it its own user instead: sudo ${ADMIN} migrate-user (after this install)."
    if root_equivalent_user; then
      warn "Your user can become root without a password (sudo without a password, or the docker group). A 1.10.0 runner refuses to start as such a user unless you accept it in guildwise-runner setup; the safer choice is --runner-user dedicated."
    fi
  fi
  RUNNER_MODE="${mode}"
}

node_platform() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo linux-x64 ;;
    Linux-aarch64|Linux-arm64) echo linux-arm64 ;;
    Darwin-x86_64) echo darwin-x64 ;;
    Darwin-arm64) echo darwin-arm64 ;;
    *) return 1 ;;
  esac
}

# Copies the root-owned tools from the verified release into /usr/local/lib/guildwise (root:root, 0755): guildwise-admin,
# deploy-compose and the pinned Node build they run on (URL and sha256 from the signed manifest) [rv7-12]. Only from a
# signed release, or from an unsigned one when this server was allowed with --allow-unsigned-from (test machines).
install_admin_tools() {
  [ "${ADMIN_TOOLS_READY}" = 1 ] && return 0
  if [ "${STAGE_SIGNED}" != 1 ] && [ "${OPT_ALLOW_UNSIGNED_FROM}" != "${SERVER_URL}" ]; then
    die "The root-owned tool guildwise-admin is installed only from a signed runner release, and this server's release is not signed." "Use --runner-user current, or on a test machine allow this server with --allow-unsigned-from ${SERVER_URL}."
  fi
  as_root true || die "Administrator rights (sudo) are needed to install the root-owned tools in ${ADMIN_DIR}." "Ask an administrator, or use --runner-user current."
  local plat entry url sha f t ext src
  plat="$(node_platform)" || die "There is no Node runtime for $(uname -s) $(uname -m)." "Use --runner-user current."
  entry="$(manifest_get "${STAGE_MANIFEST}" "node:${plat}")" ||
    die "The runner release lists no Node runtime for ${plat}." "Ask your administrator to publish a release with one, or use --runner-user current."
  url="${entry% *}"; sha="${entry##* }"
  if [ "$(cat "${ADMIN_DIR}/node/.sha256" 2>/dev/null)" != "${sha}" ]; then
    f="${STAGE_DIR}/node-runtime"
    note "Downloading the Node runtime for the root-owned tools ..."
    curl -fsSL --retry 3 -o "${f}" "${url}" || die "Could not download the Node runtime (${url})." "Check this computer can reach it, then run the command again."
    [ "$(sha256_of "${f}")" = "${sha}" ] || die "The Node runtime did not match its checksum in the signed release manifest." "Try again; if it repeats, contact us."
    { as_root mkdir -p "${ADMIN_DIR}" && as_root chown 0:0 "${ADMIN_DIR}" && as_root chmod 755 "${ADMIN_DIR}" &&
      as_root rm -rf "${ADMIN_DIR}/node.new" && as_root mkdir "${ADMIN_DIR}/node.new" &&
      as_root tar -xf "${f}" -C "${ADMIN_DIR}/node.new" --strip-components=1 --no-same-owner &&
      as_root chown -R 0:0 "${ADMIN_DIR}/node.new" && as_root chmod -R go-w "${ADMIN_DIR}/node.new" &&
      printf '%s\n' "${sha}" | as_root tee "${ADMIN_DIR}/node.new/.sha256" >/dev/null &&
      as_root rm -rf "${ADMIN_DIR}/node.old" &&
      { ! as_root test -d "${ADMIN_DIR}/node" || as_root mv "${ADMIN_DIR}/node" "${ADMIN_DIR}/node.old"; } &&
      as_root mv "${ADMIN_DIR}/node.new" "${ADMIN_DIR}/node" && as_root rm -rf "${ADMIN_DIR}/node.old"; } ||
      die "Could not install the Node runtime into ${ADMIN_DIR}/node." "Run the command again."
  fi
  for t in guildwise-admin deploy-compose; do
    src=""
    for ext in mjs cjs js sh; do
      if [ -f "${STAGE_PKG}/aom-runner/admin/${t}.${ext}" ]; then src="${STAGE_PKG}/aom-runner/admin/${t}.${ext}"; break; fi
    done
    if [ -z "${src}" ]; then
      [ "${t}" = guildwise-admin ] && die "The runner release has no ${t}." "Ask your administrator to publish a complete ${SIGNED_RUNNER_FLOOR} (or newer) release."
      # Only the narrow Docker access for deploys needs it; guildwise-admin refuses that choice while it is missing.
      warn "The runner release has no ${t}: the narrow Docker access for deploys is not available with this release."
      continue
    fi
    as_root install -o 0 -g 0 -m 0755 "${src}" "${ADMIN_DIR}/${t}" || die "Could not install ${ADMIN_DIR}/${t}." "Run the command again."
  done
  ADMIN_TOOLS_READY=1
  good "Root-owned tools installed in ${ADMIN_DIR} (guildwise-admin, its helpers and their Node), from the verified release"
}

# The "Runner user" step: in dedicated mode guildwise-admin creates the user with its home and workspace (its service is
# written later, by `guildwise-admin service install`, once the runner is in place).
setup_runner_user() {
  if [ "${RUNNER_MODE}" = current ]; then
    step_ok "The runner runs as you ($(id -un))"
    return
  fi
  install_admin_tools
  local home
  as_root "${ADMIN}" user create || die "guildwise-admin could not set up the ${DEDICATED_USER} user." "Run: sudo ${ADMIN} user create   to see why, then run the command again."
  home="$(user_home "${DEDICATED_USER}")"
  case "${home}" in ""|/) die "The ${DEDICATED_USER} user has no home folder." "Run: sudo ${ADMIN} user create" ;; esac
  RUNNER_AS="${DEDICATED_USER}"
  RUNNER_NAME="${DEDICATED_USER}"
  RUNNER_HOME="${home}"
  RUNNER_ROOT="${home}/.local/share/guildwise/runner"
  BIN_DIR="${home}/.local/bin"
  DATA_DIR="${home}/.aom-runner"
  step_ok "Runner user ${DEDICATED_USER} is ready (home ${home})"
}

# ---- download and verify (R18-U, R21): the 1.10.0 release paths, signature before anything is unpacked ------------------
STAGE_DIR=""
STAGE_PKG=""
STAGE_TGZ=""
STAGE_MANIFEST=""
STAGE_SIG=""
STAGE_VERSION=""
STAGE_SHA=""
STAGE_SIGNED=0

release_url() { printf '%s/api/runner/releases/%s' "${SERVER_URL}" "$1"; }

# Fetches manifest.json and manifest.json.minisig, verifies the signature with this server's release key, then downloads
# the tarball, checks its sha256 against the manifest and unpacks it into a private staging folder. A server that requires
# signed runners gets a signed release or nothing. With "Only signed runners" off an unsigned release is accepted (checked
# by its sha256 from the manifest). Only the 1.10.0 paths (/api/runner/releases/...) are used, never the old download
# path, which answers 410 where signed runners are required.
stage_runner_release() {
  STAGE_DIR="$(mktemp -d)"
  STAGE_MANIFEST="${STAGE_DIR}/manifest.json"
  STAGE_SIG="${STAGE_DIR}/manifest.json.minisig"
  local m="${STAGE_MANIFEST}" s="${STAGE_SIG}" tgz_url file tc got
  if [ -n "${OPT_FROM_FILE}" ]; then
    note "Using the release files in ${OPT_FROM_FILE} (offline install)."
    cp "${OPT_FROM_FILE}/manifest.json" "${m}" || die "Could not read ${OPT_FROM_FILE}/manifest.json."
    [ -f "${OPT_FROM_FILE}/manifest.json.minisig" ] && { cp "${OPT_FROM_FILE}/manifest.json.minisig" "${s}" || die "Could not read the signature in ${OPT_FROM_FILE}."; }
  else
    note "Fetching the runner release manifest from ${SERVER_URL} ..."
    if ! curl -fsSL --retry 3 -o "${m}" "$(release_url manifest.json)"; then
      rm -f "${m}"
      if [ "${REQUIRE_SIGNED_RUNNERS}" = 1 ]; then
        die "This server requires signed runners but offers no runner release manifest." "Ask your administrator to publish a signed runner release, then create a new install command."
      fi
      die "This ${APP_NAME} server offers no ${SIGNED_RUNNER_FLOOR} runner release (no release manifest)." "Ask your administrator to publish the runner release, then create a new install command."
    elif ! curl -fsSL --retry 3 -o "${s}" "$(release_url manifest.json.minisig)"; then
      rm -f "${s}"
    fi
  fi
  if [ -s "${s}" ] && [ -z "${RELEASE_PUBKEY}" ]; then
    [ "${REQUIRE_SIGNED_RUNNERS}" = 1 ] && die "This server requires signed runners but names no key to check them with." "Ask your administrator to set the runner release key, then create a new install command."
    warn "The runner release is signed, but this server names no key to check the signature with; it is checked by its checksum only."
    rm -f "${s}"
  fi
  if [ -s "${s}" ]; then
    tc="$(verify_minisig "${RELEASE_PUBKEY}" "${m}" "${s}" 2>"${STAGE_DIR}/verify.err")" ||
      die "The runner release signature did not verify: $(head -n1 "${STAGE_DIR}/verify.err")." "Do not install it. Tell your administrator: the release may have been changed."
    STAGE_SIGNED=1
    good "Release signature verified (\"${tc}\")"
  elif [ "${REQUIRE_SIGNED_RUNNERS}" = 1 ]; then
    die "This server requires signed runners, but its runner release is not signed." "Ask your administrator to sign the runner release, then create a new install command."
  else
    warn "This server's runner release is not signed. That is accepted because \"Only signed runners\" is off here; the download is checked by its checksum only."
  fi
  STAGE_VERSION="$(manifest_get "${m}" version)" || die "The runner release manifest is not valid (no version)." "Tell your administrator."
  STAGE_SHA="$(manifest_get "${m}" sha256)" || die "The runner release manifest is not valid (no sha256)." "Tell your administrator."
  file="$(manifest_get "${m}" file)" || die "The runner release manifest is not valid (no file)." "Tell your administrator."
  [ "${file}" = "aom-runner-${STAGE_VERSION}.tgz" ] || die "The runner release manifest names an unexpected file (${file})." "Tell your administrator."
  if [ -n "${RELEASE_VERSION}" ] && [ "${RELEASE_VERSION}" != "${STAGE_VERSION}" ]; then
    note "This server now offers runner ${STAGE_VERSION} (the command was made for ${RELEASE_VERSION})."
  fi
  tgz_url="$(release_url "${file}")"
  STAGE_TGZ="${STAGE_DIR}/${file}"
  if [ -n "${OPT_FROM_FILE}" ]; then
    cp "${OPT_FROM_FILE}/${file}" "${STAGE_TGZ}" || die "${OPT_FROM_FILE} has no ${file}." "Put the runner .tgz next to manifest.json, then run the command again."
  else
    note "Downloading runner ${STAGE_VERSION} from ${SERVER_URL} ..."
    curl -fsSL --retry 3 -o "${STAGE_TGZ}" "${tgz_url}" ||
      die "Could not download the runner from ${SERVER_URL}." "Check that this computer can reach ${SERVER_URL} in a browser, then run the command again."
  fi
  got="$(sha256_of "${STAGE_TGZ}")" || die "No sha256sum or shasum found to check the download." "Install coreutils, then run the command again."
  [ "${got}" = "${STAGE_SHA}" ] ||
    die "The downloaded runner did not match its checksum (expected ${STAGE_SHA:0:12}..., got ${got:0:12}...)." "The download was damaged or changed on the way. Try again; if it repeats, contact us."
  good "Checksum verified (${STAGE_SHA:0:12}...)"
  STAGE_PKG="${STAGE_DIR}/pkg"
  mkdir -p "${STAGE_PKG}"
  tar -xzf "${STAGE_TGZ}" -C "${STAGE_PKG}" || die "The runner archive could not be unpacked." "Run the command again."
  if [ "${STAGE_SIGNED}" = 1 ]; then step_ok "Runner ${STAGE_VERSION} downloaded and verified (signature and checksum)"
  else step_ok "Runner ${STAGE_VERSION} downloaded (checksum verified)"; fi
}

link_runner_commands() {
  as_runner mkdir -p "${BIN_DIR}"
  as_runner ln -sfn "${RUNNER_ROOT}/current/aom-runner" "${BIN_DIR}/aom-runner"
  # `guildwise-runner` is the name people type; `aom-runner` stays as an alias (the launcher resolves symlinks)
  as_runner ln -sfn "${RUNNER_ROOT}/current/aom-runner" "${BIN_DIR}/guildwise-runner"
  as_runner ln -sfn "${RUNNER_ROOT}/current/dist/aom.mjs" "${BIN_DIR}/aom" 2>/dev/null || true
}

# The signed-release proof the runner sends at pairing and in hello: the verified manifest and its signature, kept in the
# runner root. An unsigned release leaves none (an old proof would not match it).
keep_release_proof() {
  if [ "${STAGE_SIGNED}" = 1 ]; then
    if ! { write_as_runner "${RUNNER_ROOT}/manifest.json" <"${STAGE_MANIFEST}" &&
      write_as_runner "${RUNNER_ROOT}/manifest.json.minisig" <"${STAGE_SIG}" &&
      as_runner chmod 644 "${RUNNER_ROOT}/manifest.json" "${RUNNER_ROOT}/manifest.json.minisig"; }; then
      die "Could not keep the release signature in ${RUNNER_ROOT}." "Run the command again."
    fi
  else
    as_runner rm -f "${RUNNER_ROOT}/manifest.json" "${RUNNER_ROOT}/manifest.json.minisig"
  fi
}

# "Installing the runner": unpacks the verified release into the runner's own root (a kept runner is upgraded in place).
place_runner_release() {
  local before target
  before="$(existing_runner_version)"
  if [ -n "${before}" ]; then
    note "A runner ${before} is already installed here: keeping it and its settings (upgrading only if this server offers a newer one)."
    report "Runner" info "existing runner ${before}"
    if version_newer "${before}" "${STAGE_VERSION}"; then
      step_ok "The installed runner ${before} is newer than this server's ${STAGE_VERSION}: kept as it is"
      install_runner_ca
      repair_runner_tree
      link_runner_commands
      return
    fi
  fi
  target="${RUNNER_ROOT}/${STAGE_VERSION}"
  if as_runner test -x "${target}/aom-runner/aom-runner" && [ "$(as_runner cat "${target}/.sha256" 2>/dev/null)" = "${STAGE_SHA}" ]; then
    step_ok "Runner ${STAGE_VERSION} is already installed here and unchanged"
  else
    as_runner rm -rf "${target}"
    as_runner mkdir -p "${target}" || die "Could not create ${target}." "Run the command again."
    as_runner tar -xzf - -C "${target}" <"${STAGE_TGZ}" || die "The runner archive could not be unpacked." "Run the command again."
    printf '%s' "${STAGE_SHA}" | write_as_runner "${target}/.sha256"
    if [ -n "${before}" ] && [ "${before}" != "${STAGE_VERSION}" ]; then step_ok "Runner upgraded from ${before} to ${STAGE_VERSION}"
    else step_ok "Runner ${STAGE_VERSION} installed"; fi
  fi
  keep_release_proof
  install_runner_ca
  repair_runner_tree
  as_runner env RUNNER_ROOT="${RUNNER_ROOT}" bash -c "$(declare -f switch_current); switch_current \"\$1\"" guildwise "${target}/aom-runner" ||
    die "Could not switch to runner ${STAGE_VERSION}." "Run the command again."
  link_runner_commands
}

runner() { as_runner "${RUNNER_ROOT}/current/aom-runner" "$@"; }

# A tree made by an earlier installer under umask 0002 is repaired: no group or other write anywhere in it (UAT R25 F3).
repair_runner_tree() {
  as_runner chmod -R go-w "${RUNNER_ROOT}" ||
    die "Could not remove group and other write access from ${RUNNER_ROOT}." "Run: chmod -R go-w ${RUNNER_ROOT}   then run the command again."
}

# --ca-file: a copy in the runner root, readable by the runner (pairing and the service use it as NODE_EXTRA_CA_CERTS; the
# dedicated user's system service gets a root-owned copy from guildwise-admin). A re-run without the flag keeps a copy
# installed before.
install_runner_ca() {
  local dest="${RUNNER_ROOT}/ca.pem"
  if [ -n "${OPT_CA_FILE}" ]; then
    { write_as_runner "${dest}" <"${OPT_CA_FILE}" && as_runner chmod 644 "${dest}"; } ||
      die "Could not copy ${OPT_CA_FILE} to ${dest}." "Run the command again."
    good "The runner trusts the certificate authority in ${OPT_CA_FILE} (copied to ${dest})"
  fi
  if as_runner test -f "${dest}"; then RUNNER_CA="${dest}"; fi
}

is_paired() {
  as_runner grep -q '"runnerToken"' "${DATA_DIR}/config.json" 2>/dev/null
}

# The server a config.json is paired with (empty when unreadable).
paired_server() {
  as_runner sed -n 's/.*"serverUrl": *"\([^"]*\)".*/\1/p' "${DATA_DIR}/config.json" 2>/dev/null | head -n1
}

# Pairs this computer's runner with the workstation the one-time code belongs to. A runner that is already paired
# (to this server or another organization's) is kept: the code adds the new workstation instead of failing or
# installing a second runner. Running the same command twice is fine: a used code is reported, not treated as an error.
pair_runner() {
  local name="${GUILDWISE_NAME:-${DEFAULT_NAME}}"
  [ -n "${name}" ] || name="$(hostname 2>/dev/null || echo 'My workstation')"
  local already=0
  if is_paired; then
    already=1
    note "This computer's runner is already paired with $(paired_server). Keeping it and pairing it with this workstation as well."
  fi
  local mock=()
  [ "${GUILDWISE_MOCK:-}" = 1 ] && mock=(--mock)
  local out
  if out="$(runner pair --server "${SERVER_URL}" --code "${PAIRING_CODE}" --name "${name}" ${mock[@]+"${mock[@]}"} 2>&1)"; then
    step_ok "Paired as \"${name}\""
    report "Paired" ok "${name}"
  else
    case "${out}" in
      *signed_runner_required*)
        die "This server accepts only signed runners and refused this one." "Create a new install command on the Add a workstation page and run it; if it repeats, tell your administrator." ;;
      *401*|*invalid*|*expired*)
        if [ "${already}" = 1 ]; then
          # The same command was run again: its single-use code is spent, and the pairing it made is still in place.
          step_ok "The one-time pairing code was already used; keeping the existing pairing"
          report "Pairing" info "code already used; kept existing pairing"
          return
        fi
        die "The one-time pairing code was refused (it is single-use and expires after 30 minutes)." "Go back to the Add a workstation page, choose your system again and copy the new command." ;;
      *) die "Pairing failed: ${out}" "Check that this computer can reach ${SERVER_URL}, then run the command again." ;;
    esac
  fi
}

# Simple mode (the default) does not ask where your code lives: it is ~/src. Expert mode (turned on in your Settings),
# GUILDWISE_CHOOSE_FOLDERS=1 or the --choose-folders flag lets you pick the folders. The dedicated user works only in its
# own clones under its home [rv6-3]: your folders are never made writable for it.
add_repo_folders() {
  if [ -n "${RUNNER_AS}" ]; then
    local own="${RUNNER_HOME}/src"
    [ -n "${GUILDWISE_REPO_DIRS:-}" ] && warn "GUILDWISE_REPO_DIRS is ignored for the dedicated user: it works only in its own clones (${own})."
    as_runner mkdir -p "${own}"
    if runner repos add "${own}" >/dev/null 2>&1; then good "The runner clones your repositories into ${own}; you get its work through git (it pushes branches to your remote)"
    else step_warn "Could not register ${own}. Add it later as ${RUNNER_NAME}: guildwise-runner repos add ${own}"; fi
    report "Code folders" ok "${own}"
    return
  fi
  local dirs="${GUILDWISE_REPO_DIRS:-}"
  if [ -z "${dirs}" ]; then
    if [ "${CHOOSE_FOLDERS:-0}" = 1 ]; then
      note "The runner looks for your git projects in these folders. Most people keep them in ~/src."
      dirs="$(ask_text "Folder(s) with your code (separate several with spaces)" "${HOME}/src")"
    else
      dirs="${HOME}/src"
      note "Your projects will live in ${dirs}."
      mkdir -p "${dirs}" 2>/dev/null || true
    fi
  fi
  local d added=0
  for d in ${dirs}; do
    d="${d/#\~/${HOME}}"
    if [ ! -d "${d}" ]; then
      if ask_yn "${d} does not exist yet. Create it?" y GUILDWISE_CREATE_REPO_DIRS; then mkdir -p "${d}"; else warn "Skipped ${d}"; continue; fi
    fi
    runner repos add "${d}" >/dev/null 2>&1 && { good "Watching ${d} for git projects"; added=$((added + 1)); }
  done
  [ "${added}" -gt 0 ] || step_warn "No code folder added yet. Add one later with: guildwise-runner repos add ~/src"
  report "Code folders" ok "${dirs}"
}

# Claude Code for the dedicated user, with the root-owned Node (its own copy under its home; yours is not shared).
install_claude_for_runner() {
  if as_runner sh -c 'command -v claude' >/dev/null 2>&1; then step_ok "Claude Code is already installed for ${RUNNER_NAME}"; return; fi
  if [ "${GUILDWISE_SKIP_CLAUDE_INSTALL:-}" = 1 ]; then step_warn "Skipped installing Claude Code (GUILDWISE_SKIP_CLAUDE_INSTALL=1)"; return; fi
  note "Installing Claude Code for ${RUNNER_NAME} ..."
  as_runner npm install -g --prefix "${RUNNER_HOME}/.local" @anthropic-ai/claude-code >/dev/null 2>&1 ||
    die "Could not install Claude Code for ${RUNNER_NAME}." "Run the command again; if it repeats, contact us."
  step_ok "Claude Code installed for ${RUNNER_NAME}"
}

# ---- Claude sign-in ------------------------------------------------------------------------------------------------------
claude_signed_in() {
  [ -s "${HOME}/.claude/.credentials.json" ] && return 0
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && return 0
  [ -f "${DATA_DIR}/config.json" ] && grep -Eq '"(oauthToken|apiKey)"' "${DATA_DIR}/config.json" 2>/dev/null
}

save_api_key() {
  local key="$1"
  have node || return 1
  AOM_CFG="${DATA_DIR}/config.json" AOM_KEY="${key}" node -e '
    const fs = require("fs");
    const p = process.env.AOM_CFG;
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.runtimes = c.runtimes || {};
    c.runtimes["claude-code"] = Object.assign({}, c.runtimes["claude-code"], { authMode: "api_key", apiKey: process.env.AOM_KEY });
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  '
}

sign_in_to_claude() {
  if [ -n "${RUNNER_AS}" ]; then
    step_ok "Claude is signed in as ${RUNNER_NAME} in the next step (guildwise-runner setup); your own sign-in is not shared"
    return
  fi
  if [ "${GUILDWISE_SKIP_CLAUDE:-}" = 1 ]; then
    step_warn "Skipped the Claude sign-in (GUILDWISE_SKIP_CLAUDE=1). Agents cannot run until you sign in."
    return
  fi
  if claude_signed_in; then
    step_ok "Claude is already signed in on this computer"
    return
  fi
  if ! have claude; then
    step_warn "Claude Code is not installed, so there is nothing to sign in to yet."
    return
  fi
  say ""
  say "    Your agents run on Claude, so this computer must be allowed to use it. There are two ways:"
  say ""
  say "      1) Claude subscription (Pro, Max, Team or Enterprise). You sign in with your Claude account in a browser,"
  say "         and the agents' work counts against your plan's usage. No per-use bill. Best for most people."
  say "      2) Anthropic API key. You pay for exactly what the agents use, billed to the key's account."
  say "         Best if your company gives you a key instead of a subscription."
  say ""
  if ! interactive; then
    step_warn "No keyboard to ask on. Sign in later: run \`claude\` and follow the prompts (or see the Add a workstation page)."
    return
  fi
  local choice
  choice="$(ask_text "Which one? Type 1, 2, or s to do this later" "1")"
  case "${choice}" in
    2)
      local key
      key="$(ask_secret "Paste the API key (it is stored only on this computer, readable only by you):")" || key=""
      if [ -n "${key}" ] && save_api_key "${key}"; then step_ok "API key saved to ${DATA_DIR}/config.json (mode 600)"
      else step_warn "No key saved. Add one later with \`guildwise-runner\` config (authMode api_key) or run \`claude\` to sign in."; fi
      ;;
    s|S) step_warn "Sign-in skipped. Run \`claude\` any time to sign in; \`guildwise-runner doctor\` shows the state." ;;
    *)
      say "    Claude will open now. Choose \"Claude account with subscription\", finish in the browser,"
      say "    then type /exit to come back here."
      claude </dev/tty || true
      if claude_signed_in; then step_ok "Signed in to Claude"; else step_warn "Could not confirm the sign-in. Run \`claude\` again later."; fi
      ;;
  esac
}

# ---- setting local permissions (R20) -------------------------------------------------------------------------------------
# One value of the policy.json that guildwise-runner setup just wrote (docker: none|narrow|group; sudo: true|false).
policy_value() {
  as_runner cat "${RUNNER_HOME}/.config/aom-runner/policy.json" 2>/dev/null | GW_FIELD="$1" node -e '
let t = "";
process.stdin.on("data", (d) => { t += d; }).on("end", () => {
  let p;
  try { p = JSON.parse(t); } catch (e) { process.exit(1); }
  const v = process.env.GW_FIELD === "sudo" ? String(!!(p.devops && p.devops.sudo === true)) : (p.docker === undefined ? "none" : p.docker);
  if (!["none", "narrow", "group", "true", "false"].includes(v)) process.exit(1);
  process.stdout.write(v);
});'
}

# The root parts of the answers, done by guildwise-admin (root-owned, from the verified release). Setup has written them
# to policy.json on this machine; the values are checked against a fixed list before anything runs.
apply_root_choices() {
  local docker sudo_on app name folder
  docker="$(policy_value docker)" || docker=none
  sudo_on="$(policy_value sudo)" || sudo_on=false
  case "${docker}" in
    narrow|group)
      local acc=()
      if [ "${docker}" = group ]; then
        # Only a yes given here (the flag, or typed in setup at this keyboard) counts: policy.json alone cannot buy it.
        [ "${OPT_ACCEPT_ROOT_EQ}" = 1 ] || interactive ||
          die "policy.json asks for the docker group, but root-equivalence was not accepted here." "Run the installer with --docker group --accept-root-equivalent, or run guildwise-runner setup on this computer."
        acc=(--accept-root-equivalent)
      fi
      install_admin_tools
      as_root "${ADMIN}" docker "${docker}" --user "${RUNNER_NAME}" ${acc[@]+"${acc[@]}"} ||
        die "guildwise-admin could not set up Docker access for deploys (${docker})." "Run: sudo ${ADMIN} docker ${docker} --user ${RUNNER_NAME}   to see why."
      good "Docker access for deploys: ${docker}" ;;
    *)
      if [ "${RUNNER_MODE}" = dedicated ] && as_root test -e /etc/sudoers.d/guildwise-runner-docker; then
        as_root "${ADMIN}" docker none --user "${RUNNER_NAME}" || die "guildwise-admin could not remove the Docker rule." "Run: sudo ${ADMIN} docker none --user ${RUNNER_NAME}"
        good "Docker access for deploys: none (the earlier rule was removed)"
      fi ;;
  esac
  if [ "${RUNNER_MODE}" = dedicated ]; then
    if [ "${sudo_on}" = true ]; then
      [ "${OPT_SUDO}" = on ] || interactive ||
        die "policy.json asks for sudo, but it was not turned on here." "Run the installer with --sudo on, or run guildwise-runner setup on this computer."
      as_root "${ADMIN}" sudo on --user "${RUNNER_NAME}" || die "guildwise-admin could not turn sudo on for ${RUNNER_NAME}." "Run: sudo ${ADMIN} sudo on --user ${RUNNER_NAME}"
      good "Sudo is on for ${RUNNER_NAME} (password required; every privileged step still needs your local yes)"
    elif as_root test -e /etc/sudoers.d/guildwise-runner; then
      as_root "${ADMIN}" sudo off --user "${RUNNER_NAME}" || die "guildwise-admin could not turn sudo off for ${RUNNER_NAME}." "Run: sudo ${ADMIN} sudo off --user ${RUNNER_NAME}"
      good "Sudo is off for ${RUNNER_NAME}"
    fi
  fi
  for app in "${OPT_APPROVE_APPS[@]+"${OPT_APPROVE_APPS[@]}"}"; do
    name="${app%%=*}"
    folder="${app#*=}"
    install_admin_tools
    as_root "${ADMIN}" approve-app "${name}" --source "${folder}" --user "${RUNNER_NAME}" --yes ||
      die "The app ${name} did not pass the Docker helper's checks (the reason is above; its folder must be inside ${RUNNER_HOME})." "Fix its compose setup, or leave out --approve-app ${name}, then run the command again."
    good "App ${name} approved for deploys (${folder})"
  done
}

setup_supported() { runner setup --help >/dev/null 2>&1; }

# "Setting local permissions": guildwise-runner setup (as the runner's account) asks for and writes the policy; the
# root parts then go through guildwise-admin. The installer itself passes on only the flags you gave it.
set_local_permissions() {
  if ! setup_supported; then
    step_warn "This runner version has no guildwise-runner setup; local permissions stay as they are."
    return
  fi
  local explicit=0 args rc=0
  if [ -n "${OPT_DEVOPS_ORGS}${OPT_SUDO}${OPT_DOCKER}${OPT_DEPLOY}${OPT_ALLOW_UNSIGNED_FROM}" ] || [ "${OPT_ACCEPT_ROOT_EQ}" = 1 ] ||
    [ "${OPT_DEPLOY_PIN_COMMIT}" = 1 ] || [ "${#OPT_APPROVE_APPS[@]}" -gt 0 ] || [ -n "${SUDO_PASSWORD}" ]; then explicit=1; fi
  # An upgrade of a runner kept for your user, with no keyboard and no flags: nothing is decided for you. The runner keeps
  # working (sandboxed work runs; steps outside the sandbox wait for setup).
  if [ "${RUNNER_MODE}" = current ] && [ "${LEGACY_RESULT}" = kept ] && [ "${OPT_YES}" != 1 ] && [ "${explicit}" = 0 ] && ! interactive; then
    step_warn "Local permissions not changed (no keyboard to ask on). Run \`guildwise-runner setup\` on this computer; until then DevOps, deploys and other steps outside the sandbox wait, and sandboxed work keeps running."
    return
  fi
  # The dedicated runner from an earlier install must not run while setup writes policy.json and the root choices are
  # read from it (install_service starts it again).
  [ -n "${RUNNER_AS}" ] && stop_dedicated_service
  args=(setup --runner-user "${RUNNER_MODE}")
  if [ "${OPT_YES}" = 1 ] || ! interactive; then args+=(--yes); fi
  [ -n "${OPT_DEVOPS_ORGS}" ] && args+=(--devops-orgs "${OPT_DEVOPS_ORGS}")
  [ -n "${OPT_SUDO}" ] && args+=(--sudo "${OPT_SUDO}")
  [ -n "${OPT_DOCKER}" ] && args+=(--docker "${OPT_DOCKER}")
  [ "${OPT_ACCEPT_ROOT_EQ}" = 1 ] && args+=(--accept-root-equivalent)
  [ -n "${OPT_DEPLOY}" ] && args+=(--deploy "${OPT_DEPLOY}")
  [ "${OPT_DEPLOY_PIN_COMMIT}" = 1 ] && args+=(--deploy-pin-commit)
  [ -n "${OPT_ALLOW_UNSIGNED_FROM}" ] && args+=(--allow-unsigned-from "${OPT_ALLOW_UNSIGNED_FROM}")
  note "guildwise-runner setup asks you here, on this computer: which organizations DevOps may serve (each defaults to no), sudo, Docker access for deploys and the deploy approvals."
  if [ -n "${SUDO_PASSWORD}" ]; then
    printf '%s\n' "${SUDO_PASSWORD}" | runner "${args[@]}" --sudo-password-stdin || rc=$?
    SUDO_PASSWORD=""
  elif interactive; then
    runner "${args[@]}" </dev/tty || rc=$?
  else
    runner "${args[@]}" </dev/null || rc=$?
  fi
  [ "${rc}" = 0 ] || die "guildwise-runner setup did not finish (exit ${rc})." "Run the command again, or run guildwise-runner setup as ${RUNNER_NAME}."
  apply_root_choices
  step_ok "Local permissions set (written by guildwise-runner setup to ${RUNNER_HOME}/.config/aom-runner/policy.json, readable only by ${RUNNER_NAME})"
}

# ---- doctor and finish -----------------------------------------------------------------------------------------------------
run_doctor() {
  local out line status rest name
  out="$(runner doctor 2>&1)" || true
  printf '%s\n' "${out}" | sed 's/^/    /'
  while IFS= read -r line; do
    case "${line}" in
      "ok    "*) status=ok; rest="${line#ok    }" ;;
      "warn  "*) status=warn; rest="${line#warn  }" ;;
      "FAIL  "*) status=fail; rest="${line#FAIL  }" ;;
      *) continue ;;
    esac
    name="${rest%%:*}"
    report "doctor:${name}" "${status}" "${rest#*: }"
  done <<<"${out}"
  case "${out}" in
    *"FAIL  "*) return 1 ;;
  esac
  return 0
}

wait_until_connected() {
  for _ in $(seq 1 20); do
    runner status 2>/dev/null | grep -q ', connected' && return 0
    sleep 1
  done
  return 1
}

summary() {
  say ""
  if [ "${FAILED}" = 0 ] && [ "${DOCTOR_FAILED:-0}" = 0 ]; then
    printf '%s%s is ready.%s\n' "${C_GREEN}${C_BOLD}" "${APP_NAME}" "${C_RESET}"
    if [ "${SERVICE_MODE}" = background ]; then
      say "  This computer is connected now, but it will not start again by itself after a restart until systemd is on (see below)."
    else
      say "  This computer now appears on the Workstations page and will start again by itself after a restart."
    fi
    [ -n "${RUNNER_AS}" ] && say "  The runner runs as ${RUNNER_NAME} and works in its own clones; change its permissions with: sudo -u ${RUNNER_NAME} -H ${BIN_DIR}/guildwise-runner setup"
    [ -n "${QUARANTINE_DIR}" ] && say "  The old runner is in ${QUARANTINE_DIR}; delete it after you have looked at it."
    if [ "${#WARNINGS[@]}" -gt 0 ]; then
      say ""
      say "  A few things to look at later:"
      local w; for w in "${WARNINGS[@]}"; do say "    - ${w}"; done
    fi
    say ""
    say "  Next: open ${SERVER_URL}/workstations, then hire an agent onto this workstation."
    say "  Run this same command again any time to upgrade or repair the installation."
    report "summary" "done" "success"
  else
    printf '%s%s is installed, but some checks failed.%s\n' "${C_YELLOW}${C_BOLD}" "${APP_NAME}" "${C_RESET}"
    say "  Read the lines marked FAIL above, fix them, and run the command again."
    help_footer
    report "summary" "done" "finished with failed checks"
  fi
}

# --legacy-only: only the "Looking for an older runner" step (the Windows installer runs it inside your Ubuntu).
legacy_only() {
  STEP_TOTAL=1
  step "Looking for an older runner"
  handle_legacy
  say "LEGACY_RESULT=${LEGACY_RESULT}"
}
