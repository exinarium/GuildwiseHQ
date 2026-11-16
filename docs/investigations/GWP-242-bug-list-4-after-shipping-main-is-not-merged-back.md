# GWP-242: After shipping, main is not merged back into the working branch

## 1. Question

When a release ships, the runner merges the release commit into main and puts the tag on that merge commit. Main is
never merged back into the working branch. The next release prep looks for the last tag with
`git tag --merged <working branch head>`, so it does not see the tag that just shipped. It then starts from the
previous tag: wrong base, wrong version bump, and a changelog/commit range that repeats work already released.

Wanted: (1) find the last release tag without depending on the merge commit being on the working branch, and (2) merge
main back into the working branch after shipping. A failed merge-back must not fail the release.

## 2. Findings

### 2.1 Where the last tag is chosen

`apps/runner/src/git/release-facts.ts`

- `releaseTagsAt(repoPath, headSha)` (line 76) lists every `v*` tag that matches `RELEASE_TAG_RE`, sorts them by semver
  and keeps the newest one in `git tag --merged <headSha>`. This is the only rule for "last release". It is used by:
  - `readReleaseFacts` (line 138): `repo.release_facts`. The commit range is `<lastTag>..<head>` (line 141), and
    `componentFactsAt(lastTag, head)` gives the changed paths and the version file at the tag.
  - `lastReleaseTagAt` (line 97), used by `release-docs-prep.ts:202` (`analyse`). The range is `${base.sha}..${tip}`
    and the diff is `git diff base.sha tip` (line 252).
- `componentFactsAt(repoPath, rules, lastTag, sha)` (line 47) runs `git diff --name-only lastTag sha` (a tree-to-tree
  diff) and reads the version file at `lastTag`. `release-ship.ts:217` also calls it, with `p.lastTag` (a tag name the
  server took from the facts).
- There is no per-component tag scheme today. Every release tag is `vX.Y.Z[-pre]`, and "component" only means the
  version-file rules. "Same tag scheme" therefore means: the same `v*` + `RELEASE_TAG_RE` filter and the same semver
  ordering.

### 2.2 What the publish step does

`apps/runner/src/git/release-publish.ts`

- `publishLocked` runs under `withRepoLock`. It lands the release (found on main / PR merged by the forge /
  `landByMerge`, which does `git merge --no-ff R` from the main tip in an integration worktree and pushes main). It then
  tags `target` (the merge commit, or R after a fast-forward) with an annotated tag, pushes the tag and creates the forge
  release.
- Nothing ever writes to the working branch after landing. After a `--no-ff` landing, `M = merge(old main, R)` and the
  tag points at M. M is not an ancestor of the working branch, so `tag --merged <working branch>` never lists it. That
  is the bug. A forge squash merge has the same effect: the squash commit S has only one parent (old main), and R is not
  in its history.

### 2.3 What git already gets right

`git log X..head` excludes everything reachable from X, even when X is not an ancestor of head. With X = M, the ancestors
of M include R, so `git log M..head` already lists only new commits. Only two things are actually wrong:

1. The selection: `tag --merged head` does not see M.
2. `git diff M head` is a tree diff. It would also show, in reverse, anything that main has and the working branch does
   not (a hotfix on main). The diff has to start at a commit that is on the working branch.

So the fix is a new selection rule plus a "release point": the commit on the working branch where the shipped content
ends. The range and the diff start there.

### 2.4 The release point of a tag

For a tag T whose peeled commit is C, and the working branch head H:

