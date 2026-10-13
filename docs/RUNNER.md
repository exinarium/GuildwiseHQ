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

**Releasing.** The version is `RUNNER_VERSION` in `apps/runner/src/version.ts`, and nothing is "newer" until it is raised: bump it, run `pnpm package:runner`, publish `release/aom-runner-<version>.tgz` to the server's release directory (`AOM_RUNNER_RELEASE_DIR`). Runners pick it up within a day. Pause updates first if you are unsure about a release.

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
- `aom-runner auth api-key` / `aom-runner auth oauth-token` read the value from stdin and store it the same way: `read -rs K; printf %s "$K" | aom-runner auth api-key`, then restart the service.
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
    home/                       HOME for the agent (contains git .gitconfig identity)
    claude/                     CLAUDE_CONFIG_DIR (credentials, memory, cache)
    scratch/                    working directory for the agent's own files
cache/                          package caches shared by all agents of this runner (nuget, npm, pnpm, pip, gradle, maven, ...)
worktrees/
  <PROJECT>-<number>/
    aom/toy-1-...               git worktrees on branch aom/<ref>-<slug>
    aom/toy-2-...
mock-state/                     per-card attempt counters for mock script (test only)
logs/
  runner.log                    JSON Lines log of runner events
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
  - `"default"`: symlink to your `~/.claude/.credentials.json`
- **oauthToken** (optional): from `claude setup-token` (when authMode is `"oauth"`)
- **apiKey** (optional): API key (when authMode is `"api_key"`)
- **intake** (optional, M7): MCP integration for BA intake
  - **mcpConfig**: path to MCP config file with Jira server and credentials
  - **allowedTools** (array): tools the intake chat can use (`mcp__jira`, `WebFetch`, etc.)

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
- **maxConcurrentShifts** (default `4`): max agent shifts this workstation runs at once; a shift offered beyond it is rejected as `busy` and the card waits. The runner announces it in `hello`, the Workstations page shows `running of limit`, and the server caps it at `AOM_MAX_SHIFTS_PER_WORKSTATION` (default 16). Restart the runner after changing it.
- **vaultSyncIntervalSec** (default `300`): how often to pull/commit/push vaults

### Setting credentials

Edit `config.json` manually (mode 0600) or use the pair command with `--mock` flag.

**OAuth token (recommended for Claude Code):**
1. Run `claude setup-token` to get a token
2. Edit `~/.aom-runner/config.json`:
   ```json
   { "runtimes": { "claude-code": { "authMode": "oauth", "oauthToken": "..." } } }
   ```

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

Without a login for the repository's host (or on plain git) finalize with action `pr` falls back to pushing the branch and posting a desk notice for manual PR creation. Finalize with action `merge` first asks the host whether the working branch allows direct pushes; when it is protected (or the push is refused by a branch policy) the runner pushes the card branch and opens a pull request instead, with a desk notice. See the BA's `aom finalize --action <pr|push_branch|merge>` command.

