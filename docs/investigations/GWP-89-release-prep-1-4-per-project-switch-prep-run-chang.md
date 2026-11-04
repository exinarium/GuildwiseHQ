# GWP-89 Release prep (docs and videos), part 1/4: switch, prep run, change analysis, commit and ship gate

## 1. Question

Build the frame for an optional stage that runs before the existing ship -> land -> tag -> publish flow: a per-project
switch (off by default) with a checklist of registered steps, a prep run over every repository of the project, the two
steps 'Analyse changes' and 'Commit results', a server-side gate on the ship action, Retry/Skip after a failure, and a
live status panel on the Releases page. The content steps (changelog, user guide, videos) come in GWP-90/91/92 and must
plug in without changing this card's code paths.

## 2. Findings (how the release flow works today)

- **A release is per repository.** `release_proposals` (one live per repo, `release_proposals_one_live`) and
  `release_ships` (id = proposal id, unique per repo and version) are both keyed by repository. The "release branch" is
  the repo's working branch: `COALESCE(project_repos.working_branch, projects.working_branch)`, and a repo whose main
  branch equals it has nothing to release (`requestReleaseFacts` returns `skipped`, `facts.ts:43-45`). There is no
  project-level "release" row. For GWP the release branch is `release/1.5.0` in both GuildwiseHQ and guildwise-cloud.
- **Order of today's flow** (per repo): "Prepare release" (`PrepareRelease` in `WorkingBranchControl.tsx:365`,
  `POST /api/projects/:id/repos/:repoId/release-proposal`, `manual.ts`) -> `repo.release_facts` on a workstation ->
  `ReleaseProposed` + the `ship_release` desk item (`ShipReleaseItem.tsx`) -> the owner approves ->
  `resolveShipReleaseIn` (`approve.ts:24`, checks `factsHeadSha === facts.headSha`) appends `ReleaseApproved` and, in
  the same transaction, `startReleaseShipIn` (`ship.ts:134`, called from `commands/desk.ts:416`) queues `release.ship`.
  The runner (`release-ship.ts`) moves CHANGELOG.md `## [Unreleased]` under the version, bumps component files, commits
  as the project identity and pushes to the working branch. `planReleasePublish` then queues `release.publish`
  (land, tag, publish). A 409 thrown inside `startReleaseShipIn` rolls the approval back: the item stays open.
- **Consequence for the new stage.** The release commit reads the Unreleased section of CHANGELOG.md. The prep stage
  (whose sibling step writes that section) must therefore run and be committed **before the Ship release approval**,
  and the facts the owner approves must be read **after** the prep commit. The single place to enforce the gate is the
  start of `startReleaseShipIn`: it is the only path that creates a `release_ships` row, so land, tag and publish are
  unreachable without passing it.
- **Roles.** `resolveShipReleaseIn` and retry/dismiss are project-owner only. The "project Owner, or an organization
  Owner or Admin" rule already exists in `setCommitAs` (`commands/commit-as.ts:76-90`): `loadVisibleProject` +
  `isOrgManager({orgRole: await orgRoleOf(tx, user.id, p.org_id)})`, else `forbidden(...)`. The web uses
  `project.myRole === 'owner' || useCanConvert(project)` for the Commit as panel and `useCanManageOrg()` on the
  Releases page.
- **Event sourcing and realtime.** Release state is projected from `Release*` events on stream `release-<id>`
  (`projections/release.ts`). The browser gateway forwards visible events and `apps/web/src/ws/invalidate.ts`
  maps a stream kind (`streamId.split('-')[0]`) to query keys. `release` has no case today (release updates ride on the
  desk items created in the same transaction).
- **Runner command pattern.** `packages/shared/src/protocol/runner.ts` holds the capability constant, payload/result
  schemas, the command name list (`:1125`) and `CommandPayloadSchemas` (`:1235`). `runner.ts:2119` dispatches,
  `runner.ts:1431` announces capabilities, `runner-gateway/handlers.ts:587` routes the result to an `apply*Result`
  function. `release-ship.ts` already shows the safe git pattern: `withRepoLock`, `withIntegrationWorktree`,
  `requireCommitIdentity` + `commitEnv`, `detectSignOff`, a kept ref for a made-but-unpushed commit
  (`refs/guildwise/release/<version>`), fast-forward push without force, `isProtectedBranchRejection`,
  `advanceLocalBranch`.
- **Change data.** `readReleaseFacts` (`release-facts.ts`) already finds the last `vX.Y.Z` tag merged into the head,
  lists non-merge commits since it (1000 max) and the changed paths; with no tag it reads the whole history.
- **'Release is live on UAT and ready to go out'.** No such state exists for a release branch. The nearest thing is a
  `deploy_runs` row in `waiting_release` (the delivery release queue, `delivery/queries.ts:116`), which is per
  environment and commit, not per release branch, and is used for every production deploy. Requirement 2's auto-start
  is conditional on such a state existing, so **this card builds manual start only**. A follow-up suggestion is
  recorded in section 9.
