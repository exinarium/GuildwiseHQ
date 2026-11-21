# ---------------------------------------------------------------------------------------------------------------------
# Linux (and Windows via WSL2): Node 22, git, Claude Code, sandbox tools, the runner and its service: a system service for
# the dedicated guildwise-runner user (the default for a new install), or a systemd user service for your own user.
# ---------------------------------------------------------------------------------------------------------------------
PKG=""
SUDO=""
IN_WSL=0
FALLBACK_LAUNCHER=""
# WSL sets WSL_DISTRO_NAME in every session (a container on a WSL host shares the kernel but not this).
[ -n "${WSL_DISTRO_NAME:-}" ] && IN_WSL=1

detect_system() {
  [ "$(uname -s)" = Linux ] || die "This installer is for Linux. Your system reports $(uname -s)." "Pick your system on the Add a workstation page."
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die "Unsupported processor type: $(uname -m)." "The runner supports 64-bit Intel/AMD and ARM computers." ;; esac
  if [ "$(id -u)" -eq 0 ] && [ "${GUILDWISE_ALLOW_ROOT:-}" != 1 ]; then
    die "Run this as your normal user, not as root (agents should never run with full system rights)." "Open a normal terminal (no sudo in front) and run the command again."
  fi
  if [ "$(id -u)" -eq 0 ]; then SUDO=""
  elif have sudo; then SUDO="sudo"
  else SUDO=""; fi
  if have apt-get; then PKG=apt
  elif have dnf; then PKG=dnf
  elif have pacman; then PKG=pacman
  else PKG=""; fi
  local distro="Linux"
  # shellcheck source=/dev/null
  [ -r /etc/os-release ] && distro="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-Linux}")"
  [ "${IN_WSL}" = 1 ] && distro="${distro} (WSL2)"
  step_ok "${distro}, $(uname -m), user $(id -un)"
}

pkg_install() {
  [ -n "${PKG}" ] || die "This Linux uses a package manager the installer does not know (apt, dnf and pacman are supported)." "Install these yourself: $*, then run the command again."
  if [ -z "${SUDO}" ] && [ "$(id -u)" -ne 0 ]; then
    die "Administrator rights are needed to install: $*" "Ask an administrator to install them, or install sudo, then run the command again."
  fi
  case "${PKG}" in
    apt)
      ${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      ${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null ;;
    dnf) ${SUDO} dnf install -y -q "$@" >/dev/null ;;
    pacman) ${SUDO} pacman -S --noconfirm --needed "$@" >/dev/null ;;
  esac
}

git_new_enough() {
  have git || return 1
  local v major minor
  v="$(git --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/')"
  major="${v%% *}"; minor="${v##* }"
  [ "${major:-0}" -gt 2 ] || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -ge 40 ]; }
}

# Debian 12 ships git 2.39 and has no newer build; this compiles a pinned, checksummed git into ~/.local (a few minutes).
GIT_SRC_VERSION="2.47.1"
GIT_SRC_SHA256="f3d8f9bb23ae392374e91cd9d395970dabc5b9c5ee72f39884613cd84a6ed310"
build_git_from_source() {
  note "Building git ${GIT_SRC_VERSION} from source into ~/.local (this takes a few minutes) ..."
  pkg_install build-essential libcurl4-openssl-dev libexpat1-dev zlib1g-dev libssl-dev >/dev/null 2>&1 || return 1
  local tmp file
  tmp="$(mktemp -d)"
  file="${tmp}/git.tar.xz"
  curl -fsSL --retry 3 -o "${file}" "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_SRC_VERSION}.tar.xz" || return 1
  [ "$(sha256_of "${file}")" = "${GIT_SRC_SHA256}" ] || return 1
  tar -xJf "${file}" -C "${tmp}" || return 1
  (cd "${tmp}/git-${GIT_SRC_VERSION}" && make -j"$(nproc 2>/dev/null || echo 2)" prefix="${HOME}/.local" NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 all install >/dev/null 2>&1) || return 1
  rm -rf "${tmp}"
}

