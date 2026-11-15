# GWP-217 (GWP-212.4): ticket and issue posts as the selected app

Design report, revised against the landed GWP-214 (app integrations, token broker) and GWP-215 (per-project post-as
selection). Base: `main` at d5ad1c82.

## 0. Revision (assumption review after GWP-214 and GWP-215 landed)

| # | Assumption | Result | What the landed code says, and what changed in this design |
|---|---|---|---|
| 1 | Broker `getAccessToken(integrationId, {repositories})` → `{token, expiresAt}`, cached, typed causes | **Revised** | `AppTokenBroker.getAccessToken(instance, scope)` (`apps/runner/src/apps/broker.ts`). It is keyed by the runner **instance** `appId:installationId`, not by the integration id. `expiresAt` is epoch ms. Errors are `AppTokenError` with `.code: AppErrorCode` (`apps/runner/src/apps/types.ts`, `packages/shared/src/apps/index.ts`). Caching, single-flight and refresh 10 minutes before expiry are inside the broker. Token scope takes repository **names without the owner** (see `appTokenProbe` in `apps/apps/access-check.ts`). The broker is per runner (`this.appBroker()`, a method, one per pairing). The stored copy must belong to the selected registration (`store.get(instance).refs` contains the `integrationId`), as `appTokenProbe` already checks. → §4.3 `brokerTokenSource` + `ghEnvFor`. |
| 2 | Repository outside the installation is its own cause `repo_not_accessible` | **Revised (name)** | It exists, named **`repository_not_accessible`**: a 403/422 at mint whose message mentions a repository (`github-app.ts` error mapping). Other 403/422 errors at mint are `permission_missing`. Because the scope is by name, an issue on another owner whose repository name matches one in the installation would mint a token for the wrong repository. So `brokerTokenSource` compares the issue owner with `stored.identity.account` and raises `repository_not_accessible` itself when they differ. |
| 3 | GitHub Apps are github.com apps; GHES apps count as not covered | **Revised** | GWP-214 accepts any host (`AppHostSchema`, default `github.com`; `AppIdentity.host`, `PostAsAppIdentity.host`). Issue refs are still github.com only (`parseExternalRef`). The rule stays, now made explicit: an app whose `host` is not `github.com` does not cover issue traffic (fallback). `trackerAppFor` returns `null` for it on the server and `ghEnvFor` returns `undefined` for it on the runner (defence in depth). GHES issue support remains a follow-up. |
| 4 | GWP-215 gives `PostAsAppIdentitySchema` (integrationId, provider, label, botName, botEmail), `projects.post_as`, an `app-registry` adapter, `loadIdentityPlan` | **Revised (names)** | `PostAsAppIdentitySchema` is in `packages/shared/src/repo/post-as.ts` and also carries **`instance` and `host`** (what the broker needs). `projects.post_as` holds `PostAsAppRef[]` (`storedPostAs`). There is no `app-registry.ts`: the registry read is `selectedAppStates(db, orgId, refs)` in `apps/server/src/commands/post-as.ts`. `loadIdentityPlan` and the `shift.start` builder `withCommitAs` are in `apps/server/src/commands/commit-as.ts`. → §4.1, §4.2. |
| 5 | Removed app → fallback; disconnected or error → fail closed | Confirmed | `selectedAppStates`: no row or `status !== 'active'` → `removed`/`identity: null` → fallback (`app_removed`). A connected-state error does not remove the identity, so `trackerAppFor` returns it and the runner fails closed when the mint fails. |
| 6 | Installation permissions include `issues: write` | Confirmed | `DEFAULT_APP_PERMISSIONS` = contents, pull_requests, **issues: write**, metadata: read. `verify` reports `missingPermissions`. Without the permission a post fails closed. |

Other corrections from the landed code (not assumptions):
- The panel text lives in `apps/web/src/components/PostAsBlock.tsx` (test `apps/web/src/test/post-as.test.tsx`), not in `CommitAsPanel.tsx` / `commit-as.test.tsx`.
- Line moves: shift source read `supervisor.ts:2420`, chat source read `chat.ts:728`, `issue_labelled` enqueue `schedules.ts:1369`, `ownerWorkstation` `outbox.ts:31`, broker wiring and `hello.capabilities` in `runner.ts` ~1029 and ~1647.
- `TRACKER_POST_AS_CAPABILITY` goes next to `POST_AS_CAPABILITY` in `packages/shared/src/repo/post-as.ts`. It is still a separate capability: a runner with `post-as:1` but without this card would ignore `trackerApp` and post as the owner.
- `appReason(err)` (`apps/runner/src/git/identity.ts`) already gives the value-free one-sentence reason for an `AppTokenError`. Use it instead of a new `reasonOf`.

