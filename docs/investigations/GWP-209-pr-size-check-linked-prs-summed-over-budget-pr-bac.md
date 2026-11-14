# GWP-209 PR size check: linked PRs summed, over-budget PR back to its author, second-timeout handling

Design for the size check on PR-only pull requests (PRD "Review Gates & Reviewer Workflow" v22: F6, F6.1, F1.5, F1.6).
It builds on GWP-195 (PR-only switch, `pr_reviews`, `repo.list_prs`), GWP-197 (first reviewer run, 10-minute timeout),
GWP-198 (findings cap, which already brings changed lines onto the poll), GWP-201 (owner re-run of a timed-out PR),
GWP-202 (owner-pending timer) and GWP-205 (size budget and unit).

**Revision 2026-11-14 (assumption review).** All dependencies have now landed on `main`. The first version of this
design was written against their branches. Section 9 lists every assumption and its status. Only assumption A5 did not
hold: the comment-only poster can post pull request reviews, but not issue comments. The author notice is therefore
posted as a body-only `COMMENT` review through the existing poster (sections 3.3, 4.5). Smaller updates follow from
code that has landed since:
- `OpenChange.changedLines` and `pr_reviews.changed_lines` (GWP-198) already exist, so only `changedFiles`,
  `crossRepo` and `headSha` are new (4.2, 4.5).
- Owner re-runs are recorded as `trigger 'manual'` + `rerun_of_run_id`, not as `'owner'` (4.2 `isSecondTimeout`).
- The web page is `apps/web/src/components/pull-requests/PullRequestsPage.tsx`.
- The migration number is `2970`.

## 1. Question

1. How are "linked or stacked" PRs detected, and how are their sizes added up without counting a parent's lines twice?
2. When does the size check run, where does it get its numbers, and who decides?
3. How is an over-budget PR (or chain) sent back to its author with no owner decision, and how is the author told?
4. How does a timeout hand over to the size check, including the "timed out twice" path to the owner with the
   2-working-day reminder?

## 2. Findings

### 2.1 What exists on `main` (checked at 22b3e1fe)

- **GWP-195 / GWP-198 PR list** (`apps/server/src/commands/pr-only.ts`, `apps/runner/src/forge/github.ts`):
  - `GitHubForge.listOpenChanges` runs `gh pr list --state open --json
    number,url,title,author,headRefName,baseRefName,createdAt,additions,deletions --limit 201`. It maps
    `additions + deletions` to `OpenChange.changedLines` (optional and nullable in `OpenChangeSchema`,
    `packages/shared/src/review/pr-review.ts`).
  - `pollPrOnlyRepos` / `requestPrList` poll every PR-only repository every 5 minutes.
  - `applyPrListResult` (called only from `runner-gateway/handlers.ts`) does the following in one `withAppendTx`:
    - records new PRs (`PrReviewRecorded`, state `not_reviewed`, with `changedLines`)
    - follows the size of known open PRs (`PrReviewSizeChanged` → `pr_reviews.changed_lines`)
    - closes gone PRs when the list is complete (`PrReviewClosed`)
    - returns early when the answer is stale or failed, or when the repository is no longer PR-only
  - Card-branch PRs and PRs opened before PR-only are not recorded.
  - `listReviewEligiblePrs` is "the single place reviewer work is picked from" (`review_state='not_reviewed'`). The
    daily-cap queue (`prReviewQueue`, `listQueueCandidates`) and `loadPrReviewStatus` build on it.
  - `PR_REVIEW_STATES = ['not_reviewed', 'reviewed']`.
- **GWP-197 / GWP-200 / GWP-201 runs** (`apps/server/src/commands/pr-review-runs.ts`):
  - `startPrReviewRun` is the only place a run starts. It locks the `pr_reviews` row and refuses any
    `review_state <> 'not_reviewed'` (`not_eligible`) for both `auto` and `manual`.
  - `manualReviewAction` (`apps/server/src/review/manual-action.ts`) offers a `rerun` only when the latest run timed
    out, and it always points at that run.
  - `triggerPrReview` is the one owner command (`trigger: 'manual'`, `requestedBy`). It appends `PrReviewRunStarted
    { trigger, requestedBy, rerunOfRunId }`.
  - `pr_review_runs` has `state`, `reviewer`, `started_at`, `trigger` (default `'auto'`, migration 2950) and
    `rerun_of_run_id` (2960).
  - A timeout is recorded with `PrReviewRunTimedOut` in two places:
    - in `applyPrReviewRunResult` (`by: 'runner'`), inside `withAppendTx`, after replay runs have branched off
    - in `sweepStalePrReviewRuns` (`by: 'server'`), one `withAppendTx` per run, also after the replay branch
  - `mayStart` never restarts a timed-out PR by itself.
  - `listPrReviews` maps rows to `PrReviewDto` (`PrReviewDtoSchema` in `pr-review.ts`). It casts `review_state` to
    `'not_reviewed' | 'reviewed'`.
