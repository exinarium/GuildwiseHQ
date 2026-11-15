# GWP-236: DevOps operations run as the selected app

Base: working branch at `54d07a0a`. This design builds on the "shifts run as the selected app" branch (9 commits on
top of `54d07a0a`, last one `ef19b8a9`), which has not merged yet. Every symbol below marked "(216)" comes from that
branch: `forge/app-actor.ts`, `forge/app-repos.ts`, `Runner.scopeFor`, the push tripwire in `git/git.ts`,
`postAsFieldFor`/`identityFieldsFor` in `apps/server/src/commands/commit-as.ts`. **The build waits for that branch to
merge** (recorded as a dependency).

## 1. Question

When a project has a "post as" app selected, every git and forge write on that project must use the app: its
installation token for the remote, and its bot identity for commits. Shifts are covered by the 216 branch. This card
covers DevOps work and the runner commands that still use the owner's credentials. It also has to fail closed (an app
that cannot mint stops the operation, with no fallback to the owner) and replace the push-tripwire release with one
mechanism.

## 2. Findings

### 2.1 Where the shift app identity lives

- The card refers to `forge/app-actor.ts`. That file does not exist on the working branch; it is new on the 216 branch.
  It holds `actorScope(base, broker, plan, tripwire)`, which returns `{ forgeEnv, auth, actorFor }`, plus
  `appOriginRefusal`, `commandCarriesPlan`, `payloadRepoUrls` and `releaseUncoveredRepos`. The runner reaches it through
  `Runner.scopeFor(plan)` (216).
- Commit identity: `git/identity.ts` `resolveCommitIdentity(cwd, commitAs, boundPostAs)`. For `source: 'app'` it
  checks the app can mint (`probe.ensure`) and returns the bot name and e-mail; otherwise `AppIdentityError`.
- Push tripwire (216): `forge/app-repos.ts` `appRepos`, a **process-wide** registry keyed by runner root. `git()` in
  `git/git.ts` refuses a `push` with no `AOM_GIT_APP` env marker to a registered repository. Entries are added by
  `actorScope(..., tripwire)` and removed by `releaseUncoveredRepos`. The registry lives in memory only.
- Server (216): `loadIdentityPlan`, `identityFields`, `identityFieldsFor` (409 `runner_too_old` without `post-as:1`),
  `postAsFieldFor(db, projectId, wsId, { write })` and `withCommitAs(ctx, shiftStart)`. `loadPostAsPlan` returns
  `null` when no app is selected, so payloads stay exactly as before.

### 2.2 DevOps shifts never carry an identity plan (main gap)

`apps/server/src/dispatcher/devops.ts` sends `shift.start` with `withCommitAs(ctx, built)`. But
`buildDevopsShiftStart` (`runner-gateway/brief.ts:1031`) puts a **placeholder project** in the brief
(`project.id = requestId`, key `DEVOPS`). So `loadIdentityPlan(requestId)` finds no project, and a DevOps
`shift.start` never has `postAs` or `commitAs`, even when the request is about a card of an app-selected project.
`worktree` is `null`.