Everything else in the design (payload field, capability gate, env injection, `lookFirst`, poller, tests) stands.

## 1. Question

When a project has a GitHub App selected (GWP-215), GWP's GitHub issue traffic must run as that app's bot, not as the
owner's `gh` login. That traffic is:

- approved posts (`outbound.post`: a comment, or a close with a comment),
- the "already posted?" check on a retry,
- issue reads (`aom source read` in a shift),
- the integration poller (`integration.run` for GitHub).

Without an app nothing changes. With an app, a repository the installation does not cover falls back to today's
credentials. If the app cannot mint a token, the operation fails closed, with an error that names the app. Jira is out of
scope, apart from one line of text in the panel.

## 2. Findings (current code)

| Area | Today | What it means for this card |
|---|---|---|
| `apps/runner/src/external/github.ts` | `GithubAdapter` shells out to `gh` (`issue view/comment/close`) through the `Exec` seam. `Exec = (bin, args, opts?: {cwd})` has **no env**. `defaultExec` calls `execa` with `extendEnv` (the default). | The token has to reach `gh` as `GH_TOKEN` in the child env. It must never go in argv. `Exec` gets an optional `env`. |
| `GithubAdapter.findPosted` | Matches `comment.body.trim() === draft.body.trim()`. **No author check.** | Duplicate detection already works across the bot and the personal user. Keep it exactly like this (AC 2). |
| `apps/runner/src/external/outbound.ts` `OutboundExecutor.post` | A record per draft. `posted` → answers `duplicate`, no call. `attempting` → `findPosted` first. A `PostError` → record `refused` for that command id, and a new command posts **without** `findPosted`. | **Trap (new with this card):** ambiguous attempt (`attempting`) → retry while the app cannot mint → `PostError` → record `refused` → owner fixes the app → retry posts without looking → possible duplicate. Fix in §4.3. |
| `OutboundPostPayloadSchema` (`packages/shared/src/external/index.ts`) | `draftId, cardId, cardRef, ref, kind, body, agentNames`. No project and no identity. | The runner cannot work out the project's app itself. The server must add it. |
| `apps/server/src/commands/outbox.ts` `queueOutboundPost` | Loads the card and picks `ownerWorkstation`. Callers: outbox.ts:152, 289, 305 (`queueApprovedFor`), qa.ts. | Add `project_id` to the card select, resolve the app, and pick a capable workstation. |
| `IntegrationPoller.github` (`apps/runner/src/integrations/poll.ts`) | `exec(ghBin, ['issue','list','--repo', query, ...])` with the user's `gh` login. | Same env injection. The payload needs the app. |
| `IntegrationRunPayloadSchema` (protocol/runner.ts) | `scheduleId, runId?, integration, query, label?, limit`. | Add the app. Enqueued at `commands/schedule-actions.ts:484` (poll action) and `commands/schedules.ts:1369` (`issue_labelled` trigger). Schedules have an optional `project_id`. |
| Reads in shifts | `supervisor.ts:2420` → `external.readText(ref)`. Chat: `chat.ts:728`. | Shift reads can carry the app from the shift payload. Chat reads have no project selection, so they stay as today (§7). |
| GitHub refs | `parseExternalRef` only recognises `github.com` URLs and `owner/repo#n`. | Issue traffic is github.com only. An app on another host does not cover it (fallback). |
| Broker (GWP-214) | `AppTokenBroker.getAccessToken(instance, {repositories: [name]})`, `AppTokenError.code`, `store.get(instance).refs/identity`, per runner via `runner.ts appBroker()`. | Wrapped by one function, `brokerTokenSource` (§4.3). |
| Selection (GWP-215) | `projects.post_as` (`PostAsAppRef[]`), `selectedAppStates`, `PostAsAppIdentity` with `instance` and `host`, `withCommitAs` builds `shift.start`. | `trackerAppFor` reuses `selectedAppStates` (§4.2). |
| Redaction | `secrets/redact.ts` `registerSecret`, `redactSecrets` (matches `ghs_…`). The broker registers every minted token. | Run `gh` stderr through `redactSecrets` before it goes into an error message. |
| Capabilities | `hello.capabilities` (runner.ts ~1647). Server table `workstation_capabilities`; `canPostAs` in `commit-as.ts` shows the query. | An old runner would ignore the new field and post as the owner (fail open). Gate on a new capability. |
| Tests | `test/external-adapters.test.ts`, `test/outbound-adapters.test.ts`, `outbound-internal-key.test.ts`. The fake `exec` records `{bin,args}` and ignores `opts`. **No poller test file exists.** | Existing tests stay as they are. Add a new `test/integration-poller.test.ts`. |