- **GWP-196 poster** (`apps/runner/src/review/review-poster.ts`, `post.ts`):
  - `GitHubReviewPoster.post(run: Pick<ReviewerRun,'spec'>, findings, summary)` posts one `pulls/{n}/reviews` with
    `event: 'COMMENT'` and the reviewer token (fine-grained, **Pull requests: read and write**, RUNNER.md).
  - `findByMarker(spec, marker)` lists the PR's reviews and finds a body containing the marker.
  - `post` reads only `spec.remoteUrlNormalized`, `prNumber` and `headSha`.
  - **There is no issue-comment method.**
  - Server readiness for a repository: `reviewerGate(db, repoId)` + `pickReviewerWorkstation(db, gate, { ignoreBusy })`
    (`apps/server/src/review/reviewer-gate.ts`).
- **GWP-202 owner-pending** (`apps/server/src/commands/owner-pending.ts`):
  - `registerOwnerPending(ctx, tx, RegisterOwnerPending)` is idempotent per (kind, subject).
  - `resolveOwnerPending(ctx, tx, { kind, subjectId, reason: 'owner_acted' | 'closed', byUserId? })` also closes the
    reminder Desk item.
  - Kind `second_timeout` exists (`OWNER_PENDING_KINDS`). Nothing registers it yet.
  - The sweep only reminds. **The feature creates the first "timed out twice" item itself.**
- **GWP-205 settings:**
  - `SizeUnit = 'changed_lines' | 'changed_files'`, `sizeChecksStatus(settings)` and `diffSize` are in
    `packages/shared/src/projects/review-settings.ts`.
  - The server reads them with `reviewSettingsOf(row)` (`queries/misc.ts`).
- **Desk:** `closeItem` in `apps/server/src/commands/desk.ts` (~line 322) branches on `item.subkind`. That is where
  acknowledging or dismissing the "timed out twice" alert resolves the timer.
- **Rebuild:** `pr_review_polls` is an operational table in `rebuild.ts` `SAVED`.
- **Migrations:** the last one is `2960_pr_review_rerun.sql`, so this card uses `2970`.
- **No user-to-git-login mapping exists.** A PR author is a git host login, not necessarily a GuildWise user, so the
  only reliable way to reach them is a post on the PR.

### 2.2 Sum, or unique lines?

GitHub measures a PR's `additions`, `deletions` and `changedFiles` against the **merge base with that PR's own base
branch** (the "Files changed" tab). For a stacked PR B whose base is A's head branch, B's numbers cover only B's
commits. **Summing each member's own numbers therefore counts no line twice**, and it matches AC1 (300 + 400 = 700 >
600). For `changed_files` the members' `changedFiles` are summed, as the PRD's "added up" says. This is recorded as
decision 8.2.

## 3. Options

### 3.1 How "linked or stacked" is detected

| | A. Base-branch chain | B. Explicit link in the PR body | C. Both |
|---|---|---|---|
| Data | `head`, `base`, `isCrossRepository`, all on the poll | The PR body (untrusted, not fetched) | Both |
| Reliability | Stacking tools (git-town, Graphite, ghstack, `gh stack`) all set base = parent head | Free-text conventions vary | |
| Abuse | The author can only make a chain bigger | Easy to drop a link to stay under budget | |

**Choice: A.** PR B is stacked on PR A when `B.base == A.head` and A is not cross-repository. A chain is the
**connected group** of that relation among the repository's open PRs. Card-branch PRs neither count nor link.

### 3.2 Where the sizes come from

| | A. On the existing 5-minute poll, as a server snapshot | B. A new on-demand runner command | C. Local `git diff` |
|---|---|---|---|
| Extra git host calls | None (3 more JSON fields) | One per decision | Fetches of every member |
| Unrecorded chain members | Visible in the open list | Visible | Extra fetches |
| "Straight away" on timeout | Decides at once from the snapshot (5 minutes old at most) | Round trip plus a pending state | Slow |
| Gate before the first review | Same transaction as the recording | Extra state | Same |

**Choice: A.**

### 3.3 How the author is told (revised: A5)

| | A1. Issue comment | A2. Body-only `COMMENT` review via the existing poster | B. Desk item / push |
|---|---|---|---|
| Reaches an external author | Yes | Yes, in the PR conversation and by the author's GitHub notification | No (no login mapping) |
| Token permission | Needs `issues/comments` (GitHub accepts Pull requests: write for PR comments, but nothing here exercises it yet) | Exactly what the documented reviewer token does today | |
| Code reuse | New REST call, new marker lookup | `GitHubReviewPoster.post` + `findByMarker` unchanged in behaviour | |
| Can approve or block? | No | No (event hard-coded to `COMMENT`) | |

