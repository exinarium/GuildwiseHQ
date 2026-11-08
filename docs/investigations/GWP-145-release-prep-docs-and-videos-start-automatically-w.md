# GWP-145: Release prep (docs and videos) starts automatically when the release is ready on the test site

## 1. Question

Release prep (docs and videos) only starts when a manager clicks **Run release prep**. The card asks:

1. What already exists on `release/1.6.0` for an automatic start or a release "ready" state?
2. What signal means "live on the test site (UAT) and ready to go out"?
3. How can prep start on that signal exactly once per release and head, through the existing manual start path, with a per-project switch that is off by default?

## 2. What already exists on release/1.6.0 (check before planning)

I read the code at `f6b71d8d` (this worktree's HEAD, the same commit as `origin/release/1.6.0`).

| Area | Exists | Notes |
|---|---|---|
| Automatic start of docs prep | **No** | `startReleaseDocsPrep` (`apps/server/src/release/docs-prep.ts:188`) always calls `requireManager` and needs a user. `releaseDocsPrepSweep` (`:966`) only fails steps that have had no answer for 12 hours. Nothing else starts a run. |
| Auto-start setting | **No** | `settingsOf` (`:71`) reads `{ enabled, steps }` from `projects.release_docs_prep` (jsonb). `ReleaseDocsPrepSettingsSchema` / `ReleaseDocsPrepSettingsDtoSchema` (`packages/shared/src/release/docs-prep-dto.ts:56-74`) have no auto flag. |
| Release "ready" state | **No** | The only "ready" values are `repo_release_facts.state='ready'` (facts were read, `facts.ts:163`) and environment card states. There is no state per release. `buildStatus` (`delivery/environments.ts:737`) evaluates a gate only for a `waiting_release` run. |
| How a run was started | **Partly** | `release_docs_prep_runs.trigger` exists with `CHECK (trigger IN ('manual','retry','skip'))`. `started_by uuid` can be null. `started_at` exists. The DTO has `trigger`, `startedBy` (an id, no name) and `startedAt`. The tab shows "Started <date> · a retry". |
| System actor | **Yes** | `SYSTEM_ACTOR` (`commands/common.ts:17`). `finishInline`, `dispatchAction`, `failStepBeforeDispatch`, `sendDocsPrepStepCommand`, `applyReleaseDocsPrepResult` and `docs-prep-changelog.ts:141` already fall back to `SYSTEM_ACTOR` when `run.started_by` is null. |
| One running run per release | **Yes** | Unique partial index `release_docs_prep_one_running (project_id, release_branch) WHERE status='running'`. |
| Serialized starts | **Yes** | `startReleaseDocsPrep` locks the project row (`FOR UPDATE OF p`) inside `withAppendTx`. |
| Hook points | **Yes** | `applyDeployResult` (`delivery/runs.ts:993`) ends with `ctx.services.dispatcher.trigger()`. The dispatcher pass (every 10 s and on trigger) runs `phasePass` (`dispatcher/phases.ts:36`), which already runs `releaseDocsPrepSweep`. |
| Release-branch head per repository | **Yes** | `repo_release_facts.head_sha` / `facts.headSha`. It is refreshed by the repo-sync heartbeat (at most every 30 minutes), by release PRs, by manual refresh, and after a passed prep run. Card merges are `CardFinalized` events (`latestMerge(db, projectId, repoId)` in `delivery/gate.ts:71`). |

**Conclusion:** nothing on this card is already built, so the card is not closed. Only the run's `trigger` column, the nullable `started_by` and the system-actor fallbacks can be reused.

**Sibling cards (re-checked on 2026-11-08 against `origin/release/1.6.0` at `02587bc2`):** GWP-141 and GWP-161 have both landed on `release/1.6.0`, but this card branch was cut before them, so the builder's worktree must contain `origin/release/1.6.0` before starting.

- GWP-141 (`3077ba30`) adds `docsPrepReleaseBranch()` and a private `releaseBranchOf()` in `docs-prep.ts`, and keys every run by the branch all included repositories share. Use `releaseBranchOf` wherever this design says "the release branch". Export it (it is private today).
- GWP-161 (`02587bc2`) adds `guidePaths` to `settingsOf`, to the PUT body (`guidePaths?:`) and to the `ReleaseDocsPrepSettingsSet` payload. Add `autoStart` next to it in the same way: optional in the input, merged with `before`, and part of the `same` comparison.
- The release branch's `startReleaseDocsPrep` (lines 253-350 there) still has exactly the checks listed in 6.3, so the `startChecks` split below applies unchanged. The highest migration there is still `2860_blog_manual_posts.sql`.
- `apps/server/src/delivery/**` and `packages/shared/src/delivery/**` are identical on the card branch and on `release/1.6.0`.

## 3. What a deploy and a test environment are today (facts the design relies on)

- An environment deploys **one** repository: the recipe's `repo` name, else the project's first repository by name (`envRepo`, `delivery/runs.ts:172`).
- An environment's role (`test` / `live` / `other`) is derived in `viewsOf` (`delivery/environments.ts:660`): the guided setup's `role`; else `live` when its target is a production target; else `test` when it deploys `after_merge`; else `other`.
- A successful deploy is a `deploy_runs` row with `status='succeeded' AND NOT trial AND NOT dry_run`, with commit `COALESCE(deployed_commit, commit)` and health `health IS NULL OR (health->>'ok')::boolean`. This is the same filter as `collectGateFacts` (`delivery/gate.ts:100`).
- A gate (`packages/shared/src/delivery/gate.ts`) says what must hold **before an environment may be released**: `envHealthy` (an earlier environment healthy on this commit, optionally for N minutes), `checksPassed`, `phaseDone`, a time `window` and `freeze`. The test environment usually has gate `none`. The live site's default gate is "test copy healthy on the same commit for 10 minutes" (`productionDefaults`, `setup-templates.ts:23`).

Consequences:

1. "The test environment's gate passes" is close to always true (the commit is already on it, and the gate is usually `none`). The live site's gate requirements are what actually describe "ready to go out". This is the owner choice in section 4.
2. A time-based gate (`forMinutes`) and a lagging facts refresh both mean a release can become ready **without any new event**. A hook only inside `applyDeployResult` would miss those cases, so the check must be state-based and re-evaluated on a timer.
3. A repository that no test environment deploys (a library, docs-only repo) can never be "deployed to UAT". The owner must say whether it blocks.

## 4. Owner decision: the ready signal (decided 2026-11-08)

**Decided by the owner on 2026-11-08: o2, and no new automatic run on a new head.** The confirmed definition, which is the one to build:

> A release is **ready** when, for every repository in the release (`docsPrepRepos`):
> 1. its release-branch head is the latest successful, healthy, non-trial, non-dry-run deploy of a test environment that deploys that repository; no newer deploy of that environment is queued or running, and its last finished deploy did not fail;
> 2. that test environment's own gate passes for the head; and
> 3. the **requirements** (`requires`) of every live environment that deploys the repository hold for the head. That covers the recipe gate and the organization's bindings, for example "test copy healthy on this commit for 10 minutes", regression or e2e passed, or the phase is done. The live gate's release `window` and `freeze` are **not** part of readiness. A missing gate preset blocks.
>
> A repository that no test environment deploys is shown as "not checked" and does not block. At least one repository must be checked. A repository that has a test environment but no live environment is judged on 1 and 2 only.
>
> Once the release has any docs-prep run in its current cycle (manual, retry, automatic or skipped), a new head never starts another automatic run. The manager uses Retry or Run release prep.

The options the owner chose between are kept below for the record. Whatever the owner chooses goes into **one** pure function, `releaseReadiness` (section 6.2), so a change touches one place.

| Option | Definition per release repository (repositories = `docsPrepRepos`) | Pros | Cons |
|---|---|---|---|
| o1: the card's default, with a lenient rule for repos that have no test site** | A test-role environment that deploys this repository has, as its **latest** successful, healthy, non-trial, non-dry-run deploy, the release-branch head; no newer deploy of that environment is queued or running; and that environment's own gate passes for the head. A repository that no test environment deploys is listed as "no test site, not checked" and does not block. At least one repository must be checked. | Starts as early as possible, so the docs are ready long before shipping. Simple to explain. Uses facts the server already has. | "Gate passes" adds little (the test gate is usually `none`). |
| **o2 (chosen by the owner): o1 plus the live site's requirements** | o1, and the `requires` of the live environment that deploys the repository (e.g. "test copy healthy for 10 minutes", regression passed, phase done) hold for the head. The live gate's `window` and `freeze` are ignored, so prep is not tied to release hours. | Literally "ready to go out". Reuses the gate the owner approved. | Starts later (it can wait for e2e or a phase to be done), which leaves less time for videos before shipping. More code paths. |
| o3: o1, strict | As o1, but a repository with no test environment makes the release not ready. | Matches the card text word for word. | A release with a library repository never becomes ready, so auto-start never fires. |

Second decision, in every option: **a new head after a run exists**. Proposed: **no** new automatic run. Once the release has any run in its current cycle (manual, retry, automatic, or skipped), the automatic start is done for that release, and the manager uses Retry or Run release prep. This is also the only safe choice by default. A passed prep run pushes its own docs commit onto the release branch, which creates a new head. With "yes", every prep run would make the next one possible, and the rule would have to tell prep's own commits apart from new work.

The owner chose **o2 + no**. Section 6 is written for o2.

## 5. Comparison of how to trigger

| Option | How | Verdict |
|---|---|---|
| A. Hook only in `applyDeployResult` | On `outcome==='succeeded'`, evaluate the release and start. | Rejected. It misses time-based gates, facts that arrive after the deploy, a switch turned on while the release is already ready, and server restarts between the deploy and the check. |
| B. A new background timer | A separate interval. | Rejected. It duplicates the dispatcher loop. |
| **C. A state-based step in `phasePass` (recommended)** | Add `release docs prep auto-start` next to `release docs prep sweep`. `applyDeployResult` already calls `dispatcher.trigger()`, so a UAT success is picked up within one pass (seconds). The 10 s pass covers time-based gates, late facts and restarts. | Chosen. Level-triggered ("ready, switch on, no run in this cycle, so start"), idempotent under the project row lock, and nothing kept in memory is needed for correctness. |

## 6. Design

### 6.1 Data model: migration `apps/server/migrations/2870_release_docs_prep_auto.sql`

Use the next free number after `2860_blog_manual_posts.sql`; check again after merging main.

```sql
-- Release prep can start by itself when the release is ready on the test site.
ALTER TABLE release_docs_prep_runs DROP CONSTRAINT IF EXISTS release_docs_prep_runs_trigger_check;
ALTER TABLE release_docs_prep_runs ADD CONSTRAINT release_docs_prep_runs_trigger_check
  CHECK (trigger IN ('manual', 'retry', 'skip', 'auto'));
-- The release-branch head of each repository the run started on: {"<repoId>": "<sha>"}.
ALTER TABLE release_docs_prep_runs ADD COLUMN IF NOT EXISTS heads jsonb;
-- For an automatic run: the sorted "<repoId>@<sha>" list it started on. At most one automatic run per release and head.
ALTER TABLE release_docs_prep_runs ADD COLUMN IF NOT EXISTS ready_key text;
CREATE UNIQUE INDEX IF NOT EXISTS release_docs_prep_one_auto
  ON release_docs_prep_runs (project_id, release_branch, ready_key) WHERE trigger = 'auto';
```

- Check the real name of the inline CHECK constraint from 2830 first (`\d release_docs_prep_runs`). Postgres names it `release_docs_prep_runs_trigger_check` by default.
- The **setting** needs no migration. It lives in the existing `projects.release_docs_prep` jsonb as `autoStart`. A missing key means off, so every existing project stays off (AC "off by default").
- A new migration puts the card on the high-risk path (second review and owner approval). Say so in the handoff.

### 6.2 Shared (packages/shared)

**`packages/shared/src/release/docs-prep.ts`**

- `ReleaseDocsPrepSettings` gets `autoStart: boolean`, and `DEFAULT_RELEASE_DOCS_PREP` gets `autoStart: false`.
- New pure function, the only place the definition lives (put it in a new file `packages/shared/src/release/readiness.ts` and export it from the release index):

```ts
export interface ReadinessRepoInput {
  repoId: string; repoName: string;
  /** Release-branch head, or null when the branch has not been read yet. */
  head: string | null;
  /** Test-role environments that deploy this repository (empty: no test site). */
  envs: Array<{
    name: string; label: string;
    /** Latest succeeded, non-trial, non-dry-run deploy of this env (any commit), or null. */
    current: { commit: string | null; healthy: boolean | null } | null;
    /** A newer deploy of this env is queued or running. */
    updating: boolean;
    /** The latest finished deploy is a failure newer than `current`. */
    lastFailed: boolean;
    /** The test env's own gate for `head`, or null when it was not evaluated. */
    gate: { satisfied: boolean; missing: string[] } | null;
  }>;
  /** Live-role environments that deploy this repository (empty: none, so only the test check applies). */
  live: Array<{
    name: string; label: string;
    /** The live env's requirements for `head`, window and freeze left out; null when not evaluated (test side not ready). */
    requires: { satisfied: boolean; missing: string[] } | null;
  }>;
}
export interface ReleaseReadiness {
  ready: boolean;
  /** Sorted "<repoId>@<head>" of the checked repositories; null when not ready. */
  key: string | null;
  heads: Record<string, string>;
  repos: Array<{ repoId: string; repoName: string; state: 'ready' | 'not_ready' | 'not_checked'; env: string | null; reason: string | null }>;
  /** The not-ready sentences, one per repository, for the UI. */
  reasons: string[];
}
export function releaseReadiness(repos: ReadinessRepoInput[]): ReleaseReadiness
```

Rules (o2, owner-confirmed). A repository is `ready` when:
- **one** of its test environments meets all of these: `current.commit` matches `head` (same-prefix compare, at least 7 hex characters, like `samePrefix` in `runs.ts`), `healthy !== false`, `!updating`, `!lastFailed`, and `gate?.satisfied === true`; **and**
- **every** entry in `live` has `requires?.satisfied === true`. A `null` there counts as not ready: the loader always evaluates it once the test side is ready.

`not_checked`: `envs` is empty, whatever `live` holds. The release is ready when there is at least one `ready` repository, no `not_ready` one, and no repository with `head === null`. `key` is the sorted `<repoId>@<head>` list of the `ready` repositories. `heads` holds every repository with a known head.

Reason sentences (short SHA = 7 characters; use the environment label, not its name):
- `<repo>: the release branch has not been read yet`
- `<repo>: head abc1234 is not on <Test copy> yet (it runs def5678)` / `... (nothing deployed yet)`
- `<repo>: an update of <Test copy> is running`
- `<repo>: the last update of <Test copy> failed`
- `<repo>: <Test copy> is not healthy on abc1234`
- `<repo>: <Test copy> gate not met: <missing joined with "; ">`
- `<repo>: not ready to go out on <Live site>: <missing joined with "; ">` (for example `the test copy has been healthy on abc1234 for 10 minutes`, using the gate's own `missing` wording)
- `not_checked`: `<repo>: no test site deploys it, not checked`. This is information, not a blocker.
- No checked repository: `No test site deploys any repository of this release`.

If the owner ever changes the definition, only `releaseReadiness` and the loader change. For example "repos with no test site block" (o3) is one line: `not_checked` counts as `not_ready`.

**`packages/shared/src/release/docs-prep-dto.ts`**

- `ReleaseDocsPrepSettingsSchema` (PUT body): `autoStart: z.boolean().optional()`. Optional so that an older client that leaves it out does not turn it off.
- `ReleaseDocsPrepSettingsDtoSchema`: `autoStart: z.boolean()`.
- `ReleaseDocsPrepRunDtoSchema`: `trigger: z.enum(['manual','retry','skip','auto'])`, `startedByName: z.string().nullable()`.
- `ReleaseDocsPrepOverviewItemSchema`: add

```ts
autoStart: z.boolean(),
readiness: z.object({
  ready: z.boolean(),
  repos: z.array(z.object({ repoId: z.string(), repoName: z.string(),
    state: z.enum(['ready','not_ready','not_checked']), env: z.string().nullable(), reason: z.string().nullable() })),
  reasons: z.array(z.string()),
}).nullable(),          // null when the switch is off or the project has no release branch
autoStartBlocked: z.string().nullable(), // why an automatic start did not happen (same sentence as the manual start)
```

**`packages/shared/src/events/release-docs-prep.ts`**

- `ReleaseDocsPrepSettingsSet`: `autoStart: z.boolean().optional()`. Old events replay as off.
- `ReleaseDocsPrepStarted`: `trigger: z.enum(['manual','retry','auto'])`, `startedBy: Id.nullable()`, `heads: z.record(Id, z.string()).optional()`, `readyKey: z.string().optional()`. All changes are additive, so old events still parse.

### 6.3 Server

**`apps/server/src/projections/release-docs-prep.ts`**

- `ReleaseDocsPrepSettingsSet` replaces the whole jsonb. Keep GWP-161's `guidePaths` spread and add `...(p.autoStart ? { autoStart: true } : {})`. An old event without the key replays as off, and the event carries the full settings every time, so a save that leaves out `autoStart` keeps it through `before.autoStart`.
- `ReleaseDocsPrepStarted` also inserts `heads` (`$9::jsonb`, null when absent) and `ready_key`. `ON CONFLICT (id) DO NOTHING` stays. The unique index rejects a second automatic run for the same key, and the insert error rolls back the whole append transaction, so nothing half-done is left (the backstop).

**`apps/server/src/release/docs-prep.ts`**

1. `settingsOf` returns `autoStart: s.autoStart === true` next to GWP-161's `guidePaths`. `getReleaseDocsPrepSettings` returns it. `setReleaseDocsPrepSettings` takes `autoStart?: boolean` in its input (as `guidePaths?`), computes `autoStart = input.autoStart ?? before.autoStart`, includes it in the `same` comparison, and adds it to the event payload. Check that the projection writes the `projects.release_docs_prep` jsonb in a way that keeps `guidePaths` and `autoStart` both. Permission is unchanged: `requireManager` returns the same 403 `forbidden` for non-managers.
2. Split the start in two. The manual path keeps exactly today's behaviour and error codes:

```ts
type Starter = { kind: 'user'; userId: string; retryOf?: string }
             | { kind: 'auto'; heads: Record<string, string>; readyKey: string };

/** Every check and the Started event, in the caller's transaction (project row already locked). */
async function startRunInTx(ctx: Ctx, tx: Tx, p: Row, starter: Starter): Promise<{ runId: string; deliver: string[] }>
```

   - `startReleaseDocsPrep(ctx, user, projectId, opts)`: `requireManager`, lock the project row (as today), then `startRunInTx(..., { kind: 'user', userId: user.id, retryOf })`. Every existing check (`release_docs_prep_off`, `release_docs_prep_requires`, `no_release_branch`, `release_docs_prep_running`, `not_failed`, `release_shipping`, `runner_too_old`, `no_clone`) moves into `startRunInTx` unchanged.
   - In `startRunInTx`: `prepWorkstation(tx, r.id, starter.kind === 'user' ? starter.userId : null)` (null means no own-workstation preference; the SQL already copes with that). The event gets `trigger: retryOf ? 'retry' : starter.kind === 'auto' ? 'auto' : 'manual'`, `startedBy: user ? id : null`, `actor: user ? userActor(id) : SYSTEM_ACTOR`, and `heads` (auto: from readiness; manual: the facts heads of the picked repositories, where known) plus `readyKey` for automatic runs.
   - Also export a **read-only preflight** used by the view, `startBlocker(db, p): Promise<{ code: string; message: string } | null>`. It runs the same checks without starting anything, so the "why did prep not start" sentence is word for word the manual start's sentence (AC on case d). Implement the checks once (for example `startChecks(db, p, userId)` returning either the blocker or `{ repos, branch, picked }`) and have both `startRunInTx` and `startBlocker` call it, so the wording cannot drift.
3. `runDto` adds `startedByName` (`LEFT JOIN users u ON u.id = run.started_by`, `u.display_name`, as elsewhere).
4. `releaseDocsPrepOverview` adds `autoStart`, `readiness` (from `loadReleaseReadiness`, only when the switch is on) and `autoStartBlocked`. `autoStartBlocked` is computed only when `autoStart && readiness.ready && no fresh run`, and then equals `startBlocker(...)?.message ?? null`.

**New file `apps/server/src/release/docs-prep-auto.ts`** (keeps `docs-prep.ts`, already 986 lines, from growing):

```ts
/** Gathers the inputs and returns releaseReadiness(...) for the project's current release. */
export async function loadReleaseReadiness(db: Queryable, project: Row): Promise<ReleaseReadiness & { branch: string | null }>

/** phasePass step: starts release prep for every project whose release just became ready. State based and idempotent. */
export async function releaseDocsPrepAutoStart(ctx: Ctx): Promise<void>
```

`loadReleaseReadiness`:
- `branch = releaseBranchOf(db, project.id, project.working_branch)` (GWP-141); `repos = docsPrepRepos(db, project.id)`.
- head per repository: `loadFacts(db, repo.id)`. If `facts.state` is not `ready` or `headSha` is null, the head is null. If `latestMerge(db, projectId, repo.id)` is newer than `facts.at` and a different commit, use the merge commit as the head (the facts are older than the latest merge, so a new merge immediately makes the release not ready, AC "after new commits"). Otherwise use `facts.headSha`.
- test environments: load the recipe once (`loadRecipeRow`, approved parsed if present, else parsed) and the targets. Use the role rule from `viewsOf`: export a small `envRole(recipeRow, targets, envName)` helper from `delivery/environments.ts` rather than copying the rule. For each environment with role `test`, `envRepo(db, projectId, env.repo)?.id === repo.id`.
- per environment: one query on `deploy_runs WHERE project_id=$1 AND env=$2 AND NOT trial AND NOT dry_run ORDER BY created_at DESC LIMIT 20`, from which you derive `current` (first `succeeded`), `updating` (a `queued`/`running` row newer than `current`) and `lastFailed` (the first finished row is `failed`, or `refused` with reason `expired`, and newer than `current`). Never use `waiting_release`: it is ignored (constraint "never treat waiting_release on another commit as ready").
- test gate: `evaluateEnvGate(db, { orgId, projectId, env: recipeEnv, production: !!target?.production, commit: head, now, repoId })`, only when `current.commit` matches `head` (to save queries).
- live requirements (o2): the environments with role `live` whose `envRepo(...)` is this repository. Evaluate them only when at least one test environment of the repository is ready, using `evaluateEnvGate(db, { orgId, projectId, env: liveRecipeEnv, production: !!liveTarget?.production, commit: head, now, repoId, requiresOnly: true })`. The `production` flag matters: it pulls in the organization's `env_match='production'` gate bindings, which are part of "ready to go out".
- Take the recipe environment (`gate`) from `approved_parsed ?? parsed`, as `environmentsStatus` does (`environments.ts:836`), and the role and label from the same `viewsOf` rule. Export the helper (for example `envRoles(recipeRow, targets): Array<{ name, label, role, target }>`) rather than copying the rule.

**`apps/server/src/delivery/gate.ts`**: `evaluateEnvGate` gets an optional `requiresOnly?: boolean` (default false, so every existing caller is unchanged). When it is true, each effective gate is evaluated as `{ requires: g.gate.requires }`, without `window` and `freeze`. `missingPreset` still returns not satisfied. This is the only change to delivery code. Add one unit test for it (window closed and freeze on, but requirements met, gives satisfied with `requiresOnly`, and not satisfied without it).

`releaseDocsPrepAutoStart(ctx)`:
1. Candidates: `SELECT p.* FROM projects p JOIN organizations o ON o.id=p.org_id WHERE p.status='active' AND p.kind='project' AND o.status IN ('trial','active') AND NOT COALESCE(o.simulation,false) AND COALESCE((p.release_docs_prep->>'enabled')::boolean,false) AND COALESCE((p.release_docs_prep->>'autoStart')::boolean,false)`.
2. Per candidate, cheap pre-filter outside a transaction: `branch` known and `latestRun(db, id, branch) === null` (the fresh rule: a run since the last published ship, including `skipped`). An in-memory 60-second throttle per project (`AUTO_CHECK_MS`) limits gate queries. It is only a cost limit; correctness never depends on it.
3. `loadReleaseReadiness`. If not ready, continue.
4. `withAppendTx`: lock the project row `FOR UPDATE`. Then, **inside the lock**, check again that the switch is on, auto-start is on, `latestRun` is null, and readiness is still ready with the same `key` (recompute it with `tx`). Then `startRunInTx(ctx, tx, p, { kind: 'auto', heads, readyKey: key })`.
5. Catch `AppError` conflicts from the checks (requires, no_clone, runner_too_old, release_shipping, running, no_release_branch). Do not start, `ctx.log.info` once per project and key, and nothing else (the overview shows `autoStartBlocked`). Rethrow other errors so `phasePass`'s step logging records them. A unique violation on `release_docs_prep_one_auto` (`23505`) means another pass already started it, so swallow it.
6. After commit, `deliverPending` for the returned workstations, as the manual path does.

**`apps/server/src/dispatcher/phases.ts`**: add `await step('release docs prep auto-start', () => releaseDocsPrepAutoStart(ctx));` right after the sweep.

**`apps/server/src/delivery/runs.ts`**: no change is needed. `applyDeployResult` already appends `DeployRunFinished` (projected before the trigger) and calls `dispatcher.trigger()`. Do **not** add a direct start call there, to keep a single start path. Optionally, in `applyReleaseFactsResult`, call `ctx.services.dispatcher.trigger()` so a fresh head is evaluated at once (one line, safe).

### 6.4 Why it is idempotent (AC "duplicate events and restarts")

- All starts for a project run under `SELECT ... FROM projects WHERE id=$1 FOR UPDATE`, both manual and automatic. The second of two concurrent passes waits, then sees the first run through `latestRun` and does nothing.
- `latestRun` (fresh rule) covers running, passed, failed and skipped runs of this release cycle, so cases (b) and (c) and "a manual start before ready" block every later automatic start for that release. That meets AC 4 and is stricter than "for that head", which matches the proposed "no restart on a new head".
- The unique partial index `(project_id, release_branch, ready_key) WHERE trigger='auto'` is the database backstop for the same release and head.
- Duplicate `deploy.exec` results are already dropped (`applyDeployResult` returns unless the run is `queued`/`running`). Even if one were not, the pass is level-triggered and starts nothing twice.
- A restart loses only the throttle map. The next pass re-derives everything from the tables.
- Readiness is recomputed inside the lock from the current head, so a run never starts for an old head (AC "no automatic run for the old head").

### 6.5 Web

**`apps/web/src/components/ReleaseDocsPrepPanel.tsx`**: a second checkbox under the main switch, "Start automatically when the release is ready on the test site", with help text: "Release prep starts by itself once the release-branch head of every repository is live and healthy on its test site and meets the live site's release requirements (release hours and freeze do not count). If a run already exists for this release, nothing starts; use Run or Retry." It is disabled when `!canEdit || !enabled || save.isPending`. Send `autoStart` in `change()`, and keep it in local state like `enabled`. Touch: the label row is at least 44 px high on small screens (`min-h-11 sm:min-h-0`, like the tab's buttons), and the whole label is clickable.

**`apps/web/src/api/queries/releaseDocsPrep.ts`**: the settings mutation type includes `autoStart`. No new endpoint.

**`apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx`**:
- Under the panel title, a readiness line when `item.readiness`: "Ready on the test site" (success tone), or "Not ready on the test site yet" followed by `readiness.reasons` as a list (`data-testid="release-docs-prep-readiness"`), with `not_checked` repos in subtle text.
- When `item.autoStart`: the badge or line "Starts automatically when ready". When `item.autoStartBlocked`: a warning `Callout` "Release prep did not start by itself: <message>" (`data-testid="release-docs-prep-auto-blocked"`).
- `RunView`: "Started automatically <date>" when `run.trigger === 'auto'`, else "Started by <startedByName ?? 'someone'> <date>". Keep " · a retry" and " · skipped".

`apps/web/src/pages/Releases.tsx` needs no change unless it reads `trigger` exhaustively; check it with the type checker.

**What's new:** `apps/web/src/whats-new/entries/2026-11-<dd>-release-prep-auto-start.md`, front matter as in `2026-11-05-release-prep.md` (`audience: admin`, `help: /help/phases#release-prep`, `release: 1.6.0`), for example: "Release prep can now start by itself. Turn on **Start automatically when the release is ready on the test site** in the release prep settings, and prep begins as soon as the release is live and healthy on the test site and meets what the live site needs before it goes out. The Release prep tab shows whether the release is ready, why not if it is not, and whether a run was started automatically or by whom."

**Docs:** add one paragraph to `docs/USER-GUIDE.md` (the Release prep section near line 1407) and to `docs/ARCHITECTURE.md` 28d ("Automatic start"). The in-app help `/help/phases#release-prep` should mention the switch if that article lists the settings.

### 6.6 Runner

No change. `ReleaseDocsPrepPayload` carries neither `trigger` nor `startedBy`, and an automatic run sends exactly the same commands. `apps/runner/src/git/release-docs-prep*.ts` stay as they are.

## 7. Risks and traps

1. **Prep's own commit makes a new head.** A passed run pushes `docs(release): ...` to the release branch, so readiness drops to "not ready" afterwards. That is correct and expected; make sure the tab does not present it as an error. With "no restart on a new head" there is no loop.
2. **Stale facts.** Facts refresh at most every 30 minutes. The newer-merge rule covers card merges. A hand push only shows up after the next facts read. Accept this and document it.
3. **Constraint name** in the migration: check it before dropping it (6.1).
4. **GWP-141 first:** the run key is `releaseBranchOf(...)`, not `p.working_branch`. The overview, the auto step and the gate must all use the same branch, or `latestRun` misses runs. GWP-141 is on `release/1.6.0`, but this card branch does not contain it yet.
5. **GWP-161** is on `release/1.6.0` too. It already extends `settingsOf`, the PUT body, the settings event and its projection with `guidePaths`. Add `autoStart` beside it and keep both.
6. **Gate cost:** `evaluateEnvGate` reads up to 300 deploy runs. Call the test gate only when the commit already matches, and the live requirements only when the test side is ready. Keep the 60 s throttle.
6a. **Time-based live requirement (o2).** The default live gate needs "test copy healthy on this commit for 10 minutes", so a release usually becomes ready about 10 minutes after the last test deploy, with no new event. The 10 s pass with the 60 s throttle picks this up. Do not rely on the `applyDeployResult` trigger alone. The tab's reason shows the live gate's own `missing` text, so the manager sees why it is waiting.
6b. **Window and freeze are not readiness.** A frozen live site, or one outside its release window, still counts as ready, so prep runs before the release window opens. This is deliberate: the ship gate still applies when the release goes out.
7. **Turning the switch on while the release is already ready** starts prep within one pass. That follows from the level-triggered design. The help text says so, and it is consistent with "start once ready".
8. **Simulation and research projects** are excluded (candidate SQL, and `startRunInTx`'s existing `isResearchStage || simulation` check gives `no_release_branch`).

## 8. Acceptance criteria and the design

| AC | Where it is met |
|---|---|
| Architect note on what exists on release/1.6.0 | Section 2 (also posted on the card). Nothing exists, so the card is not closed. |
| Owner-confirmed definition written on the card before build | Section 4. The owner answered on 2026-11-08 (o2 + no restart on a new head), and the definition is also posted as a note on the card. |
| One server function, ready / not ready with a reason per repo | `loadReleaseReadiness` (server) around the pure `releaseReadiness` (shared): `repos[].reason`, `reasons`. o2: test head deployed and healthy, test gate passed, and the live env's requirements met (`evaluateEnvGate(..., requiresOnly: true)`). |
| Auto-start on: the last UAT deploy of the head succeeds, so exactly one run, marked automatic | `applyDeployResult`, then `dispatcher.trigger()`, then the `releaseDocsPrepAutoStart` step, then `startRunInTx` with `trigger:'auto'`, `startedBy:null`, `SYSTEM_ACTOR`; lock, `latestRun` and unique index (6.4). |
| Auto-start off (default): no run starts on its own; manual works as before | Candidate SQL needs `autoStart=true`. A missing key means off. The manual wrapper keeps the same checks and codes. |
| No start when a run exists for release and head, when skipped, or when a requirement is missing (and the release shows it) | `latestRun` under the lock. `startRunInTx` conflicts are caught. `autoStartBlocked` comes from `startBlocker`, with the same sentence. |
| Duplicates and restarts never create a second run | 6.4: project row lock, level-triggered state, unique partial index, no in-memory correctness state. |
| New commits: not ready until deployed; no run for the old head | The head comes from facts or a newer merge; readiness is recomputed inside the lock. |
| Only a manager toggles the switch; others get the same forbidden error | `setReleaseDocsPrepSettings` (unchanged `requireManager`). The panel disables it unless `canEdit`. |
| Releases page shows ready state and reason, the switch, and "started automatically" / "started by <user>" | 6.5 (tab, panel, `startedByName`). |
| What's new entry | 6.5. |

## 9. Tests (builder)

Unit, which the builder runs:
- `packages/shared/test/release-readiness.test.ts`: one repo deployed and gate passing gives ready, with a key. One of two not deployed gives not ready, naming that repo. Deploy failed (`lastFailed`), running (`updating`), unhealthy, a different commit, the gate failing, the head unknown: each gives not ready with its sentence. A repo with no test env gives `not_checked` and does not block, but if no repo is checked the release is not ready. o2: the test side ready but a live requirement missing (or `requires: null`) gives not ready with the "not ready to go out on <Live site>" sentence. Two live envs where one fails gives not ready. A repo with a test env and no live env is judged on the test side only.
- `apps/server` unit, or the existing gate test: `evaluateEnvGate` with `requiresOnly` ignores `window` and `freeze` but still enforces `requires` and a missing preset. Without the flag, behaviour is unchanged.
- `packages/shared/test/release-docs-prep*.test.ts`: the settings schema accepts a missing `autoStart`. The events parse old payloads (no `autoStart`, `startedBy` as a string) and new ones (`trigger:'auto'`, `startedBy:null`).
- `apps/web/src/test/release-docs-prep.test.tsx` / `releases.test.tsx`: the panel shows the switch, disabled for non-managers and when prep is off, and saves `autoStart`. The tab shows ready / not ready with the reasons, the blocked callout, "Started automatically" and "Started by <name>".

DB-backed, in `apps/server/test/release-docs-prep.test.ts` (and a new `release-docs-prep-auto.test.ts`). These need Postgres (5433), so leave them for the testers and name them in the handoff:
- The auto-start decision: switch off, no run. An existing run for the release (running, passed, failed, skipped), no run. A missing requirement, no run, and the overview's `autoStartBlocked` equals the manual start's message. Otherwise exactly one run, `trigger='auto'`, `started_by IS NULL`, `Started` event actor `system`.
- Idempotency: two `releaseDocsPrepAutoStart` calls in parallel (`Promise.all`) and one after the other give one run. A forced second insert with the same `ready_key` violates `release_docs_prep_one_auto`.
- End to end on the server: the release head deployed to the test env with the gate passing and the switch on, then `applyDeployResult(succeeded)` and one pass, gives a run with its first step dispatched (a `release.docs_prep` runner command). A new merge gives not ready and no new run. A manual start before ready, then the deploy succeeds, gives no second run. A skip, then the deploy, gives no run.
- Settings: a manager toggles; a non-manager gets 403; the default is off.
- Regression: the existing manual start, retry, skip and ship-gate tests still pass unchanged.
