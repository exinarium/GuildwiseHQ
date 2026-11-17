# GWP-261: release prep must not run or reopen a release after it has shipped

Design report. Status: root cause confirmed. The design below is ready to build.

## 1. Question

After release 1.8.0 shipped, a second release prep run pushed a docs commit on top of the release commit. A new "Ship
release" proposal then appeared, listing items 1.8.0 already contained. Which code path did this? What change stops a
prep run, and the proposal reconcile, from reopening a shipped release, while the GWP-145 rule (ledger e9827290) stays
in force?

## 2. Findings

### 2.1 What the repository shows (first-parent history of `development`, 2026-11-15, +02:00)

| time     | commit     | what                                                                  |
|----------|------------|-----------------------------------------------------------------------|
| 19:10:37 | `5d948e76` | `docs(release): prepare the release documentation for development` (prep run A, before the ship) |
| 19:22:34 | `86993329` | `chore(release): 1.8.0` (release commit R, pushed to `development`)   |
| 19:22:40 | `fa00e31b` | `Merge development into main for release 1.8.0` on **main**, tagged **v1.8.0** |
| 19:25:55 | `6abaa843` | `docs(release): prepare ...`, parent `86993329`: **prep run B, after the ship** |
| 19:42:47 | `dac73abf` | first real change after the release                                   |
| 22:40:54 | `615e6ff7` | `Merge main into development after release 1.8.0` (manual back-merge) |

The same flow puts v1.9.0 on the main merge commit `dfcc2f8e`, and `development` only gets the tag through a manual
back-merge (`77a23d96`). Tags are made by `apps/runner/src/git/release-publish.ts`. It tags the commit on main that
brought R in, so **a release tag is not an ancestor of the release branch until main is merged back.**

### 2.2 Root cause: three faults in a chain (all three candidates on the card play a part)

