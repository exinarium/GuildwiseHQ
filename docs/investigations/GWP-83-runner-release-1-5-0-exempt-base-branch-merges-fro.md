# Exempt base-branch merges from the architect guard; make the out-of-scope discard never revert legitimate work

Target: `release/1.5.0` (the card branch is cut from `origin/release/1.5.0`, 72f72c09).
Area: `apps/runner` (`src/shifts/guard.ts`, `src/shifts/supervisor.ts`), tests in `apps/runner/test/`, docs
`docs/ARCHITECTURE.md` 13.7 and `docs/RUNNER.md` ("The architect: organization source folder, git and the main merge").

## 1. Question

Four "Work in progress" commits on the GWP-63 card branch (6927fe2d, 6aa03532, f03d3c55, 7cbbc188) each deleted about
86 files (-6723 lines) of release/1.5.0 work. Why does the shift-end discard plus auto-commit revert a base-branch merge,
and how do we stop it without weakening the guard for real out-of-scope edits?

## 2. Findings

### 2.1 What happened (confirmed against the repository)

The worktree reflog (`.git/worktrees/GWP-63/logs/HEAD`) and the objects show:

| time (UTC) | HEAD move | who |
|---|---|---|
| 06:00:00 | merge commit `53f920cb` created elsewhere: parents `688930c0` (card) and `09abc0df` (origin/release/1.5.0) | architect, in a bundle |
| 06:04:45 | `merge 53f920cb: Fast-forward` (688930c0 -> 53f920cb) | DevOps, during shift 3eedc818 |
| 06:05:32 | `commit: Work in progress` = 6927fe2d, parent 53f920cb, 86 files, -6723 | runner autoCommit |
| 06:11..06:16 | `revert` / `reset: moving to 53f920cb` (repairs), each followed by a new "Work in progress" (6aa03532, f03d3c55, 7cbbc188) that deletes the same 86 files again | DevOps, then the runner |

So two mechanisms, both in `guard.ts`:

1. **No exemption for a base merge.** `mainMergeExemptPaths` (guard.ts:142) only exempts a merge whose non-first
   parent is in `mainMergeShas` (exact match, `s.mainShas` in the supervisor, filled only by `mergeMainIntoCard` /
   `architectMergeMain` / `resumeMainMerge`). `09abc0df` is a release sha, so every path the merge brought in is in
   `changedPaths` and out of the architect's scope (`docs/**`, `**/*.md`).
2. **The discard reverts the merge.** At shift end (supervisor.ts:1516-1534) `discardOutOfScope` runs for every
   `mayCommit` role. For each out-of-scope path it runs `git checkout <startSha> -- p`, or, when `p` is absent at
   startSha (files the release added), `git rm -rf --cached` + `git clean`. That rebuilds the pre-merge tree in the
   index and the worktree; `autoCommit` then `git add -A` + commits it as "Work in progress".
3. **The chain.** The next shift starts on the stray commit (startSha = 6927fe2d). DevOps resets the branch to
   `53f920cb` (an *ancestor* of startSha). At shift end `changedPaths` diffs `6927fe2d..53f920cb` (the 86 files, now
   "changed" back), finds no merge in that range, and the discard reverts them to startSha again. Nothing checks that
   HEAD left the shift's line of history.

The ledger already holds the owner's decision for GWP-63: "Accept the release/1.5.0 merge as a base-branch merge
(exempt it in the guard ...)".

### 2.2 Facts that shape the design

- The architect may `git merge` in its own shell (docs/RUNNER.md: `git fetch*`, `git push*`, `git rebase*`,
  `git reset --hard*` are denied; `git merge` is allowed). So a base merge is made by the agent, not by a runner helper:
  there is no single place that "records" it. The runner can only know which commits *are* base content.
- `origin/<base>` only moves when the runner fetches (worktree creation, `rebaseOntoBase`, `aom git fetch`,
  `aom git merge-main` fetches main only). The agent can merge the local `<base>` too, which may be behind origin.
- The merge may arrive as a fast-forward (GWP-63: DevOps fast-forwarded to 53f920cb). A card branch with no commits of
  its own that runs `git merge origin/release/1.5.0` also fast-forwards: there is then **no merge commit at all**, and
  every release path counts as changed today.
