# GWP-211 Hard size check: a status check that blocks merging an over-budget PR unless the owner approved an exception

Design for the hard size check (PRD "Review Gates & Reviewer Workflow" v22, section 8 "A CI/status check is needed for
the size block", section 10 "The hard size check comes last", decision log "Over-budget PRs blocked; exception by owner
approval"). It builds on GWP-205 (size budget and unit), GWP-209 (open-PR snapshot with sizes, stacked-PR chains, the
size verdict) and GWP-210 (owner-approved size exceptions). All three have now landed on the working branch (checked at
855691aa). Section 0 compares the first version of this design with the landed code. The rest of the report has been
corrected where the landed code differs.

## 0. Assumption review against the landed code (revision 2)

| Card # | Report # | Holds? | What the landed code says | What changed in this design |
|---|---|---|---|---|
| 1 | A1, A2 | **Yes** | `packages/shared/src/projects/review-settings.ts`: `SizeUnit = 'changed_lines' \| 'changed_files'`, `sizeChecksStatus(s)` with reason `REVIEW_SETTING_MISSING.sizeBudget = 'inactive: no size budget set'` (and `'inactive: no size unit set'`). `reviewSettingsOf(row)` is in `apps/server/src/queries/misc.ts`. `setReviewSettings` (`apps/server/src/commands/projects.ts`) is the only writer, through `ProjectReviewSettingsSet`; the projection is the only `UPDATE projects SET size_budget…` | Nothing |
| 2 | A3 | **Partly** | `apps/server/src/commands/pr-size-check.ts` and `packages/shared/src/review/size-check.ts` landed, with different names and shapes: the verdict is **`prSizeVerdict` / `PrSizeVerdict`**, not `sizeVerdict`. `unknown` has `reason: 'not_listed' \| 'no_size'`, and `within`/`over` carry `complete`. **`loadSizeContext` always excludes card branches** (it sets `excluded: cardBranches.has(head)`) and does not select `head_sha`. `OpenChange` has flat `changedLines`, `changedFiles`, `crossRepo` and `headSha` fields (not `size`). `sizeUnitWord(unit)` already exists. `requestPrList(ctx, repoId, { force })` exists. The snapshot table is `pr_open_changes` (migration 2970), and it is already in `rebuild.ts` `SAVED` | `evaluateSizeStatuses` builds its own candidate list (4.4). The message helpers reuse `sizeUnitWord`. Use the next migration number after 2980 (4.3) |
| 3 | A4 | **Partly** | GWP-210 keys exceptions by **`pr_reviews.id`**, not by `(repoId, changeId)`. `sizeExemptionOf(db, prReviewId, currentSize?)` (`commands/size-exemption.ts`) matches `pr_review_id = id OR id = ANY(chain_pr_review_ids)`, so a chain approval covers every recorded member. Exceptions **are pinned to the approved size**: `exemptionCovers(e, currentSize)` checks `currentSize <= e.size`, and `evaluateRepoSizes` withdraws (`supersedeSizeExemption`) an exception the PR has grown past. Approve and reject both run in `resolveSizeExceptionIn` inside the desk `closeItem` transaction. Lapse runs in `sizeExceptionSweep`, one `withAppendTx` per request | The lookup goes through `pr_reviews` (4.4). **Card PRs never have an exception**, because they have no `pr_reviews` row. That is the fallback this design already accepted (the PRD has Johnny raise exceptions only for reviewed PRs). The refresh hooks use `afterCommit(tx, …)` at the three named places (4.4). There is no "grown past the exception" risk any more (section 6) |
| 4 | A5 | **No** | `pr_only` gates the flow in **two** places beyond the poll query. (a) `requestPrList` only selects `r.pr_only` repositories, so a widened poll would get `skipped`. (b) `applyPrListResult` returns at "Off means off" (`!repo?.pr_only`) **before** `writeOpenChangeSnapshot`, so a non-PR-only repository never gets a snapshot. Also, `setRepoPrOnly` calls `requestPrList` without `force`. Once size-check repositories are polled, that request can be throttled (5 minutes) | 4.4 "Changes to dependency code" now names all three changes and the ordering inside `applyPrListResult` |
| 5 | A6 | **Yes** | GWP-196 landed a **reviewer-only** store (`apps/runner/src/review/reviewer-tokens.ts`, `FileReviewerTokenStore`, keyed by normalized remote URL on top of `secrets/sealed-file.ts` `SealedFile`). It is not a general purpose-token store | Nothing. `status-tokens.json` stays separate. `review-poster.ts` already exports `githubApiBase(host)` (api.github.com or `<host>/api/v3`): reuse it rather than writing a second one |