## 3. Options compared

**A. How the token reaches `gh`**
- A1: `GH_TOKEN` in the child env through a new optional `Exec` `env`. **Chosen.** The token stays out of argv and
  logs, all `gh` commands keep working, and the call is the same as today when there is no app.
- A2: replace `gh` with direct REST calls. Rejected: a rewrite of the adapter and the poller with more regression risk.
  A1 meets AC 3's intent, because `gh` sends `GH_TOKEN` as the `Authorization` header; the test asserts the token handed
  to the child process.

**B. How the adapter learns which app (if any) to use**
- B1: the server resolves the project's selected GitHub App and sends its public identity in the payload. The runner
  decides coverage per repository through the broker. **Chosen.**
- B2: send `projectId` and let the runner look up the selection. Rejected: the runner has no copy of project settings.
- B3: the server decides coverage from `project_app_access`. Rejected as the only source: issue repositories are often
  not project repositories, so there may be no fact for them. The broker's answer is authoritative and live.

**C. Passing the app into the adapter**
- C1: an optional second argument `ctx?: { app?: TrackerApp }` on `ExternalAdapter.readSource/postApproved/findPosted`
  and on `ExternalAdapters.readSource/readText`. **Chosen.** Additive; Jira ignores it.
- C2: build a `GithubAdapter` per call. Rejected: the registry is built once at runner start.

**D. Coverage, and failures that are not about coverage**
- D1: `repository_not_accessible` (from the mint, or the owner is not the installation account), or an app host that
  is not github.com → today's credentials. Any other failure → **fail closed**. **Chosen.** Matches GWP-215: unknown is
  never treated as "not covered".
- D2: treat every mint failure as "not covered". Rejected, because it is fail-open.

**E. Duplicate detection after the switch**
- Keep the body-only match in `findPosted`, no author filter, and close the `attempting → refused → retry` gap (§4.3).

## 4. Recommendation and design

### 4.1 Shared (`packages/shared`)

`src/external/index.ts`:

```ts
import { PostAsAppIdentitySchema } from '../repo/post-as.ts'; // integrationId, provider, label, botName, botEmail, instance, host

/** The GitHub App a project posts to GitHub issues as. Only its public identity, never a key or token. */
export const TrackerAppSchema = PostAsAppIdentitySchema;
export type TrackerApp = z.infer<typeof TrackerAppSchema>;

/** Per call context for an adapter; additive. Jira ignores it. */
export interface AdapterCallContext { app?: TrackerApp }

export interface ExternalAdapter {
  readonly system: ExternalSystem;
  readSource(ref: ExternalRef, ctx?: AdapterCallContext): Promise<ExternalSource>;
  postApproved(draft: ApprovedDraft, ctx?: AdapterCallContext): Promise<PostResult>;
  findPosted?(draft: ApprovedDraft, ctx?: AdapterCallContext): Promise<PostResult | null>;
}

export const OutboundPostPayloadSchema = z.object({
  ...existing,
  /** Present only when the card's project has a github.com GitHub App selected and the ref is a GitHub issue. */
  trackerApp: TrackerAppSchema.optional(),
});
```

Watch for an import cycle (`repo/post-as.ts` imports `forge/index.ts`); if one appears, define `TrackerAppSchema` in
`repo/post-as.ts` and re-export it from `external/index.ts`.

