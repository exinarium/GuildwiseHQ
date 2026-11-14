# GWP-223: DevOps guard on release_prep shifts (design)

## 1. The question

Release docs prep (`release_prep`) shifts run on the workstation's DevOps engineer, outside the OS sandbox. The card
says they start without the devops-guard hook and asks for: the hook attached, the release branch protected, no
pre-approved commands, a guard file per session, audit entries tagged with shift id and kind `release_prep`, and a
start that fails closed.

## 2. Findings (checked against the code at `22b3e1fe`)

### 2.1 The premise is out of date: the hook is already attached

GWP-189 (commit `d11ab7a7`) already changed this:

- `apps/runner/src/devops/requests.ts:36-53` `devopsGuardFor(msg)` returns a guard for `kind === 'devops' || kind ===
  'release_prep'` when `msg.agent.isDevops`. Otherwise it returns `undefined`.
- `apps/runner/src/shifts/supervisor.ts:1646` passes it to `adapter.start` (the card's line ~1608 is stale).
- `apps/runner/src/adapters/claude-code.ts:898-899` `startShiftSession` writes the guard file and sets
  `AOM_DEVOPS_GUARD` for any DevOps shift that has `devopsGuard`. `claude-policy.ts:821-831` installs the PreToolUse
  hook (`aom devops-guard`) on Bash.
- `apps/runner/test/devops-guard-for.test.ts` already asserts that release_prep gets the guard.

So requirement 1 and AC1 (hook attached), AC3 (off-workstation refused) and AC4 (deletes outside delete roots refused)
already hold today. This card adds tests that pin them down. It does not need a new kind check.

### 2.2 The release branch is already in the shift start, but only by implication

`apps/server/src/release/docs-prep-tasks.ts:509` sets `brief.project.workingBranch = t.release_branch` for a release
prep shift, so `devopsGuardFor` already puts the release branch into `protectedBranches`. The planning note says it
does not, but that is wrong. Still, it is implicit: nothing in `releasePrep` names the branch, and a future change to the
brief would silently drop the protection. Requirement 3 and the constraints ask for an explicit field and a runner that
rejects a start without it.

### 2.3 "Protected" does not cover what AC5 asks for

`guard.ts:423-462` `gitPush` refuses only a **forced** push or a **delete** of a protected branch. A plain
`git push origin release/1.6.0` is allowed (test row `devops-guard.test.ts:130`). Nothing judges `git reset`,
`git branch -D/-f` or `git update-ref`. AC5 wants push, force-push, reset and delete of the release branch refused.
So a release_prep shift needs a stricter rule than the devops shift's protected branches. Changing what
`protectedBranches` means for devops shifts would break AC8 ("devops shifts behave exactly as before"), so this needs
a new, separate setting (section 4.3).

### 2.4 The guard file is shared and racy

`claude-code.ts:585` writes `<configDir>/devops-guard.json`. `configDir` is `agents/<id>/claude` (or
`claude-acct-<key>`) per agent and account (`sandbox.ts:165-179`). That is the same path for the agent's devops shift,
its release_prep shift and its chat (`chat.ts:1290`, `claude-code.ts:1028`). The hook reads the file again on **every**
Bash command (`aom-cli.ts:2091-2106` → `loadGuardConfig(env.AOM_DEVOPS_GUARD)`). So whichever session started last
decides the approvals and protected branches of all running sessions of that agent. The server lets them overlap:
`releasePrepTaskPass` (`docs-prep-tasks.ts:417-422`) only checks for another open **release_prep** shift of the agent,
not a devops shift or a chat. Example: a release_prep start while a devops shift with an approved `ssh` command is
running drops that approval, and a devops start during a release_prep shift gives the prep shift the devops
approvals. This is the real bug behind requirement 4.

### 2.5 "Guard state"

The devops guard keeps **no state file**: it has only the config file. `readGuardState`/`writeGuardState` belong to
the CEO guard (`apps/runner/src/ceo/guard-hook.ts`, a per-turn dir that is already separate). For this card, "own guard
file and state" means the config file only.

### 2.6 Audit entries cannot tell a release_prep shift apart

`DevopsAuditEntrySchema` (`packages/shared/src/protocol/runner.ts:1840-1849`) has `sessionRef` (the shift id, already
there) and `kind: 'shift' | 'chat'`. The server table `devops_audit`
(`apps/server/migrations/2180_runner_telemetry.sql:33-42`) has `CHECK (kind IN ('shift','chat'))`. A release_prep
command is logged as `kind: 'shift'`.

### 2.7 Fail closed

- Other runtimes already refuse a start that has `devopsGuard` (`codex.ts:1305`, `opencode.ts:555`, `gemini.ts:1047`).
- In Claude Code, `devopsGuard()` returns `undefined` when `this.paths` is unset, and the session then starts
  **without** a hook (`claude-code.ts:573`, `898`). A `writeFileSync` error throws, and `startFailed` turns it into a
  `shift.rejected` (`supervisor.ts:1952-1959`), which is fine.
- `supervisor.ts:1158-1163` rejects a release_prep start only when `releasePrep` is missing.

### 2.8 Can a non-DevOps agent run release_prep?

Not through the server. `PREP_TASK_KINDS` (`packages/shared/src/release/docs-prep-task.ts:198-228`) lists `roles:
['devops']` for every task kind, and the only chooser (`docs-prep-tasks.ts:342`) filters `a.is_devops`. The runner
still accepts such a start, and `devopsGuardFor` returns `undefined` for it, which is today's behaviour. Requirement 6:
the case does not exist in practice. This design leaves it unchanged (no guard, sandboxed like any non-DevOps agent).

### 2.9 Approved commands

`approvedCommands = msg.devops?.approval?.commands ?? []` is already empty for release_prep, because a release_prep
start has no `devops` block. The design makes this explicit, so a later change to the devops block cannot leak
approvals into release_prep.

### 2.10 The release_prep checkout

`addPrepTaskWorktree` (`apps/runner/src/git/release-prep-task.ts:30-44`) adds a **detached** worktree at the work ref
(`refs/guildwise/docs-prep/<run>/work`). The agent may commit there (`changedFiles` counts commits since base). It never
needs to push, check out the release branch, reset a branch or delete one. So a strict release-branch rule blocks no
legitimate docs-prep work (requirement 2's exception clause: no exception needed).

## 3. Options

| Topic | Option | Verdict |
|---|---|---|
| Guard file | A. One file per session in a subfolder of the config dir: `<configDir>/devops-guard/<kind>-<ref>.json`, for **all** sessions (devops shift, release_prep shift, chat) | **Chosen.** It stays under the existing `Edit(<configDir>/**)` deny (same protection as today), it removes the race for devops shifts and chats too, and the hook needs no change (it already reads the path from its own env). |
| | B. Per-session files only for release_prep; devops and chat keep `devops-guard.json` | Rejected: a devops shift and a DevOps chat would still share one file (requirement 4: "two sessions must never share one file"). |
| | C. Files under a runner-private dir (`logs/`) | Rejected: it changes the protection model (the card asks for "the same way as today") and gains little, since the DevOps engineer runs unsandboxed and `logs/` is a delete root as well. |
| Audit tag | A. Optional new field `shiftKind: 'devops' \| 'release_prep'` on the entry, `kind` stays `'shift'` | **Chosen.** Additive. The protocol schemas are non-strict, so an older server strips the field and still records the entry. The `kind` CHECK stays valid. |
| | B. Add `'release_prep'` to the `kind` enum | Rejected: an older server rejects the whole batch (enum mismatch), and it mixes "session type" with "shift kind". |
| Release branch rule | A. New guard setting `frozenBranches` (release_prep only): no push of any kind, no delete, no reset, no `branch -f/-m`, no `update-ref`, no checkout of the branch | **Chosen.** It meets AC5 and leaves devops shifts unchanged (empty list). |
| | B. Make `protectedBranches` refuse plain pushes for everyone | Rejected: it changes devops shifts (AC8). |
| | C. Refuse every `git push` in a release_prep shift | Simpler but broader than the card asks for. Option A already refuses every ambiguous push (no refspec, `HEAD`, `--all/--mirror`), so in practice only a push that explicitly names another branch is allowed. |
| Branch in the start | A. Explicit `releasePrep.releaseBranch` (optional in the schema), required by the runner | **Chosen** (requirement 3). It is optional in zod so that a new runner meeting an old server rejects the shift cleanly through `shift.rejected` instead of failing the whole message parse. |

## 4. Design

### 4.1 Shared (`packages/shared`)

1. `src/release/docs-prep-task.ts` `ReleasePrepShiftSchema`: add
   ```ts
   /** The release branch this prep belongs to: protected (frozen) for the shift's DevOps guard. */
   releaseBranch: z.string().trim().min(1).max(200).optional(),
   ```
   (optional so a start from an older server parses and is then rejected by the runner, see 4.4).
2. `src/protocol/runner.ts` `DevopsAuditEntrySchema`: add
   ```ts
   /** For a shift: which kind (a DevOps request or a release prep task). Absent for chats and older runners. */
   shiftKind: z.enum(['devops', 'release_prep']).optional(),
   ```

### 4.2 Server (`apps/server`)

1. `src/release/docs-prep-tasks.ts` `buildReleasePrepShiftStart` (~line 538): add `releaseBranch: t.release_branch`
   to `releasePrep` (the column is `NOT NULL`, migration 2830). Keep `brief.project.workingBranch` as it is.
2. New migration `migrations/2970_devops_audit_shift_kind.sql` (next free number after 2960):
   ```sql
   ALTER TABLE devops_audit ADD COLUMN IF NOT EXISTS shift_kind text
     CHECK (shift_kind IS NULL OR shift_kind IN ('devops', 'release_prep'));
   ```
3. `src/commands/runner-telemetry.ts` `applyDevopsAudit`: insert `e.shiftKind ?? null` into `shift_kind`.
   `listDevopsAudit`: select `shift_kind` as well (the platform route `/api/platform/devops-audit` returns it unchanged).

### 4.3 Runner guard (`apps/runner/src/devops/guard.ts`)

1. `GuardConfig`:
   ```ts
   /** For a shift: its kind, copied into every audit entry. */
   shiftKind?: 'devops' | 'release_prep';
   /** Branches this session may not change at all (release prep: the release branch). Empty for devops shifts and chats. */
   frozenBranches?: string[];
   ```
   `defaultGuardConfig` sets `frozenBranches: []`. `loadGuardConfig` stays as it is (it already fails closed).
2. `auditEntry`: add `...(cfg.shiftKind ? { shiftKind: cfg.shiftKind } : {})` (widen the `Pick` to include
   `shiftKind`). `appendAuditFile` and `recordDevopsAudit` (`devops/audit.ts`) need no change: they validate with
   the shared schema, which now carries the field.
3. New rule `frozen_branch`, judged in `judgeSegment` next to `gitPush`, only when `cfg.frozenBranches?.length`.
   Parse the git global options the same way `gitPush` does (factor out a `gitSubcommand(words)` helper returning
   `{ sub, args, dirArg }`). Refuse when:
   - **push** (forced or not): `--all`, `--mirror` or `--prune`; no refspec; a destination of `HEAD` or empty; or a
     destination (after `:` and with `+` and `refs/heads/` removed) in `frozenBranches`. A delete (`--delete`/`-d`,
     `:<b>`) of a frozen branch is covered by the same destination check.
   - **branch**: any of `-d -D --delete -f --force -m -M --move -c -C --copy` together with a positional arg in
     `frozenBranches` (either side of a move or copy).
   - **update-ref**: an argument equal to `refs/heads/<frozen>` or `<frozen>`.
   - **checkout / switch**: the first non-option positional is a frozen branch, and the command does not create a new
     branch (`-b/-B/-c/-C/--orphan` with a different name is fine; `git checkout <frozen> -- <paths>` and
     `git checkout -- <paths>` only read the branch and are allowed).
   - **worktree add**: a positional equal to a frozen branch (it would check it out).
   - **reset** with a mode flag (`--hard --soft --mixed --keep --merge`) or a commit argument, and **commit, merge,
     rebase, pull, cherry-pick, revert, am**, when the branch checked out in the target dir is frozen. The target dir is
     `here.cwd` (with `cd` already tracked by `judgeLine`), or `-C <dir>` resolved against it. `--git-dir`/`--work-tree`
     or an unresolvable dir counts as unknown, and unknown is refused (fail closed). `git reset -- <paths>` and
     `git reset HEAD <paths>` (paths only, after `--`) are allowed.

   The checked-out branch comes from a new optional dependency, which keeps `classifyCommand` pure for tests:
   ```ts
   export interface GuardDeps { headBranch?: (dir: string) => string | null | 'unknown' }
   export function classifyCommand(command, cfg, cwd, deps: GuardDeps = {}): GuardVerdict
   ```
   `null` means detached (or not a repo): allowed. A missing `deps.headBranch` with non-empty `frozenBranches` counts
   as `'unknown'`, so those branch-moving commands are refused. Thread `deps` through `judgeLine` and `judgeSegment`
   via `Ctx`. `runGuardHook` gets `deps?: GuardDeps` and passes it on.

   Refusal message (one constant, used by every case above):
   `Branch "<b>" is the release branch of this release prep and may not be pushed, reset, moved, checked out or deleted here. Release prep never pushes: write your files and finish with \`aom prep done\`.`
   Devops shifts and chats have `frozenBranches: []`, so no new code path runs for them.
4. `apps/runner/src/aom/aom-cli.ts` `'devops-guard'`: pass
   `deps: { headBranch }`, where `headBranch(dir)` runs `git -C <dir> symbolic-ref -q --short HEAD` synchronously
   (`spawnSync`, timeout 3 s, the hook's own limit is 20 s). Exit 0 gives the trimmed stdout. Exit 1 (detached) or
   "not a git repository" gives `null`. A missing dir, a timeout or any other error gives `'unknown'`. Only call it
   when the config has frozen branches (the rule only asks then), so devops and chat hooks never spawn git.

### 4.4 Runner start (`requests.ts`, `supervisor.ts`)

1. `devopsGuardFor(msg)`: keep the existing devops branch as it is, byte for byte. Add a separate release_prep branch:
   ```ts
   if (msg.kind === 'release_prep') {
     const branch = msg.releasePrep?.releaseBranch?.trim();
     if (!branch) return undefined;             // the supervisor rejects before it gets here
     return { sessionRef: msg.shiftId, shiftKind: 'release_prep', protectedBranches: [branch],
              frozenBranches: [branch], approvedCommands: [] };
   }
   return { sessionRef: msg.shiftId, shiftKind: 'devops', protectedBranches: [...as today], approvedCommands: ..., readOnlyScan? };
   ```
   `DevopsGuardInput` (`adapters/types.ts:54`) gains `shiftKind?` and `frozenBranches?`. Note: the devops result now
   also carries `shiftKind: 'devops'`, so the existing `toEqual` test needs that field added. That is the only
   expected test change.
   Also export `const guardedShift = (msg) => msg.agent.isDevops && (msg.kind === 'devops' || msg.kind ===
   'release_prep')`. It is the one shift-kind decision for tests and for the check below.
2. `supervisor.ts:1158` release_prep branch, right after the `!rp` check and **before** `addPrepTaskWorktree`:
   ```ts
   if (msg.agent.isDevops && !rp.releaseBranch?.trim()) {
     this.reject(msg.shiftId, 'internal', 'a release prep shift without its release branch: the DevOps guard cannot protect it, so the shift does not start');
     return;
   }
   ```
3. At `supervisor.ts:1646`, compute `const guard = devopsGuardFor(msg)` once (today it is called twice). If
   `guardedShift(msg) && !guard`, reject with `'internal'`, `'the DevOps guard could not be configured for this shift'`.
   Belt and braces: 4.4.2 already covers the only real cause.

### 4.5 Runner adapter (`apps/runner/src/adapters/claude-code.ts`)

1. New exported helper (unit-testable):
   ```ts
   export const GUARD_DIR = 'devops-guard';
   export function guardFileFor(configDir: string, kind: 'shift' | 'chat', sessionRef: string): string {
     const safe = /^[A-Za-z0-9-]{1,80}$/.test(sessionRef)
       ? sessionRef : createHash('sha256').update(sessionRef).digest('hex').slice(0, 32);
     return join(configDir, GUARD_DIR, `${kind}-${safe}.json`);
   }
   ```
2. `devopsGuard(configDir, guard, kind)`: write to `guardFileFor(...)` (create the `devops-guard` dir mode 0700,
   file mode 0600, as today). Copy `shiftKind` and `frozenBranches` into `GuardConfig`. Before writing, prune the
   folder: remove `*.json` older than 24 h, and remove the legacy `<configDir>/devops-guard.json` when it is older than
   24 h. A running session always has a freshly written file, and a pruned file would fail closed anyway
   (`loadGuardConfig` falls back to the deny-most defaults). Wrap the prune in try/catch; a prune failure must not stop a
   start.
3. `startShiftSession`: after `const guard = ...`, add the fail-closed check:
   ```ts
   if (input.agent.isDevops && input.kind === 'release_prep' && !guard)
     throw new Error('the DevOps guard could not be attached to this release prep shift (no guard settings or no runner paths)');
   ```
   `start()`'s catch already rethrows, and the supervisor's `startFailed` turns it into
   `shift.rejected('internal', 'Shift could not start: ...')`. Devops shifts keep today's behaviour (see 6, risk 3).
4. Cleanup: remove the session's guard file when the session ends. Add `rmSync(guard.file, { force: true })` to the
   `onExit` `finally` of `startShiftSession` (line ~980). In `startChatSession` the `onExit` wrapper is only added for
   `bk || releaseRepo` (line ~1100); extend that condition to `bk || releaseRepo || guard` and remove the file there.
   Also remove it in the `catch` of `start()`/`startChat()` (compute the path with `guardFileFor` from
   `input.sandbox.configDir`, `'shift'|'chat'`, `input.devopsGuard?.sessionRef`), so a start that fails after the write
   leaves nothing behind.
5. Nothing else moves: `AOM_DEVOPS_GUARD` still points at the file, the hook command is unchanged, and the
   `Edit(<configDir>/**)` deny (`claude-policy.ts:789`) covers the new subfolder.

### 4.6 Data flow after the change

server `buildReleasePrepShiftStart` (+`releaseBranch`) → runner supervisor (rejects without branch) →
`devopsGuardFor` (release_prep variant) → `ClaudeCodeAdapter.devopsGuard` writes
`<configDir>/devops-guard/shift-<shiftId>.json` → env `AOM_DEVOPS_GUARD` → hook `aom devops-guard` →
`classifyCommand` (+frozen rule, headBranch dep) → `auditEntry` (`sessionRef` = shift id, `kind: 'shift'`,
`shiftKind: 'release_prep'`) → `devops.audit` rpc → `logs/devops-audit.jsonl` + server `devops_audit.shift_kind`.

## 5. Acceptance criteria mapping

| AC | Design | Test |
|---|---|---|
| 1 Hook attached, guard decision on first Bash | Already true (2.1). 4.4.1 keeps it, and 4.5.2 writes the per-shift file | adapter test: release_prep start writes `settings.json` with the PreToolUse hook and sets `AOM_DEVOPS_GUARD` to the shift's file; `runGuardHook` on that file returns a verdict and an audit entry |
| 2 Audit tagged with shift id and `release_prep` | 4.1.2, 4.3.2, 4.2.2-3 | guard test: `auditEntry` carries `sessionRef` = shift id and `shiftKind: 'release_prep'`; server test: `applyDevopsAudit` stores `shift_kind` |
| 3 Off-workstation refused, same message | Unchanged rule, same `offWorkstation` text (`kind` is still `'shift'`) | hook test with the release_prep config: `ssh other-host` and `scp f host:` give `off_workstation`, and the reason equals the devops-shift reason |
| 4 Delete outside delete roots refused | Same `deleteRootsFor` (4.5.2 does not change it) | hook test: `rm -rf /home/x/elsewhere` gives a refusal |
| 5 Push/force-push/reset/delete of release branch refused | 4.3.3 `frozen_branch` plus the existing `force_push_protected` | classifier table: `git push origin release/1.6.0`, `git push -f origin release/1.6.0`, `git push origin :release/1.6.0`, `git push`, `git push origin HEAD`, `git branch -D release/1.6.0`, `git update-ref -d refs/heads/release/1.6.0`, `git checkout release/1.6.0`, and `git reset --hard X` with `headBranch → 'release/1.6.0'` and with `'unknown'` are all refused. Allowed: `git status`, `git commit -m x` and `git reset --hard X` with `headBranch → null`, `git checkout -- docs/a.md`, `pnpm build` |
| 6 No pre-approved commands | 4.4.1 `approvedCommands: []`, explicitly | `devopsGuardFor` for release_prep with a stray `devops.approval.commands` in the msg still returns `[]`; hook: `ssh x` is refused even when the devops shift had it approved |
| 7 Separate files for concurrent sessions | 4.5.1-2 | adapter test: a release_prep shift and a devops shift (and a chat) of one agent write three different paths, each holding its own `protectedBranches`/`approvedCommands`/`frozenBranches`; starting the second does not change the first file |
| 8 Devops shifts and chats unchanged apart from the file path | devops branch of `devopsGuardFor` unchanged (+`shiftKind: 'devops'` audit tag only), `frozenBranches` empty | existing `devops-guard.test.ts`, `guard.test.ts` and `claude-args.test.ts` pass unchanged; new: a devops config gets no `frozen_branch` refusals (`git push origin dev-working` is still allowed) |
| 9 Missing branch or guard file: rejected with a reason | 4.4.2 (branch), 4.4.3 and 4.5.3 (guard), write error → `startFailed` | supervisor test: release_prep start without `releaseBranch` sends `shift.rejected` naming the release branch and no adapter start; adapter test: release_prep on an adapter without paths throws, and a guard dir that cannot be written throws |
| 10 Unit tests; runner and server suites pass | sections above | `guardedShift` table (devops and release_prep on a DevOps agent: yes; card/question/ba_task/ceo and a non-DevOps release_prep: no), `devopsGuardFor` release_prep settings, `guardFileFor` path; server `buildReleasePrepShiftStart` includes `releaseBranch` (needs a DB-backed test next to the existing release docs prep tests, or a test of the payload builder) |

## 6. Risks and notes

1. **Version skew.** New runner with an old server: release_prep is rejected ("without its release branch") until the
   server is deployed. The server ships first as usual, so this is the intended fail-closed behaviour. Old runner with
   a new server: the field is stripped and nothing changes. New runner audit to an old server: `shiftKind` is stripped
   and the entry is still stored. Release the server change (field + migration) no later than the runner.
2. **Upgrade.** The legacy `devops-guard.json` is only removed once it is over 24 h old, so a session that survives a
   runner restart keeps working.
3. **Devops shifts are not made fail-closed here.** In production `this.paths` is always set, so a devops shift always
   gets its guard. Making a missing guard a start error for devops shifts too is stricter, but outside "behave exactly as
   before". I suggest it as a follow-up.
4. **`settings.json` is also shared per agent and account.** Concurrent sessions of one agent overwrite
   `<configDir>/settings.json`. Claude Code reads it at start and may reload it. For the DevOps engineer the hook entry
   is identical in every session, so the guard is not weakened, but other policy lines may differ. This is outside this
   card; I suggest it as a follow-up.
5. **The guard is a guardrail, not a boundary** (`guard.ts:17-19`). An unsandboxed agent can still get around it with a
   script. That is unchanged.
6. **`headBranch` cost.** It runs one `git symbolic-ref` per branch-moving git command, and only in release_prep
   sessions. That is negligible.
7. **Size.** About 300-400 changed lines over shared, server (incl. migration), runner guard, adapter, supervisor and
   tests. Recorded as large.

## 7. Recommendation

Build sections 4.1-4.5 as one change. Do not add a new shift-kind check (it exists). The real work is: the per-session
guard file for every DevOps session, the explicit release branch with a fail-closed reject, the `frozenBranches` rule
that makes AC5 true, and the `shiftKind` audit tag with its server column.