# The runner needs git 2.40 (worktrees). Ubuntu 22.04 and Debian 12 ship older ones.
ensure_modern_git() {
  git_new_enough && return 0
  note "git $(git --version | sed 's/git version //') is older than the 2.40 the runner needs; installing a newer one ..."
  if [ "${PKG}" = apt ]; then
    local id
    # shellcheck source=/dev/null
    id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    if [ "${id}" = ubuntu ]; then
      pkg_install software-properties-common >/dev/null 2>&1 || true
      ${SUDO} add-apt-repository -y ppa:git-core/ppa >/dev/null 2>&1 || true
      ${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      ${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null 2>&1 || true
    fi
    git_new_enough || build_git_from_source || true
  fi
  hash -r
  git_new_enough || die "git $(git --version | sed 's/git version //') is too old and a newer one could not be installed (the runner needs 2.40 or newer)." "Install a newer git from your distribution or from https://git-scm.com/downloads/linux, then run the command again."
}

# ---- the baseline (DESIGN deps-without-sudo §1): installed once, as root, in the one authorization ---------------------
# One package-manager call per group, only for what is missing. The core group must succeed; the others warn and name
# what is missing. With --skip-baseline nothing is installed: missing core tools stop the install, the rest warn.
# Headless Chromium is not here: `runner pdf-renderer install` downloads it as the runner user.
baseline_group() {
  local group="$1"
  case "${PKG}:${group}" in
    apt:core) echo "ca-certificates curl git unzip zip tar gzip xz-utils bzip2 build-essential pkg-config python3 openssh-client jq socat bubblewrap" ;;
    apt:playwright) echo "libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libx11-6 libxcb1 libxext6 libglib2.0-0" ;;
    apt:fonts) echo "fonts-liberation fonts-noto-core fonts-noto-color-emoji" ;;
    apt:docker) echo "uidmap dbus-user-session iptables slirp4netns" ;;
    dnf:core) echo "ca-certificates curl git unzip zip tar gzip xz bzip2 gcc gcc-c++ make pkgconf-pkg-config python3 openssh-clients jq socat bubblewrap" ;;
    dnf:playwright) echo "nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm dbus-libs libxkbcommon libXcomposite libXdamage libXfixes libXrandr mesa-libgbm pango cairo alsa-lib libX11 libxcb libXext glib2" ;;
    dnf:fonts) echo "liberation-fonts google-noto-sans-fonts google-noto-color-emoji-fonts" ;;
    dnf:docker) echo "shadow-utils dbus-daemon iptables slirp4netns" ;;
    pacman:core) echo "ca-certificates curl git unzip zip tar gzip xz bzip2 base-devel pkgconf python openssh jq socat bubblewrap" ;;
    pacman:playwright) echo "nss nspr at-spi2-core libcups libdrm dbus libxkbcommon libxcomposite libxdamage libxfixes libxrandr mesa pango cairo alsa-lib libx11 libxcb libxext glib2" ;;
    pacman:fonts) echo "ttf-liberation noto-fonts noto-fonts-emoji" ;;
    pacman:docker) echo "shadow iptables slirp4netns" ;;
  esac
}

# apt t64 rename (Ubuntu 24.04+, Debian 13): use <name>t64 where the archive has it.
apt_name() {
  case "$1" in
    libasound2|libatk1.0-0|libatk-bridge2.0-0|libcups2|libglib2.0-0|libatspi2.0-0)
      if apt-cache show "$1t64" >/dev/null 2>&1; then echo "$1t64"; else echo "$1"; fi ;;
    *) echo "$1" ;;
  esac
}

# pkg_present <package>: installed already (no root needed).
pkg_present() {
  case "${PKG}" in
    apt) dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed' ;;
    dnf) rpm -q --whatprovides "$1" >/dev/null 2>&1 ;;
    pacman) pacman -Qq "$1" >/dev/null 2>&1 || pacman -Qqg "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

baseline_missing() {
  local p name out=()
  for p in $(baseline_group "$1"); do
    name="${p}"
    [ "${PKG}" = apt ] && name="$(apt_name "${p}")"
    pkg_present "${name}" || out+=("${name}")
  done
  [ "${#out[@]}" -eq 0 ] || printf '%s\n' "${out[@]}"
}

