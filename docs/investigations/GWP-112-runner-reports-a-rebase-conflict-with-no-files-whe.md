# GWP-112: a rebase conflict with no files when the card branch already contains its base

## Question

Before the finalize stage (and before test), the runner brings the card branch up to date with its base branch. On
GWP-27 the card went back to Rework twice with "Rebase onto release/1.4.0 conflicted before the finalize stage ...
(the runner could not list the files)", although the branch head already contained `origin/release/1.4.0`. Why, and
how do we make sure that (a) a branch that already contains its base is a no-op, and (b) a git failure that is not a
conflict is never reported, rendered or routed as one?

## Findings

### 1. Where the GWP-27 message really came from

The text is built in exactly one place: `rebaseConflictText` (`apps/server/src/commands/rebase.ts:7`). It prints
"(the runner could not list the files)" when the file list is empty. It is reached from three server paths, all through
`rebaseConflictEvents`:

| Server path | Trigger from the runner | Stage in the text |
|---|---|---|
| `applyFinalizeResult` (`apps/server/src/commands/finalize.ts:568`) | `finalize.execute` result with `conflict: true` | always `finalize` |
| `applyShiftRejected` (`apps/server/src/commands/shifts.ts:1249`) | `shift.rejected{reason:'rebase_conflict'}` | `card.stage` |
| `applyRunStatus` (`apps/server/src/commands/runs.ts:1141`) | `run.status{state:'failed', rebaseConflictFiles}` | `card.stage` |

None of them checks that the file list is non-empty. A runner that says "conflict" with no files is turned into a
file-less conflict, a `RebaseConflict` event (card to Rework, rework round + 1) and, with a DevOps engineer present, a
conflict attempt (`cardConflictAttemptEvents`), which is where `conflict/GWP-27-a1` came from.

In today's runner the rebase step itself never produces an empty conflict: `rebaseOntoBase`
(`apps/runner/src/git/rebase.ts:42`) already returns `up_to_date` when `merge-base --is-ancestor <target> HEAD` exits 0
(line 51), and throws a plain `Error` (not `RebaseConflictError`) when the rebase or merge fails without unmerged paths
(lines 69 and 79). So the rebase was a no-op on GWP-27, as the card suspected.

