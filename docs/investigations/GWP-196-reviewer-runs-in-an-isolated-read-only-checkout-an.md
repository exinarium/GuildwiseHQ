# GWP-196: Reviewer runs in an isolated read-only checkout and posts with a comment-only token

Design report for repository GuildwiseHQ. The first version was read at 7aa562ad. This revision was checked against the working branch at cbff1bd2, after GWP-195 (PR-only mode) landed. Section 0 lists what changed.

## 0. Revision (assumption review after GWP-195 landed)

I checked each assumption from section 6 against the GWP-195 code that landed. These files hold it: `apps/server/migrations/2900_pr_only_review.sql`, `apps/server/src/commands/pr-only.ts`, `apps/server/src/queries/misc.ts`, `packages/shared/src/api/projects.ts`, `packages/shared/src/review/pr-review.ts`, `apps/runner/src/forge/list-prs.ts`, `apps/runner/src/forge/github.ts`, `apps/web/src/components/RepoPrOnlyControl.tsx` and `apps/web/src/pages/ProjectSettings.tsx`.

| # | Assumption | Result |
|---|---|---|
| 1 | The PR-only flag is on `project_repos` and in `ProjectRepoDto` | **Holds.** The column is `project_repos.pr_only boolean NOT NULL DEFAULT false`, plus `pr_only_since`. It is projected from `ProjectRepoPrOnlySet` and exposed as `ProjectRepoDto.prOnly`. `prReview` (`{waiting, checkedAt, problem}`) is set while the repo is PR-only and is null otherwise. |
| 2 | There is one server-side point where an open PR becomes eligible, and `reviewerGate` is called there | **Revised.** Eligibility is a **query**, not an action. `applyPrListResult` records `PrReviewRecorded` into `pr_reviews` with `review_state='not_reviewed'`. `listReviewEligiblePrs(db, projectId)` is documented as "the single place reviewer work is picked from". Nothing creates or dispatches a run yet, and `pr_reviews` has no column for a waiting reason. The gate cannot be put inside `listReviewEligiblePrs`: the existing tests in `apps/server/test/pr-only-eligibility.test.ts` expect PRs to be listed when no reviewer token exists, and this card adds tests only in new files. Section 4.4 has the new hook. |
| 3 | The PR-only state is shown in the repo row of `ProjectSettings.tsx` | **Holds.** `RepoPrOnlyControl` sits in the repo row (`traits.usesRepos`), and a "PR-only" badge sits next to the repo name. |
| 4 | PR-only repos are GitHub in the first release | **Holds.** Only `GitHubForge` implements `listOpenChanges`. On any other forge, `repo.list_prs` answers `unsupported` and no PR is recorded. The `unsupported_host` fact still applies to a token saved for a non-GitHub remote. |
| 5 | GWP-195 starts no reviewer run and defines no run payload | **Holds.** The only new runner command is `repo.list_prs`, a read-only listing. Note for GWP-197, with no change on this card: `pr_reviews` and `OpenChangeSchema` store the PR number (`change_id`) and branch names but **no commit SHAs**. To fill `ReviewerRunSpec.headSha` and `baseSha`, GWP-197 must get them. The simplest way is to add `headRefOid,baseRefOid` to the `gh pr list --json` fields and to `OpenChangeSchema` as optional fields, or to have its dispatch command resolve them first. `ReviewerRunSpecSchema` stays as designed. |

Other change from the landed code: migration number **2900 is taken** (`2900_owner_pending.sql`, `2900_pr_only_review.sql`). Name the new migration `2910_reviewer_token.sql`, or use the next free number if 2910 is taken by build time.

Sections 1 to 3 and 7 to 9 are unchanged. Section 4.4 (eligibility hook, migration number), section 4.5 (exact placement), section 5 (AC4 test) and section 6 are updated.

## 1. Question

How does a PR reviewer run get the following four things? GWP-197 is the first card to use it, then GWP-198, 203 and 204.

1. A clean, isolated, read-only checkout of the PR head on the owner's workstation, fresh for every run.
2. A way to post PR comments only through a comment-only token that DevOps (Anvil) provisions, with no push, merge or write path.
3. Storage for that token that is encrypted and on the workstation only, never on the server (standing order 1800e58c).
4. A gate: a PR-only repository without a token starts no run, and the owner sees why.

## 2. Findings (what already exists)