**Choice: A2.** The notice is one body-only `COMMENT` review per recorded member PR. It is posted with the comment-only
reviewer token and is idempotent through a hidden marker. It needs no wider token and no new poster code path. No Desk
item is created (AC2).

## 4. Design

### 4.1 Flow

```
scheduler: pollPrOnlyRepos (every 5 min)
  runner repo.list_prs → open PRs with changedLines (exists) + changedFiles, crossRepo, headSha  [new fields]
server applyPrListResult, same withAppendTx, after the existing events are appended:
  writeOpenChangeSnapshot(repo, changes, complete)                    [new, operational]
  evaluateRepoSizes(project, repo)                                    [new]
    per chain (sizeVerdict, pure):
      over      → PrReviewNeedsSplit for each recorded, open, not_reviewed member with no run in flight
                  + resolveTimedOutTwice(member, 'closed')
      within / inactive → PrReviewSplitCleared for members in needs_split
      unknown   → no change
  resolveTimedOutTwice(pr, 'closed') for each PrReviewClosed

scheduler: deliverSplitNotices                                        [new]
  pending → PrReviewSplitNoticeQueued + pr_review.notice → runner (reviewer token, body-only COMMENT review)
  ok → PrReviewSplitNoticePosted (author notified) | error → PrReviewSplitNoticeFailed (retry ≤ 3)

GWP-197 timeout (runner answer or server backstop), in the same tx right after PrReviewRunTimedOut:
  onPrReviewTimedOut(run)                                             [new]
    verdict = sizeVerdict(snapshot); second = isSecondTimeout(run)   (manual + rerun_of_run_id)
    timeoutFollowUp(second, verdict):
      needs_split   → PrReviewNeedsSplit {reason: timeout_over_budget | second_timeout_over_budget}
      owner_pending → Desk alert + registerOwnerPending('second_timeout') + PrReviewTimedOutTwice
      none          → nothing (AC3)
  after commit: requestPrList(repo, { force: true })
```

### 4.2 Shared (`packages/shared`)

**`src/review/pr-review.ts`:**

```ts
export const PR_REVIEW_STATES = ['not_reviewed', 'reviewed', 'needs_split'] as const;

// OpenChangeSchema gains OPTIONAL fields next to the existing changedLines, so an old runner's answer still parses
// (the missing values then count as unknown):
//   changedFiles: z.number().int().nonnegative().nullable().optional(),
//   crossRepo: z.boolean().optional(),
//   headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
```

- Adding `needs_split` is safe for the landed callers:
  - `manualReviewAction` refuses anything but `not_reviewed` (`not_eligible`), so a PR that needs splitting shows no
    Review now / Re-run button.
  - `startPrReviewRun` refuses it.
  - `listReviewEligiblePrs` and the queue drop it.
- Update the two `review_state` casts in `pr-review-runs.ts` (`manualActionOf`, `listPrReviews`) to `PrReviewState`.

**New `src/review/size-check.ts`** (pure functions, fully unit-tested, reused by GWP-210 and GWP-211):

```ts
export interface ChangeSize { changedLines: number | null; changedFiles: number | null }
export interface ChainCandidate { changeId: string; head: string; base: string; crossRepo: boolean;
                                  size: ChangeSize; excluded: boolean /* card branch */ }

/** The connected group of open PRs linked by base == other.head (other not cross-repo), containing changeId.
 *  Excluded PRs neither count nor link. Stable order: by changeId numerically. */
export function prChain(changeId: string, open: readonly ChainCandidate[]): ChainCandidate[];

/** Size of one PR in the project's unit; null when the git host did not report it. */
export function changeSize(s: ChangeSize, unit: SizeUnit): number | null;
// changed_lines → s.changedLines; changed_files → s.changedFiles

export type SizeVerdict =
  | { state: 'inactive'; reason: string }                          // sizeChecksStatus(settings) inactive
  | { state: 'unknown'; reason: 'not_listed' | 'no_size' }
  | { state: 'within' | 'over'; unit: SizeUnit; budget: number; total: number; complete: boolean;
      members: Array<{ changeId: string; size: number }> };

/** Over budget means total > budget (equal is within). A chain of one is a single PR. */
export function sizeVerdict(i: { settings: Partial<ReviewSettings> | null; changeId: string;
                                 open: readonly ChainCandidate[]; complete: boolean }): SizeVerdict;

/** Second timeout: this run timed out, the owner started it, and it is a re-run of a timed-out run
 *  (GWP-201 only sets rerunOfRunId when the latest run timed out). A third timeout counts as second again. */
export function isSecondTimeout(run: { state: string; trigger: 'auto' | 'manual'; rerunOfRunId: string | null }): boolean {
  return run.state === 'timed_out' && run.trigger === 'manual' && run.rerunOfRunId !== null;
}

export type TimeoutFollowUp = 'needs_split' | 'owner_pending' | 'none';
export function timeoutFollowUp(secondTimeout: boolean, v: SizeVerdict): TimeoutFollowUp {
  if (v.state === 'over') return 'needs_split';
  return secondTimeout ? 'owner_pending' : 'none';
}

export const SPLIT_REASONS = ['over_budget', 'timeout_over_budget', 'second_timeout_over_budget'] as const;
export const SPLIT_NOTICE_STATES = ['pending', 'queued', 'posted', 'failed'] as const;
export const PR_NOTICE_CAPABILITY = 'pr-notice:1';
export const SPLIT_NOTICE_MAX_ATTEMPTS = 3;
export const PR_TIMED_OUT_TWICE_SUBKIND = 'pr_review_timed_out_twice';
export const splitNoticeMarker = (noticeId: string) => `<!-- size-check:${noticeId} -->`;

/** The review body: neutral, names the chain and the numbers, no reviewer or model names, ends with the marker. */
export function splitNoticeBody(i: { unit: SizeUnit; budget: number; total: number;
  members: Array<{ changeId: string; size: number }>; self: string; noticeId: string }): string;
```

