# GWP-215 (GWP-212.2): per-project "post as" app selection, with an explicit fallback when no app is selected

Design report. First written on `development` at 22b3e1fe, before GWP-214 landed. **Revised on `main` at ff4ba644**,
after GWP-214 (app integrations) landed: §6 records the check of every assumption against the landed code. Assumption 3
(the runner broker API) did not hold as written, and the migration number was taken. The sections changed by the
revision are marked **(revised)**. Everything else stands as first designed.

## 1. Question

Each project picks which workspace app integration (from GWP-214, a GitHub App first) its agents post as. The effective
commit identity is resolved in one place per repository, in this order: **selected app covering the repository ->
project "Commit as" -> repo/global/system git config**. That answer travels to the runner with every shift and every
git command. With no app selected, nothing changes. With an app selected, the shift fails closed: it never quietly
falls back to the owner's identity or token.

## 2. Findings (current code)

| Area | What is there today | Relevance |
|---|---|---|
| `packages/shared/src/repo/commit-identity.ts` | `CommitAsSchema`, `SetCommitAsRequestSchema`, `COMMIT_IDENTITY_SOURCES = project/repo/global/system`, `RepoIdentityFactSchema`, `COMMIT_IDENTITY_SOURCE_LABEL`, `CommitAsResponseSchema` (setting plus one row per workstation clone) | Add `'app'` here. The response gets additive fields. |
| `packages/shared/src/forge/index.ts` | `FORGE_KINDS`, `detectForgeKind(url, override)`; `project_repos.forge_kind` is the manual override | **Answers the planner's open point:** each repository's forge kind is already in the shared model (`detectForgeKind(remote_url, forge_kind)`). |
| `packages/shared/src/events/project.ts:150` | `ProjectCommitAsSet {projectId, commitAs, setBy}` | The model for the new selection event. |
| `apps/server/src/commands/commit-as.ts` | `loadCommitAs`, `withCommitAs` (adds `commitAs` to `shift.start`), `getCommitAs`, `setCommitAs` (project Owner or org Owner/Admin) | Gets a sibling `post-as.ts`. |
| `apps/server/src/projections/commit-as.ts`, migration `1970_commit_as.sql` | `projects.commit_as jsonb`; `workstation_repos.git_identity jsonb` (a runner fact, not an event) | Same pattern: `projects.post_as jsonb` comes from an event, coverage is a runner-fact table. |
| Payloads that carry `commitAs` | `shift.start` (protocol/runner.ts:2156), `release.ship` (958), `release.publish` (1038), `repo.bump_submodule` (1101), `run.start.rebaseCard` (runs/types.ts:136), `repo.create` (repo/index.ts:116), docs-prep (release/docs-prep-dto.ts:203), `finalize.execute` (server finalize.ts:207) | Server call sites: `dispatcher.ts:462`, `devops.ts:178`, `ba-tasks.ts:224`, `questions.ts:140` (via `withCommitAs`), `finalize.ts:207`, `release/ship.ts:136`, `release/publish.ts:79`, `release/docs-prep.ts:664`, `delivery/submodule-pin.ts:95`, `repo-create.ts:447,614`. Line numbers are from the first pass and may have moved by a few lines. |
| `apps/runner/src/git/identity.ts` | `resolveCommitIdentity(cwd, commitAs)` / `requireCommitIdentity` / `commitEnv` / `committerEnv`; about 25 call sites | The single runner resolver. `shifts/supervisor.ts:1131` resolves once per shift, for `msg.worktree.remoteUrlNormalized`. |
| `apps/server/src/commands/shifts.ts:1493` | A `shift.rejected` whose detail starts with `no_commit_identity:` raises a desk alert (`noCommitIdentityNotice`) and the card goes back to the queue; three identical rejections in a row raise a storm item | Same mechanism for `app_identity_failed:`. |
| Runner capabilities | `hello.capabilities`, filtered in `dispatcher/candidates.ts:241` (`READONLY_DESIGN_CAPABILITY`); bound raised to `MAX_HELLO_CAPABILITIES = 200` (GWP-235) | Needed so an older runner can never receive work for an app-selected project and quietly commit as the owner. Room for one more entry. |
| Commands with results | `enqueueRunnerCommand` plus `command.result` routed in `runner-gateway/handlers.ts` (for example `applySubmodulePinResult`, `applyAppCommandResult`) | The pattern for the new `app.access_check`. |
| Audit | `governance/audit-export.ts` exports every user-actor event in the org scope | The new event shows up in Org settings > Audit log with no extra work. |
| **(revised)** GWP-214, shared: `packages/shared/src/apps/index.ts` | `APP_PROVIDER_IDS = ['github-app']`, `AppProviderIdSchema`, `AppIdentitySchema` (`host`, `appId`, `installationId`, `botLogin`, `commitName`, `commitEmail`, …), `appInstance(appId, installationId)` = `"<appId>:<installationId>"`, `APP_ERROR_CODES` and `APP_ERROR_TEXT` (one non-secret sentence per code), `APP_INTEGRATIONS_CAPABILITY = 'app-integrations:1'`, runner commands `app.connect/test/adopt/remove/sync` | Provider enum, error codes and the instance key are reused as they are. |
| **(revised)** GWP-214, events: `packages/shared/src/events/apps.ts` | `OrgAppIntegrationAdded/Updated/Shared/Unshared/Removed` (stream `app-integration-<id>`, org scope) | `OrgAppIntegrationRemoved` is the documented contract for this card's fallback. |
| **(revised)** GWP-214, server: migration `2970_app_integrations.sql`, `projections/app-integrations.ts`, `commands/org-apps.ts` | Table `org_app_integrations` (uuid `id`, `org_id`, `provider`, `label`, `host`, `app_id`, `installation_id`, `bot_login`, `commit_name`, `commit_email`, `status` active/removed, `removed_at`); table `org_app_integration_workstations` (which workstations hold the key; rows deleted on removal); per-workstation state in `workstation_integrations` (`kind = provider`, `instance = app_id || ':' || installation_id`, `status->>'state'`); `listOrgApps` (`GET /api/org/apps`) | The registry the selection refers to. Removal is a soft delete: the row and its label stay. |
| **(revised)** GWP-214, runner: `apps/runner/src/apps/broker.ts`, `types.ts`, `store.ts`, `github-app.ts` | `AppTokenBroker.getAccessToken(instance, {repositories?, permissions?}) -> {token, expiresAt}` (memory only, single flight, refreshed with 10 minutes left), `withToken(instance, scope, fn)` (one retry on 401), errors are `AppTokenError {code: AppErrorCode, message}`; a workstation without the key throws `installation_not_found` ("This app is not connected on this workstation."); `AppKeyStore.get(instance).refs = [{orgId, integrationId}]`; `githubApiBase(host)`; the runner holds one broker (`runner.ts` `appBroker()`) | Keyed by **instance**, not by integration uuid: see §6 assumption 3. |

