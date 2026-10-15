# @aom/runner

The Guildwise HQ runner: a small Node process that runs on a workstation, connects out to the server over a WebSocket and runs agent shifts (Claude Code or the token-free mock runtime) inside git worktrees. It ships two binaries:

- `aom-runner`: pair, start, status, doctor, repos.
- `aom`: the command an agent runs inside a shift to read its card and report back (talks to the runner over a local, per-shift-token HTTP endpoint).

Requires Node 22 and git >= 2.40. Design: `docs/ARCHITECTURE.md` sections 11 to 13.

## Build and test

```
pnpm --filter @aom/runner build       # dist/aom-runner.mjs, dist/aom.mjs, dist/mock-agent.mjs (tsup, @aom/shared bundled)
pnpm --filter @aom/runner typecheck
pnpm --filter @aom/runner test        # uses the in-process fake server in test/fake-server.ts
pnpm --filter @aom/runner dev -- --data-dir .dev/runner   # tsx src/cli.ts start (also: pnpm runner:dev at the repo root)
```

From source (dev, vitest) the `aom` shim and the mock agent run through the tsx CLI, so no build is needed. When `dist/` is present next to the running bundle, plain `node dist/aom.mjs` is used.

## Data directory

`--data-dir <path>`, else `$AOM_RUNNER_HOME`, else `~/.aom-runner` (Windows `%LOCALAPPDATA%\aom-runner`).

```
config.json          0600: serverUrl, workstationId, runnerToken, repoRoots[], runtimes{claude-code, mock}, maxConcurrentShifts, ...
status.json          written by `start` (pid, connected, active shifts), read by `status`
outbox/              pending acked messages, one JSON file per message id
bin/aom, bin/aom.cmd shims (prepended to PATH inside shifts)
agents/<agentId>/    home/ (agent HOME + .gitconfig identity), claude/ (CLAUDE_CONFIG_DIR), scratch/
worktrees/<KEY>/<REF>/   git worktrees on branch aom/<ref>-<slug>
mock-state/          per card+stage attempt counters used by the mock script
logs/runner.log, logs/shifts/<shiftId>.jsonl   raw runtime stream per shift
```

## Pairing and starting

1. In the web UI open Workstations, click *Pair workstation* and copy the code `XXXX-XXXX` (valid 10 minutes).
2. On the machine:

```
aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"
aom-runner repos add ~/src            # folders scanned (depth 3) for git repos that have an `origin`
aom-runner start                      # foreground; run it under systemd/launchd/Task Scheduler
```