**Rotate runner token** (invalidates old token):
```sh
aom-runner rotate-token    # runner must be stopped
aom-runner start           # restart with new token
```

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
aom question --text "<q>" [--option "<a>"]... [--recommend <n>] [--doing "<x>"] [--non-blocking] [--force]
aom devops "<request>"                                 ask the DevOps engineer
```

Agents must run `aom ledger search` before raising a question: every answer (from the manager, a senior or the BA) is recorded in the ledger once and should never be asked twice. `aom question` also runs a duplicate check and returns matching ledger entries; a non-blocking question that matches needs `--force`.

**Builder/researcher shifts (To do, Rework, Research):**
```sh
aom handoff --note "<text>" [--data-file <json>]       hand the card on
aom question ...                                       ask a blocking question
```

**Reviewer shifts (Review stage):**
```sh
aom review approve --score <1-5> --note "<text>"
aom review changes --reason <r>[,<r>] --score <1-5> [--criteria-missed "<c>"]... --note "<text>"
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
aom finalize --action <pr|push_branch|merge> --note "<why>"  # pr requires `gh`; falls back to push_branch otherwise
aom answer --item <id> --text "<answer>" [--option <id>]
aom escalate --item <id> --note "<what must be decided>"
aom intake map --project <KEY> | aom intake unmapped --note "<why>"
aom repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] [--host <h>] --name <name> --private|--public --project <KEY> [--description "<text>"]   # BA chat and DevOps: asks the project owner; their runner creates it after approval
#   name: owner/repo (github) | group[/subgroup]/project (gitlab) | organization/project/repo (azure-devops) | workspace/repo (bitbucket-cloud)
aom git status [<provider>] | aom git connect <provider> [--host <h>]   # DevOps only: check or start this workstation's git host login
aom git push | fetch | merge-main | verify-merge   # architect only (investigate stages): the runner pushes the card branch, fetches origin, merges the latest main, checks a conflict resolution
aom design --report <path> --summary "<text>"           # architect: hand the designed card to build (outcome handoff)
aom investigate --report <path> --summary "<text>"      # architect: end an investigation-only card (outcome report)
aom investigation record --title "<t>" --summary-file <md> [--decision]   # BA at Finalize of an investigation-only card
aom finalize --action none                              # investigation-only card with the report in the vault: no git step
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

## Adapters: Claude Code and Mock

### Claude Code adapter

Runs the `claude` CLI in a shift, builds the full environment, and streams the output.

**Environment setup** (per shift). The agent process does **not** inherit the runner's environment; it gets an
allow-list (`PATH`, `LANG`/`LC_*`, `TERM`, `TZ`, proxy and CA variables such as `HTTPS_PROXY` and `SSL_CERT_FILE`, and the
few variables Windows needs to start a process) plus:
- `HOME=~/.aom-runner/agents/<agentId>/home`
- `CLAUDE_CONFIG_DIR=~/.aom-runner/agents/<agentId>/claude`
- `GIT_CONFIG_GLOBAL=~/.aom-runner/agents/<agentId>/home/.gitconfig` (with agent name and email)
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

- `agents/<agentId>/home/`: HOME directory with `.gitconfig` identity (name and email)
- `agents/<agentId>/claude/`: CLAUDE_CONFIG_DIR for Claude Code (credentials, auto-memory, caches)
- `agents/<agentId>/scratch/`: working directory for agent's scratch files

All are cleaned up when the agent is fired.

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
`MSBUILDDISABLENODEREUSE=1`, `DOTNET_CLI_USE_MSBUILD_SERVER=0` and `UseSharedCompilation=false`. If the `dotnet` install
is under your home (for example `~/.dotnet`), list it in `runtimes.claude-code.toolchainPaths`. Verified in the real
sandbox (`dotnet new console` and `dotnet build`, with a package from the fallback folder and one downloaded into the
shared cache); `test/sandbox-caches.test.ts` repeats it under bubblewrap and skips when `bwrap` or `dotnet` is missing.

### Git worktrees