**Also landed since the first version (not one of the card's assumptions; no design change):** GWP-214 added a GitHub App
integration on the runner (`apps/runner/src/apps/github-app.ts`, `packages/shared/src/apps/index.ts`). Its default
permissions are `contents`, `pull_requests` and `issues` write, without `statuses` or `checks`. It is also the bot identity
the agents commit and open PRs as. **Do not post the size status with an app installation token:** the identity whose PRs
are gated must not also write the gate. The token also lacks the permission. The dedicated status token stays. A second
copy of `githubApiBase` sits in `apps/github-app.ts`. Import one of the two copies, or move it to one shared place.

## 1. Question

1. Who posts the check: a GitHub status from the runner, or a GitHub Actions workflow in the repository?
2. Where does the result come from (size, budget, unit, chain, exception), and when is it refreshed?
3. Which credential posts it, given that the reviewer's comment-only token must not be stretched?
4. How does the check stay out of the way for projects without a budget (AC5)?
5. What does the owner have to do on GitHub to make it block merging (documented, never done from code)?

## 2. Findings

### 2.1 What exists

- **Forge layer** (`apps/runner/src/forge/types.ts`): the `Forge` interface has no member for posting a status.
  `GitHubForge` (`forge/github.ts`) talks to GitHub through the user's `gh` login (`this.gh()`). Tokens for forges
  without a CLI login live in `forge/tokens.ts` (`TokenStore`, sealed `<data dir>/secrets/git-tokens.json`). The
  reviewer's comment-only tokens live in `review/reviewer-tokens.ts` (sealed, per remote URL). `review/review-poster.ts`
  posts to GitHub over REST with `env.fetch` and `githubApiBase(host)`.
- **Branch protection is already read** (`GitHubForge.branchRules`): a branch with **any required status check** gives
  `requiresChange: true`, and the completion then opens a pull request instead of merging straight into the working
  branch (`git/completion.ts`). **Consequence:** once the owner makes this check required on `main`, every card of that
  repository lands as a pull request. Those card PRs need the status too, or they wait for it forever. The check
  therefore covers **every open PR of the repository**, not only PR-only (GWP-195) PRs.
- **GWP-195** (landed): `repo.list_prs`, `GitHubForge.listOpenChanges` / `forge/list-prs.ts`. On the server,
  `commands/pr-only.ts` has `pollPrOnlyRepos` (5-minute throttle), `requestPrList` (PR-only repositories only) and
  `applyPrListResult`. `applyPrListResult` records PRs in `pr_reviews`, skipping card branches, and returns early when
  the repository is not PR-only.
- **GWP-205** (landed): see section 0, row 1.
- **GWP-209** (landed): `OpenChange` carries `changedLines`, `changedFiles`, `crossRepo` and `headSha`. Inside
  `applyPrListResult`, `writeOpenChangeSnapshot(tx, repoId, changes, complete, now)` writes `pr_open_changes`
  (`change_id`, `head_branch`, `base_branch`, `cross_repo`, `head_sha`, `changed_lines`, `changed_files`) and
  `pr_review_polls.complete`. Shared `prChain(changeId, open)` builds the stack (`B.base == A.head`, A not from a fork,
  connected group, `excluded` candidates neither count nor link). Shared `prSizeVerdict({ settings, changeId, open,
  complete })` returns `inactive | unknown | within | over`. Server `loadSizeContext` / `verdictOf` and
  `evaluateRepoSizes` (needs-split for recorded PRs) also landed.
  - **The chain sum is the sum of each member's own size** as GitHub measures it against its own base, so no line is
    counted twice. A stack always lives in one repository, because a PR's base is a branch of the same repository.
- **GWP-210** (landed): `pr_size_exceptions` (migration 2980) with `pr_review_id`, `chain_pr_review_ids`, `size`,
  `budget`, `unit` and `state`. `sizeExemptionOf` and `exemptionCovers` are described in section 0, row 3.
- **No size-status code, credential or doc exists.** `docs/OWNER-SETUP` does not exist. `docs/security/github-settings.md`
  is the owner checklist for **this** repository's own GitHub settings.

### 2.2 GitHub facts that shape the design

- **Commit statuses** (`POST /repos/{owner}/{repo}/statuses/{sha}`, body `state`, `description`, `context`,
  `target_url`) attach to a commit SHA. The latest status per `context` wins. `description` is limited to **140
  characters**. A fine-grained personal access token needs only the repository permission **"Commit statuses: Read and
  write"**.
- **Check runs** (the Checks API) can only be created by a GitHub App.
- **Required status checks** (branch protection rule or ruleset) take the `context` string. GitHub offers a context in
  the picker only after it has been reported recently. A required context with no status on the PR's head shows
  "Expected — Waiting for status to be reported" and blocks merging: **a missing status fails closed.**
- A status set by a personal token cannot be pinned to a source. Section 6 covers this.

## 3. Options

### 3.1 Who posts the check

| | A. The runner posts a commit status (server decides, runner posts) | B. A GitHub Actions workflow in each repository | C. A GitHub App posting check runs |
|---|---|---|---|
| Budget, unit, exception, chain | All already on the server | The workflow must call the GuildWise server with a server API token kept as a repository secret | As A |
| Refresh when the owner approves an exception | Immediate | Needs a re-run triggered from outside | As A |
| Footprint in the customer's repository | None | A workflow file in every repository | An App installed on the org |
| Credential | One least-privilege token on the workstation | `GITHUB_TOKEN` plus a GuildWise token stored on GitHub | App private key, App registration per org |
| Fits "GuildWise hosts nothing, keeps no user tokens" | Yes | Partly | Yes, heavy to set up |
| Cost to build | Small | Large | Large |

**Choice: A.** C is the stronger long-term option (source pinning, check run). It is a backlog follow-up, not built
here.

### 3.2 Which credential

| | A. A dedicated "size check status token" | B. The reviewer's comment-only token (GWP-196) | C. The workstation's `gh` login |
|---|---|---|---|
| Permissions | Commit statuses: write only | Pull requests: write; statuses would mean widening it | Usually the owner's full `repo` scope |
| Card constraint | Meets it | Breaks "comment-only" | Far more power than needed |

**Choice: A.** **Size check status token**: a GitHub fine-grained PAT, resource owner = the repository owner,
repository access = only the project's repositories, permission **Commit statuses: Read and write**, nothing else. It is
stored only on the workstation, sealed, in `<data dir>/secrets/status-tokens.json`, and it never reaches the server, an
agent or a log. The owner creates it on GitHub. DevOps (Anvil) checks that the CLI exists but never handles the token.

### 3.3 Which PRs get the status

**Every open PR** of every GitHub repository of a project with an active size check, card PRs included (see 2.1). The
poll is widened to cover these repositories (4.4). Recording into `pr_reviews`, needs-split and the review flow stay
PR-only.

### 3.4 Projects without a budget (AC5)

Nothing is posted. After a budget is removed, repositories that had the check keep getting a passing "inactive" status,
so a rule the owner forgot to remove does not block merging.

## 4. Design

### 4.1 Flow

```
scheduler: pollPrOnlyRepos (GWP-195), widened (every 5 min)
  requestPrList: PR-only OR size check active OR repo in pr_size_status_repos      [widened, 4.4]
  runner repo.list_prs → open PRs with changedLines/changedFiles/crossRepo/headSha (landed GWP-209 fields)
server applyPrListResult, same transaction (order matters):
  poll row ok
  if repo.pr_only (and pr_only_since): record/close pr_reviews (GWP-195, unchanged)
  writeOpenChangeSnapshot(tx, repoId, ...)            (GWP-209; now for EVERY polled repo, moved out of the PR-only branch)
  if repo.pr_only: resolveTimedOutTwice / withdrawSizeExceptionOnClose for closed PRs, evaluateRepoSizes  (unchanged)
  evaluateSizeStatuses(ctx, tx, projectId, repoId, now)   [new; after evaluateRepoSizes so a withdrawn exception is seen]
    per snapshot PR with a 40-hex head_sha:
      verdict  = prSizeVerdict({ settings, changeId, open: all PRs with excluded:false, complete })
      excepted = recorded PR (pr_reviews, open) && sizeExemptionOf(tx, prReviewId, verdict.total) != null
      desired  = sizeStatusFor({ verdict, excepted, hadStatus })
      desired differs from the pr_size_statuses row (head_sha, state, description) → upsert, post_state 'pending'
    complete list: delete rows of PRs no longer listed

scheduler: deliverSizeStatuses                              [new]
  pending | failed+retryable | queued too long → pick workstation → enqueue repo.commit_status
runner: postCommitStatus → POST {githubApiBase(host)}/repos/{o}/{r}/statuses/{sha} with the size check status token
server: applyCommitStatusResult → posted | failed

after commit → refreshSizeStatuses({ projectId, repoId? }):
  setReviewSettings (GWP-205) committed with a change
  resolveSizeExceptionIn (GWP-210 approve/reject, in the desk closeItem tx) → afterCommit(tx, …)
  sizeExceptionSweep lapse (GWP-210, per-request tx) → afterCommit(tx, …)
card PR opened (repo.open_pr ok) on a repo with an active size check → requestPrList(repo, { force: true })
```

### 4.2 Shared (`packages/shared`)

**New file `src/review/size-status.ts`** (pure, fully unit-tested):

```ts
import type { SizeUnit } from '../projects/review-settings.ts';
import { type PrSizeVerdict, sizeUnitWord } from './size-check.ts';   // landed GWP-209

/** The status context the owner makes required on the branch. Never change it: rules refer to it by name. */
export const SIZE_STATUS_CONTEXT = 'size-budget';
/** Announced by a runner that can post a commit status (`repo.commit_status`). */
export const COMMIT_STATUS_CAPABILITY = 'commit-status:1';
export const COMMIT_STATUS_DESCRIPTION_MAX = 140;            // GitHub limit
export const COMMIT_STATUS_MAX_ATTEMPTS = 3;

export type SizeStatusState = 'success' | 'failure' | 'pending';
export type SizeStatusReason = 'within' | 'over' | 'owner_exception' | 'inactive' | 'unknown';

export interface SizeStatus {
  state: SizeStatusState;
  reason: SizeStatusReason;
  description: string;                                       // ≤ 140 chars, always
  total?: number; budget?: number; unit?: SizeUnit; members?: string[];
}

/** "700 changed lines", "1 changed file": plural from sizeUnitWord, singular for exactly 1. */
export function sizeWithUnit(n: number, unit: SizeUnit): string;

/**
 * The status to post for one PR, or null for "post nothing".
 * - inactive  → hadStatus ? success `Size check ${verdict.reason}` (e.g. 'Size check inactive: no size budget set') : null  (AC5)
 * - unknown   → pending 'Size not measured yet'
 * - over + excepted → success 'Passed by owner exception: 700 changed lines, budget 600 changed lines'          (AC2)
 * - over      → failure 'Over budget: 700 changed lines, budget 600 changed lines (stack #12 #13)'              (AC1, AC4)
 * - within    → success 'Within budget: 420 changed lines, budget 600 changed lines'                           (AC3)
 * Stack suffix only for a chain of more than one PR; past 140 chars it becomes ' (stack of 7 PRs)'. The size, budget
 * and unit part is never cut.
 */
export function sizeStatusFor(i: { verdict: PrSizeVerdict; excepted: boolean; hadStatus: boolean }): SizeStatus | null;
```

Notes:
- The total in the message is the **chain total**, so every member of an over-budget chain fails with the same numbers
  (AC4).
- `excepted` is decided by the server (4.4). The pure function does not look anything up.
- `within` on an incomplete list (`complete: false`) is still `within`, as in GWP-209.

**Protocol** (`src/protocol/runner.ts`): a new command `repo.commit_status`:

```ts
export const RepoCommitStatusPayloadSchema = z.object({
  statusId: z.uuid(),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  forge: ForgeKindSchema.optional(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  state: z.enum(['success', 'failure', 'pending']),
  context: z.string().min(1).max(100),
  description: z.string().max(140),
  targetUrl: z.string().url().max(500).optional(),
});
export const RepoCommitStatusResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false),
    code: z.enum(['no_clone', 'no_token', 'forbidden', 'not_found', 'invalid_sha', 'unsupported', 'error']),
    error: z.string().max(400) }),
]);
```

Add both to `RunnerCommandNameSchema` and `CommandPayloadSchemas`. The command is generic (any context).

**Runner hello / status report:** the runner adds `statusTokens: string[]` (keys such as `github@github.com`, never the
token) next to the git connection status it already reports.

**DTO:** the project DTO's `reviewSettings` gains `sizeStatus: { context: 'size-budget', state: 'inactive' | 'active' |
'no_token' | 'no_runner', reason?: string, failing: number, lastPostedAt: string | null }`.

### 4.3 Data model: migration `apps/server/migrations/2990_pr_size_status.sql`

The highest landed number is 2980 (`2980_pr_size_exceptions.sql`). Take 2990, or the next free number at build time.
Both tables are operational. Add them to `rebuild.ts` `SAVED` next to `pr_open_changes`, with `restoreWhere:
'project_repo_id IN (SELECT id FROM project_repos)'`.

```sql
-- Hard size check: the commit status wanted and posted per open pull request, and the repositories that ever had one
-- (they keep getting a passing "inactive" status after the budget is removed). Operational, refreshed by polling.
CREATE TABLE IF NOT EXISTS pr_size_statuses (
  project_repo_id uuid NOT NULL,
  change_id text NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL,                 -- success | failure | pending
  reason text NOT NULL,                -- within | over | owner_exception | inactive | unknown
  description text NOT NULL,
  total integer, budget integer, unit text,
  post_state text NOT NULL,            -- pending | queued | posted | failed
  status_id uuid NOT NULL,             -- new for every change of (head_sha, state, description)
  attempts integer NOT NULL DEFAULT 0,
  workstation_id uuid, queued_at timestamptz, posted_at timestamptz,
  error_code text, error text, retryable boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_repo_id, change_id)
);
CREATE INDEX IF NOT EXISTS pr_size_statuses_open ON pr_size_statuses (post_state)
  WHERE post_state IN ('pending', 'queued', 'failed');
