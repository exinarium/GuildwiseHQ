# Guildwise HQ — Runner Guide

The runner is a Node.js CLI that runs on your workstation, connects to the server over WebSocket, and executes agent shifts. Each shift runs an agent in an isolated git worktree with its own home directory and config.

## Installation and setup

### Requirements

- **Node 22.23** (use `nvm use` or download from https://nodejs.org)
- **Git 2.40 or later** (for worktree support)
- **Docker** (optional; needed for testers to run containers)

### Guided install (recommended)

The app generates an installer for each workstation: **Workstations, Add a workstation** (see "Add a workstation" in `docs/USER-GUIDE.md`). It gives you either a one-line command or a script to download:

```sh
curl -fsSL 'https://aom.example.com/install/<short-lived-token>/install.sh' | bash        # Linux, macOS (install-mac.sh), WSL2
irm 'https://aom.example.com/install/<short-lived-token>/install.ps1' | iex               # Windows (PowerShell)
```

The link works for 30 minutes. The script embeds the server URL, a fresh **single-use pairing code** made for that wizard session (only its hash is stored) and the checksum of the runner release; it embeds no long-lived secret. Each time a link is opened a new code is minted and the previous one stops working, and starting the wizard again retires the older unused codes.

**What the Linux installer does** (also run inside Ubuntu by the Windows script), each step shown and reported to the wizard page:

1. checks the system (64-bit, not root, apt, dnf or pacman);
2. installs git, curl, tar, `bubblewrap` and `socat` with the package manager (sudo); git older than 2.40 (Ubuntu 22.04, Debian 12) is replaced by the git-core PPA build or, on Debian, a pinned and checksummed git compiled into `~/.local`;
3. uses Node 22 if present, otherwise installs it with nvm;
4. installs Claude Code (`npm install -g @anthropic-ai/claude-code`);
5. optionally installs yt-dlp (asks, default yes) and Docker (asks, default no);
6. downloads `aom-runner-<version>.tgz` from the app, verifies its sha256 against the value embedded in the script and unpacks it to `~/.local/share/guildwise/runner/<version>` (`current` points at the active version; `~/.local/bin/aom-runner` and `aom` link to it);
7. pairs (`aom-runner pair`) with the workstation the one-time code belongs to. A machine that already has a runner (any server or organization) keeps it: the installer upgrades it only if the server offers a newer version, and the new code pairs it with the new workstation instead of failing or installing a second copy; a code that was already used (the same command run again) is reported and the existing pairing stays;
8. asks which folders hold your code (suggests `~/src`) and runs `aom-runner repos add` for each;
9. walks you through the `claude` sign-in: subscription (browser login, usage counts against your plan) or API key (stored in `config.json`, mode 0600), or later;
10. installs the systemd **user service** `aom-runner` (unit in `~/.config/systemd/user`, `PATH` set to the Node and Claude directories), enables lingering (`loginctl enable-linger`) so it survives logout and starts at boot, waits for the runner to connect and runs `aom-runner doctor`, streaming each line to the wizard.

Without a running systemd (a container, or WSL without `systemd=true`) the unit file is still written, the runner is started in the background with `~/.local/share/guildwise/runner/start-runner.sh` and the summary says so.

**macOS:** the same flow with Homebrew (installed if missing, after asking), `node@22` and `git`, no `bubblewrap` or `socat` (Seatbelt is built in), and a **launchd** agent `com.guildwisehq.runner` in `~/Library/LaunchAgents` (starts at login, restarts if it stops; log in `~/.aom-runner/logs/runner.log`).

**Windows:** the PowerShell script elevates itself, enables WSL2 and installs Ubuntu if needed (when Windows has to restart it registers a `RunOnce` entry and continues after you sign in; a copy of the script and the Linux installer are kept in `%LOCALAPPDATA%\GuildwiseHQ`), creates the Ubuntu user if the distribution has only root, sets `systemd=true` in `/etc/wsl.conf`, sets `vmIdleTimeout=-1` in `%USERPROFILE%\.wslconfig`, registers the **"Guildwise HQ runner"** scheduled task (at logon: `wsl.exe -d Ubuntu --exec sleep infinity`) and, on an upgrade or re-run, removes the old **"WSL Boot"** task when its action is that same command for this distribution, turns lingering on for the Ubuntu user and runs the Linux installer inside Ubuntu.

All installers are **idempotent**: running the command again upgrades the runner, repairs the service and keeps the existing pairing(s) and adds the new one when the command carries a fresh code. They finish with a success or failure summary that links to the install help (`/help/install-troubleshooting`) and Contact us (`/contact`).

Environment variables the Linux and macOS scripts understand (unattended installs and tests): `GUILDWISE_YES=1` (take every default, never ask), `GUILDWISE_NAME` (workstation name), `GUILDWISE_REPO_DIRS` (space-separated folders), `GUILDWISE_WITH_YTDLP`, `GUILDWISE_WITH_DOCKER`, `GUILDWISE_WITH_HOMEBREW` (1 or 0), `GUILDWISE_MOCK=1` (enable the mock runtime), `GUILDWISE_SKIP_CLAUDE=1` (skip the sign-in), `GUILDWISE_SKIP_CLAUDE_INSTALL=1`, `GUILDWISE_ALLOW_ROOT=1`.

**Server side.** The app serves the release it finds in `AOM_RUNNER_RELEASE_DIR` (the Docker image builds one into `/app/release`; otherwise `release/` next to the working directory or the repository, as made by `pnpm package:runner`): `GET /api/runner/release` (version, sha256, size, URL), `GET /api/runner/release/aom-runner-<version>.tgz` and `.tgz.sha256`. The newest version wins. Without a release the wizard says so and the installers stop with a clear message.

**Testing the installers.** `scripts/lint-installers.sh` renders them and runs `bash -n`, shellcheck (local, else the `koalaman/shellcheck` image) and, when `pwsh` is installed, the PowerShell parser and PSScriptAnalyzer. `scripts/test-installer-docker.sh` runs the Linux installer for real in throwaway containers (ubuntu:24.04, debian:12) against a running server, with the mock runtime and no Claude sign-in, and then runs it a second time to prove the upgrade path. Never run an installer on your own machine to test it.

### Getting the runner

Build it from source:
```sh
pnpm package:runner      # outputs release/aom-runner-<version>.tgz
```

Or download a pre-built binary from your system (available after deployment).

### Windows: run the runner inside WSL2

This is the default and recommended setup for a Windows workstation. Claude Code's sandbox runs on macOS (Seatbelt) and
on Linux/WSL2 (bubblewrap + socat) but not on native Windows, where Claude Code runs commands unsandboxed (see
https://code.claude.com/docs/en/sandboxing). Inside WSL2 the runner gets the same OS-level boundary as on Linux:
agents cannot read the runner token, your SSH keys or anything else outside their worktree. On native Windows the
runtime reports itself unavailable (no agent is scheduled) unless you opt out explicitly, see
[Native Windows (unsandboxed, not recommended)](#native-windows-unsandboxed-not-recommended).

macOS needs none of this: it uses the built-in Seatbelt sandbox and no extra installs. Linux needs `bubblewrap` and
`socat` (step 4).

1. **Enable WSL2.** In an administrator PowerShell: `wsl --install -d Ubuntu`, then reboot when asked and create the Linux
   user when Ubuntu first starts. Check with `wsl -l -v` that Ubuntu runs as VERSION 2.
2. **Turn on systemd** (needed for the service in step 8). In Ubuntu, `sudo tee /etc/wsl.conf <<'EOF'` with the content
   `[boot]` and `systemd=true`, then in PowerShell `wsl --shutdown` and open Ubuntu again.
3. **Install the base tools** in Ubuntu: `sudo apt update && sudo apt install -y git curl ca-certificates`.
   Then GitHub CLI `gh` (follow https://github.com/cli/cli/blob/trunk/docs/install_linux.md) and `gh auth login`.
4. **Install the sandbox dependencies:** `sudo apt install -y bubblewrap socat`. (On Ubuntu 24.04 and later see the AppArmor
   note in the Claude Code sandboxing docs if `bwrap` is refused.)
5. **Install Node 22 with nvm:**
   `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`, open a new shell, then
   `nvm install 22 && nvm alias default 22`.
6. **Install Claude Code** (2.1.257 or newer): `npm install -g @anthropic-ai/claude-code`, run `claude` once to sign in (or
   put an OAuth token in the config, see Setting credentials).
7. **Clone your repositories inside the WSL filesystem** (`~/src`), never under `/mnt/c`: file access through `/mnt/c` is
   many times slower and breaks git file modes. Set up git identity and SSH keys inside Ubuntu too.
8. **Install, pair and run the runner inside Ubuntu:**
   ```sh
   cp /mnt/c/Users/you/Downloads/aom-runner-*.tgz ~ && tar xzf ~/aom-runner-*.tgz -C ~ && cd ~/aom-runner
   ./aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop (WSL2)"
   ./aom-runner repos add ~/src
   ./aom-runner doctor            # sandbox line must say "enforced"
   ```
   Then run it as a systemd user service, exactly as in "Run as a service" below (Linux). Make it survive logout with
   `sudo loginctl enable-linger $USER`. WSL2 shuts a distribution down when nothing is running in it; to keep the
   runner up from Windows login, add a Task Scheduler task "At log on" that runs
   `wsl.exe -d Ubuntu -- sleep infinity`.

`aom-runner doctor` prints the sandbox state and, on native Windows, these steps again. The Workstations page shows an
amber warning for any workstation whose runtime reports `unsandboxed`, and why when it reports `unavailable`.

### Native Windows (unsandboxed, not recommended)

Native Windows cannot sandbox agents. With the default `sandbox: "required"` the `claude-code` runtime reports
`unavailable` ("Native Windows: install the runner in WSL2") and no agent is scheduled on that workstation. To run agents
there anyway you must opt in explicitly in `config.json`:

```json
{ "runtimes": { "claude-code": { "sandbox": "best_effort", "allowUnsandboxed": true } } }
```

`best_effort` alone is not enough on a platform without a sandbox: without `allowUnsandboxed: true` the runtime stays
`unavailable` and the reason tells you to use WSL2 or set the flag. (`sandbox: "off"` is also an explicit opt-in and
reports `unsandboxed` everywhere.)

The risk: the permission rules and the minimal environment still apply, but there is no OS-level boundary. A
prompt-injected agent can read anything your Windows user can read: the runner token and provider credentials in
`config.json`, your SSH keys, browser profiles, other projects. Use a dedicated low-privilege Windows user for the runner if you
must do this. The web UI shows a non-dismissable warning on the workstation, on every affected agent card and on the Hire
form (hiring onto it needs a confirmation checkbox) for as long as the runner reports `unsandboxed`.

Install and pair natively as shown in "Install and pair" (Windows tab) and run it with Task Scheduler.

### Install and pair

Extract the tarball and run `pair`:

```sh
tar xzf aom-runner-0.1.0.tgz && cd aom-runner
./aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"
./aom-runner repos add ~/src ~/work    # scan for git repos (depth 3)
./aom-runner start                     # run in foreground or as a service
```

On native Windows (unsandboxed, not recommended; prefer WSL2 above):
```cmd
aom-runner.cmd pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"
aom-runner.cmd repos add C:\src
aom-runner.cmd start
```

The pairing code is valid for 10 minutes and valid for one pair attempt. See **Pairing** section below for details.

### Run as a service

Keep the runner running using systemd (Linux and WSL2), launchd (macOS), or Task Scheduler (native Windows, not recommended).

**Linux and WSL2 (systemd user service):**

Create `~/.config/systemd/user/aom-runner.service`:

```ini
[Unit]
Description=Guildwise HQ Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/you/aom-runner/aom-runner start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Enable and start:
```sh
systemctl --user enable aom-runner
systemctl --user start aom-runner
systemctl --user status aom-runner      # check status
journalctl --user -u aom-runner -f      # watch logs
```

**macOS (launchd):**

Create `~/Library/LaunchAgents/com.aom.runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aom.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/aom-runner/aom-runner</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/.aom-runner/logs/runner.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.aom-runner/logs/runner.log</string>
</dict>
</plist>
```

Enable and start:
```sh
launchctl load ~/Library/LaunchAgents/com.aom.runner.plist
launchctl start com.aom.runner
launchctl list | grep aom.runner      # check status
```

**Native Windows (Task Scheduler, unsandboxed, not recommended):**

1. Open Task Scheduler
2. Create Task
3. General tab: check "Run whether user is logged in or not"
4. Triggers tab: add trigger "At log on"
5. Actions tab: set program to `C:\Users\you\aom-runner\aom-runner.cmd` and arguments to `start --data-dir %LOCALAPPDATA%\aom-runner`
6. Click OK

## Updates

A runner installed by the guided installer updates itself. The updater lives in `apps/runner/src/update/` and is owned by the `start` process (one per machine, however many pairings it holds).

**The cycle.** A random 1 to 10 minutes after start, then every 24 hours (plus or minus 10%), the runner reads `GET /api/runner/release` of the first pairing's server: `{ version, sha256, size, url, autoUpdatePaused }`. The archive is one portable `.tgz` for every platform and architecture, so there is no per-platform URL. Versions are compared with semver rules (`0.1.10` is newer than `0.1.9`; a pre-release is older than its release). When the server's version is newer:

1. **Download and verify.** The archive is streamed to `<root>/.update-<version>/`, its sha256 is compared with the server's value, and only then unpacked. A mismatch (or a bad archive) discards everything, reports `failed` and leaves the running version untouched. The unpacked folder gets its final name `<root>/<version>/` only when complete.
2. **Wait for idle.** The runner is idle when no shift and no chat is running on any pairing. It polls every 30 seconds. After `maxIdleWait` (6 hours) of never being idle it updates anyway (running shifts are resumed after the restart like after any restart). The download happens before the wait, so the wait ends in an instant switch.
3. **Last look at the kill switch**, then write the probation marker, switch the `current` link and restart.

**Layout on disk** (same for a fresh install and for an upgrade of a 0.1.0 install, which already had the `<version>/aom-runner` folders and the `current` link):

```
~/.local/share/guildwise/runner/          (the "root")
  0.1.1/aom-runner/                       one unpacked release each (dist/, node_modules/, aom-runner launcher)
  0.1.0/aom-runner/
  current  -> 0.1.1/aom-runner            what the service starts
  previous -> 0.1.0/aom-runner            what a rollback goes back to
  service-mode                            systemd | launchd | background (written by the installer)
  start-runner.sh                         the background fallback (no service manager)
  update-pending                          key=value (from, to, deadline) while a new version is on probation
  update-failed                           key=value (version, at, reason) after a rollback
```

The `current` switch is atomic: a new symlink is created next to it and renamed over it. After the new version has connected, every version except `current` and `previous` is deleted. The installer (`switch_current` in `common.sh`) keeps the same invariants, clears the two marker files (an explicit install may try a rolled-back version again) and records the service mode.

**Restart.** The runner exits cleanly (exit code 0) and the service manager starts the new version: the systemd user unit has `Restart=always`, the launchd agent `KeepAlive`. In the background fallback (`start-runner.sh`, no service manager, e.g. WSL without systemd) the runner starts a detached helper that runs `start-runner.sh` five seconds after it has gone. The mode comes from `<root>/service-mode`; for a 0.1.0 install without that file it is inferred from the environment (`INVOCATION_ID`+`JOURNAL_STREAM` for systemd, `XPC_SERVICE_NAME` for launchd, the presence of `start-runner.sh`). On Windows the runner runs inside WSL2, so it follows the Linux rules; the Windows scheduled task only keeps WSL itself alive.

**Rollback.** The marker `update-pending` holds a 5 minute deadline. The new version deletes it (and prunes old versions) the first time any pairing completes the handshake with the server. Two things can roll back:

- *The new version runs but does not connect.* When the deadline passes, the in-process watchdog first checks that the server answers HTTP at all; if it does, `current` is switched back to `previous`, `update-failed` is written and the runner restarts. If the server is down it keeps waiting (an outage is not the update's fault).
- *The new version cannot even start (crash loop).* The `aom-runner` launcher script of the new version checks, on `aom-runner start`, whether it is the version named in `update-pending` and the deadline has passed; if so it switches `current` back, writes `update-failed` and runs the previous version instead.

After a rollback the failed version is not tried again on this machine (`update-failed`); a newer release is. The Workstations page then shows "Update rolled back".

**Kill switch.** A super admin can pause automatic updates under Platform, Runners (`GET/PUT /api/platform/runner-updates`; stored in `platform_settings` as `runners.auto_update_paused`). While paused, `/api/runner/release` returns `autoUpdatePaused: true`; runners that see it do not download, and one that already downloaded and is waiting for idle checks again right before the switch and drops the update. The tarball itself stays downloadable, so the installer still works. `AOM_RUNNER_AUTO_UPDATE=0` switches updating off on one machine.

**Not managed.** The runner does not update itself when it is not running from `<root>/<version>/aom-runner` with `<root>/current` pointing at it (a source checkout, a hand-copied folder), when it was not started by a service manager (nothing would restart it) or under `--mock`. It then reports `unmanaged`.

**Reporting.** The runner sends `runner.update` `{ state, latestVersion, lastCheckedAt, detail }` after each `welcome` and whenever the state changes; the server stores it on the workstation (`runner_update`) and the Workstations page shows it next to the runner version. States: `up_to_date`, `pending`, `updating`, `failed`, `rolled_back`, `paused`, `unmanaged`.

**Check for updates now.** The Workstations page has a **Check for updates** button next to the runner version. It sends the `runner.update.check` command (capability `update-check:1`, runner 0.1.34+) through any pairing; the `start` process calls `Updater.checkNow()`, which runs the same check as the timer and so the same pipeline (download, verify, wait for idle, switch). It only skips the timer: it never restarts a busy runner, the pause switch and `AOM_RUNNER_AUTO_UPDATE=0` still apply, and a check or download already in progress is joined, not repeated. The command's result is `{ outcome, version, detail }` with `outcome` one of `up_to_date`, `update_found` (downloaded or downloading, installs when idle), `paused`, `disabled` (switched off or not an installer-managed install) or `failed`; the runner logs one INFO line (`update check on request: ...`). The server accepts one request a minute per workstation, only while the runner is connected, and stores the answer on the workstation (`runner_update_check`).

**Releasing.** The version is `RUNNER_VERSION` in `apps/runner/src/version.ts`, and nothing is "newer" until it is raised: bump it, run `pnpm package:runner`, publish `release/aom-runner-<version>.tgz` to the server's release directory (`AOM_RUNNER_RELEASE_DIR`). Runners pick it up within a day. Pause updates first if you are unsure about a release.

## CEO full power

The Owner's own chat with the CEO can run as a real Claude Code session on the Owner's workstation (docs/design/ceo-front-door.md
sections 3 and 5). It is a cap the machine owner holds against any server:

- **Opt in locally:** `aom-runner ceo full-power on` (`off`, `status`). It sets `ceo.fullPower` in `config.json`; restart the
  runner so `hello` announces the `ceo-full-power:1` capability. Without it, an owner turn runs in the restricted CEO profile and
  the reply says "Full power is off on this workstation" (`chat.done.degraded = full_power_off`); an order turn is refused.
- **Who decides:** the server sets `ceoMode` (`owner` or `order`) on `chat.start`. The runner honours it only for the CEO agent, only
  with the opt-in, and (order turns) only when the order carries the Owner's mark and its text hashes to `versionHash`. Shifts
  (wakes) never get this profile, whatever their payload says.
- **The profile:** `claude -p ... --setting-sources user,project,local --permission-mode auto --permission-prompt-tool
  mcp__aom_permission__ask --allowedTools "Bash(aom:*)" --append-system-prompt-file <turn>/ceo-brief.md --settings <turn>/floor.json`.
  Your real `~/.claude` (settings, skills, plugins, MCP), your home directory and no Guildwise sandbox. The working directory is
  fixed per conversation (`ceo.settings.ownerTurn.cwd`, default your home) so `--resume` works. The turn directory
  `<data dir>/ceo-turns/<chat id>/` is removed afterwards.
- **Deny floor** (deny wins over your own rules): `systemctl ... aom-runner`, `pkill *aom*`, `kill <runner pid>`, and reading or
  editing the runner's `secrets/` and `config.json`. A restart goes through `aom runner restart`.
- **Permission relay:** when the session needs a permission it lacks, a small MCP server (`aom ceo-permission-mcp`) raises the desk
  question "authorize this execution"; an Owner or Admin answers it on the desk (once, for the turn, or deny; ten minutes without
  an answer is a deny). In order turns the question is raised and the step is denied at once (reported as waiting).
- **Use the system first:** a PreToolUse hook (`aom ceo guard`) blocks the first edit inside a repository clone of this workstation
  with the routing rule, once per turn; `aom ceo job start` opens it. A nudge, not a boundary.
- **A dropped connection does not cancel an owner turn:** the reply goes through the outbox and is delivered after the reconnect.
- **`aom runner restart [--reason ..]`** (owner turns and DevOps shifts): the restart waits until the reply is acknowledged by the
  server and the runner is idle (at most ten minutes), then the runner exits for its service manager (or the detached helper).

## Cloud workstations (VPS over SSH, GitHub Codespaces)

The user chooses where agents run (**Add a workstation**: My computer, A VPS (SSH), GitHub Codespaces). The runner makes outbound connections only, so a cloud machine needs no open port. Guide for a server you rent: `docs/BYO-VPS.md`. Design and server side: `docs/ARCHITECTURE.md` 11.4.

### `aom-runner up`: pair if needed, then run

```
GUILDWISE_SERVER=https://app.example.com GUILDWISE_PAIR_CODE=ABCD-EFGH GUILDWISE_NAME="Build server" aom-runner up
```

Idempotent and safe at every boot. If the data directory already has a (not disabled) pairing for the server, it only starts (the single-use code is ignored). Otherwise it pairs with `GUILDWISE_PAIR_CODE` (or `--code`), or, inside a Codespace the server created, **enrolls** with `CODESPACE_NAME` and `GITHUB_TOKEN` (which GitHub sets in every codespace): `POST /api/runner/enroll`, no code needed. Then it runs like `aom-runner start`. Flags: `--server`, `--code`, `--name`, `--mock`, `--data-dir`.

### Claude credentials on a cloud workstation

The server never receives or stores a Claude credential.

- `ANTHROPIC_API_KEY` in the environment of `up` (a Codespaces secret) is written into this machine's `config.json` (mode 0600, `authMode: api_key`).
- `CLAUDE_CODE_OAUTH_TOKEN` likewise (`authMode: oauth`; a subscription token, individual use).
- `aom-runner auth api-key` / `aom-runner auth oauth-token` read the value from stdin and store it in `secrets/claude.json` (mode 0600): `read -rs K; printf %s "$K" | aom-runner auth api-key`. A running runner uses it from the next session; no restart is needed.
- From the web: the Integrations page can do the same without a terminal (API key, a token made elsewhere, or `claude setup-token` driven by the runner). See "Integrations (connect from the web)".
- The default recommended in the app is the customer's own API key; a subscription login is allowed with an "individual use" warning.

### `aom-runner devcontainer [path] --server <url>`

Prints a `devcontainer.json` for the repository at `path` (default `.`), with dev container features chosen from the toolchain detection (`src/toolchain/stacks.ts`: .NET, Python, Go, Rust, Java, Ruby, PHP on top of Node, git and the GitHub CLI). Its `postStartCommand` is `curl -fsSL <server>/api/runner/codespaces-bootstrap.sh | bash`: that script (served by the server, no secret in it) installs the runner release (checksum verified) into `~/.aom-runner-install` and starts `aom-runner up` in the background. Docker is not offered in a Codespace. `runArgs` carries `--security-opt seccomp=unconfined` so the agent sandbox (bubblewrap) can create user namespaces; confirm it works in your codespace with `aom-runner doctor`.

### Sleeping and waking

Handled by the server (`docs/ARCHITECTURE.md` 11.4): a Codespace is stopped after 30 minutes (configurable) with no open shift and woken when a card is queued for an agent on it. The runner reconnects by itself when the machine wakes (the data directory, including `config.json`, survives stop and start; a rebuild of the codespace wipes the home folder and enrolls again). GitHub also stops a codespace after at most four hours without user activity, headless runner or not; a shift running then is recovered by the lease and reaper (`runner_lost_shift`). Keep-alive tricks are deliberately not shipped.

## Several pairings (one runner, several accounts or organizations)

One runner process on a machine can be paired with more than one workstation: for example your own organization on one server and a client's account on another, or a second account on the same server. Each pairing is a separate workstation on the server side (a workstation belongs to one user; the same machine simply appears once per pairing), and on the machine each pairing is **fully isolated**.

Note that you do **not** need a second pairing for a second organization of the same account: a workstation is owned by a user, not by an organization, and already serves every organization that user belongs to (each organization gets its own DevOps engineer on it, and projects of any of those organizations share it). A second pairing is for a different account or server.

```sh
aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Acme desk"   # the first pairing
aom-runner pair --server https://hq.client.example --code YYYY-YYYY --name "Client desk" # adds a second; the first is untouched
aom-runner pairings                      # id, name, server, workstation id, state, data directory
aom-runner status [--pairing <id|name>]  # one block per pairing
aom-runner unpair "Client desk" [--purge] # forget it on this machine
```

- **What a pairing is.** `pairings.json` in the data directory lists them (`id`, `label`, `dir`, `serverUrl`, `workstationId`). The installer's pairing command is the same `pair`: running the install command on a machine that already has a runner keeps that runner, upgrades it only when the server offers a newer version, and **adds** the new workstation as another pairing. The same server and the same workstation name again is a re-pair of that pairing (new credentials, settings and data kept). `--pairing` takes the id, the name, the workstation id or an unambiguous prefix.
- **Where things live.** The first pairing stays in the data directory itself (`config.json`, `agents/`, `worktrees/`, `vaults/`, `outbox/`, `logs/`), exactly where a single-pairing runner always kept it. Later pairings live in `pairings/<id>/` with the same layout. A data directory from before pairings is migrated in place on first use: only `pairings.json` is created around it, nothing is moved or rewritten, and an older runner that ignores the index keeps working on the first pairing.
- **Isolation per pairing.** Own `config.json` (server, token, Jira token, Claude API key or OAuth token), own agent homes, worktrees, vault clones, integration worktrees, outbox, outbound records, logs and status file, and its own IPC server and shift tokens. Nothing a shift of one pairing can reach is shared with another pairing's directory, and each connects to its server with its own token. A new pairing inherits only non-secret settings from the first one (code folders, concurrency limit, sandbox and runtime options); credentials are never copied (an API key or OAuth token setting falls back to the machine's own `claude` login), so give it its own with `aom-runner` config under `pairings/<id>/config.json` if it needs one. Code folders added with `aom-runner repos add` go to every pairing unless `--pairing` names one (a repository checked out once can be seen by several pairings; their worktrees are separate).
- **One process, one connection per pairing.** `aom-runner start` (the service) runs one connection per pairing in the same process; it does not multiplex. A pairing added or removed with `pair`/`unpair`, or re-paired, is picked up by the running process within about five seconds without disconnecting the others. If the server unpairs one workstation, only that pairing stops (it is marked `unpaired` in `pairings.json` and is not retried); the process exits only when no pairing is left, with the usual exit code 0 for an unpair, and a service manager is not asked to restart a runner that cannot work.
- **Concurrency budget.** The machine's shift limit is shared: a pairing may run its own `maxConcurrentShifts` (and what its server allows) as long as the pairings together stay under the machine limit, which is `maxConcurrentShifts` in `pairings.json` or, when unset, the largest per-pairing limit. First come, first served: when the limit is reached a shift offered to another pairing is rejected as `busy` and its card waits, exactly as at the per-workstation limit. There is no reservation per pairing.
- **Not supported.** Two runner processes on the same data directory (use one process); the same workstation paired twice on the same server under different names (it would connect twice and the second supersedes the first, exit code 3 for that pairing only).

## Data directory structure

The runner stores all data in `~/.aom-runner` (Linux/macOS) or `%LOCALAPPDATA%\aom-runner` (Windows). You can override with `--data-dir <path>` or `AOM_RUNNER_HOME` env var.

```
config.json                     runner config of the first pairing (mode 0600: server URL, token, repos, runtimes)
pairings.json                   the pairings of this machine (see "Several pairings"); later ones live in pairings/<id>/ with this same layout
status.json                     updated by start (process state, connection status)
outbox/                         pending messages (persisted, retried on reconnect)
agents/
  <agentId>/
    home/                       HOME for the agent (contains the .gitconfig with the commit identity)
    claude/                     CLAUDE_CONFIG_DIR (credentials, memory, cache)
    claude-acct-<key>/          the same agent's CLAUDE_CONFIG_DIR on an additional Claude account (see "Claude accounts")
    scratch/                    working directory for the agent's own files
cache/                          package caches shared by all agents of this runner (nuget, npm, pnpm, pip, gradle, maven, ...)
worktrees/
  <PROJECT>-<number>/
    aom/toy-1-...               git worktrees on branch aom/<ref>-<slug>
    aom/toy-2-...
    run-<envId8>/<repo>/        detached run worktrees of a run environment (no branch)
runs/
  <envId>/                      one run environment ("Run a branch"): state.json, <service>.log (+ .1), steps/
mock-state/                     per-card attempt counters for mock script (test only)
vaults/<vaultId>/               local vault folders (storage "local"; not synced, see "Project graphs")
graph-cache/<repoKey>/          the project graph indexer's per-file cache (rebuildable, see "Project graphs")
sessions.json                   the Claude sessions this runner started (agent, folder, start, context size): what a resume request is checked against
claude-accounts-state.json      the usage limit and expired logins of each Claude account (kept across restarts)
claude-credentials.lock         lock for the main account's credential copies (additional accounts lock inside their own folder)
secrets/claude-accounts/        token accounts only: <key>.json (mode 0600)
logs/
  runner.log                    JSON Lines log of runner events
  devops-audit.jsonl            every shell command of the DevOps engineer, allowed or refused (see "DevOps guardrails")
  shifts/
    <shiftId>.jsonl             raw runtime output for each shift
```

## Configuration

The runner config is stored in `config.json` (mode 0600: readable/writable by owner only).

### Viewing and checking config

```sh
aom-runner status             # shows config summary and process state
aom-runner doctor             # checks node, git, claude, docker, yt-dlp, repos, server
```

### Config file format

```json
{
  "serverUrl": "https://aom.example.com",
  "workstationId": "...",
  "runnerToken": "...",
  "repoRoots": [
    "/home/you/src",
    "/home/you/work"
  ],
  "runtimes": {
    "claude-code": {
      "bin": "claude",
      "authMode": "oauth",
      "oauthToken": "...",
      "intake": {
        "mcpConfig": "/path/to/mcp-config.json",
        "allowedTools": ["mcp__jira", "WebFetch"]
      }
    },
    "mock": {
      "enabled": false,
      "capabilities": ["builder", "reviewer"]
    }
  },
  "jira": {
    "baseUrl": "https://jira.example.com",
    "email": "your-email@example.com",
    "apiToken": "..."
  },
  "maxConcurrentShifts": 4,
  "vaultSyncIntervalSec": 300
}
```

### Configuration keys

#### Server and auth
- **serverUrl** (required): server URL, e.g., `https://aom.example.com`
- **workstationId** (required): UUID issued during pairing
- **runnerToken** (required): WebSocket auth token (keep secret, stored mode 0600)

#### Repositories
- **orgSourceFolders** (object, default `{}`): `{ "<organization id>": "<folder>" }`. Every git repository under the folder is readable (read-only, secret files blocked) by the architect of that organization, in card shifts and chats. The folder must sit **inside** one of the `repoRoots` (not be a root itself) and may never be, contain or lie in the home directory, the runner's data directory or a credentials folder (`~/.ssh`, ...); real paths are compared, so a symlink cannot lead out. Set it with `aom-runner org-folder set <organization-id> <path>` (also `clear` and `list`) or, for the workstation's owner, with the **Organisation source folder** row on the Workstations page (the `org.folder` command, below); the runner reads it again at every shift, so no restart is needed. Both go through the same check (`changeOrgFolder` in `org-folder.ts`), so the runner remains the authority. See "The architect: organization source folder, git and the main merge".
- **repoRoots** (array, default `[]`): folders to scan for git repositories (recursively, depth 3). It only says where repositories are found and cloned; it does not let agents read them (see "Reference repositories and other read-only folders")

#### Runtimes

**Claude Code** (the default):
- **bin** (default `"claude"`): path or command to the claude CLI
- **authMode** (default `"default"`):
  - `"oauth"`: use `oauthToken` (from `claude setup-token`)
  - `"api_key"`: use `apiKey` (Jira Data Center, self-hosted)
  - `"default"`: each agent gets a private copy of your `~/.claude/.credentials.json` (not a symlink)
- **oauthToken** (optional): from `claude setup-token` (when authMode is `"oauth"`)
- **apiKey** (optional): API key (when authMode is `"api_key"`)
- **intake** (optional, M7): MCP integration for BA intake
  - **mcpConfig**: path to MCP config file with Jira server and credentials
  - **allowedTools** (array): tools the intake chat can use (`mcp__jira`, `WebFetch`, etc.)

**Codex CLI** (`runtimes.codex`, optional; see "Codex CLI runtime"). The runtime is registered only when the `codex` binary is found, so a workstation without it needs no block:
- **enabled** (default `true`): `false` never registers it, even when `codex` is installed
- **bin** (optional): path of the `codex` binary (`~` allowed); default: the first `codex` on `PATH`
- **authMode** (default `"login"`): `"login"` uses the runner user's own `codex login`; `"api_key"` passes **apiKey** as `CODEX_API_KEY`
- **apiKey** (optional): the OpenAI API key (when authMode is `"api_key"`; keep `config.json` at 0600)
- **loginDir** (optional): the folder with the owner's `auth.json` (default `$CODEX_HOME`, else `~/.codex`)
- **toolchainPaths** (array): extra toolchain folders the sandboxed shell may read, as for Claude Code

**Gemini CLI** (`runtimes.gemini`, optional; see "Gemini CLI runtime"). Registered only when the `gemini` binary is found:
- **enabled** (default `true`), **bin** (optional path, `~` allowed; default the first `gemini` on `PATH`)
- **authMode** (default `"auto"`): `"auto"` uses the owner's Google login when there is one, else the stored `google` key; `"login"` only the login; `"api_key"` only the stored key (workstation key over organization key)
- **loginDir** (optional): the owner's `.gemini` folder (default `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`)
- **toolchainPaths**, **extraAllowedDomains** (arrays), **models** (extra model ids offered for picking)

**opencode** (`runtimes.opencode`, optional; see "opencode runtime"). Registered only when the `opencode` binary is found: **enabled**, **bin**, **toolchainPaths**, **extraAllowedDomains** as above. Its providers are the keys held under Model providers.

**Mock** (test-only, token-free):
- **enabled** (default `false`): turn on for testing
- **capabilities** (optional array): limit advertised roles (e.g., `["builder"]`)

#### External integrations

**Jira** (posting approved updates, and downloading ticket attachments for agents; optional). Set it up with
`aom-runner jira-connect` (see "Jira on the runner" below): the token is then stored in `secrets/jira.json`, not here.
The older `jira` block in `config.json` is still read when there is no `secrets/jira.json`:
- **baseUrl** (required): Jira server URL
- **email** (optional): Jira Cloud username (if provided, use basic auth)
- **apiToken** (required): Jira Cloud API token or Data Center personal access token

GitHub uses your machine's `gh` CLI login (run `gh auth login` once).

#### Agent and vault settings
- **maxConcurrentShifts** (default `4`): max agent shifts this workstation runs at once; a shift offered beyond it is rejected as `busy` and the card waits. The runner announces it in `hello`, the Workstations page shows `running of limit`, and the server caps it at `AOM_MAX_SHIFTS_PER_WORKSTATION` (default 16). This is the fallback: the workstation's owner can set **Shifts at once** (a number or Unlimited) on the Workstations page, and that choice replaces this value without a restart (see below). Restart the runner after changing the config value.
- **Shifts at once from the Workstations page** (backlog #76). A runner that announces the `shift-limit:1` capability (releases after 0.1.20) takes the owner's choice from the server: it arrives in `welcome` (`limits.shiftLimit`: a number, `"unlimited"` or null) and, when changed while connected, as the `shifts.limit` command. The runner applies it to the next shift offered, with no restart, and keeps it in `server-limits.json` in its data directory so it holds after a restart before the server has answered. `limits.maxConcurrentShifts` is what the server enforces (the choice under the platform ceiling; unlimited is 100,000); the dispatcher also stops offering shifts to a full workstation. With no choice (null), or an older server that sends none, `maxConcurrentShifts` above is used, under what the server allows. An older runner ignores the choice and keeps its own value; the Workstations page says so. In a runner with several pairings, the machine limit (`pairings.json`) is the largest of the configured and the granted values unless it is set explicitly. Unlimited removes Guildwise's own cap only: memory, CPU and the model usage limit remain, and `AOM_MAX_SHIFTS_PER_WORKSTATION` stays a platform ceiling the super admin controls (`0` = no ceiling).
- **vaultSyncIntervalSec** (default `300`): how often to pull/commit/push vaults
- **maxRunEnvironments** (default `2`): how many run environments this workstation holds at once ("Run a branch", below). The runner announces it in `hello`; a start beyond it is refused with the list of what runs. Restart the runner after changing it.
- **runPortRange** (default `{ "from": 20000, "to": 29999 }`): where ports are allocated from when a service's default port is taken.

### Setting credentials

Use the app (Integrations page, see "Integrations (connect from the web)") or the commands below. The credentials are kept in
the `secrets/` folder of the pairing (mode 0600); editing `config.json` by hand still works and is the fallback when the secrets
file has no credential.

**OAuth token (recommended for Claude Code):**
1. Run `claude setup-token` to get a token (or let the Integrations page do it: "Sign in with your Claude subscription")
2. `printf %s "$TOKEN" | aom-runner auth oauth-token` (stored in `secrets/claude.json`; no restart needed). The older form, in `config.json`, still works:
   ```json
   { "runtimes": { "claude-code": { "authMode": "oauth", "oauthToken": "..." } } }
   ```

The token from `claude setup-token` is the most robust choice: it does not expire the way an interactive login does
(see "The Claude login: expiry, pause and resume").

**Jira API token:**
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Create a token and copy it
3. Run `aom-runner jira-connect` (base URL, your Atlassian e-mail, the token; see "Jira on the runner").
   Writing `{ "jira": { "baseUrl": "...", "email": "...", "apiToken": "..." } }` into config.json still works
   but keeps the token in the main config file; prefer the command.

**Git hosts (pull requests, repository list and creation):** the git host is chosen per project repository (GitHub, GitLab, Bitbucket Cloud, Azure DevOps, or plain git). Connect each one you use, on this workstation, with

```
aom-runner git-connect github                 # runs `gh auth login --web`
aom-runner git-connect gitlab [--host git.example.com]   # `glab auth login`, or paste a personal access token
aom-runner git-connect bitbucket-cloud        # Atlassian e-mail + API token (app passwords no longer work)
aom-runner git-connect azure-devops           # uses a Microsoft Entra service principal from the environment, or `az login`; or --organization acme and a PAT (fallback)
aom-runner git-connect <provider> --ssh       # SSH instead of a token: create ~/.ssh/aom_<provider>, print the public key and where to add it, make SSH this workstation's default, then check it
aom-runner git-connect <provider> --ssh --key-file ~/.ssh/id_ed25519   # use a key you already have (not copied, only its path is kept)
aom-runner git-connect <provider> --ssh --agent                        # use your ssh-agent / ~/.ssh/config
aom-runner git-connect <provider> --check [<repo-url>]                 # does SSH work? (git ls-remote on the repo, else ssh -T); exit 1 if not
aom-runner git-connect <provider> --default https                      # keep tokens / the CLI login as the default for new clones
aom-runner git-connect <provider> --status    # connected or not
aom-runner git-connect <provider> --disconnect  # forget a saved token
```

**SSH instead of an API token.** Some owners already have SSH keys and do not want to create tokens. Per git host the runner keeps the *default access method for new clones* (`https` with the token or CLI login, or `ssh`) and which key to use: one it generated (`~/.ssh/aom_<provider>`, ed25519, no passphrase), a key file you name, or your ssh-agent. This is kept in `<data dir>/secrets/git-ssh.json` (paths and the last check result only, no key material). A repository can override the default (project settings, Repositories, Access); the web app sends `repo.access` and the runner changes the clone's `origin` between `https://github.com/acme/web.git` and `git@github.com:acme/web.git` (Bitbucket `git@bitbucket.org:ws/repo.git`, Azure DevOps `git@ssh.dev.azure.com:v3/org/project/repo`, GitLab `git@host:group/sub/repo.git`; for Bitbucket Data Center the ssh port is not in the https address, so add the repository with its ssh URL).

How git runs over SSH: for an ssh remote the runner sets `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=<data dir>/secrets/known_hosts -o BatchMode=yes -o ConnectTimeout=20"` (no `-i` for the ssh-agent). The first contact with a host is accepted and remembered, a changed host key is refused (the check reports it). A clone made or switched to SSH also gets `core.sshCommand` with the same value in its local git config, so every git command the runner runs in the clone and its worktrees (fetch before a card starts, rebase, push or merge at completion, hygiene) uses the key without each call passing it. Agents never read the key: their sandbox denies `~/.ssh` and the data directory, so an agent's own `git fetch`/`git push` cannot authenticate (pushes are denied for agents anyway); the runner does the network work for them. The DevOps engineer runs outside the sandbox with your own privileges, as before.

What SSH does not cover: pull requests, branch rules and the repository list use the host's REST API and so still need the token or CLI login. With SSH only, finishing a card pushes the branch and the notice says the pull request must be opened by hand (the manager does it); a merge straight into the working branch works as long as the branch is not protected. The Workstations page (Git hosts, SSH) shows the public key to add on the host, the default and the last check (`SSH works`, `The host refused the key`, `Host key changed`, `Host not reachable`, `No key yet`, `ssh is not installed`); the same button queues the runner command `git.ssh` (`prepare`, `save`, `check`).

The command prints the steps, reads a token without echoing it and checks it against the provider before saving it. Tokens live in `<data dir>/secrets/git-tokens.json` (mode 0600, directory 0700; agents cannot read the data directory) and reach git only through the environment of the git process. A running runner reports `connected` / `not connected` (never the secret) to the server within a minute; the Workstations page and the repository settings show it with a Connect helper that gives the same command. Plain git needs no connection: it uses your SSH keys or Git Credential Manager as before.

**Azure DevOps sign-in: Microsoft Entra service principal first.** Azure DevOps personal access tokens that are not scoped to one organization stop working on **2026-12-01**, and Microsoft is steering teams to Entra ID (service principals and workload identity) instead. The Azure adapter (`apps/runner/src/forge/azure.ts`) uses, in this order: (1) a PAT saved by `git-connect azure-devops --organization <name>`; (2) a **service principal in the runner's environment**; (3) the Azure CLI sign-in (`az account get-access-token`, which also covers `az login --service-principal`). The exact steps for (2):

1. In the Microsoft Entra admin center register an application (the service principal) and create a client secret (or, for workload identity, a federated credential). Note the tenant id, the application (client) id and the secret.
2. In Azure DevOps open Organization settings, Users, Add users, and add the service principal with Basic access; add it to the project (Project settings, Permissions) with at least Contributor on the repositories the runner uses. The organization must be connected to the same Entra tenant (Organization settings, Microsoft Entra).
3. On the workstation set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` in the runner's environment (the systemd unit, the scheduled task or the devcontainer env; never in a project file). For workload identity set `AZURE_FEDERATED_TOKEN_FILE` (the projected token path) instead of the secret. Optionally set `AZURE_DEVOPS_ORGANIZATION` to your organization name so the repository list and status know which one to use.
4. Restart the runner and run `aom-runner git-connect azure-devops --status`: it reports `connected` with method `service-principal`. The runner asks `login.microsoftonline.com` for an access token for Azure DevOps (resource `499b84ac-1321-427f-aa17-267ca6975798`), caches it until shortly before it expires, and gives git the same token through the environment of the git process only; the secret never reaches an agent, the server or a log.

Fallbacks stay supported: a PAT for one organization (`git-connect azure-devops --organization acme`, scope Code: Read & write and Project and Team: Read), and `az login` (interactive, `--use-device-code`, or `az login --service-principal -u <client id> -p <secret> --tenant <tenant>`), which the adapter picks up through `az account get-access-token`.

**Agents and `aom git`.** The DevOps engineer (in a chat or a DevOps request) can run `aom git status [<provider>]` and `aom git connect <github|gitlab|azure-devops|bitbucket-cloud> [--host <h>]`. The runner drives the login on this workstation: a browser or device-code sign-in (`gh auth login --web`, `glab auth login --web`, `az login --use-device-code`) prints a URL and a code that the agent shows to the user; the login keeps running on the workstation, the git status is reported again when it ends, and `aom git status` shows the result. A login that needs a secret (a GitLab or Bitbucket token, an Azure DevOps PAT) is never started: the command says so and the agent tells the user to run `aom-runner git-connect <provider>` in a terminal or use the app's Connect helper. Nothing in this path accepts, prints or stores a secret; the verbs are refused for every agent except the DevOps engineer.

The `gh` CLI is required for GitHub for approved repository setup (`aom repo create`, below): the runner creates the repository with your own `gh` login after you approve it on the desk. It needs a repository root (`aom-runner repos add <path>`; the new clone goes under the first one) and `gh auth login`. For GitLab, Azure DevOps and Bitbucket Cloud the same request carries `provider` (and `host` for a self-managed GitLab or GitHub Enterprise); the runner creates the repository through that provider's adapter with the login saved by `git-connect`, then clones, makes the first commit and pushes with the same credential, and the server adds it to the project with that provider as its git host. The desk item names the git host. The command runs only on the project owner's workstation, with no shell (`gh` and `git` are run directly; `AOM_GH_BIN` overrides the `gh` path), refuses an existing GitHub repository unless it is empty and yours, confines the clone to the repository root and records each request so a retry never creates a second repository.

Without a login for the repository's host (or on plain git) finalize with action `pr` falls back to pushing the branch and posting a desk notice for manual PR creation. Finalize with action `merge` first asks the host whether the working branch allows direct pushes; when it is protected (or the push is refused by a branch policy) the runner pushes the card branch and opens a pull request instead, with a desk notice. See the BA's `aom finalize` command (the action is the card's own; agents never choose it).

**Pull request branch name.** With `pr` (and the protected-branch fallback) the card branch is pushed as `<local>:refs/heads/<prefix>/<ticket>`, not under its local `aom/...` name: `prBranchPrefix` is the project setting (default `feature`), `ticket` the tracker key of the card's intake (for example `DCPL-4276`) else the card ref. A name origin already has gets `-2`, `-3`; `remoteBranch` (the `pushedBranch` of an earlier finalize) is reused so rework updates the same branch and pull request. The pull request is opened from that name, and hygiene removes the finished card's branch on origin by that stored name only (`finishedCards[].remoteBranch`), never by prefix. Runners older than this change ignore the fields and keep pushing the card branch name.

**Rotate runner token** (invalidates old token):
```sh
aom-runner rotate-token    # runner must be stopped
aom-runner start           # restart with new token
```

### Claude accounts (more than one subscription)

A project can run its tickets on its own Claude subscription, for example `work`, while the workstation's main account
(`~/.claude`) keeps running everything else. Set it on the project's settings page (Claude account). The runner side is
below. Org work (CEO, DevOps, chats) always uses the main account.

```
aom-runner accounts list                                # every account: login and usage state, folder, e-mail
aom-runner accounts add work                            # create (or check) ~/.claude-gw-work, register it, add the alias
aom-runner accounts add work --config-dir ~/work-claude # use a folder you name, as it is
printf %s "$TOKEN" | aom-runner accounts add work --oauth-token   # a token instead of a folder (also --api-key)
aom-runner accounts login work                          # claude auth login in this terminal, in the account's folder
aom-runner accounts remove work                         # unregister only; folder, alias and sign-in are kept
```

**The default folder and alias.** `accounts add <key>` uses `~/.claude-gw-<key>` (Windows: `%USERPROFILE%\.claude-gw-<key>`),
created with mode 0700 and a marker file `.aom-runner-owned`. On Linux and macOS it also adds the alias `claude-gw-<key>`
inside a marked block of `~/.zshrc` (when `$SHELL` ends in `zsh`) or `~/.bashrc`:

```sh
# >>> guildwise claude accounts >>>
alias claude-gw-work='CLAUDE_CONFIG_DIR=~/.claude-gw-work claude'
# <<< guildwise claude accounts <<<
```

Keys are added inside the block, sorted, and never duplicated. Lines outside the block are never edited. An alias of the same
name outside the block is not the runner's: it is left alone and the answer reports an alias conflict. Remove the block by
hand to remove the aliases.

**The runner never adopts what it did not create.** Your own `~/.claude-work` and its `claude-work` alias are never used,
changed or read as an account. `accounts add work` makes `~/.claude-gw-work` and `claude-gw-work` next to them. A default
folder that already exists without the marker is left alone: the account reports `failed`, and the message names
`aom-runner accounts add <key> --config-dir <dir>` as the deliberate way to register it. Folders inside the runner data
directory, inside `~/.claude` (main) or outside your home directory are refused.

**An explicit folder.** `--config-dir <dir>` (or a `configDir` you write in `config.json`) is used as it is and may already
hold a sign-in. The runner adds no marker to a folder you name. Registration in `config.json` looks like this:

```json
{ "runtimes": { "claude-code": { "accounts": [ { "key": "work", "configDir": "~/.claude-gw-work", "source": "config_dir" } ] } } }
```

**Signing in from the web.** On the Integrations page of the workstation (`/workstations/<id>/integrations`, or
`?focus=claude-code:<key>`), the Claude Code tile has one entry per account, and "Sign in with your Claude subscription"
(method `claude_login`) is offered for each account key. The runner runs `claude auth login --claudeai` in its own terminal
session with `CLAUDE_CONFIG_DIR` set to that account's folder: open the link, sign in, paste the code back. An unknown key is
set up first, as `accounts add` does. This needs runner 0.1.33 or newer, and machine-wide changes from the web only on the
primary pairing with `integrations.machineScopeFromWeb: "primary"` (the default). Otherwise the page shows the terminal
commands. A sign-in made in a terminal (`claude-gw-work`, then `/login`) is picked up on the runner's next check of that
folder.

**Limits and login per account.** Each account has its own usage-limit and login state, probed on the same rules as the main
account (every 3 minutes, one tiny request). When an account is out, the project's tickets pause or fall back to main, as
set on the project; see the [user guide](USER-GUIDE.md). A login that does not work, or was never completed, raises a desk
notice for the workstation owner with the sign-in link and the terminal command. The notice closes when the account signs in.

## Running and connecting

### Start command

```sh
aom-runner start [--mock] [--data-dir <path>]
```

Connects to the server and listens for work. Runs in foreground (Ctrl+C to stop).

- `--mock`: enable mock runtime for this process (does not edit config)
- `--data-dir <path>`: override data directory (default `~/.aom-runner`)

Exit codes:
- `0`: stopped by SIGINT/SIGTERM
- `2`: server rejected token (re-pair needed)
- `3`: another runner connected to the same workstation (only one per workstation; with several pairings only the affected pairing stops)

### Heartbeat and reconnect

- Sends heartbeat every 15 seconds
- Reconnects with full-jitter backoff on disconnect (1 s → 30 s)
- Gives up on a connection attempt that has not finished the handshake in 15 s, on a socket that gets no `welcome` within 30 s of opening, and on a ready socket that has received nothing (frames, acks or ws pongs; the runner pings every heartbeat) for three heartbeat intervals; each case goes through the normal backoff retry
- Resends outbox (pending messages) on each reconnect

Shift state is persisted in `active-shifts/` and resumed when the runner restarts, so killing and restarting within the one-hour lease keeps the card claim.

### Status command

```sh
aom-runner status [--data-dir <path>]
```

Shows config summary and whether a runner process is alive (with PID, connection state, active shifts, pending outbox). With several pairings it prints one block per pairing (`--pairing <id|name>` picks one); `aom-runner pairings` lists them in one line each.

### Troubleshooting

```sh
aom-runner doctor [--data-dir <path>]
```

Checks prerequisites and connectivity:
- Node version ≥ 22
- Git version ≥ 2.40
- Claude CLI is available (if using claude-code runtime)
- Docker is available (if testers will run)
- `yt-dlp` is available (optional: only `aom transcript` for YouTube and other video sites needs it; a warning when missing, and the DevOps engineer can install it)
- Repos found under repoRoots
- Server is reachable

## Environment variables

The runner respects these environment variables:

| Variable | Purpose |
| --- | --- |
| `AOM_RUNNER_HOME` | Data directory (default `~/.aom-runner` or Windows `%LOCALAPPDATA%\aom-runner`) |
| `AOM_RUNNER_MOCK` | Set to `1` to enable mock runtime (alternative to `--mock` flag) |
| `AOM_RUNNER_MAX_SHIFT_MS` | Override `maxShiftMinutes` for testing (milliseconds, e.g., 5000 for 5 seconds) |
| `AOM_MOCK_STEP_MS` | Speed up mock adapter progress steps (default 100 ms) |
| `AOM_RUNNER_AUTO_UPDATE` | Set to `0` to switch the runner's self-update off on this machine (see Updates) |
| `AOM_GH_BIN` | Path to `gh` binary (default `gh`; for GitHub API integration) |

| `AOM_ALLOW_LOCAL_REMOTES` | Set to `1` to accept `file://` and path git remotes (tests only; production refuses them) |
| `AOM_CLAUDE_SMOKE` | Set to `1` to run the real-Claude smoke test (spends tokens) |
| `AOM_CLAUDE_SMOKE_MODEL` | Smoke test model (default `opus`; try `haiku` to save tokens) |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token for Claude Code (from `claude setup-token`); stored by `aom-runner up` |
| `ANTHROPIC_API_KEY` | The customer's API key; stored by `aom-runner up` in the runner config |
| `GUILDWISE_SERVER`, `GUILDWISE_PAIR_CODE`, `GUILDWISE_NAME` | Used by `aom-runner up` for unattended pairing |
| `CODESPACE_NAME`, `GITHUB_TOKEN` | Set by GitHub inside a Codespace; `aom-runner up` enrolls with them |

## The `aom` command (inside a shift)

Inside a shift, agents use the `aom` CLI to read the card, report outcomes, ask questions, and interact with the runner.

**Available everywhere (all shifts):**
```sh
aom card [--json]                                      print the card and brief
aom ledger search "<query>" [--scope all|feature|decision|standing_order]
                                                       search answers, decisions and standing orders
aom comment --note "<text>"                            post a note without ending
aom question --text "<q>" [--option "<a>"]... [--recommend <n>] [--doing "<x>"] [--topic <topic>] [--wait [10m]] [--non-blocking] [--force]
aom card facts [<REF>]                                 what the server knows: environment, dependencies merged, branch, stage, blockers
aom block --on dependency <REF> [--card <REF>]         architect, planner, BA: this card waits for another card
aom devops "<request>"                                 ask the DevOps engineer
```

Agents must run `aom ledger search` before raising a question: every answer (from the manager, a senior or the BA) is recorded in the ledger once and should never be asked twice. `aom question` also runs a duplicate check and returns matching ledger entries; a non-blocking question that matches needs `--force`, and a blocking one that is practically the same as a ledger entry is refused the same way.

**Questions (Lean Team v3).**
- `--topic environment|sandbox|tooling|dependency|order|requirements|design|code` names the problem; the server routes by topic, not by who touched the card last. Environment, sandbox and tooling become a request for the workstation's DevOps engineer (an open request of the card is attached to, not asked twice) and a blocking question parks the card on it; dependency, order and design go to the card's architect, requirements to the BA, code to the card's builder. Then the previous holder, a senior of the asker's role, the BA, the organization's CEO (when it has an active one) and the manager's desk. Routine topics (environment, sandbox, tooling, dependency, order, code) are answered on Sonnet; design and requirements keep the answerer's model. The answerer's brief is slim: the card summary, the question and the three best ledger matches.
- `--wait [10m]` raises the question without ending the shift and polls the server every 15 seconds (the Bash call blocks, at most 10 minutes and never longer than the shift has left). The answer is printed and the agent carries on in the same session. If nobody answers in time, or only the manager's desk could, the question becomes a blocking one: the card is parked on it and the claim is released, and the card keeps **affinity** to the agent (4 hours): only that agent may claim it, it is offered before new work, and the shift start carries `resumeSessionId` and `resumeMessage` (the answer) so the runner resumes the session. Review findings that send a card back to its builder set the same affinity. Affinity ends at its expiry or when the card changes stage.
- `aom answer --item <id> --text "<a>" --keep-blocked-until "<condition>"` answers a question but keeps the asker's card parked (no re-queue). The card page shows the condition; moving the card to the queue ends the park. The owner can do the same on the desk (`keepBlockedUntil`).
- Repeat guard: the second similar question on the same card and stage with no handoff in between does not reach anybody. The card is parked with a back-off and exactly one desk item says so. Five question shifts about one card within two hours put it in loop back-off, whatever the wording. A question shift the runner refused (no agent ran) does not count, and neither does a routing hop (peer, BA, CEO, desk): one question counts once. Only questions an agent asked count; the stop-loss arbitration the system asks the architect does not (the stop-loss is its own guard).
- `aom card facts` answers what the agent would otherwise ask: the environment status, whether each dependency has merged, the branch, the stage and the blockers. `aom card facts <REF>` does the same for another card of the project.
- `aom block --on dependency <REF>` records that this card waits for another card (add only, any open card, no cycles, same project). Until the dependency has merged only the design stage may run; build, review and test wait.
- Stop-loss: a card is parked and goes to its architect for arbitration (the owner gets one item if the architect cannot resolve it) when it reaches its budget of build passes, review rounds or shifts: small 2 / 2 / 10, medium 3 / 2 / 15, large 4 / 2 / 25. Size follows the risk tier (large is large; a card that needs a design is medium; the rest is small). The budget is a project setting (`PUT /api/projects/:id/stop-loss`); each arbitration the architect answers with "go on" adds one pass, one round and five shifts.

**DevOps engineer of a "Run request" (run a branch), only for the environment of its own request:**
```sh
aom run info                                            worktree paths, port range, expiry
aom run step --name "npm ci" --repo web --cwd . [--timeout 1200] [--env K=V]... -- npm ci
aom run step --name "npm ci" --wait                     wait for a step that was still running
aom run service --name api --repo api --cwd src/Api --port http:5000:ASPNETCORE_HTTP_PORTS \
    --health 'http://localhost:${port}/health' [--env-file /abs/path] [--env K=V]... [--after db] \
    [--start-timeout 300] [--stop-cmd "<cmd>"] -- dotnet run
aom run status | aom run logs <service|step> [--lines N]
aom run ready [--notes "<text>"]                        every wanted service is healthy: save the plan
aom run fail --reason "<why>"                           give up: the environment ends as failed
```

**Code map (card shifts with a graph, and chats; see "Project graphs"):**
```sh
aom graph query "<words>" [--budget <tokens>]          subgraph for a question (default budget 1,500 tokens)
aom graph path <a> <b>                                 shortest chain of links (at most 20 hops)
aom graph explain <node>                               one node, its place and up to 40 links
aom graph impact <file or symbol> [--depth <1-4>]      callers and callees (default depth 2, at most 60 nodes)
```
Answers come from the project vault on this workstation (no server round trip) and are fenced as untrusted data. Each
link is tagged `[E]` (stated by the code), `[I]` (inferred by name) or `[A]` (ambiguous, several targets): read the file
before you act on an `[I]` or `[A]` link. Chats get `graph query` and `graph explain` only. Shifts in the holdout arm
get no "Graph context" section, and their `aom graph` calls answer "not available for this work".

**Builder/researcher shifts (To do, Rework, Research):**
```sh
aom handoff --note "<text>" [--data-file <json>]       hand the card on
aom question ...                                       ask a blocking question
```

**Reviewer shifts (Review stage):**
```sh
aom review approve --score <1-5> --risk low|medium|high --risk-file <md> [--qa-focus "<text>"] --note "<text>"
aom review changes --reason <r>[,<r>] --score <1-5> --risk low|medium|high --risk-file <md> [--criteria-missed "<c>"]... --note "<text>"
```

**Tester shifts (Test stage):**
```sh
aom test pass --evidence "<text>" [--command "<cmd>"]...
aom test fail --title "<bug>" --note "<text>" [--evidence "<text>"] [--command "<cmd>"]...
```

**BA shifts (Spec, Intake, Finalize, Answer) and the BA in any chat (the chat becomes an intake without a ticket on first use):**
```sh
aom card create --json '<draft json>'      # or --file <draft.json>, or --file - to read stdin
aom card update <REF> --json '<patch json>' # or --file <patch.json> / --file -
aom card specify <REF>
aom finalize --note "<note>"                  # BA: runs the card's own completion action (never chosen by the agent; pr requires `gh`, without it the branch is pushed under the PR name and a desk notice asks for the pull request by hand)
aom answer --item <id> --text "<answer>" [--option <id>] [--keep-blocked-until "<condition>"]
aom escalate --item <id> --note "<what must be decided>"
aom intake map --project <KEY> | aom intake unmapped --note "<why>"
aom repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] [--host <h>] --name <name> --private|--public --project <KEY> [--description "<text>"]   # BA chat and DevOps: asks the project owner; their runner creates it after approval
#   name: owner/repo (github) | group[/subgroup]/project (gitlab) | organization/project/repo (azure-devops) | workspace/repo (bitbucket-cloud)
aom git status [<provider>] | aom git connect <provider> [--host <h>]   # DevOps only: check or start this workstation's git host login
aom git fetch | merge-main | verify-merge   # architect only (investigate stages): the runner fetches origin, merges the latest main, checks a conflict resolution (`aom git push` is refused: agents never push)
aom design --report <path> --summary "<text>"           # architect: hand the designed card to build (outcome handoff)
aom investigate --report <path> --summary "<text>"      # architect: end an investigation-only card (outcome report)
aom investigation record --title "<t>" --summary-file <md> [--decision]   # BA at Finalize of an investigation-only card
aom finalize                                      # investigation-only card with the report in the vault: no git step (derived by the server)
aom outbound draft --kind <comment|resolution|decision> --body "<text>"
aom source read --ref <owner/repo#12 | ticket URL>
aom source attachments <ABC-123>                        # the files attached to the intake's Jira ticket
aom source attachment <ABC-123> [<filename|id> | --all] # the runner downloads them into your scratch dir and prints the paths
aom card attach <path> [--card <REF>]                   # put a file from your scratch dir on a card you drafted
aom card attachments [<REF>]                            # copy a card's attached files next to the shift (read-only)
aom org ...                                            (design chat: draft roles/workflows; role/workflow drafts take --json, --file or --file - too)
```

**DevOps shifts (repository hygiene requests):**
```sh
aom hygiene run [--note "<text>"]                      tidy the project repositories listed in the request, then end the request
```
See "Repository hygiene" below.

**Scout/curator shifts (Feed, Digest):**
```sh
aom digest --file <json> [--note "<text>"] | --none
aom handoff --note "<text>"                            (scout: handoff with candidates)
```

**Researcher/checker shifts (Research):**
```sh
aom publish --file <note.md> [--title "<t>"] [--citations-file <json>]
```

**Transcripts of videos and podcasts (scout, researcher, checker):**
```sh
aom transcript --url <video or podcast URL>
```
The runner process (outside the agent sandbox, so the network allowlist does not apply) finds the transcript and prints a short header (title, source, language, whether the captions are auto-generated) followed by the text (the first 30,000 characters; the whole text is saved). Run it as a standalone command, like every `aom` verb.

- YouTube and other video sites: `yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs "en.*,en" --sub-format vtt`, converted to plain text with the rolling auto-caption repeats collapsed. Timeout 120 s.
- Podcasts and other pages: a `<podcast:transcript>` URL in the page or feed, a VTT/SRT `<link rel="alternate">` or a "Transcript" link; VTT, SRT, JSON and HTML are converted to text.
- The text is capped at 200,000 characters (a note says so when it was cut). The runner writes it to the card's vault as `projects/<name>/transcripts/<yyyy-mm-dd>-<slug>-<hash>.md` (both feeds and research use this folder) and sends the text to the site, which shows it on the digest items and the research citations. A transcript fetched in a shift counts as opening that source, so `aom publish` accepts a video cited with its transcript, and the published note gets a "Transcripts" section linking the file.
- Results (exit code 0 in every case; the first line says which): `Status: ok` plus the header and text; `no transcript available` (`Status: none`); `transcript lookup failed` (`Status: error`); `transcript tool missing: yt-dlp` (`Status: tool_missing`; the agent raises `aom devops "install yt-dlp"`). Text is never invented.
- A scout's report is rejected when a video or podcast candidate has no transcript lookup; the runner attaches the reference (`transcript: {status, path, chars, autoGenerated}`) to the items itself.

**Exit codes:**
- `0`: recorded successfully
- `1`: error or rejected report (reason printed; can fix and retry within the shift)
- `2`: verb not available in this version (or feature not yet implemented)

**Full reference:** see `docs/USER-GUIDE.md` for the full `aom` reference and examples.

## Adapters: Claude Code, Codex, Direct-model and Mock

### Claude Code adapter

Runs the `claude` CLI in a shift, builds the full environment, and streams the output.

**Environment setup** (per shift). The agent process does **not** inherit the runner's environment; it gets an
allow-list (`PATH`, `LANG`/`LC_*`, `TERM`, `TZ`, proxy and CA variables such as `HTTPS_PROXY` and `SSL_CERT_FILE`, and the
few variables Windows needs to start a process) plus:
- `HOME=~/.aom-runner/agents/<agentId>/home`
- `CLAUDE_CONFIG_DIR=~/.aom-runner/agents/<agentId>/claude`
- `GIT_CONFIG_GLOBAL=~/.aom-runner/agents/<agentId>/home/.gitconfig` (with the commit identity of the shift, see "Commit identity"; never the agent's name)
- `AOM_IPC_URL=http://127.0.0.1:<ephemeral>` and `AOM_IPC_SOCKET=<private unix socket>` (for the `aom` CLI; the CLI
  prefers the socket, because the sandbox has no route to loopback TCP)
- `AOM_SHIFT_TOKEN=<per-shift-token>` (ephemeral, valid only during the shift)
- only the provider credential this runtime is configured with (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`)

`GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, cloud keys (`AWS_*`, ...) and everything else in the runner's own
environment never reach an agent.

**Session startup:**
```sh
claude -p --resume --include-partial-messages --no-input
  --context-file=/path/to/shift-prompt.md
  --effort=<effort>
  [--model=<model>]
```

The shift prompt includes:
- The card spec, context, requirements, acceptance criteria
- Relevant vault files (project `.md` files, standing orders)
- Previous related decisions from the ledger
- Agent role and permissions
- Org and team context

### Runner 0.1.24: sessions, cache, shifts that start cleanly

**Session id and context size.** Claude's session id is only known after the process printed its first line, which is after
`shift.started` went out. The runner sends it as a late `shift.session` (with the context size: the last call's input +
cache read + cache write tokens) and again every two minutes while it grows, and the end of the shift carries the final size
in `shift.ended.contextTokens`. The server keeps both on the shift row (`runtime_session_id`, `context_tokens`).

**Resume.** A `shift.start` may carry `resumeSessionId`: the agent's own earlier session. The runner checks it against
`<data dir>/sessions.json` and **starts fresh** (and says which in the first `shift.session.resume`) when the session is
unknown on this workstation, belongs to another agent, holds more than 120K context tokens, is more than 4 hours old (counted
from the first shift of that session), or its transcript is gone. Otherwise it passes `--resume`. Claude Code keeps a session
transcript under the project folder of the directory it ran in (`<CLAUDE_CONFIG_DIR>/projects/<directory with every
character that is not a letter or digit turned into "-">/<session id>.jsonl`); a builder that moves from one card worktree to
the next resumes in a different directory, so the runner copies the transcript into the new directory's project folder first
(never overwriting). Spiked with claude 2.1.302: Claude Code also finds the session in another project folder of the same
config dir, so the copy is belt and braces.

**Shell timeout.** Card shifts start Claude with `BASH_DEFAULT_TIMEOUT_MS=660000` (11 minutes) so `aom question --wait` (up to
10 minutes) is not cut off by the shell's default; the hard cap `BASH_MAX_TIMEOUT_MS` stays at 15 minutes. Other kinds keep 5 minutes.

**Prompt cache.** The agent's instructions (`CLAUDE.md`) start with the stable role text (role instructions, core rules,
standing orders, project, boundaries), then the stage-specific outcomes, then this shift's attachments and notes, and end with
the agent's name and seniority, so agents of one role share a cache prefix. Question prompts put the card first and the question
last. Short shifts (question, CEO, DevOps, QA steps) run with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` (a 1-hour cache write costs
twice the input price and is never read again). Every agent session runs with `--disable-slash-commands`: the account's synced
skills (`anthropic-skills:*`) and the bundled ones add their descriptions to every first call and no agent uses them (verified
with claude 2.1.302: the init message lists 0 skills). The BA's role text leaves out the intake-chat and organisation-design
sections in background shifts, and the sections its kind of shift does not use.

**Before a shift starts.** The runner refuses with `disk_full: ...` (reason `worktree_failed`, which the server backs off on)
when the OS temp folder has under 512 MB or the data folder under 1 GB free; DevOps shifts are exempt. It checks the Claude login
(`auth_expired`, no penalty, instead of a crashed first shift): the expiry in `~/.claude/.credentials.json` is read and only when
the token expires within 10 minutes does one minimal probe run (which also refreshes it). A card worktree left on its own
`conflict/<ref>-aN` branch is switched back to the card branch when it is clean and the conflict branch has nothing the card
branch lacks; a dirty or ahead worktree is refused with the reason and left alone (a DevOps resolution is never discarded).

**End of a shift.** When the server releases the claim after an accepted report, the runner waits up to 5 seconds for Claude's
result line before stopping the process, so the real usage is recorded and the shift counts as `reported`. The sandbox stubs
(`.gitmodules`, `.bashrc`, ...) are removed only when no other shift of this runner works in the same worktree. A crashed
shift's usage is the sum of its messages (an all-zero error result no longer replaces it).

**Role smoke test.** On every runner start (so after every update) each built-in role goes down its own handoff path with no
call to Claude: its permissions are turned into Claude Code settings (a role without the edit tool must still be able to write
its scratch folder: the reviewer's `--risk-file`, the BA's notes), then its own `aom` command (`handoff --note-file`, `review
approve --risk-file`, `test pass`, ...) runs as the real `bin/aom` shim with the environment of the role's sandbox against the
runner's IPC server, which answers it as a dry run. The result goes to the server as `role.smoke`: a failed role gets no work on
this workstation until a later run passes, and one desk alert names the role and the reason. (`aom` runs outside Claude Code's
shell sandbox by design, so the bubblewrap boundary itself is covered by `claude-sandbox-real.test.ts`.)

**Errors to the server.** `unhandledRejection` is logged and reported and the runner keeps running; `uncaughtException` is
reported and the process exits. A failed shift handler is reported too. `runner.error` carries a signature, the first line of
the message with paths, ids and secrets masked, a stack of function names with file basenames, the version and a short context
label, never a prompt, card text or client code. The server keeps one row per signature with a counter in `runner_errors`
(`GET /api/platform/runner-errors`, super admin).

### Direct-model adapter: provider API keys (runner 0.1.45)

The `direct-model` runtime calls a model provider's API from this workstation with the Vercel AI SDK: Anthropic's API, OpenAI, Google Gemini, and one OpenAI-compatible endpoint (OpenRouter, Ollama, LiteLLM, LM Studio). It is for conversation: Discovery and Boardroom turns (facilitator, CEO proposals, personas, the Chair, the minutes) and plain chats. It has no shell, no edit tool and no files, so it never runs a card or a shift. It announces the `direct-model:1` capability and always reports the runtime (`available: false` until a key is stored).

**Setting a key.** On the Workstations page, under the workstation, **Model providers**: the owner of the workstation pastes the key (and, for an OpenAI-compatible endpoint, the base URL such as `http://localhost:11434/v1`; the key is optional for a local Ollama or LM Studio; extra model ids can be added for any provider). The browser encrypts the key with this runner's public key (RSA-OAEP, the same one the sudo password uses, so a key longer than 190 bytes is refused) and the server only relays the ciphertext in the `provider.key.set` command and empties it once the runner has answered. **Remove** sends `provider.key.clear`. There is no command-line form on purpose: the key never needs to be typed into a shell.

**Where it lives.** `secrets/providers.json` (mode 0600, in the 0700 `secrets/` folder, never readable by agents): per provider the ciphertext, the base URL and the extra model ids. The plain key is decrypted in memory when a turn needs it and registered with the redaction registry (also after a restart), so it does not appear in `logs/`, in a tool summary or in an error text. The server learns only provider names, model ids, the endpoint's host and a short problem text: `RuntimeInfo.providers` in `hello` and `runtimes.report`. Models offered: the built-in list per provider, the extra ids, and for the compatible endpoint the list from its `/models` (cached ten minutes).

**What a call does.** The turn's `chat.start` carries the model (`provider:model`) and, for a session turn, its purpose. The runner sends the instructions (the same room text as for Claude Code, written for tools) and the message, and runs at most 12 model calls with a 5-minute limit; each `aom` verb the purpose allows is a tool that goes through the runner's IPC with the turn's token and is checked by the server like an `aom` call from Claude Code. Plain chats keep their earlier messages in `direct-chats/<id>.json` (0600). Data goes from this workstation straight to the provider; Guildwise's servers never see the key or the traffic.

**Troubleshooting.** "X is not set up on this workstation": add the key. "X refused the API key (HTTP 401)": the key is wrong or expired, replace it. "does not know this model (HTTP 404)": the id is not available to this key, or the endpoint does not serve it. A model that is not in the built-in list needs its id added under **Model providers**. Costs of models without a price in the table show as "cost unknown".

### Codex CLI runtime

The `codex` runtime runs OpenAI's Codex CLI (`codex exec`) for card shifts and chats, in Codex's own OS sandbox. It is registered **only when the `codex` binary is found** when the runner starts (on `PATH` or at `runtimes.codex.bin`; installing it later needs a runner restart) and it is reported in `hello` and `runtimes.report` like the other runtimes: version, `available`, `sandbox` (`enforced` or `unavailable` with the reason in `sandboxReason`) and `auth` (`expired` when nobody is signed in). A Codex agent is hired like any other (runtime `codex`, model `gpt-6.1-sol`, ...); the server accepts it when the workstation reports it available and the role is one its sandbox can confine (below).

**Requirements.** Linux (WSL2) or macOS (native Windows is not supported by this adapter); `codex` 0.163.0 or newer (`npm i -g @openai/codex`, or the standalone/Homebrew install); on Linux bubblewrap (`apt install bubblewrap`) or user namespaces for Codex's bundled helper. The runner proves the sandbox works with `codex sandbox -- true` under the same profile sessions use (cached ten minutes); when it does not start the runtime reports `sandbox: unavailable` with Codex's own error and **refuses every session**. There is no `off` or `best_effort` mode and no unsandboxed acknowledgement for Codex.

**Sign-in.** `authMode: "login"` (default): run `codex login` as the runner user (ChatGPT sign-in, or `codex login --with-api-key`) with the **file** credential store, so `~/.codex/auth.json` exists (a login kept only in the OS keyring is not found; use `cli_auth_credentials_store = "file"` in `~/.codex/config.toml` and log in again, or use an API key). Each session gets a **private 0600 copy** of that file in the agent's own Codex home; a refreshed login (newer `last_refresh`) is written back to the owner's file when the session ends. Several agents refreshing a ChatGPT login at the same moment can invalidate each other's refresh token (it rotates): `authMode: "api_key"` avoids that. `authMode: "api_key"`: `apiKey` goes to the codex process as `CODEX_API_KEY` (codex reads it only for `exec`) with `forced_login_method = "api"`; no login file is read and none is left in the agent's home. A failed login (HTTP 401, expired refresh token) ends the session with `authFailed` (the shift is put back, not counted as a crash) and the runtime reports `auth: expired` until `auth.json` changes or a session works. Cost: the usage of a ChatGPT plan is not billed per token.

**Flags and files (codex-cli 0.163.0).** Verified on 2026-10-23 against the sources at github.com/openai/codex tag `rust-v0.163.0` (`codex-rs/exec/src/cli.rs`, `exec_events.rs`, `lib.rs`; `codex-rs/utils/cli/src/shared_options.rs`; `codex-rs/core/config.schema.json`), the documentation at developers.openai.com/codex (auth, skills, AGENTS.md, security, permissions, config reference; the site now redirects to learn.chatgpt.com/docs), and by running the real binary (`codex exec --help`, `codex debug models`, `codex sandbox`, `codex execpolicy check`, and the opt-in `apps/runner/test/codex-real.test.ts` against a fake Responses API):

```
codex exec --json --skip-git-repo-check --strict-config --color never --cd <worktree> --model <id>
      -c approval_policy="never" -c default_permissions="aom" -c permissions.aom={...}
      -c shell_environment_policy={inherit="none", set={...}} -c allow_login_shell=false
      -c web_search="disabled|live" -c cli_auth_credentials_store="file" -c project_doc_max_bytes=1048576
      -c skills={bundled={enabled=false}} -c analytics/feedback/history off [-c model_reasoning_effort=<effort>]
      [resume <thread id>] -        # the prompt is read from stdin (`-`): never in argv or `ps`
```

- `--json` prints one JSON event per line: `thread.started {thread_id}` (the session id to `resume`), `turn.started`, `item.started|updated|completed` (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`), `turn.completed {usage}`, `turn.failed {error}` and `error {message}` ("Reconnecting..." retries are ignored). Codex does not stream tokens: a reply arrives whole, so a chat gets it as one `delta`. `exec` never asks for approval (headless default `never`, set anyway); a request to run something unsandboxed (`sandbox_permissions: require_escalated`) is refused, which the real-binary test checks.
- `--sandbox` is **not** used: Codex does not combine `sandbox_mode` with permission profiles. `--strict-config` makes a key this Codex version does not know an error instead of a silently weaker sandbox. `--dangerously-bypass-approvals-and-sandbox`, `--oss`, `--profile`, `--add-dir` and `--worktree` are never passed. Every `-c` value is TOML, so the whole per-session policy travels in argv and the agent's Codex home holds only state shared by its sessions.
- **Models.** `gpt-6-luna` (small), `gpt-6.1-sol` (medium), `gpt-6-astra` (large) from `codex debug models`; efforts `low|medium|high|xhigh|max` (`ultra`, automatic delegation, is not offered). Other ids can still be set on an agent and are passed through.
- **Codex home** `agents/<id>/codex` (`CODEX_HOME`): `AGENTS.md` (the agent's instructions, written by `writeInstructions` from the same shared renderer text as `CLAUDE.md`, nothing forked), `auth.json` (private copy), `rules/aom.rules`, `sessions/` and Codex's state databases. The owner's `~/.codex` (config, skills, AGENTS.md, rules) is never read. Codex also reads an `AGENTS.md` in the repository, as Claude Code reads a `CLAUDE.md`.
- **Skills.** Granted skills (`grantedSkills`) are written by `materializeSkills` into `agents/<id>/home/.agents/skills` (Codex's USER scope, under the agent's private `HOME`), replacing the folder each session; nothing is written into the worktree. Codex has no switch for the repository's own `.agents/skills` (REPO scope), so those load too; Codex's bundled skills are turned off.
- **Environment.** The codex process gets the allow-listed variables (`PATH`, locale, proxies, certificates), the session's variables (`HOME` private, `AOM_*`, caches), `CODEX_HOME` and, in `api_key` mode, `CODEX_API_KEY`: nothing else of the runner's environment (no `GH_TOKEN`, ssh agent, cloud keys, the runner token). The **shell** Codex starts for the agent gets exactly the session's variables (`inherit = "none"` plus `set`), without `CODEX_*`. Codex strips variables named `*KEY*`, `*SECRET*`, `*TOKEN*` by default; `set` is applied afterwards, so `AOM_SHIFT_TOKEN` arrives (checked). `allow_login_shell = false` keeps `/etc/profile` from rewriting `PATH`.

**The sandbox profile.** A permission profile named `aom`, built per session (`codexPermissions` in `adapters/codex.ts`): the filesystem is **deny by default** (`:minimal` system read, then only the paths below), the network is off. Paths granted: write: the working folder (the worktree, or read-only for a role without `edit` and for chats), the agent's private home, scratch and temp folder, the shared package caches, `/tmp/.dotnet`; read: the toolchain folders (Node install, `toolchainPaths`), the runner's `bin/` and the `aom` script's folder, the codex install, the vault folder, reference repositories (their `.env`, `*.pem`, `id_*`, ... files denied), NuGet's fallback folder; for a role that commits, the worktree's git admin folder (`.git/worktrees/<name>`), `objects`, `refs` and `logs` of the main repository, writable; its `config` and `hooks` stay read-only. Everything else, including the owner's home, the runner's data directory with its token and secrets, other agents' folders, `~/.ssh` and **this agent's own Codex home with `auth.json`**, does not exist for the shell (checked with the real binary).

**The `aom` command.** Inside Codex's network-restricted sandbox a Unix socket cannot be connected (`connect()` fails with EPERM, checked on 0.163.0) and loopback is a separate network namespace, so the sandboxed shell cannot reach the runner. `rules/aom.rules` therefore holds `prefix_rule(pattern=["aom"], decision="allow")`: Codex runs a standalone `aom ...` command **outside the sandbox without asking**, the same way Claude Code's excluded `aom` runs (and with the same hint: run `aom` as its own command, not in a pipe or after `cd`). A compound command that contains anything else stays sandboxed. The rules file also forbids (`decision="forbidden"`) the role's denied shell patterns that are plain command prefixes, `git push`, `git reset --hard`, `git stash drop|pop|clear` and, except for builders, `git rebase|checkout|switch`; this is defence in depth, the structure above (no network, no credentials, read-only `.git` config) is what holds.

**Parity with the Claude Code adapter.**

| Guarantee | Claude Code | Codex runtime |
| --- | --- | --- |
| Private `HOME`, own config dir | `HOME`, `CLAUDE_CONFIG_DIR` in `agents/<id>` | `HOME` and `CODEX_HOME` in `agents/<id>`; the owner's `~/.codex` never read |
| Runner environment kept out | allow-listed env, `inheritEnv: false` | same for the codex process; the shell gets only the session's variables |
| Credentials | per-agent copy of `.credentials.json`, or a token | per-agent 0600 copy of `auth.json`, or `CODEX_API_KEY`; hidden from the shell |
| Writes only in the worktree, scratch, home, tmp | `denyWrite` / `allowWrite` | deny-by-default profile: same areas |
| Reads | `/home` hidden, allow-list of toolchain, reference and vault folders | whole filesystem hidden except `:minimal` and the allow-list (stricter than a blocklist) |
| Secret files denied (`.env`, keys) in reference repositories | per-file masks | deny globs, **fixed when the process starts**: a file created later is not covered |
| Network | domain allow-list (registries, git hosts, per-shift target host) | **off**: no `npm install` or `git fetch` from the shell; no per-domain list (Codex's proxy is not used). Packages must already be in the shared caches or the repository |
| `aom` over IPC | Unix socket allowed through the sandbox | `aom` runs outside the sandbox by an `allow` execpolicy rule (above) |
| Git: commit in the worktree, no push | yes; hooks and config of the main repository read-only | same: commit works, `config` and `hooks` read-only; no network, so no push; git prints a harmless `packed-refs.lock` warning |
| Denied shell patterns | permission rules | execpolicy `forbidden` prefix rules for plain prefixes (best effort); the structure holds |
| Chat shell limited to `aom` | `Bash(aom:*)` | **not limited**: the chat shell is any command, in a read-only, network-less, allow-listed sandbox |
| Web | `WebFetch`/`WebSearch` per role | Codex's hosted web search only, for roles with `web`; the shell has no network |
| MCP servers (plugins, Jira intake) | granted per role | **none** |
| Per-role path scopes (tester, writer) | `Edit(...)` globs | not expressible: those roles are refused |
| Browser roles (Unix sockets) | opt-in | refused |
| DevOps guard, DevOps/CEO profiles | yes | refused |
| Token cost | priced from `DEFAULT_MODEL_PRICES` | **cost unknown** |

**Restrictions chosen (nothing is weakened; where parity is not possible the role stays on Claude Code).** The runner refuses to start (`codex_role_refused: ...`) and the server refuses to hire or move an agent onto the runtime (`runtime_not_for_role`, from `codexRoleProblem` in shared) for: the DevOps engineer and the CEO (their own guard and full-power profiles); roles with no `shell` tool where Codex runs in its own macOS sandbox (it always has a shell there; in the runner's harness sandbox they run, Q68); roles with `browser` (the tester); roles that may edit only some paths (`writableGlobs`, the writer and the architect); the DevOps guard and read-only scans; the BA intake chat (needs the Jira MCP tool). The CEO chat never offers Codex models. The runtime is also refused whenever its sandbox self-test fails or nobody is signed in. What remains: the builder, the reviewer, the planner, the pre-reviewer, the BA's tasks and chats, and custom roles with a shell and no path or browser needs.

**Usage and cost.** `turn.completed.usage` (`input_tokens` includes the cached part; `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` is part of the output) becomes `Usage` with `inputTokens` the non-cached part and `model` `codex:<model>`. `CODEX_MODEL_PRICES` in shared is empty: a Codex turn is costed 0 and flagged `isCostUnknown` ("Cost unknown for N turns" in Discovery and the Boardroom), never priced like a Claude model. Card shifts show 0 for it (the shift ledger has no unknown flag yet).

**Known gaps.** The repository's own `AGENTS.md` and `.agents/skills` are loaded by Codex (no switch). A plain clone (not a linked worktree) cannot commit: its `.git` is inside the writable root and Codex keeps it read-only. `resume` works by thread id, but the supervisor's "continue this agent's session" decision reads Claude transcripts, so a shift always starts a new thread unless the caller passes a `resumeSessionId` from a chat. A Codex login shared by several agents can lose a refresh-token rotation (use an API key). Codex's own stderr is shown only in the failure text, cut to 1000 characters.

**Tests.** `apps/runner/test/codex-adapter.test.ts` (a fake `codex` script that records argv, environment, cwd, stdin, `AGENTS.md`, skills and rules: argv, env allow-list, instructions, skills, stream parsing, usage, exit and auth mapping, role refusals, registration only when the binary exists); `apps/runner/test/codex-real.test.ts` (opt-in, `AOM_CODEX_REAL_BIN=/path/to/codex`: the real binary against a fake local Responses API, checking the sandbox, the shell environment, the `aom` exclusion, git, skills discovery and the event parser); `packages/shared/test/codex-runtime.test.ts`; `apps/server/test/codex-runtime.test.ts`.

### Codex in the runner's harness sandbox (0.1.55)

On Linux and WSL2 the Codex runtime now runs inside the runner's own sandbox, the one the Gemini CLI and opencode use: bubblewrap around the whole CLI, the network only through the runner's egress proxy (domain allow-list, the owner's private endpoints), and the model key added upstream by the proxy so it never exists in the box. `runtimes.codex.sandbox` is `auto` (default: harness on Linux, Codex's own permission profile on macOS), `harness` or `native`; `extraAllowedDomains` adds hosts the CLI and its shell may reach. The native profile above is unchanged and is still what macOS uses.

- **How it is started.** Inside the box Codex runs with `sandbox_mode = "danger-full-access"` (the box is the confinement; a second sandbox cannot nest) and `openai_base_url` pointing at the proxy's `/openai` route, which injects the API key. A ChatGPT login (`authMode: "login"`) goes to `chatgpt.com`, `auth.openai.com` and `api.openai.com` through the proxy's allow-list instead. In login mode `forced_login_method` is not set (it would break an API-key login stored in `auth.json`).
- **Shell shim.** Codex starts `/bin/bash` by absolute path, so the box's bash is replaced by the runner's shell shim, which hides the login files from the agent's commands (`shellOverride`; the CLI itself starts through `REAL_SHELL_IN_BOX`). The agent's own Codex home with `auth.json` is therefore not readable by the commands it runs, as in the native profile.
- **Network for the agent's commands.** Now through the proxy: `npm install`, `git fetch` and package registries work for hosts on the allow-list (a Codex agent no longer has "no network"); there is still no push (no credentials in the box, `config` and `hooks` read-only).
- **Roles (Q68, 0.1.56).** `runtimeRoleProblem` still refuses the DevOps engineer and the CEO (their own guard and full-power profiles), roles with `browser` (Unix sockets are not opened), and roles that may write only some paths (`writableGlobs`). Roles with no `shell` tool (the read-only analyst, researcher, checker, scout and curator) now run on Codex **in the harness sandbox**, because the box's shell is limited to `aom` (see "Codex without a shell" below); Codex's own macOS profile always has a full shell, so there they stay on Claude Code (`runtimeRoleProblem(..., { harness: false })`, the runner passes where it runs; the server does not know and lets the role through). The hire dialog and the runner agree (`codex_role_refused`).
- **Codex without a shell (Q68).** A role without the `shell` tool, and every chat, gets `aomOnlyShell` in its `HarnessLaunch`: the shim that is the box's `bash` (and `sh` where it links to bash) first checks the command. It runs only `aom` and its arguments, written as plain words or in quotes without expansion: no `;`, `&&`, `||`, `|`, `&`, redirection, `$`, backtick, subshell, glob, brace, `~`, comment or newline, no `$`, backtick, backslash or `!` inside double quotes, and not `aom-env`, `/usr/bin/aom`, `env aom` or `cd . && aom`. Any other way of starting the shell (`bash` with no command, an option such as `-x` or `--rcfile`, extra arguments, a script outside the runner's own `bin` folder) is refused with exit status 126 and the message "this agent may run only the aom command in the shell". The runner's own scripts still start (`#!/usr/bin/env bash` helpers, from a read-only folder named `bin`). This is the box's doing, not Codex's: its own rules cannot be trusted to hold (`aomOnlyShell` in `RUNTIME_GUARANTEES` is true for Codex only with `aomOnlyShellNeedsHarness`). Proved by `aom-only-shell.test.ts` in the real bubblewrap box (a Codex-style `/bin/bash -lc`, `/usr/bin/bash`, `/usr/bin/env bash`; a role with a shell keeps a full one).

Parity changes in harness mode (rows not listed are as in the table above):

| Guarantee | Codex, native profile (macOS) | Codex, harness sandbox (Linux, 0.1.55) |
| --- | --- | --- |
| Network | off | egress proxy with the domain allow-list, extra hosts and private endpoints |
| `aom` over IPC | `allow` execpolicy rule runs it outside the sandbox | the IPC socket is bridged into the box (socat), `aom` runs inside |
| Credentials | `auth.json` hidden by the profile | API key held by the proxy; `auth.json` hidden from the shell by the shim |
| Secret files in reference repositories | deny globs fixed at start | the box shows only its read allow-list, with the same secret-file list masked |
| Denied shell patterns | execpolicy `forbidden` prefix rules | the same rules file, plus the box (no credentials, no push) |
| Token cost | priced (below) | priced (below) |

**Shift resume.** A shift that is put back resumes its Codex session: the runner reads the thread id from `thread.started`, and `codex exec resume <thread>` continues it. Before resuming, `sessions/codex-rollout.ts` checks the agent's `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` (the transcript) and starts fresh, saying which in `shift.session.resume`, when the file is missing, belongs to another working folder, or the agent's session list does not name it. `sessions.json` records the runtime with each session, so a Claude id is never passed to Codex or the other way round.

**Token cost.** `CODEX_MODEL_PRICES` in `packages/shared/src/models/codex.ts` (USD per million tokens: `gpt-6-luna` 0.1/0.5, `gpt-6.1-sol` 2/10, `gpt-6-sol` 2/10, `gpt-6-astra` 10/50; cached input at the listed cache rate, no cache-write charge) prices Codex turns; a model not listed is still "cost unknown" (0, flagged), never priced as another model. A ChatGPT plan login carries the same API-equivalent figure the Claude Code subscription does. An Owner-set price for a model wins (see the cost notes in ARCHITECTURE 38.11).

**Tests.** `apps/runner/test/codex-adapter.test.ts` and `harness-sandbox.test.ts` (a fake `codex`: argv, environment, proxy route, shim), `codex-resume.test.ts` (rollout reader and resume decisions), shared `codex-runtime.test.ts` (prices), and the opt-in `codex-harness-real.test.ts` (set `AOM_CODEX_REAL_BIN=/path/to/codex`, needs bubblewrap and socat): the real 0.164.0 binary against a fake Responses API in the real box. It checks that the key is added by the proxy and absent from the box, that a command cannot read `auth.json`, that a non-allow-listed host is refused, and that `resume` continues the thread.

### Claude Code on Bedrock, Vertex AI or a gateway

The same adapter, harness and sandbox as Claude Code on a subscription; only the model backend changes. An agent's model is `bedrock:<model id>`, `vertex:<model id>` or `gateway:<model id>` (the part before the first colon is the backend). The credential is entered under the workstation's (or the organization's) Model providers, sealed in the browser to the runner like a provider key, kept in the provider store and put into **that agent's Claude Code process only**; it is in the redaction registry (logs, activity, errors) and never in the agent's shell, because the sandbox hides the process environment of the CLI from commands.

| Backend | Credential fields | Claude Code environment set for the process |
| --- | --- | --- |
| Amazon Bedrock | region; a Bedrock API key (bearer token) or access key id, secret and optional session token | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK` or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` |
| Google Vertex AI | project id, region, service-account JSON | `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS` (the JSON is written 0600 in the runner's secrets folder for that session, which no agent shell can see, under a random name, and removed when the session ends or fails to start; the runner also removes any `vertex-*.json` left in that folder when it starts) |
| Anthropic-compatible gateway | base URL, token or API key | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` |

All three also set `ANTHROPIC_MODEL` and the `ANTHROPIC_DEFAULT_OPUS_MODEL`/`SONNET`/`HAIKU` pins to the chosen id (so Claude Code's own small-model calls do not name a model the backend lacks) and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. The subscription login of the workstation is not used for such a run. Variable names are Claude Code's documented settings (code.claude.com, Amazon Bedrock, Vertex AI and LLM gateway pages), checked against the real `claude` binary talking to a fake gateway (`apps/runner/test/claude-backend-real.test.ts`, opt-in); Bedrock and Vertex themselves were **not** called (no cloud account), only their environment contract was checked.

Roles: every role Claude Code can take except DevOps and the CEO (they need the owner's own login). **Warning shown in the UI:** non-Claude models behind a gateway may follow Claude Code's tools and instructions less reliably, and Anthropic does not support that setup. Cost: priced from the model id when it is a known Claude id, otherwise unknown.

### Gemini CLI runtime

The `gemini` runtime runs Google's Gemini CLI (checked against `@google/gemini-cli` 0.65.0) for card shifts and chats. It is registered **only when the `gemini` binary is found** and is `available` only where the runner's own sandbox runs (Linux or WSL2 with bubblewrap and `socat`); there is no unsandboxed mode. See "Sandbox parity of the other runtimes" below for the sandbox.

```
gemini -p '' --output-format stream-json --approval-mode yolo --skip-trust --model <id>
       [--resume <session uuid>] --admin-policy <policy.toml> --include-directories <readonly dirs>      # prompt on stdin
```

- `--approval-mode yolo` is required headless (there is nobody to approve); the safety is the sandbox and the admin policy, not the CLI's prompts. `--skip-trust` stops the folder-trust prompt. The CLI's own sandbox options (seatbelt, docker, podman, runsc, lxc) are **not** used: the runner's bubblewrap wraps the whole CLI.
- `--admin-policy` is the policy tier above user and workspace settings, so nothing in the repository or the owner's folder can override it: the role's allowed `aom` command and the role's denied shell prefixes (`git push`, ...) as `commandPrefix` rules; a role with no shell tool gets a shell restricted to `aom`.
- Output: one JSON event per line: `init {session_id, model}`, `message`, `tool_use`, `tool_result`, `error`, `result {status, stats}`. `stats.input` is the non-cached prompt, `cached`, `output_tokens`; usage is `gemini:<model>`. Other lines (startup notes) are ignored.
- **Sign-in.** `login`: the owner's login (`gemini-credentials.json`, the encrypted file store whose key derives from hostname and user, or the legacy `oauth_creds.json`; the OS keychain is not read, set `GEMINI_FORCE_FILE_STORAGE` by signing in with the file store) is **copied into a private `GEMINI_CLI_HOME`** per agent and a refreshed copy (newer file) is harvested back when the session ends, so parallel agents cannot clobber each other's rotated token. Inside the box the login files are hidden from the agent's shell. `api_key`: the stored `google` key; it never enters the sandbox, the egress proxy adds `x-goog-api-key` on a route and the CLI is pointed at the proxy with `GOOGLE_GEMINI_BASE_URL`. An unsigned or expired login ends the session with `authFailed` and the runtime reports `auth: expired`. A quota message ("Your quota will reset after 3h5m20s") is a usage limit with that reset time, not a crash. **Login files and the agent's tools (0.1.56).** The admin policy has a rule at priority 990 that denies the file tools (`read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`, `write_file`, `replace`) and the shell any call whose arguments name `oauth_creds`, `gemini-credentials` or `google_accounts`; the tokens are registered with the redaction registry. A login found in the agent's home after a session goes back to the owner only if it parses, is the same account (same refresh token and id-token subject, scopes not wider), has no unexpected fields and an expiry not more than two hours ahead; the owner's file keeps its form (an encrypted `gemini-credentials.json` is sealed again in its own layout, a plain file is never put in its place) and the copy and hand-back run under a lock folder beside the owner's login (`<file>.aom-lock`, as for Codex). A private copy that fails the checks is replaced by the owner's. The policy rule uses the policy engine's `argsPattern`; it was written from the CLI's documented policy format and not run against a real gemini in this change (the opt-in `gemini-real.test.ts` still has to be run on a machine with the binary).
- **Instructions and skills** use the same provider-neutral renderer as `CLAUDE.md` and `AGENTS.md` (written to the agent's private home as `GEMINI.md`); granted skills are materialised into the agent's private `GEMINI_CLI_HOME/.gemini/skills`; the repository's `AGENTS.md` is read as well; the owner's `~/.gemini` is never read.
- Models: built-in list plus `runtimes.gemini.models`; data-driven in the pickers.

### opencode runtime

The `opencode` runtime runs the open-source opencode CLI (checked against `opencode-ai` 1.19.4) with the provider keys held on the workstation (OpenAI-compatible, Anthropic, Google, OpenRouter, ... whichever keys exist). Models are `provider/model`; global instructions are the private `opencode/AGENTS.md` and granted skills `opencode/skills/` under the agent's private XDG config. Registered only when the `opencode` binary is found; same sandbox requirement as Gemini.

```
opencode run --format json -m <provider>/<model> [-s <ses_...>]       # prompt on stdin
```

- Everything the runner decides is in the environment, so a repository's or the owner's own opencode files cannot loosen it: `OPENCODE_CONFIG_CONTENT` (permission table, `enabled_providers` limited to the held keys so the vendor's hosted models are unreachable, provider base URLs pointing at the egress proxy), `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_EXTERNAL_SKILLS` (the repository's `.claude` and `.agents` are not read), `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_PURE`, and `XDG_*` into the agent's private home.
- Permissions are **last match wins**: `bash: {"*": "deny", "aom *": "allow", ...}` for a role restricted to `aom`; a role without `edit` has the edit and write tools denied (opencode then hides the write tool); `external_directory` is denied.
- Events: `step_start`, `text`, `tool_use`, `step_finish {tokens: {input, output, cache}}` (input excludes cache), `error`. Usage is booked under the provider of the key (`keySource`, `keyProvider`).
- API keys are never in the sandbox: each provider has an egress route that adds the key header upstream.

### Sandbox parity of the other runtimes

Gemini CLI and opencode have no OS sandbox of their own that holds under Linux, and no split between "the CLI" and "the shell it starts", so the runner puts **the whole CLI** in bubblewrap (`sandbox/harness-sandbox.ts`) and exposes the network only through an egress proxy (`sandbox/egress-proxy.ts`). Requirements: Linux or WSL2, `bwrap`, `socat`; the runtime reports `sandbox: unavailable` with the reason otherwise and refuses every session.

| Guarantee | Claude Code | Codex | Gemini CLI and opencode (harness sandbox) |
| --- | --- | --- | --- |
| What is sandboxed | the agent's shell | the agent's shell | the whole CLI and everything it starts |
| Private `HOME` and config | yes | yes | yes (`GEMINI_CLI_HOME` / XDG dirs in `agents/<id>`) |
| Runner environment kept out | allow-list | allow-list | new env; empty root, new user, pid, ipc, uts, cgroup namespaces |
| Owner's home, runner data dir and token, other agents, `~/.ssh`, Docker socket | hidden | hidden | not present in the box |
| Writes only in worktree, home, scratch, tmp, caches | yes | yes | yes (worktree read-only for roles without `edit` and for chats) |
| Secret files in reference repos | masked | deny globs fixed at start | masked with /dev/null at start |
| Network | domain allow-list | off | no interface; egress proxy with domain allow-list, ports 80 and 443, public addresses only |
| Model API key | in the CLI process | in the CLI process | **not in the box**: the proxy adds it upstream (Google login excepted, see below) |
| CLI's own login files | in the agent's config dir | hidden from the shell | exist for the CLI, masked from the shell by a nested sandbox shim |
| `aom` over IPC | Unix socket | execpolicy allow outside sandbox | Unix socket through the box |
| Git: commit yes, push no | yes | yes | yes (no credentials, no network to git hosts) |
| Denied shell patterns | permission rules | execpolicy | Gemini admin policy / opencode permission table (best effort, the structure holds) |
| Shell limited to `aom` (roles without a shell) | `Bash(aom:*)` | harness sandbox: **yes** (the box's bash is the aom-only shim); macOS profile: not possible | **yes** |
| Per-role path scopes (tester, writer, architect) | `Edit` globs | no | no |
| Browser roles | opt-in | no | no |
| DevOps guard, DevOps and CEO | yes | no | no |
| MCP servers | per role | none | none |
| Token cost | priced | unknown | Gemini priced by `gemini:<model>`; opencode by key provider where priced, else unknown |

Gaps, said plainly: the Gemini login files must exist inside the box for the CLI, so a prompt-injected model could use the CLI itself to call tools but cannot read them from the shell (masked); with a Google login the traffic goes straight to Google's hosts on the allow-list (`cloudcode-pa.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`) because the login flow cannot be routed through a key route. The proxy refuses private addresses, so a local Ollama or a self-hosted endpoint works only as a configured route target.

**Roles each runtime may take** (`runtimeRoleProblem`, the same check on the server, in the hire form, in "move agent" and in the CEO raise-model action, and again in the runner at session start with `runtime_not_for_role`):

| Role kind | Claude Code (incl. Bedrock, Vertex, gateway) | Codex | Gemini CLI | opencode |
| --- | --- | --- | --- | --- |
| Builder, reviewer, planner, pre-reviewer, BA tasks and chats, custom roles with a shell | yes | yes | yes | yes |
| Read-only roles with no shell (analyst, researcher, checker, scout, curator) | yes | yes in the harness sandbox (Linux, WSL2: shell limited to `aom` by the box); no on macOS | yes (shell restricted to `aom`) | yes (same) |
| Tester (browser) | yes | no | no | no |
| Writer, architect (path-limited edit) | yes | no | no | no |
| DevOps, CEO | yes on subscription; **no** on Bedrock, Vertex or a gateway | no | no | no |

**Verified against real binaries and what was only faked.** gemini 0.65.0 and opencode 1.19.4 were installed and run in the real sandbox against fake local model APIs (`gemini-real.test.ts`, `opencode-real.test.ts`, opt-in with `AOM_GEMINI_REAL_BIN` / `AOM_OPENCODE_REAL_BIN`): argv, event format, policy enforcement (denied commands, hidden login files, no network except the proxy, key not visible), session resume. Real Google and provider accounts, real quota messages and the Google login flow were **not** exercised (a faked login file and a faked API only); Bedrock and Vertex were not called.

### Provider keys: workstation and organization

Keys for direct-model providers, opencode and the Claude Code backends live in the provider store on the runner (`secrets/providers.json` for the workstation's own keys, organization keys in slots per organization id). The server and the browser never see them again: the browser seals a key to the runner's public key (`provider.key.set`), and `provider.key.clear` removes one. **Organization keys** (Settings > Model providers, Owner or Admin) are sealed once per target workstation in the admin's browser, so the server stores only ciphertexts per workstation. A workstation added later receives its copy when the admin enters the key again, or through "Share to this workstation": the server sends the durable `provider.key.reseal` command to a runner that holds the key, the runner re-seals to the new workstation's public key and the server stores the result once an Owner or Admin approved. Revoking deletes the key on every workstation. Resolution order for a run: the workstation's own key, else the organization's key for the agent's organization, else none. A workstation key overrides the organization's and is not capped. A runner older than 0.1.49 (no `provider-keys:2` in its capabilities) can use workstation keys as before and cannot receive organization shares (the server answers 422 `runner_too_old`).

**Keys are bound to their purpose (0.1.56, `provider-keys:3`).** The browser seals every provider and backend credential as `h2.` (the `h1.` scheme plus AES-GCM associated data) over: the scope (workstation or organization), the organization id, the provider, the endpoint (`baseUrl`, also the one inside a Bedrock, Vertex or gateway credential), the organization key's **generation** and the runner key id. The runner rebuilds that string from the command it received, so a ciphertext the server relabelled (an organization OpenAI key presented as an `openai-compatible` key aimed at another host, a copy moved to another organization, another endpoint) does not open. Organization keys carry a generation (`org_providers.key_generation`, one more each time the key is set); the runner keeps the highest generation it revoked or replaced (`secrets/providers-org-floor.json`) and refuses a copy at or below it, so a replayed old key is refused. The older unbound forms are accepted only for a workstation's **own** key (with a warning in the answer, and never to replace a bound one); an **organization** key in the old form is refused and an old stored one is not used: the Owner or Admin sets the key again (Settings > Model providers). A run that names no organization uses the workstation's own key only; the runner no longer picks the single organization that holds a key. An organization's endpoint (an OpenAI-compatible URL, a gateway, Bedrock or Vertex base URL) must be https to a public address or an exact entry in the workstation owner's private endpoints; loopback is not exempt.

**Sharing an organization key to another workstation needs an approval made in the admin's browser.** The page shows the target runner's key id; on "Approve and share" it seals `{organization, provider, generation, source key id, target key id, SHA-256 of the target's public key, nonce, expiry (15 minutes), admin}` to the **source** runner's key (`h2`, bound to organization, provider and source key id). `provider.key.reseal` carries that approval. The source runner opens it, recomputes the target key id and the hash from the public key it is asked to seal to and refuses any difference, checks the generation against its stored key, the expiry and that the nonce was not used before (`secrets/reseal-approvals.json`), and only then seals the key to the target, bound to the same organization, endpoint and generation. Without a valid approval the runner answers an error. Residual risk: a server that can seal to a public key can make a well-formed approval itself; the approval stops a server (or a database change) that swaps the target key behind an admin's back, a stale or foreign command, and a replay, but it is not a signature by the admin (there is no admin signing key). Setting, replacing or revoking the key fails pending reshares on the server, and an answer whose generation is not the current one is dropped.


### R2 hardening on the runner (0.1.50)

- **Skill guard timeout.** The `aom skill-guard` hook answers "deny" itself after 7 seconds, below its 10 second hook timeout, because Claude Code lets a call through when a hook is killed at its limit. A guard that cannot read its input, its configuration or finish in time refuses the skill. Set `AOM_SKILL_GUARD_DEADLINE_MS` (below 10000) only in tests.
- **Delegates.** A delegate on a CLI runtime (Claude Code, Codex, Gemini CLI, opencode) is stopped after 10 tool calls; Claude Code has no max-turns flag in print mode, so the runner counts the stream. The runner sends a heartbeat to the server every 15 seconds while a delegate runs; if the runner stops or disconnects the delegate's slot is freed within about 45 seconds (at once on disconnect).
- **Codex login.** `auth.json` is copied to the agent's private `CODEX_HOME` and a refreshed copy handed back under a lock directory next to the owner's file (`auth.json.aom-lock`; stale after 10 seconds). Newer `last_refresh` wins; a login the owner made in the meantime is not overwritten. A leftover `auth.json.aom-lock` folder after a crash is harmless. **Checked on the way back (0.1.56).** The agent's tools can write its private Codex home (`apply_patch`), so a copy is accepted back only if it has the shape Codex writes, its tokens are single tokens, it is the same account (`account_id`, id-token subject; the refresh token may rotate), it does not change the API key setting and its `last_refresh` is not in the future; otherwise the owner's file is left alone and a warning is logged. A private copy that fails the same checks is replaced by the owner's at the next session. The tokens are registered with the redaction registry. Codex has no per-path switch for `apply_patch`, so the login stays hidden from the agent's shell and this check is the control.
- **Provider keys of any length.** Keys are sealed in the browser as `h2.` (RSA-OAEP wrapped AES-GCM key, with the purpose as associated data, see "Provider keys: workstation and organization"; `h1.` before 0.1.56) and the runner opens the older forms only for a workstation's own key. For Google Gemini a service-account JSON can be entered in place of an API key; the runner exchanges it for short-lived tokens at `oauth2.googleapis.com` only.
- **Prompt caching and cost.** The direct-model runtime marks the system prompt for Anthropic's prompt cache, gives OpenAI a stable cache key and keeps the prompt stable-first for Gemini. Cache reads and writes are in the turn's usage and priced.
- **Chat history retention.** Chats on a direct-model provider keep their text in `<data dir>/direct-chats/`. Files not written for `directChatRetentionDays` (config.json, default 90; 0 keeps them forever) are deleted at start and every six hours.

### Mock adapter

Token-free test adapter driven by a script in `card.fields.mock`.

**Behavior per stage (default):**
- `build`: write files, commit, report `aom handoff`
- `review`: approve (score 4)
- `test`: pass
- Other stages: first success outcome

**Script format:** `{ "<stage>": ["<action>", ...] }`

Actions (consumed by attempt index):

| action | effect | outcome |
| --- | --- | --- |
| `ok` | stage default | reported |
| `changes` | review bounces (score 2); test fails | reported |
| `fail` | review/test fails | reported |
| `question` | raises a blocking question | no_report |
| `crash` | exits 1 immediately | crashed |
| `hang` | never exits; stopped at `maxShiftMinutes` | timeout |
| `no_report` | finishes work but exits 0 without reporting | no_report |
| `edit_outside_scope` | writes out-of-scope file; reported as ok; guard rejects | no_report + guardViolations |

**Example:**
```json
{
  "review": ["changes", "ok"],
  "test": ["fail", "pass"]
}
```

First review bounces, second approves; first test fails (creates bug card), second passes.

**Testing options:**
- `AOM_MOCK_STEP_MS=50` (default 100): speed up mock progress steps (in milliseconds)
- `AOM_RUNNER_MAX_SHIFT_MS=5000`: override maxShiftMinutes for testing (milliseconds)
- `--mock` flag or `AOM_RUNNER_MOCK=1` env var: enable mock runtime

## Sandbox isolation

Each agent runs with its own home directory and config, wiped when the agent is fired (or when the DevOps engineer is reset).
On top of that, Claude Code sessions run inside Claude Code's own sandbox and permission system. Read
[Threat model](#threat-model-and-residual-risk) for what this does and does not protect against.

**Exception: the DevOps engineer.** The workstation's DevOps engineer (the agent with `isDevops`, built-in role `devops`)
runs its shifts **and its chats** outside this sandbox by design, so that it can deploy to the local Docker stack
(`docker compose -p aom-uat ... up -d --build`), to remote hosts (ssh, scp, docker contexts), install tools and use sudo.
See [DevOps shifts are unsandboxed](#devops-shifts-are-unsandboxed).

### Per-agent directories

- `agents/<agentId>/home/`: HOME directory with a `.gitconfig` that holds the commit identity of the current shift (see "Commit identity")
- `agents/<agentId>/claude/`: CLAUDE_CONFIG_DIR for Claude Code (credentials, auto-memory, caches)
- `agents/<agentId>/scratch/`: working directory for agent's scratch files

All are cleaned up when the agent is fired.

### Agent temp directory (`TMPDIR`), cleaned after every shift

The agent's `TMPDIR`/`TMP`/`TEMP` and `CLAUDE_CODE_TMPDIR` is `/tmp/aom-<10 hex>` (hash of data dir + agent id), mode 0700,
on Linux/macOS. It is a short path on purpose: Unix socket paths are limited to 108 bytes and Claude Code puts its
sockets (`cc-socks/`, `claude-http-*.sock`) and `claude-<uid>/<cwd>/` temp there. Claude Code's sandboxed shell uses
`claude-<uid>/` inside it as its `$TMPDIR`, which is where reviewers' and testers' build copies landed. On a machine
where `/tmp` is a RAM tmpfs nothing removed them, and they filled it (backlog #81, 24 GB tmpfs, about 21 GB of
`/tmp/aom-*/claude-1000/*`).

- **End of every shift** (done, crash, stop, timeout, rejected after start) and end of every chat: everything in the
  agent's temp dir is removed except `node-compile-cache/`. The card attachments are copied again at the next start. The
  cleanup is skipped while another shift or chat of the same agent (this process) uses the same dir, and it only ever
  lists the direct entries of the dir, so a symlink is unlinked and never followed, a dir that is itself a symlink or is
  not named `aom-*` is refused, and another agent's or runner's dir is never touched.
- **Runner start**: before shifts are resumed, the temp dirs of all agents under `<data dir>/agents/` are cleaned
  (agents with a shift about to be resumed are skipped), which also removes what a killed runner left behind.
- The reviewer instructions (role version 5) tell the reviewer to delete its build copy when done and say that
  `$TMPDIR` is emptied after the shift.
- **Not moved to disk**: the temp dir stays under `/tmp` because of the socket length limit, and Claude Code's shell
  derives its `$TMPDIR` from `CLAUDE_CODE_TMPDIR`, so a long on-disk path would break the sockets; cleaning is the fix.
  The agent's `scratch/` is on disk under the data dir.

### Shared package caches and .NET in the sandbox

Every agent has a private HOME, so `~/.nuget/packages`, `~/.npm`, the pnpm store, pip, Gradle and Maven caches used to
start empty for every agent and every shift: a full package restore each time. The runner now keeps one set of caches
per runner, under `<data dir>/cache/`, created at the first shift and shared by all of its agents:

| Directory | Variable the agent's environment gets |
| --- | --- |
| `cache/nuget`, `cache/nuget-http`, `cache/nuget-plugins` | `NUGET_PACKAGES`, `NUGET_HTTP_CACHE_PATH`, `NUGET_PLUGINS_CACHE_PATH` |
| `cache/npm`, `cache/pnpm`, `cache/yarn` | `npm_config_cache`, `npm_config_store_dir` (pnpm), `YARN_CACHE_FOLDER` |
| `cache/pip` | `PIP_CACHE_DIR` |
| `cache/gradle` | `GRADLE_USER_HOME` (caches only: the agents' homes hold no `gradle.properties` or credentials, and the user's `~/.gradle` is not shared) |
| `cache/maven` | `MAVEN_OPTS=-Dmaven.repo.local=<dir>` (the user's `~/.m2/settings.xml` is not read) |
| `cache/go-mod`, `cache/go-build` | `GOMODCACHE`, `GOCACHE` |

The cache directories are in the sandbox's `allowWrite` (and nothing else under the data dir is). Cargo is not shared:
its home also holds installed binaries and registry credentials. Your own `~/.nuget/packages`, when it exists, is
offered read-only as a NuGet fallback folder (`NUGET_FALLBACK_PACKAGES`, and in the sandbox's `allowRead`): packages you
already restored are found without a download, and nothing can write to that folder. The sandbox's network allowlist
includes `api.nuget.org` and `*.nuget.org`.

**Trade-off.** Agents of one runner share these caches, and they run as the same OS user. An agent could therefore put a
modified package into the shared cache that another agent later builds with. That is the same trust level as the rest
of the sandbox (see "Threat model and residual risk"): the packages come from the registries the agent can already reach,
the caches are content-addressed by package id and version, and they never reach your own caches. Delete
`<data dir>/cache` at any time to start clean; it is recreated on the next shift. The DevOps engineer is unsandboxed and
keeps using your own caches.

**.NET.** `dotnet build`, `test` and `restore` failed inside the sandbox with
`System.IO.IOException: The system cannot open the device or file specified. : NuGet-Migrations`. On Linux .NET keeps
the shared memory and lock files behind named mutexes in `/tmp/.dotnet` (it ignores `TMPDIR`), the sandbox's `/tmp` is
read-only, and NuGet takes a named mutex at startup. The runner creates `/tmp/.dotnet` (mode 0777, as .NET does) and
puts it in `allowWrite`. Each agent also gets `DOTNET_CLI_HOME` (its own home), `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`,
`DOTNET_NOLOGO=1`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `NUGET_CERT_REVOCATION_MODE=offline` (the sandbox does not allow
the certificate revocation hosts, which only delayed restores) and, so that no build server outlives the shift,
`MSBUILDDISABLENODEREUSE=1`, `DOTNET_CLI_USE_MSBUILD_SERVER=0`, `UseSharedCompilation=false` and
`DOTNET_PROCESSOR_COUNT=1` (see "MSBuild worker nodes" below). If the `dotnet` install
is under your home (for example `~/.dotnet`) it is found automatically, see "Agent toolchains". Verified in the real
sandbox (`dotnet new console` and `dotnet build`, with a package from the fallback folder and one downloaded into the
shared cache); `test/sandbox-caches.test.ts` repeats it under bubblewrap and skips when `bwrap` or `dotnet` is missing.

**MSBuild worker nodes.** A `dotnet build`/`test` of more than one project makes MSBuild start one worker node per CPU.
The nodes talk to the build over a named pipe, which .NET implements as a Unix socket at the hard-coded path
`/tmp/MSBuild<pid>` (it ignores `TMPDIR`). In the sandbox that fails twice over: the Linux seccomp filter refuses
`socket(AF_UNIX)` (`SocketException (13): Permission denied` in `NamedPipeServerStream`, the stack seen in production
card P4-7), and with Unix sockets opened the `bind()` still fails on the read-only `/tmp` and the build hangs.
Allowing `/tmp` writes would expose other sessions' files, so the runner avoids the nodes instead: every agent gets
`DOTNET_PROCESSOR_COUNT=1`, MSBuild sizes its node count from the processor count and builds in one process, and a plain
`dotnet build`/`dotnet test` works. The trade-off is that every .NET process of the agent (also the test host) sees one
CPU, so builds are not parallel. An explicit `-m:N` with N above 1 still fails; the agent instructions say not to pass it.
Verified through `claude -p` in the real sandbox (4-project solution, two xunit projects) and under bubblewrap in
`test/sandbox-caches.test.ts`, which also shows the same build failing without the variable. The unsandboxed DevOps
engineer is not affected.

### Agent toolchains

The sandbox hides `/home`, and the PATH of the runner service rarely has the tools a project needs (a system `dotnet`
with SDK 8 first, Node under nvm, Go under `~/go/sdk`). The runner therefore keeps one list of **agent toolchains**, each
`{ name, binDirs, readDirs, env, source }`, and gives all of it to every sandboxed agent and chat (new shifts and chats
pick up a change; no restart):

- **PATH:** every `binDirs` (that exists) goes after the `aom` shim and before the service PATH, in a stable order:
  registered by DevOps, then configured, then detected. The unsandboxed DevOps engineer gets the same PATH.
- **Read access:** `binDirs` and `readDirs` are added to the sandbox's readable toolchain paths (with the Node install
  and `toolchainPaths`). They are read-only.
- **Variables:** `env` is merged (the first entry that sets one wins). Credentials are refused: a name containing TOKEN,
  SECRET, PASSWORD, KEY, CREDENTIAL, AUTH, COOKIE or SESSION unless it is on the allowlist (`DOTNET_ROOT`, `JAVA_HOME`,
  `GOROOT`, `ANDROID_HOME`, `RUSTUP_HOME`, ...), a value that looks like a token, key or URL with a password, and the
  names the runner owns (`PATH`, `HOME`, `TMPDIR`, `LD_*`, `AOM_*`, `CLAUDE*`, `GIT_*`, `NUGET_*`, ...).

Sources: **detected** (directory reads only, nothing is started): the .NET root, nvm's default Node, pyenv shims, uv
Pythons, `/usr/local/go` and `~/go/sdk/go*` (`GOROOT`), `~/.cargo/bin` (the bin folder only: the cargo home holds
credentials; the rustup toolchains are readable), sdkman Java/Gradle/Maven (`JAVA_HOME`), mise and asdf shims and
`~/.local/bin`; **config** (`runtimes.claude-code.toolchainPaths`, read access only as before, and the top-level
`dotnetRoot`); **devops**, stored in `<data dir>/toolchains.json` (mode 0600, re-validated on every load).

**.NET.** The `dotnet` muxer resolves SDKs only inside its own root, so one root has to hold them all. The candidates are
`$DOTNET_ROOT`, `~/.dotnet`, `/usr/share/dotnet`, `/usr/lib/dotnet`, `/usr/local/share/dotnet`, `/opt/dotnet`, the
Homebrew locations and the root behind `dotnet` on PATH (symlinks resolved); SDKs are the names under `<root>/sdk`,
runtimes those under `shared/Microsoft.NETCore.App`. The root with the most SDK versions wins (a superset of the others
when there is one; a tie goes to the highest SDK), `dotnetRoot` in `config.json` overrides. The agent gets
`DOTNET_ROOT=<root>` and the root first on PATH. On the owner's machine this is `~/.dotnet` (8.0.425 and 10.0.401), not
`/usr/local/bin/dotnet`. The environment check ("Development environment") no longer asks `dotnet --version`: it reads
`global.json` (with its `rollForward`, default `latestPatch`) and the `TargetFramework(s)` of the projects against the
chosen root and reports `missing SDK 10.0.100 (global.json)`, `missing SDK 10.0 (target framework net10.0)` or
`missing runtime 8.0`, plus a line **.NET SDKs 8.0.425, 10.0.401 (~/.dotnet)**. With "Install packages and tools"
allowed it installs into the chosen root with `dotnet-install.sh --install-dir <root> --channel <x.y>` (no sudo when the
root is in the user's home); a root that is not writable (`/usr/share/dotnet`) keeps the package manager recipes.

**`aom toolchain`** (outside the sandbox, over the IPC like `aom git`):

```
aom toolchain list
aom toolchain add <name> --bin <dir> [--bin <dir>]... [--read <dir>]... [--env KEY=VALUE]...
aom toolchain remove <name>
```

Everyone may `list`; only the DevOps engineer (shift or chat) may `add` and `remove`. The runner checks every path: it
must be absolute (`~` allowed) and exist, is resolved with `realpath` (a symlink into `~/.ssh` is refused), and may not
be `/`, the home folder or a parent of it, the runner's data folder or anything inside it, or a credential store
(`~/.ssh`, `~/.aws`, `~/.config/gh`, ...); a bin folder must contain an executable. A registered name replaces a detected
one. The DevOps instructions say: after installing a tool for the agents, register it, and prefer user-space installs
(`~/.dotnet`, `~/.local`, `~/go/sdk`, nvm, pyenv/uv, sdkman, mise/asdf). The agents' instructions list the toolchains
(`Toolchains available to you: dotnet 8.0.425, 10.0.401; node-nvm 22.1.0; ...`) and tell them to ask `aom devops`
instead of installing a tool themselves.

**Workstations page.** The runner reports the list (`toolchains.report`: names, versions, folders and variable *names*,
never a value) after `welcome`, when it changed and after every `aom toolchain add|remove`; the card shows **Agent
toolchains** with the source ("detected", "added by DevOps on <date>") and, for the owner, **Remove** on the ones DevOps
registered (`toolchain.remove` command). Verified in the real bubblewrap sandbox with `/home` hidden: net8.0 and
net10.0 projects build and run from `~/.dotnet` although `/usr/local/bin/dotnet` (SDK 8 only) is first on PATH
(`test/sandbox-dotnet-roots.test.ts`, skipped without bwrap or dotnet).

### Commit identity

Every commit the runner or an agent makes carries the owner's own name, so the work reads as the owner's (backlog #65).
One resolver (`src/git/identity.ts`) picks the identity, in this order:

1. the project setting **Commit as** (name and e-mail, Project settings; arrives as `commitAs` in `shift.start`,
   `finalize.execute` and `repo.create`),
2. the clone's repository-level `git config user.name` / `user.email` (a card worktree shares the clone's config),
3. the workstation user's global git config, then the system one, as the runner's OS user sees it,
4. none: the runner refuses to commit. A shift that works in a repository is rejected (`internal`, detail
   `no_commit_identity: ...`); the card gets a note and the desk one alert per workstation and project; a finalize returns
   the same message. It names the three places to set the identity. There is no fallback to an agent or product name.

Name and e-mail come from the same level (a level with only one of them is skipped). The identity is used as author and
committer by: the agent sandbox (its `.gitconfig` and `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so an agent commits as the owner
whatever it types), the shift-end leftovers commit, finalize merges, the merge of main into the working branch and the card
branch, rebases, saved-work stashes, the first commit of `repo.create`, and the knowledge vault clones (vaults have no
project: steps 2 and 3 only). Messages are plain: `[<ticket>: ]Work in progress`, `[<ticket>: ]<title>` for merges and
pull requests, `Update notes <time>` for vault syncs; the ticket is the tracker key the card came from, never a card ref.
The runner reports the identity each clone would use (`identity: {name, email, source}`) in `hello` and `repos.report`; the
web app shows it in Project settings. Tests set `GIT_CONFIG_GLOBAL` to a temporary file (`test/setup-git.ts`); nothing reads
the real `~/.gitconfig`.

### Git worktrees

Worktrees are created under `worktrees/<KEY>-<project id prefix>/<REF>/` (project keys are only unique per
organization, so the project id keeps two same-keyed projects on one workstation apart) and reused across stages of the
same card. Worktrees created by older runner versions under `worktrees/<KEY>/<REF>` keep working: reuse follows the path
the server recorded for the card. They are removed after finalize (`worktree.remove`), when the card ends without a merge, and by the sweep below.

#### Base branch and the per-clone lock

When a working branch has to be created and the project has no main branch set, the runner asks the host for its default
branch (`git ls-remote --symref origin HEAD`, with the repository's git credentials) and points the clone's `origin/HEAD`
at it; the clone's own `origin/HEAD` is only a fallback because it is fixed at clone time and goes stale. If the host
cannot be asked and the clone has more than one of `main`, `master`, `develop`, `trunk`, the runner does not guess: the
shift start (or pull request, or merge of main) fails with "Set the main branch for <repo> in Project settings". A working
branch created without an explicit main branch is noted on the card and on the desk.

All changes to one clone (worktree add and remove, branch create and delete, config writes, fetches, merging main, merge
completions) run one after another under a per-repository lock, so shifts starting together in one clone do not collide
on `.git/config.lock`. A git command that still hits "could not lock" or `index.lock` is retried a few times.

#### Stale-worktree sweep

A safety net for worktrees nobody removed (a crash, a card cancelled while the runner was offline, a database that was
reset). About 15 seconds after the first connection of the runner process, and again for every repository hygiene run
(the server sends the command `worktrees.sweep`), the runner:

1. lists `worktrees/<KEY>-<project id prefix>/<REF>` and asks the server (`worktrees.query`) which of those paths still
   belong to a live card of this workstation (a card that is not done or cancelled, or is done with its finalize still
   pending). A worktree of a finalized or cancelled card, or one the server has never heard of, is stale;
2. removes the stale ones (`git worktree remove`; the branch is kept);
3. removes empty project folders and runs `git worktree prune` in every known clone.

It is conservative: it removes nothing when the server does not answer within 15 s (`sweepAnswerMs`) or when messages
to the server are still queued in `outbox/`; it never touches the worktree of a running shift; and it never deletes a
worktree with uncommitted changes. For a stale worktree that has some, nothing is deleted: the server records a
finding (a BA signal in the daily report) with the paths of the changed files. A non-empty folder that is not a git
worktree is left alone. The result is logged to `logs/runner.log` when anything was removed or reported.

Everything the server sends that ends up in git or on the filesystem is treated as untrusted:
branch names and base branches must be valid git refs without a leading `-` (checked again on the runner, `--` is passed
before every ref and path), vault and repository URLs must be `https://`, `ssh://` or `git@host:path` without
credentials, and every worktree, integration and vault path is resolved with `realpath` and must lie strictly inside the
runner's `worktrees/`, `integration/` or `vaults/` directory; a path outside (a `..`, an absolute path, a symlink) is
refused and never deleted. `file://` and local-path remotes exist for tests only (`AOM_ALLOW_LOCAL_REMOTES=1`).

### Claude Code sandbox and permissions (per role)

Verified against the Claude Code docs (settings reference, permissions and sandboxing pages, https://code.claude.com/docs)
and `claude --help` of version 2.1.288. The runner writes `<configDir>/settings.json` for every shift and starts
`claude` with `--permission-mode dontAsk --setting-sources user`, so a cloned repository's own `.claude/settings*.json`
cannot loosen anything.

| Setting | Value | Why |
| --- | --- | --- |
| `permissions.defaultMode` | `dontAsk` | anything no allow rule approves is denied (`acceptEdits` approved every edit in the worktree whatever the role) |
| `permissions.allow` | per `allowedTools`: `Read, Glob, Grep`; `Bash`; `WebFetch, WebSearch`; `Edit(//<worktree>/**)` or one `Edit(//<worktree>/<glob>)` per `writableGlobs` entry | explicit allow |
| `permissions.deny` | `ListAgents`, `SendMessage`, `RemoteTrigger`, `Cron*`, `ScheduleWakeup`, `PushNotification`, `EnterWorktree`/`ExitWorktree` (tools that reach other Claude sessions on the machine or outside the shift; `dontAsk` would otherwise still run them); `Edit, Write, NotebookEdit` when the role has no `edit` tool; `WebFetch, WebSearch` without `web`; `Bash` without `shell`; the role's `deniedShellPatterns` and `git push/reset --hard` (and, for every role except the builder, `git rebase/checkout/switch`: see "Builders may rebase" below); `Edit` on the vault, the agent's config dir and the worktree `.git`; `Read` on the runner's `config.json`, `outbox`, `outbound`, `active-shifts`, `vaults.json`, `status.json`, `logs` and on `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.claude`, ... | deny wins over allow in every scope |
| `permissions.blockReadsOutsideWorkingDirectories` | `true` | the Read/Grep/Glob tools only see the worktree (or scratch dir), the agent's scratch dir, the vault and the project's read-only folders (`--add-dir`; see "Reference repositories and other read-only folders" below); other agents' sandboxes and other cards' worktrees are out of reach |
| `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands` | `true`, `true` (`sandbox: "required"`), `false` | Bash runs inside bubblewrap (Linux/WSL2) or Seatbelt (macOS); no `dangerouslyDisableSandbox` retry; no silent fallback to unsandboxed |
| `sandbox.filesystem.denyRead` | the runner data dir, `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.config/gh`, `~/.config/gcloud`, `~/.claude`, `~/.claude.json` | runner token, Jira and provider credentials, the copied `.credentials.json` |
| `sandbox.filesystem.allowRead` | its worktree, the vault, the `aom` shim and script, the Node install the runner runs on, and `runtimes.claude-code.toolchainPaths` | with the read block on, sandboxed commands lose read access to all of `/home`; this re-opens only what the shift needs (toolchains such as `~/.nvm/...` included) |
| `sandbox.excludedCommands` | `aom`, `aom *`, `<runner>/bin/aom`, `<runner>/bin/aom *` | entries use `Bash(...)` rule syntax, so a bare `aom` would only match `aom` with no arguments; `aom` must run outside because Linux sandboxes cannot connect Unix sockets |
| `sandbox.filesystem.allowWrite` / `denyWrite` | agent `home` + `scratch` + `tmp` + the main repository's `.git` (a linked worktree commits into it) + the runner's shared package caches (`<data dir>/cache`) + `/tmp/.dotnet` on Linux (see "Shared package caches and .NET") / the repository's `.git/hooks` and `.git/config`, the vault, the runner's private files, and the worktree itself for roles with no `edit` tool that may not commit | hooks and git config run outside the sandbox the next time the user uses git |
| `sandbox.network` | `strictAllowlist: true`; `allowedDomains`: package registries and source hosts for roles with `shell` (npm, yarn, PyPI, crates.io, Go proxy, RubyGems, Maven/Gradle, github.com), nothing for others; `allowUnixSockets`: the runner's IPC socket; `allowAllUnixSockets: true` for browser roles only (see below); `allowLocalBinding` for `shell` roles | scouts and researchers reach the web through `WebFetch`/`WebSearch` (permission rules, not the sandbox); builders reach registries from the shell. Add private mirrors with `runtimes.claude-code.extraAllowedDomains` |

**Bash "denied in don't ask mode".** Roles with a shell get the bare `Bash` allow, so any command is approved except the
deny list (`git push`, `git reset --hard`, `sudo`, `rm -rf /*`, the role's own patterns). One thing the rules cannot
fix: Claude Code (2.1.296) runs its own analysis of compound commands and forces an "ask" for some of them, for example
`cd <subfolder> && <cmd>` followed by a separate statement that starts with `VAR=1` (a heredoc script, then
`VAR=1 dotnet test ... | grep ...`, was denied in card P4-7). In `dontAsk` mode an ask is a denial. Tried and still
denied: `Bash(*)`, a `PreToolUse` hook that allows, a `PermissionRequest` hook, and `sandbox` off. A denial is per
command, not per session: the next call is allowed (verified), so one denial does not block the rest of the shift. What
protects the shift is the agent: the instructions ("How to report" in the agent's `CLAUDE.md`) tell it to retry with a
simpler equivalent (one command per call, no `cd` chains or heredocs, `git -C`, the Edit/Write tools) and, if still
blocked, to end with `aom question`/`aom handoff` and the state, never silently. Should the shift end anyway, the runner
posts a card note listing the uncommitted files (next paragraph).

**Shifts that end without a report.** When a shift ends without a report (`no_report`, `crashed` or `timeout`) and
the worktree has changes, the runner posts a card note ("The shift ended without a report (...) with N uncommitted files
in the worktree", up to 30 files with their `git status` codes, and the leftovers commit it made) before it sends
`shift.ended`. The work itself was already kept by the shift-end auto-commit; the note makes it visible to the next shift
and the owner. Read-only roles (reviewer, ...) leave nothing behind and get no note.

Claude Code's sandbox wraps shell commands only; the Read/Edit/Write/WebFetch tools are governed by the permission rules
above, which is why both exist. Chat sessions get the same layer with only `Read, Glob, Grep, Bash(aom:*)` and `Edit(//<scratch>/**)` (Edit covers Write and NotebookEdit; the agent's scratch dir only, so a card's worktree and the vault stay read-only), and `Edit`
denied when a card worktree is in context. The one exception is the DevOps engineer's chat, which is unsandboxed like its
shifts (see [DevOps shifts are unsandboxed](#devops-shifts-are-unsandboxed)); every other role's chat stays as described here.

Config keys (`runtimes.claude-code`): `sandbox` (`required` default, `best_effort`, `off`), `extraAllowedDomains`
(array of hosts), `toolchainPaths` (array of directories sandboxed commands may read, e.g. `["~/.dotnet", "~/.cargo"]`;
the home directory itself and credential stores are refused), `scrubSubprocessEnv` (boolean, default `false`). With `sandbox: "required"` the runtime reports itself
unavailable (no agent is scheduled on it) when `bwrap` and `socat` are missing on Linux (`sudo apt-get install
bubblewrap socat`; on Ubuntu 24.04+ see the AppArmor note in the Claude Code sandboxing docs) or on native Windows (use
WSL2; see "Windows: run the runner inside WSL2"); `claude` must be 2.1.257 or newer.

Effective sandbox state, reported per runtime in `hello` (and again whenever a re-probe changes it), shown by
`aom-runner doctor` and in the web UI:

| State | Meaning |
|---|---|
| `enforced` | the OS sandbox (Seatbelt, or bubblewrap + socat) is in force |
| `unsandboxed` | no OS boundary, by explicit opt-in: `sandbox: "off"`, or `sandbox: "best_effort"` with `allowUnsandboxed: true` on a platform that cannot sandbox |
| `unavailable` | no sandbox and no opt-in: the runtime refuses agents. The reason says why (native Windows: install the runner in WSL2; Linux: `bwrap`/`socat` missing; `best_effort` without `allowUnsandboxed`) |

`allowUnsandboxed` (boolean, default `false`, `runtimes.claude-code`) is the acknowledgement that agents may run with no
OS sandbox; it only matters for `best_effort`. Test only: `AOM_RUNNER_MOCK_SANDBOX=unsandboxed|unavailable|enforced`
makes the mock runtime report that state.

`scrubSubprocessEnv: true` sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`: Claude Code then strips credentials from the
environment of everything its shell starts and, on Linux, isolates the PID namespace so `/proc/<pid>/environ` of other
processes is unreadable. It is off by default because Claude Code also removes variables it recognizes as credentials,
and we could not verify (without running a real session) that `AOM_SHIFT_TOKEN` survives. Turn it on for one
workstation, run a shift and check that `aom card` still works; the per-shift IPC token is the only secret it protects.

### Browser roles (testers) and Unix sockets

Playwright/Chromium needs `socket(AF_UNIX)` (Chromium's profile singleton fails with `process_singleton_posix.cc:297
socket() failed: Operation not permitted` without it). On Linux/WSL2 Claude Code's sandbox seccomp filter blocks every
Unix socket, `sandbox.network.allowUnixSockets` is ignored there, and the only switch is
`sandbox.network.allowAllUnixSockets: true` (settings reference; on WSL2 it also reopens the interop socket that
launches Windows binaries). The runner sets it only for shifts of roles that run browsers: the built-in tester (always,
including agents hired before the flag existed) and any role whose permissions say `"browser": true` (default `false`;
a checkbox "runs browsers" in the role editor; granting it to an agent beyond its role definition needs the
organization owner). It also keeps `aom` working, since a browser role may now connect to the runner's IPC socket directly.

What that opens, and how it is compensated: a shell that can create Unix sockets can connect to any socket it can reach
by path. A path in the sandbox's `filesystem.denyRead` is masked and cannot be connected to, so browser shifts
additionally hide `/var/run/docker.sock`, `/run/docker.sock`, `/run/containerd`, `/run/podman`, `/run/WSL` (WSL interop),
`/run/dbus`, `/run/systemd`, `/run/user/<uid>` (session bus, keyrings, ssh/gpg agents) and any `/tmp/ssh-*`, `keyring-*`,
`gpg-*`, `dbus-*` entries present when the shift starts, on top of the credential stores listed above (`~/.ssh`, ...).
`WSL_INTEROP`, `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` and `DOCKER_HOST` never reach any agent
(the agent environment is an allow-list; there is a test). Residual risk: a socket in a location not listed (a custom
agent socket under `/var/tmp` or a project directory, a service listening on an abstract socket such as the X server
or `@/tmp/.X11-unix`) is reachable from tester shifts. Run the runner as the dedicated unprivileged user recommended
below, and keep the host's own agents out of paths the runner user can read.

Playwright's `test-results/`, `playwright-report/` and `blob-report/` (at the worktree root or in a package folder) are
treated as artifacts: they are no guard finding, are removed (untracked ones) before the shift-end autocommit, and are
never committed. Ignore them in `.gitignore` too.

### Vault access

The server decides which one vault a conversation may read (`vaultForProject`, `vaultForConversation` in
`apps/server/src/commands/vaults.ts`); the runner opens only that vault's clone. A vault is never opened without a `.git`
clone under `vaults/`; with none, the instructions say the vault is not cloned here and nothing crashes.

| Work | Server sends | Runner opens | How |
|---|---|---|---|
| Card shift | `shift.start.vault` (project vault, else org vault on an Owner/Admin workstation) | the vault clone | `--add-dir`, Edit denied, sandbox `denyWrite`; PROJECT.md, standing orders (and taste) added to the brief |
| Question shift, BA task shift | `shift.start.vault`, same rule, for the shift's project | the vault clone | read-only folder (as reference repositories: secret files denied); PROJECT.md and standing orders in the brief |
| Chat about a project or card | `chat.start` `context.vault` `{ vaultId, kind, folder }`, same rule | the vault clone | read-only folder (`readDirs`: `--add-dir`, Edit denied, sandbox `denyWrite`, secret-file deny list); PROJECT.md and standing orders (clipped to 3,000 characters each) in the chat instructions |
| Chat with no project | `context.vault` `{ vaultId, kind: 'org' }` (no `folder`), only on an Owner/Admin workstation | the vault clone | as above; only the root standing orders |
| DevOps | none | reads anywhere anyway | n/a |

The vault is listed in "Folders you can read" as read-only; writes go through `aom` commands (`aom publish`,
`aom investigation record`, ...), never directly. A vault of another organization is never sent.

### The CEO shift (`kind: 'ceo'`) and `aom ceo`

The organization's CEO agent (docs/design/ceo-agent-v2.md) runs on one of the owner's workstations in two ways: **wake shifts**
and the **owner's chat**. A wake shift is `shift.start` with `kind: 'ceo'` and the additive field `ceo`
(`{ purpose: 'wake' | 'review', batchId, wakeIds, reasons, brief }`; the `brief` text carries the snapshot, the owner's rules
and the policy in words, with every title written by an agent or a ticket inside an untrusted block). It has **no card, no
worktree and no `--resume`**: the working directory is the agent's scratch directory, the brief carries a placeholder card
(`CEO`), and a review shift has 30 minutes, a wake 15. The runner announces the capability `ceo:1` in `hello`; the server
sends a CEO shift only to a runner that has it (an older runner is shown "update the runner" on the CEO page).

The CEO shift has a slot of its own (backlog #79): it does not count against `maxConcurrentShifts` (nor do card shifts count it),
and only one CEO shift runs at a time (a second is refused `busy`: "a CEO shift is already running"). Before #79 a workstation
running its limit of card shifts refused the CEO's shift every time. Every `shift.rejected` now carries a `detail` and is
logged as `shift <id> rejected (<reason>): <detail>`; the server keeps the text on the batch (`ceo_batches.error`) and shows it
on the CEO Overview. The `brief` stays small: counts per reason and the 25 most important wakes when many have piled up, and the
snapshot is read with `aom ceo snapshot`, not inlined.

**Sandbox profile** (`buildCeoSettings`, the same for the wake shift and the chat): allow `Read`, `Glob`, `Grep`, `Bash(aom:*)`
and `Edit` in the agent's scratch directory only; deny `WebFetch`, `WebSearch`, every MCP server, `NotebookEdit` and the
usual git denies; `sandbox.network.allowedDomains` is empty; the organization vault is a read-only folder (`--add-dir`
equivalent: `additionalDirectories`, `Edit` denied, sandbox `denyWrite`, secret files denied); the runner's data directory and
other agents' directories stay unreadable. Even a role definition that grants more tools gets this profile (tested in
`apps/runner/test/ceo-settings.test.ts`).

**`aom ceo ...`** is one IPC rpc method, `ceo`, with an `op` (`snapshot`, `show`, `search`, `costs`, `act`, `recommend`,
`notify`, `task`, `memory`, `review_reply`); the runner forwards it unchanged as `rpc.request` under the shift or chat id, and refuses it
unless the shift is a `ceo` shift (or a chat) of an agent whose role is `ceo`. The server checks the agent again, applies the
policy, the limits and the audit, and answers `{ status: 'executed' | 'recommended' | 'refused' | 'dry_run' | 'duplicate', ... }`.
A refusal is exit code 1; a recommendation is not an error. A wake shift ends with exactly one terminal report: `aom ceo done
--summary "..."` (outcome `ceo_done`) or, for the daily review, `aom ceo report --summary-file <md>` (outcome `ceo_report`).
The mock runtime has a scripted CEO (`mock-agent` in `ceo` mode, and a mock CEO chat) for the simulated workstation and the
tests; it drives the same verbs.

**`aom ceo route "<request>"` and `aom ceo route --drafts`** (read-only, organization scope, CEO shifts and the owner's CEO
chat). The server only passes the request on; the runner answers from the organization graph (`org/graph/` in the
organization vault on this workstation, see "Project graphs"). `route` lists candidate projects and areas for the request,
each with its reason, in at most 800 bytes. `route --drafts` lists the links the code suggests that the owner has not
confirmed yet, in at most 1.8 KB. Retired projects never appear. The CEO judges; the graph only ranks.

### Reference repositories and other read-only folders

`repoRoots` (see Configuration) only says where repositories are found and cloned. It grants no read access, and there
is no config key that does: what an agent may read beyond its own work folder comes from the server, per project.

- **Reference repositories** are set by the project owner in the project settings (event `ProjectReferenceReposSet`, by
  repository id; the picker offers repositories of the organization's other active projects: all of them to organization Owners and
  Admins, else those the owner belongs to).
  `shift.start` (card shifts) and the `chat.start` context carry them as `readRepos` (`{ repoId, name,
  remoteUrlNormalized, kind: 'project' | 'reference' }`), never as paths. The runner resolves each to the clone **its own
  repository scan found** (`repoRoots`); a repository that is not cloned on this workstation is skipped. A resolved folder
  that is the runner data dir (or contains or lies inside it), the home directory (or a parent), `/` or a credential
  store (`~/.ssh`, ...) is refused. Nothing else under `repoRoots` is opened: not the other projects' clones, not
  this platform's own checkout unless the owner picked it.
- **Clones picked on a workstation.** Any repository under `repoRoots` can be picked, not only project repositories. The
  runner reports every clone it finds (with or without an `origin` remote) as `repoCatalog` in `hello` and `repos.report`:
  `{ name, localKey, remoteUrlNormalized | null }` (optional field, absent from older runners). `localKey` is the path
  **relative to the repoRoot** (never an absolute path), the stable identifier of a clone without a remote. The runner's
  data dir, the home directory (or a parent), `/` and credential stores are left out of the catalog. The server keeps it
  per workstation (`workstation_repo_catalog`, replaced on each report) for the picker. A pick is stored in
  `ProjectReferenceReposSet.workstationRepos` (`{ workstationId, localKey, name, remoteUrlNormalized | null }`, optional,
  backward compatible: an event without it leaves the list as it was) and goes to runners as `localReadRepos`
  (`{ name, localKey?, remoteUrlNormalized? }`) on `shift.start` and in the `chat.start` context, a separate field so older
  runners ignore it. Resolution: on the workstation it was picked on the runner opens the clone with that `localKey` (the
  only way for a clone without a remote); a clone **with** a remote is also opened on any other workstation where its own
  scan finds a clone of the same remote (the same repository, so it is not a wider grant); a clone without a remote is
  never sent to another workstation. The same refusals apply as for project repositories (data dir, home, credential
  stores). A pick is validated on the server: the workstation must be one of the picker's own active workstations that
  serves the organization and the clone must be in its reported catalog (a pick made earlier by another owner stays while
  its workstation is active and its user is still in the organization).
- **Who can pick what.** Organization Owners and Admins see every active project's repositories of the organization;
  other users the projects they are an active member of. The picker and the validation of `PUT
  /api/projects/:id/reference-repos` share one query (`eligibleProjectRepos`). Only the project owner changes the list.
- **Card shifts** get the reference repositories. **Chats** get the reference repositories plus, when there is no card
  worktree on this workstation (a chat about a project, or about a card not started here), the project's own clones
  (`kind: 'project'`). A chat about a card whose worktree is here keeps its read-only worktree as working directory. The
  DevOps engineer is unsandboxed and reads anywhere, so it gets none of this.
- **How it is enforced** (`ClaudePolicyContext.readDirs`, `claude-policy.ts`): the folders are passed with `--add-dir` and
  listed in `permissions.additionalDirectories` (the Read, Grep and Glob tools); `Edit(//<dir>/**)` (which covers Write
  and NotebookEdit) is denied, and the folder is in the sandbox's `denyWrite`, so a shell cannot write there either; the
  sandbox `allowRead` re-opens it for the shell. **Secret files stay unreadable inside the folder**: `.env`, `.env.*`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.npmrc`,
  `.netrc`, `.pypirc` and `.git-credentials` (`SECRET_FILE_GLOBS` in `read-only-dirs.ts`) get `Read(//<dir>/**/<name>)`
  deny rules for the built-in tools. Because an `allowRead` path wins over `denyRead`, the shell cannot be fenced by adding
  the secret to `denyRead`; instead the folder is opened to the shell entry by entry, leaving the secret files out
  (`node_modules`, `.git`, `dist`, `build` and similar folders are opened whole, not scanned). A folder with more than
  40,000 entries is not opened to the shell at all (the built-in tools still read it, minus the deny rules). The secret
  list is read when the shift starts: a secret file created later is covered by the tool rules only.
- **Git metadata.** A card shift or chat may now read the repository's `.git` (the worktree's `gitdir` under
  `.git/worktrees/<card>` and the main repository's common dir): read-only for chats; for shifts it is the same folder that
  is already writable in the sandbox so the worktree can commit (`hooks` and `config` stay write-denied). This ends the
  harmless Read/Grep refusals on `<repo>/.git/worktrees/<card>/HEAD`.
- **Per-role extras.** `ClaudePolicyContext.readDirs` is a plain list, so a role that needs more (a future Architect that
  reads every repository under the organization's source folder) only passes a longer list to `buildShiftSettings` and
  `buildChatSettings`; the write denial and secret rules apply to every entry.
- **What the agent is told.** The instructions of a card shift and of a chat end with "Folders you can read" (working
  directory, each read-only folder, and that the owner manages reference repositories in the project settings and that no
  configuration key exists for it).

### Jira on the runner

Agent sandboxes have no network (a shell reaches package registries and `extraAllowedDomains` only; chats reach
nothing), and agents hold no Jira credentials. The Atlassian plugin's MCP server (see "Plugin MCP servers") holds its own
sign-in and returns attachment names and sizes, not the files. So the **runner** reads Jira's REST API itself, on the
workstation, with the owner's own API token, and hands the agent local files.

**Connect (once per workstation, by the owner):**

```
aom-runner jira-connect                     # asks for the base URL, your e-mail and the API token (hidden)
aom-runner jira-connect --status            # connected as ..., or why not (exit code 1 when not connected)
aom-runner jira-connect --disconnect        # removes the saved credentials
aom-runner jira-connect --base-url https://yourcompany.atlassian.net --email you@company.com   # token on stdin
```

Jira Cloud: create an API token at https://id.atlassian.com/manage-profile/security/api-tokens and use your Atlassian
e-mail. Jira Data Center: leave the e-mail empty and use a personal access token. The command checks the credentials
with `GET /rest/api/2/myself` and saves nothing when Jira refuses them. Use the classic "Create API token", not "with scopes" (a scoped token must be called through `api.atlassian.com`, which is not done yet). The Integrations page connects Jira the same way. The token is stored in
`<data dir>/secrets/jira.json` (mode 0600, directory 0700), like the git tokens, never in `config.json`; a `jira` block in
`config.json` (the older form) is still read when there is no secrets file, and the secrets file wins. With several
pairings the credentials go to all of them unless `--pairing` names one. A running runner picks the change up within
the minute (no restart); the same file posts the approved updates to Jira.

The Workstations page shows a **Jira** line for the workstation: *Connected as ...*, *Not connected* (with the command
to run) or *Refused* (Jira rejected the saved token: connect again). The runner sends `jira.report` with the state, the
site address and the account's display name; never the token. (The Atlassian plugin's OAuth sign-in lives inside the
MCP client and is not available to the runner's REST calls, so the API token is the supported way.)

**What an agent can do** (BA intake chats, and any chat about a card whose `externalRef` is a Jira key):

```
aom source read --ref DCPL-4276                     # summary, status, type, priority, people, links, description, comments
aom source attachments DCPL-4276                    # name, id, type, size, author, date of every attachment
aom source attachment DCPL-4276 SlideOutHistory.svg # one file, by name or id
aom source attachment DCPL-4276 --all               # every file
```

`aom source read` is `GET /rest/api/2/issue/<KEY>` with the saved connection; the text comes back wrapped as untrusted
content (the ticket is data, not instructions). Without a connection it answers "Jira is not connected on this
workstation: ask the manager to run `aom-runner jira-connect`". The runner downloads with its own credentials and writes to `<agent scratch>/attachments/<KEY>/<file>`, then prints the
local paths. The scratch directory is a working directory of the agent, so the Read tool opens them (Claude Code shows
images, SVG and text read as text). Rules:

- **Scope.** Only the ticket the conversation is about: the intake's own Jira key, or the card in context's `externalRef`.
  Any other key is refused before Jira is asked. A GitHub intake has none.
- **Limits.** At most 20 MB per file and 60 MB per call; a file over the limit (by its declared size or while streaming)
  is skipped and listed under "Skipped". Download time limit 120 s per file.
- **Where the token goes.** The download URL is built from the saved base URL and the attachment id, never taken from
  Jira's answer, so the token can only go to the host it was saved for. It is not in any file, answer, environment
  variable or instruction an agent can see; `secrets/` is denied to every agent like the rest of the data directory.
- A runner without credentials answers with the command to run; the BA tells the manager and continues without the files.

### Attachments (card files for builders and testers)

A card can carry files (screenshots, designs, documents). They are stored in the server's database (not the event log),
shown on the card, and copied by the runner for the agents.

- **Shift start.** The brief carries each attachment's name, type, size and sha256. Before the agent starts, the runner
  downloads them from the server (`GET /api/runner/attachments/<id>?shift=<shift id>` with the runner token; the server
  allows only the attachments of that shift's card) into `<agent tmp>/card-attachments/` (the agent's private temp
  directory, outside the worktree, never committed), checks every sha256, makes the files read-only and lists them in the
  shift's instructions. The Claude adapter adds the folder to the agent's readable folders. A file that cannot be fetched
  is logged and the shift starts without it. Removed attachments disappear at the next copy.
- **`aom card attachments [REF]`** copies them again on demand (builders, reviewers, testers, the DevOps engineer for the
  card of its request, and chats about the card). In an intake chat it copies the files of every card of the intake.
- **`aom card attach <path> [--card REF]`** (the BA in its intake chat): attaches a file to a card **of that intake** (the
  card may be a draft or specified; without `--card` the intake must have exactly one card). The runner reads the file,
  which must lie in the agent's scratch or temp directory (a path outside is refused), runs the same type and size checks
  as the server, asks the server for a one-time upload ticket (`card.attach.begin`; the server decides whether the agent may
  attach to that card), then sends the bytes with `PUT /api/runner/uploads/<id>` and the runner token. A file downloaded
  from Jira is recorded as coming from `jira <KEY>`. Every other role is refused.
- **Limits and types.** 20 MB per file, 100 MB and 50 files per card. Images (png, jpg, gif, webp, bmp, ico), svg, pdf,
  zip and Office files (docx, xlsx, pptx) and text (txt, md, csv, tsv, json, xml, yaml, log, diff, patch, har, html) are
  accepted; programs and scripts (exe, dll, bat, sh, ps1, js, jar, ... and any file starting with an executable or `#!`
  header) and every other type are refused, as is content that does not match its extension. SVG and HTML are served
  with a sandboxing Content-Security-Policy and `nosniff`; HTML is delivered as a plain-text download.

### Plugin MCP servers

External tools (Jira, Confluence, ...) reach sandboxed agents only through MCP servers that come from **Claude Code
plugins** installed and enabled on the workstation. Every agent runs with its own `CLAUDE_CONFIG_DIR` and `HOME` and
`--strict-mcp-config --mcp-config <configDir>/mcp.json`, so nothing of the owner's own Claude Code setup is visible to
it: the `mcp.json` is `{ "mcpServers": {} }` unless the three conditions below hold. (Hand-added servers and claude.ai
connectors are not covered yet; `discoverPluginMcpServers` is the one source to extend.)

**Three keys, all required.** (1) The server is installed and enabled on this workstation. (2) The organization's
**Owner** granted it to the project (project settings, MCP servers; server-enforced: Admins and project owners are
refused). (3) The hired agent has the permission `mcp:<name>`: from a custom role (role builder, "What it may do") or, for any agent including built-in roles, switched on by the org Owner on the agent's card (Agents page, "External tools (MCP)"; `PATCH /api/agents/:id`, Owner only for additions). The runner gates on the hired agent's effective `allowedTools`. `mcp:*` does not exist
(the role validator only accepts `mcp:` plus a name of letters, digits, `_`, `.` and `-`), so a role names each server.
The DevOps engineer, question shifts and BA tasks never get plugin servers; the DevOps chat and shifts behave as before.

**Discovery** (`src/mcp/plugins.ts`, the way Claude Code does it; files are read, nothing is executed):

- the Claude Code home is `$CLAUDE_CONFIG_DIR` of the runner's own environment, else `~/.claude`;
- a plugin counts when it is in `plugins/installed_plugins.json` with a **user-scope** install (project- and local-scope
  installs belong to one repository, not to the workstation) and `enabledPlugins["<plugin>@<marketplace>"]` in
  `settings.json` is `true` (absent or `false`: skipped, so a disabled plugin offers nothing);
- servers are read from `<installPath>/.claude-plugin/plugin.json` (or `plugin.json`) `mcpServers` (an inline object, a
  path inside the plugin, or a list of those) and the `.mcp.json` at the plugin root (`{ "mcpServers": {...} }` or the
  bare map; a server in `plugin.json` wins over the same name in `.mcp.json`). A path that leaves the plugin is ignored.
  The agent-plugins `mcp.json` (no dot) is not read: Claude Code does not read it either;
- `${CLAUDE_PLUGIN_ROOT}` (and `$CLAUDE_PLUGIN_ROOT`) is expanded to the install path. Other `${VAR}` references are
  **left as they are**: the agent's environment is an allow-list, so a server that needs a variable of the owner's shell
  does not start. Resolving them would copy that variable into a file the agent can read, so it is deliberately not done;
- the type is `http` (also `streamable-http`), `sse`, or `stdio` (a `command`).

**The name.** Claude Code calls a plugin server `plugin:<plugin>:<server>` and its tools `mcp__plugin_<plugin>_<server>__<tool>`.
Guildwise uses the tool-prefix form, `plugin_atlassian_atlassian`, as the server's name everywhere: the project grant, the
role permission `mcp:plugin_atlassian_atlassian` (which becomes the allow rule `mcp__plugin_atlassian_atlassian`) and the
tool log. In the agent's `mcp.json` the entry is keyed `plugin:atlassian:atlassian`, so the tool names match, and Claude
Code finds the OAuth token it stored for that name.

**What the runner reports** (`mcp.servers`, after `welcome` and after a re-scan that changed it; off with the mock runtime
and under tests, `Runner` option `mcpReport`): per server `name`, `plugin`, `server`, `transport` and, for a remote server,
the **host name** only. Never the command, arguments, environment, headers, URL path or query, or any token. `tools` (tool
names) is in the schema for the settings screen's write warnings, but the runner does not start servers to ask for them, so
today it is empty and the screen shows the general warning per server. The server keeps the last report per workstation
(`workstations.mcp_servers`, kept over a projection rebuild) and drops invalid entries.

**The grant.** Event `ProjectMcpServersSet { projectId, servers: string[], by }` (whole list, names only; projection
`projects.mcp_servers`). Each name must be reported by one of the Owner's own active workstations that serve the
organization, or already be granted. `PUT /api/projects/:id/mcp-servers { servers }` (org Owner only, 403 otherwise);
`GET /api/mcp-servers` lists the caller's candidates for the role builder. `shift.start` (card shifts only) and the
`chat.start` context carry `mcpServers` (names). On another member's workstation that lacks the plugin the name is simply
not found and nothing is written.

**At the start of a card shift or chat** (`ClaudeCodeAdapter.writeMcpConfig`): the server entries that are granted, found
locally and allowed by the role's `mcp:<name>` permissions are written, with their **full local configuration**
(command, args, env, headers, as the plugin declares them), into `<configDir>/mcp.json` with mode 0600. That configuration
never travelled through the server. A chat also gets `mcp__<name>` allow rules in its settings (chats ignore the role's
other tool permissions); a card shift gets them from the role's `mcp:` entries as before. The BA intake chat keeps its
`runtimes.claude-code.intake.mcpConfig` file and the granted servers are added to it.

**How the servers authenticate inside the agent's `CLAUDE_CONFIG_DIR`.** Claude Code keeps the OAuth tokens of remote
servers in `~/.claude/.credentials.json` under `mcpOAuth`, keyed `<server key>|<hash of the connection>` (for example
`plugin:atlassian:atlassian|60c89fc9e49f37c7`), next to the model login (`claudeAiOauth`). Stdio servers get their
`env` from their config entry.

- With the default login (`authMode: default`) the agent's config dir holds a copy of the file, so the entry is found as long
  as the server key and connection are unchanged. The whole file is copied, not narrowed: it holds the model login whose
  refresh token Claude Code rotates, and a narrowed copy would lose the rotated token. Refreshed MCP tokens are written back
  to the owner's file after the session. (This is the same exposure agents already had; the file stays unreadable to the
  agent's shell by the `~/.claude` read deny.)
- With a configured token (`authMode: oauth` or `api_key`) nothing was linked before and nothing broader is linked now:
  when servers are in use the runner writes a private copy (mode 0600) containing **only** the `mcpOAuth` entries whose key
  is, or starts with `<server key>|`, for the servers in use. No model login, no other server's token. Without servers there
  is no credentials file (a stale one is removed). Limitation: a refreshed token is not written back to `~/.claude`; if the
  server rotates refresh tokens the owner may have to sign in to that plugin again (`/mcp` in Claude Code).
- If the stored token does not match (Claude changed how the key is derived, or the owner has not signed in to the plugin),
  the server starts unauthenticated and its tools fail; the agent reports that in its shift. Sign in to the plugin once
  in Claude Code on the workstation.

**The sandbox.** The checks are unchanged: `~/.claude` and `~/.claude.json` stay in `HOME_SECRETS` (Read denied for the
built-in tools and `denyRead` for the shell), the agent's `HOME` is its own directory, and the config dir is write-denied.
Claude Code starts **stdio MCP servers itself, outside the Bash tool's OS sandbox** (the sandbox wraps the shell tool
only; this is why the "Security" section says MCP servers run with the runner user's rights). So a stdio server can read
and write what the runner user can, whatever the role's permissions, and sees the agent's `HOME`, not the owner's. That is
why granting is the Owner's alone and why the screen asks for read-only use. Remote servers are reached by Claude Code
itself with the stored token. (Test on the real workstation: a granted stdio server starts, a remote one authenticates, and
`Read(~/.claude/**)` is still refused.)

**The card's log.** The tool calls an agent makes already appear in the shift's progress as `mcp__<server>__<tool>: <input>`.
The server tallies them per shift (`shifts.mcp_calls`, `[{ server, tool, count }]`, kept over a rebuild) and the card shows
**External tools used** per shift (`mcpUsage` in the card detail).

**Sign-in state** (`authState` of each reported server: `signed_in`, `needs_sign_in`, `not_needed`). The runner decides it
from the **keys** of `mcpOAuth` in `~/.claude/.credentials.json` only (`plugin:<plugin>:<server>` or `<key>|<hash>`); no
token value is read into a report, a log or the server. An entry whose access token expired counts as signed in while it
holds a refresh token (Claude Code refreshes it on use). stdio servers, and remote servers that carry their own `headers`
or `headersHelper` (an API key), are `not_needed`; any other remote server without a stored sign-in is `needs_sign_in`.
It is re-scanned every minute and reported when it changed. The Workstations page and the project's MCP servers panel
then say: *Needs sign-in: On <workstation>, run `claude`, then `/mcp`, choose <server>, Authenticate.* When such a server
is granted to a project the owner also gets a desk notice (cleared by the system once it is signed in), and an agent
whose shift or chat starts with a granted server that needs sign-in is told so in its instructions, with the sentence to
give the manager, so it does not retry the tools. Older runners report no state and raise nothing. The sign-in can be done from the Integrations page (`claude mcp login <key> --no-browser` with a paste-back of the redirect address; see "Integrations (connect from the web)"), and the desk notice has a "Sign in from the web" action.

### The architect: organization source folder, git and the main merge

The architect (built-in role `architect`, claims every `investigate*` stage) is the only role with `permissions.readOrgRepos`
(docs/design/architect-and-workflows.md).

- **Reading the organization.** `shift.start` and the `chat.start` context carry `readRepos` entries of `kind: 'org'`:
  every repository of an active project of the organization (interest projects and removed repositories excluded) of
  which the workstation's owner is an active member, named by remote like the reference repositories and resolved to the
  clones the runner found itself (the same refusals apply). On top of that, `shift.start.orgId` (and `chat.start`
  `context.orgId`) lets the runner open **every git repository under the organization source folder** of
  `config.orgSourceFolders[orgId]` (`resolveOrgFolderRepos` in `read-repos.ts`: the scan of `repoRoots`, depth 3, each
  repository confined to the folder after symlinks are resolved). Both go to the agent as read-only folders: `--add-dir`,
  `Edit(...)` denied, `denyWrite`, and the secret file list above (`SECRET_FILE_GLOBS`) unreadable. A folder that stops
  passing `checkOrgSourceFolder` (moved out of `repoRoots`, now the home directory ...) opens nothing. Other roles never
  get the folder.
- **Setting it from the app.** The owner of the workstation (and only a member of the organization) presses *Set folder* /
  *Clear* on the Workstations page: `PUT /api/workstations/:id/org-folder {orgId, path|null}` queues the runner command
  `org.folder` `{orgId, path|null}`. The runner validates exactly like the CLI (`changeOrgFolder`: strictly inside a
  `repoRoots` entry, never the home directory, the data directory or a credentials folder, real paths compared), rewrites
  `config.json` atomically with mode 0600 only on success, and answers `{ok, error?}` (a refusal is an answer, not a
  command failure). It then sends `org.folders` `{folders: [{orgId, folder, valid, reason, repoCount}], candidates}`; the
  same message follows `welcome` and every re-scan (10 minutes), so a folder that stops being valid shows up. `candidates`
  are absolute sub folders (depth 1 and 2) of the repo roots that are not repositories themselves and pass the same check,
  at most 200. The server stores the latest report and the reason of the last refusal per workstation (migration 1680) and
  shows them to the workstation's owner only, never in the admin list. The server queues; it never bypasses the runner's
  validation. An older runner answers the unknown command with an error and the page keeps showing "not reported yet".
- **Writing.** `writableGlobs: ['docs/**', '**/*.md']` plus the project's investigation folder and the card's report path
  (`brief.investigation.folder` / `reportPath`, repository location). The post-shift guard reports
  `architect_edited_non_docs`, with one exception: what a merge commit whose second parent is an `origin/<main>` SHA the
  runner recorded in this shift changed (the "merge latest main first" step, `aom git merge-main`; kept across a runner
  restart in the persisted shift record). Edits made to those files after the merge, committed or not, are not exempt.
  A main merge left unresolved is reported as `merge_unresolved`; it is never committed half done (auto-commit and the
  out-of-scope discard skip a worktree with `MERGE_HEAD`), and the next architect shift inherits it.
- **Commit, push, merge, fetch.** The agent keeps `git push*`, `git fetch*`, `git pull*`, `git remote*`, `git rebase*`,
  `git checkout*`, `git switch*` and `git reset --hard*` denied; it may `git add`, `git commit` and `git merge`.
  `aom git push` (rpc `git.push`) is **always refused** (backlog #61: no card or agent branch is pushed unless the goal is a pull request, and then the runner pushes it at finalize); `aom git fetch` (`git.fetch`) fetches origin; `aom git merge-main`
  (`git.merge_main`) merges the latest `origin/<main>` into the card branch and leaves a conflict in the worktree;
  `aom git verify-merge` (`git.verify_merge`) checks that a resolution is complete (no merge in progress, no unmerged
  file, no conflict marker, HEAD is the merge commit). The rpcs work only in `investigate*` stages of card shifts.
- **Merge latest main first** (`git/sync-main.ts`, `prepare.syncMain`). Before the card worktree is created, under the
  per-clone lock (shared with the merge completion): fetch `origin/<main>` and `origin/<working>`; when main is not
  already in the working branch, merge it (`--no-ff`) in a throwaway integration worktree and push the working branch
  (one retry when it moved). On a conflict, a protected branch (`isProtectedBranchRejection`) or another failed push the
  card branch is cut normally and takes the merge inside its worktree: clean, or a conflict left for the architect, or
  aborted (`skipped_conflict`) when the shift is not the architect's. The result is reported in `shift.started.syncMain`.
  Never on reuse, never for a resumed shift; an absent `mainBranch` is resolved from `origin/HEAD`.
- **Reports.** `aom design` / `aom investigate` send the outcome with `InvestigationData`. The runner commits leftovers,
  then checks the report: in the repository it must be a file inside the worktree (no symlink out), committed, and free of
  obvious secrets (`scanReportForSecrets`); the commit is attached. For the vault location the file is read from the
  agent's scratch or temp directory (or the worktree), scanned, and written into the project's vault folder with a vault
  commit; nothing is committed in the repository.

### Card branch already exists (worktree creation)

`ensureWorktree` never creates a card branch that exists: it asks `show-ref` for the local ref, prunes stale worktree
registrations, and uses `worktree add <path> <branch>`. If the branch appears between that check and `worktree add -b`
(the fetches in between take seconds, and a second runner or the owner's git can share the clone) the add falls back to
the branch that is there, so a shift is no longer rejected with `fatal: a branch named '...' already exists` (#72).

### Read-only roles and path scopes

A role without the `edit` tool that may not commit (reviewer, business analyst, custom read-only roles) gets a
read-only worktree in the sandbox: its worktree path is in `sandbox.filesystem.denyWrite`, while its scratch, temp and
home directories stay writable. A reviewer that needs a build or tests that write caches copies the worktree into its
scratch dir (`rsync -a ./ "$TMPDIR/review/"`) and runs it there; the reviewer instructions say so (role version 2).
The shared package caches stay writable, so a read-only shift can still restore, build and test in its copy.

The Edit/Write permission rules of such a role are **path-scoped** (runner 0.1.24): `Edit`, `Write` and `NotebookEdit` are
denied for the worktree only, and the role's scratch folder is allowed (`Edit(<scratch>/**)`, `Write(<scratch>/**)`). The
earlier bare `Edit`/`Write` deny also beat the scratch allow, so a reviewer could not write the file its
`aom review approve --risk-file` or a tester's `aom outcome steps --note-file` reads. (A role whose working folder is its
own scratch folder has no worktree deny.) The role smoke test checks this rule for every role on every runner start.

A read-only worktree used to make **every** shell command of such a role fail with
`bwrap: Can't create file <worktree>/.gitconfig: Read-only file system` (backlog #72). Real cause, reproduced with the
real Claude Code binary and bubblewrap (`apps/runner/test/claude-sandbox-real.test.ts`, which runs `claude -p` against a
fake local API with the settings the runner generates): Claude Code 2.1.296 and later mounts `/dev/null` over its
protected dotfile names in the working directory (`.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`,
`.zprofile`, `.profile`, `.ripgreprc`, `.vscode`, `.idea`), creating each missing one as a mount point first. With a
read-only working directory that creation fails, and every Bash command dies. The earlier 0.1.10 attempt (masking the data
dir entry by entry, `denyAround`) did not touch this and is kept only as a tighter mask. Fix
(`src/adapters/sandbox-placeholders.ts`): before a read-only shift the runner creates the missing names in the worktree
(empty), the sandbox then binds `/dev/null` over files that exist, and the runner removes exactly what it made when the
shift ends. If a future Claude Code protects more names, the real-sandbox test (skipped without `claude` and `bwrap`) is
the signal. The risk analysis of a review goes in a file in the scratch directory (`$TMPDIR/risk.md`) or inline with
`--risk-analysis "<text>"`; an unreadable `--risk-file` now says so.
Since 0.1.24 the stubs are removed at the end of a shift only when no other shift of this runner works in the same worktree
(another shift may be using them as mount points); they stay empty files, which every check above already ignores.
Hotfix #77: those stubs exist while the shift runs, so a report (`aom finalize`, `aom review`) used to be refused by the guard
(`readonly_role_modified_code` for `.bash_profile`, `.gitmodules`, `.profile`, ...). The guard, the leftovers autocommit, the
unreported-work note, the read-only rollback check, the worktree sweep and the finalize dirty check now ignore exactly the
sandbox stubs: untracked, empty files at the worktree root with one of the protected names (list exported from
`sandbox-placeholders.ts`; the empty directories are invisible to git). A non-empty file (a real `.gitmodules`) or a tracked
one that was modified still counts. The runner also removes such empty untracked stubs (its own and Claude Code's) when the
shift ends, before the guard, discard and autocommit run, and `autoCommit` excludes them from `git add` for every role.

Hotfix #78 (merges failed at Finalize with "could not create the integration worktree ... could not lock config file
.git/config: File exists"): Claude Code's sandbox protects `<gitDir>/config` together with `config.lock`,
`config.worktree`, `config.worktree.lock` and `commondir` (strings of the claude 2.1.300 binary). bubblewrap creates a missing
protected name on the host as an empty read-only file, and the stub outlives the sandbox. With agents running on a
clone (dcode-flow-5: 6 shifts, `.git/config.lock` 0 bytes, `r--r--r--`, created while they ran) every git command that
writes `.git/config` failed, among them the tracking set-up of `git worktree add -B <branch> <path> origin/<x>` of the
integration worktree. The sandbox deny on `config` and `hooks` stays (an agent must never write them). Fixes
(`src/git/config-lock.ts`):
- The runner no longer writes `.git/config` for its routine work: integration, card and sync worktrees use `--no-track`,
  and `git push -u` became a plain `git push origin <local>:<remote>` (completion, release-pr, branch creation, hygiene).
  `repo.create` keeps `push -u` (a new clone, no agent yet).
- `git()` recovers: a command that failed on `config.lock` / `config.worktree.lock` looks for a lock in the clone's common
  git dir that is certainly a sandbox stub (regular file, 0 bytes, no write permission), removes it and runs the command
  again. A real lock (non-empty, or writable, which every git creates) is never deleted.
- Each sandboxed shift holds its clone (`holdSandboxRepo`, ref-counted: many shifts share one `.git`); the stubs are removed
  when the last shift on the clone ends, so no `config.lock` stays on the host while no agent runs there.

Residual window: while an agent shift runs on a clone, the stub is there, so the owner's own `git config` / `git branch -u`
in that clone can fail with "could not lock config file"; the runner removes it before its own writes and at the end of
the last shift. After a runner crash a stub can survive: the owner can delete the 0-byte `.git/config.lock`, or the
runner's next config write removes it.

A role that may not commit (reviewer, scout, ...) is also rolled back after every shift, which stays as the safety net
and is still recorded as a guard violation: `git checkout -f <branch>`,
`git reset --hard <start sha>`, `git clean -fd` inside its worktree. Roles with `writableGlobs` (tester: the project's
E2E globs; writer: documentation; any custom role) may only change matching paths: the post-shift guard reports
`edited_outside_writable_globs` (or the tester/writer rules), and out-of-scope edits are discarded before the shift-end
autocommit.

### Repository hygiene (DevOps)

Once a day per workstation (the cadence is set on the Workstations page, `AOM_HYGIENE_SCHEDULE` on the server turns the
schedule off) and on "Run hygiene now", the server sends the DevOps engineer a request listing the workstation's project
repositories: local path, remote and working branch (the active phase's, else the repository's). The engineer runs
`aom hygiene run`; the runner's own git code, running as your user with your git credentials, then for each repository:

- fetches `origin`, lists the branches (agent branches `aom/...` left out);
- **working branch not confirmed** (`project_repos.working_branch` is empty): does nothing else. It does not commit,
  pull or push. The uncommitted files and the branches are reported, and the server asks you on the desk which branch is
  the working branch (the answer is stored on the repository and in the ledger, so it is not asked again);
- **uncommitted edits in your own checkout** (on the working branch or any other branch): stored as a **stash
  entry** (`saved work <ISO date>: N file(s) not committed`, visible in `git stash list`; the same content is never
  saved twice in a row). It is never pushed and no branch is made: the repository gets no trace of the product. The
  entry is built from throwaway indexes (`git commit-tree`, then `git stash store`): a commit W with parents HEAD and
  the index commit I, plus a third parent for untracked files, so `git stash show/apply` work. Your files, your index
  and your branch are untouched and nothing reaches the working branch. Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, names containing
  key, secret, token, password or credential, unless they are source or notes) are skipped and named in a desk notice
  (`saved_work`) that tells you where your work is;
- **a repository with a running card shift** (a worktree of the clone belongs to a running shift) is skipped and
  reported as "deferred": hygiene moves refs in the `.git` the shift shares, so it waits for the next run. The
  post-shift guard additionally ignores housekeeping refs (`conflict/*`, `aom-integration/*`, and the `guildwise/saved-work/*` of older runners)
  and branches whose new commits are all on a remote-tracking ref or were there at shift start (a pull); a commit on
  another branch that is on no remote ref is still `commits_on_other_branch`;
- **a working branch the remote rewrote** (force-push; an earlier value of `origin/<branch>`, read from its reflog,
  was dropped and the local branch is at, behind or on top of it): the local branch follows the remote, it is never
  merged and never pushed. Checked out: `git reset --keep origin/<branch>` (your uncommitted edits stay; if they are in
  the way the realignment waits). Not checked out: `git branch -f`. Local commits that were never on the remote are first
  kept in a stash entry (`saved work <date>: N local commit(s) of <branch> ...`, W's first parent is the old tip, so
  `git branch <name> stash@{n}^1` recovers them; no branch, nothing pushed) and listed in a desk notice. **Older
  runners' `guildwise/saved-work/*` branches** are migrated by every hygiene run: each local one is stored as a stash and
  deleted, each one on origin is fetched, kept the same way and deleted from origin (`git push origin --delete`); only
  that exact prefix is touched. A rewrite is not a conflict: no conflict
  branch, no DevOps request, and DevOps conflict resolution never pushes the working branch;
- **on the working branch**: pulls (fast-forward; with unsaved edits in the way it waits instead of rebasing over them;
  a clean tree falls back to a rebase that is aborted on conflict), and pushes what is unpushed;
- **on another branch**: leaves the working tree alone, moves the working branch forward from `origin` and pushes it
  when it is only ahead;
- deletes local `aom/...` branches of finished cards that are merged into the working branch and not checked out in a
  worktree, and runs `git worktree prune`;
- **removes the branches of finished cards** (`devops/branch-cleanup.ts`; the project setting "Remove finished card
  branches", default on, empties the list the server sends). For each done or cancelled card (a reopened card is not in
  the list) whose branch starts with `aom/`, `aom-integration/` or the project's prefix, and is not the working or
  main branch: a pull request that is still open keeps it; otherwise it goes when (a) every tip (local and origin) is
  contained in the working branch, (b) every commit's patch is already in the working branch or main (`git cherry`, so
  rebased and cherry-picked work counts), or (c) the card's pull request was merged (the runner asks its
  forge adapter through rpc `hygiene.change_state`; unknown state falls back to (a) and (b)). A declined pull request
  does not release a branch by itself: only (a) or (b) can, otherwise the branch holds the only copy of the work and is
  kept (note "kept: pull request declined, has unmerged commits"). Deleted, in this order:
  the card's worktree (`git worktree remove`, no force: edits or a running shift keep the branch), the branch on origin
  (`git push --delete` with a lease on the fetched SHA, so work pushed since the fetch survives), the local branch.
  Without a fetched origin nothing is removed. The result lists `cleaned[]` (card, branch, reason, where); the server
  logs a line on each card and posts one `branch_cleanup` notice per run.

It never force-pushes, resets or discards anything. What it cannot resolve (a conflict, a branch that is not there, an
authentication failure, a missing clone) is reported and becomes a signal in the
BA's daily report; it closes when a later run finds the repository in order. The commands that changed something are
logged in the request's record (`aom devops-done`). The DevOps agent may `git push` from its own shell (owner decision: it is the workstation-management agent);
the push in `aom hygiene run` is still done by the runner, not by the model.

#### Builders may rebase in their own worktree

A builder (and only a builder) may run `git rebase`, plus the `git checkout` / `git switch` that a rebase needs, inside its
own card worktree, to reconcile its branch with the working branch (for example when the runner's pre-test rebase
conflicted and the card is in Rework). The worktree is the only repository the builder can write to (the sandbox and the
`Edit` rules keep everything else read-only), so this can only move its own branch. `git push` and `git reset --hard` stay
denied for every role; all other roles keep denying `rebase`, `checkout` and `switch`. The built-in builder role is version 2
for this change.

### How finished work lands (protected branches)

The completion action `merge` is the project default (`projects.default_completion`, `merge` or `pr`; a card's own
action wins, and a card created without one takes the project's). Before a merge the runner asks the code host whether
the working branch is protected (`gh api repos/{owner}/{repo}/branches/<branch>/protection`; success means protected,
"Branch not protected" means open, anything else is unknown) and treats a rejected push (GH006, "protected branch hook
declined", GH013 and the like) the same way: the card branch is pushed and a pull request is opened instead
(`FinalizeResult.protectedBranch`, `action: pr`). The server records `pr` on the card and switches the project default
to `pr` with a note on the card. Nothing is forced. Hosts other than GitHub are covered by the rejected-push path only.

**When a card branch reaches origin.** Only when the completion action needs it: `pr` (the pull request needs the
branch) and the protected-branch fallback above (a pull request); a pull request branch goes out as `<prefix>/<ticket>`, never under the `aom/` card name. (The retired `push_branch` action is refused.) With `merge` the runner merges the
card branch into the working branch in a local integration worktree and pushes only the working branch; the card branch
never leaves the workstation. The architect's `aom git push` is refused for every card (with the reason): its design commits stay in the
worktree until finalize, and are pushed only if the card ends in a pull request. Hygiene removes
a card branch once the card is finished and the work is elsewhere (see "Repository hygiene"). If a reopened card's branch
was removed, the next shift recreates it: `ensureWorktree` in `reuse` mode takes `origin/<branch>` when it still exists,
else cuts the branch from the working branch.

### Run a branch (supervised services)

Backlog #58 (`docs/design/run-and-integration-tests.md`, phases 1 and 2). Someone presses **Run this branch** (card page) or
**Run branch...** (the project's board); the server sends `run.start` and files a DevOps request of kind `run`. The runner
and the DevOps engineer split the work:

- **The runner prepares and supervises.** `run.start` creates one detached worktree per repository at
  `worktrees/<KEY>-<project>/run-<env>/<repo>` (the local branch head, else `origin/<branch>`; `git worktree add --detach`, **no
  branch is created**, nothing is written into the repository). It answers the command with `ok:false` and the reason when the
  cap (`maxRunEnvironments`) is reached, there is no clone or the branch does not exist.
- **Build guides (backlog #69).** The runner finds the guides itself and passes their text in the brief, nearest first and
  without duplicates, each with its absolute path: the `BUILD.md` of the repository's project folder and root (as before), then
  every `BUILD.md` in the **folders above the clone**, up to and including the `repoRoots` entry that holds it (the organization
  source folder sits inside one), case-insensitively, never the home directory or anything above it, and nothing for a clone that
  is not under a repo root. A guide that sits above several clones is listed once, with the repositories it applies to. Only when
  no `BUILD.md` exists anywhere are README files (`README.md`, `README`, `.txt`, `.rst`) used as a fallback. The project's **Build
  guide** setting (absolute paths on this workstation, Project settings > Run and test; sent as `buildGuides` in `run.start`)
  **replaces all discovery**, the repository's own `BUILD.md` included; the runner reads those files, they are never stored on
  the server. Guides outside the run worktrees are passed as text, and the brief carries the pairs *user's checkout => run
  worktree* (`pathMap`) with the instruction to map paths in a guide accordingly. The plan fingerprint (the runner's `buildHash`)
  covers the repository guides and every parent or configured guide (path and content hash; a README fallback is not part of
  it, and with no guide above the repositories the value is the same as before). A new parent guide, or a changed one, makes
  the plan stale. **Submodules:** a new run worktree runs `git submodule update --init --recursive` with the repository's git
  auth (the origin's token or ssh key); a failure does not stop the start, the runner logs it and `aom run info` shows
  "WARNING: the submodules could not be initialised: ...".
- **The DevOps engineer works out how.** Its brief carries the guides above, the project's run instructions and the declared
  services, and the rules of the role: follow the guide first and literally, check the environment's own configuration
  (`appsettings.{Environment}.json`, `launchSettings.json`, `.env.development`) before it calls a dependency missing, start
  services in the environment the guide implies (`ASPNETCORE_ENVIRONMENT=Development`), count a host on the private network as
  available, and when it is still blocked **ask the owner** with `aom devops-approval --action "Question: ..." --reason
  "<options>"` instead of failing. The request then waits (`needs_approval`) and the environment shows as **waiting for you**
  in the app until the owner answers on the desk; `aom run fail` is for when asking cannot help, and its reason is what the
  failed environment shows. It calls `aom run step|service`
  (above). The runner runs them: **it** spawns each service, never the Claude session, so a service outlives the shift. The
  command is an argument list (no shell). `${port}`, `${<port name>}`, `${<service>.port}` and `${<service>.<port name>}` are
  substituted in arguments, `--env` values and health URLs. `--env` values must pass the toolchain credential filter
  (`checkEnvVar`: no TOKEN/KEY/SECRET names or secret-looking values); secrets go in `--env-file`, an absolute path outside the
  worktrees and the data folder, of which only the path is kept. Values from env files are replaced by `***` in `aom run logs`
  and in streamed logs. A service declared in the project settings cannot be contradicted (command, folder, ports, health,
  `after`). Docker commands (`docker`, `docker compose`, `podman`) are refused unless the project allows them.
- **Services.** Each runs in its own process group (Node `detached`, i.e. `setsid`), stdout and stderr go to
  `runs/<env>/<service>.log` (copy-truncate rotation at 20 MB, one older file `.log.1`), state to `runs/<env>/state.json`
  (pid and process start time). Ports: the default is used when it is free (a real bind test) and not held by another
  environment, otherwise one is allocated from `runPortRange` and written to the port's environment variable; a port with no
  variable that is taken makes the call fail with that explanation. `after` is honoured (the dependency must be healthy).
  Health: `http` (2xx, or 2xx and 3xx), `tcp`, `log` (regex), `none` (alive after a grace period), re-checked every 10 s once
  healthy (three failures: unhealthy). A service that was healthy and exits after `aom run ready` is restarted three times
  (1, 5 and 15 s); the fourth exit fails the environment. Stop: `--stop-cmd`, then SIGTERM to the group, SIGKILL after 10 s.
- **Waiting.** `aom run step` and `aom run service` answer after at most about 100 seconds ("still running", exit code 3) so a
  long build never trips Claude's Bash time limit; the work goes on in the runner.
- **`aom run ready`** checks every wanted service is healthy, sends `run.plan.saved` (the steps that worked, the services, the
  notes and a hash of `BUILD.md`) and moves the environment to `healthy`. The server records the plan (`run_plans`) together
  with the two halves of its fingerprint (the `BUILD.md` hash from the runner, a hash of the run instructions and structured
  fields from the server). The runner keeps the plan on the environment (it is what Restart starts again). `aom run fail`
  ends the environment as `failed`.
- **Plan replay (phase 2, `runs:2`).** When a plan for the project on this workstation is `active` and both halves of its
  fingerprint match (or, with no plan of its own, an active **project-wide** plan that the owner saved or confirmed from a
  scan: `workstationId` null, `source` `owner|scan`, sent with `replay.buildHash: null`, which means "do not compare with
  `BUILD.md`"; an owner plan never goes stale by itself, a failed start only flags it and files the DevOps repair, whose fix
  is a plan of this workstation; "Test these steps" replays an unsaved plan the same way, a failure ends the environment
  instead of filing a request), the server sends `run.start` with the plan (`replay`) and files **no DevOps request**: the runner prepares
  the worktrees, compares the plan's `BUILD.md` hash with the one it computes from the run worktrees, then replays the plan
  with no model call. Setup steps run in order and honour `when`: `always` (default), `first` (only in a fresh worktree) and
  `changed:<glob>` (in a fresh worktree, and after Update & restart when a changed file matches; the glob is matched against
  paths relative to the repository root, dotfiles included). Services start in `after` order (only the wanted ones and what they
  need), each until healthy, within its `startTimeoutSec`. The runner re-validates every step: `cwd` inside the worktree, env
  files outside every worktree and the data dir, the credential filter on `env`, Docker only with the project opt-in. **Any
  failure** (a step, a service, a vanished repository, a runner restart in between) stops what the replay started, empties the
  environment, forgets the request id and sends `run.replay.failed` (acknowledged: persisted and resent) with the reason and the
  last 40 log lines (secrets redacted). The server then files a DevOps `run` request whose brief carries the failure and the
  current plan; the engineer repairs it with `aom run` and `aom run ready` saves a new plan version. The first `aom run` call
  from that request adopts the environment. A `BUILD.md` that differs from the plan's hash is the same path with `stale: true`:
  the server marks the plan `stale` (`RunPlanMarkedStale`); a change to the run instructions or the declared services marks it
  stale as soon as it is saved. Plans saved before phase 2 have no hashes and are not replayed.
- **Scan with DevOps (`setup-scan:1`).** The server files a DevOps request of kind `run_scan` (design:
  `docs/design/deploy-run-ux-design.md` section 5); the shift's `devops.scan` carries the project's repositories, the run
  instructions and the current plan, and the supervisor fills each repository's `clonePath` (the user's checkout, passed as
  `--add-dir` so the DevOps settings deny editing it). The guard (`devops/guard.ts`, `readOnlyScan`) refuses every command that
  starts, builds, installs, connects (ssh, curl) or writes (redirects outside the scratch directory, `rm`, `git` verbs that
  change anything, `docker` verbs other than the read-only ones); it is defence in depth on top of the brief. The shift ends
  with **`aom setup propose --area run --file <json>`** (IPC `setup.propose`, forwarded to the server): the file is a
  `SetupProposal` (`packages/shared/src/setup/proposal.ts`: the proposed `run` plan, `items` with `found|guessed|unknown`,
  evidence and JSON pointers, `questions`, `secretsNeeded`, `notes`); the server validates it (schema, pointers, run plan,
  repository ids) and answers with the error so the engineer can fix and resubmit in the same shift. The proposal is data:
  nothing it names runs or is saved until the user confirms it in the app.
  **The scan's shell is an allowlist** (final review; `scanSandboxBlock`): the whole real home, `/run/WSL`, `/run/user/<uid>`,
  `/mnt/*/Users` and the Docker sockets are unreadable (so `~/.config` including `aom-uat`, browser profiles, shell history and
  every other project are gone without being listed), and only the scratch folder, the `aom` shim, the toolchain and each clone
  are opened again, read-only. Secret files (`.env*`, `*.env`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.pypirc`, `.netrc`, ...) are
  masked by path wherever the walk finds them, `build/` and `dist/` included (a clone over 400,000 entries is not opened at all;
  a dependency folder over 60,000 entries is hidden). `.git` is opened without its `config` (remote URLs may carry tokens, so
  `git remote -v` prints nothing during a scan). Links in a clone's top level are not opened (bubblewrap would bind their target).
  A scan passes no `--add-dir` (Claude Code would open the whole clone to the sandbox and undo the masks), and gets no
  `SSH_AUTH_SOCK`, `DOCKER_HOST` or `XDG_RUNTIME_DIR` and the agent's private `HOME`. Claude Code itself runs outside this
  sandbox (only its Bash commands run in it), so it needs no part of the home; `scan-sandbox-real.test.ts` runs the real
  `claude` binary and bubblewrap against a fake API to prove a normal file reads, bash runs and the secrets do not.
- **Service sandbox (D10, phase 2).** Steps and services run under the runner's own bubblewrap profile
  (`apps/runner/src/runs/sandbox.ts`), not the DevOps session's: `--ro-bind / /` (read-only), `--unshare-pid`, `--cap-drop ALL`,
  the **host network** (no `--unshare-net`: a dev server must listen where a browser can reach it), and the same unreadable
  set agents get (`HOME_SECRETS` in the real home and the runner data dir, masked with an empty tmpfs; the worktrees and caches
  are bound back inside it). Unix sockets are not filtered by bubblewrap, so the system and session buses, `/run/systemd`,
  `/run/user/<uid>` (the user's systemd manager: `systemd-run --user` would start a unit outside the sandbox) and the Docker
  socket are masked too. Writable: the run worktrees, the shared caches (`<data dir>/cache`, with the same cache variables
  agents get) and a private `/tmp` (`/tmp/aom-run-<env>`, removed when the environment stops) in which `HOME` lives
  (`/tmp/home`). **.NET user secrets:** `~/.microsoft/usersecrets` of the real home is bound **read-only** at
  `/tmp/home/.microsoft/usersecrets` (the services' `HOME`), because `dotnet run` in Development reads its secrets there; only
  run steps and services get it, an agent's shell never does, and nothing else of the home is opened. The environment is scrubbed of credentials (names like TOKEN/SECRET/KEY, `SSH_AUTH_SOCK`, the bus variables,
  `AOM_*`, `CLAUDE*`, `ANTHROPIC*`); env-file values are injected on top. There is **no `--die-with-parent` and no
  `--new-session`**: a service is detached (its own process group) and outlives the runner and the shift. The sandbox follows
  `runtimes["claude-code"].sandbox`: `required` (default) refuses to start a step or service when bubblewrap cannot run;
  `best_effort` with `allowUnsandboxed` runs unsandboxed; `off` runs unsandboxed. A service that runs outside the sandbox is
  flagged in the environment panel (`No sandbox`). **Docker** (`docker`, `docker compose`, `podman`, or a service declared
  `docker`) needs the project's "Branch code may use Docker" opt-in, runs **outside the sandbox** as the runner's user and is
  flagged `Docker: outside the sandbox`. Env files are read by the runner and injected into the process environment; the
  values never leave the runner and are replaced by `***` in logs. A plan's `stopCmd` runs in the same sandbox.
- **Restart, Update & restart.** `run.restart` stops the services (reverse order), optionally fast-forwards every run worktree
  to the head of its branch (`git checkout --detach <head>`; refused with the reason when the branch was rewritten, i.e. the
  old commit is not an ancestor, and then nothing is changed), and replays the environment's plan in the same worktrees, so
  incremental build outputs survive. Setup steps `first` are skipped, `changed:<glob>` steps run only when Update changed a
  matching file, `always` steps run. The expiry restarts from now. If the replay fails the usual fallback to the DevOps engineer
  applies. The same command **revives** a stopped manual environment: a manual environment that has a plan keeps its run
  worktrees for 24 hours after a stop (a test environment, a failed one, or one without a plan removes them at once); the
  server allows Restart on it for that long, within the cap and when the same branch is not running again.
- **Run worktree sweep.** `worktrees.sweep` (and the start-up sweep) also looks at `run-<env>` folders. The runner asks the
  server (`worktrees.query`) which are live: an environment that runs, or a stopped manual one with a plan stopped less than
  24 hours ago. Anything else (older, failed, a test environment, unknown to the server) is removed worktree by worktree; a
  worktree with uncommitted changes is **reported (`dirty`) and not deleted**, and the folder stays. With no answer from the
  server nothing is removed, and the runner never touches the folders of its own live or kept environments.
- **Reports.** `run.status` on every change (debounced, and immediately before an `aom run` call answers; also for every
  known environment after each `welcome`, so a missed final state is resent); `run.log` only while a browser follows
  (`run.follow`), first the last 500 lines, then new ones every half second. Neither is acknowledged.
- **Restart of the runner.** Services are *not* stopped when the runner stops (a self-update, a restart): on start the runner
  re-adopts every service whose pid and start time still match and goes on supervising it. An environment whose services are
  gone ends as `runner_restarted`; one that was in the middle of a replay is handed to the DevOps engineer. systemd's default
  `KillMode=control-group` would kill the services with the runner, so each service is started with
  `systemd-run --user --scope --unit=aom-run-<env>-<service>-<n>`: the scope is a unit of its own under the user manager, outside
  the runner service's cgroup, and systemd-run enters it by itself (the pid stays that of the command, so the pid and start
  time re-adoption works unchanged; for a sandboxed service the user-bus variables are passed to systemd-run only and removed
  with `env -u` before bubblewrap). It is used when `systemd-run --user --scope true` works (a systemd user session with
  `XDG_RUNTIME_DIR`: the installer's lingering gives that); without it (no systemd, a container, macOS) services start as
  plain detached processes as before, and then `KillMode=process` on the unit is the only way to keep them across a restart.
  `AOM_RUN_NO_SCOPE=1` turns the scope off. `systemctl --user list-units 'aom-run-*'` lists the scopes. Restarting
  environments automatically after a reboot or a crash comes in phase 3.
- **Time limit.** The server stops manual environments at their expiry (8 hours by default, **Extend** adds the project's TTL);
  the runner also stops one itself ten minutes after its expiry if the server could not.
- **Residual risk.** A sandboxed service shares the host network, so it can reach anything the machine can (internal hosts,
  databases on localhost); only Docker steps (opt-in) and a runner with the sandbox off run with the user's full rights. The
  tester access (forwarders and `aom-env`, D6) is described under "Integration tests by the tester" below.
- Not available on native Windows (the hello does not announce `runs:1`, `runs:2` or `runs:3` there).

### Integration tests by the tester (backlog #59, `runs:3`)

The project setting (Project settings > Run and test > Integration tests: `off`, `local`, `remote`) decides whether the `test` stage of workflow `code` v4 runs. With `local`, the server provisions a test environment per card and the tester works against it. Details of the design are in `docs/design/run-and-integration-tests.md` (sections 4 and 7, P3).

- **Provisioning.** A card queued at an `environment: 'project'` stage waits until an environment for it is `healthy` on its workstation. The server sends `run.start` with `purpose: 'test'` and `rebaseCard {repoId, cardWorktreePath, baseBranch}`: the runner first rebases the card branch onto its base branch in the card worktree (the stage's `rebaseBefore`, so the tester's own rebase finds nothing to do; a conflict fails the start and sends the card to Rework with the files, `run.status.rebaseConflictFiles`), then cuts the detached run worktrees from the rebased commit and replays the saved run plan (or the DevOps engineer works it out, as for a manual start). The environment lives until the tester's verdict (`run.stop` with `reason: verdict`), or `keepOnFailureMin` after a failed card, or four hours at most.
- **Forwarders (D6).** Each Bash call of a sandboxed agent has its own network namespace, so `localhost:<port>` there is empty. For a tester shift with an environment the runner listens on one Unix socket per environment port in the agent's private tmp dir (`<tmp>/env/<port>.sock`), connects each connection to `127.0.0.1:<that port>` and nothing else, and refuses it as soon as the environment stops. `AOM_ENV_FORWARDS=<port>=<socket>,...` and `AOM_ENV_ID` are set in the agent's environment. The wrapper `bin/aom-env [--timeout <minutes>] -- <command>` (written next to the `aom` shim, needs `socat` and `timeout`, which the sandbox prerequisites already include) starts a `socat TCP-LISTEN:<port>,bind=127.0.0.1,fork UNIX-CONNECT:<socket>` per forward inside the command's namespace, waits until they listen and runs the command, which finds `http://localhost:<port>` exactly as on the host (same port numbers: cookies, CORS and hard-coded URLs keep working). `--timeout` kills the command's whole process group (exit status 124) so a hanging suite cannot keep the shift busy. Ports 3128 and 1080 (the sandbox proxy bridges) are never forwarded. The tester role already has `allowAllUnixSockets` (browsers) and `allowLocalBinding`. **Spike (a), 2026-10-14:** a real bubblewrap call with `--unshare-net` (the flags the Claude sandbox uses), `socat` bridging a host Unix socket to a host HTTP server, `curl` and Playwright Chromium to `http://localhost:<port>` inside it: both reach the app. Not available on macOS (Seatbelt has no network namespace; the environment stage is refused there with a message, phase 4).
- **Commands for the tester** (all answered by the runner, over the IPC): `aom env info` (the environment, its ports and URLs, the suites), `aom env logs <service> [--lines N]`, `aom env restart` (same commit; needs a plan), `aom env suites` and `aom env suites propose --name ... --cmd "..."` (answered by the server: the suites the owner confirmed, and unconfirmed suggestions), and `aom test suite --name <suite> --status passed|failed|timeout|skipped [--junit <glob>] [--log <file>]`. The runner reads the JUnit report (relative to the worktree, scratch or temp folder only; a report with failing cases cannot be recorded as passed), attaches the log or report to the card as an attachment (redacted: values of the environment's env files become `***`) and sends `test.suite` to the server, which records `TestSuiteReported`. The server turns a pass after an earlier failure of the same suite in the same shift into `flaky` and counts attempts. `aom test pass` is refused while a confirmed suite of the project has no passing (passed, flaky, skipped) result in the shift. A tester may attach to its own card only suite logs (`source: test suite`).
- **Deployed targets (phase 4).** With the project in `remote` mode `brief.environment` has `mode: 'remote'` and a `target` (the deploy target's URL, extra hosts, whether destructive suites may run, the names of its test accounts). Nothing is started. The runner first probes the target URL (any answer below 500 except 502 to 504 counts) and rejects the shift with `environment_not_ready` / `target_unreachable` when it does not answer; the server answers with a blocking desk item. The adapter is given `extraAllowedDomains` = the hostnames of the URL and the extra hosts, so the sandbox's `allowedDomains` is the package registries plus exactly those hosts (hostname level: the sandbox cannot filter ports). `AOM_TARGET_URL` and `AOM_TARGET_NAME` are set. **Test accounts** are `env.secret.set` commands (the value sealed in the browser with the runner's public key, as for the sudo password; the payload is emptied on the server when answered and expires after a day): the runner keeps ciphertext only, in `secrets/targets.json` (0600), registers the plain values with the redaction registry at start-up, and for a tester shift on that target writes the declared names to a 0600 dotenv file in the shift's private tmp dir, named by `AOM_ENV_SECRETS_FILE`. Values are also removed from the logs the runner attaches. A name with no value on the workstation is noted in the shift's progress. **Spike (b), 2026-10-14**, a filtering proxy standing in for the sandbox's, reached through a socat bridge inside a real `bwrap --unshare-net` call: `curl` and Chromium pages (Playwright launched with its defaults) reach an allowed host and a blocked host answers 403; Node's `fetch` does only with `NODE_USE_ENV_PROXY=1` (`aom-env` sets it) and fails with `ENOTFOUND` without; Playwright's `request` fixture (APIRequestContext) ignores the proxy variables and needs `proxy: { server: process.env.HTTPS_PROXY }` (the tester instructions say so). **Spike (c), private-address targets (the 192.168.x UAT), not run**: it needs the sandbox's own proxy, which runs only inside an authenticated Claude session; known from the design: the sandbox's `NO_PROXY` covers private ranges, so a tool bypasses the proxy and finds no route in the empty network namespace whatever `allowedDomains` says. Proposal (not built): forward a private target's port through the same Unix-socket forwarders (the runner connects to `<private host>:<port>` instead of `127.0.0.1`), which also keeps the host name out of the sandbox; TLS certificates for a private address make `localhost:<port>` awkward, so it is a decision for when a private target is wanted. Not available on macOS (no network namespace; Seatbelt filters differently).
- **Instructions.** The runner appends an "Environment" section to the tester's instructions (where the app is, `aom-env`, the suites to run) from `brief.environment`, so testers hired before the role gained its own Environment section (tester v6) work too.
- **Capability.** The hello announces `runs:3` (not on native Windows). A server provisions only for a workstation that did.

### DevOps shifts are unsandboxed

For a DevOps shift (`agent.isDevops`) `settings.json` has no `sandbox` block, whatever `runtimes.claude-code.sandbox` says
(`required` does not refuse the shift when `bwrap`/`socat` are missing; the runtime's own `unavailable` state still stops
every agent, DevOps included, because the runtime is reported unavailable as a whole). The permissions are:

- allow: `Bash`, `Read`, `Glob`, `Grep`, `Edit` (covers Write), `WebFetch`, `WebSearch`, anywhere on the machine; no
  `blockReadsOutsideWorkingDirectories`; `defaultMode` stays `dontAsk` (no human at the terminal);
- deny: the session tools (`ListAgents`, `SendMessage`, ...), the role's shell patterns (`rm -rf /*`), Read and
  Edit of the runner's private files (`config.json`, `outbox`, `outbound`, `active-shifts`, `vaults.json`, `status.json`,
  `logs`, `mock-state`), Read of the user's `~/.claude` and `~/.claude.json`, and Edit of the agent's own Claude config dir.
  `git push` is not denied for DevOps (it is for the other roles). The credential-store read denies (`~/.ssh`, `~/.docker`, `~/.kube`, ...) are dropped: it needs them.
- environment: `HOME` is the user's real home (docker, ssh and kube configs work); `CLAUDE_CONFIG_DIR` and `TMPDIR` stay the
  agent's own; `SSH_AUTH_SOCK`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `KUBECONFIG` and `XDG_RUNTIME_DIR` are
  passed through when set; `scrubSubprocessEnv` is not applied.
- `git push` is **allowed** for the DevOps engineer (it keeps vaults in sync with the user's own git credentials); the
  no-force-push rule and creating a new repository (`aom repo create`) are unchanged.

**The DevOps chat is unsandboxed too (G-Q1).** The DevOps agent is the workstation-management agent: it runs as the user.
A chat with it gets exactly the settings, environment and tool permissions of a DevOps shift (no `sandbox` block, the real
home, the same denies), so a command, a `docker build` or a deploy asked for in the conversation runs on the workstation. A
missing `bwrap`/`socat` does not stop a DevOps chat either. Every other agent's chat is unchanged: sandboxed, read-only,
scratch directory only. In a DevOps chat the verb `aom devops "<instruction>"` (`devops.request`) is available, which turns an
instruction into a DevOps task with its own thread (the same request the Ask DevOps dialog can send); other chats cannot use it.
Commands in a DevOps chat run at once, with no approval step, except the ones the guardrails below refuse. The decision is deliberate: it is the user's own machine and the
chat is the user talking to their own engineer.

**DevOps guardrails (runner 0.1.24).** Every Bash command of a DevOps shift and a DevOps chat goes through a Claude Code
PreToolUse hook (`aom devops-guard`, configured in the agent's own `settings.json`; its inputs are in
`<agent config dir>/devops-guard.json`, found through `AOM_DEVOPS_GUARD`). The hook reads the command line (pipes, `&&`, `;`,
`$( )`, backticks, `bash -c`, `eval`, `env`/`nohup`/`timeout`/`xargs`, and `cd` are looked through) and:

- **always refuses**: deleting outside the worktrees and the runner's data folders (and the OS temp folder); disk and partition
  tools (`fdisk`, `parted`, `mkfs`, `dd of=/dev/...`, ...); user, group, password and sudo changes and raw `sudo`/`su` (privileged
  work goes through `aom sudo -- <command>`, which still refuses the other rules for the inner command); force-pushing or
  deleting `main`, `master`, `develop`, `trunk` or the project's working branch; dropping a database or schema;
- **refuses unless the manager approved that exact command**: anything that leaves this workstation (`ssh`, `scp`, `sftp`,
  `rsync` with a remote, `docker` with `-H`/`--context`/another `DOCKER_HOST`, `kubectl`, `helm`, cloud CLIs, `terraform`, ...).
  The message tells the agent to ask with `aom devops-approval --action ... --reason ... --command "<exact command>"`; after the
  manager approves, the request resumes with `devops.approval.commands`, and those commands pass. In a chat the same refusal
  tells the agent to file a request (`aom devops "<request>"`), because a chat has no shift to resume;
- **audits** every command, allowed or refused (secrets in the command line are masked): appended to
  `<data dir>/logs/devops-audit.jsonl` and sent to the server (`devops.audit`, table `devops_audit`,
  `GET /api/platform/devops-audit`, super admin).

In a DevOps chat `aom devops-approval` posts the request into the conversation for the owner and `aom sudo` works.
This is a guardrail for an agent that follows its instructions, not a security boundary against one that tries to get around it
(`python -c`, a script it wrote itself): the threat model below still applies.

**Access checkboxes stay guidance (G-Q5).** The ticked rights on the Workstations page (install, Docker, administrator,
paths) are instructions to the DevOps engineer and a precondition of the toolchain step, not an enforced boundary: shifts and
chats of the DevOps engineer are unsandboxed, so a prompt-injected agent is not stopped by an unticked box. The runner's own
toolchain code (below) does honour them.

**Approvals on a member's workstation (G-Q8).** When a DevOps shift asks for approval (`aom devops-approval`), the approver
must be an Owner or Admin of the organization, and the workstation's own user must be that approver or agree. When they are
the same person (an Owner on their own machine) one answer is enough. When they differ, the request waits until both said
yes (the desk item stays open after the first answer); either of them rejecting ends the request.

**Conflicts (G-Q2).** When a card's rebase conflicts (before test, at finalize) or repository hygiene cannot combine a
working branch with its remote, the DevOps engineer tries to resolve it **on a temporary branch first** (`conflict/<ref>-aN`),
runs the build and tests, and only moves the real branch if they pass. The attempt is visible: a note on the card's thread, a
notice on the desk, and the request in the DevOps thread. The card waits for the attempt and then goes on to Rework, so
review and test run again. After two attempts that did not hold, the conflict goes to the desk as an escalation and the
builder (who may rebase, above) takes the card as before.

What this implies: a DevOps shift has the full privileges of the runner's OS user on that workstation, and root through
`sudo` or the Docker socket (access to `docker.sock` is root). The `devops_access` flags (install, Docker, sudo, paths) and
`aom devops-approval` are guidance in the agent's prompt, not enforcement. The Read/Edit denies above do not stop a shell
command from reading the runner's `config.json` (no sandbox `denyRead` applies), so a prompt-injected DevOps agent can reach
the runner token and every credential of the user. Treat the DevOps agent as you would an admin shell: only hire it on a
workstation you are willing to give it to, keep it to requests from your own cards, and prefer a dedicated runner user and
machine (see the recommendation below).

### Repository setup, toolchain and rights (DevOps)

The DevOps engineer prepares a workstation for a project. This is plain runner code driven by server commands (no agent is
involved), so it is deterministic and tested; every command it runs is logged.

**1. A repository added to a project is put on the workstations** (Project settings, Repositories, "Add repository").
The server queues `repo.clone` on every active workstation of the project's members. The runner (`src/repo/clone.ts`):
uses a clone it already has (anywhere under the repository folders, matched by the normalized remote); refuses to touch a
non-empty folder that is not that clone; probes the remote (`git ls-remote`, again with gh's credential helper for https
hosts); then clones into the **first repository folder** (`aom-runner repos add`), the same place `repo.create` uses. If the
manager chose **Create a new repository** and the remote does not exist, the runner creates it with `gh repo create`
(the same `RepoCreator` as the approved `aom repo create`: private or public as chosen, a first commit on the working
branch, then a clone) on ONE workstation; the others clone it afterwards. When the cause is access (no `gh` login, no SSH
key) the state is `needs_manager` with the reason. The state per workstation (`repo_clones`: Cloning, Cloned, Created,
Failed, Needs you) shows under the repository, with "Try again". It is idempotent. Creating without a desk approval is a
decision: the manager asking from the settings page is the approval (agents still need the desk, see `aom repo create`).

**2. The toolchain is made ready before build work.** When a project's repository first appears on a workstation (after a
clone, a hand clone, or a new workstation joining) the server queues `env.ensure`; the table `project_environments` goes
`preparing`, and **every agent card of the project waits on that workstation** until it is `ready` (D3; dispatcher
eligibility clause `env`; only the DevOps engineer's own stages are exempt, they are how it gets fixed; the card shows "the development environment on <workstation> is not ready (...)"). Projects
with no row (everything that existed before) are never held back. The runner (`src/toolchain`):

- detects the stacks from the repository files (depth 3, build and dependency folders skipped) using the **table in
  `src/toolchain/stacks.ts`**: .NET (`*.csproj`, `*.sln`, `global.json`; SDK major from `global.json`, else the highest
  target framework), **.NET MAUI** (`<UseMaui>`, a `Microsoft.Maui.*` package or MAUI platform target frameworks; the
  `maui` workload, plus `android`, `ios`, `maccatalyst` as the target frameworks and the OS require; on Linux only
  `maui-android`, which is all Linux can build; a JDK for Android), Node (`package.json`; pnpm/yarn/bun/npm from
  `packageManager` or the lock file; the Node major from `.nvmrc`, `.node-version`, `.tool-versions` or `engines`), Python
  (`pyproject.toml`, `requirements*.txt`, `Pipfile`; venv, uv, poetry, pipenv), Docker (`Dockerfile`, compose files: the
  CLI and a daemon the runner user may use), Go, Rust, Java (Maven, Gradle; a wrapper means no build tool is needed),
  Ruby, PHP, and **native Android** (Gradle with the Android plugin, or an `AndroidManifest.xml`). Adding a stack is one
  object in that table plus a fixture test (`test/toolchain-detect.test.ts`);
- verifies each tool with its own check (`dotnet --version`, `dotnet workload list`, `node --version`, `docker info`, ...)
  against the version the repository asks for;
- installs what is missing **only if the manager allowed it** ("Install packages and tools"; Docker also needs "Docker"):
  with the OS package manager (apt, dnf, yum, pacman, zypper, apk, brew, winget, choco; Homebrew is also found at /opt/homebrew, /usr/local and on Linux under linuxbrew when PATH lacks it) or the official installer (`dotnet-install.sh`, rustup, bun,
  `npm -g`). Administrator rights come from root, passwordless sudo or the stored sudo password and need "Elevated privileges
  (sudo)" ticked; an installer that needs root is not used without it, and a user-level installer is preferred then.
  Otherwise the report says `needs_access` with what to tick and the manual command;
- **installs the Android SDK** (D6) for MAUI projects that target Android and for native Android projects, at user level in
  `$ANDROID_HOME` (else `~/Android/Sdk`, `~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk`): the command-line tools
  (downloaded from Google, licences accepted; needs `curl` and `unzip`, a JDK first), `platform-tools`, the platform the
  project targets (`platforms;android-<API>`: from `net8.0-android34.0` or the .NET release default, or `compileSdk`) and
  `build-tools;<version>` (from `buildToolsVersion`, else `<API>.0.0`). Only with "Install packages and tools" ticked;
  native Windows gets the manual command;
- **installs the project's dependencies** (D6), once the tools are fine and with "Install packages and tools" ticked, in
  the repository folder and in this table-driven order per stack: Node `pnpm|yarn|npm|bun install`; Python `uv sync`,
  `poetry install`, `pipenv install --dev`, or pip into the project's own `.venv` (`-r requirements.txt`, `-e .`; never the
  system Python); .NET `dotnet restore` (the solution at the root, else the project); Go `go mod download`; Rust
  `cargo fetch`; Maven `mvn dependency:resolve` (or `./mvnw`); Ruby `bundle install`; PHP `composer install`. A step waits
  for its tools. A failing install makes the verdict `failed` (log tail and the command to run by hand in the report);
  without the install right the steps are reported `skipped`. The logs are the same as for the tools;
- reports per tool `ok | installed | missing | failed | needs_access | skipped` and a verdict `ready | failed |
  needs_access`; when a project's environment on a workstation becomes `needs_access` or `failed` the server puts one
  notice on the desk (deduplicated per project and workstation; closed again when it is ready); the last 80 log lines are in the report (Project settings, Development environment) and the full log is in
  `logs/env/<project id>.log` on the workstation. Changing the DevOps access, entering the sudo password or "Check again"
  re-runs it. A tool installed at user level (`~/.dotnet`, `~/.cargo`) is found by the runner through the user bin folders it
  adds to `PATH`; agents in the sandbox see it through the agent toolchains ("Agent toolchains": `~/.dotnet` is found automatically, `aom toolchain add` registers anything else). A missing tool's "How to fix" ends with that registration step, so the Fix-with-DevOps button asks DevOps to install and register it.

**3. Ticked rights are proven.** For every right the manager ticks on a DevOps engineer the runner checks it on the
machine (`rights.verify`, sent when the ticks change and on "Verify now") and the Workstations page shows
`verified` or `failed` with the reason and the fix: Docker (`docker info` as the runner user: not installed, permission
denied -> `usermod -aG docker`, daemon stopped), sudo (root, `sudo -n true`, or the stored password with `sudo -S -v`; on
Windows the runner must be elevated), install (a package manager usable with the rights there are) and writable paths.

**4. The sudo password.** Design (open question for the owner): *encrypted in the browser with a key only the runner holds*.

1. The runner creates an RSA-2048 key pair on first start (`<data dir>/secrets/runner-key.pem`, mode 0600 in a 0700 folder)
   and announces the public key and its id (first 16 hex digits of the SHA-256 of the key) in `hello.sudoKey`.
2. The browser fetches it (`GET /api/workstations/:id/sudo-key`), encrypts the password with WebCrypto RSA-OAEP / SHA-256
   and sends only the ciphertext (`PUT /api/workstations/:id/sudo-password`). The server cannot read it. It travels in
   the durable runner command `sudo.set`; when the runner answers, the command payload is emptied. No event carries it
   (`DevOpsSudoPasswordSet` has the key id and whether sudo accepted it).
3. The runner decrypts it in memory, stores the **ciphertext** in `<data dir>/secrets/sudo.enc` (mode 0600), checks it with
   `sudo -S -v`, and registers the plain text with the redaction registry: the runner log, command output and install logs
   replace it with `***`. After a restart it is registered again before the first log line.
4. It is used only through `sudo -S -p ''` with the password on **stdin** (never an argument or environment variable): by the
   toolchain installer, and by the DevOps engineer through `aom sudo -- <command>` (an IPC call to the runner; refused for
   any agent but the DevOps engineer, and only while "Elevated privileges (sudo)" is ticked). The password never enters the
   agent's context. "Forget it" deletes the file.

Limits, stated plainly: the browser trusts the public key the server gives it, so a malicious server could substitute its own
key; compare the key id shown on the page with `aom-runner doctor` on the machine if you do not trust the server. The DevOps
engineer is unsandboxed (previous sections) and runs as the runner user, so a prompt-injected DevOps agent can read the
`secrets` folder like it can read `config.json`; the alternative (the OS keychain) is no stronger against a same-user process.
Windows has no sudo: the runner must run elevated and no password is stored.

### Threat model and residual risk

What the layers above protect against: an agent (or a prompt injection that steers it) reading the runner's
`config.json` (runner token, Jira token, provider credentials), other agents' sandboxes and worktrees, the user's SSH
keys and cloud credentials; writing outside its worktree, into the vault, into the repository's hooks or config;
reaching hosts other than package registries from the shell; inheriting `GH_TOKEN`, `SSH_AUTH_SOCK` or cloud keys; and a
manipulated server or project owner steering `git` or `rm -rf` with option-like refs or `..` paths.

Where the runner token lives: in `config.json` (mode 0600) inside the runner data directory, which every agent session
is denied (sandbox `denyRead` and a `Read` deny rule). We did not move it to the OS keyring: the runner needs it
unattended at boot, and a keyring that is unlocked for the runner is as reachable by a same-user process as the file.

**Residual risk, stated plainly.** Agents run as the same OS user as the runner. That is not a hard security boundary.
The DevOps engineer is outside the sandbox altogether (previous section): everything below applies to it in full.
- Anything outside the sandbox boundary runs with the runner user's rights: Claude Code itself, MCP servers, hooks, and
  any command you add to `sandbox.excludedCommands` yourself.
- Without `scrubSubprocessEnv`, a process of the same user can read `/proc/<pid>/environ` of the runner's other child
  processes (it contains other shifts' IPC tokens and the provider credential).
- The sandbox depends on Claude Code and the OS (bubblewrap/Seatbelt) being correct; the permission rules are matched on
  command text and are not a boundary by themselves.
- A same-user local attacker (outside the agent) can read `config.json` regardless.
- The agents of one runner share the package caches under `<data dir>/cache` (see "Shared package caches and .NET"):
  one agent can leave a modified package for another to build with.

**Recommendation:** run the runner as a dedicated, unprivileged OS user with its own home directory and a data directory
only that user can read (`sudo useradd -m aom-runner`, install the service from the section above under that user).
Then even a sandbox escape finds no SSH keys, no `gh` login, no other projects and no personal files. Put Docker access
for tester shifts behind a rootless Docker of that user.

## Vaults: sync and write

(M3 and later)

### Vault sync loop

Every `vaultSyncIntervalSec` (default 300 s = 5 min):

1. **Pull**: `git pull` all vaults
2. **Discover changes**: find local edits from agent shifts
3. **Commit**: stage and commit new files/edits
4. **Push**: `git push` to origin

If a push conflicts, sync pauses and a desk item is posted asking you to resolve it.

### Vault write from shifts

Agents can write to vaults via `aom` commands (BA intake, posting decisions, ratings):
```sh
aom answer --item <id> --text "..."        # writes decision to vault
aom digest --file <...>                    # appends to feed file
```

Vault writes are staged and included in the next sync commit.

### Domain vaults

- **Work vault**: shared with your team
- **Personal vault**: visible only to you
- **Project vault**: shared with project members

A builder on a work-domain card sees only the work vault; personal cards see only personal.

## Capability packs

Owners add skill, persona and playbook packs from git (Settings, Capabilities, Packs). The server pins a commit and keeps the owner's approval; the runner does the git work. Needs runner 0.1.46 (`packs:1`).

- **Where.** `<data dir>/packs/<packId>/repo` (a shallow clone checked out at the pinned commit) and `packs/state.json` (what the server last asked for, so shifts that resume before the server answers still find their skills). Delete a pack in the web app and the folder goes on the next `packs.sync`.
- **Git.** Public repositories over `https`. A private repository over `https` (an access token) or `ssh` (a deploy key), both sealed to this workstation and used for that one pack's fetch only (see "Deploy keys and tokens" below). The runner never uses the user's own ssh keys, ssh agent or git credentials for a pack. The runner runs git with hooks off, no submodules, no LFS, only the `https` and `ssh` protocols (`AOM_PACKS_ALLOW_LOCAL=1` also allows `file` and local paths; tests only) and a minimal environment (`PATH`, `HOME`). No token is ever put in a URL.
- **Nothing runs from a pack.** Files are read as text. Script files (`scripts/`, `.sh`, `.py`, `.js`...) are listed in the review and are removed from what agents are given unless the owner enabled scripts for that pack; enabled scripts only run inside the agent's normal sandbox.
- **Approval and integrity.** A pack is served only when the owner approved exactly the commit that is checked out and the files on disk still hash to the approved content hash (checked on use). Editing a file under `packs/` by hand therefore disables the pack on this workstation until you restore it (the web app shows "files changed").
- **Updates.** "Check for updates" fetches a ref into a second worktree and reports what changed; the pin only moves when the owner accepts.
- **Skills for agents.** A role's `skills` that name skills are written into the agent's own Claude Code config folder (`agents/<id>/claude/skills`) at the start of every shift or chat; an agent with no granted skills keeps Claude Code's skills switched off. Only the granted ones can be used: a hook (`aom skill-guard`) refuses every other skill, including the ones synced to your Claude account.
- **Project repositories.** At the start of a card shift the runner looks for `.agents/skills`, `.claude/skills` and `.claude/agents` in the card's checkout and makes them available to that project's agents.
- **Authored and private packs (0.1.53, `pack-authoring:1`).** An authored pack is a plain folder per revision (`packs/<id>/revs/<sha>/`, `authored.json`); the editor's files arrive sealed to this runner's key (`pack.author.save`) and are checked (text files, layout, limits) before they are stored. A private pack (`visibility private`) is served only to the sessions of its owner (a session turn whose creator is this workstation's user) and to the agents the owner granted it to; any other session, chat or shift on a shared workstation sees nothing of it, in `aom skill list|show`, personas, the capability index and materialised skills. Organization packs authored elsewhere arrive sealed from their author's runner (`pack.bundle.put`) and are stored only if the files hash to the content hash the owner approved. Reads for the editor (`pack.read`) are sealed to a key the browser made for that one read.
- **Deploy keys and tokens.** (0.1.56, `pack-credentials:2`: the credential is sealed `h2` with the pack id, the kind, the host of the git URL and this runner's key id as associated data, and stored with that host; the runner uses it for no other host and refuses a pack whose URL now names another one. The older unbound form is refused: the admin enters the key or token again.) `pack.credential.set` carries a deploy key or token sealed to this runner. It is opened once and written to `packs/.cred/<packId>/key|token` (0600, folder 0700), registered with the redaction registry, and used only for that pack's clone and fetch: ssh through `GIT_SSH_COMMAND` (`-F /dev/null -i <key> -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o UserKnownHostsFile=<pack file>`; `StrictHostKeyChecking=accept-new` for the first fetch, which records the host key in the pack's own `known_hosts` and reports it once, `yes` ever after), https through a one-shot `GIT_ASKPASS` script (`packs/.githome/askpass.sh`, no secret in it, answers only for the pack's host; the token is in that git process's environment only). Nothing is written to a git config or a URL. The private, loopback, link-local and metadata address blocks apply to ssh hosts too. Delete the folder under `.cred` (or remove the pack in the app) to forget a key.
- **Member opt-in.** A pack the server did not list is not cloned; one assigned to this workstation by another member's admin is listed only after the owner of this workstation accepted it (desk item, or Capabilities). Declining or removing it deletes its folder and credential on the next `packs.sync`.
- **Delegation and child runs (0.1.54, `delegate-grants:1`).** `aom delegate <target> "<task>"` works only for the targets the start message listed (the agent's or the session's grants); `--model` is refused (the target runs on its own model). A child that only reads runs as a chat turn with the parent's worktree as read-only working directory; a child that may edit or run commands runs as a shift-style run in the **same worktree** as its parent, under the intersection of the target's permissions and the parent's (never wider; no commit, push, web, MCP or browser), with its own private home, config dir and instructions. The parent waits inside its `aom delegate` call; children that write take a lock per working directory (one at a time), readers run in parallel. Limits: the grant's time (default 110 s, run the Bash call with a timeout above it), 10 tool calls for a reading child and 80 for a working one, a 15 s heartbeat. Its cost is booked on the parent (`delegate.cost`) even when it failed. A running child reports `run.usage` (kind `delegate`) when the server announced `delegate-grants:1` and is stopped by `chat.cancel` with its id (the provider cap) or when its caller ends. Residual risk: the lock cannot see the parent's own edits, so the instructions tell the parent to run `aom delegate` alone.
- **Native subagents (Claude Code).** Every Claude Code shift, chat and turn (except DevOps and the CEO) has the `Agent` and `Task` tools denied unless the agent holds targets: Claude Code's own subagent types (`general-purpose`, `Explore`, ...) used to be callable on the parent's model whatever the permission mode (verified with 2.1.309). With targets, only those are defined (`--agents <config dir>/agents.json`, the target's model, `tools` narrowed to its profile and the parent's), `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` keeps them in the foreground, and a PreToolUse hook on `Agent|Task` (`aom subagent-guard || exit 2`, config `subagent-guard.json`, own 7 s deadline) refuses any other type and asks the runner (`delegate.guard`), which asks the server before each one starts. After the session the runner reads each subagent's transcript under `<config dir>/projects/*/<session id>/subagents/` and books its tokens as a delegate (`native`); the parent's own reported cost is dropped when it called the tool. Only plain Claude Code models of the account are exposed natively, and only targets whose profile a native subagent can honour exactly (reading, or the parent's own edit paths): the rest stay `aom delegate`. A native subagent has no per-call time limit and no tool-call cap. Other runtimes have no native subagents; Codex, Gemini CLI and opencode use `aom delegate`, the direct-model runtime the `delegate` tool.

### Security review fixes on the runner (0.1.56)

Capabilities announced: `provider-keys:3` (credentials bound to their purpose, organization key generations, reshare on an approval) and `pack-credentials:2` (deploy keys and tokens bound to their pack and host). The server sends keys and credentials only to runners that announce them, so a runner older than 0.1.56 gets 422 `runner_too_old` for those and keeps working for everything else. What has to be entered again after the update: every **organization** provider key (the old stored ones are not used; Settings > Model providers > Replace key), and the deploy key or token of every **private git pack** (Capabilities > Packs > the pack's workstations). A workstation's own provider keys keep working (stored before binding), and are bound the next time they are entered.

- **Provider and backend credentials, organization key generations, reshare approval.** See "Provider keys: workstation and organization".
- **Pack deploy keys and tokens.** See "Capability packs", "Deploy keys and tokens".
- **Gemini and Codex logins.** See "Codex login" (R2 hardening) and "Gemini CLI runtime", Sign-in.
- **Vertex key file.** Removed when a session fails to start, random name, swept at start (see "Claude Code on Bedrock, Vertex AI or a gateway").
- **Organization key use needs an organization.** `ProviderStore.get`, `getBackend` and `configured` take the organization of the run; without one only the workstation's own key is returned. `report`, `reportKeys` and `reportConfigured` (names, models and whose key, never a key) still list organization keys, so the server's resolution and the availability of a runtime are unchanged. One side effect: the model list of an organization-only OpenAI-compatible endpoint is not refreshed from the endpoint in the background (no run, no organization); the models the admin listed are still offered.

### Security review fixes on the runner, part two (0.1.56)

Findings 6, 7, 9, 14 and 16, and decision Q68 (above, "Codex without a shell").

- **Organization endpoints (6).** A base URL an organization admin chose is untrusted on a member's workstation. `orgCredentialEndpointProblem(url, allowList)` (`packages/shared/src/models/private-endpoints.ts`): https to a public address, or an exact entry in the workstation owner's private endpoints (any scheme); loopback is not exempt; metadata and link-local never. It is enforced in the egress proxy (`EgressRoute.orgSourced`: opencode routes of an org-sourced key, checked on every request; `allowPrivateUpstream` is ignored for them), in the direct-model guard (`guardedFetch` with `isOrgUrl`: the address a name resolves to is judged without the loopback exemption) and, for Claude Code backends, by `backendEndpointProblem` / `validateBackendFields(id, fields, { orgSourced, endpoints })`. The workstation's own keys keep loopback (the owner typed it).
- **One address normaliser (7).** `classifyIp` (shared) is the one judge: IPv4, IPv6 in any notation, and the IPv4 an address carries: IPv4-mapped (dotted or hex, `::ffff:7f00:1`), IPv4-compatible `::/96`, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`), Teredo (`2001::/32`), site-local `fec0::/10`; the worst class wins, a tunnel form never counts as "this machine". The egress proxy, the direct-model guard, the pack URL check and the private-endpoint list all use it; `*.localhost` is always loopback; a listing matches an IPv6 literal however it is written.
- **Egress proxy requests (16).** The allowed ports (80, 443) apply to plain absolute-URL requests too (a listed `host:port` is the exception). A route path with `..`, `.`, an encoded dot, slash or backslash, or a control character is refused (400), and the joined URL must stay on the upstream's origin and under its path prefix.
- **The repository's configuration (9).** The agent's sandbox writes its worktree and the worktree's administrative folder, and the runner (or the owner) runs git there later, so a `core.fsmonitor` or a hook the agent wrote would run on the host. (a) The `.git` file of the worktree and the admin folder's `commondir`, `gitdir`, `config`, `config.worktree` (and, for a plain clone, `.git/config` and `.git/hooks`) are read-only in the harness box (`protectedGitPaths`, bound read-only after the writable binds, so they can be neither rewritten nor replaced) and denied in Claude Code's sandbox settings (`denyWrite`, and `Edit` rules for the file tools). (b) Every git the runner starts gets `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.ext.allow=never` and `GIT_CONFIG_NOSYSTEM=1` (`GIT_HARDEN_ARGS`, `GIT_HARDEN_ENV` in `git/harden.ts`; `git()`, clone, access, repo create, ssh/plain probes, delivery bundles, the graph's `cat-file`). (c) `git()` refuses a worktree whose `.git` file does not lead to `<repo>/.git/worktrees/<name>` outside the working folder whose `commondir` leads to that repository and whose `gitdir` leads back (`gitPointerProblem`; exit 128, "refusing to run git"). `safe.directory` is deliberately not widened. Proved by `git-harden.test.ts` (a real fsmonitor and a real hook do not run; the real bubblewrap box cannot rewrite or remove the pointers and still commits). Claude Code's sandbox has the same exposure and now carries the same denies; the Codex native profile (macOS) is unchanged.
- **Native subagents (14).** (a) A running native subagent's transcript is read incrementally (`readNativeSubagentUsage` keeps an offset per file) every five seconds and reported as `run.usage` of its delegate, so the organization key's live cap sees it; the server's stop (`chat.cancel` with the subagent's id) stops the parent session the subagent lives in (`DelegateRunner.attachNative`, `stopDelegate`). (b) Each native delegate's server row is kept alive with `delegate.heartbeat` (it used to lapse after 45 s on a long call, which also freed the per-caller count). (c) A journal (`<runner root>/native-pending/<caller>.json`: caller, config dir, session id, the delegate ids) is kept while a session with subagents runs; at the next start `startNativeRecovery` books what the transcripts hold (`delegate.cost` is idempotent by id) and removes it. The server keeps a released delegate's row for two days for exactly this (`released_at`), and `delegate.cost` requires the row. (d) `aom subagent-deadline` fails closed: a marker or state folder it cannot read refuses the tool call; `subagent-guard` refuses to start a call whose marker it cannot write (markers are written whole and renamed). The markers live in the Claude config dir, which the shell sandbox cannot write (not in `allowWrite`); the finding's "writable from the shell sandbox" is not so for Claude Code's sandbox as built.

## Project graphs (the code map)

The project graph is a derived index of a repository's code and docs: the "code map" that agents query with `aom graph`.
It is built on the workstation that holds the clone, kept in the project vault, and never sent to Guildwise HQ. Design:
`docs/design/project-graphs.md`. Architecture: `docs/ARCHITECTURE.md` section 36. Code: `apps/runner/src/graph/`.

### What the indexer reads and skips

- It needs a clone with an `origin` remote on this workstation. It reads the commit through the git object store
  (`git ls-tree`, `git cat-file --batch`), never the working tree. It calls no model and makes no network request.
- Skipped before any file is read: sensitive names (`.env*` except templates, keys and certificates, credential-like data
  files, `.ssh`, `.aws` and similar folders), vendored and build folders (`node_modules`, `vendor`, `dist`, `bin`, `obj`,
  `.venv`, `venv`), binaries, generated files, and files over 1 MB.
- Code: TypeScript and TSX, JavaScript, Python, Go and C# give symbols, imports and calls. Other languages give file and
  module nodes only. Markdown gives headings and links.
- Each link has a confidence: `EXTRACTED` (an import that resolves exactly), `INFERRED` (a call matched by name inside the
  imported files), `AMBIGUOUS` (2 to 5 candidates, all listed). No candidate, or more than five, means no edge.
- The same commit, indexer version and grammar versions give the same bytes. A file that fails to parse drops its symbols
  and is counted in the manifest; the rest of the graph is kept.

### Where the graph is stored

The project graph is the `graph/` folder inside the project vault folder. The organization graph is `org/graph/` inside the
organization vault.

```
graph/
  manifest.json                       schema and indexer versions, repo keys, commits, counts
  modules.md                          navigation summary: top modules, entry points, card counts
  work.md                             card and merge references per module (no bodies)
  repos/<repoKey>/<module>.jsonl      nodes and edges of one module, sorted by id
  repos/<repoKey>/_edges.jsonl        links between modules
  repos/<repoKey>/_work.jsonl         merge (card) links to modules
  repos/<repoKey>/communities.json    module clusters and their labels
```

- `repoKey` is the first 12 hex characters of the SHA-256 of the normalised remote URL. Ids use paths relative to the repo
  root, so they are the same on every machine.
- The files are sorted and written only when their bytes change. An unchanged commit writes nothing, so it makes no vault
  commit.
- Above `maxExportNodes` (default 50,000) the vault keeps `modules.md`, the manifest and the module-level shards. Symbol
  shards stay in the local cache.
- Local cache: `<data dir>/graph-cache/<repoKey>/`. It holds per-file facts keyed by blob id and can be deleted; the next
  index rebuilds it.

### When it is (re)built

- `graph.index` runs when a workstation that holds the clone connects and the project has no graph yet, when the server
  requests one, and on **Index again** in project settings.
- `graph.update` runs when a card merges. The runner diffs the indexed commit against the merge commit, parses only the
  changed files and rewrites only the shards that changed. A force-push or rebase that removes the indexed commit from
  history causes a full re-index.
- Communities are recomputed every 10th merge. Between those, `communities.json` keeps the last result.
- Conflicts in generated `graph/` files during vault sync are resolved by the runner (the remote side wins, then the graph
  is rebuilt from the clones). They never raise a desk item.

### Local vaults

A vault with storage `local` is a plain folder at `<data dir>/vaults/<vaultId>`, marked by a `.aom-local-vault` file. It has
no remote, no sync and no commits.

- The runner logs one warning per folder: the folder is not synced, so the owner backs it up. If the folder sits under
  OneDrive, iCloud Drive, Dropbox or Google Drive, the warning names that tool. The runner never runs `git init`.
- Only the workstation that holds the folder can read the graph. Other workstations get no graph unless they hold the vault.
- When a git repository is registered for the vault, the runner moves the folder aside as `<vaultId>.was-local-<timestamp>`
  (kept, not deleted) and clones the repository in its place.

### Organization graph

Built by the runner on the workstation that holds the organization vault, as `org/graph/`: `projects.jsonl` (project names,
area names and package names; no symbols, files or lines), `links.jsonl`, `drafts.md` and `manifest.json`. Links derived from
code are drafts. They stay on the workstation and count for routing only after the owner asserts them (see the Project
links tab in `docs/USER-GUIDE.md`). `aom ceo route` reads this graph (see "The CEO shift").

### Turning it off

Server setting `AOM_PROJECT_GRAPHS` (default on). When it is off, new projects get no vault from the graph code, nothing is
indexed, no graph is offered to agents, and the organization graph is not built.

### Parser and bundled grammars

- Parser: `@vscode/tree-sitter-wasm` 0.3.1 (MIT), pinned exactly as a devDependency in `apps/runner/package.json`. It is the
  tree-sitter runtime as WASM, so there is no native module and no install script.
- Grammars: TypeScript, TSX, JavaScript, Python, Go and C# (all MIT).
- `apps/runner/tsup.config.ts` runs `scripts/copy-grammars.mjs` after every build. It copies these into `dist/grammars/`:
  `tree-sitter.cjs` (the runtime; `.cjs` because the runner package is `type: module`), `tree-sitter.wasm`,
  `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`, `tree-sitter-python.wasm`,
  `tree-sitter-go.wasm` and `tree-sitter-c-sharp.wasm`. Nothing is fetched at install time.
- Licences: `apps/runner/THIRD_PARTY_NOTICES` lists each shipped file with its origin, copyright and licence text. The copy
  script also places it at `dist/THIRD_PARTY_NOTICES`, so the release tarball carries it at its root. Update it when a grammar
  is added or changed.
- Size: the packaged grammars add about 3.4 MB to the runner tarball.

### Checking a packaged runner

```
aom-runner graph-check <repo> [--out <dir>]
```

Indexes a clone into a scratch folder (or `--out`) and prints the file, node, edge and module counts, the time and the commit.
It writes no vault. It exits 1 when the parser fails on any file. On the reference laptop (2026-10-19) a cold index of this
repository (2,176 files) took about 6 s and gave 12,300 nodes and 27,300 edges in 8 modules.

## Deploys from a delivery recipe

A project in **Recipe** delivery mode deploys by a script in its project vault (`<folder>/delivery/`, see the user guide, "Deploying
with a recipe"). The runner announces the `delivery:1` capability and does three things for it, all as deterministic code (no model):

- **`recipe.inspect`**: reads `delivery/` of the project vault at a commit (`git ls-tree` and `git cat-file`, never the working tree;
  a local vault folder is read as it is), computes the content hash, parses `recipe.yaml`, lints it (a secret in a file, a missing or
  non-executable script) and reports the result. It reports kinds ("a private key"), never the secret.
- **Guided deploy setup (`deploy-setup:1`).** Two more durable commands and one `aom` verb (design: `docs/design/deploy-run-ux-design.md`
  sections 4 and 6). **`recipe.write`** replaces `<folder>/delivery/` with the files the server compiled from `setup.json`
  (`packages/shared/src/delivery/setup-compile.ts`) in one commit (a local vault is rewritten in place), carrying over the
  hand-written scripts named in `keep`; it refuses a path outside `delivery/`, a file the secret scan flags, and files that
  do not hash to `expectedHash` (what the preview showed), then reports what `delivery/` holds now like `recipe.inspect` (which
  also returns the parsed `setup.json`, so the server can find scripts edited by hand). **`deploy.probe`** (`delivery/probe.ts`)
  answers fixed read-only questions, never a free command: scope `local` (`docker version`, `docker compose version|ls`,
  `docker ps` with compose labels, `docker volume ls`, each compose file reduced to structure, backups next to it, a GET of the
  hinted addresses), `ssh_hosts` (the non-wildcard `Host` aliases of `~/.ssh/config`, text only, each tested with
  `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes`) and `ssh_target` (one `ssh` running the bundled read-only script
  `probe-remote.ts`, with only key names of `.env` files and the value of keys that name an image). Results are names and shapes:
  never a secret value, a private key or a compose `environment:` value; a changed host key is a hard stop (`ssh_host_key_changed`)
  with no override; the whole probe has a 60 s budget and a 64 KB report. **`aom deploy probe --local | --ssh-hosts | --host
  <alias> [--dir D] [--compose-file F] [--url U]`** (DevOps, in a scan) runs the same probe through IPC. The scripts `compileSetup`
  generates run unchanged through `deploy.exec`; `generated-scripts.test.ts` runs them against fake docker/ssh/curl.
- **Guided connect, dedicated keys and server preparation (`deploy-connect:1`, v2).** Five more durable commands (design: section
  7.4 and 8). Keys live in `<data dir>/keys/deploy/<target id>/` (`id_ed25519` 0600 in a 0700 folder, its `.pub`, an `ssh_config` that
  is passed to ssh with `-F`, a `known_hosts` of its own with the one host key the person confirmed, `meta.json`); a key made before
  its target exists sits under `pending/<ref>` for up to a week. Nothing here edits `~/.ssh`. **`deploy.hostkey`** runs `ssh-keyscan`
  and returns type and SHA256 fingerprint (it trusts nothing). **`deploy.key`** makes (or finds, never replaces) the ed25519 key with
  the comment `guildwise-deploy:<id>:<computer>` and returns the public half. **`deploy.connect`** (an envelope command: the sealed
  value is a password or key file, hybrid RSA-OAEP + AES-GCM, `h1.` format, expires after 10 minutes, emptied once answered) pins
  exactly the confirmed fingerprint, appends the public key to the server's `authorized_keys` once with `grep -qxF` and a dated copy
  (`authorized_keys.guildwise-bak-<time>`), by `SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+, else the copy-paste
  option) for a password (in the environment of that one ssh process only), a 0600 temp file for a key file, the person's own alias
  (`-F <their config>` only when given) for "also add a dedicated key", or not at all for a pasted key; then tests the new key in
  BatchMode. The password, passphrase and key text are registered with the redaction registry for the call and never logged.
  **`deploy.revoke`** removes the line of ONE key whose comment starts `guildwise-deploy:` (by its public key, dated copy first);
  never its own key, never a line it did not add. **`deploy.prepare`** is a closed list (`install_docker`, `create_dir`,
  `write_compose` from the project's checkout, `caddy_site`, `start_services`), every action idempotent, `dryRun` changes nothing, each
  reports `done|skipped|would|failed`; the server scripts are fixed POSIX shell passed to ssh as a base64 argument with quoted
  positional arguments. `deploy.exec` exports `AOM_DEPLOY_SSH="ssh -F <config>"` for a target this computer holds a key for (the
  generated scripts use it), `deploy.probe` scope `ssh_check` is the cheap reachability look (the server asks for it by itself daily and after a failed deploy only for targets connected through the guided flow, i.e. with a managed `ssh_config`: `IdentitiesOnly yes`, `IdentityAgent none`; a target on the person's own alias is checked only by the Check connection button or by a deploy), and a DevOps scan's `aom deploy
  probe` result is also reported to the server (`deploy.probe.record`). Tests: `deploy-connect.sshd.test.ts` runs all of it against a
  real sshd container (skipped without Docker), `deploy-prepare.test.ts` against fake docker/systemctl/caddy.
- **Read-only scans are an allowlist (v1a review).** In a `run_scan` or `deploy_scan` shift the guard allows only listed read
  commands with an exact list of flags per command (an unknown flag or abbreviation is refused; `$`, backticks and `<(` are refused;
  credentials, `.env` files and the runner's `secrets`/`keys` cannot be read; no web tools), refuses shells, interpreters, wrappers and every redirect to a file, and limits
  Edit/Write to the shift's scratch folder; the shift carries `devops.scanKind` so a scan whose brief cannot be built fails instead
  of running unrestricted.
- **`deploy.exec`**: runs an approved deploy. It re-exports `delivery/` at the approved commit into `<data dir>/deploys/<run id>/recipe`
  and **recomputes the hash; a mismatch refuses** (`hash_mismatch`). It resolves the secrets the recipe names from
  `<data dir>/secrets/deploy.json` (mode 0600; sealed by the browser to this runner's key, the same way as the test accounts of a
  target), else from the recipe's `envFile` (a `KEY=value` file you keep on this machine); a missing one refuses the run
  (`missing_secret:NAME`). It prepares a clean checkout of the commit (a detached git worktree of the repository clone, removed
  afterwards), runs the script in its own process group with the recipe's timeout, with your own environment minus the runner's
  `AOM_*` settings plus `AOM_DEPLOY_COMMIT`, `AOM_DEPLOY_CHECKOUT`, `AOM_DEPLOY_ENV`, `AOM_DEPLOY_TARGET`, `AOM_DEPLOY_HOST`,
  `AOM_DEPLOY_APP_URL`, `AOM_DEPLOY_DRY_RUN` and the secrets. Then the health check (a web address polled until it answers, a port,
  or a line in the script's output) and the smoke script. The log is `<data dir>/logs/deploys/<run id>.log` with secrets hidden. A
  refusal or a failed deploy is an answer, never a retry; the same command delivered twice runs once.
- **`aom recipe save`** (the DevOps engineer, in a recipe request): copies a scratch folder into `<folder>/delivery/` of the vault
  (a git vault: one commit, pushed; a local vault: rewritten in place) and reports the new hash. A folder that holds a secret, a
  symlink or no `recipe.yaml` is refused.

- **Moving to a new server (`deploy-move:1`, v3).** One durable command `deploy.move` with a step per command (design J6): `check`, `copy_config`,
  `copy_image`, `start_database`, `stop_and_backup`, `restore`, `start_app`, `restart_old`, `retire_keys`. The server builds the payload from the
  approved guided setup (compose file, app and database services, backup folder, health path) and chains the steps; the computer is stateless
  between steps. It signs in to BOTH servers with the sign-ins it has (a target's managed `ssh_config`, else the person's own config named with
  an explicit `-F` and `UserKnownHostsFile`: OpenSSH reads `~/.ssh/config` through the account database, not `$HOME`, so every ssh call
  names its config) and moves data as streams through itself, never to disk: the compose file and `.env`/`env_file` files (written 0600 on the
  new server, never over a different file: `config_differs`), the image (`docker save | gzip` to `gunzip | docker load`, skipped when present),
  and the database (the last backup is made on the old server with the app stopped, dated in the backup folder and kept; it is streamed into
  an EMPTY database in one `--single-transaction` psql, `new_database_not_empty` otherwise, and the table counts of both databases must match).
  A step that stops the old app puts it back by itself when its own work fails (`oldAppRunning` in the answer); a failed `start_app` leaves the
  old app stopped (the data is on the new server) and the person chooses Try again or `restart_old`. `retire_keys` removes every line whose
  comment starts `guildwise-deploy:` after a dated copy (atomic: copy, filter, rename) and nothing else. Nothing is ever `down`, removed,
  pruned or deleted on either server. Answers carry plain-words checks and counts, never a value. Tests: `deploy-move.test.ts` (fake ssh and
  docker, hermetic: a fake `ssh` first on PATH) and `deploy-move.sshd.test.ts` (two real sshd containers with a fake docker and a real httpd).
- **Scan shifts run in the OS sandbox.** A "Scan with DevOps" shift is the one DevOps session that is sandboxed: the clones are read-only with
  their settings files (`.env*`, keys) left out of what the shell sees, the scratch folder is the only writable place, credential folders,
  the runner's data, Windows user folders and the Docker sockets are masked, and the shell has no network. It is refused (fail closed) when
  bubblewrap is not available, whatever the runner's sandbox mode says. The command guard stays as a second layer. A scan probes only its
  project's own servers (`aom deploy probe --target <name>`).

The script runs as you, on your machine, outside the Claude sandbox: that is the point of a recipe (Docker, ssh, a remote host).
What protects you is that it only runs the exact version you approved, only when its gate holds and only when the recipe's releaser
(you, an Admin, or the CEO where the recipe names it) says so. `aom deploy run|trial|status` only ask the server.

## Simulated workstation

A simulation organization (see `docs/ARCHITECTURE.md` section 33) has no workstation of yours. The server pairs one for the Owner and runs a normal runner process on the server itself: mock runtime only (`--mock`, `AOM_RUNNER_MOCK=1`), its own data directory `AOM_SIMULATION_DIR/<org id>/runner`, repo root `.../repos`, and local bare "origin" repositories `.../origin`. The pace is `AOM_MOCK_STEP_MS` (100, 1500 or 5000 ms for fast, normal and slow) and `AOM_MOCK_CHAT_TOKEN_MS`. Chat replies come from `AOM_MOCK_REPLIES_FILE`, a JSON map whose keys are an exact message, a `/regular expression/flags`, or `*` for the default; a value is a reply or a list of replies (`{name}` is the agent, `{message}` the user's text). The same file format is used for the training video. `ANTHROPIC_API_KEY`, `GH_TOKEN` and `GITHUB_TOKEN` are blanked in its environment. It needs `git` and the built runner on the server (`AOM_SIMULATION_RUNNER_BIN`, or the packaged release in `AOM_RUNNER_RELEASE_DIR`, which the server unpacks once).

## Integrations (connect from the web)

The Integrations page (`/workstations/<id>/integrations`) lists every integration of a workstation as a tile (Claude Code, GitHub,
GitLab, Bitbucket Cloud, Azure DevOps, SSH keys, Jira, MCP servers) with its status and the actions Connect, Replace, Test and
Remove. The kinds, methods, fields, scopes and help steps come from one registry (`packages/shared/src/integrations/registry.ts`); a
runner adapter per kind (`apps/runner/src/integrations/`) does the work. Needs runner 0.1.11 or newer; an older runner shows its
state read-only and the page says which command to run instead. Every command-line path stays (`git-connect`, `jira-connect`,
`auth`) and uses the same adapters, so the page and the terminal agree and a change made in one shows in the other within seconds.

**How a secret gets from the browser to the runner.** The browser seals the values with the runner's public key (the key whose id
`aom-runner doctor` prints, shown on the page): a random AES-256-GCM key encrypts the fields, RSA-OAEP-256 wraps that key, and the
authenticated data binds the envelope to one workstation, request, kind, instance and operation. The server relays the ciphertext
in the durable command queue and cannot read it; it empties the payload when the runner answers (or after ten minutes) and never
logs it. The runner opens it, refuses an expired envelope (10 minutes), one already used (the seen refs survive a restart), another
key id and one moved to another request, checks the values with the provider and saves them only when the provider accepts them.
An active, malicious server could still serve altered page code or swap the public key: that is why the key id is shown in both
places and why you can turn web connect off.

**Local policy** (`config.json`, `integrations`; commands below):
- `aom-runner integrations` lists the status of every integration (the same facts the page shows) and the policy.
- `aom-runner integrations allow-web off|on` refuses (or accepts again) every credential and sign-in submitted from the web on this workstation. Test stays allowed.
- Machine-wide logins (`~/.claude`, `gh`, MCP sign-ins) belong to the whole machine, not to one pairing. From the web they can be changed only by the machine's primary pairing (the first one, or the one named with `aom-runner integrations machine-admin <pairing>`); `machineScopeFromWeb: "never"` in `config.json` turns that off completely. The tile shows why an action is disabled.

**Claude from the web.** "Sign in with your Claude subscription" runs `claude setup-token` in a pseudo-terminal made with `script(1)`
(Linux and macOS; native Windows has none, so the tile shows the command). The page shows the sign-in link; the owner signs in
at claude.ai and pastes the code the Anthropic page shows; the runner writes it to the CLI, captures the year-long token it
prints, stores it in `secrets/claude.json` and switches that workstation to `oauth` mode without a restart. Agents then get
`CLAUDE_CODE_OAUTH_TOKEN` and no longer depend on the refresh token of `~/.claude`. Plugin MCP sign-ins are still passed to
agents as private copies. The token never reaches the server. A subscription token is for individual use. Output the runner does not
recognise ends the sign-in as failed with the command to run in a terminal; it never hangs (limit: 10 minutes, two sign-ins at a time).

**MCP servers from the web.** `claude mcp login <server key> --no-browser` prints the provider's authorization link and asks for
the redirect URL. The page shows the link (with its host) and a field. After signing in the provider redirects to
`http://localhost:<port>/callback?...`: if the browser is on the workstation itself, the CLI also listens there and finishes by
itself; otherwise that page does not load, which is expected: copy the whole address and paste it into the field (up to three
tries; a wrong address is asked for again). Limits: claude.ai connectors and hand-added servers are not listed; a provider that needs
the redirect delivered another way needs "on the workstation run `claude`, `/mcp`, Authenticate".

**GitHub, GitLab, Bitbucket Cloud, Azure DevOps, Jira.** GitHub: a device code (`gh auth login --web`, the code and link shown on the
page) or a classic token handed to `gh auth login --with-token` on stdin, then `gh auth setup-git`. GitLab, Azure DevOps and
Bitbucket Cloud: the token goes through the same `saveAndVerify` as `git-connect` (`secrets/git-tokens.json`); the GitLab tile also
shows the scopes and expiry from `personal_access_tokens/self`. Jira: base URL, e-mail and a classic API token, checked with
`GET /rest/api/2/myself` (scoped Atlassian tokens need the `api.atlassian.com` route and are a later phase).

**Files.** `secrets/claude.json`, `secrets/integration-seen.json`, `logs/integrations.jsonl`, `tmp/integrations/` (the working
directory of the sign-in CLIs, never a repository). **Protocol:** runner messages `integrations.report` (every status, plus the
policy) and `integration.session` (progress of a sign-in; acked), `hello.integrationsVersion`; server commands
`integration.connect|begin|input|cancel|test|remove`. Recorded transcripts of the real CLIs (claude 2.1.299, gh 2.102) are the
fixtures under `apps/runner/test/fixtures/integrations/`; Claude's screens can change between versions, so the matchers live in
one place each (`claude-code.ts`, `mcp.ts`, `github.ts`) and a version bump should re-run `claude setup-token` once to check them.

## Credentials and secrets

**Credentials stay on the machine:**
- Runner token: stored in `config.json` (mode 0600); agents are denied the data directory (see the threat model)
- Claude token or API key: `secrets/claude.json` (mode 0600; written by the Integrations page and `aom-runner auth`; `config.json` is the fallback)
- Claude credentials: stored in the agent's `CLAUDE_CONFIG_DIR` (mode 0700) as a copy of your `~/.claude/.credentials.json` (or of an additional account's `<configDir>/.credentials.json`; the sandbox denies reading the real file to shell commands; Claude Code itself reads it). Token accounts keep their token in `secrets/claude-accounts/<key>.json` (mode 0600)
- Jira token: stored by `aom-runner jira-connect` in `secrets/jira.json` (mode 0600, directory 0700; an older `jira` block in `config.json` is still read); agents are denied `secrets/` and never see it; only connected / not connected / refused is reported to the server
- Git hosts: the `gh` / `glab` logins, or tokens saved by `aom-runner git-connect` in `secrets/git-tokens.json` (0600); only connected / not connected is reported to the server
- Vault SSH keys: used from machine's SSH agent or keyfiles

- Values typed on the Integrations page travel sealed (see below); `secrets/integration-seen.json` holds the refs of used envelopes (no values); `logs/integrations.jsonl` records who changed what (time, kind, operation, result; no values)

**Nothing leaves the runner:**
- Credentials are never sent to the server
- Vault content stays local (only commits/pushes pushed to origin)
- Session transcripts stay in the agent's sandbox

## Testing and smoke tests

### Test environment check

A tester shift needs something to test against. Two cases:

- **A test environment for the card** (integration tests are on for the project, runner capability `runs:3`): the server starts the card's commit on this workstation before it hands the card to a tester (section "Integration tests by the tester" below). `shift.start` then carries `brief.environment`; the runner checks that environment is `healthy` on this workstation and rejects the shift with `environment_not_ready` / `run_failed` when it is not (the server then asks the DevOps engineer and parks the card). Docker is not checked.
- **No environment** (the project has integration tests off, a runner without `runs:3`, suite and regression cards): as before. Before a tester shift starts, the runner checks that Docker is installed and responsive (`docker info`) and, if `.aom/test-env.json` exists in the repository root, that the app's health endpoint answers with a 2xx.

**`.aom/test-env.json` is retired** (design D12): `{"healthUrl": "http://localhost:3000/health"}` is still read in this version, and a shift that finds the file notes that it is deprecated (the health check now comes from the run plan, Project settings > Run and test). It is ignored from the next version on; the file can be deleted from the repository. It is never required.

**Mock mode** (testing): the card's `fields.mockEnv` field names a problem (`"docker_missing"` or `"app_not_deployed"`). The mock persists the problem in `.aom-runner/mock-state/` until fixed by mock DevOps.

### Unit and integration tests

Run the test suite (uses the in-process fake server):
```sh
pnpm --filter @aom/runner test
```

### Smoke test (real Claude)

Spends tokens; requires Claude credentials:

```sh
export AOM_CLAUDE_SMOKE=1
export CLAUDE_CODE_OAUTH_TOKEN=...       # or `claude setup-token`, or omit for local login
export AOM_CLAUDE_SMOKE_MODEL=haiku      # optional (default opus)
pnpm --filter @aom/runner test:smoke
```

Runs one real builder shift on a toy repo and asserts a handoff was recorded.

## Troubleshooting

### Check runner status and logs

```sh
aom-runner status                         # shows process and connection state
aom-runner doctor                         # checks prerequisites
tail -f ~/.aom-runner/logs/runner.log     # watch runner events
tail -f ~/.aom-runner/logs/shifts/*.jsonl # watch specific shifts
```

### Runner is not connecting

1. Check `aom-runner doctor` output for server connectivity
2. Verify `config.json` has the correct `serverUrl`
3. Check the server is running: `curl https://aom.example.com/api/health`
4. Check the firewall allows WebSocket connections to the server

### The Claude login: expiry, pause and resume

Interactive Claude Code logins (`claude` then `/login`, kept in `~/.claude/.credentials.json`) can expire. Symptom in a
shift log: `Failed to authenticate: OAuth session expired and could not be refreshed` (an error result, 0 tokens).

- **Detection.** The runner recognises such a failure in the stream result, an assistant message flagged as an
  authentication failure, or the stderr of a failed session ("Please run /login", "OAuth refresh token is no longer
  valid", `authentication_error`, 401 `invalid_api_key`). It marks that account `expired` (main, or the additional account
  the shift ran on) and reports it (`runtimes.report`, `accounts[]`; main also in the top-level `auth` field). An expired
  account is unusable: the project's tickets fall back to main or pause, and main-only work pauses only if main itself is out.
- **The failing shift** is returned as `shift.rejected` with the reason `auth_expired`, not as a crash: the card goes back
  to the queue without penalty (not counted by the loop breaker, back-off or the digests), with a note on the card.
- **Notice.** The server raises one desk notice for the workstation's owner and e-mails once: *Claude login expired on
  <workstation>: run `claude` then `/login` on that machine (or `claude setup-token`)*. The Workstations page shows it too.
  (There is no push-notification channel yet; the e-mail is the out-of-app notification.)
- **Probe and resume.** While expired, every 3 minutes (`authProbeMs`) the runner runs `claude auth status --json` and then
  one minimal `claude -p` call (one turn, the smallest model). When it works the runtime is reported available again,
  dispatching resumes and the server closes its notice by itself. The state is kept in `claude-accounts-state.json`, so a
  restart does not forget it. For an additional account (see "Claude accounts") only that account is paused.
- **Why it expired so often, and the fix.** Agents used to get `.credentials.json` as a **symlink** to the machine's file.
  Every agent's Claude Code refreshes the access token on its own and the refresh token rotates, so concurrent agents
  raced each other: an atomic rename by one replaced the link, leaving its refreshed token in an agent directory and the
  others holding a refresh token that was already used. Now each agent session gets a **private copy**, made under a
  runner-wide lock (`claude-credentials.lock` in the data directory). When the machine's access token expires within 10
  minutes, one refresh probe runs under the lock first, so agents start with a fresh token. After the session, a copy whose
  `claudeAiOauth.expiresAt` (or a plugin sign-in in `mcpOAuth`) is newer than the machine's is written back atomically,
  under the same lock; nothing older ever overwrites. The files stay mode 0600, token values are never logged.
- **Most robust: a long-lived token.** Run `claude setup-token` once and set `"authMode": "oauth"` and `"oauthToken"` for
  the runtime (see "Setting credentials"). The token is passed to agents as `CLAUDE_CODE_OAUTH_TOKEN`; no credentials file is
  shared (only the `mcpOAuth` entries of granted servers are copied), so nothing races or rotates. If that token is
  revoked the same detection, pause and resume apply.

### The model usage limit: pause until it resets

A Claude subscription has a session limit (5 hours) and a weekly limit. When one is hit every shift would fail
(`You've hit your session limit · resets 6pm (Africa/Johannesburg)`, `5-hour limit reached ∙ resets 3am`,
`Claude AI usage limit reached|<epoch>`), so the runner pauses instead of failing and retrying.

- **Detection.** On a failed session the runner looks for a limit message in the stream result, in an assistant message flagged as
  an API error, and in the stderr tail. Ordinary text that talks about limits does not count. The reset time is read from the
  message: a named zone (`6pm (Africa/Johannesburg)`) is used as given, a bare `3am` or `18:30` is read in the runner's own
  zone, `Oct 20, 9am` is a date, `|1760000000` is an epoch (seconds or milliseconds). A time that cannot be read means one hour
  from now; the probe below then re-checks.
- **State.** The Claude runtime is reported `usage: limited` with `limitedUntil` (ISO) and `limitedLabel` (the time in the
  machine's zone, for notices) in `runtimes.report`, and as `available: false`. Both are additive; older servers ignore them.
- **The failing shift** returns as `shift.rejected` with the reason `usage_limited` and `limitedUntil`: the card goes back to the
  queue without penalty, with the note *Paused: the model usage limit resets at 18:00 (Africa/Johannesburg)*. It is not a crash:
  no loop-breaker count, no back-off, not in the digests.
- **Server.** The dispatcher dispatches nothing to that runtime until `limitedUntil`. A project whose Claude agents all sit on
  limited workstations shows *Paused until 18:00 (usage limit on <workstation>)* on its board and settings page; work on other
  workstations continues. One desk notice and one e-mail (*Claude usage limit reached on <workstation>; work resumes at ...*),
  closed by the system on recovery. The CEO is woken as information, not as an incident.
- **Probe and resume.** Once `limitedUntil` has passed, the runner (checked every minute, at most every `usageProbeMs`, default
  3 minutes) runs one minimal `claude -p` call (one turn, the smallest model; `claude auth status` shows no limits). Clean: the
  runtime is available again and the server resumes. Still limited: the freshly read time extends the pause. Network trouble: the
  state stays and the probe is tried again. A real session that succeeds (a chat, for example) also ends the pause at once.
- **Chats** that hit the limit answer *The Claude usage limit on this workstation has been reached ... work again at ...* instead
  of an error. The limit is kept in `claude-accounts-state.json` across a restart. Additional accounts have their own limit:
  `aom-runner accounts list` shows each one (see "Claude accounts").


### Shift did not complete

1. Check the shift log in `logs/shifts/<shiftId>.jsonl`
2. If the runner crashed, check `logs/runner.log` for errors
3. If the shift timed out (>1 hour), the card was returned to the queue with the last handoff
4. Check agent permissions and vault access; restart the runner and retry

### "already reported" error

The agent tried to report twice in the same shift. Only one terminal report (handoff, review, test, finalize) is accepted per shift.

### Vault sync conflicts

Sync pauses and a desk item is posted. Resolve the conflict manually:
1. Go to `~/.aom-runner/worktrees/<vault>/` (or wherever the vault is cloned)
2. Resolve the conflict using `git` (e.g., `git status`, `git add`, `git commit`)
3. `git push` to clear the conflict
4. Restart the runner to resume sync

### Agent sandbox is full

Clear old shift logs and agent caches:
```sh
rm -rf ~/.aom-runner/logs/shifts/*.old
rm -rf ~/.aom-runner/agents/*/claude/cache
```

## See also

- `apps/runner/README.md`: quick reference
- `docs/USER-GUIDE.md`: manager features and agent hiring
- `docs/DEPLOY.md`: server deployment
- `docs/BYO-VPS.md`: running agents on a server you rent
- `docs/ARCHITECTURE.md`: technical design and protocol

### R2 session side on the runner (0.1.51)

- **`aom board score --option "<o>" --score 1-5 [--why "<w>"]`** (rpc `board.score`): option scoring for a speaker; the server decides who may call it (speakers of an option-scoring boardroom).
- **Project-repository capabilities** are reported with their `path` (`.claude/skills/<name>`, `.agents/skills/<name>`, `.claude/agents/<name>.md`) for the owner's review list.
- **Blocked list.** `packs.sync` may carry `blocked: [{projectId, kind, key}]`; `CapabilityRegistry.setBlocked` leaves those project-repository capabilities out of every effective view (they are still indexed and reported, so the list shows them). An older server sends none.

### Private endpoints (R2, 0.1.52)

Off by default. The workstation's owner lists exact `host:port` entries (Workstations, your workstation, Model providers, **Private endpoints**); they are kept in `secrets/private-endpoints.json` and reported with the direct-model runtime. The Gemini CLI and opencode egress proxy then lets the sandbox's requests and CONNECTs, and a configured model route, reach those addresses and no others on private networks (loopback for a configured route works as before). Link-local, cloud-metadata and multicast addresses are never reachable, even if listed or if a listed name resolves to one. The direct runtime accepts an OpenAI-compatible endpoint on a private IP address only when it is listed; removing the entry stops the provider from being used. Announces `private-endpoints:1`.

### R3c on the runner (0.1.55)

All additive; an older server never sends the new fields and an older runner ignores them (the server falls back, see below).

- **Reviewed project capabilities.** `packs.sync` may carry `reviewed: [{projectId, kind, key, contentHash}]`: the project-repository skills and personas the owners approved at that content. `CapabilityRegistry.setReviewed` marks every other project-repository entry unusable (listed, with the reason "needs review"); a changed file is unreviewed again. An older server sends none, and the runner then keeps its earlier behaviour (all usable).
- **Reading a pack for review.** `pack.read` may carry `withPinned: true` to return the pinned (previously approved) version beside the working copy, for the diff a reviewer sees. The text goes sealed to the reviewer's browser; the server relays ciphertext.
- **Attempt ids.** `chat.start` for a session turn carries an `attemptId`; the runner echoes it in `chat.delta`, `chat.done`, `chat.error` and in `rpc.request`, so a late reply from an earlier attempt is matched to its attempt and a stale one is ignored. A runner that does not echo it (older than 0.1.55) is treated as before.
- **Native subagent time limit.** A native Claude Code subagent (a granted target offered as a Claude subagent) has the grant's per-call time limit. The `Agent|Task` PreToolUse hook starts the clock (`aom subagent-guard` writes a deadline marker); every other tool call (hook `*`) asks `aom subagent-deadline`, and past the deadline the call is refused with "the time limit of N seconds for this call is over, answer with what you have"; the PostToolUse `Agent|Task` hook (`aom subagent-done`) clears the marker, so the parent is not held back. The limit is per call of the subagent, not a kill: a single long tool call finishes. Checked with the real Claude Code 2.1.309 against a fake API (`claude-subagents-real.test.ts`). Claude Code's own subagent types stay denied for an agent without a grant.
- **Direct-model endpoints.** A base URL's host name is resolved by the runner (`direct/guarded-fetch.ts`, an undici `connect.lookup`) and judged on the address it resolves to: a name that points to a private address is refused unless the owner listed `host:port` under Private endpoints, so DNS cannot be used to reach the internal network.
- **Project packs for a member's session.** A project's approved packs follow a session to its creator's workstation when the member opted in (`pack_assignments`, "follow sessions"); the existing `packs.sync` carries them.
