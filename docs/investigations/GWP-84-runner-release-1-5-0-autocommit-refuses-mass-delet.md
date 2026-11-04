# GWP-84: autoCommit refuses mass deletions and tree reverts and raises a card note

Target branch: `release/1.5.0`. Code read at `release/1.5.0` (72f72c09).

## 1. Question

The shift-end leftovers commit (`autoCommit`, `apps/runner/src/shifts/autocommit.ts`) committed four "Work in progress"
commits on GWP-63 (6927fe2d, 6aa03532, f03d3c55, 7cbbc188). Each one deleted about 86 files (-6723 lines) of release
work. GWP-83 fixes the root cause (`discardOutOfScope` reverting a base-branch merge). This card adds the safety net:
`autoCommit` must never *silently* commit a mass deletion or a revert to an earlier tree. It must refuse, leave the
worktree and index as they are, log a WARN and have the supervisor post a card note.

## 2. Findings

### 2.1 What `autoCommit` does today (release/1.5.0)

```ts
export async function autoCommit(input: AutoCommitInput): Promise<boolean> {
  if (MERGE_HEAD exists) return false;                       // unfinished main merge: never commit half done
  const status = await statusLinesWithoutStubs(worktree);    // sandbox stubs excluded
  if (!status.ok || status.lines.length === 0) return false;
  const stubs = await untrackedSandboxStubs(worktree);
  git add -A -- . :(exclude,top)<stub>...                    // REAL index
  git commit --no-verify -m "[<ticket>: ]Work in progress"
  return c.exitCode === 0;
}
```

There is no check on what is being committed. It returns only a boolean.

### 2.2 Callers (every one checked)

| Caller | Where | Uses the result |
|---|---|---|
| `ShiftSupervisor.run` shift end | supervisor.ts ~l.1530, after `discardTestArtifacts` + `discardOutOfScope` | `committed` decides the short sha in `unreportedWorkNote` |
| `ShiftSupervisor.submit`, investigation outcome | supervisor.ts ~l.2559 | ignored; then `prepareInvestigation` |
| `ShiftSupervisor.submit`, `diffStats` / `buildHandoff` outcome | supervisor.ts ~l.2571 | ignored; then `computeDiffStats` / `computeCardDiff` (measured on HEAD) |
| `test/guard.test.ts` l.174, 176, 264 | | `.toBe(true/false)` |
| `test/sandbox-stubs-guard.test.ts` l.86, 88, 96 | | `.toBe(true/false)` |
| `test/architect-guard.test.ts` l.123 | | ignored |
| `test/supervisor.test.ts` l.96-160 | end to end | commit messages, the unreported-work note |

No other package imports `autoCommit`.

### 2.3 What the GWP-63 commits looked like

The ledger (c9392985, 7a9cade7) records that `git diff 688930c0 7cbbc188` touches only 9 docs files: the stray tree was
the pre-merge tree for every non-doc file **plus the merged docs**. So the stray commits were **not** exact tree reverts.
The rule that would have caught them is the **mass deletion** rule (86 files deleted). The tree-revert rule catches the
pure case (a discard that restores the pre-merge tree exactly, for example when the shift changed no docs). Both are
needed, and the deletion rule is the main protection.

### 2.4 The index constraint

The card says that on refusal "autoCommit leaves the working tree **and index** as they are" and "never runs reset,
checkout or clean". The brief's suggestion (run the check on `git diff --cached` after the real `git add -A`) would
leave the whole pending change *staged* on refusal. Undoing that needs `git reset`, which is forbidden. So the check has
to run **without touching the real index**: on a temporary copy of the index (`GIT_INDEX_FILE`). The `git()` helper
already passes `opts.env` through (`{ ...GIT_HARDEN_ENV, ...opts.env }`, `extendEnv: true`), so no helper change is needed.

## 3. Options compared

| | A. Check after the real `add -A` (brief) | B. Check on a temporary index copy (chosen) | C. Check `git status` porcelain before add |
|---|---|---|---|
| Index untouched on refusal | no (everything staged; undoing it needs `reset`) | **yes** | yes |
| Accurate deletions (renames, stubs, pathspec excludes) | yes | **yes** (same `add -A` pathspec) | weak: porcelain `D` lines also show renames as D+?? untracked |
| Tree for the revert check | `write-tree` | **`write-tree` on the temp index** | must build a tree anyway |
| Cost | none | copy of `.git/worktrees/<wt>/index` (a few MB) + one extra `add -A` | none |