- `unknown` covers any chain member without a size, so a partial sum never gives a false "within". There is one
  exception: if the members that do have sizes are already over budget, the verdict is `over`.
- `isSecondTimeout` takes the timed-out run row itself. No history scan is needed, because `manualReviewAction`
  guarantees that `rerunOfRunId` is set only on a re-run of a timed-out run.

**Events** (next to `PrReviewRecorded` in `src/events/project.ts`, project stream):

- `PrReviewNeedsSplit { projectId, repoId, prReviewId, checkId, reason, unit, budget, total, members: [{changeId,
  size}], runId?, noticeId }`. Sets `review_state='needs_split'` and creates a `pending` notice row.
- `PrReviewSplitCleared { projectId, repoId, prReviewId, checkId, verdict: 'within' | 'inactive', total?, budget? }`.
  Sets `review_state='not_reviewed'` and clears `attention`.
- `PrReviewSplitNoticeQueued { projectId, prReviewId, noticeId, workstationId, attempt }`
- `PrReviewSplitNoticePosted { projectId, prReviewId, noticeId, reviewUrl, alreadyPosted }`
- `PrReviewSplitNoticeFailed { projectId, prReviewId, noticeId, code, error, retryable }`
- `PrReviewTimedOutTwice { projectId, repoId, prReviewId, runId, verdict: 'within' | 'inactive' | 'unknown', total?,
  budget?, unit?, deskItemId, timerId }`. Sets `pr_reviews.attention='timed_out_twice'`. The state stays
  `not_reviewed`.
- `PrReviewAttentionCleared { projectId, prReviewId, reason }`. Clears `attention`. It is appended by
  `resolveTimedOutTwice`.

**Protocol** (`src/protocol/runner.ts`, `CommandPayloadSchemas`): add a new command `pr_review.notice`.

```ts
PrReviewNoticePayloadSchema = z.object({ noticeId: z.uuid(), projectRepoId: z.uuid(),
  remoteUrlNormalized: z.string().max(500), prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(), body: z.string().max(5000) }).strict();
PrReviewNoticeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), reviewUrl: z.string().max(500), alreadyPosted: z.boolean() }),
  z.object({ ok: z.literal(false),
             code: z.enum(['no_token','unsupported','unreachable','forbidden','not_found','error']),
             error: z.string().max(400) }) ]);
```

**DTO** (`PrReviewDtoSchema`): `state` now includes `needs_split`. Add these optional fields:
- `size: { state, total?, budget?, unit?, members?, complete?, reason? } | null`, the live verdict from the snapshot
- `split: { reason, total, budget, unit, members, at, notice: { state, postedAt, url, error } } | null`
- `attention: 'timed_out_twice' | null`
- `reminder: { dueAt, remindedAt } | null`, from the open `owner_pending_timers` row (`kind='second_timeout'`)

### 4.3 Data model: `apps/server/migrations/2970_pr_size_check.sql`