| Landing | C | Release point P (on H) |
| --- | --- | --- |
| Tag merged into H (today's case, working branch == main, or after a merge-back) | any | C |
| `--no-ff` merge by Guildwise or a PR merge commit | merge commit | the first non-first parent of C that is an ancestor of H (`C^2` = R, or the PR head) |
| Squash / rebase merge on the forge | single-parent commit, R not in its history | the release commit on H: `git log -1 --grep='^chore(release): <version>$' H`. `release-ship.ts:106` already uses this lookup. |
| Tag made by hand on main (a hotfix) | anything | `git merge-base C H` (best effort) |

P is always an ancestor of H, so `P..H` and `git diff P H` agree with each other.

### 2.5 Why "ahead" must not count merge commits

`readReleaseFacts` counts `ahead` with `git rev-list --count base..head`, which includes merge commits.
`apps/server/src/release/reconcile.ts:99-108` opens a new "Ship release" proposal when `ahead > 0` and the last tag
differs from the last closed proposal's tag. After a merge-back that needed a merge commit, the merge commit alone makes
`ahead = 1`. With the correct last tag, that would open a release proposal for a release that has no new content. Counting with
`--no-merges` fixes this. It also matches what `ahead` means in the UI ("N commits ahead of the main branch",
`ShipReleaseItem.tsx:100`). `release-docs-prep` already counts with `--no-merges`.

### 2.6 GWP-145 (no new automatic release prep run on a new head)

The automatic start (`apps/server/src/release/docs-prep-auto.ts`) needs the release-branch head to be deployed and
healthy on a test environment. The head comes from the facts or the latest card merge (`CardFinalized`). After a publish
the cycle resets (`latestRun`: `started_at >= MAX(published_at)`).

The merge-back commit is not a card merge, and nothing in Guildwise deploys on a runner push. When the next facts
refresh picks up the new head, readiness becomes "not ready", because the test environment still runs the old head. No
run starts. The rule holds as long as the server does not react to the merge-back: no event that triggers a deploy, no
`dispatcher.trigger()` call. Section 2.5 removes the other way a merge-back could start release work (a new proposal).

## 3. Options

### A. Fix only the lookup (requirement 1)

Change the selection and range rules in release-facts. This is enough for the next release to be correct even when main
is never merged back. Without a merge-back, the working branch stays behind main, and every PR from the working branch
to main shows the old merge commits as "behind". Requirement 2 and AC 3 are not met.

### B. Only merge back (requirement 2)

Simple, but it does not cover a failed merge-back (conflict, protected branch), a forge squash, or repositories that
shipped before this fix. AC 1 and AC 5 are not met.

### C. Both: a robust lookup and a best-effort merge-back (recommended)

The lookup makes the facts right whatever the branch state. The merge-back keeps the branches tidy and makes
`tag --merged` work again in the common case. A merge-back failure is reported and does no harm.

## 4. Recommendation

Option C. Design below.

## 5. Design

### 5.1 `apps/runner/src/git/release-facts.ts`

**New `releasePointOf`** (exported, read-only):

```ts
/**
 * The commit on `head` where the release `tag` ended: the tag's commit when head contains it, else the release side of
 * its merge commit, else the release commit (`chore(release): <version>`, squash or rebase landing), else the merge base.
 * Null when the tag is missing or shares no history with head.
 */
export async function releasePointOf(repoPath: string, tag: string, head: string): Promise<string | null> {
  const c = await revParse(repoPath, `refs/tags/${tag}`); // revParse peels (^{commit})
  if (!c) return null;
  if (await isAncestor(repoPath, c, head)) return c;
  const parents = (await git(repoPath, ['rev-list', '--parents', '-n', '1', c])).stdout.trim().split(/\s+/).slice(2);
  for (const p of parents) if (await isAncestor(repoPath, p, head)) return p;
  const version = tag.slice(1);
  const rel = (await git(repoPath, ['log', '-1', '--format=%H', `--grep=^chore(release): ${escapeRe(version)}$`, head])).stdout.trim();
  if (rel) return rel;
  const mb = await git(repoPath, ['merge-base', c, head]);
  return mb.exitCode === 0 && mb.stdout.trim() ? mb.stdout.trim() : null;
}
```

`escapeRe` exists privately in `release-ship.ts:49`. Move it to a small shared helper in the runner (or export it), so
that the grep is the same in both places. `isAncestor` comes from `./merged.ts`.

**`releaseTagsAt(repoPath, headSha, mainSha?: string | null)`**: new optional `mainSha`. The return type adds `from`
to `last`: `{ name, sha, from }`, where `sha` is the peeled tag commit (as today) and `from` is the release point.

The rule, newest tag first (same `all` list, same semver ordering):

1. `mergedHead` = `tag --merged headSha --list v*` (as today).
2. `mergedMain` = `tag --merged mainSha --list v*`. Only when `mainSha` is given and differs from `headSha`; otherwise an
   empty set.
3. For each tag t in `newestFirst(all)`:
   - t in `mergedHead`: last = t, from = the peeled sha. Stop.
   - t in `mergedMain`: from = `releasePointOf(t, headSha)`. If it is not null: last = t. Stop. (If it is null, the tag
     shares no history with head. Skip it.)
   - Otherwise, only when `mainSha` is given and differs from `headSha`, and for at most the first 50 tags checked: if
     the peeled commit is a merge whose non-first parent is an ancestor of head, last = t, from = that parent. Stop.
     This is the card's "release-side parent reachable from the working branch" rule, for when main cannot be
     resolved. The cap keeps a repository with many unrelated tags cheap. Note the cap in a comment.
4. No tag found: `last = null` (first release, unchanged).

When the working branch is main (`mainSha === headSha` or not given), only step 1 applies. The result is the same as
today (AC 6, AC 7).

**`lastReleaseTagAt(repoPath, headSha, mainSha?)`**: passes `mainSha` through and returns `{ name, sha, from }`.

**`componentFactsAt(repoPath, rules, lastTag, sha, from?: string)`**: the diff starts at
`from ?? (await releasePointOf(repoPath, lastTag, sha)) ?? lastTag`:

```ts
const start = lastTag ? (from ?? (await releasePointOf(repoPath, lastTag, sha)) ?? lastTag) : null;
// diff: git diff --name-only -z <start> <sha>
```

`contentAtTag` is still read at `lastTag` (the version as released, unchanged). `release-ship.ts:217` keeps calling it
without `from`. It only has the tag name, and it now resolves the same release point itself (the integration worktree
shares the clone's tags and objects).

**`readReleaseFacts`**:

- `releaseTagsAt(repoPath, headSha, baseSha)`.
- `range = lastTag ? `${lastTag.from}..${headSha}` : headSha`.
- `componentFactsAt(repoPath, p.components, lastName, headSha, lastTag?.from)`.
- `ahead`: `git rev-list --count --no-merges ${baseSha}..${headSha}` (section 2.5).
- The wire value stays `lastTag: { name, sha }`. Strip `from` before returning (`ReleaseFactsSchema` has no such field;
  keep the wire unchanged).

### 5.2 `apps/runner/src/git/release-docs-prep.ts` (`analyse`, line 202)

Resolve the main sha that the function already fetches (`origin/<main>` or `<main>`, when `p.mainBranch` is set) and
call `lastReleaseTagAt(repoPath, tip, mainSha)`. Use `base = { kind: 'tag', tag: last.name, sha: last.from }`, so that the
range (line 218) and the diff (line 252) start at the release point. `baseSha` in the summary becomes the release point,
which is "where this range starts". That is what the field is for.

### 5.3 `apps/runner/src/git/release-publish.ts`: the merge-back

In `publishLocked`, right after `carry.tag = {...}` (line ~202) and before the forge release:

```ts
// 2b. main back into the working branch: never fatal, reported in the result
if (p.workingBranch !== base) carry.mergeBack = await mergeBack(input, a, base, target);
```

It runs before the forge release so that a failing forge step still reports it. A Retry runs it again and gets
`already`. It runs for every landing mode (found / PR / merge), because a PR merge leaves the same gap.

**New `mergeBack(input, a, base, target)`** (in the same file, under the lock `publishLocked` already holds). It never
throws, and the whole body is wrapped in a try/catch that returns `failed`:

1. `git fetch origin <wb>` (with auth). `tip = revParse('refs/remotes/origin/<wb>')`. If there is no tip:
   `{ state: 'failed', reason: 'the working branch … does not exist on origin' }`.
2. `isAncestor(target, tip)`: `{ state: 'already', sha: tip }`. Nothing is pushed (this is also the rerun case).
3. `isAncestor(tip, target)`: a fast-forward. Push `target:refs/heads/<wb>` with `pushFastForward` (export it from
   `release-ship.ts`; it never forces). On success: `advanceLocalBranch(repoPath, wb, target)` and
   `{ state: 'fast-forward', sha: target }`. This is the normal case: the working branch is still R and M descends from R.
4. Otherwise (the working branch moved during the release):
   - `requireCommitIdentity(repoPath, p.commitAs, boundPostAsFor(p.postAs, p.remoteUrlNormalized, input.appProbe))`. On
     an error: `failed` with `NO_IDENTITY_WIRE` / `identityErrorWire(err)` as the reason (the same mapping as the tag step).
   - `withIntegrationWorktree({ repoPath, dir: join(integrationDir, `merge-back-${p.repoId}`), root: integrationDir,
     tempBranch: integrationBranchName(`merge-back-${p.version}`), startPoint: tip }, …)`.
   - Sign-off is decided as in `landByMerge`: `p.land.mode === 'merge' && p.land.signoff !== undefined ? p.land.signoff :
     (await detectSignOff(wt)).required`.
   - `git merge --no-ff [--signoff] -m "Merge <base> into <wb> after release <version>" <target>` with
     `commitEnv(identity)`.
   - On a conflict: list the files (`diff --name-only --diff-filter=U`), run `merge --abort`, and return `failed` with
     reason `merging <base> back into <wb> conflicts in a, b: merge <base> into <wb> by hand`.
   - Push with `pushFastForward(repoPath, sha, wb, a, appOfPlan(...))`. Its error already says "protected and refused
     the push" for protected-branch rejections and adds the `withPushReport` report. A non-fast-forward rejection
     (someone pushed in between) is a plain `failed`. It is not retried.
   - On success: `advanceLocalBranch` and `{ state: 'merged', sha, signedOff }`.

What it merges is the tagged commit `target`, not the current main tip. That is what the AC asks for
(`merge-base --is-ancestor <tag> <wb>`). It is deterministic, and it does not pull unrelated later main commits into the
working branch during a publish. Right after a landing, `target` is the main tip anyway.

It never moves or creates a tag, never touches the forge release and never pushes with force (constraints). A failure
stays inside `carry.mergeBack`. `ok`/`stage` are decided by the tag and forge steps exactly as today (AC 5).

### 5.4 Shared DTO: `packages/shared/src/protocol/runner.ts` (`ReleasePublishResultSchema`)

Add:

```ts
/** Main merged back into the working branch after tagging; absent when the working branch is the main branch. */
mergeBack: z
  .object({
    branch: z.string(),
    state: z.enum(['fast-forward', 'merged', 'already', 'failed']),
    sha: z.string().optional(),
    signedOff: z.boolean().optional(),
    reason: z.string().max(2000).optional(),
  })
  .optional(),
```

The field is optional, so an older server ignores it (zod strips unknown keys) and an older runner simply does not send
it.

### 5.5 Server: `apps/server/src/release/publish.ts` (`applyReleasePublishResult`, display only)

- In the `done` branch, add one line to the "Released …" desk item body (`lines`):
  - `fast-forward` / `merged`: `` `${base} was merged back into ${branch} (${sha7}).` ``
  - `failed`: `` `Could not merge the main branch back into ${branch}: ${reason}. Merge it by hand; the next release still starts from ${tag}.` ``
  - `already` / absent: no line.
- Optional: carry `mergeBack: { state, reason? }` on the `ReleasePublished` event (`packages/shared/src/events/release.ts`,
  an optional field). This is not needed for the AC. Leave it out unless it is trivial.
- Do not trigger anything (no dispatcher trigger, no deploy, no facts request) because of the merge-back (GWP-145).

No web change is needed. The desk item is the visible release result. `WorkingBranchControl.tsx` stays as it is.

### 5.6 Files touched (summary)

| File | Change |
| --- | --- |
| `apps/runner/src/git/release-facts.ts` | `releasePointOf`, new selection rule in `releaseTagsAt`, `from` in `last`, `componentFactsAt` start, range, `ahead --no-merges` |
| `apps/runner/src/git/release-docs-prep.ts` | pass the main sha, use `last.from` |
| `apps/runner/src/git/release-publish.ts` | `mergeBack` step after tagging |
| `apps/runner/src/git/release-ship.ts` | export `pushFastForward` (already exported) and `escapeRe` (or move it to a helper) |
| `packages/shared/src/protocol/runner.ts` | `mergeBack` in `ReleasePublishResultSchema` |
| `apps/server/src/release/publish.ts` | desk item line |
| `apps/runner/test/release-facts.test.ts`, `apps/runner/test/release-publish.test.ts` | new tests |
| `apps/server/test/…release publish test` (if one exists) | desk line for failed / merged |

## 6. Risks and traps

1. **Wire shape of `lastTag`.** Keep `{ name, sha }` on the wire, and do not leak `from` into the facts result. The
   server compares `lastTag.name` (reconcile, approve, proposal).
2. **Tags made by hand on main count now** (rule "reachable from main"). A hotfix tag `v1.4.1` made on main becomes the
   last release. That is correct for the version bump, and the range starts at the merge base. A repository that keeps
   an older maintenance line as its working branch while main is on a newer major would now see the newer major tag.
   That is not a supported layout in this product (the working branch is merged into main for every release).
3. **Squash landing.** It is only found through the `chore(release): <version>` subject. If someone edits the release
   commit subject, the fallback is the merge base, which can repeat commits. That is no worse than today.
4. **`ahead --no-merges`** changes the number shown on the Ship release item. A branch whose only new commits are merge
   commits now reads 0 (there is nothing to release). That is intended (2.5).
5. **Existing publish tests.** "is safe to repeat" snapshots every origin ref after the first run. The merge-back
   happens in the first run, and the second run gets `already`, so the snapshot still matches. Check that the other
   tests do not assert on `develop`.
6. **Lock and worktree.** `mergeBack` runs inside `publishLocked` (already under `withRepoLock`). It uses its own
   integration directory name (`merge-back-<repoId>`), so it never clashes with `publish-<repoId>` or
   `release-<repoId>`.
7. **Protected working branch.** Pushing to a protected working branch fails, and no PR is opened for the merge-back.
   The owner merges by hand, and the lookup keeps the next release correct. Opening a back-merge PR would be a
   follow-up.
8. **Group order.** GWP-260 reads `releaseTagsAt`/`lastReleaseTagAt`. The `from` field and the new optional `mainSha`
   argument are additive, so GWP-260 builds on top of this card.

## 7. Acceptance criteria and the design

| AC | Design | Test |
| --- | --- | --- |
| Shipped v1 on main (tag on the merge commit), no merge-back: facts report the just-shipped tag | `releaseTagsAt` step 3, `mergedMain` + `releasePointOf` (5.1) | facts test 1 |
| Same situation: bump and commit/changelog range from the just-shipped release, no repeated commits | `range = from..head`, `componentFactsAt` start = `from` (and in `release-ship` through `releasePointOf`) | facts test 1 (commits, `changedCount`, `contentAtTag`), facts test 4 (`componentFactsAt` with a tag name only) |
| After a successful ship, the remote working branch contains the tagged merge commit | `mergeBack` fast-forward / merge + push (5.3) | publish tests A and B (`merge-base --is-ancestor v1.4.0 origin/develop` on the origin repository) |
| A merge-back commit (not a fast-forward) uses the configured identity and DCO sign-off | `requireCommitIdentity` + `commitEnv`, sign-off rule of `landByMerge` | publish test B (author/committer = commitAs, `Signed-off-by` in a DCO repository) |
| A failed merge-back (conflict or protected rejection) keeps the release shipped, the reason is visible, and the next prep still finds the tag | `mergeBack` returns `failed` in `carry`; `ok/stage` unchanged; desk line (5.5); lookup (5.1) | publish tests C and D, then `readReleaseFacts` on the same repository |
| Working branch == main: no extra merge, same last tag | `p.workingBranch !== base` guard; `mainSha === headSha` → today's rule | publish test E, facts test 3 |
| No previous tag: facts unchanged | `last = null` path untouched | existing test "reports every file as changed when there is no tag" plus facts test 3 |
| Existing tests pass; new tests cover each case | | the full `apps/runner` unit suite |

## 8. Tests (builder)

All of them use temporary git repositories (`makeRepo`, `sh` from `apps/runner/test/helpers.ts`), as the existing tests do.

**`apps/runner/test/release-facts.test.ts`**

1. *Shipped, not merged back.* main has v1.3.0. develop gets `feat: a` and `chore(release): 1.4.0` (bumps the version
   file to 0.1.63). On main, `git merge --no-ff develop`, then tag v1.4.0 on the merge commit and push main and the tags.
   Optionally add a hotfix commit on main that changes some other file before the merge, to prove the diff does not
   pick it up. Then add `fix: b` on develop and push. Expect: `lastTag.name === 'v1.4.0'`, `lastTag.sha` = the merge
   commit, `commits` = `['fix: b']`, `components[0].changedCount` counts only b's files, `contentAtTag` is the 0.1.63
   version, `ahead` counts only the non-merge commits.
2. *Same, merged back.* As in 1, but fast-forward develop to main before `fix: b`. Expect the same `lastTag`, commits
   and counts as in 1.
3. *Working branch == main.* `head: 'main'` with tags on main and new commits: the same result as the old rule. Also a
   squash variant: tag v1.4.0 on a single-parent commit on main, with `chore(release): 1.4.0` on develop. Expect
   v1.4.0, and commits after the release commit only.
4. *`componentFactsAt` with a tag name only* (the `release-ship` path): the tag is on the merge commit, main has a
   hotfix; `paths` hold only the develop changes since R.
5. *`ahead` ignores a lone merge-back merge commit.* develop = `merge(develop, main)` after the release: `ahead === 0`,
   `commits === []`.
6. The existing four tests are unchanged.

**`apps/runner/test/release-publish.test.ts`**

- A. *Fast-forward.* `merge` mode in the existing setup (develop = R). Expect `r.mergeBack = { state: 'fast-forward',
  branch: 'develop', sha: M }`, `originRef('develop') === M`, no new commit (develop's parent chain = M's), and
  `merge-base --is-ancestor v1.4.0 develop` succeeds on the origin repository.
- B. *Diverged, DCO.* `setup({ dco: true })`, then push one more commit to develop after R (another file) before
  publishing in `merge` mode. Expect `state: 'merged'`, `signedOff: true`. The develop tip on origin is a merge commit
  with parents [the old develop tip, M], author and committer `Release Owner <owner@example.test>`, a `Signed-off-by:`
  trailer, and the tag is an ancestor. A second run gives `already` and changes no origin ref.
- C. *Conflict.* After R, push a develop commit that changes `notes.txt`. Before publishing, push a main commit that
  changes `notes.txt` differently (it does not conflict with R, so the landing succeeds). Expect `ok: true`,
  `stage: 'done'`, the tag on origin, `mergeBack.state === 'failed'`, a `reason` that contains `notes.txt`, develop on
  origin unchanged, and no leftover integration worktree or `guildwise/integration/merge-back-*` branch. Then
  `readReleaseFacts` (head `develop`, base `main`) reports `lastTag.name === 'v1.4.0'`.
- D. *Protected rejection.* An origin `pre-receive` hook that rejects `refs/heads/develop` with "protected branch"
  (tags and main are allowed, like the existing tag-hook test). Expect `ok: true`, the tag kept, and
  `mergeBack.state === 'failed'` with a reason that contains `protected`. The facts lookup still finds v1.4.0.
- E. *Working branch == main.* `workingBranch: 'main'` with the release commit on main: `mergeBack` is undefined, and
  the origin refs are only the tag added.
- F. The existing tests are unchanged (check "is safe to repeat" and the PR-mode tests).

**Server** (when an `applyReleasePublishResult` unit test exists): a `done` result with
`mergeBack.state === 'failed'` adds the "Could not merge the main branch back" line to the desk item; `merged` adds the
"was merged back" line.

Run: the `apps/runner` unit suite (vitest, the hang-limit rule from the brief), `pnpm -r typecheck` and lint. No
end-to-end suites.

## 9. Manual check (testers / owner)

On a test project with a separate working branch, ship a release in merge mode. Check that the working branch on the
forge contains the tag, and that the "Released" desk item says main was merged back. Make one new commit and refresh
the release facts. The Ship release item shows the just-shipped tag as the last release and only the new commit.