**B** is the only option that meets requirement 2 and the "never reset" AC literally. The copy keeps git's stat cache, so
the second `add -A` is as fast as the first.

Thresholds: runner config keys vs named constants. The card says no new config keys unless needed. The values protect
against a failure mode, not a preference, so **constants** (exported, one place, documented). No config key.

## 4. Recommendation and design

### 4.1 Constants (top of `autocommit.ts`, exported)

```ts
/** A leftovers commit that deletes more tracked files than this is refused (the GWP-63 stray commits deleted 86). */
export const AUTOCOMMIT_MAX_DELETED_FILES = 25;
/** ... or that deletes more than this percentage of the files tracked at HEAD ... */
export const AUTOCOMMIT_MAX_DELETED_PERCENT = 10;
/** ... the percentage rule applies only from this many deleted files, so a small repository can still lose a file or two. */
export const AUTOCOMMIT_PERCENT_MIN_FILES = 5;
/** How many commits behind HEAD (all parents) the tree-revert check compares against. */
export const AUTOCOMMIT_TREE_REVERT_DEPTH = 1000;
```

Rule: refuse as `mass_deletion` when
`deleted > AUTOCOMMIT_MAX_DELETED_FILES || (deleted >= AUTOCOMMIT_PERCENT_MIN_FILES && deleted * 100 > AUTOCOMMIT_MAX_DELETED_PERCENT * tracked)`.

- "more than 25": 25 deletions are committed, 26 are refused.
- In a large repository the file count decides (10% of 3000 files is 300). In a small one (fewer than 250 files) the
  percentage decides. The floor of 5 keeps today's behaviour for tiny repositories and for the existing tests (the
  `makeRepo()` toy repository tracks 2 files: deleting 1 of them is 50%, which must still commit).
- `deleted` counts `D` entries of the staged diff **with rename detection** (`-M`): a move is not a loss, so a refactor
  that renames 40 files still commits. Copies and type changes do not count.
- `tracked` = files at `HEAD` (`git ls-tree -r -z --name-only HEAD`).

### 4.2 Result type (replaces the boolean)

```ts
export type AutoCommitRefusalReason = 'mass_deletion' | 'tree_revert';

export interface AutoCommitRefusal {
  reason: AutoCommitRefusalReason;
  /** Tracked files the pending change removes (renames not counted). */
  deleted: number;
  /** Files tracked at HEAD. */
  tracked: number;
  added: number;
  modified: number;
  /** The deleted paths, at most 30, for the note. */
  deletedPaths: string[];
  /** The tree the commit would have had. */
  tree: string;
  /** tree_revert: the earlier commit whose tree that is. */
  revertsTo?: string;
}

export type AutoCommitResult =
  | { committed: true; sha: string }
  | { committed: false; skipped: 'clean' | 'merge_pending' | 'git_failed'; refused?: undefined }
  | { committed: false; refused: AutoCommitRefusal };
```

`AutoCommitInput` stays as it is.

### 4.3 Algorithm of `autoCommit`

1. `MERGE_HEAD` exists: `{ committed: false, skipped: 'merge_pending' }` (unchanged).
2. `statusLinesWithoutStubs`: not ok or empty: `skipped: 'clean'` (unchanged).
3. `stubs = untrackedSandboxStubs(worktree)`; `pathspec = ['--', '.', ...stubs.map(n => ':(exclude,top)' + n)]` (unchanged, shared by the probe and the real add).
4. No `HEAD` yet (`rev-parse -q --verify HEAD^{commit}` fails, unborn branch): skip the checks and go to step 7.
5. **Probe** (new helper `inspectPending(worktree, pathspec, env)`, all on a temp index, in `try/finally`):
   - `idx = git rev-parse --path-format=absolute --git-path index` (worktree aware); `dir = mkdtemp(os.tmpdir()/aom-autocommit-)`; `tmpIdx = join(dir, 'index')`.
   - when `idx` exists `copyFile(idx, tmpIdx)`, otherwise `git read-tree HEAD` with `GIT_INDEX_FILE=tmpIdx`.
   - with `env = { ...input.env, GIT_INDEX_FILE: tmpIdx }`: `git add -A <pathspec>`; `tree = git write-tree`;
     `git diff --cached -M --name-status -z HEAD` (parse: `D` = deleted, `A` = added, `M`/`T` = modified, `R*`/`C*` = neither);
   - `tracked = count(git ls-tree -r -z --name-only HEAD)`;
   - `tree === HEAD^{tree}`: nothing to commit: `skipped: 'clean'` (today the commit fails and returns false; same outcome);
   - ancestor trees: `git log --skip=1 -n AUTOCOMMIT_TREE_REVERT_DEPTH --format='%H %T' HEAD`, first line whose `%T === tree` gives `revertsTo`;
   - `finally`: `rm(dir, { recursive: true, force: true })`.
   - Any probe git failure: return `skipped: 'git_failed'` (do not commit blind; it is logged by the supervisor like a refusal but without a note). *Builder: if this turns out to be noisy, fall back to committing; but a failed probe in a healthy worktree should not happen.*