- **Name clash.** "release prep 2/4, 3/4, 4/4" names the existing proposal, commit and publish phases
  (ARCHITECTURE 28b/28c, `PrepareRelease`, `usePrepareRelease`). Nothing in the code uses `docsPrep`/`docs_prep`, so
  the new identifiers are free.
- **Tests that exist and must stay green.** Server: `release-ship.test.ts`, `release-publish.test.ts`,
  `release-proposal.test.ts`, `release-reconcile.test.ts`, `releases.test.ts`. Runner: `release-ship.test.ts`,
  `release-publish.test.ts`, `release-facts.test.ts`. Web: `desk-ship-release.test.tsx`, `releases.test.tsx`,
  `releases-panel.test.tsx`, `repo-release-status.test.tsx`, `release-status-line.test.ts`. There is no Playwright spec
  for the release flow yet.

## 3. Options

### 3.1 What a "release" is for prep

| Option | Pro | Con |
| --- | --- | --- |
| A. Per proposal (repo + version) | Matches `release_ships` | The version is only chosen at approval, after prep; a run must span all repos; proposals may not exist yet |
| **B. Per project and release branch** (`projects.working_branch`), covering each repo's effective branch | Matches "the release branch across all repos"; exists before any proposal; one run per release is a simple unique index | A long-lived branch reused for several releases needs a freshness rule (below) |

**Choice: B.** Freshness: a run counts for repo R only if it started after R's newest published ship
(`release_ships.published_at`), and for a passed run the repo's analysed base tag must equal the proposal's
`last_tag`. A branch per release (`release/1.5.0`) never hits these rules; a reused branch (`develop`) does.

### 3.2 Where the files a step produces live between steps

| Option | Pro | Con |
| --- | --- | --- |
| Steps return file contents to the server; the commit step sends them back | Server sees everything | Videos are large binaries; the server should not hold repo content |
| A throwaway worktree kept open across commands | Simple | Lost on restart; locks the clone for the whole run |
| **Local commits on a kept ref per run** (`refs/guildwise/docs-prep/<runId>/work`) on the repo's workstation | Durable across restarts; each step is a short `withRepoLock` + `withIntegrationWorktree`; the same pattern as the kept release ref; nothing leaves the workstation until Commit results | All steps of a repo must run on the same workstation (recorded per repo at start) |

**Choice: kept ref.** Every step command for a repo goes to the workstation recorded for that repo when the run
started.

### 3.3 One command per step or one command per repo

**One `release.docs_prep` command per (step, repo).** That gives per-step, per-repo live status for free, lets a step
read the analysis the server stored, and lets the sibling steps be long (videos) without one giant command. Steps run in
registry order; within a step all repos run in parallel; the next step starts only when every repo finished the current
one.

### 3.4 Commit results: one phase or two

Card rule: if any step fails in any repo, no repo gets a prep commit. A content-step failure stops the run before
Commit results, but Commit results itself can fail in repo B after repo A pushed (no identity in B, a conflict, a
refused push). **Choice: two phases.** `commit` with `phase: 'prepare'` in every repo (make the squash commit locally,
keep it under `refs/guildwise/docs-prep/<runId>/commit`, push nothing); only when every repo prepared does the server
send `phase: 'push'` to each. The only remaining partial case is a push refused in B after A pushed (cannot be atomic
across two remotes): the run fails, shows which repos pushed, and a Retry run is idempotent because A's content is now
on its branch and produces no diff (section 5.5).

### 3.5 Where the gate sits

| Option | Verdict |
| --- | --- |
| Hide/disable "Prepare release" | UI only, and the proposal is read-only anyway: rejected as the enforcement point |
| Refuse in `resolveShipReleaseIn` | Works, but the card names `startReleaseShipIn` |
| **Top of `startReleaseShipIn`** (after the "already committed" short-cut) | Same transaction as the approval, so a 409 rolls the approval back and the item stays open; the only entry to `release_ships`, so land/tag/publish cannot be reached without it |
| Also refuse in `enqueueReleasePublish` / `releaseChecks` | **Not done.** A ship can only exist after passing the start gate; a check here would strand a ship that started before prep was switched on, which breaks "behaves exactly as today". A test proves the publish path is unchanged and unreachable without a gated start. |

`retryReleaseShipIn` resends the stored payload of an existing ship and is not gated (the ship passed the gate when it
started, or started before prep was switched on).

## 4. Recommendation

Build option B with kept refs, one command per step and repo, a two-phase commit, and the gate at the top of
`startReleaseShipIn`. Manual start only. Distinct names everywhere: `releaseDocsPrep` (code), `release_docs_prep`
(SQL), `release.docs_prep` (runner command), `release-docs-prep:1` (capability), `ReleaseDocsPrep*` (events), and the
label **"Release prep (docs and videos)"** in the UI and docs. Nothing existing is renamed.

