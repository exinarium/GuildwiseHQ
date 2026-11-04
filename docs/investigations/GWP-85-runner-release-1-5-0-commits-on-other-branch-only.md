# GWP-85: commits_on_other_branch only for branches this shift touched

Target branch: release/1.5.0. Scope: `apps/runner/src/shifts/guard.ts` (branch rule, one shared reflog helper), a few
additive fields in `apps/runner/src/shifts/supervisor.ts` (`guardInput()` only), tests in
`apps/runner/test/guard.test.ts`, one paragraph in `docs/ARCHITECTURE.md` section 13.7.

Revision 2 (after GWP-83 landed): the shift start time and the HEAD-reflog parsing now come from what GWP-83 added
(`GuardInput.startedAtMs`, the reflog read in `ownCommitPaths`). The `shiftStartedAtUnix` field and the
`branchesAtStartUnix` supervisor field of revision 1 are dropped. See section 9.

## 1. Question

The post-shift guard of GWP-79 refused with `commits_on_other_branch` because `backup/gwp-63-partial-rebase-0c0bf3f8`
changed during the GWP-79 shift. GWP-79 never touched that branch. How should the guard tell which card a moved branch
belongs to, so that another card's work never refuses this shift, while a shift that really writes to another card's
branch, to main or to the base branch is still refused?

## 2. Findings

### 2.1 Current behaviour (`guard.ts` `runGuard`, l.514-528 after GWP-83)

```ts
const now = await snapshotBranches(input.worktree);           // every refs/heads branch, repo-wide
const siblings = await siblingWorktreeBranches(input.worktree); // branches checked out in other linked worktrees
for (const b of Object.keys(now)) {
  if (b === input.branchName || siblings.has(b) || input.branchesAtStart[b] === now[b]) continue;
  if (isRunnerOwnedBranch(b)) continue;                          // guildwise/saved-work/, conflict/, guildwise/integration/, aom-integration/
  if (await isSyncOnly(input.worktree, now[b], input.branchesAtStart[b])) continue;
  moved.push(b);
}
```

- The snapshot is repo-wide (one ref store is shared by the main clone and every card worktree).
- A branch is exempt only when it is the card branch, checked out in a sibling worktree, runner-owned, or moved
  without new local commits (`isSyncOnly`: `rev-list tip --not --remotes <before>` is empty).
- Not exempt: another card's branch that is **not checked out** anywhere (`backup/gwp-63-*`, a second
  `aom/gwp-63-finalize`, an older card branch after its worktree went), plus every non-card branch.
- Sibling exemption is a blanket skip: a shift that writes into a sibling's branch (`git update-ref`,
  `git branch -f` is refused by git for a checked-out branch but `update-ref` is not) is never caught. AC4 asks for
  this to follow the new rule.

### 2.2 What happened on GWP-79 (confirmed in the shared `.git`)

- Branch reflog `backup/gwp-63-partial-rebase-0c0bf3f8@{1793771876}`: `branch: Created from 0c0bf3f8`.
- `0c0bf3f8` is `commit: Work in progress` in **GWP-63's** worktree HEAD reflog (`.git/worktrees/GWP-63/logs/HEAD`),
  same second as GWP-63's `rebase (abort)`.
- For GWP-79's guard: `before` undefined, tip `0c0bf3f8` is a local-only commit, so `isSyncOnly` is false and the
  branch is flagged. Nothing in GWP-79's own worktree reflog refers to `0c0bf3f8`.

So the information that separates "this shift did it" from "another card did it" exists: **each linked worktree has its
own HEAD reflog** (`.git/worktrees/<name>/logs/HEAD`, read with `git reflog` from inside that worktree). Commits made in
card B's worktree land in B's HEAD reflog, never in A's. A shift that checks out another branch and commits, or
creates a commit and points another branch at it, leaves those SHAs in its own HEAD reflog. GWP-83 relies on the same
fact (`ownCommitPaths` reads this worktree's HEAD reflog since `startedAtMs` to find the shift's own commits).

### 2.3 Branch naming in this repository

