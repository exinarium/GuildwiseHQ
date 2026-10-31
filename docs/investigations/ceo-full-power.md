# Why the CEO in "full power" still hits permission checks

Date: 2026-10-31. Branch `feat/ceo-full-power`, based on `release/1.4.0` (runner 0.1.64). Fixed in runner 0.1.65.

Owner's complaint: "When talking to the CEO in full power mode the CEO still fails with some permission checks and is not like
talking directly to Claude Code. If things get messy I still need to switch back to Claude Code, as he cannot read runner logs
for example, as if he is still limited even at full power."

## 1. How the CEO chat works

- **Where it runs.** Not as server-side model calls. The Owner's message on the CEO thread becomes a `chat.start` with
  `ceoMode: 'owner'` (`apps/server/src/chat/ceo-turns.ts`, only when the CEO's workstation belongs to the Owner). The runner on that
  workstation starts a real `claude -p` session (`buildClaudeOwnerTurnCommand`, `apps/runner/src/adapters/claude-code.ts`) with the
  Owner's own `~/.claude` (user, project and local settings, skills, plugins, MCP), his real `HOME`, no sandbox. The CEO reaches
  Guildwise through `aom ceo ...` over the runner's local IPC.
- **What "full power" is.** A switch the machine owner holds against any server: `guildwise-runner ceo full-power on` sets
  `ceo.fullPower` in the runner's `config.json`; `hello` then announces the capability `ceo-full-power:1`. The server sets
  `ceoMode` only for a message whose author is the organization Owner now and a workstation that belongs to him
  (`chat/relay.ts`, `ceo-turns.ts`); the runner re-checks CEO agent, opt-in and (order turns) the hash of the Owner's mark
  (`ceo/profile.ts`). Without the opt-in the turn runs restricted and says "Full power is off on this workstation". A second,
  separate full-power use: standing orders the Owner marked (`order` turns), started by a wake's CEO. Wakes are always restricted.
- **Tools.** Everything Claude Code has plus the Owner's MCP servers, plus `aom ceo` verbs (snapshot, show, search, costs, act,
  recommend, notify, task, memory, correction, job, topic, intake, devops, dir) and `aom deploy run|status`.

## 2. Every limit that applied in full power, where it came from, and whether it was meant