## 5. Design

### 5.1 Shared (`packages/shared/src/release/`)

New `docs-prep.ts` (exported from `release/index.ts`):

```ts
export type ReleaseDocsPrepStepId = string;            // validated against the registry, not a z.enum
export interface ReleaseDocsPrepStepDef {
  id: ReleaseDocsPrepStepId;     // 'analyse' | 'commit' here; 'changelog' | 'guide' | 'videos' from the siblings
  label: string;                 // 'Analyse changes', 'Commit results'
  description: string;           // one line for the checklist
  order: number;                 // analyse 10, (changelog 20, guide 30, videos 40), commit 1000
  defaultOn: boolean;            // true for both steps here
  producesFiles: boolean;        // analyse false, commit false (it commits what the others produced)
  last?: true;                   // only 'commit'
}
const STEPS: ReleaseDocsPrepStepDef[] = [ANALYSE_STEP, COMMIT_STEP]; // siblings append one import + one entry
export const releaseDocsPrepSteps = (): readonly ReleaseDocsPrepStepDef[] => sorted by order, 'last' forced last;
export const isReleaseDocsPrepStep = (id: string) => ...;
export const enabledReleaseDocsPrepSteps = (settings) => registry steps with settings.steps[id] ?? def.defaultOn;

export type ReleaseDocsPrepRunStatus = 'running' | 'passed' | 'failed' | 'skipped';
export type ReleaseDocsPrepStepState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type ReleaseDocsPrepState = 'off' | 'not_run' | ReleaseDocsPrepRunStatus;   // what the page shows

// state machine, pure
export function canTransitionStep(from, to): boolean;   // pending->running|skipped, running->passed|failed|skipped
export function canTransitionRun(from: RunStatus | 'not_run', to): boolean;
//   not_run->running|skipped, running->passed|failed|skipped, failed->skipped (Skip after a failure)
export function nextReleaseDocsPrepAction(run: RunSnapshot):
  | { kind: 'dispatch'; step: string; phase?: 'prepare' | 'push'; repoIds: string[] }
  | { kind: 'wait' }
  | { kind: 'finish'; status: 'passed' }
  | { kind: 'finish'; status: 'failed'; step: string; repoId: string; error: string };
//   first step (in run.steps order) with a non-finished repo; any failed repo -> finish failed (later steps stay
//   pending and are shown as "not run"); commit: prepare for all repos, then push for all; repos in state 'skipped'
//   (no release branch on origin) are skipped for every later step.

// the gate, pure
export function releaseDocsPrepGate(i: {
  enabled: boolean;
  releaseBranch: string;
  run: { id: string; status: RunStatus; startedAt: string } | null;   // latest run for (project, release branch)
  repo: { inRun: boolean; baseTag: string | null; commitSha: string | null } | null;
  lastPublishedAt: string | null;           // newest published ship of this repo
  proposalLastTag: string | null;
  facts: { headSha: string; commitShas: string[]; truncated: boolean } | null;
}): { allowed: true } | { allowed: false; code: 'release_docs_prep_required'; message: string };
```

Gate rules (each refusal message names "Release prep (docs and videos)" and the release branch):
off -> allowed (no reads beyond the switch). No run, or run older than `lastPublishedAt` -> "has not run for
release/1.5.0". `running` -> "is still running". `failed` -> "failed at <step> in <repo>: Retry or Skip it on the
Releases page". `skipped` -> allowed. `passed` -> refuse if the repo was not in the run, if `baseTag !== proposalLastTag`
("ran for an earlier release"), or if `commitSha` is set and the facts do not contain it (`headSha === sha ||
commitShas.includes(sha)`; when `truncated`, accept) with "its commit is not in the repository read yet: press Refresh
on the Ship release item"; otherwise allowed.

New `docs-prep-dto.ts`: `ReleaseDocsPrepSettingsSchema = z.object({enabled: z.boolean(), steps: z.record(z.string(),
z.boolean())})` (unknown step ids refused on the server with 400 `unknown_step`), `ReleaseDocsPrepSettingsDto`
(`enabled`, `steps: [{id, label, description, enabled}]`, `canEdit`), `ReleaseDocsPrepRunDto` (id, releaseBranch,
status, trigger `manual|retry`, retryOf, startedBy/At, finishedAt, failed `{step, repoId, repoName, error}`,
skippedBy/At, `steps: string[]`, `repos: [{repoId, repoName, branch, state, baseTag, headSha, commitSha, pushed,
steps: [{step, state, startedAt, finishedAt, error, files}]}]`), `ReleaseDocsPrepSummarySchema` (below),
`ReleaseDocsPrepOverviewItem` (projectId, key, name, enabled, releaseBranch, state, canAct, run summary), and
`ReleaseDocsPrepGateView` (`{blocked: boolean, message?: string, link: string}`).

