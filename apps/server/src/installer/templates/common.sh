# ---------------------------------------------------------------------------------------------------------------------
# Shared helpers (screen output, progress reports, questions, downloads, the runner itself).
# Everything below runs as your own user. It asks for administrator rights only to install system packages.
# ---------------------------------------------------------------------------------------------------------------------
STEP_N=0
STEP_TOTAL=0
WARNINGS=()
FAILED=0
SERVICE_MODE=""
RUNNER_ROOT="${HOME}/.local/share/guildwise/runner"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${AOM_RUNNER_HOME:-${HOME}/.aom-runner}"
CHOOSE_FOLDERS="${GUILDWISE_CHOOSE_FOLDERS:-${EXPERT_MODE:-0}}"
export PATH="${BIN_DIR}:${PATH}"

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

# ---- the runner release ------------------------------------------------------------------------------------------------
sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}

# The version of a runner that is already installed here (empty: none). The installer keeps it and only upgrades it.
existing_runner_version() {
  [ -x "${RUNNER_ROOT}/current/aom-runner" ] || return 0
  "${RUNNER_ROOT}/current/aom-runner" --version 2>/dev/null | head -n1 | tr -d '[:space:]' || true
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

# Tells the runner how it is kept running, so a self-update knows how to restart it (systemd | launchd | background).
record_service_mode() {
  printf '%s\n' "$1" >"${RUNNER_ROOT}/service-mode" 2>/dev/null || true
}

install_runner_release() {
  local before; before="$(existing_runner_version)"
  if [ -n "${before}" ]; then
    note "A runner ${before} is already installed on this computer: keeping it and its settings (upgrading only if this server offers a newer one)."
    report "Runner" info "existing runner ${before}"
    if [ -n "${RELEASE_VERSION}" ] && version_newer "${before}" "${RELEASE_VERSION}"; then
      step_ok "The installed runner ${before} is newer than this server's ${RELEASE_VERSION}: kept as it is"
      mkdir -p "${BIN_DIR}"
      ln -sfn "${RUNNER_ROOT}/current/aom-runner" "${BIN_DIR}/aom-runner" 2>/dev/null || true
      ln -sfn "${RUNNER_ROOT}/current/aom-runner" "${BIN_DIR}/guildwise-runner" 2>/dev/null || true
      return
    fi
  elif have aom-runner && [ "$(command -v aom-runner)" != "${BIN_DIR}/aom-runner" ]; then
    warn "Another aom-runner is on this computer ($(command -v aom-runner)). The installer adds its own copy in ${RUNNER_ROOT} and uses that one."
  fi
  if [ -z "${RELEASE_VERSION}" ] || [ -z "${RELEASE_SHA256}" ]; then
    die "This ${APP_NAME} server has no runner download to offer." "Ask your administrator to publish the runner release, then create a new install command."
  fi
  local target="${RUNNER_ROOT}/${RELEASE_VERSION}"
  if [ -x "${target}/aom-runner/aom-runner" ] && [ "$(cat "${target}/.sha256" 2>/dev/null)" = "${RELEASE_SHA256}" ]; then
    step_ok "Runner ${RELEASE_VERSION} is already installed here and unchanged"
  else
    local tmp; tmp="$(mktemp -d)"
    local file="${tmp}/aom-runner-${RELEASE_VERSION}.tgz"
    note "Downloading runner ${RELEASE_VERSION} from ${SERVER_URL} ..."
    curl -fsSL --retry 3 -o "${file}" "${SERVER_URL}/api/runner/release/aom-runner-${RELEASE_VERSION}.tgz" ||
      die "Could not download the runner from ${SERVER_URL}." "Check that this computer can reach ${SERVER_URL} in a browser, then run the command again."
    local got; got="$(sha256_of "${file}")" || die "No sha256sum or shasum found to check the download." "Install coreutils, then run the command again."
    [ "${got}" = "${RELEASE_SHA256}" ] ||
      die "The downloaded runner did not match its checksum (expected ${RELEASE_SHA256:0:12}..., got ${got:0:12}...)." "The download was damaged or changed on the way. Try again; if it repeats, contact us."
    good "Checksum verified (${RELEASE_SHA256:0:12}...)"
    rm -rf "${target}"
    mkdir -p "${target}"
    tar -xzf "${file}" -C "${target}" || die "The runner archive could not be unpacked." "Run the command again."
    printf '%s' "${RELEASE_SHA256}" >"${target}/.sha256"
    rm -rf "${tmp}"
    if [ -n "${before}" ] && [ "${before}" != "${RELEASE_VERSION}" ]; then step_ok "Runner upgraded from ${before} to ${RELEASE_VERSION}"
    else step_ok "Runner ${RELEASE_VERSION} installed"; fi
  fi
  switch_current "${target}/aom-runner"
  mkdir -p "${BIN_DIR}"
  ln -sfn "${RUNNER_ROOT}/current/aom-runner" "${BIN_DIR}/aom-runner"
  # `guildwise-runner` is the name people type; `aom-runner` stays as an alias (the launcher resolves symlinks)
  ln -sfn "${RUNNER_ROOT}/current/aom-runner" "${BIN_DIR}/guildwise-runner"
  ln -sfn "${RUNNER_ROOT}/current/dist/aom.mjs" "${BIN_DIR}/aom" 2>/dev/null || true
}

runner() { "${RUNNER_ROOT}/current/aom-runner" "$@"; }

is_paired() {
  [ -f "${DATA_DIR}/config.json" ] && grep -q '"runnerToken"' "${DATA_DIR}/config.json" 2>/dev/null
}

# The server a config.json is paired with (empty when unreadable).
paired_server() {
  sed -n 's/.*"serverUrl": *"\([^"]*\)".*/\1/p' "${DATA_DIR}/config.json" 2>/dev/null | head -n1
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
# GUILDWISE_CHOOSE_FOLDERS=1 or the --choose-folders flag lets you pick the folders.
add_repo_folders() {
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