## 3. Options compared

**A. Where the selection lives**
- A1: a new column on `projects` (`post_as jsonb`), the projection of a new event. **Chosen.** Same shape as
  `commit_as`, additive, easy to audit.
- A2: put it inside `commit_as`. Rejected: it changes the wire format of `commitAs`, so old events and existing payloads
  would no longer stay byte-for-byte the same.

**B. Coverage check (can the installation reach repository X?)**
- B1: the runner reports the installation's whole repository list with its integration status, and the server works out
  coverage. GWP-214 did not ship such a list (its status facts carry state, refresh time and error only), and lists can
  be large.
- B2: a new runner command `app.access_check` for the project's repositories on that forge. The runner uses the GWP-214
  broker to list `GET /installation/repositories` and match the names. The result is stored as a fact per (project,
  repo, integration). **Chosen.** It is what requirement 2 describes ("the runner checks ... and reports"), it does not
  depend on GWP-214's status shape, and it can be re-run.

**C. What crosses the wire**
- C1: send the selected app only, and let the runner work out coverage. Rejected: the runner would need the coverage
  facts, and the panel and the shift could disagree.
- C2: the server resolves each repository with one shared pure function and sends `postAs.repos[]`. The runner obeys
  `source`. **Chosen.** One decision point, used by both the panel and dispatch.

**D. Coverage unknown (never checked, or the check errored)**
- D1: use the fallback. Rejected: this quietly uses the owner's identity while an app is selected, which breaks
  requirement 5.
- D2: treat it as `app` (fail closed). The runner tries to mint; if it cannot, the shift stops with the app's name and
  the reason. **Chosen.** The fallback is used only when a check recorded `not_covered` (the panel says so) or the app
  was removed.

**E. Removed app vs disconnected app**
- Removed (`org_app_integrations.status = 'removed'`): the project keeps the reference, the panel says "app removed,
  using fallback" and resolution falls back (AC 8). The selection is not cleared automatically, so the history stays
  intact and the owner can see it.
- Disconnected or error (the app exists but cannot mint): stays `app` and fails closed. The panel warns that shifts will
  stop.

## 4. Recommendation and design

### 4.1 Shared (`packages/shared`)

New file `packages/shared/src/repo/post-as.ts`, re-exported from `repo/index.ts`:

