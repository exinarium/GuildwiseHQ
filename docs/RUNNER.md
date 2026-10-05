# Agent Org Manager — Runner Guide

The runner is a Node.js CLI that runs on your workstation, connects to the server over WebSocket, and executes agent shifts. Each shift runs an agent in an isolated git worktree with its own home directory and config.

## Installation and setup

### Requirements

- **Node 22.23** (use `nvm use` or download from https://nodejs.org)
- **Git 2.40 or later** (for worktree support)
- **Docker** (optional; needed for testers to run containers)

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
Description=Agent Org Manager Runner
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

## Data directory structure

The runner stores all data in `~/.aom-runner` (Linux/macOS) or `%LOCALAPPDATA%\aom-runner` (Windows). You can override with `--data-dir <path>` or `AOM_RUNNER_HOME` env var.

```
config.json                     runner config (mode 0600: server URL, token, repos, runtimes)
status.json                     updated by start (process state, connection status)
outbox/                         pending messages (persisted, retried on reconnect)
agents/
  <agentId>/
    home/                       HOME for the agent (contains git .gitconfig identity)
    claude/                     CLAUDE_CONFIG_DIR (credentials, memory, cache)
    scratch/                    working directory for the agent's own files
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
aom-runner doctor             # checks node, git, claude, docker, repos, server
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
- **repoRoots** (array, default `[]`): folders to scan for git repositories (recursively, depth 3)

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

**Jira** (M8 outbox, optional):
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
3. Edit config.json:
   ```json
   { "jira": { "baseUrl": "https://jira.example.com", "email": "you@example.com", "apiToken": "..." } }
   ```

**GitHub setup (for PR creation):**
1. Install the GitHub CLI: `brew install gh` (macOS), `choco install gh` (Windows), apt/dnf (Linux)
2. Authenticate: `gh auth login` (one-time setup)
3. Test: `gh pr list`

The `gh` CLI is required for approved repository setup (`aom repo create`, below): the runner creates the repository with your own `gh` login after you approve it on the desk. It needs a repository root (`aom-runner repos add <path>`; the new clone goes under the first one) and `gh auth login`. The command runs only on the project owner's workstation, with no shell (`gh` and `git` are run directly; `AOM_GH_BIN` overrides the `gh` path), refuses an existing GitHub repository unless it is empty and yours, confines the clone to the repository root and records each request so a retry never creates a second repository.

Otherwise `gh` is optional; if not available, finalize with action `pr` falls back to pushing the branch and posting a desk notice for manual PR creation. See the BA's `aom finalize --action <pr|push_branch|merge>` command.

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
- `3`: another runner connected to the same workstation (only one per workstation)

### Heartbeat and reconnect

- Sends heartbeat every 15 seconds
- Reconnects with full-jitter backoff on disconnect (1 s → 30 s)
- Resends outbox (pending messages) on each reconnect

Shift state is persisted in `active-shifts/` and resumed when the runner restarts, so killing and restarting within the one-hour lease keeps the card claim.

### Status command

```sh
aom-runner status [--data-dir <path>]
```

Shows config summary and whether a runner process is alive (with PID, connection state, active shifts, pending outbox).

### Troubleshooting

```sh
aom-runner doctor [--data-dir <path>]
```

Checks prerequisites and connectivity:
- Node version ≥ 22
- Git version ≥ 2.40
- Claude CLI is available (if using claude-code runtime)
- Docker is available (if testers will run)
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
| `AOM_GH_BIN` | Path to `gh` binary (default `gh`; for GitHub API integration) |
| `AOM_ALLOW_LOCAL_REMOTES` | Set to `1` to accept `file://` and path git remotes (tests only; production refuses them) |
| `AOM_CLAUDE_SMOKE` | Set to `1` to run the real-Claude smoke test (spends tokens) |
| `AOM_CLAUDE_SMOKE_MODEL` | Smoke test model (default `opus`; try `haiku` to save tokens) |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token for Claude Code (from `claude setup-token`) |

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
aom repo create --name <owner/repo> --private|--public --project <KEY> [--description "<text>"]   # BA chat and DevOps: asks the project owner; their runner creates it after approval
aom outbound draft --kind <comment|resolution|decision> --body "<text>"
aom source read --ref <owner/repo#12 | ticket URL>
aom org ...                                            (design chat: draft roles/workflows; role/workflow drafts take --json, --file or --file - too)
```

**Scout/curator shifts (Feed, Digest):**
```sh
aom digest --file <json> [--note "<text>"] | --none
aom handoff --note "<text>"                            (scout: handoff with candidates)
```

**Researcher/checker shifts (Research):**
```sh
aom publish --file <note.md> [--title "<t>"] [--citations-file <json>]
```

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

### Per-agent directories

- `agents/<agentId>/home/`: HOME directory with `.gitconfig` identity (name and email)
- `agents/<agentId>/claude/`: CLAUDE_CONFIG_DIR for Claude Code (credentials, auto-memory, caches)
- `agents/<agentId>/scratch/`: working directory for agent's scratch files

All are cleaned up when the agent is fired.

### Git worktrees

Worktrees are created under `worktrees/<KEY>-<project id prefix>/<REF>/` (project keys are only unique per
organization, so the project id keeps two same-keyed projects on one workstation apart) and reused across stages of the
same card. Worktrees created by older runner versions under `worktrees/<KEY>/<REF>` keep working: reuse follows the path
**Exception: the DevOps engineer.** The workstation's DevOps engineer (the agent with `isDevops`, built-in role `devops`)
runs its shifts outside this sandbox by design, so that it can deploy to the local Docker stack
(`docker compose -p aom-uat ... up -d --build`), to remote hosts (ssh, scp, docker contexts), install tools and use sudo.
See [DevOps shifts are unsandboxed](#devops-shifts-are-unsandboxed).

the server recorded for the card. They are removed after finalize.

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
| `permissions.deny` | `ListAgents`, `SendMessage`, `RemoteTrigger`, `Cron*`, `ScheduleWakeup`, `PushNotification`, `EnterWorktree`/`ExitWorktree` (tools that reach other Claude sessions on the machine or outside the shift; `dontAsk` would otherwise still run them); `Edit, Write, NotebookEdit` when the role has no `edit` tool; `WebFetch, WebSearch` without `web`; `Bash` without `shell`; the role's `deniedShellPatterns` and `git push/rebase/checkout/switch/reset --hard`; `Edit` on the vault, the agent's config dir and the worktree `.git`; `Read` on the runner's `config.json`, `outbox`, `outbound`, `active-shifts`, `vaults.json`, `status.json`, `logs` and on `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.claude`, ... | deny wins over allow in every scope |
| `permissions.blockReadsOutsideWorkingDirectories` | `true` | the Read/Grep/Glob tools only see the worktree (or scratch dir), the agent's scratch dir and the vault (`--add-dir`); other agents' sandboxes and other cards' worktrees are out of reach |
| `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands` | `true`, `true` (`sandbox: "required"`), `false` | Bash runs inside bubblewrap (Linux/WSL2) or Seatbelt (macOS); no `dangerouslyDisableSandbox` retry; no silent fallback to unsandboxed |
| `sandbox.filesystem.denyRead` | the runner data dir, `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.config/gh`, `~/.config/gcloud`, `~/.claude`, `~/.claude.json` | runner token, Jira and provider credentials, the linked `.credentials.json` |
| `sandbox.filesystem.allowRead` | its worktree, the vault, the `aom` shim and script, the Node install the runner runs on, and `runtimes.claude-code.toolchainPaths` | with the read block on, sandboxed commands lose read access to all of `/home`; this re-opens only what the shift needs (toolchains such as `~/.nvm/...` included) |
| `sandbox.excludedCommands` | `aom`, `aom *`, `<runner>/bin/aom`, `<runner>/bin/aom *` | entries use `Bash(...)` rule syntax, so a bare `aom` would only match `aom` with no arguments; `aom` must run outside because Linux sandboxes cannot connect Unix sockets |
| `sandbox.filesystem.allowWrite` / `denyWrite` | agent `home` + `scratch` + the main repository's `.git` (a linked worktree commits into it) / the repository's `.git/hooks` and `.git/config`, the vault, the runner's private files, and the worktree itself for roles with no `edit` tool that may not commit | hooks and git config run outside the sandbox the next time the user uses git |
| `sandbox.network` | `strictAllowlist: true`; `allowedDomains`: package registries and source hosts for roles with `shell` (npm, yarn, PyPI, crates.io, Go proxy, RubyGems, Maven/Gradle, github.com), nothing for others; `allowUnixSockets`: the runner's IPC socket; `allowAllUnixSockets: true` for browser roles only (see below); `allowLocalBinding` for `shell` roles | scouts and researchers reach the web through `WebFetch`/`WebSearch` (permission rules, not the sandbox); builders reach registries from the shell. Add private mirrors with `runtimes.claude-code.extraAllowedDomains` |

Claude Code's sandbox wraps shell commands only; the Read/Edit/Write/WebFetch tools are governed by the permission rules
above, which is why both exist. Chat sessions get the same layer with only `Read, Glob, Grep, Bash(aom:*)` and `Edit(//<scratch>/**)` (Edit covers Write and NotebookEdit; the agent's scratch dir only, so a card's worktree and the vault stay read-only), and `Edit`
denied when a card worktree is in context.

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

### Read-only roles and path scopes

A role without the `edit` tool that may not commit (reviewer, business analyst, custom read-only roles) gets a
read-only worktree in the sandbox: its worktree path is in `sandbox.filesystem.denyWrite`, while its scratch, temp and
home directories stay writable. A reviewer that needs a build or tests that write caches copies the worktree into its
scratch dir (`rsync -a ./ "$TMPDIR/review/"`) and runs it there; the reviewer instructions say so (role version 2).
A role that may not commit (reviewer, scout, ...) is also rolled back after every shift, which stays as the safety net
and is still recorded as a guard violation: `git checkout -f <branch>`,
`git reset --hard <start sha>`, `git clean -fd` inside its worktree. Roles with `writableGlobs` (tester: the project's
E2E globs; writer: documentation; any custom role) may only change matching paths: the post-shift guard reports
`edited_outside_writable_globs` (or the tester/writer rules), and out-of-scope edits are discarded before the shift-end
autocommit.

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
### DevOps shifts are unsandboxed

For a DevOps shift (`agent.isDevops`) `settings.json` has no `sandbox` block, whatever `runtimes.claude-code.sandbox` says
(`required` does not refuse the shift when `bwrap`/`socat` are missing; the runtime's own `unavailable` state still stops
every agent, DevOps included, because the runtime is reported unavailable as a whole). The permissions are:

- allow: `Bash`, `Read`, `Glob`, `Grep`, `Edit` (covers Write), `WebFetch`, `WebSearch`, anywhere on the machine; no
  `blockReadsOutsideWorkingDirectories`; `defaultMode` stays `dontAsk` (no human at the terminal);
- deny: the session tools (`ListAgents`, `SendMessage`, ...), `git push`, the role's shell patterns (`rm -rf /*`), Read and
  Edit of the runner's private files (`config.json`, `outbox`, `outbound`, `active-shifts`, `vaults.json`, `status.json`,
  `logs`, `mock-state`), Read of the user's `~/.claude` and `~/.claude.json`, and Edit of the agent's own Claude config dir.
  The credential-store read denies (`~/.ssh`, `~/.docker`, `~/.kube`, ...) are dropped: it needs them.
- environment: `HOME` is the user's real home (docker, ssh and kube configs work); `CLAUDE_CONFIG_DIR` and `TMPDIR` stay the
  agent's own; `SSH_AUTH_SOCK`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `KUBECONFIG` and `XDG_RUNTIME_DIR` are
  passed through when set; `scrubSubprocessEnv` is not applied. Chat sessions of the same agent stay sandboxed.

What this implies: a DevOps shift has the full privileges of the runner's OS user on that workstation, and root through
`sudo` or the Docker socket (access to `docker.sock` is root). The `devops_access` flags (install, Docker, sudo, paths) and
`aom devops-approval` are guidance in the agent's prompt, not enforcement. The Read/Edit denies above do not stop a shell
command from reading the runner's `config.json` (no sandbox `denyRead` applies), so a prompt-injected DevOps agent can reach
the runner token and every credential of the user. Treat the DevOps agent as you would an admin shell: only hire it on a
workstation you are willing to give it to, keep it to requests from your own cards, and prefer a dedicated runner user and
machine (see the recommendation below).

- Anything outside the sandbox boundary runs with the runner user's rights: Claude Code itself, MCP servers, hooks, and
  any command you add to `sandbox.excludedCommands` yourself.
- Without `scrubSubprocessEnv`, a process of the same user can read `/proc/<pid>/environ` of the runner's other child
  processes (it contains other shifts' IPC tokens and the provider credential).
- The sandbox depends on Claude Code and the OS (bubblewrap/Seatbelt) being correct; the permission rules are matched on
  command text and are not a boundary by themselves.
- A same-user local attacker (outside the agent) can read `config.json` regardless.

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

## Credentials and secrets

**Credentials stay on the machine:**
- Runner token: stored in `config.json` (mode 0600); agents are denied the data directory (see the threat model)
- Claude credentials: stored in agent's `CLAUDE_CONFIG_DIR` (mode 0700) or symlinked to your `~/.claude/.credentials.json` (the sandbox denies reading the real file to shell commands; Claude Code itself reads it)
- Jira token: stored in `config.json` (mode 0600)
- GitHub: uses machine's `gh` login (via `gh auth login`)
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
- `docs/ARCHITECTURE.md`: technical design and protocol