`src/repo/post-as.ts`: `export const TRACKER_POST_AS_CAPABILITY = 'tracker-post-as:1';` (this runner understands
`trackerApp`).

`src/protocol/runner.ts`:
- `IntegrationRunPayloadSchema`: `trackerApp: TrackerAppSchema.optional()` (GitHub only).
- `ShiftStart`: `trackerApp: TrackerAppSchema.optional()`, used by `aom source read` in that shift.

The field is **absent** when no app is selected (spread conditionally, never `trackerApp: undefined`), so the no-app
payloads stay byte-for-byte the same.

### 4.2 Server (`apps/server`)

In `commands/post-as.ts`, next to `selectedAppStates`:

```ts
/** The project's selected github.com GitHub App for issue traffic, or null (no project, no app, removed, other host). */
export async function trackerAppFor(db: Queryable, projectId: string | null | undefined): Promise<TrackerApp | null> {
  if (!projectId) return null;
  const p = await one<{ post_as: unknown; org_id: string | null }>(db, 'SELECT post_as, org_id FROM projects WHERE id=$1', [projectId]);
  const refs = storedPostAs(p?.post_as).filter((r) => APP_PROVIDER_FORGE[r.provider] === 'github');
  if (!refs.length) return null;
  const [s] = await selectedAppStates(db, p?.org_id ?? null, refs.slice(0, 1)); // one app per provider (GWP-215)
  if (!s || s.removed || !s.identity) return null;                              // removed -> fallback
  if (s.identity.host.toLowerCase() !== 'github.com') return null;              // issue refs are github.com only
  return s.identity;                                                            // error/disconnected -> runner fails closed
}
```

- `commands/outbox.ts` `queueOutboundPost`: select `project_id` with the card. When `draft.external_system === 'github'`,
  call `trackerAppFor`. If there is an app:
  - add `trackerApp` to the payload;
  - choose the owner's workstation among those that announce `TRACKER_POST_AS_CAPABILITY`: extend
    `ownerWorkstation(db, ownerId, { capability? })` with `EXISTS (SELECT 1 FROM workstation_capabilities wc WHERE
    wc.workstation_id = w.id AND $2 = ANY (wc.capabilities))`. When `toWorkstation` is given (`queueApprovedFor`), check
    it the same way.
  - If none qualifies, queue nothing (the draft stays `approved`, as it does today with no workstation) and raise one
    desk notice, deduplicated per draft: "Update the runner on <workstation> so it can post as <label>".
    `queueApprovedFor` re-runs when a workstation connects, so the post goes out once the runner is updated.
  The Jira branch does not change.
- `commands/schedule-actions.ts:484` (poll action) and `commands/schedules.ts:1369` (`issue_labelled`): when the
  integration is `github`, call `trackerAppFor(tx, s.project_id)` and spread `trackerApp`. If the schedule's workstation
  does not announce the capability, do not enqueue: the poll action returns `status: 'failed'` with "update the runner on
  this workstation to poll as <label>"; the labelled trigger raises the existing schedule failure notice with the same
  text. Org-level schedules (no `project_id`) never get an app.
- Shift payload: in `commands/commit-as.ts` `withCommitAs`, also add `...(trackerApp ? { trackerApp } : {})`. GWP-215's
  dispatch gate already sends app projects only to `post-as:1` runners; these are reads only, so an older runner is not
  an attribution risk here.
- No migration. No new event.

### 4.3 Runner (`apps/runner`)

**New file `src/external/app-token.ts`** (the only file that knows the broker):