- `discardOutOfScope` has one production caller (supervisor.ts:1521) and three test call sites
  (guard.test.ts:210, guard.test.ts:260, architect-guard.test.ts:112). `changedPaths` and `mainMergeExemptPaths` are
  only used inside guard.ts (`graph/gitio.ts` has an unrelated `changedPaths`).
- `rebaseOntoBase` (git/rebase.ts) runs before `s.startSha` is taken (supervisor.ts:1014 vs 1042): its merge or rebase
  is part of the baseline and never judged.

## 3. Options

### 3.1 How to recognise a base-branch merge

| option | how | verdict |
|---|---|---|
| A. Exact sha, like main | record `origin/<base>` sha at shift start; exempt a merge whose parent equals it | Misses a merge of an older base commit (local `<base>` behind origin, a bundle made earlier as in GWP-63, base moved by a later `aom git fetch`). |
| B. Ref lookup at guard time | parent is an ancestor of whatever `origin/<base>` / `<base>` point to when the guard runs | The agent can move a local ref (`git branch -f`, `update-ref`) and launder its own commit. |
| **C. Recorded tips, ancestor test** | the runner records the shas of `origin/<base>`, `<base>`, `origin/<working>`, `<working>` at shift start and after every runner fetch; a merge parent counts as base when it **is or is an ancestor of** a recorded tip | Covers local and origin, older base commits and bundles; a ref the agent moves later changes nothing. **Recommended.** |

Main keeps its current exact-match rule (`mainMergeShas.includes(parent)`) so main merges behave exactly as before.

### 3.2 Which paths of a base merge are exempt

The card: "only the files the merge result takes from the base side are exempt; files the architect changed by hand
while resolving conflicts are still judged", and AC 1 "merges ... (with or without conflicts) and changes no non-doc
files by hand: no violation". Resolving a conflict is therefore *not* a hand edit; an edit beyond the merge is. Per path
`p` of `diff --name-only F M` (F first parent, P base parent, B = `merge-base F P`):

- `M:p == P:p` (taken from the base side, deletions included): exempt.
- both sides changed `p` since B (`p` in `diff B F` and in `diff B P`): a conflict resolution or a clean combination of
  both sides: exempt (the same rule main merges have today).
- otherwise (`M:p` differs from the base side although only one side, or neither, changed it): a hand edit inside the
  merge commit: **not exempt**, judged normally.

Three name-only diffs give this without per-path blob reads:
`handEdits = (diff P M ∩ diff F M) − (diff B F ∩ diff B P)`; `exempt(M) = diff F M − handEdits`.
For main merges `exempt(M) = diff F M` as today.

### 3.3 HEAD moved during the shift: re-baseline or skip

| option | effect | verdict |
|---|---|---|
| Re-baseline startSha to the new HEAD and discard against it | only dirty paths are judged | Changes the disk (dirty paths are reverted) although AC 4 says "changes nothing on disk"; also hides an agent's own reset. |
| Re-baseline to `merge-base(startSha, HEAD)` | | A DevOps rebase onto a newer base puts the whole base diff in `mb..HEAD`: the discard would delete base files again, exactly the GWP-63 failure. |
| **Skip** | discard nothing, WARN + card note naming old and new HEAD; do not auto-commit out-of-scope dirty paths | Matches AC 4 literally, cannot destroy anything, keeps the guard strict. **Recommended.** |

"Moved outside the shift" = `git merge-base --is-ancestor <startSha> HEAD` fails (reset backwards, rebase, rewrite,
switch to an unrelated commit). A move *forward* (fast-forward to a descendant) stays on the normal path: the commits it
brings are judged like any others, with the merge and fast-forward exemptions below.

## 4. Recommendation and design

### 4.1 Data model

`GuardInput` (guard.ts:55) gets one new optional field; `mainMergeShas` keeps its meaning:

```ts
/**
 * Tips of the card's base and working branch (local and origin/), recorded by the runner at the shift start and after
 * each runner fetch. A merge parent that is, or is an ancestor of, one of these is base-branch content.
 */
baseTipShas?: string[];
```

and a second one for the "own diff" test (4.2.3):

```ts
/** When the shift started (ms since epoch, taken with startSha): HEAD reflog entries since then are this shift's. */
startedAtMs?: number;
```

`ActiveShift` (supervisor.ts:355) gets `baseTips: string[]` next to `mainShas` and `startedAtMs` (set at
supervisor.ts:1042 together with `startSha`); `PersistedShift` gets `baseTips?: string[]` and `persist()` /
`resumePersisted()` / `handleStart(resume)` carry it the same way as `mainShas`. No new runner config key.