`branchName(prefix, ref, title)` in `packages/shared/src/ids.ts` gives `<prefix><ref lowercased>-<slug>`. Prefixes:
`CARD_BRANCH_PREFIXES` (`guildwise/`, legacy `aom/`) or a project prefix; a ticket-keyed card can have
`<prefix><ticket>` (stored `branch_name`). Live branches in the clone today include `aom/gwp-63-finalize`,
`aom/gwp-63-storage-connectors-...`, `backup/gwp-63-partial-rebase-0c0bf3f8`, `backup/video-1.3-before-trailer-fix`,
`conflict/GWP-27-a1`, `feat/video-1.3`, `release/1.5.0`, `merge/fix-into-1.5.0`, `hotfix/ceo-plain-claude` (a sibling
worktree). A generic `[a-z]+-\d+` regex would match `video-1` in `feat/video-1.3`, so the card ref pattern must use the
project key.

### 2.4 Ledger

- b98fc43a (GWP-79): "do not exclude the backup branch from the guard ... widening it would hide the next unrelated
  change". This card (from the owner, parent GWP-81) now asks for the fix. The design below does **not** exclude other
  cards' branches blindly: it keeps refusing any change this shift made to them, so the concern of b98fc43a (hiding
  real changes) is met; only changes made by another card's worktree stop refusing this card.
- c5dba013 / e35b6a9c / a7a8d0bc: GWP-63 history, root cause handled by GWP-83 / GWP-84.

## 3. Options

