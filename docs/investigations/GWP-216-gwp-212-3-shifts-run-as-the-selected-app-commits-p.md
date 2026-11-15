# GWP-216 (GWP-212.3): shifts run as the selected GitHub App

Status: design, **revised against the landed GWP-214 (token broker) and GWP-215 (per-project "post as" selection)**.
Sections marked **(revised)** changed in the review. Section 8 lists each assumption, whether it held, and what changed.
Repository: GuildwiseHQ. Mostly the runner (`apps/runner`). Also one optional `postAs` field on the payloads that do
not carry it yet (`packages/shared`) and the server senders that fill it (`apps/server`) **(revised)**.

## 1. Question

When a project has a GitHub App selected, how does every git and forge action the runner takes for that project
(commits, pushes, fetches, pull requests, reviews, releases, branch-rule reads, repository creation) run as the app's bot
user, with tokens that refresh by themselves across shifts of any length, without changing anything for projects with
no app, and without weakening the sandbox?

## 2. Findings (current code, after GWP-214 and GWP-215)

### 2.1 What GWP-214 and GWP-215 already deliver (revised)

- **Broker** (`apps/runner/src/apps/broker.ts`): `AppTokenBroker.getAccessToken(instance, { repositories?, permissions? })`
  returns `{ token, expiresAt }` (`expiresAt` in epoch ms). It is keyed by `instance` (`"<appId>:<installationId>"`),
  caches in memory, refreshes when less than 10 minutes are left (`REFRESH_MARGIN_MS`), and shares one in-flight mint
  per scope key. It calls `registerSecret` on every new token and unregisters a replaced token 5 minutes later.
  `withToken(instance, scope, fn)` retries once on a 401. Errors are `AppTokenError { code: AppErrorCode }` with one
  value-free sentence (`APP_ERROR_TEXT`). There is **one broker per runner** (`runner.ts` `appBroker()`). Several
  pairings run in one process, and each has its own key store and broker.
- **Plan on the wire** (`packages/shared/src/repo/post-as.ts`): `postAs: PostAsPlan = { repos: PostAsRepo[] }`, where
  each `PostAsRepo` is `{ repoId, remoteUrlNormalized, source: 'app'|'project'|'repo', app?: PostAsAppIdentity,
  fallbackReason? }`. The server resolves each entry with `resolvePostAsRepo`. Unknown or errored coverage resolves to
  `app` (fail closed). `PostAsAppIdentity` = `{ integrationId, provider, label, botName, botEmail, instance, host }`. The
  plan is absent when the project has no app selected. `postAsFor(plan, remoteUrlNormalized)` finds one entry.
- **Payloads that carry `postAs` today:** `shift.start`, `finalize.execute`, `release.ship`, `release.publish`,
  `release.docs_prep`, `repo.bump_submodule`, `repo.create`, and the run's `rebaseCard`. Server side:
  `commands/commit-as.ts` `identityFields` / `identityFieldsFor` (with the `canPostAs` capability gate `post-as:1`).
- **Commit identity is done** (`apps/runner/src/git/identity.ts`). `resolveCommitIdentity(cwd, commitAs, postAs?:
  BoundPostAs)` returns `{ name: botName, email: botEmail, source: 'app', app }` when `postAs.source === 'app'`, after
  `postAs.probe.ensure(...)` mints a token scoped to the repository. When that fails it throws
  `AppIdentityError(app, appReason(err))` (`code = 'app_identity_failed'`), so nothing is committed under another
  identity. `BoundPostAs` = the entry plus this runner's `AppTokenProbe` (`runner.ts` `appProbe`, via
  `apps/access-check.ts` `appTokenProbe`, which also checks that the stored key belongs to the selected registration:
  `app_mismatch`). It is threaded into supervisor (shift identity, sandbox `.gitconfig`, leftovers), completion, rebase,
  sync-main, release-prep-task, release-ship, release-publish, release-docs-prep, submodule-pin, architect-git and
  runs/manager. Failures travel as `app_identity_failed: <message>` (`appIdentityWire`) and the server raises the app
  desk alert.
- `COMMIT_IDENTITY_SOURCES` contains `'app'`.

### 2.2 Commit identity gaps left

- `repo/create.ts:212,330` still call `resolveCommitIdentity(target, p.commitAs)` without `postAs`, although
  `repo.create` carries the plan.