The empty conflict came from the **integration merge** of the completion action. Commit `2c6b4688` (2026-10-31,
"finalize reports an already-landed branch as merged and never an empty conflict") says so in its message: before it,
`mergeLocked` (`apps/runner/src/git/completion.ts:249`) returned `{conflict: true, conflictedFiles: []}` when
`git merge --no-ff` in the integration worktree failed for any reason, and `applyFinalizeResult` rendered that as
"Rebase onto release/1.4.0 conflicted before the finalize stage" with no files. That commit fixed the runner side
(a merge failure without files is now a plain finalize failure with git's message) and added the "already landed"
short-cut. The exact git error of that merge was never captured, which is the observability gap this card closes. The
untracked sandbox dotfiles play no part: the integration merge runs in a fresh worktree, and `statusLinesWithoutStubs`
leaves the stubs out of the dirty check.

So the root cause is settled and fixed on the runner, but the system is still fragile:

- The server still turns any `conflict` without files into a conflict, so an older runner (before 0.1.63, or any future
  regression) causes the same loop. Requirement 5 and test plan step 9 need a server-side guard.
- A non-conflict rebase failure is a plain `Error` with free text. It is reported as a generic finalize failure
  ("rebase failed: ..."), a generic run failure, or a `worktree_failed` shift rejection. That is the right route, but it
  carries no base ref, command, exit code or structured stderr, and nothing in the protocol tells the server it was a
  rebase.
- The ancestor check treats every non-zero exit as "not an ancestor". `git merge-base --is-ancestor` exits 1 for "no"
  and 128 for an error (bad ref, broken repo; checked on git 2.x in a scratch repo). A 128 today falls through to a
  rebase that fails with a confusing message.
- A base ref that does not resolve at all (no `origin/<base>`, no local `<base>`) is not caught before the rebase.
- The abort after a failure is unconditional (`git rebase --abort` exits 128 "no rebase in progress" when git refused
  before starting, e.g. on `index.lock`) and its result is ignored. If the abort itself fails, a rebase is left behind
  silently.

### 2. Git behaviour verified in a scratch repository

- `merge-base --is-ancestor`: 0 = ancestor, 1 = not an ancestor, 128 = error (`fatal: Not a valid object name`).
- `git rebase <base>` with a held `index.lock`: exit 1, stderr `Unable to create '<path>/index.lock': File exists ...
  could not detach HEAD`, **no** rebase in progress, no unmerged paths. The runner's `git()` helper retries lock errors
  five times (about 3.9 s) before returning; tests set `lockRetry.delaysMs` to `[]`.
- Untracked, never-tracked files (`.bashrc`, `.claude/`) survive a rebase unchanged and stay untracked. They only stop
  a rebase when the base adds a file at the same path ("untracked working tree files would be overwritten"); that is a
  non-conflict error under this design, never a conflict, and the files are not touched.
- In a linked worktree the lock and rebase state live under the worktree's git dir: use
  `git rev-parse --git-path index.lock` / `--git-path rebase-merge` / `--git-path rebase-apply`, never `<wt>/.git/...`.

### 3. Fetch

`rebaseOntoBase` runs `git fetch -- origin <base>` without the repository's git auth and ignores its result. On a
private HTTPS remote the fetch can fail silently and the step works on a stale `origin/<base>`. That is not part of
this card (the result is "up to date with what we last fetched", never a false conflict), and the shift path fetches
with auth in `ensureWorktree` first. Keep the fetch best-effort; see Follow-ups.

## Options

| | Option | For | Against |
|---|---|---|---|
| A | Server-only guard: treat `conflict` with no files as a failure | Smallest change; closes the old-runner hole | The error still has no base ref, command, exit code or stderr; requirements 3 and 5 not met |
| B | Runner-only: structured `RebaseError`, stricter ancestor check, safe abort | Real cause shows up next time | An older runner (or a regression) still loops cards through Rework |
| C | **Both, with an additive optional `rebaseError` field in the three payloads** | Meets every requirement; works across old/new runner and server in both directions | Touches runner, shared and server (all in this repository, they ship together) |

A new shift reject reason (`rebase_failed`) was considered and rejected: `ShiftRejectReasonSchema` is a `z.enum`, so an
older server would fail to parse the whole `shift.rejected` message and the claim would hang. The existing
`worktree_failed` reason already has the right routing (back-off, rejection-storm desk item, no rework round), so the
runner keeps using it and adds the structured details in a new optional field, which `z.object` strips on an old server.

## Recommendation

Option C.

## Design

### Runner: `apps/runner/src/git/rebase.ts`

1. New error type next to `RebaseConflictError`:

   ```ts
   export interface RebaseErrorInfo {
     baseRef: string;   // the target actually used: origin/<base> or <base>
     command: string;   // e.g. 'git rebase origin/release/1.4.0' (no hardening flags, no auth args)
     exitCode: number;
     stderr: string;    // redactSecrets(...) then trimmed to 2000 chars; stdout when stderr is empty
   }
   export class RebaseError extends Error {
     constructor(readonly info: RebaseErrorInfo) {
       super(`rebase onto ${info.baseRef} failed: ${info.command} exited ${info.exitCode}: ${info.stderr || '(no output)'}`);
     }
   }
   ```

   Redact with `redactSecrets` from `apps/runner/src/secrets/redact.ts` (strips credentials in URLs, tokens, registered
   secrets) before cutting to length. Keep paths exactly as git printed them; add nothing.

2. `RebaseConflictError` must never carry an empty list: make the constructor throw (or assert) when
   `conflictedFiles.length === 0`, so the phrase "(the runner could not list the files)" cannot originate from the
   runner at all.

3. `rebaseOntoBase` flow (same signature and return values `'up_to_date' | 'rebased' | 'merged'`):

   ```ts
   if (!isSafeGitRef(baseBranch)) throw new Error(...)                // unchanged
   if (await hasRemote(wt)) await git(wt, ['fetch', '--', 'origin', baseBranch]);  // unchanged, best effort
   const target = await baseTarget(wt, baseBranch);                   // the one validated ref, used for every step
   if (!(await revParse(wt, target)))
     throw new RebaseError({ baseRef: target, command: `git rev-parse --verify ${target}`, exitCode: 128, stderr: `base ref ${target} not found` });
   const anc = await git(wt, ['merge-base', '--is-ancestor', target, 'HEAD']);
   if (anc.exitCode === 0) return 'up_to_date';                       // no rebase, no identity lookup, head unchanged
   if (anc.exitCode !== 1) throw rebaseError(target, ['merge-base', '--is-ancestor', target, 'HEAD'], anc);
   const renv = await rebaseEnv(wt, commitAs);                        // unchanged; NoCommitIdentityError stays as it is
   ... merge-commit branch / plain rebase as today, then on non-zero exit:
   const files = await unmergedPaths(wt);   // diff --name-only --diff-filter=U; a failing diff counts as "no files"
   await abortInProgress(wt);                // see 4
   if (files.length) throw new RebaseConflictError(files);
   throw rebaseError(target, args, r);
   ```

   The ancestor check is the existing one; the change is that only exit 1 means "go on and rebase". Keep it before
   `rebaseEnv` so an already-based branch never needs a commit identity (that is today's order too).

4. `abortInProgress(wt)`: abort only what is in progress, and verify.
   - rebase in progress when `git rev-parse --git-path rebase-merge` or `rebase-apply` exists: `git rebase --abort`;
   - merge in progress when `git rev-parse -q --verify MERGE_HEAD` succeeds: `git merge --abort`;
   - if the abort fails or the state is still there afterwards, append that to the error (`... ; abort failed: <stderr>`)
     so the owner learns a rebase was left behind. Never `reset --hard`, `clean`, `stash` or `checkout`: untracked
     sandbox files must stay untouched.

   Test that `HEAD` after a conflict or error equals the head before the call (it does today for both, since git
   either never started or `--abort` restores ORIG_HEAD).

5. No other behaviour change: the merge-commit branch (`rev-list --merges`) and the plain rebase stay as they are;
   hardening (`hardenedGitArgs`, `GIT_HARDEN_ENV`, `isSafeGitRef`, `requireCommitIdentity`) is untouched; the command
   string in the report is built from the plain args, not from `hardenedGitArgs`.

### Runner: callers

- `apps/runner/src/git/completion.ts` `executeCompletion` (line 128): add before the generic fallback
  ```ts
  if (err instanceof RebaseError)
    return { ok: false, action, error: err.message, rebaseError: err.info };
  ```
  Never `conflict: true`. `RebaseConflictError` handling stays (files are guaranteed non-empty now).
- `apps/runner/src/runs/manager.ts` `rebaseCardBranch` (line 457): on `RebaseError` set `env.rebaseError = err.info`
  (new optional field on `EnvState`, `apps/runner/src/runs/state.ts:107`) and rethrow
  `new Error(err.message)`; report it in `run.status` next to `rebaseConflictFiles` (`manager.ts:903`).
- `apps/runner/src/shifts/supervisor.ts` (line 1171): on `RebaseError` call
  `this.reject(shiftId, 'worktree_failed', err.message, ...)` with the new `rebaseError` field. Extend `reject`
  (line 859) with an optional `rebaseError` in its extra-fields argument the same way `branchProblem` is passed.
- Re-export `RebaseError` from `apps/runner/src/git/worktrees.ts:386` with the others.
- Bump `RUNNER_VERSION` and add a CHANGELOG line, as for every runner change.

### Shared: `packages/shared`

One reusable schema, optional everywhere (backward compatible: older peers strip or ignore it):

```ts
export const RebaseErrorInfoSchema = z.object({
  baseRef: z.string().max(300),
  command: z.string().max(500),
  exitCode: z.number().int(),
  stderr: z.string().max(2000),
});
```

- `FinalizeResultSchema` (`packages/shared/src/testing/index.ts:136`): `rebaseError: RebaseErrorInfoSchema.optional()`.
- `ShiftRejectedSchema` (`packages/shared/src/protocol/runner.ts:1620`): `rebaseError: RebaseErrorInfoSchema.optional()`
  ("set with reason worktree_failed when the pre-stage rebase failed for a reason other than a conflict").
- `RunStatusSchema` (`packages/shared/src/runs/types.ts:187`): `rebaseError: RebaseErrorInfoSchema.optional()`.
- A pure text helper shared by server and tests (in `apps/server/src/commands/rebase.ts`, or shared if the web needs it):

  ```ts
  export function rebaseErrorText(stage: string, baseBranch: string, e?: RebaseErrorInfo | null, fallback?: string): string
  // "Updating the card branch with release/1.4.0 failed before the finalize stage: `git rebase origin/release/1.4.0` exited 1.
  //  Git said: <stderr>. This is a problem on the workstation, not in the card's code; the card was not sent back to Rework."
  ```
  It must not contain "conflicted" or "could not list the files" (a unit test asserts both). Git's own stderr is
  quoted verbatim, so the helper text itself must avoid those words.

### Server

A conflict is a conflict only when the runner listed files. One helper in `apps/server/src/commands/rebase.ts`:

```ts
export const isRealConflict = (files: readonly string[] | undefined | null) => (files?.length ?? 0) > 0;
```

and `rebaseConflictText` loses its empty-list branch (it is only called with files; keep a defensive fallback that does
not use the old phrase, or throw in development).

- `applyFinalizeResult` (`finalize.ts:568`): the conflict branch becomes `ok && result?.conflict && isRealConflict(result.conflictedFiles)`.
  Everything else falls to the existing `FinalizeFailed` + desk escalation branch (infrastructure route, no
  `RebaseConflict`, no conflict attempt). There the message is
  - `rebaseErrorText('finalize', base, result.rebaseError)` when `result.rebaseError` is set;
  - for `conflict: true` with no files (an old runner): `Finalize (merge) failed: the runner reported a conflict with
    <base> but git listed no conflicting files, so this is not a code conflict. <result.error>`; drop `result.error`
    when it is only "merge conflict in " / "rebase conflict in " with nothing after it;
  - otherwise today's `Finalize (<action>) failed: <message>`.
- `applyShiftRejected` (`shifts.ts:1249`): conflict branch only when `msg.reason === 'rebase_conflict' && isRealConflict(msg.conflictedFiles)`.
  A `rebase_conflict` without files is handled like `worktree_failed` (add it to the back-off list at line 1275, the
  rejection record and the storm check), with the card message from `rebaseErrorText`. A `worktree_failed` that carries
  `rebaseError` uses `rebaseErrorText(card.stage, card.base_branch, msg.rebaseError)` as the thread text instead of the
  generic "Shift rejected by the runner (...)". No `RebaseConflict`, no `cardConflictAttemptEvents`, no rework round.
- `applyRunStatus` (`runs.ts:1141`): `msg.rebaseConflictFiles` becomes `isRealConflict(msg.rebaseConflictFiles)`. A failed
  test run with `rebaseError` (or with an empty `rebaseConflictFiles`) stays on the normal failed-environment route
  (`handleFailedEnvironments`, which reads `last_error` = `msg.error`); additionally post one card message with
  `rebaseErrorText(card.stage, base, msg.rebaseError, msg.error)` so the thread names the base and git's message.
- `cardConflictAttemptEvents` (`conflict-attempts.ts`) is only called from the conflict branches above, so it never sees
  an error. Add a guard at its top (`if (!isRealConflict(files)) return []`) as a second line of defence.

Compatibility matrix:

| Runner | Server | Result |
|---|---|---|
| new (error) | old | `ok:false` with `error` text / `worktree_failed` with detail / failed run: generic failure, never a conflict |
| old (empty conflict) | new | treated as an error (no Rework, no conflict attempt), text says no files were listed |
| new (conflict + files) | any | unchanged conflict flow |
| unknown/extra fields | any | `z.object` strips them; the decision rests on `conflict && files.length`, so anything else is a failure, never a success |

### Docs

Update `docs/ARCHITECTURE.md` 13.6: the ancestor no-op (exit 0 only, 128 is an error), `RebaseError` with base ref,
command, exit code and redacted stderr, the abort-only-what-is-in-progress rule, and that the server treats a conflict
without files as a failure on all three paths. Fix the "(runner 0.1.64)" vs commit `2c6b4688` "0.1.63" mismatch while
there (check `CHANGELOG.md` for which is right).

## Acceptance criteria mapping

| AC | Design | Test |
|---|---|---|
| Already based: success, no `git rebase`, head unchanged | ancestor exit 0 returns `up_to_date` before identity and rebase | runner rebase test 1 (head SHA unchanged, no `rebase-merge`/`rebase-apply`) |
| Same plus untracked dotfiles | no clean/stash/reset anywhere; untracked files never looked at | runner rebase test 2 (`.bashrc`, `.claude/settings.json`, `.mcp.json`, `.gitconfig` still present, content same, `status --porcelain` shows them as `??`) |
| Behind, no overlap: rebase as today | flow unchanged | existing "rebases the card branch onto the fetched working branch" plus test 3 |
| Real conflict: files, abort, server conflict flow | `RebaseConflictError` only with files; `abortInProgress`; server unchanged for files | existing conflict tests in `rebase.test.ts` / `completion.test.ts`; server test 7 |
| Non-conflict failure: error with base ref, command, exit code, stderr; no rebase in progress | `RebaseError`, `abortInProgress` | runner test 5 (held `index.lock` via `--git-path`, `lockRetry.delaysMs = []`), test 5b (ancestor check exit 128 / missing base ref) |
| Thread message: git error + base, no "conflicted"/"could not list the files", not Rework | `rebaseErrorText`, server routing above | server unit test of `rebaseErrorText`; server tests 8 and 9 |
| Phrase cannot be produced without conflicting paths | runner never builds an empty `RebaseConflictError`; server conflict branches require files; empty branch removed from `rebaseConflictText` | `RebaseConflictError([])` throws; `rebaseConflictText` test; server test 9 |
| Both callers (prepare and completion) | `RebaseError` handled in `rebaseCardBranch`, `executeCompletion` and the supervisor | completion test 6 (already-based no-op, index.lock error without `conflict`); manager test with a stubbed `rebaseOntoBase` or real repo asserting `env.rebaseError` and `run.status.rebaseError` |
| New tests for `rebaseOntoBase` and server error handling; suites pass | as listed | `rebase.test.ts`, `completion.test.ts`, server tests |

## Test plan for the builder

Runner (real temporary repos, style of `apps/runner/test/rebase.test.ts`, helpers `makeRepo`, `sh`, `tmp`):

1. Already based: card commit on top of `origin/main`; `rebaseOntoBase` returns `up_to_date`; head unchanged; no
   rebase state dirs.
2. As 1 with `.bashrc`, `.claude/settings.json`, `.mcp.json`, `.gitconfig` written into the worktree; all still there,
   unchanged, untracked.
3. Behind without overlap: existing test; add an assertion that `origin/main` is an ancestor of the new head.
4. Real conflict: existing test; add `RebaseConflictError([])` throws.
5. Lock error: branch behind `origin/main`, create the file at `git rev-parse --git-path index.lock`, set
   `lockRetry.delaysMs = []` (restore in `afterEach`); expect `RebaseError` (not `RebaseConflictError`), `info.baseRef
   === 'origin/main'`, `info.command` starts with `git rebase`, `info.exitCode !== 0`, `info.stderr` mentions
   `index.lock`; head unchanged; no rebase state. Remove the lock afterwards and check a second call rebases.
6. Missing base: remove `origin/main` and local `main` refs (or call with a branch that exists nowhere); expect
   `RebaseError` with the `rev-parse` command.
7. Completion path (`completion.test.ts`): already based and behind-by-nothing: `executeCompletion` merges without
   rebasing; with a held `index.lock` while behind: `ok:false`, no `conflict`, `rebaseError` present, nothing pushed.
8. Manager path: a run start with `rebaseCard` whose rebase hits the lock: `run.status` is `failed` with `rebaseError`
   and no `rebaseConflictFiles` (see `runs-tester.test.ts:133` for the existing conflict case).

Server:

9. Pure unit test (no DB) for `rebaseErrorText` / `isRealConflict` / `rebaseConflictText`: error text names the base and
   git message, contains neither "conflicted" nor "could not list the files"; conflict text keeps today's wording with
   files.
10. `rebase-conflict.test.ts` / `finalize.test.ts` (DB-backed, run by the testers): conflict with files keeps today's
    message and conflict attempt; `worktree_failed` with `rebaseError` and finalize `ok:false` with `rebaseError` show
    the git error, no `RebaseConflict` event, no `ConflictAttemptStarted`, `rework_round` unchanged; an old-format
    `rebase_conflict` / `conflict:true` with no files is handled as an error the same way.

Run unit tests only (`pnpm --filter` the runner and the shared package, plus the server's pure unit file). The DB-backed
server suites need Postgres and go to the testers; say so in the handoff.

## Risks

- **Server test infrastructure**: the server conflict tests use `createWorld` (Postgres); builders cannot run them in
  the sandbox. Mitigated by putting the text and decision logic in pure functions with their own unit test.
- **Lock retry delay in tests**: `git()` retries lock errors for about 3.9 s; forgetting `lockRetry.delaysMs = []` makes
  the test slow, not wrong.
- **Wording**: git's stderr is quoted verbatim. If git ever prints "conflicted" in a non-conflict failure, the AC
  phrase test would still pass because it runs on our own fixtures, but the thread would carry git's word; acceptable.
- **Behaviour change for old runners**: a `rebase_conflict` with no files will no longer send the card to Rework but
  back off and reach the desk after three identical rejections. That is the intended route.
- **Do not** "fix" the fetch by adding auth in this card; it changes network behaviour on all three paths (follow-up).

## Follow-ups (not in this card)

- `rebaseOntoBase` and `alreadyLanded` fetch without the repository's git auth and ignore the result; on private HTTPS
  remotes the step may work on a stale base. Pass the runner's `gitAuth` and log a failed fetch.
- The finalize conflict text says "Rebase onto ... conflicted" even when the conflict came from the integration merge;
  a wording change (`Updating ... with <base>`) would make the thread accurate.
