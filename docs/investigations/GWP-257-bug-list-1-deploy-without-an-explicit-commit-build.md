# GWP-257: which commit a deploy without an explicit commit builds

Design for the server side of bug 1. The web part (the ReleaseSheet commit field and the preview on screen) is GWP-258 and
uses the shared DTO and the preview route defined here.

## 1. The question

When nobody names a commit, a deploy builds the newest `CardFinalized` merge of the deploy repository. Release commits,
release/docs prep commits, submodule pointer bumps and manual commits are not card merges, so they are skipped and an older
build goes out (14 Nov). The card asks for:

- (a) an environment that deploys releases builds the newest shipped release commit;
- (b) every other environment builds the tip of the deploy repository's working branch;
- the explicit commit a person names still wins, and it is validated (4xx with a reason, no run);
- a read-only preview that returns the same commit the deploy would build, from the same code;
- the resolved commit and its source recorded on the run;
- no change for the other callers of `latestMerge`.

## 2. Findings

### 2.1 Where the wrong commit comes from

`apps/server/src/delivery/runs.ts`:

- `resolveCommit` (l.189): explicit commit, else the commit of the newest healthy, succeeded run of the environment that an
  `envHealthy` gate requirement names ("promote what test runs"), else `latestMerge(db, projectId, repoId)`.
- The trial branch of `requestDeployRunNow` (l.588) calls `latestMerge` directly.
- The non-trial branch calls `resolveCommit` (l.632) and then `evaluateEnvGate` with that commit.

`latestMerge` (`apps/server/src/delivery/gate.ts` l.71) only reads `CardFinalized` events. So whenever a project has at
least one card merge, the server sends a concrete (old) commit in `deploy.exec`.

### 2.2 The runner already knows how to build the branch tip

`apps/runner/src/delivery/exec.ts` `prepareCheckout` (l.229): when `p.commit` is null it runs
`git fetch origin <workingBranch>` and builds `origin/<workingBranch>`. It never gets the chance, because the server always
fills `commit` from `latestMerge`. The fix is therefore server-side resolution, not a new build path on the runner.

### 2.3 The server cannot read the branch tip by itself