install_baseline() {
  [ -n "${PKG}" ] || {
    [ "${OPT_SKIP_BASELINE}" = 1 ] || die "This Linux uses a package manager the installer does not know (apt, dnf and pacman are supported)." "Install the baseline yourself (see the install guide) and run the command again with --skip-baseline."
  }
  local group missing all=()
  for group in core playwright fonts docker; do
    [ -n "${PKG}" ] || break
    mapfile -t missing < <(baseline_missing "${group}")
    [ "${#missing[@]}" -eq 0 ] && continue
    if [ "${OPT_SKIP_BASELINE}" = 1 ]; then
      [ "${group}" = core ] && die "These baseline packages are missing: ${missing[*]} (--skip-baseline installs nothing)." "Install them yourself, then run the command again."
      step_warn "Missing ${group} packages (--skip-baseline installs nothing): ${missing[*]}"
      continue
    fi
    note "Installing the ${group} packages: ${missing[*]}"
    if ! pkg_install "${missing[@]}"; then
      [ "${group}" = core ] && die "Installing the core packages failed: ${missing[*]}." "Run the command again; if it repeats, install them by hand and run it with --skip-baseline."
      step_warn "Could not install the ${group} packages: ${missing[*]}. Install them yourself later."
      continue
    fi
    all+=("${missing[@]}")
  done
  local tool
  for tool in curl git tar gzip socat bwrap; do have "${tool}" || die "${tool} is still missing." "Install it by hand, then run the command again."; done
  ensure_modern_git
  if [ "${#all[@]}" -gt 0 ]; then step_ok "Baseline installed: ${all[*]}"; else step_ok "The baseline packages are already installed"; fi
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node() {
  if have node && [ "$(node_major)" -ge 22 ]; then step_ok "Node $(node -v) is already installed"; return; fi
  local nvm_dir="${NVM_DIR:-${HOME}/.nvm}"
  if [ -s "${nvm_dir}/nvm.sh" ]; then
    # nvm is there but this shell did not load it: use the Node 22 it already has before installing anything.
    export NVM_DIR="${nvm_dir}"
    set +u
    # shellcheck disable=SC1091
    . "${NVM_DIR}/nvm.sh"
    nvm use 22 >/dev/null 2>&1
    set -u
    if have node && [ "$(node_major)" -ge 22 ]; then step_ok "Node $(node -v) is already installed with nvm"; return; fi
  else
    note "Installing nvm (the Node version manager) ..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null 2>&1 ||
      die "Could not install nvm." "Check this computer can reach github.com, then run the command again."
  fi
  export NVM_DIR="${nvm_dir}"
  set +u
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh"
  note "Installing Node 22 ..."
  nvm install 22 >/dev/null 2>&1 || { set -u; die "Could not install Node 22." "Run the command again."; }
  nvm alias default 22 >/dev/null 2>&1
  nvm use 22 >/dev/null 2>&1
  set -u
  { have node && [ "$(node_major)" -ge 22 ]; } || die "Node 22 is still not available." "Open a new terminal and run the command again."
  step_ok "Node $(node -v) installed with nvm"
}

install_claude_code() {
  if have claude; then step_ok "Claude Code is already installed ($(claude --version 2>/dev/null | head -n1))"; return; fi
  if [ "${GUILDWISE_SKIP_CLAUDE_INSTALL:-}" = 1 ]; then step_warn "Skipped installing Claude Code (GUILDWISE_SKIP_CLAUDE_INSTALL=1)"; return; fi
  note "Installing Claude Code with npm ..."
  local prefix_args=()
  case "$(command -v npm)" in "${HOME}"/.nvm/*) ;; *) prefix_args=(--prefix "${HOME}/.local") ;; esac
  npm install -g ${prefix_args[@]+"${prefix_args[@]}"} @anthropic-ai/claude-code >/dev/null 2>&1 ||
    die "Could not install Claude Code." "Run \`npm install -g @anthropic-ai/claude-code\` yourself to see the error, then run the command again."
  hash -r
  have claude || die "Claude Code installed but is not on your PATH." "Open a new terminal and run the command again."
  step_ok "Claude Code installed"
}

install_ytdlp() {
  if have yt-dlp; then good "yt-dlp is already installed"; return; fi
  if ! ask_yn "Install yt-dlp? It lets agents read transcripts of YouTube and other videos. Optional." y GUILDWISE_WITH_YTDLP; then
    note "Skipped. You can add it later."; report "yt-dlp" info "skipped"; return
  fi
  local asset=yt-dlp_linux
  [ "$(uname -m)" = x86_64 ] || asset=yt-dlp_linux_aarch64
  mkdir -p "${BIN_DIR}"
  if curl -fsSL --retry 2 -o "${BIN_DIR}/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}"; then
    chmod +x "${BIN_DIR}/yt-dlp"; good "yt-dlp installed in ${BIN_DIR}"
  else
    rm -f "${BIN_DIR}/yt-dlp"; step_warn "Could not download yt-dlp; video transcripts will not work until it is installed."
  fi
}

# The browser that makes the PDF copy of a form's answers. Never fatal: the copies stay off until it works.
install_pdf_renderer() {
  note "Installing the browser for PDF copies of form answers (a download of roughly 100 MB) ..."
  # Its system libraries and fonts are in the baseline; the runner downloads the browser for itself, without root.
  if runner pdf-renderer install >/dev/null 2>&1; then good "PDF renderer installed for ${RUNNER_NAME}"; return; fi
  step_warn "Could not install the PDF renderer. PDF copies of form answers stay off until \`guildwise-runner pdf-renderer install\` succeeds."
}

xdg_runtime() {
  local dir
  dir="/run/user/$(id -u)"
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "${dir}" ]; then export XDG_RUNTIME_DIR="${dir}"; fi
}

user_systemd_works() {
  [ -d /run/systemd/system ] || return 1
  have systemctl || return 1
  xdg_runtime
  systemctl --user show-environment >/dev/null 2>&1
}

service_path() {
  local p="${BIN_DIR}" d
  for d in "$(dirname "$(command -v node)")" "$(dirname "$(command -v claude 2>/dev/null || echo /usr/bin/claude)")"; do
    case ":${p}:" in *":${d}:"*) ;; *) p="${p}:${d}" ;; esac
  done
  printf '%s' "${p}:/usr/local/bin:/usr/bin:/bin"
}

write_unit_file() {
  local unit_dir="${HOME}/.config/systemd/user"
  mkdir -p "${unit_dir}"
  cat >"${unit_dir}/aom-runner.service" <<UNIT
[Unit]
Description=${APP_NAME} runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="PATH=$(service_path)"
$([ -n "${RUNNER_CA}" ] && printf 'Environment="NODE_EXTRA_CA_CERTS=%s"' "${RUNNER_CA}")
ExecStart="${RUNNER_ROOT}/current/aom-runner" start
Restart=always
RestartSec=10
# 78: the runner refused to start (R18-P); restarting would only repeat the refusal.
RestartPreventExitStatus=78
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
UNIT
  good "Service file written: ${unit_dir}/aom-runner.service"
}

enable_linger() {
  have loginctl || return 1
  loginctl enable-linger "$(id -un)" 2>/dev/null || { [ -n "${SUDO}" ] && ${SUDO} loginctl enable-linger "$(id -un)" 2>/dev/null; } || return 1
  [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]
}

# When systemd is not running (a container, or WSL without systemd): a small script that starts the runner in the background.
write_fallback_launcher() {
  local f="${RUNNER_ROOT}/start-runner.sh"
  cat >"${f}" <<LAUNCH
#!/bin/sh
# Starts the ${APP_NAME} runner in the background (used when systemd is not available).
export PATH="$(service_path)"
$([ -n "${RUNNER_CA}" ] && printf 'export NODE_EXTRA_CA_CERTS="%s"' "${RUNNER_CA}")
mkdir -p "${DATA_DIR}/logs"
if [ -f "${DATA_DIR}/status.json" ] && kill -0 "\$(sed -n 's/.*"pid": *\\([0-9]*\\).*/\\1/p' "${DATA_DIR}/status.json")" 2>/dev/null; then exit 0; fi
nohup "${RUNNER_ROOT}/current/aom-runner" start >>"${DATA_DIR}/logs/service.log" 2>&1 &
LAUNCH
  chmod +x "${f}"
  FALLBACK_LAUNCHER="${f}"
}

# The home folder of a user (from the user database).
user_home() { getent passwd "$1" 2>/dev/null | cut -d: -f6; }

# The dedicated user runs as a system service, so it needs systemd (a container or WSL without systemd cannot).
dedicated_supported() {
  { [ -d /run/systemd/system ] && have systemctl; } ||
    die "The dedicated runner user needs systemd, which is not running here." "Use --runner-user current on this computer (or turn systemd on), then run the command again."
}

# Stops an old runner of your user: its systemd user service (any process left is stopped by the caller).
stop_legacy_services() {
  if user_systemd_works; then systemctl --user disable --now aom-runner >/dev/null 2>&1 || true; fi
}

# The system service of the dedicated user: guildwise-admin writes the unit (User=guildwise-runner, the runner root below)
# and enables and starts it; a restart picks up an upgraded runner. A named instance (--instance <name>) has its own
# service, guildwise-runner-<name>, and never touches another runner's.
# Stops the dedicated user's system service (if there is one yet).
stop_dedicated_service() { as_root systemctl stop "${DEDICATED_SERVICE}.service" >/dev/null 2>&1 || true; }

install_dedicated_service() {
  run_admin service install --runner-root "${RUNNER_ROOT}" ${RUNNER_CA:+--ca-file "${RUNNER_CA}"} --start ||
    die "guildwise-admin could not install the ${DEDICATED_SERVICE} service." "Run: sudo ${ADMIN_HINT} service install --runner-root ${RUNNER_ROOT} --start   to see why, then run the command again."
  as_root systemctl restart "${DEDICATED_SERVICE}.service" ||
    die "The service could not be started." "Run \`sudo systemctl status ${DEDICATED_SERVICE}\` to see why, then run the command again."
  good "Service enabled and started (system service \"${DEDICATED_SERVICE}\", running as ${RUNNER_NAME})"
  SERVICE_MODE=systemd; record_service_mode systemd
  report "Service" ok "systemd system service running as ${RUNNER_NAME}"
}

install_service() {
  if [ -n "${RUNNER_AS}" ]; then install_dedicated_service; return; fi
  write_unit_file
  if user_systemd_works; then
    systemctl --user daemon-reload
    systemctl --user enable aom-runner >/dev/null 2>&1
    systemctl --user restart aom-runner || die "The service could not be started." "Run \`systemctl --user status aom-runner\` to see why, then run the command again."
    good "Service enabled and started (systemd user service \"aom-runner\")"
    if enable_linger; then good "Lingering is on: the runner keeps running when you log out and starts at boot"
    else step_warn "Could not turn on lingering. Run \`sudo loginctl enable-linger $(id -un)\` so the runner survives logging out."; fi
    SERVICE_MODE=systemd; record_service_mode systemd
    report "Service" ok "systemd user service running"
  else
    write_fallback_launcher
    if [ "${IN_WSL}" = 1 ]; then
      step_warn "systemd is not running in this WSL distribution, so the runner was started in the background only. Enable systemd=true in /etc/wsl.conf, run \`wsl --shutdown\` in Windows, and run the command again."
    else
      step_warn "systemd is not running here, so no service was installed. The service file is ready in ~/.config/systemd/user; the runner was started in the background."
    fi
    "${FALLBACK_LAUNCHER}"
    SERVICE_MODE=background; record_service_mode background
    report "Service" warn "systemd unavailable; started in the background"
  fi
}

main() {
  parse_flags "$@"
  if [ "${OPT_LEGACY_ONLY}" = 1 ]; then legacy_only; return 0; fi
  STEP_TOTAL=16
  say "${C_BOLD}${APP_NAME}: set up this computer as a workstation${C_RESET}"
  say "${C_DIM}Safe to run again at any time: it upgrades or repairs what is already here.${C_RESET}"
  report "installer" start "linux"

  step "Checking this computer"; detect_system
  step "Looking for an older runner"; handle_legacy; choose_runner_user
  step "Administrator rights (once)"; authorize_once; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"
  step "Installing the baseline"; install_baseline
  step "Installing Node 22"; install_node
  step "Optional extras"; install_ytdlp
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
  if wait_until_connected; then good "The runner is connected to ${SERVER_URL}"; report "Connected" ok "runner connected"
  else step_warn "The runner has not connected yet. Give it a minute; the checks below say more."; fi
  DOCTOR_FAILED=0
  run_doctor || DOCTOR_FAILED=1
  summary
  [ "${DOCTOR_FAILED}" = 0 ] || exit 2
}

main "$@"