Change summary (`ReleaseDocsPrepSummarySchema`, the output of 'analyse', stored per repo, at most about 256 KB):

```ts
{ repoName, branch, headSha, base: { kind: 'tag', tag, sha } | { kind: 'main', branch, sha },
  commitCount, commits: [{ sha, subject, author, date }] (newest 300; `commitsTruncated`),
  merges: [{ sha, subject, cardKeys: string[], prNumber: number | null }],
  cards: [{ key, title | null }],                  // keys found in commit/merge subjects and bodies, titles added by the server
  areas: [{ area, files: number, added, modified, deleted, paths: string[] (first 50) }] }
```

Area = the name of the repo's first component rule that covers the path (`componentRuleApplies`), else the first two
path segments (`apps/server`, `packages/shared`, `docs`), else the top folder or `(root)`.

New events in `packages/shared/src/events/release-docs-prep.ts` (registered like `releaseEvents`):

| Event | Stream | Payload |
| --- | --- | --- |
| `ReleaseDocsPrepSettingsSet` | `project-<id>` | projectId, enabled, steps (record), setBy |
| `ReleaseDocsPrepStarted` | `releasedocs-<runId>` | runId, projectId, releaseBranch, steps[], repos[{repoId, branch, mainBranch, workstationId}], trigger, retryOf?, startedBy |
| `ReleaseDocsPrepStepStarted` | same | runId, repoId, step, phase?, commandId |
| `ReleaseDocsPrepStepFinished` | same | runId, repoId, step, phase?, state, error?, files[], summary? (analyse), baseTag?, headSha?, commit?, pushed? |
| `ReleaseDocsPrepFinished` | same | runId, status 'passed' or 'failed', step?, repoId?, error? |
| `ReleaseDocsPrepSkipped` | same | runId, projectId, releaseBranch, skippedBy, wasStatus ('not_run' or 'failed' or 'running') |

Add `releaseDocsPrep: (id) => \`releasedocs-${id}\`` to `ids.ts` (the kind must not start with `release-`, so the web
can route it). The events carry the actor (`userActor`), which is the audit trail for Start, Retry and Skip, as for the
existing `ReleaseApproved` and `ReleaseProposalClosed`.

Runner protocol (`protocol/runner.ts`): `RELEASE_DOCS_PREP_CAPABILITY = 'release-docs-prep:1'`, command
`'release.docs_prep'` in the command list and `CommandPayloadSchemas`:

```ts
ReleaseDocsPrepPayloadSchema = z.object({
  runId: z.uuid(), projectId: z.uuid(), repoId: z.uuid(), remoteUrlNormalized, forge?,
  releaseBranch: z.string().min(1).max(200), mainBranch?: string,
  step: z.string().max(40), phase: z.enum(['prepare','push']).optional(),   // phase only for 'commit'
  components: ComponentRuleSchema[] (for areas), projectKey,               // analyse
  summary?: ReleaseDocsPrepSummarySchema,                                    // every step after analyse
  base?: { sha, tag | null },                                                // every step after analyse
  message?: string,                                                          // commit message
  commitAs: CommitAsSchema.nullable().optional(), signOff?: boolean });
ReleaseDocsPrepResultSchema = z.object({ ok, state: 'passed'|'failed'|'skipped', error?: max 4000,
  summary?, files: string[] (max 500), commit?: sha, pushed?: boolean, alreadyPushed?: boolean, notices: string[] });
```

### 5.2 Server

**Migration `apps/server/migrations/2830_release_docs_prep.sql`** (check the newest number when building; 2820 is the
newest today):

```sql
-- Release prep (docs and videos): the per-project switch and its runs. Off for every project.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS release_docs_prep jsonb NOT NULL
  DEFAULT '{"enabled": false, "steps": {}}'::jsonb;

CREATE TABLE IF NOT EXISTS release_docs_prep_runs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_branch text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','passed','failed','skipped')),
  steps text[] NOT NULL DEFAULT '{}',
  trigger text NOT NULL CHECK (trigger IN ('manual','retry','skip')),
  retry_of uuid,
  started_by uuid, started_at timestamptz NOT NULL, finished_at timestamptz,
  failed_step text, failed_repo_id uuid, error text,
  skipped_by uuid, skipped_at timestamptz,
  updated_at timestamptz NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS release_docs_prep_one_running
  ON release_docs_prep_runs (project_id, release_branch) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS release_docs_prep_latest ON release_docs_prep_runs (project_id, release_branch, started_at DESC);

CREATE TABLE IF NOT EXISTS release_docs_prep_repos (
  run_id uuid NOT NULL REFERENCES release_docs_prep_runs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
  branch text NOT NULL, main_branch text, workstation_id uuid,
  state text NOT NULL CHECK (state IN ('pending','running','passed','failed','skipped')),
  base_tag text, base_sha text, head_sha text, summary jsonb,
  commit_sha text, pushed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, repo_id));

CREATE TABLE IF NOT EXISTS release_docs_prep_steps (
  run_id uuid NOT NULL REFERENCES release_docs_prep_runs(id) ON DELETE CASCADE,
  repo_id uuid NOT NULL, step text NOT NULL, phase text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('pending','running','passed','failed','skipped')),
  command_id uuid, started_at timestamptz, finished_at timestamptz, files text[] NOT NULL DEFAULT '{}', error text,
  PRIMARY KEY (run_id, repo_id, step, phase));
```