```sql
-- PR size check (needs split) and the "timed out twice" mark. pr_reviews columns and pr_split_notices: projections of
-- PrReviewNeedsSplit / PrReviewSplitCleared / PrReviewSplitNotice* / PrReviewTimedOutTwice / PrReviewAttentionCleared.
-- pr_open_changes: operational snapshot of the latest open pull request list per repository. No foreign keys.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_reason text;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_at timestamptz;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_total integer;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_budget integer;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_unit text;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS split_members jsonb;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS attention text;            -- 'timed_out_twice' | NULL
CREATE TABLE IF NOT EXISTS pr_split_notices (
  id uuid PRIMARY KEY, pr_review_id uuid NOT NULL, project_id uuid NOT NULL, check_id uuid NOT NULL,
  state text NOT NULL,              -- pending | queued | posted | failed
  attempts integer NOT NULL DEFAULT 0, workstation_id uuid, queued_at timestamptz,
  review_url text, error_code text, error text, retryable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL, posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS pr_split_notices_open ON pr_split_notices (state) WHERE state IN ('pending','queued','failed');
CREATE TABLE IF NOT EXISTS pr_open_changes (
  project_repo_id uuid NOT NULL, change_id text NOT NULL,
  head_branch text NOT NULL, base_branch text NOT NULL, cross_repo boolean NOT NULL DEFAULT false,
  head_sha text, changed_lines integer, changed_files integer,   -- NULL: not reported (old runner), size unknown
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (project_repo_id, change_id)
);
ALTER TABLE pr_review_polls ADD COLUMN IF NOT EXISTS complete boolean;
```

- Add `pr_split_notices` to `PROJECTION_TABLES`. Add `pr_open_changes` to `rebuild.ts` `SAVED` with `restoreWhere:
  'project_repo_id IN (SELECT id FROM project_repos)'`, like `pr_review_polls`.
- The chain always reads the **live** `pr_open_changes`, not `pr_reviews.head_branch/base_branch` (those are written
  once), so a retargeted PR is handled correctly. `pr_reviews.changed_lines` (GWP-198) stays as it is. The snapshot is
  still needed for unrecorded chain members, `changedFiles` and `crossRepo`.

### 4.4 Server (`apps/server`)

**New `src/commands/pr-size-check.ts`:**

- **`writeOpenChangeSnapshot(tx, repoId, changes, complete, now)`:** upserts every listed change. When the list is
  complete, it also deletes the repository's rows that are not listed. It sets `pr_review_polls.complete`.
- **`loadSizeContext(tx, projectId, repoId)`:** reads `reviewSettingsOf(project row)`, the snapshot as
  `ChainCandidate[]` (`excluded` = head is a card branch, the same set `applyPrListResult` builds), and `complete`.
- **`evaluateRepoSizes(ctx, tx, projectId, repoId)`:** runs once per recorded open PR of the repository whose state is
  `not_reviewed` or `needs_split`.
  - Skip a PR whose latest first-reviewer run is `running` or `completed` (post pending). That run decides, and the
    next poll re-evaluates the PR.
  - A chain is decided once and applied to every recorded member, so AC1 marks both PRs.
  - `over` + `not_reviewed`: append `PrReviewNeedsSplit { reason: 'over_budget' }` with a fresh `noticeId`, then call
    `resolveTimedOutTwice(member, 'closed')`.
  - `within` / `inactive` + `needs_split`: append `PrReviewSplitCleared`.
  - `unknown`: no change.
  - **No Desk item and no owner notification (AC2).**