| Need | What already exists | File |
|---|---|---|
| Sealed secrets on the workstation | `SealedFile<T>`: an AES-256-GCM envelope with a key derived from the runner key, mode 0600 in a 0700 `secrets/` dir. It registers loaded secrets with the log redactor | `apps/runner/src/secrets/sealed-file.ts`, `apps/runner/src/secrets/redact.ts` |
| A token store built on it | `FileTokenStore` / `MemoryTokenStore` for git-host PATs (`secrets/git-tokens.json`). The status sent to the server is "connected or not", never the token | `apps/runner/src/forge/tokens.ts` |
| CLI to enter a token | `promptSecret` (hidden input, or piped stdin) and `touchRecheck(paths.secrets)`, so the running runner re-reports within a minute | `apps/runner/src/cli.ts` (`gitConnect`), `apps/runner/src/forge/connect.ts` |
| Detached read-only checkout | `ensureReadOnlyCheckout` / `removeReadOnlyCheckout`: a detached `git worktree` of the working branch for the architect, removed after the shift | `apps/runner/src/git/worktrees.ts` |
| Read-only worktree in the sandbox | `isReadOnlyWorktreeRole(p)` (no `edit` tool, `mayCommit` false) gives `SandboxProfile.readOnlyWorktree`. The cwd goes into `denyWrite`, and the runner root is masked around it (`denyAround`) | `apps/runner/src/adapters/claude-policy.ts` (`sandboxBlock`) |
| Protected dotfile names over a read-only cwd | Placeholders, so bubblewrap can mount them | `apps/runner/src/adapters/sandbox-placeholders.ts` |
| Roll back anything a read-only role left | `resetReadOnlyWorktree` | `apps/runner/src/shifts/guard.ts` |
| Denied shell commands | `GIT_PUSH_DENIED`, `git reset --hard` and stash removal, as Claude `Bash(...)` deny rules plus prefixes for other runtimes | `apps/runner/src/adapters/claude-policy.ts`, `apps/runner/src/adapters/denied-shell.ts` |
| Agent environment | `agentEnv` passes only allow-listed inherited variables plus the session's own, so no git or gh credential reaches an agent. `~/.config/gh`, `.git-credentials` and similar files are in `HOME_SECRETS` (denyRead) | `apps/runner/src/adapters/claude-policy.ts` |
| Per-repo facts from runner to server | `repos.report` (`RepoReportSchema`: remoteUrl, localPath, headBranch, identity) is projected into `workstation_repos` by `matchRepos`, which then triggers the dispatcher | `packages/shared/src/protocol/runner.ts`, `apps/server/src/runner-gateway/handlers.ts` |
| "Facts only" pattern on the server | `applyGitReport` and `applyJiraReport` store validated facts, never a secret | `apps/server/src/commands/forges.ts` |
| Repo DTO and settings UI | `ProjectRepoDtoSchema` (now with `prOnly` and `prReview`), built in `queries/misc.ts` `getProjectDetail`. Each repo row in `ProjectSettings.tsx` has its controls, including `RepoPrOnlyControl` | `packages/shared/src/api/projects.ts`, `apps/server/src/queries/misc.ts`, `apps/web/src/pages/ProjectSettings.tsx` |
| PR-only (GWP-195) | `project_repos.pr_only`, `pr_reviews` (recorded open PRs, `not_reviewed`), `pr_review_polls`, `listReviewEligiblePrs`, `loadPrReviewStatus`, runner command `repo.list_prs` | `apps/server/src/commands/pr-only.ts`, `packages/shared/src/review/pr-review.ts` |

Some things do not exist yet:

- any reviewer run code;
- any PR comment posting (`Forge` has no comment method);
- any per-run sandbox root (an agent's `scratch/` and `home/` persist across its shifts);
- any network-off sandbox profile (every shell-using role gets `REGISTRY_DOMAINS`, which includes `github.com`).

Two facts drive the design:

- **A linked worktree is not isolated enough.** `ensureReadOnlyCheckout` creates a `git worktree` of the owner's clone. Its `.git` file points into the owner's clone, so the shell would need read access to that clone's git dir. That exposes every branch, every other card's refs, and the clone's `config` (remote URL, credential helper). A reviewer checkout should be a standalone repository with no remote.
- **The agent never needs the token.** If the runner, outside the sandbox, posts the findings, the token never enters the agent's environment, files, argv or network namespace. That makes AC1 and AC3 structural rather than a matter of rules.

## 3. Options compared

### 3.1 Checkout

| Option | Isolation | Cost | Verdict |
|---|---|---|---|
| A. Linked worktree (`ensureReadOnlyCheckout`) at the PR head | Shares the owner's git dir (other refs, `config`); the shell must read it | Cheap | No |
| B. Fresh `git clone` from the host on each run, with the comment token | Full | Network on every run, slow for big repos, token inside the git process | No |
| **C. The runner fetches the PR head into the owner's clone under a private ref, then builds a standalone repo per run (`git init` plus a local fetch of head and base) with no remote, then makes it read-only on disk** | Full: its own `.git` inside the run dir, no remote, no credential helper | One local fetch (hard links on the same filesystem) | **Chosen** |

### 3.2 Who posts the comment

| Option | Token exposure | Verdict |
|---|---|---|
| A. The agent posts with `gh`/`curl`, with the token in its env | Token in the sandbox and transcript; needs network to github.com | No (breaks AC1 and AC3 in spirit) |
| B. The runner posts through `gh` with `GH_TOKEN` | Token in a child process env; risk of falling back to the owner's own `gh` login, which can push | No |
| **C. The runner posts with `fetch` to the REST API, `Authorization: Bearer <token>`, reading the token from the sealed store at post time, with no fallback to any other credential** | Token only in the runner process memory and one HTTPS header | **Chosen** |

Posting shape: a single **PR review with `event: 'COMMENT'`**. The request is `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with `commit_id: headSha`. Line comments go in `comments[]`; findings without a line go in `body`. One API call means all findings are posted or none are, which GWP-197 (no partial comments) and GWP-198 (cap) need. The poster hard-codes `event: 'COMMENT'`, so it can never approve or request changes.

### 3.3 Where the token lives

| Option | Verdict |
|---|---|
| A. Add it to `secrets/git-tokens.json` (`FileTokenStore`) | No. That store holds the owner's write-capable git logins, keyed by provider and host. Mixing the two would let a lookup bug use the wrong token, and `gitAuth` might pick it up for pushes |
| **B. A separate sealed file, `secrets/reviewer-tokens.json` (`SealedFile`), keyed by the repo's normalized remote URL** | **Chosen**: the same encryption, 0600/0700 handling and redaction, with a separate purpose |

### 3.4 Run gate

Two gates are needed:

- **Server (primary, and what the owner sees):** a PR-only repo has a reviewer token if at least one active workstation of a project member reports one (`workstation_repos.reviewer_token = true`). Without one, no run is dispatched and the repo shows "Reviewer token missing".
- **Runner (backstop):** `prepareReviewerRun` refuses with `reviewer_token_missing` if the token is not in its store when the run arrives. That happens when the token was removed since the last report or the file is unreadable. The runner then creates nothing and starts no agent.

## 4. Design

### 4.1 Overview

```
server                                    runner (owner's workstation)
------                                    ----------------------------
repos.report { reviewerToken:{present} } <- ReviewerTokenStore (secrets/reviewer-tokens.json, sealed)
workstation_repos.reviewer_token (bool)
listReviewablePrs(project)  = listReviewEligiblePrs (GWP-195) filtered by reviewerGate
reviewerGate(repo) --ready--> (GWP-197 dispatches ReviewerRunSpec, no token)
                   --missing--> PR stays not_reviewed; no run; repo shows "Reviewer token missing"
                                          prepareReviewerRun(spec)
                                            1. token present?  no -> refuse reviewer_token_missing
                                            2. fetch PR head into clone under refs/guildwise/review/<runId>
                                            3. reviews/<runId>/checkout: git init + local fetch head+base, detach, no remote
                                            4. placeholders, then chmod -R a-w checkout; delete private ref
                                            5. fresh home/scratch/tmp for this run only
                                            6. sandbox profile: readOnlyWorktree + offline, no gitDirs
                                          agent (GWP-197) reads checkout, writes findings.json in run scratch
                                          postReview(findings): runner -> GitHub API with token (COMMENT review)
                                          disposeReviewerRun: rm -rf reviews/<runId> + tmp
```

### 4.2 packages/shared

New file `packages/shared/src/review/reviewer-run.ts`, exported from `packages/shared/src/index.ts` next to `review/pr-review.ts`:

```ts
/** What the server sends for one reviewer run. Never a credential: `.strict()` rejects any extra key such as `token`. */
export const ReviewerRunSpecSchema = z.object({
  runId: z.uuid(),
  projectId: z.uuid(),
  projectRepoId: z.uuid(),
  remoteUrlNormalized: z.string().max(500),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseRef: GitRefSchema,
}).strict();

/** One finding as the agent hands it to the runner (GWP-197/198 may add fields). */
export const ReviewFindingSchema = z.object({
  path: z.string().max(1000).optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
}).strict();

/** The workstation's fact about a repo's reviewer token: present or not, never the value. */
export const ReviewerTokenFactSchema = z.object({
  present: z.boolean(),
  problem: z.enum(['unreadable', 'unsupported_host']).optional(),
}).strict();

export const REVIEWER_TOKEN_STATES = ['present', 'missing'] as const;
```

`prNumber` is the number of `pr_reviews.change_id`. GWP-195 stores it as a string (`String(p.number)`), so GWP-197 parses it.

Changes in existing files. All are additive and optional, so older runners and servers keep working:

- `packages/shared/src/protocol/runner.ts`, `RepoReportSchema`: add `reviewerToken: ReviewerTokenFactSchema.optional()`.
- `packages/shared/src/api/projects.ts`, `ProjectRepoDtoSchema`: add `reviewerToken: z.enum(REVIEWER_TOKEN_STATES).nullable().optional()` next to `prOnly` / `prReview`. It is null when the repo is not PR-only, the same rule as `prReview`. Keep it a separate field: `prReview.problem` describes the PR listing poll, and mixing the two would confuse the existing `RepoPrOnlyControl` texts.

GWP-197 carries `ReviewerRunSpec` to the runner, as a `shift.start` kind or a runner command; that is its decision. This card defines the payload only.

### 4.3 apps/runner (new folder `apps/runner/src/review/`)

**`reviewer-tokens.ts`**: a `ReviewerTokenStore` interface with `get(remoteUrlNormalized)`, `set`, `remove`, `has`, `list()` (no values) and `problem()`.

- `FileReviewerTokenStore` wraps `SealedFile<Record<string, {token, host, savedAt}>>` at `<paths.secrets>/reviewer-tokens.json`. It passes `secretsOf = v => Object.values(v).map(t => t.token)` so that every loaded token is registered with the redactor.
- Never overwrite an unreadable file: quarantine it first, as `FileTokenStore.write` does.
- `MemoryReviewerTokenStore` is for tests.

**`review-checkout.ts`**:

```ts
export async function createReviewCheckout(i: {
  repoPath: string; runDir: string; spec: ReviewerRunSpec; auth?: GitAuth;
}): Promise<{ path: string; headSha: string }>
export async function removeReviewCheckout(runDir: string): Promise<void>  // chmod -R u+w, then rm -rf; never throws
```

The steps run under `withRepoLock(repoPath)`:

1. Fetch the PR head into the owner's clone with the clone's existing auth, as `ensureReadOnlyCheckout` does: `git fetch --no-tags origin +refs/pull/<n>/head:refs/guildwise/review/<runId>`. Check that `rev-parse` equals `spec.headSha`. If it does not, throw `ReviewHeadMovedError` (the PR moved; GWP-197 re-queues it). Also make sure `baseSha` is present, and fetch `baseRef` if it is not.
2. Run `git init -q <runDir>/checkout`, then `git -C checkout fetch --no-tags <repoPath> refs/guildwise/review/<runId> <baseSha>`, then `git -C checkout checkout -q --detach <headSha>`. Do **not** add a remote: the `.git/config` must hold no `url`, no `credential.*` and no `includeIf`. Write `refs/review/base` = `baseSha` so the agent can run `git diff refs/review/base...HEAD`.
3. Delete `refs/guildwise/review/<runId>` from the owner's clone, in a `finally`.
4. Create the sandbox placeholders, then make the checkout read-only on disk with `chmod -R a-w <checkout>`. This covers the files and `.git`. Writes, `git add` and `git commit` then fail with EACCES even outside bubblewrap, which is defence in depth and testable in unit tests.
5. Fail closed: if anything throws, remove the run dir.

Only the runner process runs these commands, never the agent. Validate refs with `isSafeGitRef` and confine paths with `confineAny([paths.reviews], ...)`, as `worktrees.ts` does.

**`reviewer-sandbox.ts`**:

```ts
export interface ReviewerRun { spec: ReviewerRunSpec; runDir: string; checkout: string; sandbox: Sandbox }
export async function prepareReviewerRun(deps, spec): Promise<ReviewerRun | { refused: 'reviewer_token_missing' | 'unsupported_host' | 'sandbox_unavailable' }>
export async function disposeReviewerRun(run: ReviewerRun): Promise<void>
export function reviewerPolicy(run, base: ClaudePolicyContext): { ctx: ClaudePolicyContext; profile: SandboxProfile }
```

- Check the token first (`store.has(spec.remoteUrlNormalized)`). If the check fails, refuse before anything is created.
- Refuse when the claude-code sandbox state is not `enforced` (`sandboxMissing` / mode `required`). A reviewer never runs unsandboxed.
- **Fresh per run (AC5):**
  - Use `runDir = <paths.reviews>/<runId>`, and add `reviews: join(root, 'reviews')` to `apps/runner/src/paths.ts`.
  - The run's `Sandbox` has `home = runDir/home`, `scratch = runDir/scratch` and `tmp = <agentTmpRoot()>/aom-r-<sha256(runId)[0..10]>` (a short path, mode 0700).
  - `configDir` stays the agent's account config dir: the Claude login needs it, and the shell cannot read it.
  - The agent's persistent `agents/<id>/scratch` and `home` are not used.
  - The cwd differs per run, so nothing Claude Code keys by project path carries over. Do not use `--resume`.
- `disposeReviewerRun` removes `runDir` and the tmp dir. Add a startup sweep that removes every `reviews/*` and `aom-r-*` that no live run owns. Either extend `apps/runner/src/git/sweep.ts`, or add a small `sweepReviewRuns` called where `sweepWorktrees` is called.
- `reviewerPolicy` reuses `buildShiftSettings` / `sandboxBlock` with these settings:
  - `cwd = checkout`, `gitDirs = []` (the `.git` is inside the read-only cwd), `readDirs = []`, `addDirs = []`, no `extraAllowedDomains` and no `testServiceDomains`.
  - `profile.readOnlyWorktree = true`. The reviewer role has no `edit` and `mayCommit: false`, so `isReadOnlyWorktreeRole` already holds, but set it explicitly anyway. The cwd then goes into `denyWrite`, and the runner root is masked around it with `denyAround`.
  - A **new** `SandboxProfile.offline?: boolean`. When it is true, `network.allowedDomains = []`. This is a small additive change in `claude-policy.ts` `sandboxBlock`, and it means the reviewer shell cannot reach github.com at all.
  - The permission deny rules keep `GIT_PUSH_DENIED` (role defaults). `Edit` and `Write` stay denied by the role tools.
  - `sandbox-placeholders.ts` must create its placeholders **before** the `chmod` in step 4, or bubblewrap fails on the read-only cwd. The order is: checkout, placeholders, chmod.
- `agentEnv` is used as it is, since it holds no token or git credential variable. Add an assertion for this in the tests.

**`review-poster.ts`**:

```ts
export interface ReviewPoster {
  post(run: ReviewerRun, findings: ReviewFinding[], summary: string): Promise<{ reviewId: string; url: string }>;
}
export class GitHubReviewPoster implements ReviewPoster {
  constructor(private env: { fetch: typeof fetch; tokens: ReviewerTokenStore }) {}
}
```

- Parse the host and `owner/repo` with the shared remote parser (`ParsedRemote`). The API base is `https://api.github.com` for github.com and `https://<host>/api/v3` for GitHub Enterprise Server. Any other forge throws `unsupported_host`. The fact reports the same for such repos, so the gate shows it.
- Request: `POST {api}/repos/{owner}/{repo}/pulls/{n}/reviews` with the headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`. The body is `{ commit_id: headSha, event: 'COMMENT', body, comments: [{ path, line, side, body }] }`.
- The token comes **only** from `ReviewerTokenStore.get(spec.remoteUrlNormalized)`, read at post time. There is no fallback to `gh`, `FileTokenStore`, `GH_TOKEN` or the clone's auth. A missing token throws `reviewer_token_missing`.
- Pass any error text from the host through `redact` before it is logged or returned.
- **Line comments outside the diff:** GitHub rejects the whole review with 422 when a line is not part of the diff. On a 422, the poster retries **once** with every finding moved into `body`. That is still one review, and still all or nothing.

**`reviewer-token-cli.ts`**, wired in `apps/runner/src/cli.ts`: `guildwise-runner reviewer-token set <remote-url> | remove <remote-url> | status [<remote-url>]`, with `--pairing` handled as in `git-connect`.

- `set` reads the token with `promptSecret` (hidden input or piped stdin, never an argv value).
  1. It checks the token with `GET {api}/repos/{owner}/{repo}` and expects a 200.
  2. It **refuses a classic PAT that carries a write scope**, that is, when the response's `X-OAuth-Scopes` contains `repo`, `public_repo` or `write:*`. The message is "use a fine-grained token: Pull requests read and write, Contents read, Metadata read".
  3. It saves the token and calls `touchRecheck(paths.secrets)`.
- `status` prints present or missing per repo, never the value.

**Report to the server**: in `apps/runner/src/runner.ts` (`scan` / `rescan`, where `this.repos` is built), set `reviewerToken: { present: store.has(normalizeRemoteUrl(remoteUrl)) }` for each repo.

- Use `problem: 'unreadable'` when `store.problem()` reports one.
- Use `problem: 'unsupported_host'` for a non-GitHub remote that has a token in the store.
- The existing recheck touch file already triggers `rescan`. Check that it does, and add the store to whatever `touchRecheck` wakes.

### 4.4 apps/server

- **Migration** `apps/server/migrations/2910_reviewer_token.sql`. 2900 is already used twice, so take the next free number at build time if 2910 is taken by then:
  ```sql
  ALTER TABLE workstation_repos ADD COLUMN IF NOT EXISTS reviewer_token boolean;          -- null: runner did not say
  ALTER TABLE workstation_repos ADD COLUMN IF NOT EXISTS reviewer_token_problem text;
  ```
  It adds booleans and a short enum only. No column, event or log field can hold a token.
- **`apps/server/src/runner-gateway/handlers.ts` `matchRepos`**: write `r.reviewerToken?.present ?? null` and `r.reviewerToken?.problem ?? null` in the existing upsert. `matchRepos` already calls `dispatcher.trigger()`, so a token that appears unblocks waiting PRs without new plumbing.
- **New `apps/server/src/review/reviewer-gate.ts`**:
  ```ts
  export type ReviewerGate =
    | { state: 'not_pr_only' }
    | { state: 'reviewer_token_missing'; problem: 'unreadable' | 'unsupported_host' | null }
    | { state: 'ready'; workstationIds: string[] };
  export async function reviewerGate(q: Queryable, projectRepoId: string): Promise<ReviewerGate>;
  export async function reviewerTokenStates(q: Queryable, repoIds: string[]): Promise<Map<string, 'present' | 'missing'>>;

  /** The open PRs that may get a reviewer run now: GWP-195's eligible PRs on repos whose gate is ready. */
  export async function listReviewablePrs(
    q: Queryable, projectId: string,
  ): Promise<Array<ReviewEligiblePr & { workstationIds: string[] }>>;
  ```
  - **`not_pr_only`**: `project_repos.pr_only` is false, or `removed_at` is set.
  - **`ready`**: the repo is PR-only and at least one row of `workstation_repos wr JOIN workstations w ON w.status='active'` exists with `wr.project_repo_id = repo` and `wr.reviewer_token = true`, where the workstation's `user_id` is an active member of the repo's project (`project_members`).
    - `workstationIds` lists these workstations. Order them as `requestPrList` does: `connected DESC`, then `last_seen_at DESC NULLS LAST`.
    - It tells GWP-197's dispatcher **which workstation to send the run to**. The dispatcher must pick one of them and never another one.
  - **`reviewer_token_missing`**: no such workstation, the flag false, the flag null (an older runner), or only rows with a problem set.
- **Gate placement (AC4), revised.** GWP-195 has no action that creates a run, and `listReviewEligiblePrs` (`apps/server/src/commands/pr-only.ts`) is the single pick point. So:
  - `listReviewablePrs` calls `listReviewEligiblePrs(q, projectId)` and keeps only the PRs whose repo's `reviewerGate` is `ready`. Evaluate the gate once per distinct repo and attach `workstationIds`. **This is the only list a reviewer dispatcher may take work from.** GWP-197 and GWP-200 must use it and must not use `listReviewEligiblePrs` directly. GWP-197 also calls `reviewerGate` again right before it sends a run (single source of truth; the token may have gone in between).
  - Do **not** change `listReviewEligiblePrs`, `applyPrListResult` or the `pr_reviews` table. A PR on a gated repo stays `not_reviewed` and keeps counting in `prReview.waiting`. No new review state or reason column is needed. The owner sees the reason on the repository through the DTO (below), which is where AC4 asks for it.
  - On this card nothing dispatches a run yet. AC4 is therefore shown by `listReviewablePrs` returning nothing for the gated repo while `listReviewEligiblePrs` still lists the PR, and by no runner command other than `repo.list_prs` being queued.
- **DTO**: in `apps/server/src/queries/misc.ts` `getProjectDetail`, next to `prReviewStatus = await loadPrReviewStatus(...)`, load `reviewerTokenStates(ctx.pool, <PR-only repo ids>)`. In the repo map, next to `prOnly` / `prReview`, set `reviewerToken: r.pr_only ? (states.get(r.id) ?? 'missing') : null`. Other places that build a `ProjectRepoDto` (`commands/repo-sync.ts`, `commands/setup-proposals.ts`, `commands/workstation-setup.ts`, `runner-gateway/read-repos.ts`) do not set `prReview` either. The field is optional, so leave them as they are.

### 4.5 apps/web (small, needed for "the owner sees why")

- New `apps/web/src/components/RepoReviewerTokenStatus.tsx`. It renders only when `repo.prOnly && repo.reviewerToken != null`.
  - `missing`: a warning line, "Reviewer token missing: no reviews run on this repository." Below it, the help text: "DevOps sets a comment-only token on the workstation: `guildwise-runner reviewer-token set <remote url>`. The token stays on the workstation." Use `data-testid={`repo-reviewer-token-${repo.name}`}`, in line with the `repo-pr-only-*` ids.
  - `present`: a neutral line, "Reviewer token set on a workstation."
  - **No input field.** The token is never typed into the browser, because the server must never carry it. The text wraps on narrow and touch screens and has nothing to tap, so no soft keyboard opens. To follow the all-devices standing order, use plain flow layout, `text-xs`, and the colour and badge style that `RepoPrOnlyControl` already uses.
- `apps/web/src/pages/ProjectSettings.tsx`: render it in the repo row **directly after `<RepoPrOnlyControl … />`**, under the same `traits.usesRepos` condition. That is one added line plus the import. Do not change `RepoPrOnlyControl.tsx`: its test file stays untouched.

### 4.6 docs

`docs/RUNNER.md`:

- Under "Credentials and secrets", add one bullet: reviewer tokens live in `secrets/reviewer-tokens.json`, sealed, mode 0600, and are set with `guildwise-runner reviewer-token set`. Only present or missing is reported.
- Add a new section, "Reviewer runs (PR-only repositories)", near "Sandbox isolation". It covers:
  - the fresh standalone checkout per run under `reviews/<runId>`: no remote, read-only on disk and in the sandbox, offline shell, fresh home/scratch/tmp, removed afterwards;
  - that the runner, not the agent, posts one COMMENT review;
  - **token setup by DevOps**:
    - a dedicated bot account with the **Read** role on the repository. Read is enough to comment on PRs and can never push or merge, even if the token were mis-scoped;
    - a fine-grained PAT for that account, limited to the one repository, with the permissions Pull requests read and write, Contents read and Metadata read, and an expiry date. A GitHub App with the same three permissions works the same way and is a later option;
    - the command, and that classic PATs with write scopes are refused.

`docs/USER-GUIDE.md`: GWP-195 added a PR-only paragraph. Add one sentence saying that reviews need a reviewer token on a workstation, and that the repository shows "Reviewer token missing" until one is set.

## 5. Acceptance criteria mapped to the design and tests

| AC | Design | Test (new files only) |
|---|---|---|
| AC1 write/push fails, nothing reaches the repo | Standalone checkout with no remote and no credential config; `chmod -R a-w`; sandbox `denyWrite` on the cwd plus `offline`; `GIT_PUSH_DENIED`; no credential in `agentEnv` | `apps/runner/test/reviewer-sandbox.test.ts`. The fake remote is a local bare repo with a PR ref. After `prepareReviewerRun`: `writeFileSync` in the checkout throws; `git add` and `git commit` fail; `git push` and `git push origin` fail (no destination); `git remote -v` is empty; `.git/config` has no `url` or `credential`; the bare repo's refs are unchanged. A `reviewerPolicy` snapshot shows the cwd in `denyWrite`, `allowedDomains` empty, `Bash(git push:*)` denied, and the token string absent from the settings JSON and the env |
| AC2 comment posted with that token | `GitHubReviewPoster`, token from the store only | `apps/runner/test/review-poster.test.ts`. A fake `fetch` host records requests. Expect one POST to `/repos/o/r/pulls/7/reviews` with `Authorization: Bearer github_pat_FAKE_…`, `event: 'COMMENT'` and `commit_id = headSha`. With no token in the store, it throws and makes no request. The 422 retry moves the findings into the body. It never calls `gh` (executor spy) |
| AC3 token not on the server | Only a boolean or enum crosses the wire; schemas are `.strict()` | `packages/shared/test/reviewer-run.test.ts`: `ReviewerRunSpecSchema` and `ReviewerTokenFactSchema` reject a `token` key. `apps/runner/test/reviewer-token-report.test.ts`: the `repos.report` payload holds `present: true`, and the sentinel token is not in `JSON.stringify(payload)`. `apps/server/test/reviewer-token.test.ts`: a FakeRunner reports `reviewerToken: { present: true, token: 'github_pat_SENTINEL' }`; `workstation_repos.reviewer_token = true`; the sentinel is absent from `events.payload::text`, from the `workstation_repos` and `workstations` rows (`row_to_json(...)::text`) and from the captured server log output |
| AC4 no token, no run, visible state | `reviewerGate` + `listReviewablePrs` (the gate on GWP-195's pick point) + DTO + web status | `apps/server/test/reviewer-token.test.ts`. Set up a PR-only repo, record a PR through `applyPrListResult` as `pr-only-eligibility.test.ts` does, and use no flag or a false flag. Expect: `listReviewEligiblePrs` still lists the PR (unchanged GWP-195 behaviour); `listReviewablePrs` is `[]`; `reviewerGate` = `reviewer_token_missing`; no `runner_commands` row except `repo.list_prs`; the project API repo shows `reviewerToken: 'missing'`. Then flip the report to present: `listReviewablePrs` lists the PR with that workstation id, `reviewerGate` = `ready`, and the DTO shows `present`. A non-PR-only repo gives `not_pr_only` and a DTO value of `null`. `apps/web/src/test/repo-reviewer-token.test.tsx`: the missing text renders and has no input; nothing renders for null. Runner backstop in `reviewer-sandbox.test.ts`: an empty store refuses with `reviewer_token_missing` and creates no run dir |
| AC5 fresh checkout per run | `reviews/<runId>` + per-run home/scratch/tmp, removed in dispose and swept at startup | `reviewer-sandbox.test.ts`. Run 1 writes `leftover.txt` to its scratch, home and tmp, then is disposed. Run 2 (new runId, same PR) has none of them in its checkout, scratch, home or tmp, and run 1's dirs are gone. The sweep removes an orphaned `reviews/<id>` |

Server tests need the test database (Postgres 5433). If the build shift cannot reach it, the builder says so and the tester runs `reviewer-token.test.ts`. Runner and shared tests are plain unit tests. These existing GWP-195 tests must still pass unchanged: `apps/server/test/pr-only-*.test.ts`, `apps/web/src/test/repo-pr-only.test.tsx` and `apps/runner/test/forge-list-prs.test.ts`.

## 6. Assumptions about GWP-195 (checked after it landed)

1. PR-only flag: **holds**. It is `project_repos.pr_only`, exposed as `ProjectRepoDto.prOnly`.
2. Eligibility point: **revised**. `listReviewEligiblePrs` is a query and nothing dispatches runs yet. The gate is applied through the new `listReviewablePrs` wrapper in `reviewer-gate.ts`, and GWP-195 code is not changed (section 4.4). The gate itself is unchanged.
3. Settings placement: **holds**. `RepoReviewerTokenStatus` goes directly after `RepoPrOnlyControl` in the repo row of `ProjectSettings.tsx`.
4. GitHub only: **holds**. Only `GitHubForge.listOpenChanges` exists.
5. No run or payload in GWP-195: **holds**. GWP-197 must get the head and base SHAs, which GWP-195 does not store (section 0).

## 7. Risks

- **Builder sandbox and file modes:** if tests run as root, `chmod a-w` does not stop writes. Tests should skip the EACCES assertion when `process.getuid?.() === 0` and still assert the sandbox settings and the push failures.
- **Placeholders vs chmod ordering** (section 4.3): getting this wrong breaks every reviewer shell with "Read-only file system" at sandbox start.
- **Owner's clone lock:** the private-ref fetch takes `withRepoLock`, the same lock that card worktrees use. Keep the lock short (fetch and ref only), and build the run checkout after releasing it if possible.
- **The token scope cannot be fully checked for fine-grained PATs**, because GitHub does not expose their permissions. The guard against a mis-scoped token is the Read-role bot account (docs), plus the facts that the token never reaches the agent and the runner only ever calls the reviews endpoint.
- **Stale flag:** the server fact can lag by up to a minute. The runner backstop covers it.
- **Disk:** the hard-linked local fetch is cheap, but on another filesystem the objects are copied. Dispose and the sweep keep `reviews/` from growing.
- **Bypassing the gate later:** a later card could take work from `listReviewEligiblePrs` directly and skip the gate. The JSDoc of `listReviewablePrs` and the GWP-197 brief must say it is the only source. GWP-197's dispatcher test should cover the token-missing case.

## 8. Answers to the planning note's questions

1. Working branch: the card branch the runner created. The builder does not choose one.
2. Token storage: a separate sealed file, `secrets/reviewer-tokens.json`, not `git-tokens.json` (section 3.3).
3. Gate: both. The server gate decides and shows the state, and the runner refuses as a backstop (section 3.4).
4. Tests: new files only, as listed in section 5. No existing test file is modified.

## 9. Order within group pr-review

GWP-196 lands first. The following cards build on `apps/runner/src/review/` and on `listReviewablePrs`:

- **GWP-197**: the Sonnet run (shift kind or command), a 10-minute timeout, and findings handed over through `<run scratch>/findings.json`, validated by `ReviewFindingSchema` and posted with `GitHubReviewPoster`. It takes work from `listReviewablePrs` and gets the head and base SHAs.
- **GWP-198**: the cap, applied before `post`.
- **GWP-203**: the replay. It uses `prepareReviewerRun` without a poster, and the token gate may be bypassed for offline replay since nothing is posted.
- **GWP-204**: the Opus reviewer.