### 4.2 guard.ts

1. **`mergeExemptions(worktree, startSha, { mainShas, baseTips })`** replaces `mainMergeExemptPaths` (keep the old
   name as a thin wrapper only if something else needs it; nothing does today). Returns:

   ```ts
   interface MergeExemptions {
     exempt: Set<string>;            // paths whose change since startSha is main/base content
     restoreFrom: Map<string, string>; // path -> commit to restore from instead of startSha (see 4.2.3)
     handEdits: Set<string>;         // non-exempt paths changed inside an exempt merge commit
   }
   ```

   - `isBase(sha)`: `baseTips.some(t => t === sha || git merge-base --is-ancestor sha t succeeds)`; cache per sha.
   - Merges: `git rev-list --merges --parents <startSha>..HEAD --not <baseTips...>` (merges that are themselves base
     history are covered by the fast-forward rule; skipping them avoids needless work). For each merge `M F P...`:
     kind `main` if a parent is in `mainShas` (exact, as today), else kind `base` if `isBase(P)` for a parent, else skip.
     `brought = diff --name-only F M`; `after = diff --name-only M HEAD` (as today).
     `main`: candidates = brought. `base`: candidates = brought − handEdits(M) (3.2); add handEdits(M) to `handEdits`.
     `exempt += candidates − after`. For each `p` in `candidates ∩ after`, if not yet set, `restoreFrom[p] = M`
     (rev-list is newest first, so the first merge seen is the latest). For each `p` in handEdits(M), if not yet set,
     `restoreFrom[p] = (p in diff B P) ? P : F` (the side a clean merge would have taken).
   - Fast-forward to base content: for each base tip `t`, `X = merge-base HEAD t`; when `X != startSha` and
     `merge-base --is-ancestor startSha X` succeeds, the commits `startSha..X` are base history:
     `exempt += diff(startSha, X) − diff(X, HEAD)`; for paths in both, `restoreFrom[p] ??= X`. Take the X nearest HEAD
     when several tips qualify.
   - All git calls through `git()`; refs passed after `--not` are the recorded shas only (never agent input).

2. **`changedPaths(worktree, startSha, exemptOpts)`**: same as today but uses `mergeExemptions(...).exempt`. Signature
   becomes `changedPaths(worktree, startSha, opts: { mainShas?: readonly string[]; baseTips?: readonly string[] } = {})`;
   `runGuard` and `discardOutOfScope` pass `{ mainShas: input.mainMergeShas, baseTips: input.baseTipShas }`.