```ts
import { APP_ERROR_TEXT, type TrackerApp } from '@aom/shared';
import type { AccessCheckBroker } from '../apps/access-check.ts';
import { AppTokenError } from '../apps/types.ts';
import { appReason } from '../git/identity.ts';

/** A token for `owner/name`. Throws AppTokenError. */
export interface AppTokenSource {
  tokenFor(app: { instance: string; integrationId: string }, repoFullName: string): Promise<string>;
}

/** The runner's broker as an AppTokenSource (wired in runner.ts with () => this.appBroker()). */
export function brokerTokenSource(broker: () => AccessCheckBroker): AppTokenSource {
  return {
    tokenFor: async ({ instance, integrationId }, repo) => {
      const b = broker();
      const stored = b.store.get(instance);
      if (!stored) throw new AppTokenError('installation_not_found', APP_ERROR_TEXT.installation_not_found);
      if (!stored.refs.some((r) => r.integrationId === integrationId))
        throw new AppTokenError('app_mismatch', APP_ERROR_TEXT.app_mismatch);
      const [owner, name] = repo.split('/');
      // An installation lives on one account; GitHub scopes tokens by repository name only.
      if (!owner || !name || owner.toLowerCase() !== stored.identity.account.toLowerCase())
        throw new AppTokenError('repository_not_accessible', APP_ERROR_TEXT.repository_not_accessible);
      const t = (await b.getAccessToken(instance, { repositories: [name] })) as { token: string };
      return t.token;
    },
  };
}

export class AppCredentialError extends Error {
  constructor(readonly app: TrackerApp, readonly repo: string, readonly reason: string) {
    super(`The GitHub App ${app.label} (${app.botName}) could not get a token for ${repo}: ${reason} ` +
          'Nothing was sent under another identity.');
    this.name = 'AppCredentialError';
  }
}

/** No app, other host, or repo not in the installation -> undefined (today's gh login). Anything else -> fail closed. */
export async function ghEnvFor(src: AppTokenSource | undefined, app: TrackerApp | undefined, repo: string)
  : Promise<Record<string, string> | undefined> {
  if (!app) return undefined;
  if (app.host.toLowerCase() !== 'github.com') return undefined;
  if (!src) throw new AppCredentialError(app, repo, APP_ERROR_TEXT.runner_too_old);
  try {
    const token = await src.tokenFor(app, repo);
    return { GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  } catch (err) {
    if (err instanceof AppTokenError && err.code === 'repository_not_accessible') return undefined;
    throw new AppCredentialError(app, repo, appReason(err));
  }
}
```

(`AccessCheckBroker.getAccessToken` is typed `Promise<unknown>`; widen it to `Promise<{ token: string }>` or add a
narrow interface, rather than casting.)

`GH_HOST: 'github.com'` is required: with a GHES `GH_HOST` in the runner's own env, `gh` would use
`GH_ENTERPRISE_TOKEN` and the owner's GHES login instead of `GH_TOKEN` (fail open). `GH_TOKEN` takes priority over
`GITHUB_TOKEN` and the `gh` config. The broker already calls `registerSecret` for every minted token.

**`src/external/github.ts`**
- `Exec` opts become `{ cwd?: string; env?: Record<string, string> }`. `defaultExec` passes `...(opts?.env ? { env: opts.env } : {})`
  to `execa` (keep `extendEnv`). Never log `opts.env`.
- Constructor: `{ bin?, exec?, appTokens?: AppTokenSource }`.
- One private helper used by every call:
  ```ts
  private async gh(args: string[], repo: string, ctx: AdapterCallContext | undefined, wrap: (m: string) => Error) {
    let env: Record<string, string> | undefined;
    try { env = await ghEnvFor(this.opts.appTokens, ctx?.app, repo); }
    catch (err) { if (err instanceof AppCredentialError) throw wrap(err.message); throw err; }
    const exec = this.opts.exec ?? defaultExec;
    const bin = this.opts.bin ?? 'gh';
    return env ? exec(bin, args, { env }) : exec(bin, args);   // no app: exactly today's two-argument call
  }
  ```
  `postApproved` and `run` use `wrap = (m) => new PostError(m)`, and `readSource` uses `SourceReadError`. The ENOENT
  mapping stays where it is. Minting happens **before** `gh` starts, so a mint failure runs no `gh` command at all.
- `postApproved(draft, ctx)`, `findPosted(draft, ctx)`, `readSource(ref, ctx)` pass `owner/name` and `ctx`.
- `findPosted`: matching does not change (body only, any author). Do not add an author filter.
- `gh` stderr in `PostError` / `SourceReadError` messages goes through `redactSecrets(...)`.

**`src/external/index.ts`**: `ExternalAdapters.defaults({ ..., appTokens? })` passes it to `GithubAdapter`.
`readSource(ref, ctx?)` and `readText(text, ctx?)` forward `ctx`.

**`src/external/outbound.ts`**
- `const ctx = payload.trackerApp ? { app: payload.trackerApp } : undefined;` and pass it to `findPosted(draft, ctx)` and
  `postApproved(draft, ctx)`.