The server holds no clones and stores no forge tokens (standing order: tokens stay on the user's workstation). The only
stored head is `repo_release_facts.head_sha` (`apps/server/src/release/facts.ts`), which:

- exists only for repositories whose working branch differs from their main branch (`repoReleaseBranch` returns null
  otherwise);
- is refreshed at most every 30 minutes by the heartbeat (`SYNC_MS`).

It is too stale and too partial to be "the current tip". The tip has to be read on a workstation that holds the clone.

### 2.4 Ways to talk to a runner

- The durable command queue (`enqueueRunnerCommand`, `runner_commands`): asynchronous, answers via `command.result`. The
  card forbids the preview from enqueueing runner commands.
- Live, in-memory request/reply over the runner socket: `RelayHub.forward` (`apps/server/src/webhook-relay/hub.ts` l.337)
  sends with `ctx.services.runners.send(...)` and keeps a `pending` map with a timer. Nothing is stored. Answers take a
  fast path in `RunnerGateway` (`relayAnswer`, `gateway.ts` l.166) so they do not wait behind slower frames. A disconnect
  ends waiting requests as "offline".

The second pattern fits: no queued command and no stored row, and "runner unreachable" becomes a clear, immediate error,
as the card's constraint expects.

### 2.5 Shipped release commits

`release_ships` (migrations 2780, 2790), one row per repository and version:

- `commit_sha`: the `chore(release): <version>` commit that `release.ship` pushed to the working branch
  (`apps/runner/src/git/release-ship.ts`, recorded by `applyReleaseShipResult` and the `ReleaseCommitted` projection);
- `merge_sha` and `tag_sha`: set later, when the release PR lands on the main branch and is tagged.

`status` moves `committing` → `committed` → `tagged` → `published` (or `failed`).

### 2.6 "An environment that deploys releases"

Recipes have no such flag. The project already has one rule for it: the environment role from
`environmentRoles` / `viewsOf` (`apps/server/src/delivery/environments.ts`). It is `live` when the setup says so or when the
target is a production place, `test` for `after_merge` environments, `other` otherwise. Release readiness
(`apps/server/src/release/docs-prep-auto.ts`) already treats `live` environments as the ones a release goes out to.

### 2.7 The `envHealthy` branch (open question from planning)

The default live gate is `{envHealthy: <test>, sameCommit: true, forMinutes: 10}` (docs/design/deploy-run-ux-design.md).
For that gate `resolveCommit` returns what the test environment runs, and the gate then checks the test environment ran
that same commit, healthy. If this branch is dropped, a live deploy would default to the branch tip. The gate would then
refuse it every time the test environment lags behind the tip, so live deploys would stop working by default. The branch
stays (decision in 4.1).

### 2.8 Gate facts that depend on the commit (risk, not a change)

`evaluateGate` (`packages/shared/src/delivery/gate.ts`):

- `checksPassed` with a test run that names no commit only vouches for `latestMergeCommit`;
- `phaseDone` needs the commit to be the merge of a done phase.

When the default becomes a non-card tip, these requirements fail for that tip. `latestMerge` itself does not change; the
gate is right to refuse an untested commit, and the refusal names what is missing. See risks (section 8).

### 2.9 Callers of `requestDeployRun` and the commit they pass

| Caller | Requester | Commit passed | Effect of this design |
|---|---|---|---|
| `routes/delivery.ts` POST `/delivery/deploy` (Deploy button) | owner/admin | optional `commit` | default resolution, or explicit commit validated through the workstation |
| `delivery/environments.ts` `requestRollback` | owner/admin | the earlier run's commit | unchanged; `commitSource: 'rollback'`, no validation |
| `runs.ts` `releaseFromQueue` | owner/admin | `run.commit` of the waiting run | unchanged; carries the waiting run's source, no validation |
| `delivery/triggers.ts` after_merge / phase_done | trigger | the merge commit, or `null` when no pin was sent | explicit unchanged (allow-list); `null` now gets the default |
| `dispatcher/phases.ts` phase follow-up | trigger | none | default resolution |
| `delivery/setup.ts` guided trial | owner/admin, trial | none | default resolution (replaces l.588) |
| `delivery/submodule-pin.ts` | trigger, `pinnedCommit` | the head after the pin | unchanged |
| `delivery/rpc.ts` deploy.run / deploy.trial | devops | optional | explicit unchanged (allow-list); none: default |
| `ceo/actions4.ts` | ceo, or owner when `acceptedFrom` | optional | ceo: as today; owner with a commit: validated (may throw 422, see 5.6) |

## 3. Options

### 3.1 How the server learns the working branch tip

| Option | Fresh | Preview can show it | Runner offline | Card fit |
|---|---|---|---|---|
| A. Stored `repo_release_facts.head_sha` | no (≤30 min, missing for main-branch repos) | yes | works on stale data | fails AC1 |
| B. Send `commit: null`, the runner resolves `origin/<branch>` at build time | yes | no | queued until it comes back | fails preview = deploy, run cannot record the commit up front, `sameCommit` gates see null |
| C. Durable `runner_commands` request plus polling | yes | slow and stores rows | queued | preview may not enqueue commands |
| **D. Live probe over the runner socket (RelayHub pattern)** | yes (fresh fetch) | yes | clear error at once | **fits** |

**Choose D.**

### 3.2 Order of the default

| Order | Live env with the default gate | Card AC2 |
|---|---|---|
| promote → release → tip | gives what test runs even when a release is shipped | fails AC2 |
| **release → promote → tip** | release envs build the release; other gated envs keep promoting | **meets AC2; keeps today's promotion** |
| release → tip (drop promote) | live default gate refuses whenever test lags the tip | breaks today's live flow |

**Choose release → promote → tip** (explicit always first).

## 4. Recommendation and decisions

### 4.1 Resolution order (one function)

1. **explicit**: a commit in the request.
   - Person (owner/admin): validated through the probe; the full SHA is recorded.
   - Automated requester: the existing `automatedCommitAllowed` check only, unchanged, no probe.
   - Server-internal callers set `commitSource` (rollback, release from the queue) or `pinnedCommit`: trusted as today.
2. **release**: the environment's role is `live` and `release_ships` has a shipped release for the deploy repository.
   Use the newest one's `commit_sha`.
3. **promoted**: an `envHealthy` requirement of the environment's gates points at an environment with a healthy,
   succeeded, non-trial run. Use that run's commit. This is today's query, moved into a helper.
4. **working-branch**: the tip of `origin/<branch>`, where branch is `repo.working_branch ?? project.working_branch`.

There is no fallback to `latestMerge`. If the tip (or the commit chosen in 2 or 3) cannot be read on the workstation, the
request fails with a clear reason.

`source` therefore has four values for a preview: `explicit | release | promoted | working-branch`. The card listed three.
`promoted` is added because the `envHealthy` branch stays (2.7), and calling it "working-branch" would be false. A run can
also record `rollback`.

"Shipped release" means `status IN ('committed','tagged','published') AND commit_sha IS NOT NULL`, newest by `created_at`.
`commit_sha` is used, not `merge_sha` or `tag_sha`: it is on the working branch the deploy fetches, so the runner's
`prepareCheckout` finds it, and it is the commit the card calls the shipped release commit.

### 4.2 Same SHA for the preview and the deploy

Both call `resolveDeployCommit`. A push between the preview and the press can still move the tip. The deploy request
therefore gets an optional `expectCommit`. When it is given and the resolved default differs, the request is refused with
409 `commit_moved` (body: expected and resolved), and no run is created. GWP-258 sends the previewed SHA as `expectCommit`,
so what the owner confirmed is exactly what is built, and the source stays truthful (it does not become "explicit").

## 5. Design

### 5.1 Shared (`packages/shared`), lands first (GWP-258 needs it)

`packages/shared/src/delivery/protocol.ts`:

```ts
export const DEPLOY_COMMIT_PROBE_CAPABILITY = 'deploy-commit-probe:1';
```

`packages/shared/src/api/delivery.ts`:

```ts
export const DEPLOY_COMMIT_SOURCES = ['explicit', 'release', 'promoted', 'working-branch'] as const;
export const DeployCommitSourceSchema = z.enum(DEPLOY_COMMIT_SOURCES);
export const DeployRunCommitSourceSchema = z.enum([...DEPLOY_COMMIT_SOURCES, 'rollback']);
const Sha = z.string().trim().toLowerCase().regex(/^[0-9a-f]{7,64}$/, 'a commit is 7 to 64 hex characters');

export const DeployRequestSchema = z.object({
  env: z.string().min(1).max(40),
  commit: Sha.optional(),          // same name, still optional; now also accepts upper case
  /** The commit the preview showed: refused with 409 commit_moved when the default now resolves to another one. */
  expectCommit: Sha.optional(),
  targets: z.array(z.string().max(80)).max(20).optional(),
});

/** GET /api/projects/:id/delivery/deploy/preview */
export const DeployCommitPreviewQuerySchema = z.object({
  env: z.string().min(1).max(40),
  commit: Sha.optional(),
  target: z.string().max(80).optional(),
});
export const DeployCommitPreviewSchema = z.object({
  env: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string().nullable(),
  author: z.string().nullable(),
  committedAt: IsoTime.nullable(),
  source: DeployCommitSourceSchema,
  /** e.g. "release 1.9.0", "what test runs", "tip of release/1.9.0" */
  sourceDetail: z.string().nullable(),
});
```

`DeployRunDtoSchema` gets `commitSource: DeployRunCommitSourceSchema.nullable()` and `commitSourceDetail: z.string().nullable()`.
Map them where the run DTO is built.

`packages/shared/src/events/delivery.ts`: `DeployRunRequested` and the `request` of `DeployRunRefused` get
`commitSource: DeployRunCommitSourceSchema.optional()` and `commitSourceDetail: z.string().max(200).optional()`. They are
optional so stored events still replay.

`packages/shared/src/protocol/runner.ts`, next to `relay.request` / `relay.response`, added to the server→runner and
runner→server unions:

```ts
export const RepoCommitProbeSchema = msg('repo.commit.probe', {
  requestId: z.uuid(),
  remoteUrlNormalized: z.string().max(500),
  branch: z.string().max(250).nullable(),
  /** absent: the tip of origin/<branch>; given: this commit (full or abbreviated) */
  sha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  deadlineMs: z.number().int().positive(),
});
export const RepoCommitProbeResultSchema = msg('repo.commit.probe.result', {
  requestId: z.uuid(),
  ok: z.boolean(),
  sha: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  shortSha: z.string().max(64).optional(),
  subject: z.string().max(300).optional(),
  author: z.string().max(200).optional(),
  committedAt: z.string().max(40).optional(),
  error: z.enum(['no_clone', 'no_branch', 'fetch_failed', 'not_found', 'ambiguous', 'timeout']).optional(),
  message: z.string().max(500).optional(),
});
```

### 5.2 Runner (`apps/runner`)

- New `apps/runner/src/delivery/commit-probe.ts`, `probeCommit(deps, msg)`:
  1. `findRepo(remoteUrlNormalized)`; none: `no_clone`.
  2. `git fetch origin <branch>`, with a timeout of `min(deadlineMs - 1000, 20000)`. A failure gives `fetch_failed` with
     git's first line, masked. For a `sha` whose commit already exists locally the fetch may be skipped.
  3. Rev: the tip is `git rev-parse --verify --quiet refs/remotes/origin/<branch>^{commit}` (missing: `no_branch`). A sha is
     `git rev-parse --verify --quiet <sha>^{commit}`, with a fetch and a retry when it is missing. Then `not_found`, or
     `ambiguous` when git says the short id is ambiguous.
  4. `git log -1 --format=%H%x00%h%x00%s%x00%an%x00%cI <rev>`, then answer.
  It only fetches; it never touches a worktree. `prepareCheckout` already does the same fetch.
- `apps/runner/src/runner.ts`: handle `repo.commit.probe` (beside `relay.request`) and answer with
  `repo.commit.probe.result`. Announce `DEPLOY_COMMIT_PROBE_CAPABILITY` in the capability list (l.~1768, next to
  `DELIVERY_CAPABILITY`).
- `prepareCheckout` stays as it is: an explicit commit that is missing is fetched; null still means the tip.

### 5.3 Server: the probe hub

New `apps/server/src/delivery/commit-probe.ts`, modelled on `RelayHub.forward` / `onResponse`:

```ts
export type ProbeAnswer =
  | { kind: 'commit'; sha: string; shortSha: string; subject: string | null; author: string | null; committedAt: string | null }
  | { kind: 'failed'; error: 'no_clone'|'no_branch'|'fetch_failed'|'not_found'|'ambiguous'|'timeout'; message: string }
  | { kind: 'offline' } | { kind: 'outdated' } | { kind: 'timeout' };

export class CommitProbeHub {
  probe(workstationId: string, req: { remoteUrlNormalized: string; branch: string | null; sha?: string },
        timeoutMs = 25_000): Promise<ProbeAnswer>;   // single-flight per (ws, remote, branch, sha)
  onResult(conn: RunnerConn, msg: RunnerToServerOf<'repo.commit.probe.result'>): void; // ignore late/foreign answers
  onDisconnect(workstationId: string): void;         // pending -> offline
}
```

- `outdated`: the workstation lacks `DEPLOY_COMMIT_PROBE_CAPABILITY` (`workstation_capabilities`, like `lacksCapability`).
- `offline`: `runners.send` returned false, or the runner disconnected.
- Wiring: `Services.commitProbe` in `apps/server/src/context.ts`, constructed in `apps/server/src/app.ts` next to
  `new RelayHub(ctx)`. `RunnerGateway` gets a fast path for `repo.commit.probe.result` (like `relayAnswer`), and the socket
  `close` handler calls `onDisconnect`.

### 5.4 Server: one resolution function (`apps/server/src/delivery/runs.ts`)

Replace `resolveCommit` with an exported `resolveDeployCommit`, and use it in both the trial and the non-trial branches
(removing the direct `latestMerge` call at l.588):

```ts
export interface ResolvedDeployCommit {
  sha: string; shortSha: string; subject: string | null; author: string | null; committedAt: string | null;
  source: 'explicit' | 'release' | 'promoted' | 'working-branch'; sourceDetail: string | null;
  branch: string | null;
}
export type DeployCommitFailure =
  | { code: 'commit_unknown' | 'commit_ambiguous'; status: 422; message: string }   // explicit commit: no run
  | { code: 'commit_unresolved'; status: 409; message: string };                     // tip/release/promoted unreadable

export async function resolveDeployCommit(ctx: Ctx, a: {
  projectId: string; projectBranch: string | null;
  envName: string; live: boolean;                 // role === 'live' (environmentRoles rule)
  repo: EnvRepo | null; gates: Array<{ gate: Gate }>;
  explicit: string | null; workstationId: string;
}): Promise<ResolvedDeployCommit | DeployCommitFailure>;
```

Body: explicit → probe(sha), else `newestShippedRelease(db, repoId)` when `live`, else `promotedCommit(db, projectId, gates)`
(the current `envHealthy` loop, moved), else probe(tip). Every chosen commit goes through the probe, so it is known to exist
in the clone and has its subject and date. Messages, one per cause:

- "`<repo>` names no working branch";
- "the workstation `<name>` that deploys `<env>` is offline, so the tip of `<branch>` could not be read; nothing was deployed";
- "the runner on `<name>` is too old to read the branch: update it, or name a commit";
- "commit `<x>` is not in `<repo>`";
- "`<x>` matches several commits: give more characters";
- "`git fetch` failed: …".

Changes inside `requestDeployRunNow`:

- `RequestDeployInput` gets `commitSource?: 'rollback' | DeployCommitSource` and `expectCommit?: string`. `commitSource`
  is server-internal (like `pinnedCommit`) and never comes from a request body. When it is set, the commit is trusted
  (no probe) and recorded with that source. `requestRollback` sets `'rollback'`. `releaseFromQueue` sets the waiting run's
  `commit_source` (reuse of the waiting run then works as today, because `(open.commit) === commit`).
- Per target, compute `deployWorkstation` **before** the commit, because the probe runs on that workstation. Workstation
  refusals keep `commit: null`. Memoise probe answers per request by `(workstationId, ref)`.
- When the default is resolved (no explicit commit) or a person gives one: call `resolveDeployCommit`.
  - 422 failure: `throw unprocessable(code, message)` before anything is appended (events are only appended at the end of
    the function, so nothing is persisted and no run exists). This is AC4.
  - 409 failure: `refuse('commit_unresolved', message)`, an audited refusal like `no_workstation`.
- `expectCommit` given and the default resolved to another SHA: `throw new HttpError(409, 'commit_moved', …, {expected, resolved})`.
- Automated requester with an explicit commit: today's `automatedCommitAllowed` check, then the commit as given, with
  source `explicit`.
- Rollback: unchanged (source `rollback`).
- `DeployRunRequested` and the `refusedEvent` request carry `commitSource` and `commitSourceDetail`. In the `deploy.exec`
  payload `repo.workingBranch` becomes the resolved branch when `repo.working_branch` is null.
- Leave `automatedCommitAllowed`, `latestMerge` and `MERGE_IN_REPO` untouched.

`envRepo` stays. The role comes from `environmentRoles(db, projectId)` (find by name), so the preview and the deploy use
the Environments page rule.

### 5.5 Server: the preview route

`apps/server/src/routes/delivery.ts`:
`GET /api/projects/:id/delivery/deploy/preview?env=&commit=&target=` (Owner or Admin, the same check as POST `/delivery/deploy`).
It is served by `previewDeployCommit(ctx, user, projectId, query)` in `runs.ts`:

1. Load the recipe (approved parsed, else parsed) and the environment (404 `unknown_env`). Load the repo (`envRepo`) and
   the first active target of the environment (or `target`). Get the workstation with `deployWorkstation` (409 with its
   message), `effectiveGates` for that target's `production`, and the role.
2. `resolveDeployCommit(...)`: 422 / 409 on failure, otherwise 200 `DeployCommitPreview`.

It creates no run, appends no event and enqueues no runner command (the probe is the live socket frame). It is a GET.

### 5.6 Data model

`apps/server/migrations/3010_deploy_commit_source.sql` (take the next free number on main):

```sql
ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS commit_source text
    CHECK (commit_source IN ('explicit','release','promoted','working-branch','rollback')),
  ADD COLUMN IF NOT EXISTS commit_source_detail text;
```

The `DeployRunRequested` and `DeployRunRefused` projections (`apps/server/src/projections/delivery.ts` l.394, l.479) write
both columns, null for old events. `commit` keeps holding the resolved full SHA; `deployed_commit` stays the runner's
answer.

## 6. Acceptance criteria → design

| AC | Where it is met |
|---|---|
| Non-card tip newer than the last card merge → deploy builds the tip | 4.1 step 4; `resolveDeployCommit` probes `origin/<branch>`; `latestMerge` no longer used for the default (5.4) |
| Release env → newest shipped release commit, also when it is not a card merge | 4.1 step 2; `release_ships.commit_sha`, role `live` |
| Explicit valid commit → exactly that commit | 4.1 step 1; full SHA from the probe goes into the run and `deploy.exec` |
| Explicit unknown or malformed commit → 4xx with a reason, no run | malformed: `DeployRequestSchema` (400, with message); unknown or ambiguous: 422 thrown before any event (5.4) |
| Preview returns the same SHA as the next deploy, plus short SHA, subject, date, source | 5.5 calls the same `resolveDeployCommit`; `expectCommit` guards the push-in-between case (4.2) |
| The run records the resolved commit and its source | `commit`, `commit_source`, `commit_source_detail` (5.6), in the run DTO |
| Other `latestMerge` callers unchanged; existing tests pass | `gate.ts`, `automatedCommitAllowed`, `submodule-pin.ts`, `docs-prep-auto.ts` untouched; regression tests (section 7) |
| New tests for the five cases | section 7 |

## 7. Tests (builder)

New `apps/server/test/deploy-commit-resolution.test.ts` (deliveryWorld + FakeRunner announcing `delivery:1` and
`deploy-commit-probe:1`). FakeRunner (`apps/server/test/helpers/fake-runner.ts`) gets an auto-answer for
`repo.commit.probe`, configured per test, for example `r.commits = { tip: B, known: { [A]: {...}, [R]: {...} } }`, like the
`shift.stop` auto-ack.

1. `mergeLanded(A)`, tip B (non-card): deploy without a commit → `deploy.exec.commit === B`, run `commit_source='working-branch'`.
2. Live env (production target), `release_ships` row `committed` with `commit_sha=R`: → R, source `release`. Without a
   shipped release: falls through. A failed ship row is ignored.
3. Owner deploys with explicit C (abbreviated) → full C, source `explicit`.
4. Owner deploys with an unknown SHA → 422 `commit_unknown`, and `deploy_runs` has no new row and no event was appended.
   A malformed SHA gets 400.
5. Preview, then deploy with `expectCommit` = preview SHA → same SHA in `deploy.exec`. The tip moves between them →
   409 `commit_moved`, no run.
6. Probe offline (runner disconnected) → preview 409, deploy refused `commit_unresolved`. Never the card merge.
   Outdated runner (no capability) → the same, with the "update it" message.
7. `envHealthy` gate: the default promotes the test commit (source `promoted`).
8. Regression with fixture A (merge) plus tip B: `collectGateFacts(...).latestMergeCommit === A`, `evaluateEnvGate` gives
   the same verdict as before. `loadReleaseReadiness` head is unchanged. `requestSubmodulePin` still pins from `latestMerge`
   (extend `delivery-submodule-pin.test.ts`). `automatedCommitAllowed` is unchanged: a CEO deploying B explicitly is still
   refused.

Runner: `apps/runner/test/...commit-probe.test.ts` with a temporary origin and clone: tip, known sha, abbreviated, unknown,
ambiguous, missing branch.

**Existing tests that change on purpose.** Deploys without a commit in `deploy-run.test.ts`, `deploy-commit-gate.test.ts`,
`deploy-followup.test.ts`, `deploy-audit.test.ts`, `code-v6-deploy.test.ts`, `deploy-removed-computer.test.ts`,
`delivery-setup.test.ts` and others now need the probe capability and an answer. Assertions that expected the
newest-merge default must expect the tip (or the promoted commit). List each changed assertion in the handoff. Run the
server and runner unit suites only.

## 8. Risks

- **Gates that depend on the commit**: `phaseDone` and commit-less `checksPassed` refuse a non-card tip (2.8). This is
  correct (the tip was not tested), and the refusal names the missing requirement; the owner can name a commit
  (GWP-258). It affects automated phase follow-ups that pass no commit. Note it in the handoff; do not change `latestMerge`.
- **Release env with an untested release commit**: the live default gate (`envHealthy test sameCommit`) refuses R until
  the test environment has run R healthy. The preview shows R and the refusal says why. This is the intended order.
- **Offline workstation**: deploys without a commit (including triggers with `commit: null`) are now refused while the
  deploying workstation is offline, instead of queueing an old commit. The card asks for this.
- **Old runners**: no probe capability means a clear "update the runner" refusal. Runner and server ship together, and
  the message says what to do.
- **Old release commits not in the clone** (the release branch moved on): the probe fetches and then reports `not_found`
  clearly. `merge_sha`/`tag_sha` are deliberately not used (5.1/4.1).
- **CEO action accepted by the owner with a commit** (`ceo/actions4.ts`, requester `owner`): the new 422 throw must be
  caught there and turned into a refused message. Check `runAction`'s error handling.
- **Fetch load**: the preview fetches on every open. Single-flight per key in the hub, and the Owner/Admin role check.
- **Shared DTO first**: GWP-258 depends on 5.1 and the route in 5.5.

## 9. Out of scope

- The web field and the preview on screen (GWP-258).
- Any change to `latestMerge`, gate semantics, release readiness or submodule pinning.
- guildwise-cloud.
