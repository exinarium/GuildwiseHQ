# GWP-141: Release prep run label and key when repositories set their own release branch

## Question

A project's working branch is `main` and its repositories set `workingBranch: release/x.y`. Release prep (docs and
videos) analyses `release/x.y` in every repository, but stores the run with `release_branch = 'main'`. The tab title then
reads `<project> · main` and the one-run-per-release key is `(project, main)`. Which value should label and key the run,
and where must it change so that every path (start, retry, skip, overview, latest view, ship gate, result handling) uses
the same key?

## What release/1.6.0 already does

`origin/release/1.6.0` and this card branch point at the same commit (`f6b71d8d`), so the code below is the release/1.6.0
code. **Nothing on this card is done yet.** The card should be built, not closed.

Where the release branch is chosen today (`apps/server/src/release/docs-prep.ts`):

| Path | Line | Rule today |
|---|---|---|
| `startReleaseDocsPrep` (also retry, via `retryReleaseDocsPrep`) | 209 | `p.working_branch ?? repos[0]?.branch` |
| `skipReleaseDocsPrep` | 305 | `p.working_branch ?? docsPrepRepos(...)[0]?.branch` |
| `gateInput` (ship gate, used by `loadReleaseDocsPrepGate` and `releaseDocsPrepViewFor`) | 774 | `p.working_branch ?? p.repo_branch` |
| `getReleaseDocsPrepRun(..., 'latest')` (the per-project view) | 916 | `p.working_branch` |
| `releaseDocsPrepOverview` (Releases > Release prep tab, its title) | 945 | `p.working_branch` |
| `applyReleaseDocsPrepResult`, `advance`, steps | – | by `runId` only; no branch lookup |

Other facts that shape the design:

- `projects.working_branch` is `text NOT NULL DEFAULT 'main'` (`migrations/0004_projects.sql:10`). The
  `?? repos[0].branch` part of today's rule never runs against a real row. It is only reachable through the pure helper
  in a unit test.
- `docsPrepRepos` (line 147) already applies `repoReleaseBranch` (`facts.ts:21`) to every repository and keeps only
  those whose release branch differs from their main branch. Its `branch` field is the branch the run analyses
  (`picked[].branch` comes from it, line 255).
- The DB enforces one running run per key: `release_docs_prep_one_running ON release_docs_prep_runs (project_id,
  release_branch) WHERE status = 'running'` (`migrations/2830_release_docs_prep.sql:25`). The projector inserts
  `release_branch` from the event payload's `releaseBranch`, so the key changes with the payload and needs no migration.
- The web tab title (`ReleaseDocsPrepTab.tsx:63`) reads `item.releaseBranch` from the overview item. Fixing the overview
  fixes the title; no web change is needed.
- Per-run code reads the stored `run.release_branch` and follows whatever was stored:
  `docs-prep-steps.ts:31` (guide covered sources), `docs-prep-changelog.ts:120` (changelog covered sources),
  `docs-prep-tasks.ts:374/403` (video shift title and the shift's `project.workingBranch`).
- **The e2e project REL already is the bug's setup.** It is created without a working branch (so `main`, the column
  default) and both repositories are added with `workingBranch: 'release/1.1'` (`e2e/tests/release-docs-prep.spec.ts`
  lines 188–197). Today its runs are stored as `(REL, main)`. The planning note said REL's working branch is
  `release/1.1`; that is not so. No second project is needed in the e2e spec. See the test plan.

## Options for the label and key

1. **Shared effective branch, else today's value (recommended).** The included repositories (`docsPrepRepos`) all have
   the same `branch`: use it. Otherwise (none included, or they differ): `p.working_branch ?? repos[0].branch`, which is
   today's value.
2. **Shared branch, else the first repository's branch.** This is also deterministic, but in the mixed case it labels the
   whole run with one repository's branch, and that label changes when a repository is added whose name sorts first.