| Option | How a moved branch is attributed | AC1 (B's work does not refuse A) | AC2 (A writing to B / main / base refused) | Notes |
|---|---|---|---|---|
| O1 name only: skip branches named for another card | name `…gwp-<n>-…` with n ≠ own | yes | **no** for B's branch: A can commit to `backup/gwp-63-*` unnoticed | rejected (planner already flagged it) |
| O2 provenance only, all branches | new commits in A's HEAD reflog | yes | yes | drops the strict rule for main and non-card branches (owner commits in the main clone would no longer refuse); conflicts with "keep the existing protection"; attribution by worktree only, not by card naming |
| O3 timing (moved after A's last commit etc.) | timestamps | partly | partly | forbidden by the card constraint |
| **O4 (recommended) classify by name and runner records, decide foreign branches by provenance** | protected / own / foreign / other by name and worktree list; foreign branches refused only when A's HEAD reflog shows A made the move | yes | yes | keeps every existing refusal for main, base, own-family and non-card branches |

## 4. Recommendation: O4

### 4.1 Classification of a moved branch `b` (in this order)

Keep the existing early exits: `b === input.branchName`, unchanged, `isRunnerOwnedBranch(b)`, `isSyncOnly(...)`.
Then:

1. **protected**: `b` is main, the project working branch or the card's base branch (input `protectedBranches` plus
   `baseBranch`, plus the default branch from `git symbolic-ref --short refs/remotes/origin/HEAD` without `origin/`).
   - not checked out in a sibling worktree: **strict** (refuse, exactly as today; the existing test "commit on main in
     the main clone" keeps passing).
   - checked out in a sibling worktree: **provenance** (today it was skipped; now a write by this shift is caught).
2. **sibling**: checked out in another linked worktree (`siblingWorktreeBranches`): **provenance**.
3. **own family**: `cardRefOfBranch(b, projectKey) === cardRef` (for example `backup/gwp-85-save`): **strict**, as
   before (AC3 "judged as before").
4. **foreign card branch**: `cardRefOfBranch(b, projectKey)` is another card's ref (any prefix: `guildwise/`, `aom/`,
   `backup/`, `merge/`, the project prefix), or `b` starts with a `CARD_BRANCH_PREFIXES` entry (ticket-keyed card
   branches): **provenance**.
5. **other** (non-card branches such as `feat/x`, `rogue`): **strict**, as before.

**strict** = refuse (today's rule). **provenance** = refuse only when `madeByThisShift(b)`.

### 4.2 Provenance: one HEAD-reflog helper shared with GWP-83

GWP-83 already parses this worktree's HEAD reflog inline in `ownCommitPaths` (guard.ts l.363-391:
`git reflog show --date=unix --format=%H%x09%gd%x09%gs HEAD`, `since = floor(startedAtMs / 1000) - 1`). Do not add a
second parser: extract that parse into one helper and use it from both places.

```ts
interface HeadReflogEntry { sha: string; ts: number; subject: string }

/**
 * This worktree's HEAD reflog entries since the shift started (`startedAtMs`, one second of slack as before); every
 * entry when `startedAtMs` is absent. Null when the reflog cannot be read or is switched off.
 */
async function headReflogSince(worktree: string, startedAtMs: number | undefined): Promise<HeadReflogEntry[] | null> {
  const rl = await git(worktree, ['reflog', 'show', '--date=unix', '--format=%H%x09%gd%x09%gs', 'HEAD']);
  if (rl.exitCode !== 0) return null;
  const since = startedAtMs === undefined ? undefined : Math.floor(startedAtMs / 1000) - 1;
  const out: HeadReflogEntry[] = [];
  for (const line of lines(rl.stdout)) {
    const [sha, sel, subject = ''] = line.split('\t');
    const ts = Number(/@\{(\d+)\}/.exec(sel ?? '')?.[1]);
    if (!sha || !Number.isFinite(ts) || (since !== undefined && ts < since)) continue;
    out.push({ sha, ts, subject });
  }
  return out;
}
```

- `ownCommitPaths` keeps its exact behaviour: it calls the helper only when `input.startedAtMs !== undefined`, applies
  its own subject filter (`commit|cherry-pick|revert`, `merge ...: Merge made by`) and `--is-ancestor` check, and
  keeps its `rev-list --no-merges startSha..HEAD` fallback when the start time is absent or the helper returns null.
  This is a pure refactor for GWP-83's code; its tests must pass unchanged.
- The branch rule builds its SHA set from the same helper:

```ts
// SHAs this worktree's HEAD pointed at because of a commit-creating action since the shift started.
// checkout:/reset: entries only move HEAD to an existing commit, they never create one.
async function shiftHeadShas(input: GuardInput): Promise<Set<string> | null> {
  const cfg = await git(input.worktree, ['config', '--get', 'core.logAllRefUpdates']);
  if (cfg.stdout.trim() === 'false') return null;                      // no reflog: provenance unknown
  const entries = await headReflogSince(input.worktree, input.startedAtMs);
  if (!entries) return null;
  return new Set(entries.filter((e) => !/^(checkout|reset):/.test(e.subject)).map((e) => e.sha));
}

// b moved and this shift made the move: its new tip, or one of its new commits that are not on this card's own
// branch, was created in this worktree during the shift.
async function madeByThisShift(input: GuardInput, tip: string, before: string | undefined, shas: Set<string>): Promise<boolean> {
  if (shas.has(tip)) return true;                                   // checkout b + commit, or branch -f/update-ref to a shift commit
  const args = ['rev-list', tip, '--not', '--remotes', `refs/heads/${input.branchName}`];
  if (before) args.push(before);
  const r = await git(input.worktree, args);
  return lines(r.stdout).some((c) => shas.has(c.trim()));
}
```

- Reflog unavailable (`null`): fail closed, treat as strict, and say so in the detail
  ("provenance unknown: this worktree keeps no HEAD reflog"). Read the reflog once per guard run, lazily (only when a
  provenance branch moved).
- `startedAtMs` absent (older callers, tests that do not pass it, and a shift resumed after a runner restart: the
  supervisor does not persist `startedAtMs`): use the whole worktree reflog. That is stricter, never looser.
- Excluding `refs/heads/<own branch>` in the rev-list keeps card B's legitimate merge of card A's branch from counting
  as A's doing (B's new commits are then only B's merge commit, which is in B's reflog, not A's).

Why this is attribution by card and runner records, not by timing: the class comes from branch naming
(`cardRefOfBranch`, `CARD_BRANCH_PREFIXES`) and runner records (the card branch, the project main/working/base
branches, the worktree list); the decision for a foreign branch comes from **which worktree** created its commits. The
timestamp only bounds the reflog to this shift.

### 4.3 `cardRefOfBranch`

```ts
/** The card ref a branch name carries (`backup/gwp-63-x` -> `GWP-63`), for the project's key only; null when none. */
export function cardRefOfBranch(name: string, projectKey: string | undefined): string | null {
  if (!projectKey) return null;
  const key = projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|/)(${key}-\\d+)(?=$|[-/_.])`, 'i').exec(name);
  return m?.[1] ? m[1].toUpperCase() : null;
}
```

Boundary: `gwp-630-x` gives `GWP-630`, never `GWP-63`. `feat/video-1.3` gives null. Card ref comparison is
case-insensitive (`conflict/GWP-27-a1`, `aom/gwp-27-...`).

### 4.4 Data model / API (all additive, optional)

`GuardInput` (guard.ts), next to GWP-83's `mainMergeShas` / `baseTipShas` / `startedAtMs` / `baseBranch`:

```ts
/** The card's ref (`GWP-85`) and the project key (`GWP`): name a branch's card. Absent: no name-based attribution. */
cardRef?: string;
projectKey?: string;
/** Main, the project working branch and the base branch: always strict unless checked out in a sibling worktree. */
protectedBranches?: string[];
```

No new time field: the reflog bound is GWP-83's `startedAtMs` (set in `ShiftSupervisor.run` at l.1055, right before
`recordBaseTips` and `s.branchesAtStart = await snapshotBranches(cwd)` at l.1057, and passed by `guardInput()`).
`baseTipShas` is a SHA list, not a branch list, so it does not replace `protectedBranches`.

`supervisor.ts`, `guardInput()` only (l.2125-2147); no change at the start snapshot:
- `cardRef: msg.brief.card.ref, projectKey: msg.brief.project.key,`
- `protectedBranches`: main (`msg.prepare.syncMain?.mainBranch ?? msg.worktree?.mainBranch`, as l.2163 already does),
  `msg.brief.project.workingBranch` and `s.worktree?.baseBranch`, de-duplicated, empty ones dropped (the same branch
  pair `recordBaseTips` uses at l.2097, plus main). Omit the field when the list is empty.

`runGuard`: replace the loop at l.514-528 with a call to a new exported `otherBranchViolations(input)` that returns
`GuardViolation | null`; same rule name `commits_on_other_branch`, same detail prefix
`Branches other than <card branch> changed: a, b` so the server, the CLI text and existing tests are unaffected. Add a
short reason per refused foreign/sibling branch, e.g. `backup/gwp-63-x (commits made in this worktree)`.

`snapshotBranches` and `BranchSnapshot` stay as they are (repo-wide is right: the classification, not the snapshot,
decides). `siblingWorktreeBranches` stays as is; only its use changes from "skip" to "provenance". `isRunnerOwnedBranch`
unchanged. Of GWP-83's code only `ownCommitPaths` changes, and only by calling the extracted `headReflogSince`.

### 4.5 Out of scope (decisions)

- Read-only `.git/worktrees/<card>` (index.lock): handled by **GWP-86** (landed: the card's own worktree git dir is
  writable in the shift sandbox). The guard runs in the runner, outside the sandbox, and only reads the reflog.
- Architect merge exemption, `discardOutOfScope`: GWP-83 (landed). `autoCommit`: GWP-84.
- Non-card branches the owner commits on in the main clone during a shift (`feat/*`) still refuse, as before. Not this
  card.

## 5. Risks

- **Residual hole**: a shift that builds commits without moving HEAD (`git commit-tree` + `git update-ref` of another
  card's branch) leaves nothing in its HEAD reflog. Mitigation: the sandbox already keeps the agent out of other
  worktrees; this needs plumbing commands on purpose. Accepted and documented.
- **False refusal**: card A fast-forward-merges card B's branch while B's branch moves in the same shift (B's tip then
  lands in A's reflog via a `merge ...: Fast-forward` entry). Rare and A has then genuinely entangled with B's branch.
- **Reflog off** (`core.logAllRefUpdates=false`): falls back to strict, i.e. today's behaviour, never looser.
- **Regression in GWP-83's discard**: extracting `headReflogSince` touches `ownCommitPaths`. Keep the one-second slack,
  the `Number.isFinite` check, the subject filter and the fallback exactly as they are; GWP-83's guard and
  architect-guard tests cover it and must pass unchanged.
- Cost: one `git reflog` and at most one `rev-list` per moved foreign branch; only when such a branch moved.

## 6. Acceptance criteria mapped

| AC | Design | Test (guard.test.ts, temp repos via `makeRepo` + `ensureWorktree`, project key `TOY`, card A `TOY-1` on `aom/toy-1-x`, card B `TOY-2` on `aom/toy-2-y`; pass `startedAtMs` taken before the shift's actions, as the supervisor does) |
|---|---|---|
| AC1 B's branch moves for B's work: no refusal for A | foreign / sibling class, provenance false (B's commits are in B's reflog only) | (a) in B's worktree commit, then `git branch backup/toy-2-partial HEAD`: A's guard `[]` (the GWP-79 case). (b) `git -C <B> branch -f aom/toy-2-old <B commit>` (not checked out): `[]`. (c) same with `guildwise/toy-2-z`. (d) B merges A's branch in B's worktree: `[]`. (e) existing "concurrent shifts" test still passes. |
| AC2 A commits to B's branch, main or base: refused | foreign/sibling provenance true; protected strict | (a) A: `checkout backup/toy-2-partial`, commit, `checkout aom/toy-1-x`: `commits_on_other_branch`. (b) A commits on its branch, then `git branch -f aom/toy-2-old HEAD`: refused. (c) A: `git update-ref refs/heads/aom/toy-2-y <A commit>` (sibling): refused. (d) existing main-clone commit on main: refused. (e) base branch `release/x` (passed as `baseBranch`/`protectedBranches`): A checks it out, commits, returns: refused; owner commits locally on it in the main clone: refused (strict as before). |
| AC3 own branches judged as before | `b === branchName` skipped; own family strict | A commits on `aom/toy-1-x`: `[]`. A creates `backup/toy-1-save` with a local commit: refused (as before). Existing "rogue" test (non-card branch): refused. |
| AC4 sibling branches consistent | sibling class uses provenance instead of skip | AC1 (e) and AC2 (c). |
| extra | `cardRefOfBranch`, reflog bound, reflog off | unit cases: `backup/gwp-63-partial-rebase-0c0bf3f8`→`GWP-63`, `aom/gwp-63-finalize`→`GWP-63`, `conflict/GWP-27-a1`→`GWP-27`, `aom/gwp-630-x`→`GWP-630`, `feat/video-1.3`→null, `release/1.5.0`→null, no key→null. A commit A made on B's branch **before** `startedAtMs` (earlier shift) and B's branch then moved by B: `[]`. Same without `startedAtMs`: refused (whole reflog, stricter). Reflog off (`git config core.logAllRefUpdates false` in the test repo) + foreign move: refused with "provenance unknown". GWP-83's discard tests unchanged after the `headReflogSince` extraction. |

Run the whole `apps/runner` unit suite (vitest, with the `timeout` rule); `architect-guard.test.ts`,
`tester-guard.test.ts` and `supervisor.test.ts` call `runGuard`/`guardInput` and must pass unchanged (all new fields are
optional). No integration or e2e suites.

## 7. Docs

`docs/ARCHITECTURE.md` section 13.7, replace the bullet "any role: no commits on any branch other than the card branch"
with:

> - any role: no commits on any branch other than the card branch (`commits_on_other_branch`). Runner-owned branches and
>   moves that add no local commit (a pull, a reset backwards) never count. Main, the working branch, the base branch,
>   the card's own other branches (same card ref in the name) and non-card branches are refused whenever they gain local
>   commits. A branch of another card (another card ref in its name, a card branch prefix, or checked out in another
>   card's worktree) is refused only when this shift made the move: its tip or one of its new commits is in this
>   worktree's HEAD reflog since the shift started. Without a HEAD reflog the rule is strict.

## 8. Assumptions about dependencies

1. GWP-83 does not change the branch loop in `runGuard`, `snapshotBranches`, `siblingWorktreeBranches` or the meaning
   of `branchesAtStart`/`branchName`. **Holds**: the loop is unchanged, now at l.514-528; the start snapshot is at
   l.1057.
2. GWP-83 adds at most optional fields to `GuardInput` and keeps `baseBranch`. **Holds**: it added `mainMergeShas`,
   `baseTipShas` and `startedAtMs` (all optional) and kept `baseBranch`. It adds no protected/base branch list (only
   SHAs), so `protectedBranches` stays.
3. GWP-83 may add a HEAD-reflog helper for its HEAD-moved check. **Did not hold as written**: GWP-83 added the shift
   start time (`startedAtMs`) and a HEAD-reflog parse, inline in `ownCommitPaths`. Revised: reuse `startedAtMs` instead
   of the new `shiftStartedAtUnix`, and extract the reflog parse into `headReflogSince` shared by `ownCommitPaths` and
   `shiftHeadShas` (section 4.2, 4.4).
4. GWP-84 changes `autocommit.ts` and the shift-end part of `ShiftSupervisor.run`, not `guardInput()` or the start
   snapshot. **Holds** (GWP-84 has not landed; nothing here depends on its code). With assumption 3 revised this card no
   longer touches the start snapshot at all.

## 9. Revision log

- Rev 2 (2026-11-04, after GWP-83 landed): dropped `GuardInput.shiftStartedAtUnix` and `ActiveShift.branchesAtStartUnix`;
  the reflog bound is GWP-83's `startedAtMs`. Replaced the standalone `shiftHeadShas` reflog parse with the shared
  `headReflogSince` helper extracted from `ownCommitPaths` (behaviour of `ownCommitPaths` unchanged). Line numbers
  updated to the landed code. Added the "before shift start" and "no start time" test cases.