- `delegate/delegate.ts:396` uses the workstation identity even when the delegate works in the caller's card worktree.
- Out of scope, unchanged: `vaults/sync.ts`, `chat/chat.ts`, `devops/saved-work.ts` stash commits (local only).
- DCO: `--signoff` uses the committer identity of the same env, so it follows automatically.

### 2.3 Git credentials (unchanged since the first design)

- One entry point: `gitAuthFor(forgeEnv, url, forge)` in `forge/index.ts` returns the ssh key auth, else
  `forge.gitAuth(url)`. `GitHubForge.gitAuth` (`forge/github.ts:99`) resets the host's helper list and points it at
  `gh auth git-credential` (the owner's gh login). GitLab, Bitbucket and Azure use `tokenHelperEnv` (`forge/http.ts`):
  the token sits only in the env of that one git process. No token is ever put in a URL or a config file.
- Every caller evaluates `auth(url)` immediately before the git command that needs it. No caller holds a `GitAuth` for
  minutes.
- The runner builds `auth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge)` in about 15 places in `runner.ts`
  and passes `forgePrCreator(this.forgeEnv)`, `branchRulesFor(this.forgeEnv, ...)` and `forgeEnv: this.forgeEnv` next
  to it.
- Hardening (`git/harden.ts`): `core.hooksPath=/dev/null` and `GIT_TERMINAL_PROMPT=0` on every runner git process.

### 2.4 Network git calls that bypass `auth`

`completion.ts` (fetch base, two sites), `rebase.ts` (fetch base), `sync-main.ts` (fetch, two sites), `git.ts`
`resolveDefaultBranch` (fetch), `merged.ts` (fetch, and **push --delete** of the card branch), `devops/saved-work.ts`
(**push --delete**), `devops/hygiene.ts` (fetch/pull/**push**), `devops/branch-cleanup.ts` (**push**),
`delivery/exec.ts`, `delivery/submodules.ts` (fetch). These act as the owner even with an app selected.

### 2.5 Forge API calls (unchanged)

- `GitHubForge.gh()` (`forge/github.ts:67`) runs `gh` with no token env, so every call uses the owner's gh login.
  This covers `status`, `listRepos`, `createRepo`, `defaultBranch`, `listOpenChanges`, `listMergedChanges`,
  `openChange` (+`existingChange`), `changeState`, `changeHeads`, `findRelease`, `createRelease`, `changeMergeCommit`
  and `branchRules`.
- `review/review-poster.ts` `GitHubReviewPoster` posts with a per-repository reviewer token from `ReviewerTokenStore`.
- The runner never merges a pull request through the API. "Merge" is a local `merge --no-ff` plus a push.

### 2.6 Sandboxes (unchanged)

Agent processes get an allow-listed env (no `GH_TOKEN`, no `SSH_AUTH_SOCK`), a private `HOME`, a `.gitconfig` with only
`[user]` and no credential helper. **Sandboxed agents have no forge credential and cannot push**; the runner pushes for
them.

## 3. Options

### 3.1 How the "act as app" decision reaches each operation

| Option | How | For | Against |
|---|---|---|---|
| A. Explicit per-payload scope | Each payload carries the plan (GWP-215). The handler builds one `ActorScope` and passes it where `this.forgeEnv`/`gitAuthFor` are passed today | Visible, testable, per runner; matches GWP-215's `BoundPostAs` pattern | A forgotten call site silently acts as the owner |
| B. Runner-wide repo -> app registry | `gitAuthFor`/`GitHubForge` look the repository up | Few call-site changes | Implicit; GWP-215 explicitly removed process-wide globals for app state |
| C. AsyncLocalStorage context | Handler runs inside `actAs.run(...)` | No signature change | Implicit; timers and IPC handlers outside the context fall back silently |

**Recommendation: A, plus a fail-closed push tripwire** (4.6) that only refuses, never chooses an identity.

### 3.2 How git gets the installation token

**Recommendation: a fresh token per git process via `tokenHelperEnv`**, as GitLab/Bitbucket/Azure do today. The broker
returns a cached token while more than 10 minutes are left, and every git operation calls `gitAuth` again, so a push at
hour 3 gets a token that is valid at hour 3. A callback helper (`git-credential-aom` over IPC) stays the fallback if
agents ever push themselves. Tokens in remote URLs or `git config` are forbidden.

### 3.3 Sandboxed agents

**Agents stay credential-free; they get the bot identity for their commits only** (GWP-215 already writes the bot into
the sandbox `.gitconfig`). Requirement 4 holds because no agent process can reach the forge with any credential. A test
locks that in.

## 4. Design

### 4.1 Wire model (revised)

Reuse GWP-215's `PostAsPlan` as it is. **No new schema, no `botCommitIdentity`:** the bot name and e-mail come
ready-made in `PostAsAppIdentity.botName`/`botEmail` (from GWP-214's `commitName`/`commitEmail`).

A repository acts as the app iff `postAsFor(plan, normalizeRemoteUrl(url))?.source === 'app'`. An entry with source
`project`/`repo`, a URL that is not in the plan, or an absent plan all mean today's credentials.

This card adds `postAs: PostAsPlanSchema.optional()` to the payloads that act on the forge but do not carry it yet:
`repo.open_pr`, `repo.release_facts`, `repo.list_prs`, `repo.list_merged_prs`, `repo.clone`, `repo.access`,
`pr_review.run`, `pr_review.post`, `branch.check_merged` and `repo.sync`. Server: each sender spreads
`identityFieldsFor(db, projectId, workstationId)` (or `loadIdentityPlan` where only `postAs` is wanted) exactly as the
GWP-215 senders do, conditionally (never `postAs: undefined`), behind the same `canPostAs` gate. Commands without a
project (`repo.sync` for a workstation-wide sync, if any) send nothing and keep today's behaviour.

### 4.2 New runner module `apps/runner/src/forge/app-actor.ts` (revised)

```ts
import type { PostAsAppIdentity, PostAsPlan } from '@aom/shared';
import { AppIdentityError, appReason, repoNameOf } from '../git/identity.ts';

/** The part of this runner's broker the actor needs (AppTokenBroker satisfies it). */
export type AppTokenSource = Pick<AccessCheckBroker, 'store' | 'getAccessToken' | 'withToken'>;

export interface AppActor {
  app: PostAsAppIdentity;
  repoName: string;                     // owner/name, lower-cased, from the plan entry
  /** A token for this repository; AppIdentityError(app, reason) on any failure. Never cached here. */
  token(): Promise<string>;
}

export interface ActorScope {
  forgeEnv: ForgeEnv;                    // base, or { ...base, app: (host, fullName) => AppActor | null }
  auth: (url: string, forge?: ForgeKind | null) => Promise<GitAuth>;
  /** The actor for one remote URL (null = today's credentials). */
  actorFor(url: string): AppActor | null;
}

export function actorScope(base: ForgeEnv, broker: AppTokenSource | null, plan?: PostAsPlan | null,
                           tripwire?: AppRepoRegistry): ActorScope;
```

- `actorScope(base, broker, undefined)` returns `{ forgeEnv: base, auth: (u, f) => gitAuthFor(base, u, f),
  actorFor: () => null }`. This is byte-for-byte today's behaviour.
- `token()` uses one shared helper next to `appTokenProbe` in `apps/access-check.ts`:
  `appAccessToken(broker, { instance, integrationId }, repoName): Promise<string>`. It runs the same stored-copy and
  `refs` check as the probe (`installation_not_found`, `app_mismatch`), then
  `(await broker.getAccessToken(instance, { repositories: [name] })).token` with `name` = the repository name without
  the owner. This is **the same scope key the probe uses**, so the commit-time probe and the push share one cached token.
  `appTokenProbe.ensure` is refactored to call it and drop the value. Errors become
  `new AppIdentityError(app, appReason(err))`.
- **Reuse GWP-215's `AppIdentityError` / `appIdentityWire` instead of a new `AppCredentialError`.** The server already
  turns `app_identity_failed:` into the app desk alert. There is no new reject code.
- No extra redaction bookkeeping: the broker already registers each token and retires replaced ones.
- No broker on this runner (should not happen, since `appBroker()` is lazy) or no key on this workstation: `token()`
  throws `AppIdentityError(app, APP_ERROR_TEXT.installation_not_found)`. Fail closed.
- `ForgeEnv` (`forge/types.ts`) gains `app?: (host: string, fullName: string) => AppActor | null`. This is a resolver
  rather than one actor, so multi-repository payloads (release components, submodule pins) pick the right entry per
  repository.

### 4.3 Identity (commits) (revised: mostly landed in GWP-215)

- No change to `resolveCommitIdentity`, `CommitIdentitySource` or the call sites GWP-215 wired.
- `repo/create.ts` (both sites): pass `bindPostAs(postAsFor(p.postAs, normalizeRemoteUrl(<new remote>)), probe)`.
  `RepoCreator` gets the runner's `appProbe` in its deps. A repository that does not exist yet normally has no plan
  entry, so this is today's path unless the server resolved one.
- `delegate.ts:396`: a delegate that works in its caller's worktree uses the caller shift's resolved identity
  (`caller.identity`, a new field set from `s.identity`) instead of `resolveCommitIdentity(paths.root)`. Without a
  caller identity, today's call.
- Out of scope, unchanged: `vaults/sync.ts`, `chat/chat.ts`, `devops/saved-work.ts` stash commits.

### 4.4 Git auth (pushes, fetches, ls-remote, clone)

`GitHubForge.gitAuth(url)`:

```ts
async gitAuth(url: string): Promise<GitAuth> {
  if (!isHttps(url)) return { args: [], env: {} };
  const actor = this.env.app?.(this.host, fullNameOf(url)) ?? null;
  if (actor) {
    const token = await actor.token();                   // AppIdentityError propagates: fail closed
    return { args: [], env: { ...tokenHelperEnv(this.host, 'x-access-token', token), AOM_GIT_APP: actor.app.integrationId } };
  }
  return /* today's gh helper, unchanged */;
}
```

- `tokenHelperEnv` empties the host's helper list first, so the owner's `gh auth git-credential` is never consulted for
  that host. `GIT_TERMINAL_PROMPT=0` stops a prompt fallback.
- **SSH remotes (revised: GWP-215 treats them as covered).** `normalizeRemoteUrl` maps `git@github.com:o/r` and
  `https://github.com/o/r` to the same `github.com/o/r`, and the access check compares normalized URLs, so an ssh-origin
  repository resolves to `source: 'app'`. A GitHub App has no ssh identity. `ActorScope.auth` therefore checks the scheme
  before `gitAuthFor`: if `actorFor(url)` is set and the url is not https, it throws `AppIdentityError(app, "The
  repository's origin uses SSH; an app can push over HTTPS only. Change the remote to https://<host>/<owner>/<repo>.git.")`.
  **Fail early:** because GWP-215 resolves the commit identity before any push, an ssh origin would otherwise let a
  shift commit as the bot and then fail only at the push. So the supervisor (shift start, before the worktree fetch)
  and each command handler check `git remote get-url origin` of the clone with `assertAppTransport(scope, url)` and
  reject with `appIdentityWire` up front.
- Pass `auth` to the bare network calls of 2.4 that belong to project work: `completion.ts` fetches (`input.auth`),
  `rebase.ts` (new optional `auth` param, supervisor passes the shift scope's auth), `sync-main.ts` (has
  `input.auth`/`opts.auth`), `git.ts` `resolveDefaultBranch` (has `opts.auth`), and `merged.ts` fetch and
  push --delete (`checkBranchMerged` gets `auth`). Each is a one-line change of the form
  `git(cwd, [...a.args, 'fetch', ...], { env: a.env })`.
- Background jobs without a payload (`devops/hygiene.ts`, `branch-cleanup.ts`, `saved-work.ts` push --delete,
  `delivery/*`) keep today's fetch credentials. Their pushes are stopped by the tripwire (4.6). Moving them onto the app
  is a follow-up.

### 4.5 Forge API (`gh`)

`GitHubForge.gh(args, input, repoFullName?)` becomes async and gets the token per invocation:

```ts
private async gh(args: string[], input?: string, repo?: string) {
  const actor = repo ? this.env.app?.(this.host, repo) ?? null : null;
  let tokenEnv: Record<string, string> = {};
  if (actor) {
    const t = await actor.token();                         // throws AppIdentityError: gh is not run
    tokenEnv = this.host === 'github.com' ? { GH_TOKEN: t } : { GH_ENTERPRISE_TOKEN: t };
  }
  return this.env.exec.run(this.bin, args, { ..., env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1',
    ...(this.host !== 'github.com' ? { GH_HOST: this.host } : {}), ...tokenEnv } });
}
```

Every repository method passes `repo.fullName`. Methods that do not work with an installation token get an app branch:

| Method | App mode |
|---|---|
| `status()` | Not per repository: unchanged (owner's login status on the Workstations page). App health is GWP-214's `broker.health()` |
| `listRepos()` | Unchanged (workstation-level listing, no project) |
| `createRepo()` | Today's path. A not-yet-existing repository has no plan entry (4.3) |
| `openChange`, `existingChange`, `changeState`, `changeHeads`, `listOpenChanges`, `listMergedChanges`, `findRelease`, `createRelease`, `changeMergeCommit`, `defaultBranch` | Same `gh` command with the app token |
| `branchRules()` | Same; a 403 (no Administration: read) keeps returning `null`, as today |

(revised: `status`/`listRepos`/`createRepo` need no app branch, because they have no project repository and so no plan
entry. This removes the earlier `gh api /installation/repositories` and `orgs/<org>/repos` branches.)

`forgePrCreator`, `branchRulesFor`, `listOpenPrs`/`listMergedPrs`, `publishRelease` receive the scoped `forgeEnv`.
`forgePrCreator` must let `AppIdentityError` propagate (it maps only `ForgeUnavailableError` to `unavailable`), so a
failing app never degrades to "push and let the manager open the PR by hand".

PR reviews (`GitHubReviewPoster`): `post` gets an optional `actor?: AppActor | null` (from the `pr_review.post` scope).
When it is set, the request runs through `broker.withToken(instance, { repositories: [name] }, fn)` (one retry on 401)
with the Authorization header as today. Otherwise the reviewer token store is used as today (`reviewer_token_missing`
unchanged). The app wins over a saved reviewer token. The app needs Pull requests: write.

### 4.6 Fail-closed push tripwire (`git/git.ts`) (revised: per runner root, not process-wide)

New `forge/app-repos.ts`: `AppRepoRegistry` holds entries `{ root, remoteUrlNormalized, integrationId, label }`, where
`root` is the runner's `paths.root` (every clone and worktree of a pairing lives under it). One module-level instance
holds no credentials. `actorScope(..., tripwire)` upserts an entry for each plan entry with `source: 'app'` and removes
it when a later plan for the same root and repository has another source. In `git()`, for subcommand `push` only: if
`opts.env?.AOM_GIT_APP` is missing and an entry exists whose `root` contains `cwd` and whose repository equals the
normalized push target (the url argument, else `git remote get-url <remote>`), refuse with exit 128 and
`refusing to push: <repo> posts as the app '<label>'; this push had no app credential, so nothing was pushed with another identity`.
Keying by root keeps two pairings in one process apart (the reason GWP-215 moved its probe off a global). The registry
only refuses; it never chooses an identity.

### 4.7 Wiring (revised)

`runner.ts`: `private scopeFor(plan?: PostAsPlan | null): ActorScope` returns
`actorScope(this.forgeEnv, this.appBroker(), plan, appRepos.forRoot(this.paths.root))`. In each handler:

| Command | Change |
|---|---|
| `finalize.execute` | `pr: forgePrCreator(scope.forgeEnv)`, `auth: scope.auth`, `rules: branchRulesFor(scope.forgeEnv, ...)`; the follow-up sync gets `scope.auth` |
| `repo.open_pr`, `repo.release_facts`, `repo.list_prs`, `repo.list_merged_prs` | `scope.auth`, `scope.forgeEnv` (payloads gain `postAs`, 4.1) |
| `release.ship`, `release.docs_prep`, `release.publish` | `scope.auth`, `forgeEnv: scope.forgeEnv`, `pr: forgePrCreator(scope.forgeEnv)` |
| `repo.bump_submodule` | `scope.auth` |
| `repo.create`, `repo.clone`, `repo.access` | scoped `forgeEnv` per call; `repo.create` also passes the probe (4.3) |
| `branch.check_merged` | `auth: scope.auth` |
| `pr_review.run` / `pr_review.post` | scoped `forgeEnv`/auth; poster gets `scope.actorFor(remote)` |
| `repo.sync` | `scope.auth` through `SyncService.sync(target, { auth })` (new optional override) |

The commit identity is not touched here: GWP-215's `boundPostAsFor(...)` calls stay as they are.

`shifts/supervisor.ts`: at shift start `s.scope = this.deps.actorScope(msg.postAs)`. Before the worktree fetch, run
`assertAppTransport` (4.4); on `AppIdentityError`, `this.reject(msg.shiftId, 'internal', appIdentityWire(err))` (same
path GWP-215 uses). Every `this.deps.gitAuth` in the shift's life (`ensureWorktree`, `syncMainIntoWorking`,
`mergeMainIntoCard`, `rebaseOntoBase`, architect git, `aom git fetch|merge-main`, run start) becomes `s.scope.auth`.
`runs/manager.ts` builds its scope from `rc.postAs` the same way.

### 4.8 Branch protection and permission reports (`git/gh.ts`)

New `describePushRejection(output: string, app?: { label: string; botName: string }): string | null` next to
`isProtectedBranchRejection`:

| git output | Report |
|---|---|
| `GH006: Protected branch update failed for refs/heads/<b>.` + reason line | `GitHub refused the push to <b>: branch protection (<reason>). Give the app '<label>' a bypass (Settings > Branches > <rule> > "Allow specified actors to bypass required pull requests") or let changes go through a pull request.` |
| `GH013: Repository rule violations found for refs/heads/<b>` + `- <rule>` lines | `... repository ruleset (<rules>). Add the app '<label>' to the ruleset's bypass list (Settings > Rules > Rulesets > Bypass list).` |
| `Permission to <repo>.git denied to <botName>` / `403` | `The app '<label>' cannot write to <repo>: it needs Contents: Read and write, and the installation must include <repo>.` |
| `refusing to allow a GitHub App to create or update workflow '<path>' without 'workflows' permission` | `The change touches <path>; the app '<label>' needs Workflows: Read and write.` |
| `Resource not accessible by integration` (gh) | `The app '<label>' lacks a permission for <operation>: Pull requests: write (PRs, reviews), Contents: write (releases), Administration: read (branch rules).` |

It is used in `completion.ts` (merge push failure and the protected-branch fallback to a PR, whose result carries the
report), in the push failures of `release-ship.ts`, `release-publish.ts`, `submodule-pin.ts` and `sync-main.ts`, and in
`GitHubForge` gh failures. All outputs pass through `redact`.

### 4.9 Required app permissions (user guide)

Contents: write; Pull requests: write; Metadata: read; Administration: read (branch rules); Workflows: write (only if
cards change `.github/workflows`); Issues: write (GWP-217). These match GWP-214's `DEFAULT_APP_PERMISSIONS` plus the two
optional ones.

## 5. Files to change (revised)

| File | Change |
|---|---|
| `packages/shared/src/protocol/runner.ts` (and wherever `pr_review.*`, `branch.check_merged`, `repo.clone`, `repo.access`, `repo.list_*` live) | `postAs: PostAsPlanSchema.optional()` on the 10 payloads in 4.1 |
| `apps/server/src/...` senders of those commands | spread `identityFieldsFor`/`loadIdentityPlan` (conditional, capability-gated) |
| `apps/runner/src/forge/app-actor.ts` (new) | `AppActor`, `ActorScope`, `actorScope`, `assertAppTransport` |
| `apps/runner/src/forge/app-repos.ts` (new) | push tripwire registry, keyed by runner root |
| `apps/runner/src/apps/access-check.ts` | `appAccessToken` helper; `appTokenProbe` uses it |
| `apps/runner/src/forge/types.ts` | `ForgeEnv.app?` resolver |
| `apps/runner/src/forge/github.ts` | async `gh()` with token env, `gitAuth` app branch |
| `apps/runner/src/forge/index.ts` | `forgePrCreator` lets `AppIdentityError` through |
| `apps/runner/src/git/git.ts` | push tripwire; `resolveDefaultBranch` fetch with auth |
| `apps/runner/src/git/gh.ts` | `describePushRejection` |
| `apps/runner/src/git/completion.ts`, `rebase.ts`, `sync-main.ts`, `merged.ts` | auth on bare fetch/push; rejection reports |
| `apps/runner/src/git/release-ship.ts`, `release-publish.ts`, `submodule-pin.ts` | rejection reports |
| `apps/runner/src/review/review-poster.ts` | app actor path via `withToken` |
| `apps/runner/src/repo/create.ts` | pass bound `postAs` |
| `apps/runner/src/delegate/delegate.ts` | caller identity |
| `apps/runner/src/shifts/supervisor.ts` | `s.scope`, transport check, scoped auth |
| `apps/runner/src/runner.ts` | `scopeFor(plan)` and the handler wiring in 4.7 |
| `apps/runner/src/repo/clone.ts`, `access.ts`, `runs/manager.ts`, `git/sync-service.ts` | scoped env/auth per call |
| `docs/RUNNER.md`, `docs/USER-GUIDE.md` | app credential, permissions, fail-closed, ssh limitation |

No longer changed: `git/identity.ts`, `packages/shared/src/repo/commit-identity.ts` (GWP-215 did it). Expected size:
500 to 800 changed lines plus tests. Large.

## 6. Acceptance criteria -> design -> tests

| AC | Design | Test (unit) |
|---|---|---|
| Builder shift commits show `<slug>[bot]` as author and committer; none carries the owner | GWP-215 identity (landed) + 4.4/4.7 push with the app | existing `post-as-identity` tests cover the identity; new supervisor test: app shift's worktree fetch/push env has `AOM_GIT_APP` and the token helper, never the gh helper |
| Merge, rebase, sync-main, release, submodule-pin commits carry the bot | GWP-215 (landed); repo create added (4.3) | existing `post-as-git-steps` tests; new: `repo.create` initial commit `%an|%ae|%cn|%ce` = bot when the plan has an entry |
| PR, its comments/reviews and its merge attributed to the bot | 4.5 gh token env; review poster via `withToken`; merges are bot commits pushed with the app token | fake `Executor`: `gh pr create` env has `GH_TOKEN` = broker token (GHES: `GH_ENTERPRISE_TOKEN`); review poster sends the app token; merge push env has `AOM_GIT_APP` |
| Push more than 1 hour after the first succeeds without manual action | 3.2 per-operation `gitAuth`; broker refresh (GWP-214) | real `AppTokenBroker` with a fake provider (60-minute tokens) and fake `now`: push at t0 uses token1; advance 51+ minutes; next push and next gh call use token2 |
| No remote URL, git config, env dump or transcript contains a token | env-only helper, agents credential-free, broker redaction | after an app-mode completion: grep `.git/config`, `.git/worktrees/*/config`, sandbox `.gitconfig`, `s.env`, log lines for the token -> none; `sandboxEnv` has no `GH_TOKEN`/helper; `redact(token)` masks it |
| No app selected: identical to today | `actorScope(base, broker, undefined)` returns base env/auth | existing `completion*`, `commit-identity`, `repo-identity`, `rebase`, `release*`, `delegate`, `github` suites unchanged and green; new: gh env has no `GH_TOKEN`, `gitAuth` returns the gh helper args exactly as before; a plan entry with source `project` behaves the same |
| App uninstalled mid-shift: next push fails naming app and reason; nothing pushed with another identity | `token()` -> `AppIdentityError`; `forgePrCreator` propagates; tripwire 4.6 | fake provider throws `AppTokenError('installation_not_found')` on the 2nd mint: completion `ok:false`, error starts `app_identity_failed:` and names the app and `APP_ERROR_TEXT.installation_not_found`; bare remote has no new ref; no git process ran with the gh helper; tripwire test: push without `AOM_GIT_APP` to a registered repository is refused, another root is not affected |
| Push rejected by branch protection reports the rule and the bypass/permission | 4.8 | table tests for `describePushRejection` with real GH006/GH013/403/workflows outputs; completion merge against a stub remote that rejects -> result carries the report |

Also: ssh origin + app -> shift rejected at start with the ssh message, no commit made.

Regression to run (unit only): runner `completion`, `identity`, `post-as`, `commit-identity`, `repo-identity`,
`rebase`, `release`, `submodule`, `sync-main`, `delegate`, `github`, `forge`, `review-poster`, `sandbox`; shared
protocol tests; server tests of the senders touched. Left for testers: the live check on a scratch repository with a
test GitHub App (commit, push, PR, review, merge attribution; a push after the token TTL; the same with no app).

## 7. Risks and traps

- **Missed call site acts as the owner.** Mitigated by the push tripwire and the per-path tests. A missed fetch is a
  read, not an attribution.
- **SSH origins** resolve as covered (GWP-215). Fail early at shift or command start with the ssh message (4.4).
  Follow-up: show the ssh limitation in the post-as panel.
- **Scope key:** the push must ask for `{ repositories: [name] }` exactly as the probe does, or each commit-time probe
  and push mint separate tokens (still correct, but doubles the mints).
- **`gh()` becomes async:** every caller already awaits its result, but check the sync uses in `github.ts`.
- **Workflow files** need Workflows: write; the rejection report names it.
- **GHES:** `gh` reads `GH_ENTERPRISE_TOKEN` with `GH_HOST`.
- **Branch delete after merge** (`merged.ts`) is migrated here. Hygiene and branch-cleanup pushes are refused by the
  tripwire for app repositories until their follow-up.
- **Several pairings in one process:** actors and the tripwire are bound to the runner (broker, `paths.root`), never a
  process-wide choice.
- **Older runners:** the server's `canPostAs` gate must also cover the newly extended commands.
- Human-merged PRs on GitHub are attributed to the person who merges.

## 8. Assumptions about GWP-214 and GWP-215, checked against the landed code

1. **Broker API: did not hold as written.** The real API is `AppTokenBroker.getAccessToken(instance, { repositories?,
   permissions? })` -> `{ token, expiresAt: number }`. It is keyed by `instance` (`appId:installationId`), repositories
   are given by name without the owner, it has `withToken` for 401 retry, it already handles redaction, and errors are
   `AppTokenError { code }`. The refresh margin (10 minutes), memory-only cache and single flight hold. Change: only
   `app-actor.ts` (via the new `appAccessToken` helper in `access-check.ts`) adapts. GWP-215's `AppIdentityError`
   replaces the planned `AppCredentialError`, and the separate redaction bookkeeping is dropped.
2. **Bot identity derivation: did not hold as written.** GWP-214 stores `appSlug` and `botUserId`, but also ready-made
   `commitName`/`commitEmail`, and GWP-215 sends them as `botName`/`botEmail` in the plan. Change: `botCommitIdentity`
   is dropped; the runner uses the plan's values (already done by GWP-215's `resolveCommitIdentity`).
3. **Selection on the wire: did not hold as written.** It is a per-payload `PostAsPlan` with an entry for every
   repository (also `project`/`repo` fallbacks with a reason), not a single covered-only `postAs`. Only 8 payloads
   carry it, and GWP-215 already wires the commit identity. Changes: act as the app iff the entry's `source === 'app'`;
   `ActorScope.commitAs` is dropped; `ForgeEnv.app` becomes a per-repository resolver; this card adds `postAs` to the
   10 forge-facing payloads that lack it and to their server senders (the card is no longer runner-only).
4. **`'app'` in `CommitIdentitySource`: held.** `COMMIT_IDENTITY_SOURCES` ends with `'app'`.
5. **SSH origins not covered: did not hold.** `normalizeRemoteUrl` makes ssh and https equal, so ssh-origin repositories
   resolve to the app. Change: the fail-closed ssh error stays and moves to shift/command start, because the bot commit
   would otherwise be made before the push fails.
6. **Broker in the runner process: held**, with one refinement: there is one broker per runner, and several runners
   share a process. The actor is bound to the runner that received the payload, like GWP-215's `BoundPostAs`.

Also changed by the landed code (not a numbered assumption): the push tripwire registry is keyed by the runner's
`paths.root` instead of being one process-wide map by remote URL (GWP-215 commit "app token probe per runner instead of
a process-wide global"). `status`/`listRepos`/`createRepo` no longer need app branches (no plan entry without a project
repository).

## 9. Follow-ups (outside this card)

- Hygiene, branch cleanup and delivery fetch/push as the app (their commands need the project's plan).
- Post-as panel: warn when a covered repository's clone uses an ssh origin.
- Agents that push themselves, if ever wanted, through a callback credential helper.
- DevOps engineer pushing over ssh with `SSH_AUTH_SOCK` in an app-selected project acts as the owner; consider refusing
  or documenting.
- Route app projects to workstations that hold the key (GWP-215 risk list).