| # | Limit | Source | Intended? |
|---|-------|--------|-----------|
| 1 | **Claude Code auto mode.** The turn ran with `--permission-mode auto`. In auto mode a server-side classifier judges each action; its refusal ("Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Interfere With Workloads] / [External System Writes] / [Auto-Mode Bypass] / "judged this action dangerous (it gave no explanation)") is final and does **not** go to `--permission-prompt-tool`, so the Owner is never even asked. | `claude-code.ts` `buildClaudeOwnerTurnCommand`; owner decision 14.1 of `docs/design/ceo-front-door.md` ("every agent runs in auto mode: there is no prompt at a terminal") | The relay was intended; refusing silently was not. **Accidental for the Owner's own chat**: the design (section 3.3) says "the permission mode is whatever his settings say"; the code forced `auto` |
| 2 | **Deny floor names the runner's `logs` and `status.json`.** `floorDenies` denies any Bash command containing `<runner root>/logs*` or `/status.json*`. The root of the Owner's runner here is `~/.aom-runner-guildwise` (`AOM_RUNNER_HOME` of the systemd unit), so `ls ~/.aom-runner-guildwise/logs`, `tail .../logs/runner.log`, `cat .../status.json` are all refused, with only "Permission to use Bash has been denied". | `apps/runner/src/ceo/turn-files.ts` `PRIVATE_ENTRIES` | Logs: **intended as secret protection but too blunt, and with no alternative offered**. `status.json` holds a pid and counters: accidental |
| 3 | **`Bash(systemctl * aom-runner*)`** denied every systemctl verb on the runner unit, including `status`, `cat`, `show`, `is-active`. | `turn-files.ts` `floorDenies` | Stopping the runner from inside the turn is intended (the reply would die; `aom runner restart` exists). Blocking reads was **accidental** |
| 4 | **No tool for the runner's logs or status at all.** Runner logs are local files (`~/.aom-runner*/logs/runner.log`, `logs/shifts/*.jsonl`, `logs/env/*`) and the systemd user journal (`aom-runner-guildwise.service`). The runner uploads no logs to the server (only sanitized errors `runner.error` and shift reports), so the server cannot read them either, and the CEO had no `aom` verb for them. The only path was a raw shell, which items 1 to 3 blocked. | no code; absence | **Accidental gap** |
| 5 | **Server logs and diagnostics.** No verb, no buffer: server logs go to stdout only. | `apps/server/src/app.ts` | Gap |
| 6 | **The permission relay** (desk question "authorize this execution", 10 minute timeout = deny). Only for what auto mode lets through to the prompt tool; every question blocks the chat for up to 10 minutes. | `ceo/permission-relay.ts` | Intended for standing orders and unattended runs. For the Owner who is typing in the chat it is friction, and a second person (Admin) can answer |
| 7 | **Order turns deny at once** and cannot read anything beyond their order. | `permission-relay.ts` mode `order` | **Intended** (nobody watches). Unchanged |
| 8 | **Policy per class** (`evaluatePolicy`): `mode never` and hard-never classes (ceo.policy, org.members, billing, secrets, widening permissions, MCP grants, deleting projects, firing DevOps, raising budgets) deny; `recommend` becomes an inline confirmation card for the Owner (reserved keys, low confidence, mode, desk). But `evidence` ("cite a ledger entry") and `limit` (30 actions an hour, 3 a subject a day, ...) stayed hard recommendations (not inline) even with the Owner in the chat. | `packages/shared/src/ceo/policy.ts` | Never / hard-never: **intended**. Evidence and limits: guards for a CEO acting alone, **accidental for the Owner's turn** |
| 9 | **Vague refusals.** The deny rule says only "Permission to use Bash has been denied"; the policy said "the owner set this action to never". Neither told the model what to use instead or where the owner changes it. | `turn-files.ts`, `policy.ts` | Accidental |
| 10 | The use-the-system hook blocks the first edit inside a managed repo clone once per turn. | `ceo/guard-hook.ts` | Intended (a nudge, `aom ceo job start` opens it). Unchanged |
| 11 | Deny rules on `secrets/**` and `config.json` (Read/Edit) and Bash commands naming the runner's keys, tokens, queued payloads, pairings, sessions. | `turn-files.ts` | **Intended**: tokens must never reach tool output. Kept |
| 12 | `pkill *aom*`, `killall *aom*`, `kill <runner pid>`. | `turn-files.ts` | Intended. Kept |
| 13 | `aom deploy run` only asks Guildwise; the recipe and gate decide, and the brief forbids running deploy scripts, docker or ssh against production by hand. | server + brief | Intended. Kept (prompt-level: a bypass-mode shell could technically run `ssh`, as the Owner's terminal could) |

### Evidence on this machine

Server events: the dev databases here hold no owner-turn refusals (the `aom_proddebug` event store predates owner turns; the
test databases are empty). The runner side does: 120 owner-turn transcripts in `~/.aom-runner-guildwise/logs/shifts/chat-*.jsonl`
with their `ceo-turns/*.commands.log` (all initialised with `permissionMode: "auto"`). They hold 24 refusals:

- 10 by the **auto-mode classifier** (reasons `[Interfere With Workloads]`, `[External System Writes]`, `[Auto-Mode Bypass]`, or "dangerous, no explanation"). 9 of the 10 were for commands that touch nothing on the floor: `aom runner restart`, `aom ceo act cancel-card ...`, `aom ceo act list --dry-run`, `grep` over `~/.claude/projects`, a vitest run against the dev database, `sed` over the repo.
- 14 by **deny rules** ("Permission to use Bash has been denied"), 10 of them commands naming the runner's folder: `ls -la ~/.aom-runner-guildwise/logs`, `cat ... status.json`, `cat ~/.aom-runner-guildwise/config.json`, `journalctl --user -u aom-runner-guildwise ...; systemctl --user cat aom-runner-guildwise.service`. The other four (for example `aom ceo show card GWP-3 2>&1 | head`) were refused by the same rule message with "don't ask mode" in it; I could not tie them to a rule and treat them as the relay or classifier path failing closed. They disappear with the bypass mode (the tool never asks).

This is exactly the owner's example: the CEO tried to look at the runner logs, was refused (item 2 and 3), and reached for the
journal (item 3), and had no other path (item 4).

Verification I could not do: running a real nested `claude` here to prove that deny rules from `--settings` still win under
`bypassPermissions` (the harness of this session refused to start one). It is Claude Code's documented order (deny rules are
checked before the mode); the Owner should confirm once with `aom runner logs` (allowed) versus `cat ~/.aom-runner*/config.json` (blocked)
after updating with `--bypass` (see "Open questions").

## 3. What changed (runner 0.1.65)

1. **Mode.** The default stays `auto` (classifier plus relay) for every install, new and existing. The machine owner can opt in to
   `--permission-mode bypassPermissions` for his own chat with `guildwise-runner ceo full-power on --bypass` (`on --strict` goes back;
   `ceo.ownerPermissions`). It is the most permissive mode and is safe under the rules because: (a) only the Owner can start such
   a turn (server: author must be the Owner now, workstation must be his; runner: his local opt-in), (b) deny rules and the
   `PreToolUse` hook are evaluated before the mode, so the floor still holds, (c) the runner sets
   `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so his shell cannot print the provider credential the runner injected, (d) every Bash command
   is still audited locally (redacted) and its first word reaches the server together with the permission mode, (e) it is the same
   power he has in his own terminal. **Order turns stay `auto` with the relay** whatever the setting says (nobody is watching), as do
   wakes and every other agent. Without `--bypass`, item 1 of the table (classifier refusals) still applies.
2. **Floor.** `status.json` is no longer private. `systemctl` is denied only for `stop|restart|try-restart|reload-or-restart|kill|
   disable|mask|start|reenable|edit|revert`; `status`, `cat`, `show`, `is-active`, `journalctl` work. The runner's keys, config,
   queued payloads, pairings, sessions, raw logs, `pkill *aom*`, `kill <pid>` stay denied.
3. **Clear refusals.** A `PreToolUse` hook on `Bash` (the same `aom ceo guard`) answers a refused command with what was blocked,
   why, and the alternative (`aom runner logs`, `aom runner restart`, `aom ceo diag ...`). Policy refusals say where the owner changes
   them.
4. **Runner and workstation logs and status.** `aom runner status` and `aom runner logs [--kind runner|service|shifts|env|audit]
   [--name f] [--lines N] [--grep t] [--since ..]`, answered by the runner itself in the Owner's turn only
   (`apps/runner/src/ceo/diagnostics.ts`). Output goes through `redactSecrets`, is line- and size-capped, never lists the config.
   For another workstation: `aom ceo diag workstation <name> ...` -> new runner command `runner.diagnostics` (capability
   `ceo-diagnostics:1`, `MIN_RUNNER_FOR_CEO_DIAGNOSTICS = '0.1.65'` in `apps/server/src/ceo/diagnostics.ts`, same pattern as
   `MIN_RUNNER_FOR_SUBMODULE_PIN`); the answer is kept in the new column `runner_commands.result` (migration 2800) until collected.
5. **Server logs and diagnostics.** `aom ceo diag server --kind status|logs`: DB round trip, uptime, memory, connected runners, failed
   runner commands of the last day, the Owner's workstations and whether they can answer; the logs are an in-memory ring of the last
   5000 log lines the app logger tees into (`apps/server/src/diagnostics/log-ring.ts`), masked when read.
   Only while the turn really is a full-power owner turn (CEO workstation owned by the Owner and announcing `ceo-full-power:1`).
6. **Actions the Owner could do in the UI.** In an owner turn an action refused only for lack of a cited ledger entry or a reached
   rate limit is now an inline confirmation card for him (like the reserved matters), not a refusal.
7. **Audit.** `CeoTurnFinished` and `chat.done` gain `permissionMode`; the server also keeps the first words and counts of the commands
   of an owner turn (`commands`, as order turns already did). The local audit file starts with the mode. Every `aom ceo diag` is
   logged by the server with the turn id.

## 4. Deliberately kept

- Secrets: `secrets/`, `config.json`, `keys`, `pairings.json`, `sessions.json`, `outbox`, tokens: Read, Edit and Bash that name them stay
  denied. Logs are readable only through the masking command (raw logs and shift transcripts can contain tokens).
- Stopping, starting or editing the runner service by hand and `pkill`/`kill` of the runner: the turn would die before its reply
  (use `aom runner restart`).
- Hard-never classes (policy, settings, members, security, billing, secrets, widening permissions, MCP grants, deleting projects, firing
  DevOps, raising budgets) and an action the owner set to `never`: they change who can act, what is spent or what is secret, and have
  no undo. The refusal now says so and where the owner does it.
- Order turns, wakes, every other agent, and a CEO on another user's machine: unchanged (tests below).
- Deployments only through the recipe (`aom deploy run`); a production deploy by hand is a brief-level rule only, as in his terminal.

## 5. Tests

- `apps/runner/test/ceo-full-power-diagnostics.test.ts`, `owner-turn-command.test.ts`, `aom-ceo-front-door.test.ts`: mode per turn kind (owner default, strict,
  order never promoted), floor patterns, hook messages, diagnostics (masking, grep, lines, traversal, systemd and fallback), refusals
  in order turns and plain chats, audit.
- `apps/server/test/ceo-diagnostics.test.ts`: server status and logs, wake and order turn refused, full power off refused, the
  remote request/collect flow, version gate, offline, failure, another user's machine, `CeoTurnFinished` audit fields, `LogRing`.
- `packages/shared/test/ceo-policy.test.ts`: owner-only inline for evidence and limit; wake and order verdicts byte-for-byte as
  before; never / hard-never refused in every mode.

## 6. Open questions for the owner

1. Is `--bypass` what you want to run, or should the `auto` default be improved some other way (for example allow-listing the read-only commands the classifier refuses)?
2. The CEO's `aom ceo act` surface is the set of `CEO_ACTIONS`; UI buttons without an action (members, billing, settings, budgets,
   project deletion) stay UI-only by design. Do you want any of them behind an inline confirmation card for your own turns?
3. Confirm once on your machine that deny rules still win in `bypassPermissions` (try `cat ~/.aom-runner-guildwise/config.json` in the CEO chat: it must be refused
   with the new message).