Worktrees are created under `worktrees/<KEY>-<project id prefix>/<REF>/` (project keys are only unique per
organization, so the project id keeps two same-keyed projects on one workstation apart) and reused across stages of the
same card. Worktrees created by older runner versions under `worktrees/<KEY>/<REF>` keep working: reuse follows the path
the server recorded for the card. They are removed after finalize (`worktree.remove`), when the card ends without a merge, and by the sweep below.

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
| `sandbox.filesystem.denyRead` | the runner data dir, `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.config/gh`, `~/.config/gcloud`, `~/.claude`, `~/.claude.json` | runner token, Jira and provider credentials, the linked `.credentials.json` |
| `sandbox.filesystem.allowRead` | its worktree, the vault, the `aom` shim and script, the Node install the runner runs on, and `runtimes.claude-code.toolchainPaths` | with the read block on, sandboxed commands lose read access to all of `/home`; this re-opens only what the shift needs (toolchains such as `~/.nvm/...` included) |
| `sandbox.excludedCommands` | `aom`, `aom *`, `<runner>/bin/aom`, `<runner>/bin/aom *` | entries use `Bash(...)` rule syntax, so a bare `aom` would only match `aom` with no arguments; `aom` must run outside because Linux sandboxes cannot connect Unix sockets |
| `sandbox.filesystem.allowWrite` / `denyWrite` | agent `home` + `scratch` + `tmp` + the main repository's `.git` (a linked worktree commits into it) + the runner's shared package caches (`<data dir>/cache`) + `/tmp/.dotnet` on Linux (see "Shared package caches and .NET") / the repository's `.git/hooks` and `.git/config`, the vault, the runner's private files, and the worktree itself for roles with no `edit` tool that may not commit | hooks and git config run outside the sandbox the next time the user uses git |
| `sandbox.network` | `strictAllowlist: true`; `allowedDomains`: package registries and source hosts for roles with `shell` (npm, yarn, PyPI, crates.io, Go proxy, RubyGems, Maven/Gradle, github.com), nothing for others; `allowUnixSockets`: the runner's IPC socket; `allowAllUnixSockets: true` for browser roles only (see below); `allowLocalBinding` for `shell` roles | scouts and researchers reach the web through `WebFetch`/`WebSearch` (permission rules, not the sandbox); builders reach registries from the shell. Add private mirrors with `runtimes.claude-code.extraAllowedDomains` |

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
with `GET /rest/api/2/myself` and saves nothing when Jira refuses them. The token is stored in
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
aom source attachments DCPL-4276                    # name, id, type, size, author, date of every attachment
aom source attachment DCPL-4276 SlideOutHistory.svg # one file, by name or id
aom source attachment DCPL-4276 --all               # every file
```

The runner downloads with its own credentials and writes to `<agent scratch>/attachments/<KEY>/<file>`, then prints the
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

- With the default login (`authMode: default`) the file is already linked into the agent's config dir (a symlink; a copy
  on Windows), so the entry is found as long as the server key and connection are unchanged. The link is kept, not
  narrowed: the file holds the model login whose refresh token Claude Code rotates, and a copy would lose the rotated
  token and sign the owner out. Refreshed MCP tokens are written back through the link as well. (This is the same
  exposure agents already had; the file stays unreadable to the agent's shell by the `~/.claude` read deny.)
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
  `aom git push` (rpc `git.push`) pushes **the card branch only** (`git push -u origin <branch>` with the runner's
  `GitAuth`; any other ref is refused); `aom git fetch` (`git.fetch`) fetches origin; `aom git merge-main`
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

### Read-only roles and path scopes

A role without the `edit` tool that may not commit (reviewer, business analyst, custom read-only roles) gets a
read-only worktree in the sandbox: its worktree path is in `sandbox.filesystem.denyWrite`, while its scratch, temp and
home directories stay writable. A reviewer that needs a build or tests that write caches copies the worktree into its
scratch dir (`rsync -a ./ "$TMPDIR/review/"`) and runs it there; the reviewer instructions say so (role version 2).
The shared package caches stay writable, so a read-only shift can still restore, build and test in its copy.

A read-only worktree used to make **every** shell command of such a role fail with
`bwrap: Can't create file <worktree>/.gitconfig: Read-only file system`. Cause: the runner masked the whole data dir
(`denyRead`), and the worktree lives inside it. When the read-only working directory sits under a masked directory,
bubblewrap tries to create Claude Code's protected dotfiles (`.gitconfig`, `.bashrc`, ...) as mount points inside it,
which a read-only directory refuses (reproduced with the real sandbox; the same read-only directory with no masked
parent works, and a writable worktree is not affected). For a read-only shift the runner now masks the data dir entry by entry
(`denyAround`): everything except the path down to the worktree is still hidden (`config.json`, other agents, other
cards' worktrees), but no parent of the worktree is masked. Worktrees created after the shift started are not hidden
from it (they are made before their own shift begins).
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
- **uncommitted edits in your own checkout** (on the working branch or any other branch): stored on a
  `guildwise/saved-work/<date>` branch (a suffix `-2`, `-3` ... if the name is taken; the same content is never saved
  twice) and pushed with `git push -u origin <branch>`. The commit is built from a throwaway index on top of the
  checkout's current commit (`git commit-tree`), so your files, your index and your branch are untouched and nothing
  reaches the working branch. Files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, names containing
  key, secret, token, password or credential, unless they are source or notes) are skipped and named in a desk notice
  (`saved_work`) that tells you where your work is;
