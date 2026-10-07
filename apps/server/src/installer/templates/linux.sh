# ---------------------------------------------------------------------------------------------------------------------
# Linux (and Windows via WSL2): Node 22, git, Claude Code, sandbox tools, the runner, a systemd user service.
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

# Package names per tool (the program name is not always the package name).
pkg_for() {
  case "$1" in
    bwrap) echo bubblewrap ;;
    docker) if [ "${PKG}" = apt ]; then echo docker.io; else echo docker; fi ;;
    *) echo "$1" ;;
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

install_system_packages() {
  local missing=() tool
  for tool in curl git tar gzip socat bwrap; do have "${tool}" || missing+=("$(pkg_for "${tool}")"); done
  if [ "${#missing[@]}" -eq 0 ]; then
    ensure_modern_git
    step_ok "git $(git --version | sed 's/git version //'), curl and the sandbox tools (bubblewrap, socat) are ready"
    return
  fi
  note "Installing: ${missing[*]} (this may ask for your password)"
  pkg_install "${missing[@]}" || die "Installing ${missing[*]} failed." "Run the command again; if it repeats, install them by hand and run it once more."
  for tool in curl git tar gzip socat bwrap; do have "${tool}" || die "${tool} is still missing after the install." "Install it by hand, then run the command again."; done
  ensure_modern_git
  step_ok "Installed ${missing[*]}"
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

install_docker() {
  if have docker; then good "Docker is already installed"; return; fi
  if ! ask_yn "Install Docker? Only needed if your testers run containers. It needs administrator rights. Optional." n GUILDWISE_WITH_DOCKER; then
    note "Skipped Docker. You can add it later."; report "Docker" info "skipped"; return
  fi
  pkg_install "$(pkg_for docker)" || { step_warn "Could not install Docker. Install it by hand if you need it."; return; }
  if [ -n "${SUDO}" ]; then ${SUDO} usermod -aG docker "$(id -un)" 2>/dev/null || true; fi
  good "Docker installed (log out and in again so your user may use it)"
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
ExecStart="${RUNNER_ROOT}/current/aom-runner" start
Restart=always
RestartSec=10
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
mkdir -p "${DATA_DIR}/logs"
if [ -f "${DATA_DIR}/status.json" ] && kill -0 "\$(sed -n 's/.*"pid": *\\([0-9]*\\).*/\\1/p' "${DATA_DIR}/status.json")" 2>/dev/null; then exit 0; fi
nohup "${RUNNER_ROOT}/current/aom-runner" start >>"${DATA_DIR}/logs/service.log" 2>&1 &
LAUNCH
  chmod +x "${f}"
  FALLBACK_LAUNCHER="${f}"
}

install_service() {
  write_unit_file
  if user_systemd_works; then
    systemctl --user daemon-reload
    systemctl --user enable aom-runner >/dev/null 2>&1
    systemctl --user restart aom-runner || die "The service could not be started." "Run \`systemctl --user status aom-runner\` to see why, then run the command again."
    good "Service enabled and started (systemd user service \"aom-runner\")"
    if enable_linger; then good "Lingering is on: the runner keeps running when you log out and starts at boot"
    else step_warn "Could not turn on lingering. Run \`sudo loginctl enable-linger $(id -un)\` so the runner survives logging out."; fi
    SERVICE_MODE=systemd
    report "Service" ok "systemd user service running"
  else
    write_fallback_launcher
    if [ "${IN_WSL}" = 1 ]; then
      step_warn "systemd is not running in this WSL distribution, so the runner was started in the background only. Enable systemd=true in /etc/wsl.conf, run \`wsl --shutdown\` in Windows, and run the command again."
    else
      step_warn "systemd is not running here, so no service was installed. The service file is ready in ~/.config/systemd/user; the runner was started in the background."
    fi
    "${FALLBACK_LAUNCHER}"
    SERVICE_MODE=background
    report "Service" warn "systemd unavailable; started in the background"
  fi
}

main() {
  STEP_TOTAL=10
  say "${C_BOLD}${APP_NAME}: set up this computer as a workstation${C_RESET}"
  say "${C_DIM}Safe to run again at any time: it upgrades or repairs what is already here.${C_RESET}"
  report "installer" start "linux"

  step "Checking this computer"; detect_system
  step "Installing git and the sandbox tools"; install_system_packages
  step "Installing Node 22"; install_node
  step "Installing Claude Code"; install_claude_code
  step "Optional extras"; install_ytdlp; install_docker
  step "Downloading the runner"; install_runner_release
  step "Pairing with ${APP_NAME}"; pair_runner
  step "Choosing your code folders"; add_repo_folders
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