6. `revertsTo` set: refuse `tree_revert`. Otherwise the mass rule hits: refuse `mass_deletion`. (Tree revert wins when
   both hold; the note gives the deleted count in both cases.) Return `{ committed: false, refused }`. **Nothing else
   runs**: the real index and the working tree are untouched (no add, reset, checkout, restore, rm, clean, stash).
7. Real `git add -A <pathspec>` and `git commit --no-verify -m msg` exactly as today; `sha = rev-parse HEAD`;
   `{ committed: true, sha }`, or `skipped: 'git_failed'` when add/commit fail (today's `false`).

Race note: the probe and the real add are milliseconds apart. In `run()` the agent process has exited. In `submit()` the
agent is blocked on its report. A change in between is not a realistic risk; no extra re-check is needed.

### 4.4 Note and message text (pure functions in `autocommit.ts`)

```ts
export function describeRefusal(r: AutoCommitRefusal): string
// mass_deletion: "it deletes 86 of 3120 tracked files (the limit is 25 files, or 10% of the tracked files from 5 files on)"
// tree_revert:   "its tree equals the tree of the earlier commit 688930c (it would undo the commits after it); it deletes 86 tracked files"

export function autoCommitRefusedNote(
  r: AutoCommitRefusal,
  opts: { shiftId: string; branch?: string; where: 'shift_end' | 'report' },
): string
```

Note layout (one card note):

```
The runner did not commit the leftovers of shift <shiftId> on <branch> as "Work in progress": <describeRefusal>.
Deleted files (86):
- `apps/server/migrations/2810_journeys.sql`
- ... (at most 30, then "... and N more")
Nothing was reset, restored or deleted: the changes are still uncommitted in the worktree.
Before the next shift, check them: if they are intended, commit them with a message that says why; if not, restore
the files from HEAD. Until then every shift end in this worktree refuses again.
```

`unreportedWorkNote` gets one more option, `refused?: boolean`. When it is set, the "kept" sentence reads: "They are still
uncommitted in the worktree: the runner refused to commit them (see the note on the refused leftovers commit)." Today's
`committed: false` text ("a merge of the main branch is waiting") would be wrong in that case.

### 4.5 Supervisor (`apps/runner/src/shifts/supervisor.ts`)

New field on `ActiveShift`: `autoCommitRefusals: Set<string>` (initialise it where the other per-shift fields are
initialised). New private method used by **all three** call sites:

```ts
private async leftoversCommit(s: ActiveShift, where: 'shift_end' | 'report'): Promise<AutoCommitResult> {
  const r = await autoCommit({ worktree: s.worktree!.path, ticket: ticketOf(s.msg), env: s.env });
  if (r.refused) {
    this.log.warn(
      `refused to auto-commit the leftovers of shift ${s.msg.shiftId} (${r.refused.reason}): ` +
        `${r.refused.deleted} of ${r.refused.tracked} tracked files deleted, ${r.refused.added} added, ` +
        `${r.refused.modified} modified${r.refused.revertsTo ? `, tree of ${r.refused.revertsTo.slice(0, 8)}` : ''}`,
    );
    const key = `${r.refused.reason}:${r.refused.tree}`;
    if (!s.autoCommitRefusals.has(key)) {          // one note per distinct refusal per shift
      s.autoCommitRefusals.add(key);
      await this.submit(s, { kind: 'comment', note: autoCommitRefusedNote(r.refused, {
        shiftId: s.msg.shiftId, branch: s.worktree!.branchName, where }) });
    }
  } else if (!r.committed && r.skipped === 'git_failed') {
    this.log.warn(`could not auto-commit the leftovers of shift ${s.msg.shiftId}`);
  }
  return r;
}
```

(`submit` with `kind: 'comment'` is not terminal and does not run the guard, so calling it from inside `submit` is safe;
the existing unreported-work note already uses it from `run`.)

- **`run()` (~l.1530)**: `const ac = await this.leftoversCommit(s, 'shift_end'); const committed = ac.committed;`
  The sha is `ac.committed ? ac.sha.slice(0, 7)` (or keep the existing `rev-parse --short`). Pass
  `refused: !!ac.refused` to `unreportedWorkNote`. The order is unchanged: after `discardOutOfScope` (GWP-83's version),
  before the delegates and the read-only rollback.
- **`submit()` investigation (~l.2559) and `diffStats`/`buildHandoff` (~l.2571)**: on `ac.refused` **reject the report**
  before `prepareInvestigation` / `computeDiffStats`:
  `return rejected(\`The runner did not commit your pending changes as Work in progress: ${describeRefusal(ac.refused)}. Nothing in the worktree was changed. If the deletion is intended, commit it yourself with a message that says why, then report again. If it is not, restore the files from HEAD and report again. If you did not make these changes, ask with aom question.\`)`
  Why reject: otherwise the handoff goes to build or review measured on a HEAD that does not contain the pending change,
  and the shift-end step refuses again anyway. The agent is still in the shift and can fix it. Deliberate deletions are
  still possible: the agent commits them itself (autoCommit only handles leftovers; the guard still judges the agent's
  commits as today).

### 4.6 Docs

- `docs/ARCHITECTURE.md` §13.7: replace the outdated last sentence ("committed by the runner as `aom: <REF> <stage>
  leftovers (shift <shortId>)`"; the real message is `[<ticket>: ]Work in progress`) and add a paragraph: the leftovers
  commit is refused when it deletes more than 25 tracked files, or more than 10% of the tracked files (from 5 deleted
  files on), renames not counted, or when its tree equals the tree of one of the last 1000 commits behind HEAD. Say where
  the constants are (`AUTOCOMMIT_*` in `apps/runner/src/shifts/autocommit.ts`), that refusal changes nothing in the
  worktree or index, that a WARN is logged and a card note is posted, and that a report needing the commit is rejected.
- `docs/RUNNER.md` "Shifts that end without a report" (~l.1595): one sentence on the refused case and the second note.

### 4.7 Risks

| Risk | Handling |
|---|---|
| A legitimate leftovers change exactly undoes the last commit(s) (for example an agent backs out its own earlier WIP commit) and is refused as `tree_revert` | Safe failure: nothing is lost, the note explains, the agent can commit it itself. This is what requirement 1b asks for. |
| A legitimate large deletion in leftovers (a big cleanup the agent forgot to commit) | Same: refused, noted, the agent or human commits it on purpose. Renames are not counted, so moves are not affected. |
| An uncommitted mass deletion stays in the worktree and the next shift starts with it | Intended: the next shift's agent sees it, and every shift end refuses again and posts a note (dedupe is per shift). This is the alarm, not a loop that destroys work. |
| Temp index in `os.tmpdir()` | The runner runs outside the sandbox. The directory is removed in `finally`. |
| Changing the return type breaks callers | All callers are listed in §2.2. The test changes are mechanical (`.toBe(true)` becomes `.committed === true`). |
| Overlap with GWP-83 in the same `run()` block | Only the `autoCommit` line and the note block change here. See §6. |

## 5. Acceptance criteria to design to tests

| AC | Design | Test (builder) |
|---|---|---|
| A change deleting more than the threshold is not committed; working tree left as is; WARN logged; card note with shift id, deleted count, reason | §4.1 rule, §4.3 steps 5-6, §4.5 `leftoversCommit` (WARN + note) | `autocommit.test.ts`: (1) 40 tracked files, delete 26: `refused.reason === 'mass_deletion'`, `deleted === 26`, HEAD unchanged, the 26 files still absent on disk, `git diff --cached --name-status` the same before and after, `git status --porcelain` shows 26 ` D`. (1b) 300 files, delete 25: committed (boundary). (2) 20 files, delete 5: refused by the percentage rule; the 2-file toy repo, delete 1: committed (floor). Note: `autoCommitRefusedNote(r, { shiftId: 'shift-x', ... })` contains `shift-x`, `26` and `deletes 26 of 40`. `supervisor.test.ts`: the agent commits 30 files itself, deletes them and ends without a report: one refusal note (shift id, `30`), the unreported note says "refused", HEAD is still the agent's commit, the files are absent. |
| A change whose resulting tree equals an ancestor's tree is not committed and raises the same note | §4.3 ancestor walk, `tree_revert` | (3) commit B on A (adds x.ts, edits README); then `git checkout HEAD~1 -- .` and delete x.ts: `refused.reason === 'tree_revert'`, `revertsTo === A`, no commit, the index the same as before the call. |
| A normal change still commits as "Work in progress" exactly as before | §4.3 step 7 unchanged | (4) 3 edits + 2 adds (+1 delete): `committed`, message `DCPL-4276: Work in progress` / `Work in progress`, author from env, status clean, `sha === HEAD`. Rename of 40 files: committed. Existing `guard.test.ts`, `sandbox-stubs-guard.test.ts` and `supervisor.test.ts` cases still pass with the new result shape. |
| Thresholds are named constants in one place and the docs state their values | §4.1, §4.6 | Review; a test can import the constants to build the fixtures (26 = `AUTOCOMMIT_MAX_DELETED_FILES + 1`). |
| The refusal path never runs reset, checkout or clean | §4.3 step 6, temp index (§2.4) | `vi.mock('../src/git/git.ts', ...)` passthrough that records `args[0]` of every `git()` call during a refused `autoCommit`: none of `reset`, `checkout`, `restore`, `clean`, `rm`, `stash`, `commit`, and no `add` without `GIT_INDEX_FILE`. Plus the behaviour checks in (1)/(3): the index and untracked files are unchanged. |
| (Test plan 5) Sandbox stubs are ignored in the count | stubs excluded through the same pathspec in the probe | (5) stubs + 26 deletions: the deleted count is 26 (stubs never counted); stubs + 1 real edit: committed, stubs not in the commit; stubs only: `skipped: 'clean'`. |

Run: `apps/runner` unit tests only (`pnpm --filter <runner package> test`, i.e. `vitest run`), with a hang limit.

## 6. Assumptions about unlanded dependencies (GWP-83)

1. GWP-83 keeps the shift-end order in `ShiftSupervisor.run`: `discardTestArtifacts` → `discardOutOfScope` (now safe, or
   skipped with its own WARN and card note) → `autoCommit`. If it moves or removes the `autoCommit` call, put
   `leftoversCommit` wherever the leftovers commit ends up.
2. GWP-83 does not change `autoCommit`'s signature or return type, and does not add its own deletion check inside
   `autocommit.ts`. If it does, merge the two into the one `AutoCommitResult` above. The constants still live in one place.
3. GWP-83 posts its "discard skipped" card note through `this.submit(s, { kind: 'comment', note })`, the same path as
   here. If it adds a shared note helper, `leftoversCommit` uses it.
4. GWP-83 does not touch the `submit()` call sites (~l.2559, ~l.2571).
5. `discardOutOfScope` (old or new) may stage changes in the real index. The probe copies the real index, so this design
   works either way.

GWP-85 (`snapshotBranches`, `runGuard`) shares no code with this card.

## 7. Files to change

- `apps/runner/src/shifts/autocommit.ts`: constants, `AutoCommitResult` / `AutoCommitRefusal`, `inspectPending`
  (temp index probe), `describeRefusal`, `autoCommitRefusedNote`, the `refused` option of `unreportedWorkNote`.
- `apps/runner/src/shifts/supervisor.ts`: `ActiveShift.autoCommitRefusals`, `leftoversCommit`, the three call sites.
- `apps/runner/test/autocommit.test.ts` (new); updates to `guard.test.ts`, `sandbox-stubs-guard.test.ts` (result
  shape), `supervisor.test.ts` (refusal note case).
- `docs/ARCHITECTURE.md` §13.7, `docs/RUNNER.md` (~l.1595).
- Do not change `guard.ts` (GWP-83 owns it).