- **on the working branch**: pulls (fast-forward; with unsaved edits in the way it waits instead of rebasing over them;
  a clean tree falls back to a rebase that is aborted on conflict), and pushes what is unpushed;
- **on another branch**: leaves the working tree alone, moves the working branch forward from `origin` and pushes it
  when it is only ahead;
- deletes local `aom/...` branches of finished cards that are merged into the working branch and not checked out in a
  worktree, and runs `git worktree prune`.

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
Commands in a DevOps chat run at once, with no approval step. The decision is deliberate: it is the user's own machine and the
chat is the user talking to their own engineer.

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
  adds to `PATH`; agents in the sandbox read `runtimes.claude-code.toolchainPaths` (add `~/.dotnet` there).

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

## Simulated workstation

A simulation organization (see `docs/ARCHITECTURE.md` section 33) has no workstation of yours. The server pairs one for the Owner and runs a normal runner process on the server itself: mock runtime only (`--mock`, `AOM_RUNNER_MOCK=1`), its own data directory `AOM_SIMULATION_DIR/<org id>/runner`, repo root `.../repos`, and local bare "origin" repositories `.../origin`. The pace is `AOM_MOCK_STEP_MS` (100, 1500 or 5000 ms for fast, normal and slow) and `AOM_MOCK_CHAT_TOKEN_MS`. Chat replies come from `AOM_MOCK_REPLIES_FILE`, a JSON map whose keys are an exact message, a `/regular expression/flags`, or `*` for the default; a value is a reply or a list of replies (`{name}` is the agent, `{message}` the user's text). The same file format is used for the training video. `ANTHROPIC_API_KEY`, `GH_TOKEN` and `GITHUB_TOKEN` are blanked in its environment. It needs `git` and the built runner on the server (`AOM_SIMULATION_RUNNER_BIN`, or the packaged release in `AOM_RUNNER_RELEASE_DIR`, which the server unpacks once).

## Credentials and secrets

**Credentials stay on the machine:**
- Runner token: stored in `config.json` (mode 0600); agents are denied the data directory (see the threat model)
- Claude credentials: stored in agent's `CLAUDE_CONFIG_DIR` (mode 0700) or symlinked to your `~/.claude/.credentials.json` (the sandbox denies reading the real file to shell commands; Claude Code itself reads it)
- Jira token: stored by `aom-runner jira-connect` in `secrets/jira.json` (mode 0600, directory 0700; an older `jira` block in `config.json` is still read); agents are denied `secrets/` and never see it; only connected / not connected / refused is reported to the server
- Git hosts: the `gh` / `glab` logins, or tokens saved by `aom-runner git-connect` in `secrets/git-tokens.json` (0600); only connected / not connected is reported to the server
- Vault SSH keys: used from machine's SSH agent or keyfiles

**Nothing leaves the runner:**
- Credentials are never sent to the server
- Vault content stays local (only commits/pushes pushed to origin)
- Session transcripts stay in the agent's sandbox

## Testing and smoke tests

### Test environment check

Testers need Docker and the application running. Before a tester shift starts, the runner checks:

1. Docker is installed and responsive (`docker info`)
2. If `.aom/test-env.json` exists in the repository root, the app's health endpoint is reachable

**Test environment file** (`.aom/test-env.json`):

```json
{
  "healthUrl": "http://localhost:3000/health"
}
```

The tester's DevOps engineer (or setup job) creates this file once the app is deployed. If the health check fails, the tester shift is blocked with a desk notice; DevOps resolves it.

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