- **`onPrReviewTimedOut(ctx, tx, run)`:** GWP-197 calls this right after it appends `PrReviewRunTimedOut`, in the same
  transaction, in both `applyPrReviewRunResult` (`r.outcome === 'timeout'` branch) and `sweepStalePrReviewRuns`
  (`run.state === 'running'` branch only, not the post-stage failure). Replay runs never reach either call site,
  because both functions branch replays off first.
  1. Lock the `pr_reviews` row. If it is closed or not `not_reviewed`, return.
  2. Compute `verdict` from the snapshot. Compute `second = isSecondTimeout({ state: 'timed_out', trigger:
     run.trigger, rerunOfRunId: run.rerun_of_run_id })`. Both are already on the locked `run` row
     (`SELECT * FROM pr_review_runs`).
  3. Act on `timeoutFollowUp(second, verdict)`:
     - `needs_split`: append `PrReviewNeedsSplit { reason: second ? 'second_timeout_over_budget' :
       'timeout_over_budget', runId }` for every recorded member, as the poll rule does. (AC4, and the first timeout
       over budget.)
     - `owner_pending`:
       - Create a Desk alert to the project owner (`project_members.role='owner'`, as `pollPrOnlyRepos` finds it):
         - `kind 'alert'`, `subkind PR_TIMED_OUT_TWICE_SUBKIND`
         - title `PR #<n> timed out twice: <title>` (sliced to 280)
         - a body with the size result ("within the size budget: 420 of 600 changed lines" / "size check inactive: no
           size budget set" / "size could not be measured")
         - `subjectKey 'pr-timed-out-twice:<prReviewId>'`
         - `data { prReviewId, changeId, url: '/p/<KEY>/pull-requests#pr-<changeId>' }`
       - If that alert is already open, reuse it.
       - Call `registerOwnerPending(ctx, tx, { kind: 'second_timeout', orgId, projectId, subjectId: prReviewId,
         ownerUserId, title: 'PR #<n>: <title>', url, startedAt: now })`. It is idempotent.
       - Append `PrReviewTimedOutTwice`.
       - The state is **not** changed (AC5).
     - `none`: nothing (AC3).
  4. Return `{ repoId }`. After the commit, the caller runs `requestPrList(ctx, repoId, { force: true })`.
  - No network calls. Data gaps become `unknown`, never a throw.
- **`deliverSplitNotices(ctx)`** (scheduler):
  - Picks these notices:
    - `pending`
    - `failed` with `retryable`, `attempts < SPLIT_NOTICE_MAX_ATTEMPTS` and `queued_at` older than 15 minutes
    - `queued` and older than 15 minutes (lost command)
  - Readiness: `reviewerGate(db, repoId)` must be `ready`, then `pickReviewerWorkstation(db, gate, { ignoreBusy: true
    })`, plus `PR_NOTICE_CAPABILITY` on that workstation. If none is ready, the notice stays `pending` and the PR row
    shows why.
  - For each notice: append `PrReviewSplitNoticeQueued`, then enqueue `pr_review.notice` (`headSha` from the
    snapshot, `body: splitNoticeBody(...)`), then `deliverPending`.
  - Skip simulation orgs.
  - Drop a notice whose PR has left `needs_split` or closed before it was posted.
- **`applySplitNoticeResult(ctx, payload, ok, result, error)`:** appends `PrReviewSplitNoticePosted` or
  `PrReviewSplitNoticeFailed`. `retryable` is false for `forbidden`, `not_found` and `unsupported`.
- **`resolveTimedOutTwice(ctx, tx, prReviewId, reason, byUserId?)`:**
  - `resolveOwnerPending(ctx, tx, { kind: 'second_timeout', subjectId: prReviewId, reason, byUserId })`.
  - Close the open `pr_review_timed_out_twice` alert (`DeskItemResolved`, `acknowledged`).
  - Append `PrReviewAttentionCleared` if `attention` is set.
  - It is a no-op when nothing is open. It is called:
    - in `triggerPrReview` inside its transaction when `r.started`, with `owner_acted`, `user.id` (the owner
      re-ran it)
    - in `closeItem` (`commands/desk.ts`) for subkind `pr_review_timed_out_twice`, with `owner_acted` (the owner
      decided to leave it). The item close itself is done by `closeItem`, so skip the alert close there.
    - from `applyPrListResult` for each `PrReviewClosed`, with `closed`
    - on `PrReviewNeedsSplit`, with `closed`

**Other server changes:**

- `commands/pr-only.ts`:
  - In `applyPrListResult`, after the existing `ctx.store.append(events, { tx })` and still inside the transaction:
    `writeOpenChangeSnapshot`, then `resolveTimedOutTwice` for each closed PR, then `evaluateRepoSizes`. This happens
    only on the `ok` path, after the PR-only check.
  - Give `requestPrList` an option `{ force?: boolean }` that skips the 5-minute throttle (a pending request is still
    honoured).
- `commands/pr-review-runs.ts`: the two `onPrReviewTimedOut` call sites. In `applyPrReviewRunResult` and
  `sweepStalePrReviewRuns`, the post-commit `requestPrList(..., { force: true })`. Also the `triggerPrReview` call to
  `resolveTimedOutTwice`, and the `PrReviewState` casts.
- `runner-gateway/handlers.ts`: a terminal branch for `pr_review.notice` next to `pr_review.post`.
- `scheduler/scheduler.ts`: `deliverSplitNotices(ctx).catch(log)` after `pollPrOnlyRepos`.
- **New** `projections/pr-size-check.ts` for the seven events. Register it in `projections/index.ts`.
- `listPrReviews`: add `size` (live `sizeVerdict` per PR from one snapshot read per repository), `split`, `attention`
  and `reminder`.
- **Do not touch** card, shift, dispatcher-claim or transition code, or the card needs-split path (`design-size.ts`,
  GWP-208).

### 4.5 Runner (`apps/runner`)

- `forge/github.ts` `listOpenChanges`:
  - Add `changedFiles,isCrossRepository,headRefOid` to `--json` (all valid `gh pr list` fields; `headRefOid` is
    already used by `listMergedChanges`).
  - Map them to `changedFiles`, `crossRepo` and `headSha`, next to the existing `changedLines`. A missing field means
    the value is absent, which is not an error.
  - Extend `GhPr` with these fields.
- `review/review-poster.ts`: loosen the `post` and `findByMarker` parameter types to `Pick<ReviewerRunSpec,
  'remoteUrlNormalized' | 'prNumber'> & { headSha?: string }`. When `headSha` is absent, `post` omits `commit_id`,
  and GitHub then uses the head. No change in behaviour for existing callers.
- **New** `review/notice.ts`, `postPrNotice(deps: { poster }, payload)`:
  - Call `findByMarker(spec, splitNoticeMarker(noticeId))`. A hit gives `alreadyPosted: true`.
  - Otherwise call `poster.post({ spec }, [], body)`, a body-only `COMMENT` review.
  - Error mapping is the same as `postPrReview` (`stale_head` is not used; a 422 maps to `error`).
  - It never uses `gh` or the user's git login.
- `runner.ts`: announce `PR_NOTICE_CAPABILITY`, add the `pr_review.notice` branch next to `pr_review.post` (line
  ~2343), and dedupe by `noticeId` while a post is live. Never log a token.

### 4.6 Web (`apps/web`)

These changes are on `src/components/pull-requests/PullRequestsPage.tsx` (row) and `src/api/queries/pr-reviews.ts`:
- A **Needs split** badge (amber, with text and an icon, not colour alone).
- Detail line: "Over the size budget: 700 of 600 changed lines (stacked with #12, #13). Sent back to the author to
  split." Notice state: "Author notified <time> · View", "Notifying the author…", or "Author not notified: <error>"
  (`data-testid="pr-split-notice-<changeId>"`).
- Size where known: "Size 420 of 600 changed lines", "Size check inactive: no size budget set", or "Size unknown
  (update the runner on <workstation>)".
- `attention='timed_out_twice'`: "Timed out twice. Within the size budget, so it waits for your decision: re-run the
  review or leave it." Add "Reminder <dueAt>" or "Reminder sent <time>" (`data-testid="pr-timed-out-twice-<changeId>"`).
  The re-run button is GWP-201's `PrReviewTriggerButton`.
- All devices, including touch: no hover-only information, tap targets of at least 44 px, rows wrap at 320 px, and no
  text input.

### 4.7 Docs

- `docs/USER-GUIDE.md`: a new subsection **Size check and needs split** after the PR-only review points (around line
  605). It covers:
  - The size check uses the project's budget and unit, and is inactive until both are set.
  - Stacked PRs (a PR whose base is another open PR's branch) are measured together. Each PR counts only its own
    changes.
  - Over budget means needs split: no review, and a comment review on each PR asks the author to split it. No owner
    action is needed.
  - Back within the budget means the PR is reviewed again.
  - A timeout never sends a PR back on its own.
  - A re-run that times out again within the budget gives the owner a "timed out twice" item, with a reminder after 2
    working days.
- `docs/RUNNER.md`: one line next to the reviewer-token section on `pr_review.notice` and `pr-notice:1`. It says the
  notice uses the same reviewer token (Pull requests: read and write), and lists the extra `gh pr list` fields.

## 5. Acceptance criteria mapped to design and tests

All tests go in **new files**. The "fake git host" is a `repo.list_prs` result fed to `applyPrListResult` with chosen
`changedLines`/`changedFiles`, plus a stubbed `pr_review.notice` answer. Timeouts are driven through
`applyPrReviewRunResult` (`outcome: 'timeout'`) and `sweepStalePrReviewRuns`.

| AC | Design | Test |
|---|---|---|
| AC1: stacked 300 + 400, budget 600: both needs-split, author notified | `prChain`, `sizeVerdict` 700 > 600, `evaluateRepoSizes` marks each member, one notice each → `PrReviewSplitNoticePosted` | shared `packages/shared/test/pr-size-check.test.ts` (chain, sum, 600 = within, unknown member, cross-repo parent ignored, card branch excluded, files unit); server `apps/server/test/pr-size-check-chain.test.ts` |
| AC2: single PR over budget: needs-split, author notified, no owner desk item | Same path, chain of one | server `apps/server/test/pr-size-check-single.test.ts` (`desk_items` count unchanged; notice posted; `PrReviewSplitCleared` after a smaller list; inactive without a budget) |
| AC3: first timeout within budget: not reviewed, not sent back | `timeoutFollowUp(false, within) = 'none'` | server `apps/server/test/pr-size-check-timeout.test.ts`; shared `timeoutFollowUp` / `isSecondTimeout` tables |
| AC4: second timeout after owner re-run, over budget: needs-split at once | `isSecondTimeout` (manual + `rerun_of_run_id`) + `over` → `PrReviewNeedsSplit { second_timeout_over_budget }` in the timeout tx | same server file: auto run times out, `triggerPrReview` re-run, timeout → `needs_split` with no poll in between; also via the server backstop |
| AC5: second timeout within budget: stays not reviewed, owner item with the reminder rule | Desk alert + `registerOwnerPending('second_timeout')` + `PrReviewTimedOutTwice` | same server file: state `not_reviewed`, alert open, timer `dueAt = addWorkingDays(now, 2, tz)`; `ownerPendingSweep` after 2 working days → reminder, state unchanged; closing the alert resolves the timer |

- Runner tests:
  - `apps/runner/test/forge-list-prs-size.test.ts`: the new fields map; missing fields leave the values absent.
  - `apps/runner/test/pr-notice.test.ts`: a marker hit means no POST; otherwise one `pulls/{n}/reviews` POST with
    `event: 'COMMENT'` and no `comments`; a 403 gives `forbidden`.
- Web test: `apps/web/src/test/pull-requests-size.test.tsx`.
- The server tests need the test DB (Postgres 5433). If it is down, name them for the testers.

## 6. Risks

- **No reviewer token or no ready workstation:** the PR is still `needs_split`, but the author is not told. The row
  shows it, with up to 3 retries. The size decision never waits on posting.
- **More than 200 open PRs (`complete: false`):** `over` still stands, `within` shows "list incomplete", and snapshot
  rows are not deleted.
- **Flapping while the author pushes:** the state changes only when the verdict changes. Re-entering `needs_split`
  posts again with a new `noticeId`.
- **The same transaction as the timeout:** a bug would roll back the timeout record. `onPrReviewTimedOut` makes no
  network calls and never throws on data gaps. Tests cover both call sites.
- **A COMMENT review counts as a "review" on GitHub:** it never approves or blocks. If a repository's branch rules
  count reviews, a COMMENT review does not satisfy "approving reviews".

## 7. Out of scope

- The CI status check (GWP-211).
- Size exceptions (GWP-210). `sizeVerdict` stays pure so that GWP-210 can wrap it.
- The architect's size estimate and card needs-split (GWP-208).
- The manual trigger UI (GWP-201).
- Explicit "depends on #n" links.

## 8. Decisions recorded

1. Linked/stacked = base-branch chain among open PRs (B.base == A.head, A not from a fork), as a connected group. No
   body parsing.
2. The chain sum is the sum of each member's own size as the git host measures it. For files, `changedFiles` is summed.
3. Over budget means total > budget.
4. The check runs on every poll (the gate before the first review) and at once on every timeout. Only `over` sends a
   PR back.
5. The author is told by a body-only `COMMENT` review on each recorded member PR, posted with the reviewer token. There
   is no Desk item for needs-split.
6. A second timeout with an inactive or unknown size check still gives the owner the item, and its text says why.
7. Back within budget (or the budget removed) returns the PR to `not_reviewed`.
8. Second timeout = a timed-out run with `trigger 'manual'` and `rerun_of_run_id` set.

## 9. Assumptions, checked against `main` (2026-11-14)

| # | Assumption | Status | Evidence / change |
|---|---|---|---|
| A1 | Eligibility is `review_state='not_reviewed'`; `applyPrListResult` is the single place the open list is applied | Holds | `listReviewEligiblePrs`, `startPrReviewRun`, `manualReviewAction` all require `not_reviewed`; `applyPrListResult` is called only from `handlers.ts`. It now also emits `PrReviewSizeChanged`, so the hook goes after its append |
| A2 | `gh pr list --json` accepts the extra fields | Holds | `additions,deletions` are already listed (mapped to `changedLines`); only `changedFiles,isCrossRepository,headRefOid` are added. The snapshot uses `changed_lines` instead of additions/deletions |
| A3 | Timeout recorded in `applyPrReviewRunResult` and `sweepStalePrReviewRuns` inside a transaction; runs have `state`, `reviewer`, `started_at` | Holds | Both inside `withAppendTx`; replay runs branch off first |
| A4 | GWP-201 records who started a run, and has one owner command | Holds | `trigger 'auto' \| 'manual'` + `rerun_of_run_id`, `triggerPrReview`. `isSecondTimeout` now reads those (no `'owner'` value) |
| A5 | The comment-only poster can also post an issue comment | **Does not hold** | `GitHubReviewPoster` only posts `pulls/{n}/reviews` (`COMMENT`). The notice is posted as a body-only `COMMENT` review via `post` + `findByMarker` (types loosened); readiness = `reviewerGate` + `pickReviewerWorkstation` |
| A6 | `registerOwnerPending`/`resolveOwnerPending`, kind `second_timeout`; the timer does not create the first item | Holds | `owner-pending.ts`; the sweep only reminds; nothing registers `second_timeout` yet |
| A7 | `reviewSettingsOf`, `sizeChecksStatus`, `SizeUnit` | Holds | Unchanged on `main` |
| A8 | The Pull requests page and `PrReviewDto` exist and can be extended | Holds | `components/pull-requests/PullRequestsPage.tsx`, `PrReviewDtoSchema` |