3. **Composite label for the mixed case** (for example `release/1.1+release/2.0`). This is honest, but the label then
   changes whenever any repository's branch changes. Retry looks up the latest run by key, so a retry after such a change
   would miss the failed run. It also changes the ship gate's `releaseBranch` text, and the video shift would get a
   working branch that does not exist. It is a wider redesign of the release key and out of scope for a Low card.

**Recommendation: option 1.** It meets requirement 3 with no change at all: when no repository overrides the branch,
every included repository's branch is the project branch, so the result is the project branch, exactly as today. It
fixes the reported case, and the mixed case keeps today's value, which the card names as the default.

### The rule, as it goes on the card (requirement 4)

> A release prep run's release branch (its label and its one-run-per-release key) is worked out from the repositories
> the run includes (`docsPrepRepos`, the same list and branch the run analyses):
> 1. if every included repository has the same release branch, that branch;
> 2. otherwise (no repository included, or repositories on different branches) the project's working branch, or the
>    first included repository's branch (by name, then id) if the project has none.
>
> The same rule is used to start, retry and skip a run, for the Release prep tab, the latest-run view and the ship
> gate. A stored run keeps the branch it was stored with.

Worked examples:

| Project branch | Included repositories (branch) | Run's release branch |
|---|---|---|
| main | alpha release/1.1, beta release/1.1 | release/1.1 |
| release/1.5 | alpha (no override), beta (no override) | release/1.5 (unchanged) |
| main | alpha release/1.1; beta no override, main_branch main (so excluded) | release/1.1 |
| main | alpha release/1.1, beta release/2.0 | main (fallback) |
| main | alpha release/1.1; beta no override, main_branch null (so included on main) | main (fallback) |
| main | none (every repo's release branch equals its main branch) | main; start refuses with `no_release_branch` as today |
| null (unit test only) | alpha release/1.1, beta release/2.0 | release/1.1 (first by name) |

## Design

All changes are in `apps/server/src/release/docs-prep.ts`. `facts.ts` (`repoReleaseBranch`), `docsPrepRepos`, the repos
picked for analysis, the shared DTOs, the projector and the web are unchanged.

### 1. A pure helper (exported for unit tests)

Put it just under `docsPrepRepos`:

```ts
/**
 * The release a run belongs to: its label and its one-run-per-release key. The branch every included repository
 * releases from when they all agree; otherwise (none, or different branches) the project's working branch, else the
 * first repository's. Stored runs keep the branch they were stored with.
 */
export function docsPrepReleaseBranch(
  projectBranch: string | null | undefined,
  repos: readonly { branch: string }[],
): string | null {
  const first = repos[0]?.branch ?? null;
  if (first && repos.every((r) => r.branch === first)) return first;
  return projectBranch ?? first;
}
```

Add a small async wrapper for the read paths that do not already hold the repo list:

```ts
async function releaseBranchOf(db: Queryable, projectId: string, projectBranch: string | null): Promise<string | null> {
  return docsPrepReleaseBranch(projectBranch, await docsPrepRepos(db, projectId));
}
```

The effective-branch rule itself is not copied. The helper only compares the `branch` values that `docsPrepRepos`
already produced with `repoReleaseBranch`.

### 2. Call sites

| Path | Change |
|---|---|
| `startReleaseDocsPrep` line 209 | `const branch = docsPrepReleaseBranch(p.working_branch, repos);`. The running check (217), the retry `latestRun` (226), the `release_shipping` message and the `ReleaseDocsPrepStarted.releaseBranch` payload all use `branch` already. Keep the `repos.length === 0 \|\| !branch` refusal as it is. Research and simulation projects still pass `repos = []` and are refused as today. |
| `retryReleaseDocsPrep` | No change; it calls start. The failed run must be the latest under the same resolved key. |
| `skipReleaseDocsPrep` line 305 | `const branch = await releaseBranchOf(tx, projectId, p.working_branch);` |
| `gateInput` line 774 | `const branch = (await releaseBranchOf(db, proposal.project_id, p.working_branch)) ?? '';`. Drop `repo_branch` from the `loadReleaseDocsPrepGate` SELECT (line 764) if nothing else reads it. |
| `getReleaseDocsPrepRun` 'latest' line 916 | `const branch = await releaseBranchOf(ctx.pool, projectId, p.working_branch); run = branch ? await latestRun(ctx.pool, projectId, branch) : null;` |
| `releaseDocsPrepOverview` line 945 | `const branch = await releaseBranchOf(ctx.pool, p.id, p.working_branch);`, used for both `latestRun` and `releaseBranch` in the item (this is the tab title). |
| `applyReleaseDocsPrepResult` | No change; it finds the run by `runId`. |

The gate change is not listed in the card's affected areas, but it is required. Without it the ship gate keeps looking
under `(project, main)`, finds nothing, and blocks every ship of the e2e project (AC6 of the existing spec would fail).

`docsPrepRepos` adds one query per call. In the overview that is one query per listed project. That is acceptable at
this scale and needs no batching.

### 3. Data model and API

No migration and no event change. `releaseBranch` in `ReleaseDocsPrepStarted` and `ReleaseDocsPrepSkipped` carries the
resolved branch, and the projector stores it as before. The DTOs (`ReleaseDocsPrepRunDto.releaseBranch`,
`ReleaseDocsPrepOverviewItem.releaseBranch`) keep their shape. Stored runs and events are not touched.

## Risks and side effects (say these in the handoff)

1. **Old `(project, main)` runs drop out of the reads.** For a project whose repositories all override the branch, the
   overview, the latest view and the ship gate now look under `release/x.y`. A run stored earlier under `main` no longer
   shows: the tab reads `not_run` and the ship gate blocks until the owner runs prep again or presses Skip. This only
   affects projects in the reported setup, and the card requires that stored runs are not rewritten and are not looked up
   under another key, so this is accepted. It also clears itself at the next published ship, because the freshness rule
   in `latestRun` ignores runs from before it. Release notes should say: "Projects whose repositories use their own
   release branch: run Release prep again (or Skip) once after this update."
2. **First run under the new key re-does work the old key covered.** `guideCoveredSources` and `coveredSourcesFor` look
   up earlier passed runs by `(project, release_branch)`. The first new-key run will not see what a `main`-keyed run
   already covered, so the guide and changelog writers may handle those sources again once. This is a one-off and
   harmless (the writers see the current files), and it follows from risk 1.
3. **An old running `main` run and a new `release/x.y` run can run at the same time** for one project, because they have
   different keys. The card wants exactly that (an old run must not block). Results still land by `runId`.
4. **Mixed branches keep today's label.** In the mixed case the label and key stay `main`, as today. The video shift's
   `project.workingBranch` (`docs-prep-tasks.ts:403`) then still reads the run label, not the repository's branch. The
   reported case gets better (the shift now sees `release/x.y` instead of `main`). The mixed case is unchanged and is
   raised as a separate backlog suggestion, not part of this card.
5. **`repoReleaseBranch` callers** (release facts, release PR, repo sync, manual release) are not touched.

## Acceptance criteria → design

| AC | How it is met | Test |
|---|---|---|
| Architect's note on what release/1.6.0 does | Section "What release/1.6.0 already does": nothing done, so build | – |
| main project, all repos release/x.y → stored `release/x.y` | Helper case 1 in start | server (a), e2e |
| Tab title `<project> · release/x.y` | Overview uses the helper; the title reads `item.releaseBranch` | server overview (a), web, e2e |
| Second start refused as duplicate of release/x.y; an old `(project, main)` run neither blocks nor changes | Running check and DB index use the resolved key | server duplicate test |
| No override → project branch (or first repo's when the project has none); existing tests pass | Helper case 1 with every branch equal to the project branch; case 2 fallback | server (b), helper unit (c), existing suite unchanged |
| Mixed branches → documented fallback, no crash | Helper case 2 | server (d) |
| Retry, skip, overview, project view, result handling find the same run | All use the helper; results go by `runId` | server retry/skip/latest/overview/result test, ship gate test |
| e2e asserts the release/x.y label and key | Extend the existing REL tests (REL already is main + release/1.1) | e2e |

## Test plan

Server (`apps/server/test/release-docs-prep.test.ts`, DB-backed vitest like the rest of that file). In `beforeEach` the
project is on `release/1.5.0` and the repo has no override: the existing tests are case (b) and must pass unchanged.

- (a) `UPDATE projects SET working_branch='main'` and `UPDATE project_repos SET working_branch='release/1.5.0'`. Start:
  `release_docs_prep_runs.release_branch = 'release/1.5.0'`, `GET runs/latest` returns it, and the overview item for the
  project has `releaseBranch: 'release/1.5.0'` with that run.
- Duplicate: in setup (a), pre-seed a `status='running'` row under `(project, 'main')` (insert directly, or start under
  the old setup and then switch the branches). Start succeeds (202). A second start gives 409
  `release_docs_prep_running` whose message names `release/1.5.0`. The seeded `main` row is unchanged (same status,
  `release_branch`, `started_at`).
- Retry: in (a), fail a step and retry with the failed run's id; it is accepted, and the new run is stored under
  `release/1.5.0` with `retry_of` set.
- Skip: in (a), start, then Skip; the same run id becomes `skipped`. Also: Skip with no run records a skipped run under
  `release/1.5.0`.
- Result handling: `runToPassed()` in (a) passes the run, and `latest` shows `passed`.
- Ship gate: in (a), a passed run lets the ship start (reuse the gate tests' facts setup). This guards the `gateInput`
  change.
- (d) Two repositories: add a second `project_repos` row with a different `working_branch` (see the "two repositories"
  guide test at line 338 for how a second repo is added). The run is stored under the project branch, and start, latest
  and skip work.
- Helper unit tests for `docsPrepReleaseBranch` (no DB): all equal → that branch; none → project branch; mixed → project
  branch; project null and mixed → first repo; project null and none → null. (c) can only be reached here, because the
  column is NOT NULL.

Web (`apps/web/src/test/release-docs-prep.test.tsx`): add a case where the overview item has
`releaseBranch: 'release/1.1'` and assert that the title reads `<name> · release/1.1`. This is a regression guard only;
the component does not change.

E2E (`e2e/tests/release-docs-prep.spec.ts`). Under the standing CEO rulings, edits under `e2e/**` belong to the tester,
not the builder. REL is on `main` with both repositories on `release/1.1` (`BRANCH`), so extend the existing tests and do
not add a project:

- In "AC4/AC5/AC8": after the run passes, `SELECT release_branch FROM release_docs_prep_runs WHERE id=$1` equals
  `BRANCH`. The tab title (the `title` that `ReleaseDocsPrepTab` renders for REL) reads `Release project · release/1.1`.
  When the second start is refused, its message contains `already running for release/1.1`.
- Also assert that no run of REL is stored under `main`.
- "AC6" (ship after a passed run), "AC7" (Retry) and "AC7 Skip" then cover the gate, retry and skip under the new key
  without changes. Run the whole spec and the other release specs.

Regression suites to run unchanged: `release-docs-prep*.test.ts`, `release-prep-shift.test.ts`, the release facts,
release PR, repo sync and ship tests (`release-proposal`, `release-ship`, `release-reconcile`, `releases`).

## Out of scope / follow-ups

- The video shift's working branch in the mixed case (risk 4). Raised as a backlog suggestion.
- Any wider redesign of the release key (for example one key per repository) belongs on a separate card.