The DevOps engineer is the one agent that runs outside the OS sandbox. It runs `git` and `gh` **in its own shell, as
the user**, and the prompt says so (`prompt/devops.ts`: "You may fetch, pull and push with the user's git
credentials"). The only control on those commands is the PreToolUse guard (`devops/guard.ts`, `aom devops-guard`). It
blocks force-pushes to protected branches and off-workstation commands; it knows nothing about apps.

### 2.3 Hygiene runs in the CLI process, outside the tripwire

`aom hygiene run` (`aom/aom-cli.ts:2201`) calls `runHygiene` **inside the `aom` CLI process** that the agent's shell
starts. Its `git()` calls run there and never pass `auth`. The 216 design (section 2.5) says the hygiene pushes "are
stopped by the tripwire". **That is not true:** the tripwire registry is filled in the runner process, and the CLI
process has an empty registry. Today, hygiene pushes, `push --delete` (branch cleanup, saved work) and fetches all go
with the owner's credentials, whatever the project selected.

### 2.4 Inventory: every DevOps/runner path that writes to git or the forge

"Before" is the 216 branch (this card's base once it merges). "After" is this design.

| # | Operation | Code path | Before (credential / identity) | After |
|---|---|---|---|---|
| 1 | Hygiene `fetch --prune`, `pull --ff-only`, `pull --rebase`, `push origin <wb>` (3 sites) | `devops/hygiene.ts` via `aom hygiene run` (CLI process) | Owner (user git config). Rebased commits get the DevOps env identity as committer. No plan, no tripwire. | Runs in the runner (`hygiene.run` rpc). Per repository: `scope.auth(url)` from the DevOps shift plan. Rebase gets `committerEnv(bot)` on app repos. Mint failure: repo problem `app_identity_failed`, no remote call. |
| 2 | Finished-card branch delete on origin (`push --delete --force-with-lease`) | `devops/branch-cleanup.ts` `cleanFinishedCards` (from hygiene) | Owner | `auth` passed in from hygiene, same as #1 |
| 3 | Old saved-work branches: fetch + `push origin --delete` | `devops/saved-work.ts` `migrateSavedWorkBranches` (from hygiene) | Owner | `auth` passed in, same as #1. Stash commits are local only: N/A. |
| 4 | PR state reads during hygiene | `hygiene.change_state` rpc → `Runner.changeState` | Owner `forgeEnv` (read) | `scope.forgeEnv` of the shift plan (read; this keeps one identity per project) |
| 5 | DevOps engineer `git push` (any refspec, tags, `--delete`) in its shell | agent Bash | Owner (user git config / gh helper / ssh agent) | Guard refuses raw push to an app repository → `aom git push --repo <dir> ...` (runner rpc `devops.git`, app token). No-app repositories: unchanged. |
| 6 | DevOps engineer `git fetch` / `pull` / `ls-remote` in its shell (conflict resolution step 2) | agent Bash | Owner | Guard refuses for app repositories → `aom git fetch --repo <dir>` (runner, app token). No-app: unchanged. |
| 7 | Conflict-resolution rebase/merge/commit in the scratch worktree and `merge --ff-only` into the card worktree | agent Bash (`conflict-attempts.ts` brief) | Committer = workstation identity (DevOps shift has no commitAs/postAs) | For a card request whose card repository resolves to an app: the DevOps env carries `commitEnv(bot)` (author and committer). The guard refuses HEAD-moving git (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `pull`) in an app repository when the env identity is not that app's bot. |
| 8 | Push of the resolved card branch, merge, PR | runner `finalize.execute` | App (216) | Unchanged (216) |
| 9 | DevOps engineer `gh` writes (`pr create/edit/comment/merge/close/review`, `issue comment/create`, `release *`, `api` with a write method or `-f/-F`) | agent Bash | Owner gh login | Guard refuses for app repositories (target from `-R/--repo`, else cwd origin; unknown target while the plan has app repositories = refuse). The PR/merge path is `finalize.execute`/`repo.open_pr` (216). |
| 10 | `repo.commit_status` (hard size check) | `forge/commit-status.ts` → `GitHubForge.setCommitStatus` | **Owner-supplied status token** (`statusTokens`). Payload has no `postAs`. | Payload gets `postAs`. With an actor: `actor.token()` (never the status token). Mint failure: `{ ok:false, code:'app_identity_failed' }`. |
| 11 | `pr_review.notice` (split-the-PR comment review) | `PrReviewCommands.notice` → `GitHubReviewPoster` | Owner reviewer token. Payload has no `postAs`. | Payload gets `postAs`; poster gets `actor` exactly like `post()` (216) |
| 12 | `pr_review.post` | review poster | App (216) | Unchanged |
| 13 | `repo.open_pr`, `release.ship`, `release.docs_prep`, `release.publish`, `repo.bump_submodule`, `branch.check_merged` (fetch + remote branch delete), `repo.create` | runner commands | App (216) | Unchanged; test only that the plan still arrives |
| 14 | `release.ref_cleanup` | `deleteKeptReleaseRef` (`update-ref -d`, local) | Local only | N/A (no remote) |
| 15 | `worktree.remove` (`deleteBranch`), `worktrees.sweep` | local | Local only | N/A |
| 16 | `repo.sync` / background `SyncService` | fetch + local fast-forward | Owner fetch (216 sends `postAs` but the handler ignores it) | Read only, so not in this card's write scope. Listed as a follow-up. |
| 17 | `outbound.post` (tracker) | external adapters | GWP-217 | Unchanged (out of scope) |
| 18 | `vault.*`, `packs.sync`, `deploy.*`, `delivery.send` | not a project repository / not git writes to the project forge | n/a | Out of scope |

Rows 5, 6, 7 and 9 also cover "merges, branch cleanup, tag/release pushes, PR create/update, comment posts" when the
DevOps engineer does them by hand. Rows 10 and 11 are the runner commands that write to the forge without a plan
today.

### 2.5 The tripwire finding (runner.ts around 2138/2179, 216)

On the 216 branch, `onMessage` releases the tripwire for any command whose schema has a `postAs` field and whose
payload has none (`commandCarriesPlan` + `releaseUncovered`). A missing `postAs` therefore means "no app selected".
If the server leaves out a plan by mistake, or an older server sends the command, the runner releases the entry and
pushes as the owner. Today the runner cannot tell "no app" from "plan missing", because GWP-215 defines "no app" as
"field absent".

## 3. Options

### 3.1 DevOps engineer's own git/gh (rows 5, 6, 9)

- **A. Credential helper in the agent env.** URL-scoped `credential.<url>.helper=!aom git-credential` returns an
  installation token to git. Raw git keeps working. But the agent can run the helper itself and print the token into
  its transcript. That breaks "tokens stay redacted", and the token enters the agent's process tree.
- **B. Runner does the network part; the guard refuses raw writes to app repositories (recommended).** `aom git
  push|fetch --repo <dir>` is an rpc to the runner. The runner resolves the repository from the shift plan and runs git
  with `scope.auth`, so the token never leaves the runner. The guard (already on every DevOps Bash command) refuses
  raw `git push/fetch/pull/ls-remote` and `gh` writes aimed at an app repository, and its message names the `aom`
  command to use. As defence in depth against guard bypasses (the guard is documented as not a security boundary),
  the DevOps env also gets `url."https://app-push-refused.invalid/".pushInsteadOf=<origin url>` for every app
  repository clone. A raw push then fails at DNS instead of going out as the owner.
- **C. Forbid DevOps any remote work on app projects.** Simple, but hygiene and conflict fetches stop working on app
  projects. Rejected.

### 3.2 Hygiene (rows 1 to 4)

- **A. Keep it in the CLI and ask the runner for a token per repository.** The token reaches the agent's process.
  Rejected (same reason as 3.1 A).
- **B. Run hygiene in the runner (recommended).** New supervisor rpc `hygiene.run`. The runner reads the spec from its
  own copy of the brief (`s.msg.devops.hygiene`, so the agent cannot change it) and calls `runHygiene` with per-repo
  `auth` and identity from the shift scope. The CLI becomes a thin rpc client. The runner and CLI ship in one package,
  so there is no version skew.

### 3.3 Where the plan comes from for DevOps

- **A. One plan per request (recommended):** the server builds the DevOps `shift.start` `postAs` as the union of
  `loadPostAsPlan` for every project that has a repository on that workstation (`workstation_repos` →
  `project_repos.project_id`), each entry tagged with `projectKey`. This covers card requests, hygiene (multi-project)
  and generic requests ("fix my checkout") with one rule. The schema cap is 200 entries; past it, refuse to dispatch
  with a clear message (do not truncate).
- B. Only the card's project: leaves hygiene and generic requests on the owner. Rejected.

### 3.4 One tripwire mechanism (req. 7)

- **A. Explicit "no app" plan + no release on absence (recommended).** A runner with the new capability
  `post-as:2` always gets `postAs` on every plan-carrying command and DevOps/card `shift.start`. "No app selected" is
  `postAs: { repos: [] }`, or entries with `source: 'project' | 'repo'`. On such a runner:
  - `postAs` present (even empty): release the uncovered repositories of the payload, as 216 does.
  - `postAs` **absent** on a plan-carrying command or `shift.start` whose payload repository is registered in the
    tripwire: **reject**. The command fails with `app_identity_failed: The app <label> could not be used: the command
    arrived without the app identity (project <KEY>, <operation> on <owner/repo>). Nothing was ...`, and the tripwire
    stays as it is. Never release, never run as the owner.
  - `postAs` absent and nothing registered: today's behaviour (no-app project).
  - Commands that cannot carry a plan (local-only rows 14 and 15, packs, vault, ...) still leave the tripwire alone
    (216 `commandCarriesPlan`).
  - The tripwire registry is persisted per runner root in `app-repos.json` (repo URL → integrationId, label; no
    credential), so a restart does not forget which repositories are app-only. A registry entry only ever refuses.
- B. Keep 216 as is (absent = release). This leaves the Linus finding open. Rejected.

A server on this card's version sends `postAs` to `post-as:2` runners on every plan-carrying command. So an absent
plan reaches a `post-as:2` runner only from an older server, or by a bug, and that is exactly the case that must fail
closed.

## 4. Recommendation and design

Take 3.1 B + 3.2 B + 3.3 A + 3.4 A. Build after the 216 branch has merged, reusing `actorScope`, `scopeFor`, the
tripwire and `postAsFieldFor`.

### 4.1 Shared (`packages/shared`)

- `repo/post-as.ts`:
  - `POST_AS_V2_CAPABILITY = 'post-as:2'`: "every repository command and DevOps shift honours `postAs`; an absent
    plan on an app repository is refused".
  - `PostAsRepoSchema` gets optional `projectKey: z.string().max(40)`, used for error text. Additive: old runners strip
    it.
  - `appOperationText(op)` is a small map of operation names used in messages: `push`, `fetch`, `delete branch`,
    `push tag`, `commit status`, `PR comment`, `hygiene`, `conflict resolution`.
- `protocol/runner.ts`: `RepoCommitStatusPayloadSchema` gets `postAs: PostAsPlanSchema.optional()`.
  `RepoCommitStatusResult` code enum gets `'app_identity_failed'`.
- `review/pr-review.ts`: `PrReviewNoticePayloadSchema` gets `postAs`. The schema is `.strict()`, so an older runner
  rejects a payload with the field. That is fine: the server sends it only to `post-as:2` runners and otherwise
  refuses the notice for app projects. `PrReviewNoticeResultSchema` code enum gets `'app_identity_failed'`.
- `hygiene/index.ts`: `HygieneProblemKind` gets `'app_identity_failed'`.
- `devops/index.ts`: `DevopsShift.card` gets optional `remoteUrlNormalized`. `DevopsShift` gets optional
  `appRepos: Array<{ remoteUrlNormalized; localPath?; label; botEmail }>`, filled by the runner for the guard (no
  secrets).
- `ShiftStartPayload.postAs` already exists; no change.

### 4.2 Server (`apps/server`)

- `commands/commit-as.ts`:
  - `loadPostAsPlan` tags each entry with `projectKey`.
  - New `explicitPostAs(db, projectId, wsId, { write })`. For a runner with `post-as:2` it always returns `{ postAs }`
    (the empty plan when no app is selected). Without `post-as:2`, it keeps 216's `postAsFieldFor` behaviour, but
    refuses (409 `runner_too_old`) when the project has an app and the command is one only `post-as:2` honours
    (commit status, notice, DevOps).
  - Switch every 216 caller of `postAsFieldFor`/`identityFieldsFor` to `explicitPostAs` (keep `commitAs` as is), so
    absence never means "no app" on a new runner.
  - `withCommitAs` (card/BA/question shifts) does the same for `post-as:2` runners.
- `dispatcher/devops.ts` + `runner-gateway/brief.ts`:
  - Replace `withCommitAs(ctx, built)` with `withDevopsPostAs(ctx, built, req)`. It builds the union plan of 3.3 A
    and **does not add `commitAs`**: DevOps commits on no-app projects keep today's identity (req. 6). It adds
    `devops.card.remoteUrlNormalized` for card requests.
  - If any union entry is `source: 'app'` and the workstation lacks `post-as:2`: do not dispatch. Fail the request
    with `POST_AS_RUNNER_TOO_OLD_MESSAGE` and project name(s).
  - If the plan exceeds 200 entries, fail the request with a clear message.
- `commands/pr-size-status.ts` `queueStatus`: add `...explicitPostAs(tx, projectId, wsId, { write: true })`.
  `pickStatusWorkstation`: when the repository resolves to an app, accept a workstation that has `post-as:2` without
  a status token (`w.status_tokens ? $3 OR (<app> AND 'post-as:2' = ANY caps)`).
  `applyCommitStatusResult`: on `code === 'app_identity_failed'`, raise the project alert (below) and do not count it
  as a token problem.
- `commands/pr-size-check.ts:595` (`pr_review.notice`): add `explicitPostAs(..., { write: true })`.
- `commands/conflict-attempts.ts` `cardConflictBrief`: step 2 becomes "`aom git fetch --repo <repo>` then rebase ...".
  The command works for every project; for a no-app project it fetches with the same credentials as before.
- App failure alert: generalize `appIdentityFailedNotice` (`commands/shifts.ts`, 216) into
  `appIdentityFailedAlert(tx, { orgId, projectId, cardId?, detail, what })`. Use it from shift rejection (as now),
  the DevOps request completion (outcome text starts with `app_identity_failed:`), and command results (commit
  status, notice). The title stays parsed from `The app <label> could not be used:`.

### 4.3 Runner (`apps/runner`)

1. **Error text.** `git/identity.ts`: `AppIdentityError` gets optional `ctx?: { projectKey?: string; operation?:
   string; repo?: string }`. The message becomes `The app <label> could not be used: <reason> (project <KEY>, <op> on
   <owner/repo>). Nothing was committed or pushed under another identity.` Add helper `inContext(err, ctx)` that
   returns a new error with context. The prefix stays the same for the server's parser. Values come only from
   `appReason` (value-free), so no token can appear.
2. **Tripwire, one mechanism (`runner.ts onMessage`, `forge/app-actor.ts`, `forge/app-repos.ts`).**
   - Add `missingPlanRefusal(tripwire, command, payload)`. For a plan-carrying command (`commandCarriesPlan`) or
     `shift.start` without `postAs`, when `appRepos.find(root, url)` hits for any `payloadRepoUrls(payload)` entry,
     answer the command `ok:true, result.ok:false` (or reject the shift) with the `app_identity_failed` text of 3.4.
     Do not call `releaseUncovered`.
   - `releaseUncovered` runs only when `postAs` is present. For a DevOps `shift.start`, `payloadRepoUrls` also
     returns every `postAs.repos[].remoteUrlNormalized` (the DevOps plan names the repositories it acts on).
   - `AppRepoRegistry` persists per root to `<root>/app-repos.json` (load on `forRoot`, write on `set`). It holds no
     credential.
   - Announce `POST_AS_V2_CAPABILITY`.
3. **DevOps shift start (`shifts/supervisor.ts`).**
   - For `msg.kind === 'devops'`: `scope = deps.shiftCredentials(msg.postAs)`. This registers the app repositories in
     the tripwire.
   - Card request: if `msg.devops.card.remoteUrlNormalized` resolves to `source: 'app'`, set
     `identity = await resolveCommitIdentity(root, null, boundPostAsFor(...))` (bot). On `AppIdentityError`, reject the
     shift with `inContext(err, { projectKey, operation: 'DevOps request' })`. Otherwise keep today's identity.
   - Build `devops.appRepos` for the guard config: for every app plan entry with a local clone (`findRepo`), the clone
     path, label and botEmail.
   - Add to `s.env` (DevOps only, merged with any existing `GIT_CONFIG_COUNT`): for every app clone's origin URL (as
     written in the clone, plus the `.git`-less form), `url.https://app-push-refused.invalid/.pushInsteadOf=<url>`.
4. **Guard (`devops/guard.ts`).**
   - `GuardConfig.appRepos?: Array<{ path: string; remote: string; label: string; botEmail: string }>`,
     `identityEmail?: string`.
   - `GuardDeps.originUrl?(dir)` returns the normalized origin of a directory (read-only `git remote get-url`).
     Worktrees resolve through the common dir.
   - New rule `app_repo` (refuse), checked in the git and gh branches of the classifier:
     - git `push`, `fetch`, `pull`, `ls-remote` whose target URL or remote resolves to an app repository → "<repo>
       posts as the app '<label>': use `aom git push --repo <dir> ...` / `aom git fetch --repo <dir>`".
     - `clone` of an app URL → refuse ("the runner keeps the clone").
     - HEAD-moving subcommands in an app repository when `identityEmail !== botEmail` → refuse ("commits here must be
       made as the app; ask for this as a card request, or use `aom hygiene run`").
     - `gh` writes with a target that is an app repository, or unknown while `appRepos` is non-empty and the cwd is
       inside an app clone → refuse.
   - No `appRepos` (no-app projects): no new refusals. This is the regression guarantee.
5. **`aom git push|fetch` for DevOps.**
   - Supervisor rpc: when `s.msg.kind === 'devops' && isDevops`, route `git.push`/`git.fetch` to `devopsGit(s,
     method, params)` instead of `architectGit`.
   - Params: `{ repo: string; refspecs?: string[]; delete?: boolean; tags?: boolean }`. No `--force`. A delete or
     non-fast-forward of a protected branch is refused by reusing `classifyCommand` on the synthetic `git push ...`
     line with the shift's guard config.
   - Steps:
     1. `dir` must resolve inside a known clone (`repoRoots`), `paths.worktrees` or the agent's tmp/scratch (conflict
        scratch worktrees).
     2. `url = origin of dir`.
     3. `scope.actorFor(url)`; `appOriginRefusal`.
     4. `a = await scope.auth(url)`.
     5. `git(dir, [...a.args, 'push', 'origin', ...], { env: a.env })`. Fetch is the same with `fetch --prune origin`.
   - On `AppIdentityError`, return the `inContext` wire text naming project/app/operation. Nothing is run.
   - CLI (`aom/aom-cli.ts`): `aom git push --repo <dir> [--delete] [--tags] <refspec>...` and `aom git fetch --repo
     <dir>`. The architect form (no `--repo`) is unchanged.
6. **Hygiene in the runner.**
   - `devops/hygiene.ts`: `HygieneDeps` gets `appAuth?: (url) => Promise<GitAuth | null>` and `identityFor?: (url) =>
     { name; email } | null`. The runner builds `appAuth` as `scope.actorFor(url) ? scope.auth(url) : null`, so a
     repository not on an app gets `null` and runs plain `git` exactly as today, never `gitAuthFor`. Add a
     `Repo.remote(args)` helper. It resolves `appAuth(originUrl)` right before each network command (fetch, pull,
     push), prefixes `a.args` and passes `a.env`. For `pull --rebase` on an app repository it adds
     `committerEnv(bot)`.
   - `AppIdentityError` → `mark(res, 'app_identity_failed', inContext(...).message)` and skip that repository's
     remaining remote steps. Local stash steps may still run.
   - Pass the same `auth` into `cleanFinishedCards` and `migrateSavedWorkBranches` (new optional `auth` in their
     inputs, used for `fetch` and `push --delete`).
   - Supervisor rpc `hygiene.run`: DevOps-only. It reads `s.msg.devops.hygiene`, gets `busy` from
     `supervisor.worktreePaths()`, uses `changeState` with `scope.forgeEnv` and `auth = scope.auth`, and returns
     `{ summary, commands, report }`.
   - `aom hygiene run` calls the rpc and reports `devops_done` with the result, exactly as now.
   - With the new `HygieneProblemKind` `'app_identity_failed'` (4.1), the server's summary shows it as the
     repository's problem.
7. **Commit status and notice.**
   - `runner.ts` `repo.commit_status`: `postCommitStatus({ ..., forgeEnv: this.scopeFor(p.postAs).forgeEnv })`.
   - `GitHubForge.setCommitStatus`: `const actor = this.actor(repo.fullName)`. With an actor, `token = await
     actor.token()`. Catch `AppIdentityError` → `{ ok:false, code:'app_identity_failed', error: appIdentityWire(...) }`.
     Never read `statusTokens` then. Without an actor: today's status-token path, unchanged.
   - Other forges: `setCommitStatus` is GitHub-only for apps (`APP_PROVIDER_FORGE`). Nothing to change.
   - `PrReviewCommands.notice`: `actor = this.env.scope?.(payload.postAs).actorFor(payload.remoteUrlNormalized)`
     (same as `post`).

### 4.4 Data model

No database migration. `pr_size_statuses` already stores the error text. The tripwire file
`<runner root>/app-repos.json` is new on the runner: repo URL → `{ integrationId, label }`, mode 0600, never a token.

### 4.5 Compatibility

- Runner without `post-as:1`: unchanged 216 gate (409 for writes).
- Runner with `post-as:1` but without `post-as:2` (the 216 release): it ignores `postAs` on commit status, notice
  and DevOps shifts. So the server refuses those commands for app projects (409 `runner_too_old`, left queued with a
  desk alert), and does not dispatch DevOps requests to it while any project on that workstation has an app. No-app
  projects: no change.
- Older server → new runner: plan-carrying commands for a registered app repository without `postAs` are refused
  (3.4). Unregistered: as before.

## 5. Acceptance criteria → design → tests

| AC | Design | Test (fake broker `AppTokenSource`, bare remote under tmp, no network) |
|---|---|---|
| 1 Investigation recorded | Section 2.4 table (before/after per path) | This report; the builder posts the table on the card |
| 2 Hygiene push with app token; commit author/committer = app | 4.3.6 | `apps/runner/test/hygiene-post-as.test.ts`: bare origin moved ahead plus a local commit authored by the bot, so hygiene rebases and pushes. Assert the push env had `AOM_GIT_APP` and the token helper env (spy on `scope.auth`). The remote tip's author and committer are the bot (`git log -1 --format=%an%n%ae%n%cn%n%ce`). The owner `gitAuthFor` spy is never called. |
| 3 Conflict-resolution commit and push attributed to app | 4.3.3 identity, 4.3.4 guard, 4.3.5 `aom git push`, 216 finalize | `devops-post-as.test.ts`: supervisor DevOps start for a card request on an app repository gives `s.env` with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` = bot. A rebase with a conflict resolved and committed in a temp repo under that env has author/committer = bot. `devopsGit('git.push')` of the resolved branch uses the app auth and lands on the bare remote. The guard refuses a raw `git push` and a `git commit` without bot identity in that repository. |
| 4 Merges, branch deletes, tag/release pushes, PR create/update, comments, commit status | Rows 2, 3, 5, 9, 10, 11 new; rows 8, 12, 13 by 216 | Table-driven `post-as-devops-ops.test.ts`: `aom git push --delete`, `aom git push <tag>`, `cleanFinishedCards` remote delete, `migrateSavedWorkBranches` delete, `repo.commit_status` (fake fetch asserts `Authorization: Bearer <app token>`, never the status token), `pr_review.notice` (poster sees the actor token). Rows 13 keep the 216 tests (`post-as-forge-paths.test.ts`) plus one assertion each that the server attaches `postAs`. Rows 14 and 15: the report states N/A (local only). |
| 5 Mint failure: error names project, app, operation; owner credential never used | `AppIdentityError` context (4.3.1); every path catches and returns the wire text | Same table with a broker that throws `AppTokenError('installation_not_found')`. Each result/error matches `/app_identity_failed: The app .+ could not be used: .+\(project GWP, <op> on owner\/repo\)/`. The `gitAuthFor`/`statusTokens.get`/reviewer-token spies are never called. The bare remote is unchanged. |
| 6 No-app projects unchanged | No `appRepos` → guard has no new refusals. Hygiene: for a repository not on an app, `Repo.remote` adds nothing (no auth args, no env), so it runs exactly the same plain `git` as today, not `gitAuthFor`. DevOps identity unchanged (no `commitAs` added). | Regression cases in the same files with `postAs: { repos: [] }` and absent. Hygiene runs the same git argv as before (snapshot of `commands`). Commit status uses the status token. DevOps env identity = workstation identity. The guard allows `git push`. |
| 7 Command without identity on app project rejected; one tripwire mechanism | 3.4 A, 4.3.2 | `post-as-tripwire.test.ts`: register a repository through a plan; then `branch.check_merged` without `postAs` is answered `app_identity_failed` and the tripwire entry is still there. With `postAs: {repos: []}` the entry is released. A restart (new registry from `app-repos.json`) still refuses. Commands without a plan field leave the entry alone (keeps the 216 test). |
| 8 Suites pass | — | `pnpm --filter @aom/runner test`, `@aom/server test`, `@aom/shared test`, `pnpm typecheck`, biome |

Server tests (`apps/server/test/post-as-devops.test.ts`):
- The DevOps `shift.start` for a card of an app project carries the union plan with `projectKey` and
  `devops.card.remoteUrlNormalized`, and no `commitAs`.
- A no-app workstation gets `postAs: { repos: [] }` on `post-as:2`.
- `repo.commit_status` and `pr_review.notice` carry `postAs`.
- A `post-as:1`-only runner gets 409 / no dispatch for app projects.
- `applyCommitStatusResult` with `app_identity_failed` raises one project alert.

## 6. Risks

- **Size.** Runner, server and shared, about 900 to 1200 changed lines with tests. Recorded as large.
- **Depends on the 216 branch.** Building before it merges duplicates `app-actor.ts`. Blocked on it.
- **Required status check source.** With the app posting the size status, a branch protection rule that pins the
  check to a specific source (the token's user) would stop matching. Document it in the user guide next to the hard
  size check: with an app selected, set the expected source to the app or "any source".
- **Guard is a guardrail.** The `pushInsteadOf` env and the runner tripwire are the backstops. A remote with an
  explicit `pushurl`, or a push over ssh from a script, can still bypass `pushInsteadOf`. Add the ssh/pushurl forms
  of the clone's URLs too, and record the residual risk in `docs/RUNNER.md`.
- **Workstations without the app key.** `post-as:2` says the runner understands plans, not that it holds the key. A
  mint failure is then the clear `app_identity_failed` error (fail closed), as for shifts. Routing to key-holding
  workstations stays a follow-up (216 list).
- **Same remote in two projects** with different selections: the union plan keeps the `app` entry (fail closed).
- **DevOps workflow friction** on app projects (must use `aom git push|fetch`). The guard messages name the exact
  command, and the DevOps prompt line "You may fetch, pull and push with the user's git credentials" gets: "...;
  repositories that post as an app: only through `aom git push|fetch --repo <dir>`".

## 7. Follow-ups (outside this card)

- `repo.sync` and the background `SyncService` fetch with the owner's credentials (read only).
- DevOps commits on no-app projects ignore the project's Commit as setting (today's behaviour, kept by req. 6).

## 8. Note for the 216 finding

This card closes the Linus finding completely: an absent plan on an app repository is refused, never a release; a
present plan (even empty) is the only release. If 216 merges first, as required here, the builder replaces
`releaseUncovered`'s "absent = release" branch rather than adding a second check.