CREATE TABLE IF NOT EXISTS pr_size_status_repos (
  project_repo_id uuid PRIMARY KEY,
  first_posted_at timestamptz NOT NULL
);
```

### 4.4 Server (`apps/server`)

**New `src/commands/pr-size-status.ts`:**

- `evaluateSizeStatuses(ctx, tx, projectId, repoId, now)`:
  - **Builds its own candidate list. Do not use `loadSizeContext`**, which always excludes card branches and does not
    select `head_sha`. Read `projects` (`reviewSettingsOf`), then `SELECT change_id, head_branch, base_branch,
    cross_repo, head_sha, changed_lines, changed_files FROM pr_open_changes WHERE project_repo_id=$1` and
    `pr_review_polls.complete`. Map each row to a `ChainCandidate` with **`excluded: false`** for every PR, so card PRs
    are checked too. If you prefer, add an optional `{ includeCardBranches: true }` to `loadSizeContext` plus `head_sha`
    in its select. Either way, GWP-209's behaviour must not change.
  - Exceptions: `SELECT id, change_id FROM pr_reviews WHERE project_repo_id=$1 AND closed_at IS NULL` gives
    changeId → prReviewId. For a PR whose verdict is `over`: `excepted = prReviewId != null && (await
    sizeExemptionOf(tx, prReviewId, verdict.total)) != null`. Passing `currentSize` makes the lookup respect the
    approved size. It is read-only: **never call `supersedeSizeExemption` here**, because `evaluateRepoSizes` owns that
    and runs first in the poll transaction. Card PRs (no `pr_reviews` row) are never excepted.
  - `hadStatus` = the repository is in `pr_size_status_repos`.
  - For each snapshot PR whose `head_sha` matches `/^[0-9a-f]{40}$/`: `prSizeVerdict(...)` → `sizeStatusFor(...)`.
    Null → no row change. Otherwise compare with the row: same `head_sha`, `state` and `description` → nothing.
    Otherwise upsert with a new `status_id`, `post_state 'pending'`, `attempts 0`, error fields cleared.
  - Complete list: delete rows whose PR is no longer listed. Incomplete list: delete nothing.
  - No network calls, and it never throws on missing data.
- `deliverSizeStatuses(ctx)` (scheduler pass, the same shape as GWP-209's `deliverSplitNotices`). It picks rows that
  are `pending`; `failed` with `retryable`, `attempts < COMMIT_STATUS_MAX_ATTEMPTS` and `queued_at` older than 5 minutes;
  or `queued` older than 10 minutes. It skips simulation organizations. For each row:
  - It picks a connected workstation with the clone (`workstation_repos`), `COMMIT_STATUS_CAPABILITY` in
    `workstation_capabilities` and a status token for the host (`statusTokens`), preferring the workstation that
    answered the last poll. If there is none, the row stays `pending` and the DTO says `no_token` or `no_runner`.
  - It sets `post_state 'queued'`, `attempts+1`, `queued_at` and `workstation_id`, then calls
    `enqueueRunnerCommand(tx, ws, 'repo.commit_status', payload, expiry)` and `gateway.deliverPending`.
- `applyCommitStatusResult(ctx, payload, ok, result, error)`: matches by `statusId`; a stale answer is ignored. `ok` →
  `posted`, `posted_at`, insert `pr_size_status_repos` if missing. Error → `failed` with `error_code`, `error` and
  `retryable = code ∉ {no_token, forbidden, not_found, invalid_sha, unsupported}`.
- `refreshSizeStatuses(ctx, { projectId, repoId? })`: own `withAppendTx`. It runs `evaluateSizeStatuses` for the
  repository, or for each repository of the project that has a snapshot or a status row, from the current snapshot,
  then `deliverSizeStatuses`. Errors are logged, never thrown to the caller. It is called **after commit** from:
  - `commands/projects.ts` `setReviewSettings`: after the `withAppendTx` returns, only when something was appended
    (have the transaction return `true` on append);
  - `commands/size-exception.ts` `resolveSizeExceptionIn` (approve **and** reject): `afterCommit(tx, () =>
    refreshSizeStatuses(ctx, { projectId: row.project_id, repoId: row.project_repo_id }))`. It runs inside the desk
    `closeItem` transaction, so `afterCommit` is the hook;
  - `commands/size-exception.ts` `sizeExceptionSweep`, on the lapse branch: the same `afterCommit` inside the
    per-request transaction;
  - the `repo.open_pr` ok result of a card on a repository whose project's size check is active:
    `requestPrList(ctx, repoId, { force: true })`.

**Changes to dependency code (keep them small and named):**

- `commands/pr-only.ts` (GWP-195 + GWP-209):
  - **`requestPrList`**: its select has `AND r.pr_only`. Widen it to `AND (r.pr_only OR <size check active> OR EXISTS
    (SELECT 1 FROM pr_size_status_repos s WHERE s.project_repo_id = r.id))`. "Size check active" is `p.size_budget IS NOT
    NULL AND p.size_unit IS NOT NULL`. Put the predicate in one exported SQL fragment or helper and use it in both
    places. Without this, a widened poll only ever gets `skipped`.
  - **`pollPrOnlyRepos`**: the same widened predicate in its select. Keep the name, or rename to `pollPrRepos` and update
    the scheduler. Keep the throttles.
  - **`applyPrListResult`**: today it returns at `if (!repo?.pr_only || !repo.pr_only_since) return;` **before**
    `writeOpenChangeSnapshot`. Restructure so that for every `ok` answer of a live repository:
    1. if PR-only: record/close `pr_reviews` and append the events (unchanged);
    2. always: `writeOpenChangeSnapshot(tx, repoId, r.changes, r.complete, now)`;
    3. if PR-only: closed-PR handling (`resolveTimedOutTwice`, `withdrawSizeExceptionOnClose`) and `evaluateRepoSizes`
       (unchanged);
    4. always: `evaluateSizeStatuses(ctx, tx, projectId, repoId, now)`.
    "Off means off" still holds for `pr_reviews`: a non-PR-only repository must never get `pr_reviews` rows or
    PR-review events.
  - **`setRepoPrOnly`**: pass `force: true` to `requestPrList` when turning PR-only on. The repository may have been
    polled for the size check less than 5 minutes ago, and the owner should not wait for the first recording.
- `runner-gateway/handlers.ts`: a terminal branch for `repo.commit_status` → `applyCommitStatusResult`.
- `scheduler/scheduler.ts`: `deliverSizeStatuses(ctx).catch(log)` after the poll pass.
- `queries/misc.ts`: `sizeStatus` on the project DTO.
- `projections/rebuild.ts`: the two new tables in `SAVED`.
- **Do not touch** branch protection, rulesets or any GitHub setting from code.

### 4.5 Runner (`apps/runner`)

- **`forge/types.ts`:** add `statusTokens?: StatusTokenStore` to `ForgeEnv`, and add to `Forge`:

  ```ts
  export interface CommitStatusInput {
    sha: string; state: 'success' | 'failure' | 'pending'; context: string; description: string; targetUrl?: string;
  }
  export type CommitStatusOutcome =
    | { ok: true }
    | { ok: false; code: 'no_token' | 'forbidden' | 'not_found' | 'invalid_sha' | 'error'; error: string };
  /** Sets a commit status with the size check status token (never the CLI login). Absent: not supported on this host. */
  setCommitStatus?(repo: RemoteRepo, s: CommitStatusInput): Promise<CommitStatusOutcome>;
  ```

- **`forge/github.ts` `setCommitStatus`:** `this.env.fetch` with the token from `this.env.statusTokens?.get('github',
  this.host)`, **not** `this.gh()`:
  - No token → `{ ok: false, code: 'no_token' }` and no request.
  - `POST ${githubApiBase(host)}/repos/{fullName}/statuses/{sha}`. Reuse `githubApiBase` from
    `review/review-poster.ts`, or move it to `forge/http.ts` and import it in both places. Headers `Authorization:
    Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`; body `{ state, context,
    description, target_url? }`.
  - 201 → ok. 401 → `no_token`. 403 → `forbidden`. 404 → `not_found`. 422 → `invalid_sha`. Anything else, or a network
    error → `error`. The error text never contains the token.
- **New `forge/status-tokens.ts`:** `StatusTokenStore` (`get(provider, host)`, `set`, `remove`, `list()` without token
  values, `problem()`), a `SealedFile` (`secrets/sealed-file.ts`) at `<data dir>/secrets/status-tokens.json`, keyed like
  `tokens.ts` (`provider@host`). Follow `review/reviewer-tokens.ts` for the unreadable-file handling (warn once, quarantine
  before overwriting). This is its own file: it is never shared with the reviewer store or `git-tokens.json`.
- **New `forge/commit-status.ts`:** `postCommitStatus({ payload, remoteUrl, forgeEnv })`, mirroring `forge/list-prs.ts`:
  no clone → `no_clone`; a forge without `setCommitStatus` → `unsupported`.
- **CLI (`cli.ts`):** `guildwise-runner status-token github [--host <h>]` prints the exact token settings, reads the
  token without echo (as `reviewer-token set` / `git-connect` do) and saves it sealed. It also takes `--status` and
  `--remove`.
- **`runner.ts`:** announce `COMMIT_STATUS_CAPABILITY`; add the `repo.commit_status` branch (dedupe by `statusId` while a
  post is live); report the `statusTokens` keys. Never log a token.

### 4.6 Web (`apps/web`)

One read-only line in GWP-205's `ReviewSettingsPanel`, under the size budget and unit, from `reviewSettings.sizeStatus`,
`data-testid="size-status-line"`:

- inactive: "Hard size check: inactive until a size budget and unit are set."
- active: "Hard size check: posts the status **size-budget** on every pull request. To block merging, make it required
  on the branch (Guide 4.3d). 2 pull requests are over budget."
- no_token: "Hard size check: no workstation has a status token, so no status is posted and a required check keeps pull
  requests waiting. Run `guildwise-runner status-token github` on a workstation with the clone."
- no_runner: "Hard size check: waiting for a workstation with the clone to come online."

The line has no inputs (so no soft keyboard), never shows state by colour alone and wraps at 320 px. The command sits in
a copyable code element with a 44 px tap target, and nothing depends on hover.

### 4.7 Docs

- **`docs/USER-GUIDE.md`, new subsection "4.3d Hard size check on pull requests"** (after the GWP-209/GWP-210
  subsections; renumber if needed):
  - **What it is:** a status named `size-budget` on every open pull request of the project's GitHub repositories, once
    the project has a size budget and unit. Stacked PRs are measured together. Give the messages verbatim.
  - **Owner setup, in order:**
    1. Set the size budget and unit.
    2. Create a fine-grained PAT on GitHub: Resource owner = the repository owner; Repository access = only the
       project's repositories; Repository permissions = **Commit statuses: Read and write**; nothing else. Note its
       expiry.
    3. On a workstation that has the clone, run `guildwise-runner status-token github` (add `--host` for GitHub
       Enterprise Server).
    4. Wait until an open pull request shows the `size-budget` status (about 5 minutes at most).
    5. On GitHub, open Settings > Rules > Rulesets (or the branch protection rule) for the working branch. Turn on
       "Require status checks to pass" and add `size-budget`. **GuildWise never changes this for you.**
    6. Recommended: set Settings > Actions > General > Workflow permissions to "Read repository contents".
  - **What changes once it is required:** cards land as pull requests and get the status. An over-budget PR cannot be
    merged until it is split, or until the owner approves a size exception. Exceptions are available for reviewed (PR-only)
    pull requests, and an approval holds up to the approved size. If no workstation can post, PRs show "Expected" and
    wait.
  - **Removing the budget:** PRs that had the check get a passing "Size check inactive" status. Remove the rule as well.
- **`docs/RUNNER.md`:** the `status-token` command, `secrets/status-tokens.json`, `repo.commit_status` and
  `commit-status:1`.
- **`docs/security/github-settings.md`:** one optional checklist item: "If the project that builds this repository has
  a size budget, add `size-budget` as a required status check on `main` (USER-GUIDE 4.3d)."

## 5. Acceptance criteria mapped to design and tests

All tests go in **new files**. The **fake git host** is a fake `fetch` standing in for the GitHub REST API on the
runner, and a fake runner on the server that answers `repo.list_prs` (sizes, heads, bases, SHAs) and
`repo.commit_status`.

| AC | Design | Tests |
|---|---|---|
| AC1 | `prSizeVerdict` over → `sizeStatusFor` failure "Over budget: 700 changed lines, budget 600 changed lines"; the runner posts `failure` / `size-budget`; GitHub blocks the merge on a required context (4.3d) | shared `packages/shared/test/size-status.test.ts` (contains "700", "600", "changed lines"; ≤ 140 chars with a 30-PR stack; the files unit says "changed files"); runner `apps/runner/test/commit-status.test.ts` (exactly one POST to `/repos/o/r/statuses/<sha>`; the token appears only in Authorization); server `apps/server/test/pr-size-status.test.ts` (row `failure`, enqueued payload) |
| AC2 | recorded PR + `sizeExemptionOf(prReviewId, total)` → success "Passed by owner exception: ..."; refreshed by `afterCommit` in `resolveSizeExceptionIn` | shared table test; server: a recorded PR-only PR over budget, an approved `pr_size_exceptions` row (GWP-210 helper `test/helpers/size-exception.ts` or a direct row) → refresh → new `status_id`, `success`, "owner exception"; and grown past the approved size → `failure` again |
| AC3 | within → success "Within budget: ..."; 600 of 600 is within | shared (boundary); server (row `success`) |
| AC4 | `prChain` with `excluded:false` + chain total; every member fails with the stack suffix | shared: #12 300 + #13 400, budget 600 → both `failure`, "700", "(stack #12 #13)"; server: two rows `failure`, two commands; a card-branch PR in a **non-PR-only** repository gets a status and **no** `pr_reviews` row |
| AC5 | inactive + never had a status → null; after a budget removal → success "Size check inactive: no size budget set" | shared (null; success when `hadStatus`); server: no budget and not PR-only → `requestPrList` skipped, no rows, no command; budget set, posted, then removed → success inactive |

More runner tests: no token → `no_token` and no request; the 401/403/404/422 mapping; the GHES `/api/v3` base;
`apps/runner/test/status-tokens.test.ts`. Web: `apps/web/src/test/size-status-line.test.tsx`. The server test needs the
test database (Postgres 5433). If it is not up in the build shift, the builder names it for the testers.

**Regression check for the builder:** GWP-195's tests (`pr-only-eligibility`, `pr-only-regression`), GWP-209's
size-check tests and GWP-210's `size-exception-decide` / `size-exception-lapse` must still pass after the
`applyPrListResult` restructure and the `requestPrList` widening. A non-PR-only repository must never get `pr_reviews`
rows. Turning PR-only on records PRs at once (`force`).

## 6. Risks

- **Another writer of the same context:** anyone with "Commit statuses: write" could post `success`. The guide
  recommends read-only workflow permissions, and the server re-posts whenever its desired status differs. A GitHub App is
  the real fix (backlog).
- **Lag after a push:** up to about 5 minutes. With the check required, this delays merging but fails closed.
- **No workstation online, or no token:** the required check stays "Expected". This is intended, and the settings line
  says why.
- **More than 200 open PRs** (`complete: false`): `within` may be optimistic, as in GWP-209.
- **Chain scope differs from GWP-209 when a card PR is stacked with a human PR.** GWP-209 excludes card branches, while
  this check includes them. In that rare mix the status total can be larger than the total GWP-210 approved, so an
  approved exception may not cover it, and the status fails while needs-split does not fire. This is accepted (fail
  closed). The owner sees the stack in the message.
- **Card PRs cannot get an exception** (no `pr_reviews` row). A card PR over budget must be split. This matches the
  PRD.
- **Token expiry:** a 401 answers `no_token`, and the settings line shows it.
- **Migration number collision:** renumber at build time if 2990 is taken.

## 7. Out of scope

- Changing branch protection or rulesets.
- Commit statuses on GitLab, Bitbucket or Azure.
- A GitHub App / check runs.
- The size computation, the chain rule, needs-split and exceptions themselves (GWP-209, GWP-210).

## 8. Decisions recorded

1. The check is a **commit status posted by the runner**, decided by the server, with context **`size-budget`**.
2. Credential: a dedicated **size check status token** (fine-grained PAT, Commit statuses: Read and write only), sealed
   on the workstation.
3. Every open PR of every GitHub repository of a project with an active size check gets the status, card PRs included.
4. The chain is GWP-209's base-branch stack, with card PRs included for this check. Each member fails with the chain
   total.
5. No budget: nothing is posted, except a passing "inactive" status on repositories that had the check.
6. Message format as in 4.2, always ≤ 140 characters with size, budget and unit intact.
7. Owner steps go in USER-GUIDE 4.3d. No OWNER-SETUP file is created.
8. (Revision 2) Exceptions are read through `pr_reviews.id` with `sizeExemptionOf(..., total)`, read-only.

## 9. Assumptions (all checked against landed code, see section 0)

| # | Assumption | Status |
|---|---|---|
| A1 | `reviewSettingsOf`, `sizeChecksStatus`, `SizeUnit` | Holds |
| A2 | `setReviewSettings` is the single writer | Holds |
| A3 | GWP-209 snapshot, chain, verdict | Revised: `prSizeVerdict`, own candidate list with `excluded:false` and `head_sha`, `sizeUnitWord` |
| A4 | GWP-210 exception lookup | Revised: `sizeExemptionOf(prReviewId, total)`, size-pinned, hooks via `afterCommit` |
| A5 | GWP-195 gating | Revised: widen `requestPrList`, snapshot before the PR-only return, `force` in `setRepoPrOnly` |
| A6 | No general purpose-token store | Holds; reuse `githubApiBase` |

## 10. Card brief for the builder

See the brief and the summary handed off with this report.