No data migration is needed: the column default sets every existing project to off.

**Projection** `apps/server/src/projections/release-docs-prep.ts` (registered in `projections/index.ts`, tables added to
the rebuild list): `ReleaseDocsPrepSettingsSet` updates `projects.release_docs_prep`; the run events insert/update the
three tables. `ReleaseDocsPrepSkipped` with no run row inserts one with `trigger 'skip'`, `status 'skipped'`, empty steps.
Replay-safe (`ON CONFLICT DO UPDATE`).

**Module `apps/server/src/release/docs-prep.ts`** (beside `ship.ts`):

- `requireDocsPrepManager(tx, user, projectId)`: `loadVisibleProject` (404 for outsiders) then project owner or
  `isOrgManager(orgRoleOf(...))`, else `forbidden('only the project Owner or an organization Owner or Admin can do this')`
  (403). Same rule as `setCommitAs`.
- `getReleaseDocsPrepSettings` / `setReleaseDocsPrepSettings` (no event when nothing changed; 400 `unknown_step`).
- `releaseBranchOf(project)` = `projects.working_branch`; `docsPrepRepos(tx, projectId)` = non-removed repos with
  `branch = COALESCE(r.working_branch, p.working_branch)` and `branch <> r.main_branch` (the same rule as
  `requestReleaseFacts`; extract it there as a small helper so both read one rule). Research-stage and simulation
  organizations are refused (409 `nothing_to_prepare`), as for facts.