- **Duplicate gap fix:** add `lookFirst?: boolean` to `PostRecord`. In the `PostError` branch, if the record at entry
  was `attempting` (an earlier send may have landed), write `{ state: 'refused', commandId, error, lookFirst: true }`.
  When there is no `commandId`, keep the `attempting` record instead of deleting it. On entry, a `refused` record for a
  different command with `lookFirst` becomes `done = { state: 'attempting' }` (not `null`), so the retry runs
  `findPosted` before posting. Without an app this changes only that one rare path, in the safe direction. Every
  existing executor test still passes.

**`src/integrations/poll.ts`**: constructor option `appTokens?: AppTokenSource`. In `github(p)`:
`env = await ghEnvFor(this.opts.appTokens, p.trackerApp, p.query.trim())`. An `AppCredentialError` becomes a plain
`Error` with the same message; `run()` already turns it into `{ok:false, error}`. Then call
`env ? exec(bin, args, { env }) : exec(bin, args)`.

**`src/shifts/supervisor.ts:2420`**: `external.readText(ref, s.msg.trackerApp ? { app: s.msg.trackerApp } : undefined)`
(use whatever holds the `shift.start` message at that point).

**`src/runner.ts`**: `private readonly appTokenSource = brokerTokenSource(() => this.appBroker());` (per runner, like
`appProbe`; never a global, since several pairings share one process). Pass it to `ExternalAdapters.defaults` (~line 815)
and to `IntegrationPoller` (~line 912). Add `TRACKER_POST_AS_CAPABILITY` to `hello.capabilities` (~line 1647). Mind the
construction order: `this.appBroker()` is lazy, so a closure is safe.

### 4.4 Web (`apps/web`)

In `components/PostAsBlock.tsx`, under the intro paragraph ("Shifts commit, push and post as the ticked app's bot…"),
add one line:

> Comments on GitHub issues are posted as the selected GitHub App too. Jira comments still use this workstation's Jira
> connection: a GitHub App cannot post to Jira.

Plain text (`text-xs text-subtle`), no new controls, wraps on narrow screens (standing order: all devices). The block
renders only when the server sends `postAs`. Add a test in `apps/web/src/test/post-as.test.tsx`: the line is shown with
`postAs`; the existing "without postAs from the server the panel renders as before" test keeps covering its absence.
Leave the per-repository text ("Pull requests and comments also use that login for now") to GWP-216.

### 4.5 Docs

- `docs/ARCHITECTURE.md` §16.5: one paragraph covering the `trackerApp` payload field, `GH_TOKEN` env injection,
  covered vs fallback vs fail closed, the capability gate, and `findPosted` being author-agnostic.
- `docs/USER-GUIDE.md` ("Post as app"): issue comments and polling run as the app. Jira does not change.

## 5. Acceptance criteria → design → test

