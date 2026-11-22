# ---------------------------------------------------------------------------------------------------------------------
# macOS: Homebrew, Node 22, git, Claude Code, the runner and its service: a LaunchDaemon for the dedicated guildwise-runner
# user (the default for a new install), or a launchd agent for your own user. The sandbox (Seatbelt) is built into macOS.
# The dedicated-user path is not yet tested on Mac hardware (release notes).
# ---------------------------------------------------------------------------------------------------------------------
LABEL="com.guildwisehq.runner"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

brew_shellenv() {
  local b
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "${b}" ]; then eval "$("${b}" shellenv)"; return 0; fi
  done
  return 1
}

detect_system() {
  [ "$(uname -s)" = Darwin ] || die "This installer is for macOS. Your system reports $(uname -s)." "Pick your system on the Add a workstation page."
  if [ "$(id -u)" -eq 0 ]; then die "Run this as your normal user, not with sudo." "Open Terminal and run the command again."; fi
  step_ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?'), $(uname -m), user $(id -un)"
}

install_homebrew() {
  brew_shellenv || true
  if have brew; then step_ok "Homebrew is already installed"; return; fi
  say "    Homebrew is the standard installer for developer tools on a Mac. It is needed for Node and git."
  ask_yn "Install Homebrew now? (it asks for your Mac password once)" y GUILDWISE_WITH_HOMEBREW ||
    die "Homebrew is required." "Install it from https://brew.sh, then run the command again."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" ||
    die "The Homebrew installer did not finish." "Run it yourself from https://brew.sh, then run the command again."
  brew_shellenv || die "Homebrew installed but was not found." "Open a new Terminal window and run the command again."
  step_ok "Homebrew installed"
}

install_tools() {
  local f
  for f in git "node@22"; do
    if brew list --formula "${f}" >/dev/null 2>&1; then good "${f} is already installed"
    else note "Installing ${f} ..."; brew install "${f}" >/dev/null 2>&1 || die "Could not install ${f} with Homebrew." "Run \`brew install ${f}\` yourself to see the error, then run the command again."; fi
  done
  local node_prefix
  node_prefix="$(brew --prefix node@22)"
  export PATH="${node_prefix}/bin:${PATH}"
  if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    die "Node 22 is not available." "Open a new Terminal window and run the command again."
  fi
  step_ok "Node $(node -v) and git are ready"
}

install_claude_code() {
  if have claude; then step_ok "Claude Code is already installed ($(claude --version 2>/dev/null | head -n1))"; return; fi
  if [ "${GUILDWISE_SKIP_CLAUDE_INSTALL:-}" = 1 ]; then step_warn "Skipped installing Claude Code (GUILDWISE_SKIP_CLAUDE_INSTALL=1)"; return; fi
  note "Installing Claude Code with npm ..."
  npm install -g --prefix "${HOME}/.local" @anthropic-ai/claude-code >/dev/null 2>&1 ||
    die "Could not install Claude Code." "Run \`npm install -g --prefix ~/.local @anthropic-ai/claude-code\` yourself to see the error, then run the command again."
  hash -r
  have claude || die "Claude Code installed but is not on your PATH." "Open a new Terminal window and run the command again."
  step_ok "Claude Code installed"
}

# macOS baseline (DESIGN deps-without-sudo §1): the Xcode Command Line Tools (compilers, git, make), with the same
# wait-and-recheck as Docker Desktop below. Not yet tested on hardware.
install_xcode_clt() {
  if xcode-select -p >/dev/null 2>&1; then step_ok "The Xcode Command Line Tools are installed"; return; fi
  [ "${OPT_SKIP_BASELINE}" = 1 ] && die "The Xcode Command Line Tools are missing (--skip-baseline installs nothing)." "Run \`xcode-select --install\`, then run the command again."
  xcode-select --install >/dev/null 2>&1 || true
  interactive || die "The Xcode Command Line Tools are needed; their installer window has opened." "Finish it, then run the command again."
  while ! xcode-select -p >/dev/null 2>&1; do
    say "    Finish the Command Line Tools installer window, then press Enter to check again."
    wait_enter || die "No keyboard to wait on." "Finish the Command Line Tools install, then run the command again."
  done
  step_ok "The Xcode Command Line Tools are installed"
}

# Docker on a Mac (owner 2026-11-21): Docker Desktop is used when it is there; without it the installer stops, shows the
# download link, waits and checks again. --docker none skips the wait. Without a keyboard: --docker host stops with the
# link; otherwise the wait is skipped and the runner gets no Docker (an unattended re-run cannot loop). Not yet tested on
# hardware.
# Waits for Enter at the keyboard.
wait_enter() { read -r _ </dev/tty; }

DOCKER_DESKTOP_URL="https://www.docker.com/products/docker-desktop/"
wait_for_docker_desktop() {
  [ "${OPT_DOCKER}" = none ] && { note "Docker skipped (--docker none)."; return 0; }
  desktop_docker_answers && { good "Docker Desktop is running"; return 0; }
  if ! interactive; then
    [ "${OPT_DOCKER}" = host ] && die "Docker Desktop is needed: install it from ${DOCKER_DESKTOP_URL}, start it, then run the command again." "Or run the installer with --docker none."
    step_warn "No Docker Desktop: the runner gets no Docker (install it from ${DOCKER_DESKTOP_URL} and run the installer again)."
    return 0
  fi
  while ! desktop_docker_answers; do
    say "    Docker Desktop is needed: install it from ${DOCKER_DESKTOP_URL}, start it, then press Enter to check again."
    wait_enter || die "No keyboard to wait on." "Install Docker Desktop, then run the command again."
  done
  good "Docker Desktop is running"
}