`pair` writes `config.json` (mode 0600) and keeps existing `repoRoots`/runtime settings when re-pairing. `start` connects, sends `hello` (repos, runtimes, active shifts), heartbeats every 15 s (the server's `welcome.heartbeatSec`), reconnects with full-jitter backoff (1 s up to 30 s) and resends the outbox after every reconnect or process restart. Exit codes: 0 on SIGINT/SIGTERM, 2 if the server rejects the token (re-pair), 3 if another runner connected for the same workstation.

Restart behaviour: running shifts are persisted in `active-shifts/` and resumed (same shift id, same worktree) when the runner starts again, so killing and restarting the runner within the one-hour lease keeps the card claim. The agent process is re-run, not re-attached. `AOM_MOCK_STEP_MS` slows the mock agent's three progress steps (default 100 ms) for UI tests.

Other commands:

```
aom-runner status                     # config summary and whether a runner process is alive
aom-runner doctor                     # node, git >= 2.40, claude, docker, repos, GET /api/health
aom-runner repos add <path> | repos list
```

Enable the mock runtime (CI, development) with `pair --mock`, `start --mock`, `AOM_RUNNER_MOCK=1`, or `"runtimes": {"mock": {"enabled": true}}` in `config.json`. `AOM_RUNNER_MAX_SHIFT_MS` overrides `maxShiftMinutes` (milliseconds; useful to test the `hang` action).

### Claude Code credentials

In `config.json`: `"runtimes": {"claude-code": {"bin": "claude", "authMode": "oauth", "oauthToken": "..."}}` (token from `claude setup-token`), or `"authMode": "api_key", "apiKey": "..."`. With `"default"` (the default) the user's `~/.claude/.credentials.json` is symlinked into each agent's config dir. Credentials never leave the machine.

## The `aom` CLI (inside a shift)

Needs `AOM_IPC_URL` and `AOM_SHIFT_TOKEN` (set by the runner; valid only while the shift runs).

```
aom card [--json]                                   print the card and brief
aom ledger search "<query>" [--scope s]             forwarded to the server (M2)
aom comment --note "<text>" | --note-file <path>    non-terminal thread message
aom handoff --note "<text>"                         builder: outcome "handoff"
aom review approve --score <1-5> --risk low|medium|high --risk-file <md> [--qa-focus "<text>"] --note "<text>"
aom review changes --reason <r>[,<r>] --score <1-5> --risk low|medium|high --risk-file <md> [--criteria-missed "<c>"]... --note "<text>"
aom test pass --evidence "<text>"|--evidence-file <path> [--command "<cmd>"]...
aom test fail --title "<bug>" --note "<text>" [--evidence "<text>"]
aom outcome <id> --note "<text>" [--data-file <json>]   generic form
aom question ...                                    501 until M2 (exit code 2)
```

Exit codes: 0 recorded, 1 error or rejected report (the reason, including post-shift guard violations, is printed and the agent may fix it and report again), 2 not available. Exactly one terminal report is accepted per shift; a second one gets "already reported". Verbs for later milestones (`devops`, `publish`, `digest`, `finalize`, `answer`, `escalate`) print "not available in this version". Adding a verb is one line in the `VERBS` table in `src/aom/aom-cli.ts`.

## Mock script format

The mock adapter runs `mock-agent`, which drives the real `aom` CLI. Behaviour per stage by default: `build` writes `aom-mock/<ref>.txt` and `<ref>.test.txt`, commits, `aom handoff`; `review` approves (score 4); `test` passes; other stages report the first success outcome.

Override with `card.fields.mock` (`MockScriptSchema` in `@aom/shared`): `{ "<stage>": ["<action>", ...] }`, consumed by attempt index (how many shifts of that card and stage ran before; missing entries mean `ok`). Actions:

| action | effect | `shift.ended.outcome` |
| --- | --- | --- |
| `ok` | stage default | `reported` |
| `changes` / `fail` | review: `review changes` (missed_requirement, score 2); test: `test fail`; other stages: first failure outcome | `reported` |
| `question` | calls `aom question` (501 until M2) | `no_report` |
| `crash` | exits 1 immediately | `crashed` |
| `hang` | never exits; stopped at `maxShiftMinutes` | `timeout` |
| `no_report` | does the work, exits 0 without reporting | `no_report` |
| `edit_outside_scope` | writes `aom-mock/outside-scope.txt`, then reports `ok`; a reviewer or tester is stopped by the guard | `no_report` plus `guardViolations` (reviewer: `reviewer_modified_code`) |

Example: `{"review": ["changes", "ok"]}` bounces the first review and approves the second. Emits a progress line every 100 ms and usage `{inputTokens: 1000, outputTokens: 200}`.

## Opt-in Claude smoke test

Spends tokens; skipped unless enabled:

```
export AOM_CLAUDE_SMOKE=1
export CLAUDE_CODE_OAUTH_TOKEN=...       # from `claude setup-token`; omit to reuse ~/.claude login
pnpm --filter @aom/runner test:smoke     # optional: AOM_CLAUDE_SMOKE_MODEL=haiku (default)
```

It runs one real builder shift on a toy repo and asserts that a handoff report was recorded and `hello.txt` exists in the worktree.