```ts
import { AppProviderIdSchema, type AppProviderId } from '../apps/index.ts';   // (revised) GWP-214's enum, reused

/** Which forge each app provider posts to. Kept here; GWP-214 has no forge mapping. */
export const APP_PROVIDER_FORGE: Record<AppProviderId, ForgeKind> = { 'github-app': 'github' };

/** Only the reference is stored in settings and events: never a key or token. */
export const PostAsAppRefSchema = z.object({ integrationId: z.uuid(), provider: AppProviderIdSchema });
export const SetPostAsRequestSchema = z.object({ apps: z.array(z.object({ integrationId: z.uuid() })).max(8) });

/** The public identity of the bot (from org_app_integrations). Not a secret. */
export const PostAsAppIdentitySchema = PostAsAppRefSchema.extend({
  label: z.string().max(80),          // org_app_integrations.label
  botName: z.string().max(140),       // commit_name ('<slug>[bot]')
  botEmail: z.string().max(254),      // commit_email ('<id>+<slug>[bot]@users.noreply.<host>')
  // (revised) the runner broker is keyed by the instance, not the integration uuid; both are public ids
  instance: z.string().max(200),      // appInstance(app_id, installation_id)
  host: z.string().max(200),          // org_app_integrations.host (github.com or a GHES host)
});

export const POST_AS_FALLBACK_REASONS = ['no_app_for_forge', 'not_covered', 'app_removed'] as const;

/** Resolved per repository by the server. The runner obeys `source`; 'repo' = the runner reads git config as today. */
export const PostAsRepoSchema = z.object({
  repoId: z.uuid(),
  remoteUrlNormalized: z.string().min(1).max(500),
  source: z.enum(['app', 'project', 'repo']),
  app: PostAsAppIdentitySchema.optional(),              // present iff source === 'app'
  fallbackReason: z.enum(POST_AS_FALLBACK_REASONS).optional(),
});
export const PostAsPlanSchema = z.object({ repos: z.array(PostAsRepoSchema).max(200) });

export const APP_IDENTITY_FAILED_CODE = 'app_identity_failed';
```

Do not name anything in shared `APP_PROVIDERS`: the runner already has `APP_PROVIDERS` (the provider factory map in
`apps/runner/src/apps/providers.ts`).

**The single resolution function** (pure, shared, used by both the server panel and the dispatch payloads):

```ts
export function resolvePostAsRepo(i: {
  repo: { repoId: string; remoteUrlNormalized: string; forge: ForgeKind };
  selected: ReadonlyArray<SelectedAppState>;   // {ref, identity|null, removed: boolean}
  access: (integrationId: string, repoId: string) => 'covered' | 'not_covered' | 'error' | null;
  commitAs: CommitAs | null;
}): PostAsRepo {
  const app = i.selected.find((s) => APP_PROVIDER_FORGE[s.ref.provider] === i.repo.forge);
  const fallback = (reason?: FallbackReason) =>
    ({ ...base, source: i.commitAs ? 'project' : 'repo', ...(reason ? { fallbackReason: reason } : {}) });
  if (!app) return fallback(i.selected.length ? 'no_app_for_forge' : undefined);
  if (app.removed || !app.identity) return fallback('app_removed');
  if (i.access(app.ref.integrationId, i.repo.repoId) === 'not_covered') return fallback('not_covered');
  return { ...base, source: 'app', app: app.identity };          // covered, unknown or error: fail closed
}
export const postAsFor = (plan: PostAsPlan | null | undefined, remoteUrlNormalized: string) =>
  plan?.repos.find((r) => r.remoteUrlNormalized === remoteUrlNormalized) ?? null;
```

`commit-identity.ts`:
- `COMMIT_IDENTITY_SOURCES = ['project', 'repo', 'global', 'system', 'app']`. **Append** `app` at the end. Old values
  still parse. `RepoIdentityFactSchema` accepts `app` too, although the runner never reports it there.
- `COMMIT_IDENTITY_SOURCE_LABEL.app = "the project's selected app"`.
- `CommitAsResponseSchema` gets additive, optional fields (old clients ignore them):
  ```ts
  postAs: z.object({
    selected: z.array(PostAsAppIdentitySchema.extend({
      state: z.enum(['connected', 'not_connected', 'error', 'removed']), detail: z.string().max(400).optional() })),
    available: z.array(/* same shape */),   // org apps a manager can tick
    canSelect: z.boolean(),
    lastChange: z.object({ by: z.string().max(200), at: z.iso.datetime() }).nullable(),
  }).optional(),
  repos: z.array(z.object({
    repoId, repoName, forge: ForgeKindSchema,
    resolved: PostAsRepoSchema,                      // from resolvePostAsRepo
    access: z.object({ state: z.enum(['covered','not_covered','error']), detail: z.string().max(400).optional(),
                       checkedAt: z.iso.datetime() }).nullable(),
  })).optional(),
  ```
  The response may leave out `instance`/`host` for the browser if the builder prefers; they are public ids, so carrying
  them is harmless.

`events/project.ts`: a new event (additive; no existing event changes):

```ts
defineEvent('ProjectPostAsAppsSet', z.object({
  projectId: Id,
  apps: z.array(PostAsAppRefSchema).max(8),
  previous: z.array(PostAsAppRefSchema).max(8),
  setBy: Id,
})),
```

Protocol (additive, optional, **absent when the project has no app selected**). Add `postAs: PostAsPlanSchema.optional()`
next to every `commitAs` field: `ShiftStart`, `ReleaseShipPayload`, `ReleasePublishPayload`, `RepoBumpSubmodulePayload`,
`run.start.rebaseCard` (runs/types.ts), `RepoCreatePayload` (repo/index.ts), the docs-prep DTO (docs-prep-dto.ts), and
`FinalizeExecutePayload` (next to the `'finalize.execute'` entry in runner.ts).

A new runner command, `'app.access_check'` (added to `RunnerCommandNameSchema` after GWP-214's `app.*` entries, and to the
payload map):