# The browser that makes the PDF copy of a form's answers. Never fatal: the copies stay off until it works.
install_pdf_renderer() {
  note "Installing the browser for PDF copies of form answers (a download of roughly 100 MB) ..."
  if runner pdf-renderer install >/dev/null 2>&1; then good "PDF renderer installed"; return; fi
  step_warn "Could not install the PDF renderer. PDF copies of form answers stay off until \`guildwise-runner pdf-renderer install\` succeeds."
}

service_path() {
  printf '%s' "${BIN_DIR}:$(dirname "$(command -v node)"):$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
}

# The home folder of a user (from Directory Services).
user_home() { dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{print $2}'; }

dedicated_supported() { :; }

# Stops an old runner of your user: its launchd agent (any process left is stopped by the caller).
stop_legacy_services() {
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
}

# The LaunchDaemon of the dedicated user: guildwise-admin writes it (UserName guildwise-runner, the runner root below) and
# loads and starts it; a kickstart picks up an upgraded runner. A named instance (--instance <name>) has its own label,
# com.guildwisehq.runner.<name>, and never touches another runner's.
dedicated_label() { printf '%s' "${LABEL}${OPT_INSTANCE:+.${OPT_INSTANCE}}"; }

# Stops the dedicated user's LaunchDaemon (if there is one yet).
stop_dedicated_service() { as_root launchctl bootout "system/$(dedicated_label)" >/dev/null 2>&1 || true; }

install_dedicated_service() {
  run_admin service install --runner-root "${RUNNER_ROOT}" ${RUNNER_CA:+--ca-file "${RUNNER_CA}"} --start ||
    die "guildwise-admin could not install the runner's LaunchDaemon." "Run: sudo ${ADMIN_HINT} service install --runner-root ${RUNNER_ROOT} --start   to see why, then run the command again."
  as_root launchctl kickstart -k "system/$(dedicated_label)" >/dev/null 2>&1 || true
  good "The runner starts at boot as ${RUNNER_NAME} (LaunchDaemon $(dedicated_label))"
  SERVICE_MODE=launchd; record_service_mode launchd
  report "Service" ok "launchd daemon running as ${RUNNER_NAME}"
}

install_service() {
  if [ -n "${RUNNER_AS}" ]; then install_dedicated_service; return; fi
  mkdir -p "${HOME}/Library/LaunchAgents" "${DATA_DIR}/logs"
  cat >"${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUNNER_ROOT}/current/aom-runner</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(service_path)</string>
$([ -n "${RUNNER_CA}" ] && printf '    <key>NODE_EXTRA_CA_CERTS</key>\n    <string>%s</string>' "${RUNNER_CA}")
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DATA_DIR}/logs/runner.log</string>
  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/logs/runner.log</string>
</dict>
</plist>
PLIST
  good "Launch agent written: ${PLIST}"
  local domain
  domain="gui/$(id -u)"
  launchctl bootout "${domain}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "${domain}" "${PLIST}" || die "The launch agent could not be loaded." "Run \`launchctl bootstrap ${domain} ${PLIST}\` to see why, then run the command again."
  launchctl kickstart -k "${domain}/${LABEL}" >/dev/null 2>&1 || true
  good "The runner starts at login and restarts if it stops (launchd agent ${LABEL})"
  SERVICE_MODE=launchd; record_service_mode launchd
  report "Service" ok "launchd agent running"
}

main() {
  parse_flags "$@"
  if [ "${OPT_LEGACY_ONLY}" = 1 ]; then legacy_only; return 0; fi
  STEP_TOTAL=17
  say "${C_BOLD}${APP_NAME}: set up this Mac as a workstation${C_RESET}"
  say "${C_DIM}Safe to run again at any time: it upgrades or repairs what is already here.${C_RESET}"
  report "installer" start "macos"

  step "Checking this Mac"; detect_system
  step "Looking for an older runner"; handle_legacy; choose_runner_user
  step "Administrator rights (once)"; authorize_once
  step "Xcode Command Line Tools"; install_xcode_clt
  step "Homebrew"; install_homebrew
  step "Installing Node 22 and git"; install_tools
  step "Checking Docker"; wait_for_docker_desktop
  step "Downloading the runner"; stage_runner_release
  step "Runner user"; setup_runner_user
  step "Installing the runner"; place_runner_release
  step "Installing Claude Code"; if [ -n "${RUNNER_AS}" ]; then install_claude_for_runner; else install_claude_code; fi
  step "Pairing with ${APP_NAME}"; pair_runner
  step "Installing the PDF renderer"; install_pdf_renderer
  step "Choosing your code folder"; add_repo_folders
  step "Signing in to Claude"; sign_in_to_claude
  step "Setting local permissions"; set_local_permissions
  step "Starting the runner and checking everything"
  install_service
  if wait_until_connected; then good "The runner is connected to ${SERVER_URL}"; report "Connected" ok "runner connected"; open_approvals_page
  else step_warn "The runner has not connected yet. Give it a minute; the checks below say more."; fi
  DOCTOR_FAILED=0
  run_doctor || DOCTOR_FAILED=1
  summary
  [ "${DOCTOR_FAILED}" = 0 ] || exit 2
}

main "$@"