- `startReleaseDocsPrep(ctx, user, projectId, {retryOf?})`, one `withAppendTx`:
  1. role check; `SELECT ... FROM projects WHERE id=$1 FOR UPDATE` (serializes two starts);
  2. 409 `release_docs_prep_off` when the switch is off; 409 `no_release_branch` when no repo has a separate release
     branch;
  3. 409 `release_docs_prep_running` ("Release prep (docs and videos) is already running for release/1.5.0, started
     at 10:02. Wait for it to finish.") when a running row exists for (project, branch);
  4. 409 `release_shipping` when any of the repos has an approved proposal (`release_proposals.state='approved'`):
     prep belongs before the approval, a commit after it would not be in the release;
  5. pick a workstation per repo like `shipWorkstation` but with `RELEASE_DOCS_PREP_CAPABILITY`
     (own workstation first); none -> 409 `no_clone` / `runner_too_old` naming the repo;
  6. append `ReleaseDocsPrepStarted` (steps = `enabledReleaseDocsPrepSteps` in registry order, frozen for the run);
  7. `advance(ctx, tx, runId)`; deliver the workstations after commit (as `applyReleaseShipResult` does).
- `retryReleaseDocsPrep` = start with `retryOf`, only when the latest run is `failed` (409 `not_failed`); trigger
  `retry`. A new run, never a resend.
- `skipReleaseDocsPrep(ctx, user, projectId)`: role check, allowed when the latest run is `failed`, `running` or absent
  (`not_run`); refused when `passed` or already `skipped` (409). Appends `ReleaseDocsPrepSkipped` (who and when). A
  skipped running run ignores late answers.
- `advance(ctx, tx, runId)`: loads the run snapshot, calls `nextReleaseDocsPrepAction`; `dispatch` appends
  `ReleaseDocsPrepStepStarted` and `enqueueRunnerCommand(tx, workstationId, 'release.docs_prep', payload)` per repo
  (`commitAs: await loadCommitAs(tx, projectId)` on every command, as `queue()` in `ship.ts` does; `summary`/`base` from
  the stored analysis; the commit message `docs(release): prepare the release documentation for <branch>`);
  `finish` appends `ReleaseDocsPrepFinished`; after a passed run, `requestReleaseFacts(ctx, repoId, 'manual', {userId})`
  for every repo that got a commit (outside the transaction), so the Ship release item reads the prep commit.
- `applyReleaseDocsPrepResult(ctx, workstationId, payload, ok, result, error)`: in `withAppendTx`, `FOR UPDATE` on the
  run; ignored unless the run is `running`, the step row is `running` and the workstation matches; appends
  `ReleaseDocsPrepStepFinished` then `advance`. A transport failure (`ok:false`) is a failed step with git's message.
- `loadReleaseDocsPrepGate(db, proposal)`: reads the switch, the latest run for (project, the repo's release branch),
  the repo's run row, the newest `published_at`, `loadFacts`, and calls the shared `releaseDocsPrepGate`.
- `releaseDocsPrepSweep(ctx)` in `dispatcher/phases.ts` beside `releaseChecks`: a running step with no answer for
  12 hours fails with "no answer from <workstation> within 12 hours" (so a lost workstation cannot block Retry forever).

**Gate in `ship.ts`**: in `startReleaseShipIn`, after `if (done) return undefined;` and before `shipWorkstation`:

```ts
const gate = await loadReleaseDocsPrepGate(tx, proposal);
if (!gate.allowed)
  throw conflict(gate.code, gate.message, { projectId: proposal.project_id, link: releaseDocsPrepLink(proposal.project_id) });
```

`loadReleaseDocsPrepGate` returns `{allowed: true}` after reading only `projects.release_docs_prep` when the switch is
off: no other query, no behaviour change. Nothing else in `ship.ts`, `publish.ts`, `approve.ts` or the runner's
`release-*.ts` changes behaviour.

**Gate in the views**: `releaseViewFor` (`approve.ts`) and the repo DTO's `releaseProposal` add an optional
`docsPrep?: ReleaseDocsPrepGateView` only when the switch is on (absent when off, so the item and the repo row render
exactly as today).

**Routes** `apps/server/src/routes/release-docs-prep.ts` (registered in `app.ts`):

| Route | Who | Answer |
| --- | --- | --- |
| `GET /api/projects/:id/release-docs-prep/settings` | any member | `ReleaseDocsPrepSettingsDto` with `canEdit` |
| `PUT /api/projects/:id/release-docs-prep/settings` | project Owner, org Owner/Admin (else 403) | the DTO |
| `GET /api/release-docs-prep` | org members | `ReleaseDocsPrepOverviewItem[]` for visible projects with the switch on or any run |
| `GET /api/projects/:id/release-docs-prep/runs/latest` and `/runs/:runId` | any member | `ReleaseDocsPrepRunDto` with summaries |
| `POST /api/projects/:id/release-docs-prep/runs` | Owner/Admin | `{runId}`; 409s above |
| `POST /api/projects/:id/release-docs-prep/runs/:runId/retry` | Owner/Admin | `{runId}` of the new run |
| `POST /api/projects/:id/release-docs-prep/skip` | Owner/Admin | 204 |

**Gateway**: `runner-gateway/handlers.ts`, a `release.docs_prep` branch next to `release.ship`: `completeCommand(...)`
then `applyReleaseDocsPrepResult`.

### 5.3 Runner (`apps/runner/src/git/`)

New `release-docs-prep.ts`, entry `runReleaseDocsPrep(input: {payload, repoPath, integrationDir, auth})`, always under
`withRepoLock(repoPath, ...)`, never throws for expected failures (like `shipReleaseCommit`). Refuses unsafe refs with
`isSafeGitRef`. Kept refs: `refs/guildwise/docs-prep/<runId>/work` (the step commits) and
`refs/guildwise/docs-prep/<runId>/commit` (the squash commit before push).

- **analyse**: fetch `origin <branch>`, `origin <main>` and tags (as `readReleaseFacts` does; reuse
  `resolveReleaseBase`). Branch missing on origin -> `state: 'skipped'`, `error: "the release branch '<b>' does not exist
  on origin"`. Base = the newest release tag merged into the head (extract the tag selection from `readReleaseFacts` into
  an exported `lastReleaseTagAt(repoPath, headSha)` and use it in both, no second copy), else `merge-base origin/<main>
  head`. Commits `git log --no-merges base..head` (newest 300 kept, count all), merges `git log --merges --first-parent
  base..head` (card keys by `\b<PROJECTKEY>-\d+\b` and generic `\b[A-Z][A-Z0-9]+-\d+\b` in subject and body; PR number
  from `Merge pull request #N` or `(#N)`), files `git diff --name-status -z base head` grouped into areas. Writes
  nothing. Deletes kept refs `refs/guildwise/docs-prep/*` of other run ids (left by an earlier failed run).
- **content steps** (none in this card; GWP-90/91/92): `withIntegrationWorktree` from `work` ref (or `base.headSha` the
  first time), call the handler from `release-docs-prep-steps.ts` (`Record<stepId, (ctx: {worktree, payload,
  summary}) => Promise<{ok, files: string[], error?}>>`), `git add -- <files>`, refuse files outside the handler's list
  (like `commitRelease`'s "unexpected changes"), local commit with `requireCommitIdentity` + `commitEnv`, update `work`.
  A step that changes nothing makes no commit. Contract for sibling steps, written in the file header: a step must
  produce byte-identical files when its content is already on the branch (needed for idempotent retries).
- **commit, phase prepare**: no `work` ref or `tree(work) == tree(head)` -> passed, no commit ("no changes"). Else
  fetch the branch; tip == analysed head: `git commit-tree tree(work) -p tip` with the message, the identity
  (`commitEnv`), `--signoff` trailer when `detectSignOff` asks; tip moved: in an integration worktree from tip,
  cherry-pick the squash (conflict -> failed "the release branch moved and the prepared files conflict: run prep again").
  Store under `.../commit`. No push.
- **commit, phase push**: `.../commit` already an ancestor of `origin/<branch>` -> passed `alreadyPushed`. Else push
  `sha:refs/heads/<branch>` without force. Extract the push + protected-branch message of `pushCommit`
  (`release-ship.ts:300-310`) into an exported `pushFastForward(repoPath, sha, branch, auth)` and use it from both (no
  behaviour change for `release.ship`). On success delete the kept refs and `advanceLocalBranch`. Never a tag, never
  the main branch: the target ref is always `refs/heads/<releaseBranch>` and the command refuses when `releaseBranch ===
  mainBranch`.

`runner.ts`: announce `RELEASE_DOCS_PREP_CAPABILITY`; dispatch `release.docs_prep` like `release.ship` (no clone ->
`{ok:false, state:'failed', error:'no local clone for ...'}`); after a pushed commit trigger `this.sync.sync(...)` as
`release.ship` does. `RUNNER_VERSION` is raised by the release commit itself (RUNNER.md), not by hand.

### 5.4 Web

- **Settings**: new `components/ReleaseDocsPrepPanel.tsx` in `pages/ProjectSettings.tsx` beside `CommitAsPanel`, titled
  "Release prep (docs and videos)": a switch (default off) and a checklist of the registered steps (from the settings
  DTO, so only registered steps show). `canEdit` from the server; read-only (disabled controls with a line "Only the
  project Owner or an organization Owner or Admin changes this") for members. Errors inline, never a toast. Touch:
  `min-h-11` targets, full-width stacked on small screens.
- **Releases page**: a new tab `prep` "Release prep" in `pages/Releases.tsx`, shown to everyone **only when**
  `GET /api/release-docs-prep` returns at least one project (with the switch off everywhere the page is exactly as
  today). `components/delivery/ReleaseDocsPrepPanel.tsx` (or `releases/`): per project and release branch, the state
  badge (off / not run / running / passed / failed / skipped), start and end times, per repo a row per step with its
  state, the change summary (collapsible: base, commit count, cards, merges, areas), errors in full, commit SHAs (and
  "no changes" for a repo without a commit), who skipped and when. Actions for `canAct`: "Run release prep" (not run,
  passed, skipped), "Retry prep" and "Skip prep for this release" (failed), "Skip prep for this release" also while not
  run or running (with a confirm dialog). Each project block has an anchor id (`release-docs-prep-<projectId>`), the
  target of the gate links (`/releases?tab=prep#release-docs-prep-<projectId>`).
- **Live**: `ws/invalidate.ts` gets `case 'releasedocs': return [['release-docs-prep'], ['desk'], ['projects'],
  ['project']];` and the project stream case adds `['release-docs-prep']` (settings change). New hooks in
  `api/queries/releaseDocsPrep.ts` keyed `['release-docs-prep', ...]`.
- **Gate in the UI**: `ShipReleaseItem.tsx` shows a `Callout` with `rel.docsPrep.message` and a link "See release prep"
  when `rel.docsPrep?.blocked`, and disables Approve; it also shows a 409 `release_docs_prep_required` from the server
  in that callout rather than under the version field. `WorkingBranchControl.tsx` `PrepareRelease` shows the same line
  and link under the status when `repo.releaseProposal?.docsPrep?.blocked`. Both are unchanged when `docsPrep` is
  absent (switch off).

### 5.5 Failure, retry and idempotency

- A failed content step or a failed `commit/prepare`: the run fails, nothing was pushed anywhere, kept refs stay local
  and are deleted by the next run's analyse.
- A refused `commit/push` in repo B after repo A pushed: the run fails at commit in B; A shows its SHA and "pushed". Retry
  starts a new run: analyse reads A's branch with the prep commit in it, the content steps produce identical files, A has
  no diff and gets no commit; B is prepared again from its kept ref or from scratch. No duplicate commits or content.
- A repeated `commit/push` command (redelivery) answers `alreadyPushed` when the commit is on origin.
- Skip after a failure appends `ReleaseDocsPrepSkipped` and the gate opens: the ship flow is exactly today's.

## 6. Acceptance criteria mapping

| AC | Design | Test |
| --- | --- | --- |
| New or migrated project is off; flow unchanged | column default off; gate returns allowed after reading the switch; `docsPrep` absent in DTOs; prep tab hidden | server: migration default + existing release-ship/publish tests unchanged; web: Releases page and ShipReleaseItem snapshots unchanged when off |
| Only owner/org admin edits; member 403, read-only UI | `requireDocsPrepManager` on PUT, start, retry, skip; `canEdit`/`canAct` | server DB test per role (owner, org admin, member 403, outsider 404); web panel read-only test |
| Prep on, no passed run: server refuses ship naming release prep; page links | gate at top of `startReleaseShipIn`, 409 `release_docs_prep_required` with link | server: approve the ship item with prep on and no run / running / failed -> 409, approval rolled back; web: callout and link |
| Analyse on two repos stores a summary each, commits since previous tag | `analyse` step, `release_docs_prep_repos.summary` | runner temp-repo test (tag and no-tag cases); server test with two repos; web summary render |
| Commit results commits, identity, pushes, SHAs, no-change repo no commit | two-phase commit, `commitEnv`, `pushFastForward` | runner test with two bare remotes, a test-only step handler writing a file in one repo; asserts author/committer, branch head, no commit in the other |
| After a passed run the ship flow starts and completes | gate `passed` + facts contain the commit; facts refresh after the run | server: passed run + facts with the SHA -> `startReleaseShipIn` queues `release.ship` |
| Any failure: no commit, ship blocked, failing step/repo/error; Retry new run, Skip unblocks; owner/admin, audited | `nextReleaseDocsPrepAction` stops before commit; events with actor | shared state machine; server retry/skip role + event actor; runner retry after simulated push failure |
| Second run while running is refused | project row lock + partial unique index, 409 `release_docs_prep_running` | server DB test (two starts; concurrent via two transactions) |
| Checklist shows only registered steps; siblings add steps without changing this card's paths | shared registry; runner handler map; checklist from DTO | shared registry tests (order, `last`, unknown id); web checklist renders from DTO |

## 7. Tests to write (unit only in the build shift)

- `packages/shared`: `release-docs-prep.test.ts` (registry order and `last`, defaults, enabled steps, every step and run
  transition, `nextReleaseDocsPrepAction` for each case incl. a skipped repo and two-phase commit, the gate for every
  state with the switch on and off, freshness by published date and base tag, facts containment and truncation).
- `apps/server` (DB-backed): `release-docs-prep.test.ts` (default off after migration; settings roles; start/retry/skip
  roles and events with actor; concurrent start refused; `release_shipping`; result handling and advance; sweep) and
  additions to `release-ship.test.ts` (gate on/off at `startReleaseShipIn`, approval rolled back, publish path
  unchanged).
- `apps/runner`: `release-docs-prep.test.ts` with temp repos and bare remotes (analyse with and without a tag, areas,
  card keys; commit only where changed; identity; push to the release branch only; prepare-fails-nothing-pushed;
  retry after a refused push makes no duplicate). `release-ship.test.ts` must stay green after `pushFastForward`.
- `apps/web`: settings panel (edit vs read-only), Releases prep tab (each state, actions by `canAct`, tab hidden when
  empty), ShipReleaseItem and PrepareRelease blocked states, `invalidate.ts` case.
- For the testers (not run in the build shift): Playwright specs under `e2e/tests/` for the plan's scenarios (prep off
  unchanged; prep on with Analyse + Commit on a seeded two-repo project; forced failure, blocked ship, Skip, ship). There
  is no existing release e2e spec today.

## 8. Risks

- **Facts after the prep commit.** The owner may open the Ship release item before the refreshed facts arrive. The gate
  refuses with a "press Refresh" message instead of letting a stale approval through.
- **Partial push across repos** cannot be atomic; covered by the two-phase commit and idempotent retry (5.5), and shown
  on the page.
- **Reused release branch** (`develop`): freshness by the last published ship and the base tag. Manual tags made
  outside the flow have no `published_at`; the base-tag check still catches a passed run of an earlier release.
- **Workstation loss mid-run**: the 12-hour sweep fails the step; Skip is always available.
- **Event size**: the summary is capped (300 commits, 50 paths per area, about 256 KB) because it is in the event
  payload and forwarded to browsers.
- **Turning prep on mid-release**: ships already started are not affected (gate only at start), by design.
- **Do not touch** tag/title naming (GWP-49 ruling) or the existing "release prep 2/4-4/4" names.

## 9. Open points and follow-ups

- Auto-start on "live on UAT and ready to go out": no such state exists for a release branch (section 2), so it is not
  built. Suggested follow-up: start prep automatically when a recipe environment marked as the test site finishes a
  deploy of the release branch head, once the owner decides which signal means "ready to go out".
- Docs to update in the build: `docs/ARCHITECTURE.md` new section "28d. Release prep (docs and videos)" (after 28c, with
  a pointer from 28b/28c that the gate sits in `startReleaseShipIn`), `docs/USER-GUIDE.md` 4.28 Releases (the switch in
  Project settings, the Release prep tab, Run/Retry/Skip, the blocked Approve) and `docs/RUNNER.md` (`release.docs_prep`,
  capability `release-docs-prep:1`).