| AC | Where it is met | Test (runner unit unless noted) |
|---|---|---|
| 1. Approved post appears authored by `<slug>[bot]` | `OutboundExecutor` passes `trackerApp`. `GithubAdapter.gh` sets `GH_TOKEN` to the installation token. | `outbound-adapters.test.ts`: with an `appTokens` fake returning `ghs_test`, `postApproved` calls exec with `opts.env.GH_TOKEN === 'ghs_test'` and `GH_HOST === 'github.com'`, args unchanged, token not in args. Executor test: the payload with `trackerApp` reaches the adapter. `brokerTokenSource` test: scope is `{repositories: ['name']}` on `instance`, owner mismatch → `repository_not_accessible`, foreign copy → `app_mismatch`. **Manual QA** on the scratch repo with the test app confirms `<slug>[bot]` in the GitHub UI (`gh --json comments` shows a bot's login without `[bot]`). |
| 2. No duplicate after switching personal → app | `findPosted` stays body-only. The executor `lookFirst` fix. | (a) Record `attempting`, the issue has the same text by the personal user, the adapter runs with the app → `duplicate:true`, no `issue comment` call. (b) The same with the bot as author. (c) A `posted` record → no exec call. (d) `attempting` → retry with mint failing → `refused` + `lookFirst` → the next command with a working app finds the text and posts nothing. |
| 3. Polling uses the app token | `IntegrationPoller.github` + `ghEnvFor` | New `test/integration-poller.test.ts`: mocked exec plus a fake token source. Assert `opts.env.GH_TOKEN` (what `gh` sends as `Authorization: token …`), the `tokenFor` call with `({instance, integrationId}, 'acme/toy')`, and that a payload without `trackerApp` calls exec with no opts. |
| 4. No app → exactly as today | Field absent → `ghEnvFor` returns undefined → two-argument exec | Existing adapter tests pass **unchanged**. A new test asserts exec argument length 2 with no app. Server: no `trackerApp` key for a project with no app, a removed app, or a non-github.com app. |
| 5. Mint fails → error names the app, nothing posted | `AppCredentialError` → `PostError` before any `gh` call. Only `repository_not_accessible` (and another host) fall back. | Token source throws `AppTokenError('installation_suspended')` → `postApproved` rejects with `PostError` containing the label and bot name, and **exec is never called**. The poller returns `{ok:false}` with the label. No token source + app → fail closed. `repository_not_accessible` → exec without env (fallback). |
| 6. Jira unchanged, UI says so | `jira.ts` untouched (ignores `ctx`). §4.4 panel line. | Existing Jira tests pass unchanged. Web test for the line. |

Server tests: `trackerAppFor` (none, removed, GHES host, active); `queueOutboundPost` adds `trackerApp` only for a GitHub
draft of a project with an app, skips workstations without `tracker-post-as:1` and raises the notice; the poll action
includes `trackerApp` for a project schedule and not for an org schedule; `withCommitAs` adds `trackerApp` only when set.

Suites for the testers: none of this needs integration or E2E suites. Manual QA covers bot attribution on the scratch
repository.

## 6. Dependencies (landed; see §0 for how each was checked)

GWP-214 broker: `apps/runner/src/apps/broker.ts`, `types.ts`, `access-check.ts`, `github-app.ts`; shared
`packages/shared/src/apps/index.ts`. GWP-215 selection: `packages/shared/src/repo/post-as.ts`,
`apps/server/src/commands/post-as.ts`, `commit-as.ts`, `apps/web/src/components/PostAsBlock.tsx`.

## 7. Risks and traps

- **Fail open through old runners:** the `tracker-post-as:1` gate on `outbound.post` and `integration.run`.
- **Fail open through `GH_HOST`:** always set `GH_HOST=github.com` with the token.
- **Fail open through "not covered":** only `repository_not_accessible` (from the mint or the owner check) and a
  non-github.com app fall back. Unknown or other errors fail closed.
- **Wrong repository by name:** the broker scopes by name only; the owner check in `brokerTokenSource` prevents a token
  for a same-named repository of the installation account being used against another owner.
- **Per-runner broker:** never cache the token source or broker in a module global (several pairings per process).
- **The token in logs:** env only. Never argv, never a log of `opts`. Errors go through `redactSecrets`.
- **Duplicate on retry across the switch:** the `lookFirst` fix.
- **App permissions:** `issues: write` is in GWP-214's default set; an installation without it fails closed.
- **Out of scope, unchanged:** chat `aom source read` (`chat.ts:728`), Jira (`jira.ts`), and `forge/github.ts` (GWP-216).

## 8. Files touched (summary)

Shared: `external/index.ts` (TrackerApp, AdapterCallContext, optional `ctx`, payload field), `repo/post-as.ts`
(`TRACKER_POST_AS_CAPABILITY`), `protocol/runner.ts` (`IntegrationRunPayload.trackerApp`, `ShiftStart.trackerApp`), plus
a schema test.
Server: `commands/post-as.ts` (`trackerAppFor`), `commands/commit-as.ts` (`withCommitAs`), `commands/outbox.ts`,
`commands/schedule-actions.ts`, `commands/schedules.ts`, plus tests.
Runner: `external/app-token.ts` (new), `external/github.ts`, `external/index.ts`, `external/outbound.ts`,
`integrations/poll.ts`, `shifts/supervisor.ts` (one line), `runner.ts` (wiring and capability), plus tests.
Web: `components/PostAsBlock.tsx` (one line), `test/post-as.test.tsx`.
Docs: `ARCHITECTURE.md` §16.5, `USER-GUIDE.md`.

Size: about 250–350 changed lines across shared, server, runner and web; the card is flagged large.