3. **`discardOutOfScope(input): Promise<DiscardResult>`**:

   ```ts
   export interface DiscardResult {
     discarded: string[];
     /** Out of scope but left alone: not in the shift's own diff (another process brought it onto the branch). */
     kept: string[];
     /** Set when nothing was discarded because HEAD left the shift's history. */
     skipped?: { reason: 'head_moved'; from: string; to: string };
   }
   ```

   a. `head = rev-parse HEAD`. If the role has a write scope (`effectiveWritableGlobs(input) !== null`) and
      `merge-base --is-ancestor startSha HEAD` fails: return `{ discarded: [], kept: [], skipped: { reason:
      'head_moved', from: startSha, to: head } }`. Nothing on disk changes. (Unscoped roles return early with nothing to
      do anyway, so builders never get the note.)
   b. `ex = mergeExemptions(...)`; `bad = outOfScope(input, changedPaths(...))` (same set as today when no merge is
      involved, so AC 6 is unchanged).
   c. **The shift's own diff** (`ownPaths`): the dirty paths (status, as in `changedPaths`) plus the paths changed by
      the commits this worktree *created* during the shift. Those are read from the worktree's own HEAD reflog (linked
      worktrees keep it per worktree, so other cards never show up):
      `git reflog show --date=unix --format=%H%x09%gd%x09%gs HEAD`, entries whose `HEAD@{<seconds>}` is
      `>= floor(startedAtMs/1000) - 1`, whose subject starts with `commit` (`commit:`, `commit (merge):`,
      `commit (amend):`), `cherry-pick` or `revert`, or is a `merge <x>: Merge made by ...` (a merge commit made here).
      Not own: `merge <x>: Fast-forward`, `reset:`, `checkout:`, `rebase ...`, anything else (another process moved the
      branch to commits it did not create; GWP-63's `merge 53f920cb: Fast-forward` is exactly this). For each own
      commit `C` that is still reachable from HEAD: `diff --name-only C^1 C`, minus `exempt(M)` when `C` is an exempt
      merge (its `handEdits` stay own). When `startedAtMs` is absent (old callers, tests) or the reflog is unreadable,
      fall back to the paths of the non-merge commits in `startSha..HEAD` (today's reach, minus exempt merges).
   d. For each `p` in `bad`:
      - `p` not in `ownPaths`: push to `kept`, touch nothing (the guard still reports it, so the refusal is unchanged;
        only the destructive revert is withheld). This covers both AC 3 (no `rm --cached` / `clean` of a file present
        in HEAD that the shift did not add) and the matching case of a modified file the shift did not modify.
      - else `R = ex.restoreFrom.get(p) ?? startSha`; `p` exists at `R` (`cat-file -e R:p`): `git checkout R -- p`
        (today's behaviour when `R = startSha`).
      - else: `git rm -rf --cached --ignore-unmatch -- p` + `git clean -fdq -- p` (today's behaviour).
   e. Return `{ discarded, kept }`.

4. **`runGuard`**: only the exemption input changes (via `changedPaths`). The `architect_edited_non_docs` detail text
   becomes "... (never product code or tests, except merge conflicts of the main or base branch)". No other rule
   changes (GWP-85 owns `commits_on_other_branch`).

5. New small helper for the supervisor: `uncommittedOutOfScope(input): Promise<string[]>` = `outOfScope(input, <dirty
   paths from status, stubs and test artifacts removed>)` (reuse the dirty half of `changedPaths`).

### 4.3 supervisor.ts

1. **Record base tips** (new private `recordBaseTips(s)`): for each distinct, `isSafeGitRef` branch in
   `[s.worktree.baseBranch, msg.brief.project.workingBranch]`, `revParse` `refs/remotes/origin/<b>` and `refs/heads/<b>`
   and push the shas not yet in `s.baseTips`; then `this.persist(s)`. Call it right after `s.startSha` is taken
   (supervisor.ts:1042) and in `architectGit` after a successful `git.fetch` (and after `git.merge_main`, which fetches).
   Runs inside the shift's existing worktree hold; read-only ref lookups need no repo lock.
2. **`guardInput`** (supervisor.ts:2056): add `...(s.baseTips.length ? { baseTipShas: s.baseTips } : {})` and
   `...(s.startedAtMs ? { startedAtMs: s.startedAtMs } : {})`.
3. **Shift end** (supervisor.ts:1520-1534):

   ```ts
   let holdCommit: string[] = [];
   if (s.startSha && !(await mergeInProgress(wt))) {
     const input = this.guardInput(s, wt, s.startSha);
     const r = await discardOutOfScope(input);
     if (r.discarded.length) this.log.warn(`discarded out-of-scope changes of shift ${id}: ${r.discarded.join(', ')}`);
     if (r.kept.length) this.log.warn(`kept ${r.kept.length} out-of-scope paths of shift ${id} that are not its own changes: ...`);
     if (r.skipped) {
       holdCommit = await uncommittedOutOfScope(input);
       const text = `The out-of-scope discard was skipped: HEAD moved from ${short(r.skipped.from)} to ${short(r.skipped.to)} `
         + `outside this shift's commits (a reset, rebase or rewrite of ${branch}). Nothing was reverted.`
         + (holdCommit.length ? ` These out-of-scope files were left uncommitted: ${list(holdCommit)}.` : '');
       this.log.warn(`${ref}: ${text}`);
       await this.submit(s, { kind: 'comment', note: text });
     }
   }
   // ... leftovers as today
   const committed = holdCommit.length ? false : await autoCommit({...});
   ```

   The existing unreported-work note keeps working; when `holdCommit` is non-empty pass `committed: false` (its text
   for `committed: false` mentions a waiting merge; add an optional `reason` to `unreportedWorkNote` or leave it, the
   skip note above already says why).

### 4.4 Why requirement 3 holds (no commit can revert a base merge)

After a base merge the shift-end tree can only differ from HEAD by (i) paths the shift itself changed out of scope,
restored to the content right after the last exempt merge (`restoreFrom`), never to the pre-merge startSha, and (ii) the
shift's own in-scope edits. Files the base brought in are exempt (never in `bad`); out-of-scope paths that arrived through
commits the worktree did not create (a fast-forward, a reset forward) are `kept` even if the exemption missed them (for
example a base tip that was not recorded); a HEAD that left the shift's history disables the discard and blocks the
commit of out-of-scope dirty paths. The GWP-63 chain therefore cannot start (step 1: the 53f920cb fast-forward is a merge with base parent 09abc0df ->
exempt) and cannot continue (a reset to an ancestor -> skipped). GWP-84 adds the independent mass-deletion refusal in
`autoCommit` on top.

## 5. Files to change

| file | change |
|---|---|
| `apps/runner/src/shifts/guard.ts` | `GuardInput.baseTipShas`; `mergeExemptions` (replaces `mainMergeExemptPaths`); `changedPaths` options object; `discardOutOfScope` -> `DiscardResult` with the HEAD check, restore points and the keep rule; `uncommittedOutOfScope`; architect violation text |
| `apps/runner/src/shifts/supervisor.ts` | `ActiveShift.baseTips`, `PersistedShift.baseTips`, persist/resume; `recordBaseTips` at start and after `git.fetch` / `git.merge_main`; `guardInput`; shift-end discard handling, WARN + card note, commit hold |
| `apps/runner/test/guard.test.ts`, `apps/runner/test/architect-guard.test.ts` | adapt the three `discardOutOfScope` assertions to `.discarded`; new cases (section 7) |
| `apps/runner/test/supervisor.test.ts` | shift-end case (7.7) |
| `docs/ARCHITECTURE.md` 13.7, `docs/RUNNER.md` architect section | describe the base exemption, the in-merge hand-edit rule, the restore point, the keep rule and the skip on an external HEAD move |

`git/architect-git.ts` and `git/sync-main.ts` need no change: they record main shas only, and base content is
recognised from the recorded tips. (`architectVerifyMerge` checks the main sha; a base merge has no recorded main sha,
so `startMainSha()` is undefined and verify-merge already accepts any merge commit. No change needed.)

## 6. Acceptance criteria -> design

| AC | covered by |
|---|---|
| 1. Architect merges origin/release/1.5.0 (with or without conflicts), no hand edits: no `architect_edited_non_docs`, nothing reverted or deleted | base tips recorded at start (4.3.1); merge parent is a tip/ancestor -> kind `base`; brought paths taken from base or changed on both sides are exempt (3.2, 4.2.1); fast-forward rule for merges with no merge commit |
| 2. Plus one hand-edited non-doc file: only that file reported and discarded | hand edit after the merge (commit or dirty) is in `after` / dirty -> not exempt, restored from `restoreFrom = M`, so the base change to that file survives; a hand edit inside the merge commit is in `handEdits`, restored from the clean side |
| 3. Files absent at startSha, present in HEAD, not in the shift's own diff are never removed | exemption (they are not in `bad`) and, independently, the own-diff rule in 4.2.3c/d (`kept`) |
| 4. HEAD reset/moved to a non-descendant: nothing on disk changes; WARN + card note with old and new HEAD | 4.2.3a + 4.3.3 |
| 5. Main merges exempt exactly as before | main keeps exact-sha matching and the full `brought − after` set; existing architect-guard tests stay green |
| 6. Plain out-of-scope edits with no merge and no HEAD move: discarded and refused as before | with no merges, no tips matched and HEAD a descendant, `exempt` is empty and `restoreFrom` is empty: identical code path to today |
| 7. Replaying GWP-63 produces no deleting "Work in progress" commit | test 7.7 (two shifts: base merge + rejected shift; then reset to an ancestor + rejected shift) |

## 7. Test plan (real temp git repos via `test/helpers.ts`, no git mocks)

In `architect-guard.test.ts` add a `setupRelease()` variant: origin gets a `release/x` branch with its own commits
(add `rel/new.ts`, modify `src/existing.ts`, delete `rel/old.ts`), the card worktree is created from `release/x` (spec
`baseBranch: 'release/x'`), and the test pushes more release commits and runs `git fetch` in the worktree, then records
`baseTipShas = [rev-parse origin/release/x]`.

1. Architect `git merge --no-ff origin/release/x` (no conflict): `runGuard` -> `[]`; `discardOutOfScope` -> nothing
   discarded or kept; `git status` clean; `rel/new.ts` still present. Same with a conflict in a non-doc file resolved by
   combining both sides and `git commit --no-edit`.
2. Same, plus a hand edit of `src/other.ts` (committed, and in a second case dirty): only `src/other.ts` reported and
   discarded; for a hand edit of a file the merge changed, it is restored to the merge's content, not to startSha.
   A hand edit placed inside the merge commit (`git merge --no-commit`, edit an untouched file, commit) is reported.
3. `rel/new.ts` (absent at startSha, added by the merge) survives a discard that runs because of another out-of-scope
   edit. Own-diff belt: build the merge commit in a second clone, then in the worktree `git merge --ff-only <it>`
   (reflog "Fast-forward", like GWP-63) and call `discardOutOfScope` with `startedAtMs` set but **without**
   `baseTipShas`: `rel/new.ts` and the modified `src/existing.ts` are in `kept`, the tree is unchanged, while a file
   the test then commits itself in the worktree is still discarded. Also the fast-forward case with tips: a card branch
   with no own commits runs `git merge origin/release/x` (fast-forward): guard passes, nothing discarded.
4. HEAD reset mid-shift: startSha = a commit C; `git reset --hard C~1` (or `update-ref` to an unrelated commit) plus an
   untracked out-of-scope file: `discardOutOfScope` returns `skipped { from: C, to: C~1 }`, the tree is byte-identical
   before and after; `uncommittedOutOfScope` lists the file.
5. Main-merge regression: the existing tests "what a merge of the recorded main commit brought in is exempt", "an edit
   to a main file after the merge ...", "a conflict resolution is exempt ..." stay unchanged and green; add one where
   both a main merge and a base merge happen in the same shift.
6. Plain out-of-scope edit (existing "out-of-scope edits are discarded instead of auto-committed", guard.test.ts
   "custom role" case): unchanged expectations on `.discarded`; add a committed out-of-scope new file (no merge) that is
   still removed (own non-merge commit).
7. Supervisor (`supervisor.test.ts`, harness + `ScriptedAdapter`): an architect shift in an `investigate` stage on a
   card based on `release/x`; the script merges `origin/release/x`, posts a report that the guard rejects (for example
   one hand-edited `src/x.ts`), exits. Assert: no commit deletes or reverts a release file (`git log -p` of the new
   commits touches only `src/x.ts` or nothing), the release files are in HEAD. Second shift: the script runs
   `git reset --hard <ancestor>`; assert a `comment` with "discard was skipped" naming both shas reached the server, and
   no new "Work in progress" commit exists.

Run `pnpm --filter <runner package> test` (vitest, unit only) with a timeout; no e2e suites.

## 8. Risks and notes

- **Ancestor test cost**: one `merge-base --is-ancestor` per merge parent per tip, cached; fine for a shift.
- **Reflog as the "who created it" signal**: per-worktree HEAD reflog, enabled by default in non-bare repos. Commits
  another process makes *inside the same worktree* (DevOps committing there) count as the shift's own; commits
  brought by fast-forward or reset never do. Unreadable reflog falls back to today's reach (non-merge commits since
  startSha), so the change can never make the discard reach further than it does now. Use a 1 s slack on the start
  time (reflog stamps are whole seconds).
- **Base content is "anything in base history"**: merging an old base commit, or another card's branch that is already
  in the base, is exempt. That is base content by definition; branches not in base history stay judged.
- **Skip leaves dirty out-of-scope files uncommitted** in the worktree after an external HEAD move. The next shift sees
  them (and its own shift-end discard handles them against its own startSha). Accepted for AC 4 ("nothing on disk").
- **runGuard after an external HEAD move** still diffs `startSha..HEAD` and may refuse the report (as today). That is
  honest (the guard cannot attribute the change) and no longer destructive; a softer guard rule for this case is not in
  this card.
- **Resumed shifts** (runner restart) take a fresh startSha and re-record the tips; persisting `baseTips` keeps tips
  recorded before a mid-shift fetch.
- GWP-84 (autoCommit mass-deletion refusal) depends on this card (recorded); GWP-85 (`commits_on_other_branch`) touches
  `runGuard` only in the branch loop: keep this card's `runGuard` change limited to the exemption input and text.
- The read-only `.git/worktrees/<card>` issue (index.lock) is GWP-86, not here.
