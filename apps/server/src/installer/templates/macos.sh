# ---------------------------------------------------------------------------------------------------------------------
# macOS: Homebrew, Node 22, git, Claude Code, the runner, a launchd agent. The sandbox (Seatbelt) is built into macOS.
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

install_extras() {
  if have yt-dlp; then good "yt-dlp is already installed"
  elif ask_yn "Install yt-dlp? It lets agents read transcripts of YouTube and other videos. Optional." y GUILDWISE_WITH_YTDLP; then
    if brew install yt-dlp >/dev/null 2>&1; then good "yt-dlp installed"; else step_warn "Could not install yt-dlp."; fi
  else note "Skipped yt-dlp. You can add it later."; fi
  if have docker; then good "Docker is already installed"
  elif ask_yn "Install Docker Desktop? Only needed if your testers run containers. Optional." n GUILDWISE_WITH_DOCKER; then
    if brew install --cask docker >/dev/null 2>&1; then good "Docker Desktop installed (open it once to finish setup)"; else step_warn "Could not install Docker Desktop."; fi
  else note "Skipped Docker. You can add it later."; fi
}

service_path() {
  printf '%s' "${BIN_DIR}:$(dirname "$(command -v node)"):$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
}

install_service() {
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
  case " $* " in *" --choose-folders "*) CHOOSE_FOLDERS=1 ;; esac
  STEP_TOTAL=10
  say "${C_BOLD}${APP_NAME}: set up this Mac as a workstation${C_RESET}"
  say "${C_DIM}Safe to run again at any time: it upgrades or repairs what is already here.${C_RESET}"
  report "installer" start "macos"

  step "Checking this Mac"; detect_system
  step "Homebrew"; install_homebrew
  step "Installing Node 22 and git"; install_tools
  step "Installing Claude Code"; install_claude_code
  step "Optional extras"; install_extras
  step "Downloading the runner"; install_runner_release
  step "Pairing with ${APP_NAME}"; pair_runner
  step "Choosing your code folder"; add_repo_folders
  step "Signing in to Claude"; sign_in_to_claude
  step "Starting the runner and checking everything"
  install_service
  if wait_until_connected; then good "The runner is connected to ${SERVER_URL}"; report "Connected" ok "runner connected"
  else step_warn "The runner has not connected yet. Give it a minute; the checks below say more."; fi
  DOCTOR_FAILED=0
  run_doctor || DOCTOR_FAILED=1
  summary
  [ "${DOCTOR_FAILED}" = 0 ] || exit 2
}

main "$@"