**F1. The GWP-145 "a run exists" check resets the moment a release is published, and nothing then asks whether there
is anything left to prepare** (candidate a).
`latestRun()` (`apps/server/src/release/docs-prep.ts:520`) counts a run as missing when it started before the newest
`release_ships.published_at` of the project. That is correct for the ship gate. But `releaseDocsPrepAutoStart`
(`docs-prep-auto.ts:164`) reads it as "this release has no run yet". On the next dispatcher pass after
`ReleasePublished`, the automatic start sees no run. If readiness is true, it starts a new run. Readiness is often
already true then:
- after a ship or publish, nothing re-reads the release facts (`requestReleaseFacts` is only called by sync every
  30 min, by manual Refresh, by the release PR flow and by the end of a prep run). So `releaseHead()` still returns the
  **pre-release head** (run A's docs commit). That head has been on the test site long enough to satisfy the o2 gate.
- `startChecks` blocks a start only while a proposal is `approved`. Publish closes the proposal (`released`), and
  that lifts the block.

Run B started this way about one dispatcher pass after the publish. It finished in about 3 minutes, which fits
19:22:40 → 19:25:55. Run B's runner phases then worked on `origin/development`, which is the release commit.
`commitPrepare` (`apps/runner/src/git/release-docs-prep.ts:519`) deliberately *carries the squash commit over onto the
moved tip*. That put the docs commit on top of R.

The run's `trigger` column says whether B was `auto` or `manual` (query in §7). The design closes both ways in.

**F2. The newest tag is ignored because it is on main, not on the release branch** (the cause of the stale items, AC4).
`releaseTagsAt()` (`apps/runner/src/git/release-facts.ts:76`) picks the last tag with `git tag --merged <head>`. After
1.8.0, `v1.8.0` (on `fa00e31b`) is not merged into `development`, so `lastTag = v1.7.0`. Everything keyed on the last
tag then covers the whole of 1.8.0 again:
- facts `commits` = `v1.7.0..head`, so notes from commits list all 1.8.0 work as unreleased.
- `componentFactsAt(lastTag)` diffs from v1.7.0, so components that 1.8.0 already bumped show as bumped again.
- prep `analyse` (`release-docs-prep.ts:202`, same helper) uses base `v1.7.0`. That is why run B wrote a help paragraph
  (`6abaa843` touches `apps/web/src/help/articles/devops-and-hygiene.md`) about work 1.8.0 already documented.
- `baseVersion()` takes v1.7.0. That is the "version below the newest tag" symptom of sibling GWP-262.

**F3. The prep run's own commit raises a proposal, and the de-duplication is bypassed** (candidate c).
When run B passed, `applyReleaseDocsPrepResult` called `requestReleaseFacts(..., 'manual')`
(`docs-prep.ts:1021`). The facts showed `ahead = 1` (`6abaa843` is not on main). `reconcileReleaseProposal`
(`reconcile.ts:99-109`) applies its "same last tag as the last closed proposal" suppression only for trigger `ahead`.
`manual` skips it, so a new Ship release desk item and `ReleaseProposed` were appended. Its notes came from commits
(the `[Unreleased]` section was empty after the release), so the stale 1.8.0 items reappeared. Even with trigger
`ahead`, any later commit (`dac73abf`) would have raised a proposal with the same stale contents, because of F2.

**Candidate (b), a run in flight when the ship happens**, is not what happened on 1.8.0. The ship gate
(`releaseDocsPrepGate`) refuses approval while a run is `running`, and `startChecks` refuses a start while a proposal
is approved. It can still happen: the switch can be turned off while a run is in progress (the gate is then
`allowed`), or a `commit/prepare` or `commit/push` command can already be on a runner. Once there, `commitPrepare`
carries the commit onto the release commit and `commitPush` fast-forwards it. AC2 asks for this path to be closed, so
the design covers it.

### 2.3 What already works and stays

- `applyReleaseDocsPrepResult` ignores answers for a run that is not `running`, so closing the run is enough to stop
  late results from attaching.
- `closeTasksOfEndedRuns` (`docs-prep-tasks.ts:287`) closes queued writer tasks of an ended run.
- The partial unique index on `release_docs_prep_runs (project_id, release_branch) WHERE status='running'` stays.
- The ship and publish flows (`release-ship.ts`, `release-publish.ts`) do not change. Tags are never moved.

## 3. Options

| # | Option | Covers | Verdict |
|---|--------|--------|---------|
| O1 | Change `latestRun` so a pre-ship run still counts after the ship | F1 only | **No.** It would also block the next cycle's legitimate automatic run and change the ship gate. Stale items stay (F2). |
| O2 | Server only: filter release-machinery commits in reconcile and auto start | F1 (partly), F3 | **Not enough.** With `lastTag = v1.7.0` the facts still carry all 1.8.0 commits, which are real changes. |
| O3 | Runner only: fix the last-tag rule | F2 (and so most of F1/F3) | **Not enough.** It does not cover older runners, stale facts at publish time, the `manual` bypass, or a run in flight. |
| O4 | **O2 + O3, plus close in-flight runs on ship, plus a runner push guard, with a server fallback for older runners** | F1, F2, F3, (b) | **Recommended.** |

## 4. Recommendation and design (O4)

Six parts. Each is small. Together they come to about 350-450 changed lines with tests across shared, server and
runner, so the card is **large**.

### D1. Shared: recognise release-machinery commits and real changes (new, `packages/shared/src/release/machinery.ts`, export from `release/index.ts`)

```ts
/** Subject of the release commit made by release.ship. */
export const releaseCommitSubject = (version: string) => `chore(release): ${version}`;
/** Subject of the docs commit made by release prep (server sends it as payload.message). */
export const releasePrepCommitSubject = (branch: string) =>
  `docs(release): prepare the release documentation for ${branch}`;

const RELEASE_COMMIT_RE = /^chore\(release\): v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PREP_COMMIT_RE = /^docs\(release\): prepare the release documentation for \S+$/;
export const isReleaseMachineryCommit = (subject: string) =>
  RELEASE_COMMIT_RE.test(subject.trim()) || PREP_COMMIT_RE.test(subject.trim());

/**
 * Whether the facts show work that no release contains yet: a non-machinery commit since the last release, or a
 * truncated list. `behindRelease`: the facts list the release commit of a published ship whose tag is not the facts'
 * last tag. Only a runner without the D3 rule produces this; it is never treated as new work.
 */
export function releaseChanges(
  facts: Pick<ReleaseFacts, 'commits' | 'commitsTruncated' | 'lastTag'>,
  published: ReadonlyArray<{ tag: string; commitSha: string }> = [],
): { real: number; behindRelease: boolean } { ... }
```

- `real` = `commits.filter(c => !isReleaseMachineryCommit(c.subject)).length`. When `commitsTruncated` is set, return
  `real = Infinity` (or any value > 0).
- `behindRelease` = some published ship `p` with `p.tag !== facts.lastTag?.name` whose `p.commitSha` is in
  `facts.commits` (prefix compare, as `sameCommit` does).
- `apps/server/src/release/docs-prep.ts:895` uses `releasePrepCommitSubject(repo.branch)` and `release-ship.ts:275`
  uses `releaseCommitSubject(p.version)`. The patterns then cannot drift from the messages they match.

Server helper `publishedShips(db, repoId)` → `SELECT tag_name AS tag, commit_sha FROM release_ships WHERE repo_id=$1 AND
status='published' AND commit_sha IS NOT NULL ORDER BY published_at DESC LIMIT 20` (`release/facts.ts`).

### D2. Server: reconcile only raises a proposal for real changes (`apps/server/src/release/reconcile.ts`)

In the "no live proposal" branch, after `if (facts.ahead === 0) return;` and **for every trigger**:

```ts
const changes = releaseChanges(facts, await publishedShips(tx, repoId));
if (changes.behindRelease || changes.real === 0) return; // only release machinery since the last release
```

The rules for an approved or open proposal (rules 1, 2 and 4) stay exactly as they are. Update the doc comment
(rule 3: "something ahead **that is not release machinery**").

`buildProposal` (`proposal.ts`): pass `facts.commits` with machinery commits filtered out **to `notesFromCommits`
only**, so a prep or release commit never shows as a release note. `recommendVersion` keeps the unfiltered list (no
recommendation change in this card, see §5).

### D3. Runner: a release counts as soon as its release commit is on the branch (`apps/runner/src/git/release-facts.ts`)

Change `releaseTagsAt(repoPath, headSha)` so a tag counts for `head` when either:
1. the tag is merged into head (today's rule), **or**
2. head contains that version's release commit: `git log -1 --format=%H --grep=^chore(release): <escaped version>$
   <head>` (same pattern as the `alreadyDone` lookup in `release-ship.ts:107`, so move `escapeRe` to a shared
   runner helper).

`last` becomes `{ name, sha, from }`. `sha` is the tag's commit, unchanged on the wire. `from` is the **cut point** in
head's history: the tag commit for rule 1, the release commit for rule 2. Pick the newest tag by semver among those
that count. To keep it cheap, check tags newest first and stop at the first tag that counts. Rule 2 runs only for tags
newer than the newest merged one.

Use the cut point everywhere the last tag delimits "already released":
- `readReleaseFacts`: `range = ${from}..${headSha}`, and `componentFactsAt(repoPath, rules, from, headSha)`.
- `componentFactsAt(repoPath, rules, lastTag, sha)`: rename the parameter to `since`. Diff `since..sha` and read
  `contentAtTag` at `since` (the release commit has the same version files as the tag).
- `release-ship.ts:217` `commitRelease`: resolve the cut point of `p.lastTag` through the same helper
  (`releaseCutPoint(repoPath, tag, head)`, exported from `release-facts.ts`) before `componentFactsAt`, so the next
  release's bumps are measured from 1.8.0 and not from 1.7.0.
- `release-docs-prep.ts` `analyse`: `base = { kind: 'tag', tag: last.name, sha: last.from }`. `range` and the area diff
  follow from it. `baseTag` stays the tag name, so the ship gate's `baseTag === proposal.last_tag` check keeps working,
  and both sides now agree on v1.8.0.

`facts.lastTag.name` therefore becomes the true newest release. `baseVersion` and `last_tag` follow from it, and the
`ahead`-trigger suppression in reconcile compares like with like.

### D4. Server: the automatic start (and a manual start) needs fresh facts with real changes (`docs-prep-auto.ts`, `docs-prep.ts`)

Add to `docs-prep.ts`:

```ts
/** Whether any repository of the run has work no release contains yet, read after its last publish. */
export async function unreleasedWork(db, projectId, repos: PrepRepo[]):
  Promise<{ state: 'yes' | 'no' | 'unknown'; tag: string | null }>
```

For each repo: `f = loadFacts(db, repo.id)`. The facts are **fresh** when `f.state === 'ready' && f.message === null &&
f.at >= MAX(release_ships.published_at)` for that repo. A failed read also bumps `updated_at`, which is why `message`
is checked. Combined result: `yes` if some fresh repo has `releaseChanges(...).real > 0 && !behindRelease`. Otherwise
`no` if every repo is fresh. Otherwise `unknown`. `tag` = the newest last tag (for the message).

- **Automatic start** (`releaseDocsPrepAutoStart`, before `loadReleaseReadiness` and again inside the transaction):
  start only when `state === 'yes'`. On `unknown`, ask for facts for the stale repos (`requestReleaseFacts(ctx, id,
  'release')`, throttled by the existing 5-minute pending rule) and skip this pass. On `no`, skip and log once per
  project+tag (`'release prep did not start by itself: nothing new since <tag>'`). This also fixes the stale
  `releaseHead`: readiness is only evaluated on facts read after the publish.
- **Manual start / Retry** (`startChecks`): on `no`, throw `conflict('nothing_since_release', `${tag} is released and
  ${branch} has no changes since; there is nothing to prepare.`)`. On `unknown` the manual start goes ahead as today. A
  run on such a head now analyses from the right tag (D3) and commits nothing. `startBlocker` picks this up, so the
  Releases overview shows the sentence instead of "ready".
- GWP-145 is unchanged. `latestRun` keeps its rule, so once any run exists for the new cycle, a new head starts no
  further automatic run. The new check only adds a reason *not* to start.

Publish must re-read the facts at once. In `applyReleasePublishResult` (`publish.ts`), on the `done` path after the
transaction, call `requestReleaseFacts(ctx, ship.repo_id, 'release').catch(() => undefined)`. Add `'release'` and
`'prep'` to `FactsTrigger`. Neither is throttled by `SYNC_MS`, and `applyReleaseFactsResult` maps both to the reconcile
trigger `ahead` (the de-duplication applies). Change `docs-prep.ts:1021` from `'manual'` to `'prep'`. That removes the
F3 bypass. The column is plain `text`, so no migration is needed.

### D5. Server: a run that is still running when its release ships is closed (`docs-prep.ts`, `ship.ts`, `publish.ts`, events)

New `closeRunningPrepForRelease(ctx, tx, projectId, version, reason)` in `docs-prep.ts`:
- `SELECT * FROM release_docs_prep_runs WHERE project_id=$1 AND status='running' FOR UPDATE`. For each run, append
  `ReleaseDocsPrepSkipped { runId, projectId, releaseBranch, skippedBy: null, wasStatus: 'running', reason }`.
- Mark the run's live commands as failed:
  `UPDATE runner_commands SET status='failed', last_error=$reason, done_at=now WHERE type='release.docs_prep' AND
  payload->>'runId'=$1 AND status IN ('pending','sent')`. This is the same pattern as `cancelLiveShipCommands`.
- Call it in the same transaction as `ReleaseCommitted` (`applyReleaseShipResult`, `ship.ts:414`) with reason
  `Release <version> was shipped while release prep was running; prep for it was stopped and nothing more is
  committed.` Call it again on the publish `done` path (`publish.ts:358`), in case a run was started by hand during
  the land step.

Event and projection changes:
- `packages/shared/src/events/release-docs-prep.ts`: `ReleaseDocsPrepSkipped.skippedBy` becomes `Id.nullable()`, and
  add `reason: z.string().max(500).optional()`. Old events still parse.
- Migration `30xx_release_docs_prep_skip_reason.sql`: `ALTER TABLE release_docs_prep_runs ADD COLUMN IF NOT EXISTS
  skip_reason text;`. The projection (`projections/release-docs-prep.ts:228`) writes it, and `skipped_by` may be NULL.
- `ReleaseDocsPrepRunDto` (`packages/shared/src/release/docs-prep-dto.ts`): add `skipReason: string | null`, filled in
  `runDto`. The Releases page run card (web) shows it under "Skipped" when present ("Skipped by the system: <reason>").
  This is the reason the manager can see (AC2).
- The guard in `skipReleaseDocsPrep` against skipping a passed run is not affected.

### D6. Runner: never carry or push a prep commit over a release commit (`apps/runner/src/git/release-docs-prep.ts`)

This guards against a runner that already holds the command when the server closes the run. Add a helper
`releasedSince(repoPath, from, tip)`: `git log --format=%s from..tip` and look for a line matching the release commit
pattern (D1, shared).
- `commitPrepare` (line 519, the "release branch moved" path): if `releasedSince(analysed, tip)`, return
  `failed('<branch> got a release commit while prep was running: nothing was committed. Run prep again for the next
  release.')` instead of cherry-picking.
- `commitPush` (line 577): before the parent check, if the kept commit's parent is not the tip and
  `releasedSince(parent, tip)`, fail with the same sentence. When the parent is the tip, the commit was made after the
  release was already on the branch. That only happens when the server let it through (a manual run on a released
  head). In that case also refuse when `releasedSince(p.summary.headSha ?? parent, tip)`.

No runner capability bump is needed. An older runner keeps today's behaviour. D2/D4/D5 on the server (close the run,
mark commands failed, and the `behindRelease` fallback) still keep it from creating a phantom proposal or a stale
automatic run.

## 5. Scope boundaries and risks

- **GWP-262 overlap (same group, same builder).** D3 makes `facts.lastTag` the true newest release, so `baseVersion()`
  starts at 1.8.0 after a ship. That is the input to the recommendation, not a change to `recommendVersion` or
  `baseVersion`, which this card leaves alone. GWP-262 still adds its own floor at the newest *existing* tag for the
  cases D3 does not cover (for example a tag cut on main with no release commit on the branch). It should build on D3
  and not repeat it.
- **Squash or rebase landing.** Rule 2 in D3 matches the release commit by subject on the release branch, so it works
  whether main got a merge, a squash or a rebase.
- **A hand-made commit titled `chore(release): x.y.z`** would count as a release when tag `vx.y.z` exists. The
  release ship refuses an existing tag, and the subject is reserved for release machinery, so this is acceptable.
  Write it in the D1 doc comment.
- **Multi-repository projects.** `unreleasedWork` is "any repo has real work". The ship gate is per repo and does not
  change.
- **Older runners** report `lastTag = v1.7.0` until main is merged back. `behindRelease` then suppresses a proposal and
  the automatic start. Proposals come back after the back-merge or the runner update. This is a conservative,
  temporary state, and better than a phantom proposal.
- **No rewrite.** Already-pushed commits (`6abaa843`) and tags stay. The fix only acts going forward.
- With the automatic switch off, nothing changes except D2/D3/D5/D6 (the fixes themselves).

## 6. Acceptance criteria → design → tests

| AC | Design | Test (file: case) |
|----|--------|-------------------|
| 1. No automatic run for a shipped version, including when R or a prep commit is the new head | D4 (fresh facts + `real > 0`), D3, D4 publish re-read | `apps/server/test/release-docs-prep-auto.test.ts`: "after a ship and publish, with the release commit as head (facts commits = [chore(release)]), the dispatcher pass starts no run"; same with a prep docs commit as head; "facts older than the publish: no start, facts requested with trigger release" |
| 2. A run in flight at ship ends skipped with a visible reason, and no docs commit lands on the release | D5, D6 | server `release-ship.test.ts`: "ReleaseCommitted closes a running prep run as skipped with reason, its pending release.docs_prep commands are failed, a late step result is ignored, no ReleaseProposed"; runner `release-docs-prep.test.ts`: "commit/prepare and commit/push refuse when the branch got chore(release) since the analysed head" (real git repo) |
| 3. Shipping raises no proposal unless non-release commits follow the newest tag | D2, D4 (`prep`/`release` triggers), D1 | `release-reconcile.test.ts`: "no live proposal, ahead>0, commits only chore(release)+docs(release) → no desk item, for triggers ahead, manual and release"; "behindRelease facts → no proposal"; shared `release-machinery.test.ts` for the patterns |
| 4. Entries and bumps of the shipped release do not show again (1.8.0 case) | D3 | runner `release-facts.test.ts`: build main + development, release commit on development, merge into main, tag the merge (1.8.0 layout), add one feat commit → `lastTag = v1.8.0`, `commits` = only the feat commit, the component `contentAtTag` is the 1.8.0 version, `changedTotal` = files of that commit only. Same layout without the new commit → `commits = []`. `release-docs-prep.test.ts` analyse: base tag v1.8.0 at the release commit. Server `release-reconcile.test.ts`: with those facts plus one real change → proposal raised, notes list only the new change |
| 5. Manual Run/Retry still works on an unreleased head, and GWP-145 holds | D4 (manual refused only on `no`) | existing `release-docs-prep-auto.test.ts` GWP-145 cases stay green; new: "manual start with fresh facts showing a real change starts a run"; "manual start with fresh facts showing nothing since the release → 409 nothing_since_release"; "after a new-cycle automatic run exists, a newer head starts no second automatic run" |
| 6. Automated tests for late result, post-release head and machinery-only reconcile | all of the above | the rows above |

Regression: the existing `release-facts.test.ts` (tag merged into head, rc tags, no tag), `release-ship.test.ts`
(componentFactsAt from the last tag) and the ship gate tests in `release-docs-prep.test.ts` must stay green. Callers of
`releaseTagsAt` / `lastReleaseTagAt` / `componentFactsAt`: `release-facts.ts`, `release-ship.ts`, `release-docs-prep.ts`
only.

## 7. Confirmation query (optional, for the manager or DevOps; read-only)

```sql
SELECT id, trigger, status, started_at, finished_at, skipped_by
  FROM release_docs_prep_runs
 WHERE project_id = (SELECT id FROM projects WHERE key = 'GWP')
   AND started_at BETWEEN '2026-11-15 16:30Z' AND '2026-11-15 18:00Z'
 ORDER BY started_at;
SELECT id, state, trigger, last_tag, recommended_version, head_sha, created_at
  FROM release_proposals
 WHERE project_id = (SELECT id FROM projects WHERE key = 'GWP') AND created_at > '2026-11-15 17:00Z'
 ORDER BY created_at;
```

Expected: run B starts between 17:22:40Z and 17:25Z with trigger `auto` (or `manual`; both are fixed). A proposal
appears about 17:26Z with trigger `manual` and `last_tag = v1.7.0`.