```ts
AppAccessCheckPayloadSchema = z.object({ projectId: z.uuid(), integrationId: z.uuid(),
  instance: z.string().max(200), host: AppHostSchema,                                   // (revised)
  repos: z.array(z.object({ repoId: z.uuid(), remoteUrlNormalized: z.string().min(1).max(500) })).max(200) });
AppAccessCheckResultSchema  = z.object({ repos: z.array(z.object({ repoId: z.uuid(),
  state: z.enum(['covered', 'not_covered', 'error']),
  code: AppErrorCodeSchema.optional(),                                                  // (revised) GWP-214's codes
  detail: z.string().max(400).optional() })).max(200) }).strict();
```

A new capability, `POST_AS_CAPABILITY = 'post-as:1'`: the runner understands `postAs` and `app.access_check`. A runner
that announces it also announces `app-integrations:1`.

### 4.2 Server (`apps/server`)

- **Migration (revised)** `2980_post_as.sql` (2970 is now used three times, by `2970_app_integrations.sql` among
  others; take the next free number when you build):
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_as jsonb, ADD COLUMN IF NOT EXISTS post_as_set_by uuid,
  ADD COLUMN IF NOT EXISTS post_as_set_at timestamptz;` plus a fact table
  `project_app_access (project_id uuid, repo_id uuid, integration_id uuid, state text, code text, detail text,
  checked_at timestamptz, workstation_id uuid, PRIMARY KEY (project_id, repo_id, integration_id))`. It is a runner fact
  like `workstation_repos.git_identity`, not an event.
- **Projection** `projections/post-as.ts`: `ProjectPostAsAppsSet` writes `projects.post_as` (the `apps` array, or NULL when
  empty) and the last-change columns. Register it in `projections/index.ts` next to `commitAsProjectors`. Nothing here
  listens to `OrgAppIntegrationRemoved`: the removed state is read live from `org_app_integrations.status`, so the
  reference in `projects.post_as` stays (AC 8).
- **Registry adapter (revised)** `apps/server/src/apps/app-registry.ts`, a thin read layer over GWP-214's tables (keep
  it as the one place that knows their shape):
  - `getOrgAppsByIds(db, orgId, ids)` -> rows of `org_app_integrations` **including removed ones** (`status`,
    `removed_at`), mapped to `{ ref, identity: {label, botName: commit_name, botEmail: commit_email,
    instance: appInstance(app_id, installation_id), host}, removed: status === 'removed' }`. An id with no row at all
    counts as removed.
  - `listActiveOrgApps(db, orgId)` -> the `available` list (`status = 'active'`).
  - `appConnectionState(db, integrationId)` -> `'connected' | 'error' | 'not_connected'`, from
    `org_app_integration_workstations` joined to `workstation_integrations` (`kind = provider`,
    `instance = app_id || ':' || installation_id`) and `workstations.status = 'active'`, the same join as `listOrgApps`.
    **Connected = at least one active workstation holding the key reports `state = 'connected'`** (`stateOf` in
    `org-apps.ts`; export it rather than copying it). Note `listOrgApps` shows `error` for the whole app as soon as one
    workstation errors; selection validation uses the "at least one connected" rule, not that summary.
  - `appWorkstations(db, integrationId)` -> active workstations that hold the key and report connected (used to pick
    the access-check target).
- **Command** `commands/post-as.ts`, a sibling of `commit-as.ts`:
  - `loadPostAsPlan(db, projectId, commitAs)`: returns `PostAsPlan | null`, and `null` when `projects.post_as` is empty
    (this keeps the "no app selected" path byte-for-byte the same). It loads the project's active `project_repos`
    (`remote_url_normalized`, `detectForgeKind(remote_url, forge_kind)`), the selected integrations through the adapter
    (removed or missing -> `removed: true`) and the `project_app_access` rows, then maps every repository through
    `resolvePostAsRepo`.
  - `loadIdentityPlan(db, projectId)` returns `{ commitAs, postAs }`. Replace each `loadCommitAs` call site in §2 with it
    and spread `...(postAs ? { postAs } : {})`. Extend `withCommitAs` the same way. This is the only change to those
    files.
  - `setPostAsApps(ctx, user, projectId, apps)`, inside `withAppendTx`:
    1. `loadVisibleProject`. `p.org_id` must be set, and `isOrgManager({orgRole: await orgRoleOf(tx, user.id, p.org_id)})`
       must hold, otherwise `forbidden('only an organization Owner or Admin can choose the app a project posts as')`.
       This is stricter than Commit as on purpose: the app is an org-level asset (AC 1, "non-manager gets forbidden").
       A project Owner who is not an org manager can see the panel but cannot tick anything. (Registering apps stays
       Owner-only in GWP-214; choosing one for a project is Owner or Admin, as the card says "org manager".)
    2. Each `integrationId` must exist in this org's `org_app_integrations` with `status = 'active'`, otherwise
       `badRequest('that app is not registered in this organization')`. Its connection state must be `connected`,
       otherwise `badRequest('<label> is not connected; connect it on the Apps tab of Organization settings first')`.
       Unticking a removed or disconnected app is always allowed (only newly added ids are checked).
    3. No two apps may share a provider, otherwise
       `badRequest('A project can post as one GitHub App only; untick <label> first')`. Use the provider's label in the
       message, not its id.
    4. If the set is unchanged, return without writing anything. Otherwise append `ProjectPostAsAppsSet {apps, previous,
       setBy}` with `userActor(user.id)` and `projectScope(...)` (the audit log picks it up automatically).
    5. After commit: for each selected app, `requestAppAccessCheck` (below).
  - `requestAppAccessCheck(ctx, projectId, integrationId)`: choose one online workstation from `appWorkstations` whose
    runner announces `post-as:1`, then `enqueueRunnerCommand(..., 'app.access_check', {projectId, integrationId,
    instance, host, repos})` and `deliverPending`. If none qualifies, write nothing; the panel shows "not checked". Also
    call it when a repository is added to a project that has an app selected (`ProjectRepoAdded` path).
  - `applyAppAccessCheckResult` (routed in `runner-gateway/handlers.ts` next to `applyAppCommandResult`): upsert the
    `project_app_access` rows. A failed command marks every repository in the payload `error` with the runner's
    (non-secret) message.
- **Routes** (`routes/commit-as.ts`, or a sibling `routes/post-as.ts`):
  - `PUT /api/projects/:id/post-as` with `SetPostAsRequestSchema`, returns `CommitAsResponse`.
  - `POST /api/projects/:id/post-as/check` (org manager only) re-runs the access checks and returns 202.
  - `getCommitAs` fills the new `postAs` and `repos` fields using `resolvePostAsRepo`; `canSelect` = the caller is an
    org manager.
- **Dispatch gate** (`dispatcher/candidates.ts`): when a project has `post_as` set, offer its work only to workstations
  that announce `post-as:1`. When no workstation qualifies, the card waits, and a desk notice says "update the runner on
  <ws> to post as <app>". Apply the same rule to the commands from §2 (release, bump, finalize, repo.create): an old
  runner ignores `postAs` and would commit as the owner. If a payload has `postAs` and the target workstation lacks the
  capability, do not send it, and raise the existing "runner too old" style desk notice (see the
  `MIN_RUNNER_FOR_SUBMODULE_PIN` pattern in `delivery/submodule-pin.ts`).
- **Rejection handling** (`commands/shifts.ts`, next to the `no_commit_identity:` branch): add an `appFailed` branch. If
  the detail starts with `app_identity_failed:`, raise a desk alert (subkind `DESK_SUBKIND.appIdentityFailed`,
  deduplicated per project+app like `noCommitIdentityNotice`) titled `Shifts for <project> stopped: the app <label>
  cannot be used`, with the reason from the detail. The card thread text says the shift was stopped instead of
  committing under another identity. The card goes back to the queue and the existing storm guard (`REJECTION_DESK_AT`)
  escalates repeats. That is the "flagged for the owner" in requirement 5.

### 4.3 Runner (`apps/runner`)

- `git/identity.ts` **(revised: probe keyed by instance, GWP-214's error type)**:
  ```ts
  export interface CommitIdentity { name: string; email: string; source: CommitIdentitySource; app?: PostAsAppRef }
  export class AppIdentityError extends Error {
    readonly code = APP_IDENTITY_FAILED_CODE;
    constructor(readonly app: { label: string; integrationId: string }, readonly reason: string) {
      super(`The app ${app.label} could not be used: ${reason} Nothing was committed or pushed under another identity.`);
    }
  }
  export const appIdentityWire = (e: AppIdentityError) => `${APP_IDENTITY_FAILED_CODE}: ${e.message}`;

  /** Port to GWP-214's AppTokenBroker; set once at runner start (setAppTokenProbe). Default: always fails (fail closed). */
  export interface AppTokenProbe {
    ensure(app: { instance: string; integrationId: string }, repoName: string): Promise<void>;
  }

  export async function resolveCommitIdentity(cwd, commitAs?, postAs?: PostAsRepo | null) {
    if (postAs?.source === 'app') {
      if (!postAs.app) throw new AppIdentityError({ label: 'unknown app', integrationId: '' }, 'The app reference is missing.');
      try { await probe.ensure(postAs.app, repoNameOf(postAs.remoteUrlNormalized)); }
      catch (err) { throw new AppIdentityError(postAs.app, appReason(err)); }
      return { name: postAs.app.botName, email: postAs.app.botEmail, source: 'app',
               app: { integrationId: postAs.app.integrationId, provider: postAs.app.provider } };
    }
    // unchanged from here: today's code, byte for byte
    if (commitAs?.name.trim() && commitAs.email.trim()) return { ..., source: 'project' };
    return repoLevelIdentity(cwd);
  }
  ```
  `requireCommitIdentity(cwd, commitAs?, postAs?)` passes the argument through. Without `postAs` (every existing caller
  and every project with no app), the code path is identical: no extra git call and no extra await.
  `appReason(err)`: an `AppTokenError` gives `APP_ERROR_TEXT[err.code]` (GWP-214's one-sentence, value-free text, for
  example `installation_not_found` -> "The app is not installed there any more.", `installation_suspended`,
  `jwt_rejected`, `clock_skew`, `permission_missing`, `repository_not_accessible`, `token_rejected`, `rate_limited`,
  `unreachable`); the broker's own "This app is not connected on this workstation." message for a missing key may be
  used as it is (it holds no value). Anything else gives `APP_ERROR_TEXT.unexpected`. Never `String(err)` of a
  non-typed error, and pass the result through `redact()` anyway.
- **Probe wiring (revised)** in `runner.ts`, once, after `appBroker()` exists:
  ```ts
  setAppTokenProbe({
    ensure: async ({ instance, integrationId }, repoName) => {
      const broker = this.appBroker();
      const stored = broker.store.get(instance);
      if (!stored) throw new AppTokenError('installation_not_found', 'This app is not connected on this workstation.');
      // the copy must belong to the selected registration; a stale or foreign copy is refused, never used
      if (!stored.refs.some((r) => r.integrationId === integrationId))
        throw new AppTokenError('app_mismatch', APP_ERROR_TEXT.app_mismatch);
      await broker.getAccessToken(instance, { repositories: [repoName] });   // name only: GitHub scopes by repo name
    },
  });
  ```
  The scoped mint answers "can this installation reach this repository" at shift time; GitHub refuses a name that is
  not in the installation and the provider maps it to a typed code. The token stays in the broker's memory cache, so
  GWP-216 reuses it with the same scope key. The probe never returns the token.
- **Callers.** Pass `postAsFor(p.postAs, p.remoteUrlNormalized)` (or the repo's url) as the third argument at:
  `shifts/supervisor.ts` (the per-shift resolve), `git/completion.ts`, `git/rebase.ts` (thread `postAs` like
  `commitAs`), `git/sync-main.ts` (both sites), `git/release-ship.ts`, `git/release-publish.ts` (both sites),
  `git/release-docs-prep.ts` (both sites), `git/release-prep-task.ts`, `git/submodule-pin.ts`, `repo/create.ts` (both
  sites). **Leave alone:** `vaults/sync.ts` (vault repositories are not project repositories), and `chat/chat.ts`,
  `delegate/delegate.ts`, `devops/saved-work.ts` (no project payload; today's behaviour). GWP-216/217 may revisit these.
- **`supervisor.ts`.** Catch `AppIdentityError`. If the shift `commits` (same rule as for the missing identity), call
  `this.reject(msg.shiftId, 'internal', appIdentityWire(err))` and return. A read-only shift continues with
  `identity = null` (it never commits; forge posting is GWP-216/217's fail-closed point).
- **Command callers** (completion, release, bump): an `AppIdentityError` becomes the command's error string
  `appIdentityWire(err)`. The existing failure paths surface it on the card or desk. Do not catch it into a fallback.
- **`app.access_check` handler (revised)** (`apps/runner/src/apps/access-check.ts`, routed in `runner.ts` with the other
  `app.*` commands): check the stored copy and its ref as in the probe, then
  `broker.withToken(instance, { permissions: { metadata: 'read' } }, (t) => page GET ${githubApiBase(host)}/installation/repositories?per_page=100)`.
  Build a set of lower-cased `owner/name`, and for each payload repository compare `parseRemote(remote)` host (must
  equal the app's `host`) and `namespace/name`. The result is `covered` or `not_covered`. An `AppTokenError` gives
  `error` plus its `code` and `APP_ERROR_TEXT[code]`. Never return a token in the result (the result schema is strict).
- Announce `POST_AS_CAPABILITY` in `hello.capabilities` next to `APP_INTEGRATIONS_CAPABILITY`.

### 4.4 Web (`apps/web`)

- `api/queries/commit-as.ts`: add `useSavePostAs(projectId)` (PUT `/projects/:id/post-as`, writes the `['commit-as', id]`
  cache) and `useRecheckPostAs` (POST `.../post-as/check`, then invalidate).
- `components/CommitAsPanel.tsx`: add a "Post as app" block **above** the name/e-mail form, in the same panel so the
  owner sees the full order:
  - one checkbox per `postAs.available` app, labelled `<label> (GitHub App, <botName>)`, with its state badge. Not
    connected -> disabled with "Connect it on the Apps tab of Organization settings first" (GWP-214's
    `orgsettings/AppsTab.tsx`). Disabled for everyone when `!canSelect`, with the note "Only an organization Owner or
    Admin can choose the app". Selected apps that were removed are shown checked, with the warning "App removed, using
    fallback" and an "Untick" action. Ticking a second app of the same provider in the form is blocked locally with the
    same message the server sends (the server stays authoritative). Save writes the set.
  - "Last changed by X on <date>" (`postAs.lastChange`).
  - **Effective identity, per repository** (`repos[]`). Replace the clone-list text with one helper,
    `effectiveIdentityText(resolved, commitAs, clone)`, extended with the credential:
    - `app`: "Commits and pushes as <botName> <botEmail> (GitHub App <label>), with the app's installation token."
      Access unknown or error: add "Access not checked yet; shifts stop if the app cannot reach this repository." App
      state `not_connected`/`error`: add "The app is not working; shifts for this repository will stop rather than use
      another identity."
    - `project`: today's text, plus "pushed with the workstation's <Forge> login".
    - `repo`: today's per-clone text, plus the same credential clause.
    - fallback reasons: `not_covered` -> warning "<label> cannot reach this repository; it uses the fallback above".
      `app_removed` -> "App removed, using fallback". `no_app_for_forge` -> "No app for <Forge>; uses the fallback".
  - a "Check access again" button (managers only).
  - When `postAs` is absent (an older server, or an org with no apps), the panel renders exactly as today.
- Mobile and touch (standing order): checkboxes have at least 44px targets with the label as the hit area, the
  per-repository lines wrap (no table), and the new block adds no text fields that a soft keyboard would cover.
- `pages/ProjectSettings.tsx`: no change (the server decides `canSelect`).
- Docs: `docs/USER-GUIDE.md` §Commit as gets a "Post as app" paragraph (GWP-214 already added an apps section; link to
  it), and `docs/RUNNER.md` gets the new first step in the order plus the fail-closed rule.

## 5. Acceptance criteria -> design

| AC | Where it is met | Test |
|---|---|---|
| 1. Manager can tick a connected app; non-manager forbidden; disconnected/deleted app cannot be selected | `setPostAsApps` steps 1-2; panel disables options | server `post-as.test.ts`: org owner OK, admin OK, project-owner-only -> 403, member -> 403, unknown id -> 400, removed (`status='removed'`) -> 400, not connected (no workstation row, or only `error`/`pending` states) -> 400; web: disabled checkbox |
| 2. Second app of the same provider rejected with a clear message | step 3 plus local check in the panel | server test asserts the message text; web test |
| 3. Panel shows per-repository identity and credential, warns when not covered | `getCommitAs` `repos[]` + `effectiveIdentityText` | shared `resolvePostAsRepo` matrix; web `commit-as.test.tsx` cases for app, project, repo, not_covered, unknown, removed |
| 4. `CommitIdentitySource` has `app`; runner receives the resolved source with each shift | `COMMIT_IDENTITY_SOURCES`, `PostAsPlanSchema` on `shift.start` and the other payloads | shared `protocol.test.ts`: `shift.start` with `postAs` round-trips through the server-to-runner schema; a payload without `postAs` parses to exactly the old object; server dispatch test asserts `postAs` is present iff `post_as` is set |
| 5. No app selected -> byte-for-byte the same | `loadPostAsPlan` returns null -> field omitted; runner branch only when `postAs?.source==='app'` | existing `commit-identity.test.ts` (shared and runner), `repo-identity.test.ts`, all `completion*.test.ts`, server `commit-as.test.ts` pass **unchanged**; a new test snapshots the `shift.start` payload for a no-app project, the same as before |
| 6. App selected and minting fails -> no other identity, error names the app and reason | `AppIdentityError` in `resolveCommitIdentity`; supervisor reject; command error strings; server desk alert | runner: resolution matrix (app covering / not covered -> fallback entry / commit-as only / nothing) and probe throws `AppTokenError` (missing key, ref mismatch, `installation_suspended`) -> `AppIdentityError` with label and `APP_ERROR_TEXT` reason, `commitEnv` never reached; supervisor test: rejection detail starts with `app_identity_failed:`; server: that rejection raises the app desk alert, not the no-identity one |
| 7. Selection change records an event with actor, old and new | `ProjectPostAsAppsSet {apps, previous, setBy}` with a user actor | server test reads the event; old event shapes still parse (shared schema test) |
| 8. Removed integration -> "app removed, using fallback" + fallback | `resolvePostAsRepo` `app_removed`, read from `org_app_integrations.status`; panel text | shared test; server test appends `OrgAppIntegrationRemoved` for a selected app and checks `getCommitAs` and `loadPostAsPlan`; web test |

## 6. Assumptions about GWP-214, checked against the landed code (revised)

Checked on `main` at ff4ba644 (merge of GWP-214) by reading `packages/shared/src/apps/index.ts`,
`packages/shared/src/events/apps.ts`, `apps/server/migrations/2970_app_integrations.sql`,
`apps/server/src/projections/app-integrations.ts`, `apps/server/src/commands/org-apps.ts`, and
`apps/runner/src/apps/{broker,types,store,github-app}.ts`.

1. **Org-level registry on the server — holds.** `org_app_integrations` (uuid `id`, `org_id`, `provider`, `label`,
   `bot_login`, `commit_name`, `commit_email`, `status` active/removed) plus `org_app_integration_workstations` and
   per-workstation state in `workstation_integrations`. The adapter `apps/app-registry.ts` stays, now as a thin read
   layer over these tables (§4.2).
2. **The server knows the bot identity — holds.** `commit_name` (`<slug>[bot]`) and `commit_email`
   (`<botUserId>+<slug>[bot]@users.noreply.<host>`) are stored at registration and refreshed by
   `OrgAppIntegrationUpdated`. `botName/botEmail` stay in `PostAsAppIdentitySchema`.
3. **Runner broker API — did not hold as written.** The broker is `AppTokenBroker.getAccessToken(instance, scope)`,
   keyed by the **instance** `"<appId>:<installationId>"`, not by the integration uuid; the runner store maps an
   instance to its registrations (`refs: [{orgId, integrationId}]`). Errors are `AppTokenError` with GWP-214's
   `AppErrorCode` (`installation_not_found`, `installation_suspended`, `repository_not_accessible`, …), not the names
   guessed in the first pass. Changes, all within the seams the first pass named: `PostAsAppIdentitySchema` carries
   `instance` and `host` (public ids the server already has); `AppTokenProbe.ensure` takes `{instance, integrationId}`
   and checks the stored copy belongs to that registration; `appReason` uses `APP_ERROR_TEXT`; `app.access_check`
   carries `instance`/`host` and reports GWP-214's error codes; `access-check.ts` uses `broker.withToken` and
   `githubApiBase(host)` and compares hosts. The resolver, the selection rules and the server validation are
   unchanged.
4. **Connection state per workstation — holds.** `workstation_integrations.status->>'state'` per workstation, joined
   through `org_app_integration_workstations` as in `listOrgApps`. "Connected" for selection = at least one active
   workstation holding the key reports `connected` (not `listOrgApps`'s summary, which shows `error` if any one
   workstation errors).
5. **Provider id `github-app` — holds.** Use GWP-214's `APP_PROVIDER_IDS` / `AppProviderIdSchema`; the forge mapping
   `APP_PROVIDER_FORGE` stays in `post-as.ts`. Do not declare a shared `APP_PROVIDERS` (the runner's factory map has that
   name).
6. **Removal does not clear selections — holds.** `OrgAppIntegrationRemoved` sets `status = 'removed'` and only deletes
   the workstation rows; nothing touches `projects`. GWP-214's report names this event as the contract for GWP-215's
   fallback. The label and bot identity stay on the removed row, so the panel can name the removed app.

Also changed by the landed code (not a numbered assumption): migration `2970_*` is taken, so this card uses
`2980_post_as.sql` (or the next free number at build time).

## 7. Risks and traps

- **Older runners quietly commit as the owner.** This is the main fail-open risk. The capability gate in dispatch and on
  the git commands is required, not optional.
- **Byte-for-byte:** do not reorder `COMMIT_IDENTITY_SOURCES` (append `app`), do not change `commitAs` fields, and do
  not add `postAs: undefined` keys (spread conditionally, as `withCommitAs` does).
- **Secrets:** settings, events, payloads and the access-check result carry only ids, labels, the instance and the
  public bot identity. Error reasons come from `APP_ERROR_TEXT` and go through the runner's redaction.
- **Panel says "pushes with the app's installation token" before GWP-216 lands.** The group lands in order with one
  builder; land GWP-215 and GWP-216 in the same release. If GWP-216 slips, change the credential clause to "commits as
  the app".
- **Shift on a workstation without the app key.** The shift fails closed with "This app is not connected on this
  workstation." GWP-214's `org_app_integration_workstations` now says which workstations hold the key, so routing app
  projects to them is a small follow-up for GWP-216, not this card.
- **Simulation orgs** have no apps, so `postAs` is never set and nothing changes there.
- **Repos added after the last access check** have unknown access, so they fail closed until a check runs. This is why
  adding a repository also triggers `requestAppAccessCheck`.

## 8. Files touched (summary)

Shared: `repo/post-as.ts` (new), `repo/commit-identity.ts`, `repo/index.ts`, `events/project.ts`,
`protocol/runner.ts`, `runs/types.ts`, `release/docs-prep-dto.ts`, tests (`commit-identity.test.ts`, `protocol.test.ts`,
new `post-as.test.ts`).
Server: migration `2980_post_as.sql`, `projections/post-as.ts` + `index.ts`, `commands/post-as.ts` (new),
`apps/app-registry.ts` (adapter over GWP-214's tables, new), `commands/org-apps.ts` (export `stateOf` only),
`commands/commit-as.ts` (`getCommitAs`, `withCommitAs`), the `loadCommitAs` sites, `routes/commit-as.ts`,
`runner-gateway/handlers.ts`, `dispatcher/candidates.ts`, `commands/shifts.ts`, desk subkind, new test
`post-as.test.ts`.
Runner: `git/identity.ts`, the call sites in §4.3, `apps/access-check.ts` (new), `runner.ts` (probe wiring, command
route, capability), tests.
Web: `CommitAsPanel.tsx`, `api/queries/commit-as.ts`, `test/commit-as.test.tsx`.
Docs: `USER-GUIDE.md`, `RUNNER.md`.
Estimated size: about 900-1200 changed lines across four packages, so the card is **large**.

Unit suites to run: shared, server unit, runner, web component tests. Manual QA (two repositories, one covered and one
not) and any E2E are left to the testers.
