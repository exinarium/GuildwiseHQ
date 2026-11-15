# GWP-197 First reviewer (Sonnet) reviews PR-only PRs, with a 10-minute timeout and no partial comments

Design for the first reviewer run on PR-only repositories (PRD "Review Gates & Reviewer Workflow" v22, F1, rewritten
F1.6). It builds on GWP-195 (PR-only switch, `pr_reviews` table) and GWP-196 (read-only checkout, comment-only token).
Both have now landed on the working branch. Section 0 checks this design's assumptions against the landed code, and the
sections below have been updated to match it.

## 0. Assumption review against the landed code (revision 1)

| # | Assumption | Verdict | What landed, and what changed in this design |
|---|---|---|---|
| A1 | GWP-196 gives a checkout call `→ { dir, headSha, baseSha, cleanup }` with the base commit available | **Did not hold** | The call is `prepareReviewerRun(deps, spec)` (`apps/runner/src/review/reviewer-sandbox.ts`). It returns `ReviewerRun { spec, runDir, checkout, sandbox }` or `{ refused }`, and `disposeReviewerRun(run)` cleans up. It builds the run's own sandbox: home, scratch and tmp. The base commit is available as `refs/review/base` in a standalone read-only repository. **But `ReviewerRunSpec` needs `headSha`, `baseSha`, `prNumber` and `baseRef`, and the server has no SHAs**: `pr_reviews` and `OpenChangeSchema` store only branch names, and known PRs are never updated. The checkout throws `ReviewHeadMovedError` if the head it fetches is not `spec.headSha`. GWP-196 also gives the reviewer's Claude settings (`reviewerPolicy(run, base)`: offline, cwd read-only), but `adapter.startChat` cannot take them today. **Changes:** the runner looks up the head and base SHAs right before the checkout (section 4.5 step 2, a new read-only `Forge.changeHeads`). The run payload carries `prNumber` and `baseRef` instead of SHAs. `startChat` gets an optional `reviewRun` input, so Claude Code uses `reviewerPolicy` instead of the chat settings. Each run uses its own config dir. Refusals and the head-moved case get result codes. The completed result returns `baseSha` too. |
| A2 | GWP-196 gives a way to post with the comment-only token; the token never reaches the server, model or logs | **Partly held** | `GitHubReviewPoster.post({ spec }, findings, summary)` (`review-poster.ts`) exists. It makes one `COMMENT` review with `commit_id = headSha`, takes the token from the sealed store only, and redacts errors. It builds the review body itself: findings without a `line` go into the body. If GitHub answers 422 it tries once more with everything in the body. Each call is atomic, so this still never leaves partial comments. **What it lacks:** an idempotency check (listing existing reviews). It also takes `ReviewFinding` (strict: no severity, no id). **Changes:** `pr_review.post` sends a `ReviewerRunSpec`, a summary that ends with the run marker, and `ReviewFinding[]`. Severity goes into the title, and non-anchored findings are sent **without** `line`. The server's `buildReviewPost` shrinks to choosing findings and building the summary. The poster gets one new method, `findByMarker`, so a resent post command does not post twice. |
| A3 | The server can check "no token, no run" before dispatch, and GWP-196 shows the reason | Held | `reviewerGate(db, repoId)` and `listReviewablePrs(db, projectId)` (`apps/server/src/review/reviewer-gate.ts`) give the PRs whose repo is `ready`, plus the `workstationIds` that hold the token. The repo DTO shows `reviewerToken: 'present' | 'missing'`. **Name only:** the dispatcher takes work from `listReviewablePrs`, never from `listReviewEligiblePrs` directly, and calls `reviewerGate` again right before it enqueues. |
| A4 | GWP-195 lands as designed | Held | `pr_reviews` has the columns this design expected. So do `PR_REVIEW_STATES = ['not_reviewed']` in `packages/shared/src/review/pr-review.ts`, `listReviewEligiblePrs` (`apps/server/src/commands/pr-only.ts`), the repo DTO `prOnly`, migration `2900_pr_only_review.sql`, and the GitHub-only `gh pr list`. Follow-on from GWP-196: `2910_reviewer_token.sql` is now the highest migration, so this card's migration becomes **`2920_pr_review_runs.sql`**. The migrator would also apply 2901, but the project convention is to number above the highest. |
| A5 | The comment-only token can create a PR review with inline comments | Held | GWP-196 documents a fine-grained token with "Pull requests: read and write" on a Read-role bot account, and the poster sends `comments[]` to `/pulls/{n}/reviews`. |

Everything else in the design stands: option B for both choices, the server as the only party that starts a post,
"timeout or failure = one event", the data model, the web tab and the AC mapping.

## 1. Question

1. Where does a reviewer run execute, and how is its 10-minute timeout enforced so that a timed-out run can never post
   anything (requirements 2 and 3, AC2)?
2. How are findings buffered and posted so that a completed run posts all of them and a failed or timed-out run posts
   none (requirements 1 and 3, AC1, AC2, AC4)?
3. Where do "reviewed" / "not reviewed", the reviewer and the run time live, and how does the owner see them, including
   an error (requirement 5, AC1, AC4)?
4. How do we make sure a timeout sends nothing back and starts no needs-split (requirement 4, AC3)?

The planner left three points open. This design settles them:
- **Where the timer runs.** In the runner, around the whole run. The server also has a backstop sweep (section 4.4).
- **Whether "not reviewed" is a PR field or a run outcome.** It is the PR field `pr_reviews.review_state`. Each run has
  its own outcome in `pr_review_runs.state`.
- **What the owner sees on a model error.** The error shows on the PR row on the project's new Pull requests tab
  (section 4.6). No desk item is created. The PRD's 2-working-day reminder for owner-pending items belongs to a later
  card.

## 2. Findings

### 2.1 What exists

- **No PR review run yet.** The "reviewed" hits in `queries/cards.ts` and `projections/cards.ts` are about card design
  review. Leave them alone.
- **The delegate runner already does an isolated, read-only, headless run with a timer**
  (`apps/runner/src/delegate/delegate.ts` ~380-525):
  - `adapter.startChat({ readOnly: true, ... })` starts the session.
  - A `setTimeout(...)` calls `session.stop('delegate.timeout')`.
  - `readSession(session, ...)` (~1111, not exported) collects the final text and how the session exited.
  - The outcome is one of `ok | timeout | failed | cancelled`, with `authFailed` / `usageLimit` on the exit.
  - This is the template for the reviewer run's timer and result handling.
- **GWP-196 (landed)** (`apps/runner/src/review/`):
  - `prepareReviewerRun(deps, spec)` refuses with `reviewer_token_missing`, `unsupported_host`, `sandbox_unavailable`
    or `no_clone` before it creates anything.
  - It fetches `refs/pull/<n>/head` into the owner's clone under a private ref, using the clone's own login. It throws
    `ReviewHeadMovedError` if that head is not `spec.headSha`, and fetches `baseRef` if `baseSha` is missing.
  - It then builds a standalone repository with no remote, `refs/review/head` and `refs/review/base`, detached at the
    head, and removes the write bit from the whole tree. The run also gets its own home, scratch and tmp.
  - `disposeReviewerRun` cleans up. `sweepReviewRuns` runs at startup.
  - `reviewerPolicy(run, base)` gives the Claude Code settings: reviewer role, cwd = checkout (read-only), no git dirs,
    no extra dirs, `offline`. `reviewerPermissions()` allows read and shell only, with `mayCommit: false`.
  - `GitHubReviewPoster` and `ReviewPostError` (codes `reviewer_token_missing`, `unsupported_host`, `rejected` with an
    HTTP status, `unreachable`).
  - `runner.reviewerTokens` (`FileReviewerTokenStore`).
  - On the server: `reviewerGate`, `listReviewablePrs`, and `workstation_repos.reviewer_token`.
  - Nothing calls `prepareReviewerRun`, `reviewerPolicy` or the poster yet. This card wires them.
- **Claude Code chat settings:** `ClaudeCodeAdapter.startChatSession` (`adapters/claude-code.ts` ~1037) picks
  devops, ceo, work or `buildChatSettings(readOnly, ...)`, then writes `settings.json` into `sandbox.configDir`. There
  is no way to pass different settings in. A shared config dir would also mean two concurrent runs overwrite each
  other's `settings.json`.
- **The model is chosen by `{ runtime: 'claude-code', model: 'sonnet' }`** (`MODEL_CHOICES`). The mock runtime exists,
  and `realClaudeBlocked()` refuses real Claude under vitest.
- **Server to runner commands:**
  - `enqueueRunnerCommand(db, workstationId, type, payload)` queues a command. The runner runs each command
    concurrently and answers with `command.result`, which `applyCommandResult` (`runner-gateway/handlers.ts`) applies.
  - **Trap:** `requeueSentCommands` sends a "sent" command again after a reconnect, so the runner must dedupe. This
    also applies to the post command after it has already posted.
- **Server sweeps** run in `Scheduler.run()` (`apps/server/src/scheduler/scheduler.ts`) every 15 s.
- **PR listing** (`apps/runner/src/forge/github.ts` ~158): `gh pr list --json number,url,title,author,headRefName,baseRefName,createdAt`.
  It has no SHAs. `changeState` (~235) shows the `gh pr view --json ...` pattern.
- **Project view:** Board and Backlog tabs (`ProjectTabs.tsx`, `router.tsx` ~123). There is no PR list.

### 2.2 PRD sub-items F1.2a and following

The project vault copy of v22 (`projects/gwp/docs/review-gates-reviewer-workflow.md`) holds F1 only as edit
instructions. The sub-item texts are not in it. Mapped from the text that is there:

| PRD item | Where it is covered |
|---|---|
| F1.6 (rewritten): timeout posts no partial comments, PR "not reviewed" | AC2 (this card) |
| F1.6: timeout on a PR within budget does not send the card back; needs-split only after the size check | AC3 (this card); the size check is GWP-209 |
| Non-goal "No partial comments from a timed-out run" | AC2, AC4 (this card) |
| Non-goal "The reviewer has no write access" | GWP-196; kept here by `reviewerPolicy` (section 4.5) |
| Boardroom: Sonnet first, 10-minute timeout | Requirements 1 and 2, AC1, AC2 |
| F1.4 daily cap of 20 | GWP-200 |
| F1.5 manual trigger / second timeout | GWP-201, GWP-209 |
| F2 findings cap, useful/noise marks | GWP-198, GWP-199 (findings are kept as a stored list for them) |

**The BA should attach the v22 sub-item texts before review.** If one of them asks for more than AC1 to AC4, it needs
its own AC.

## 3. Options

### 3.1 Where the run executes

| | A. A new shift kind `pr_review` | B. A runner command `pr_review.run`, modelled on the delegate run | C. A server-side model call |
|---|---|---|---|
| Read-only checkout on the workstation (GWP-196) | Yes | Yes | No: code would leave the workstation |
| Model chosen per run (Sonnet now, Opus in GWP-204) | Needs a hired agent per model; brief, IPC token and `aom` contract do not fit | Per call | Yes |
| Reuse by the 20-PR replay (GWP-203) | Hard | `runPrReview()` returns findings and posts nothing | Yes |
| Timeout | Whole minutes, reaper late | Precise timer | Yes |
| Standing order: no user data and no runners on the server | Yes | Yes | **No** |

**Choice: B.**

### 3.2 Who posts, and when

| | A. The runner runs and posts in one command | B. `pr_review.run` returns findings; the server stores them, then sends `pr_review.post` |
|---|---|---|
| A timed-out or failed run posts nothing | Yes, if the runner is right | Yes. Also **only the server can start a post**, so a late result after the server backstop can never post |
| Findings cap (GWP-198) / merge with Opus (GWP-204) | Hard | The server chooses what to post |
| Replay (GWP-203) | Needs a "do not post" flag | `pr_review.run` never posts |

**Choice: B.**

### 3.3 How findings are posted

One GitHub pull request review (`event: COMMENT`) holding every inline comment, through GWP-196's
`GitHubReviewPoster`. One call creates all comments or none. The poster's 422 retry is a second complete call, made
only after the first one created nothing.

### 3.4 Where the head and base SHAs come from (new, A1)

| | A. The runner looks them up right before the checkout | B. Store them on `pr_reviews` from the PR list poll |
|---|---|---|
| Fresh | Yes: read seconds before the fetch | Stale: GWP-195 never updates known PRs, so it needs a new "head moved" event and changes to `applyPrListResult` |
| Code touched | One read-only `Forge.changeHeads` (GitHub `gh pr view --json headRefOid,baseRefOid`) | `OpenChangeSchema`, the `gh pr list` fields, events, projection, GWP-195's apply code |
| Which commit was reviewed | Returned in the result and stored on the run | The same |

**Choice: A.** GWP-196's `ReviewerRunSpecSchema` stays as it is. The runner builds and validates the spec locally.

## 4. Design

### 4.1 Flow

```
scheduler pass (15 s)
  └─ dispatchPrReviews: listReviewablePrs (GWP-196 gate) → PR with no 'first' run yet → reviewerGate re-check
       └─ PrReviewRunStarted (run row 'running')  +  enqueue pr_review.run → one of the gate's workstations
runner: runPrReview()  [10-minute timer around the whole run; never posts]
  changeHeads → ReviewerRunSpec → prepareReviewerRun (GWP-196) → git diff → reviewer-policy Sonnet session → parse
  → command.result { outcome: completed | timeout | failed }
server applyPrReviewRunResult
  completed → PrReviewRunCompleted (findings stored, run 'completed')  +  enqueue pr_review.post (same workstation)
  timeout   → PrReviewRunTimedOut  (run 'timed_out'; PR stays not_reviewed; nothing else)
  failed    → PrReviewRunFailed    (run 'failed', error kept; PR stays not_reviewed; nothing else)
runner: postPrReview()  [findByMarker, then GitHubReviewPoster.post (GWP-196)]
server applyPrReviewPostResult
  ok    → PrReviewPosted  (PR review_state 'reviewed', reviewed_by, reviewed_at, run 'posted')
  error → PrReviewRunFailed { stage: 'post' } (PR stays not_reviewed, error kept)
scheduler pass: sweepStalePrReviewRuns
  'running' past timeout + 5 min grace → PrReviewRunTimedOut { by: 'server' } (late result ignored)
```

The PR is `reviewed` only after the comments really exist on GitHub (AC1).

### 4.2 Shared (`packages/shared`)

Extend `src/review/pr-review.ts` (GWP-195). Reuse `ReviewerRunSpecSchema` and `ReviewFindingSchema` from
`src/review/reviewer-run.ts` (GWP-196).

```ts
export const PR_REVIEW_STATES = ['not_reviewed', 'reviewed'] as const;   // GWP-209 adds 'needs_split'
export const PR_REVIEWERS = ['first'] as const;                          // GWP-204 adds 'second'
export type PrReviewer = (typeof PR_REVIEWERS)[number];
export const PrReviewerSchema = z.enum(PR_REVIEWERS);
/** Boardroom: the first run uses the smaller model. */
export const REVIEWER_MODEL: Record<PrReviewer, { runtime: string; model: string }> = {
  first: { runtime: 'claude-code', model: 'sonnet' },
};
export const PR_REVIEW_TIMEOUT_MS = 10 * 60_000;
export const PR_REVIEW_CAPABILITY = 'pr-review:1';

export const PR_REVIEW_RUN_STATES = ['running', 'completed', 'posted', 'timed_out', 'failed'] as const;
export const PrReviewRunStateSchema = z.enum(PR_REVIEW_RUN_STATES);

/** What the model writes (validated on the runner). */
export const ReviewerFindingSchema = z.object({
  path: z.string().min(1).max(500),
  line: z.number().int().positive().nullable(),       // a line in the new file; null = about the file or the PR
  severity: z.enum(['high', 'medium', 'low']),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});
export const ReviewerOutputSchema = z.object({
  summary: z.string().max(2000),
  findings: z.array(ReviewerFindingSchema).max(50),
});
/** `anchored` = the line is in a diff hunk (right side), so GitHub accepts it inline. */
export const PrReviewFindingSchema = ReviewerFindingSchema.extend({ anchored: z.boolean() });

/** pr_review.run: no SHAs (the server has none); the runner looks them up (section 3.4). Never a token. */
export const PrReviewRunPayloadSchema = z.object({
  runId: z.uuid(), projectId: z.uuid(), prReviewId: z.uuid(), projectRepoId: z.uuid(),
  remoteUrlNormalized: z.string().max(500),
  prNumber: z.number().int().positive(),          // Number(pr_reviews.change_id)
  baseRef: GitRefSchema,                          // pr_reviews.base_branch
  title: z.string().max(300),
  reviewer: PrReviewerSchema, runtime: z.string().max(40), model: z.string().max(120),
  timeoutMs: z.number().int().positive().max(PR_REVIEW_TIMEOUT_MS),
}).strict();
export const PrReviewRunResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('completed'), headSha: Sha40, baseSha: Sha40,
             durationMs: z.number().int().nonnegative(), summary: z.string().max(2000),
             findings: z.array(PrReviewFindingSchema).max(50), usage: UsageSchema.optional() }),
  z.object({ outcome: z.literal('timeout'), durationMs: z.number().int().nonnegative(),
             phase: z.enum(['checkout', 'review']) }),
  z.object({ outcome: z.literal('failed'), durationMs: z.number().int().nonnegative(),
             code: z.enum(['model_error', 'bad_output', 'no_checkout', 'head_moved', 'no_token', 'unsupported',
                           'runtime_unavailable', 'error']),
             error: z.string().max(400), retryable: z.boolean() }),
]);

/** pr_review.post: what GitHubReviewPoster takes, plus finding ids for the result. */
export const PrReviewPostPayloadSchema = z.object({
  runId: z.uuid(),
  spec: ReviewerRunSpecSchema,                    // headSha/baseSha from the completed run
  summary: z.string().max(60_000),                // ends with <!-- review-run:<runId> -->
  findings: z.array(z.object({ findingId: z.uuid(), finding: ReviewFindingSchema })).max(50),
}).strict();
export const PrReviewPostResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), reviewUrl: z.string().max(500), alreadyPosted: z.boolean() }),
  z.object({ ok: z.literal(false), code: z.enum(['no_token', 'forbidden', 'not_found', 'stale_head', 'unsupported',
                                                 'unreachable', 'error']),
             error: z.string().max(400) }),
]);
```

- `Sha40` is `z.string().regex(/^[0-9a-f]{40}$/)`, the same as in `ReviewerRunSpecSchema`. Export one shared const.
- Use the existing zod usage schema for `UsageSchema`. If there is none, leave `usage` out.

Events, next to `PrReviewRecorded` / `PrReviewClosed` in `src/events/project.ts`:
- `PrReviewRunStarted { projectId, repoId, prReviewId, runId, reviewer, runtime, model, workstationId, timeoutMs, at }`
- `PrReviewRunCompleted { projectId, prReviewId, runId, headSha, baseSha, durationMs, summary, findings: [{ findingId, ...PrReviewFinding }] }`
- `PrReviewRunTimedOut { projectId, prReviewId, runId, durationMs, phase, by: 'runner' | 'server' }`
- `PrReviewRunFailed { projectId, prReviewId, runId, stage: 'run' | 'post', code, error, retryable, durationMs? }`
- `PrReviewPosted { projectId, prReviewId, runId, reviewer, reviewUrl, postedFindingIds: uuid[], at }`

`src/protocol/runner.ts`: add `'pr_review.run'` and `'pr_review.post'` to the command names and both payload
schemas to `CommandPayloadSchemas`. Export `PR_REVIEW_CAPABILITY`.

`src/api/pr-reviews.ts` (new) or `src/api/projects.ts`: `PrReviewDtoSchema`:

```ts
{ id, repoId, repoName, changeId, url, title, author, openedAt,
  state: PrReviewStateSchema,
  reviewedAt: IsoTime.nullable(), reviewer: PrReviewerSchema.nullable(),
  lastRun: { state: PrReviewRunStateSchema, startedAt, finishedAt: IsoTime.nullable(),
             durationMs: number | null, timeoutMs, error: string | null, code: string | null,
             postedCount: number, reviewUrl: string | null } | null }
```

### 4.3 Data model: migration `apps/server/migrations/2920_pr_review_runs.sql`

2910 (GWP-196) is the highest today. Re-check at build time.

```sql
-- Reviewer runs on PR-only pull requests and their findings. Projections of PrReviewRun* / PrReviewPosted.
-- No foreign keys (projection rebuild).
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS reviewed_by text;      -- PrReviewerSchema
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS last_run_id uuid;
CREATE TABLE IF NOT EXISTS pr_review_runs (
  id uuid PRIMARY KEY,
  pr_review_id uuid NOT NULL,
  project_id uuid NOT NULL,
  reviewer text NOT NULL,
  runtime text NOT NULL,
  model text NOT NULL,
  workstation_id uuid,
  state text NOT NULL,               -- PrReviewRunStateSchema
  timeout_ms integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms integer,
  head_sha text,                     -- the commit that was reviewed (from the runner)
  base_sha text,
  summary text,
  error_stage text,                  -- run | post
  error_code text,
  error text,
  retryable boolean NOT NULL DEFAULT false,
  timed_out_by text,                 -- runner | server
  review_url text,
  posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS pr_review_runs_pr ON pr_review_runs (pr_review_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pr_review_runs_active ON pr_review_runs (state) WHERE state IN ('running', 'completed');
CREATE TABLE IF NOT EXISTS pr_review_findings (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  pr_review_id uuid NOT NULL,
  idx integer NOT NULL,              -- order the reviewer gave (most important first)
  path text NOT NULL,
  line integer,
  anchored boolean NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  posted boolean NOT NULL DEFAULT false   -- GWP-198 adds held-back; GWP-199 adds the owner's mark
);
CREATE INDEX IF NOT EXISTS pr_review_findings_run ON pr_review_findings (run_id, idx);
```

- Add both tables to `PROJECTION_TABLES` (`apps/server/src/projections/index.ts`).
- The run row is the run record that GWP-203 and GWP-204 reuse. `reviewer` tells the models apart. Findings have
  stable ids for GWP-199.

### 4.4 Server (`apps/server`)

**New `src/commands/pr-review-runs.ts`:**

- **`dispatchPrReviews(ctx)`**, run from the scheduler:
  1. For each project, take **`listReviewablePrs(db, projectId)`** (GWP-196). Never use `listReviewEligiblePrs`
     directly, because that would start runs without a token. Keep only PRs with **no `pr_review_runs` row for
     reviewer `first`**, except:
     - a `failed` run with `retryable = true`, older than 30 minutes, with at most 3 retryable attempts per PR;
     - a `failed` run with code `no_token`, which does not count as an attempt. The gate normally prevents it; if it
       happens, the PR is picked again once the gate is `ready`.
  2. As a result, **a timed-out PR, or a PR whose run failed with a model error, is never started again
     automatically.** The owner re-runs it by hand (GWP-201). This is AC3's "no automatic follow-up".
  3. Pick a workstation from the PR's `workstationIds` (the gate's order, best first) that is connected and announced
     `PR_REVIEW_CAPABILITY`. Never pick a workstation outside that list. If none fits, start nothing: the repo already
     shows GWP-196's reason.
  4. Concurrency: at most 1 `running` run per repo and 2 per workstation. Oldest PR first. (The daily cap is GWP-200.)
  5. In one transaction: call **`reviewerGate(tx, repoId)` again** and stop if it is not `ready` or no longer lists
     the workstation. Append `PrReviewRunStarted` (`REVIEWER_MODEL.first`, `PR_REVIEW_TIMEOUT_MS`), then
     `enqueueRunnerCommand(..., 'pr_review.run', payload)` with `prNumber = Number(change_id)` and
     `baseRef = base_branch`. Then call `deliverPending`.
  6. Skip simulation orgs, as GWP-195 does.
- **`applyPrReviewRunResult(ctx, commandId, ok, result, error)`**, in one transaction, locking the run row:
  - **If the run is no longer `running`, ignore the result** (duplicate after a requeue, or a late answer after the
    backstop). Log it.
  - Command-level failure (`ok:false`, or the result does not parse): `PrReviewRunFailed { stage:'run', code:'error' }`.
  - `completed`: give each finding a uuid, append `PrReviewRunCompleted` (with `headSha` and `baseSha`), then build
    the post with `buildReviewPost(...)` and enqueue `pr_review.post` to **the same workstation** (it holds the token).
  - `timeout`: append `PrReviewRunTimedOut { by:'runner' }`. **Nothing else.** No post, and no change to
    `pr_reviews.review_state`.
  - `failed`: append `PrReviewRunFailed { stage:'run', code, error, retryable }`. **Nothing else.**
- **`buildReviewPost(run, pr, repo, findings)`**, a pure function that returns `PrReviewPostPayload`:
  - `spec` = `ReviewerRunSpec { runId, projectId, projectRepoId, remoteUrlNormalized, prNumber, headSha, baseSha, baseRef }`
    from the run row and the PR.
  - Each chosen finding becomes a `ReviewFinding`, mapped as follows:
    - `title` = `[severity] title`, because `ReviewFindingSchema` is strict and has no severity field.
    - `path` is kept.
    - `line` and `side: 'RIGHT'` are set **only when `anchored`**. A non-anchored finding is sent without `line`
      (its line number goes into the body text as "line N, outside the diff"), so the poster puts it in the review
      body. That way it cannot trigger GitHub's 422, which would push every inline comment into the body.
  - `summary` = the reviewer's summary (or "No findings." when the list is empty) followed by
    `<!-- review-run:<runId> -->`, capped so that the whole body stays under GitHub's 65,536 characters.
  - **Never name the model or the reviewer slot** in any text (GWP-199 blind marking).
  - One hook, `selectFindingsToPost(findings) => findings`, returns all findings in this card. GWP-198 replaces it.
- **`applyPrReviewPostResult(ctx, commandId, ok, result)`**:
  - `ok:true`: append `PrReviewPosted`, which sets `review_state='reviewed'`, `reviewed_by`, `reviewed_at`,
    `last_run_id`, and `posted=true` on the findings. **Apply this even if the run was already marked failed at post
    stage**, because the comments now exist.
  - `ok:false`: `PrReviewRunFailed { stage:'post', code, error }`. The PR stays `not_reviewed`.
- **`sweepStalePrReviewRuns(ctx)`**, run from the scheduler:
  - `running` older than `timeout_ms + 5 min` gets `PrReviewRunTimedOut { by:'server', phase:'review' }`.
  - `completed` (post pending) older than 15 minutes gets `PrReviewRunFailed { stage:'post', code:'error', error:'posting did not finish' }`.
- **`listPrReviews(db, projectId)`**: `pr_reviews` rows of the project's live repos, joined with the latest run and
  the count of posted findings, mapped to `PrReviewDto`. Open PRs first, then by `opened_at` descending.

**Other server changes:**

- `src/runner-gateway/handlers.ts` `applyCommandResult`: add `pr_review.run` and `pr_review.post` branches. Each is
  terminal: `completeCommand(...)`, then apply.
- `src/scheduler/scheduler.ts` `run()`: add `dispatchPrReviews(ctx).catch(log)` and `sweepStalePrReviewRuns(ctx).catch(log)`.
- **New** `src/projections/pr-review-runs.ts` for the five events. Register it in `projections/index.ts`.
- `src/routes/projects.ts`: `GET /api/projects/:id/pull-requests` returns `PrReviewDto[]`, with the same visibility
  guard as the project detail (`loadVisibleProject`). No write routes.
- **Do not touch** card, shift, dispatcher-claim or transition code. No `cards` row, shift or desk item is created
  (AC3).

### 4.5 Runner (`apps/runner`)

**New `src/review/run.ts`: `runPrReview(deps, payload): Promise<PrReviewRunResult>`.** It never posts.

`deps` (everything injectable, so tests need neither bubblewrap nor GitHub):
- `adapter: RuntimeAdapter` (from the registry by `payload.runtime`)
- `heads(payload) → { headSha, baseSha }`: in production, `forge.changeHeads(...)`
- `prepare(spec) → ReviewerRun | { refused }`: in production, `prepareReviewerRun(reviewerDeps, spec)`
- `dispose(run)`: in production, `disposeReviewerRun`
- `exec` (git)
- `paths`, `now`, `log`

Production `reviewerDeps`:
- `paths`
- `tokens: runner.reviewerTokens`
- `findRepo`
- `sandboxState`: `sandboxState(...)` from `adapters/claude-policy.ts`, as the claude-code adapter computes it
- `auth`: the clone's existing git auth
- **`agentId = 'pr-review-' + runId` and `configDir = sandboxFor(paths, agentId).configDir`.** Each run gets its own
  config dir. Claude Code writes `settings.json` there and the adapter links the account credentials in, so two
  concurrent runs never overwrite each other's settings.

Steps:
1. Start the timer with `deadline = start + payload.timeoutMs`. It covers the whole run: heads lookup, checkout and
   review. Track `phase` ('checkout' until the session starts, then 'review').
2. **Look up the heads (new, A1).** `heads(payload)` uses a new read-only `Forge.changeHeads(repo, prNumber)`. On
   GitHub it runs `gh pr view <n> --repo <r> --json headRefOid,baseRefOid` with the owner's existing `gh` login (the
   same pattern as `changeState`). Other forges answer `unsupported`. Then build
   `ReviewerRunSpecSchema.parse({ runId, projectId, projectRepoId, remoteUrlNormalized, prNumber, headSha, baseSha, baseRef })`.
   If it fails: `failed`, `no_checkout`, retryable.
3. `prepare(spec)`. Map the outcomes:

   | Outcome | Code | Retryable |
   |---|---|---|
   | refused `reviewer_token_missing` | `no_token` | false (not counted, section 4.4) |
   | refused `unsupported_host` | `unsupported` | false |
   | refused `sandbox_unavailable` | `runtime_unavailable` | true |
   | refused `no_clone` | `no_checkout` | true |
   | `ReviewHeadMovedError` (a push between steps 2 and 3) | `head_moved` | true |
   | other `ReviewCheckoutError` or error | `no_checkout` | true |

   `prepare` cannot be cancelled. If the timer fires first, answer `timeout` (`phase: 'checkout'`) at once, and
   `dispose` the run when `prepare` settles.
4. The runner, not the agent, runs `git -C <run.checkout> diff --no-color --unified=3 refs/review/base...HEAD` and
   writes the output to `<run.sandbox.scratch>/pr.diff`. The checkout is read-only and `git diff` between commits
   does not write. Parse the hunk headers into `Map<path, Set<rightSideLine>>` for `anchored`.
5. Check `adapter.accountGate?.('main')`. If it is not ok: `failed`, `runtime_unavailable`, retryable. Write the
   reviewer instructions into the run's config dir, the way the delegate does (`adapter.writeInstructions`).
6. Start the session:
   ```ts
   adapter.startChat({ chatId: runId, message: prompt, cwd: run.checkout, readOnly: true, readDirs: [],
     sandbox: run.sandbox, env: sandboxEnv(run.sandbox) /* no AOM_SHIFT_TOKEN, no IPC, no forge token */,
     agent: { runtime: payload.runtime, model: payload.model, roleKey: 'reviewer', permissions: reviewerPermissions(), ... },
     reviewRun: run,                                   // NEW: Claude Code uses reviewerPolicy(run, ...).settings
     logFile: `${paths.shiftLogs}/pr-review-${runId}.jsonl` })
   ```
   **Adapter change (A1):**
   - Add an optional `reviewRun?: ReviewerRun` to `ChatStartInput` (`adapters/types.ts`).
   - In `ClaudeCodeAdapter.startChatSession`, when it is set, use `reviewerPolicy(input.reviewRun, this.policy(chatInput, input.cwd, true)).settings`
     instead of `buildChatSettings(...)`. Write no MCP servers, skills or subagents for it. When it is not set,
     nothing changes.
   - The mock adapter ignores the field.
   - Register no IPC token.
7. When the timer fires: set `stopped = 'timeout'` and call `session.stop('pr_review.timeout')`. Read the session with
   the delegate's `readSession`: export it from `delegate/delegate.ts`, or move it to `adapters/read-session.ts`.
8. Classify the result:
   - Stopped by the timer: `timeout`.
   - `authFailed` or `usageLimit`: `failed`, `runtime_unavailable`, retryable.
   - Exit code ≠ 0: `failed`, `model_error`.
   - Otherwise parse the **last** `===REVIEW-JSON===` block of the final text with `ReviewerOutputSchema`. If it does
     not parse: `failed`, `bad_output`. If it does: `completed` with `headSha`, `baseSha` and `anchored` per finding.
     (GWP-196 sketched a `findings.json` in scratch. The final-text block is used instead: there is one channel, and
     the mock runtime emits it easily.)
9. Always, in `finally`: clear the timer, `dispose(run)`, then `wipeAgent`/`cleanAgentTmp` for `pr-review-<runId>`.

**Startup sweep:** next to `sweepReviewRuns`, remove `agents/pr-review-*` folders that no live run owns (left by a
crash).

**Prompt and instructions** (new `src/review/instructions.ts`):
- You are reviewing a pull request. Read `pr.diff` (path given) and the checkout for context.
- Report real defects only, most important first, each with path, a line in the new file (or null), severity, title
  and body. No style nits.
- End with one `===REVIEW-JSON===` block.
- The PR title goes inside an "untrusted" fence. The PR body is not sent.

**New `src/review/post.ts`: `postPrReview(deps, payload): Promise<PrReviewPostResult>`.** It wraps GWP-196's poster.
- `deps.poster: ReviewPoster & { findByMarker(spec, marker): Promise<string | null> }`.
- **Idempotent:** first `findByMarker(payload.spec, '<!-- review-run:<runId> -->')`. If it finds a review, return
  `{ ok:true, alreadyPosted:true, reviewUrl }`.
- Otherwise call `poster.post({ spec }, findings.map(f => f.finding), summary)` once.
- Map `ReviewPostError`:

  | Error | Code |
  |---|---|
  | `reviewer_token_missing` | `no_token` |
  | `unsupported_host` | `unsupported` |
  | `rejected` 401 / 403 | `forbidden` |
  | `rejected` 404 | `not_found` |
  | `rejected` 422 (after the poster's own body-only retry) | `stale_head` |
  | other `rejected` | `error` |
  | `unreachable` | `unreachable` |

- **Change in `review-poster.ts` (A2):** add `findByMarker(spec, marker)` to `GitHubReviewPoster`.
  - It sends `GET {api}/repos/{o}/{r}/pulls/{n}/reviews?per_page=100` with the same token, headers and redaction.
  - It returns the `html_url` of the first review whose body contains the marker, or `null`.
  - If there is no token, it throws `ReviewPostError('reviewer_token_missing')` like `post` does.
  - Keep the existing `post` behaviour unchanged, because GWP-196's tests cover it.

**`src/runner.ts`:**
- Announce `PR_REVIEW_CAPABILITY` in `hello.capabilities`.
- `pr_review.run`: parse, find the clone, call `runPrReview`, call `done(true, result)`.
- `pr_review.post`: parse, call `postPrReview` with `new GitHubReviewPoster({ fetch, tokens: this.reviewerTokens })`,
  call `done(true, result)`.
- **Dedupe by `runId`:** keep a `Map<runId, Promise<result>>` for each of the two commands. A requeued command for a
  live run awaits the same promise and answers with its own `commandId`. Pass the live run ids to `sweepReviewRuns`.
- Never put a token in a result or a log line.

### 4.6 Web (`apps/web`)

- `src/components/ProjectTabs.tsx`: add a third tab, **Pull requests** (`/p/:projectKey/pull-requests`,
  `testId: 'project-tab-pull-requests'`), shown only when the project has a PR-only repo (`prOnly`).
- `src/router.tsx`: add the route.
- **New** `src/pages/PullRequests.tsx`: one row per PR (a card on narrow screens):
  - Title as an external link, repo, author, opened time.
  - State badge (`data-testid="pr-review-state-<changeId>"`): **Reviewed** (green) or **Not reviewed** (neutral). On
    timeout or failure, also an amber attention icon with text (not colour alone).
  - Detail line:
    - Reviewed: "Reviewed <time> by Sonnet reviewer · run took 3 min 12 s · 4 comments · View on GitHub". GWP-199 may
      hide the reviewer name.
    - Running: "Review running, started 2 min ago (stops after 10 min)".
    - Timed out: "Not reviewed: the review run timed out after 10 minutes. No comments were posted."
    - Failed: "Not reviewed: the review run failed. No comments were posted." followed by the error in a `Callout`
      (`data-testid="pr-review-error-<changeId>"`). **This is AC4's "error visible to the owner".**
    - Waiting: "Waiting for a review". When the repo's `reviewerToken` is `missing`, show "Reviewer token missing"
      (GWP-196's state) instead.
  - Empty state: "No pull requests recorded yet." Refetch every 30 s while any run is `running` or `completed`.
- **New** `src/api/queries/pr-reviews.ts`: `usePullRequests(projectId)`.
- **All devices, including touch:**
  - No hover-only information.
  - Tap targets at least 44 px (`min-h-11`).
  - Rows wrap at 320 px (stacked lines, no table with horizontal scroll).
  - No text input, so no soft keyboard.
  - Check that the third tab is reachable at 320 px.

### 4.7 Docs

`docs/USER-GUIDE.md`: a subsection **PR-only reviews** after "PR-only repositories". It covers:
- One automatic run per new PR, on a workstation that has the clone and the comment-only token.
- The run uses Sonnet with a 10-minute limit.
- Comments are posted only when the run finishes, as one GitHub review.
- What Reviewed and Not reviewed mean.
- A timed-out or failed run posts nothing, is not retried automatically and sends nothing back.
- Where the error shows.

`docs/RUNNER.md`: extend GWP-196's reviewer section with the two commands, `pr-review:1`, the per-run config dir and
the heads lookup.

## 5. Acceptance criteria mapped to design and tests

All tests go in **new files**. Use a fake runtime adapter, a fake `prepare`/`dispose`, fake `heads`, a fake poster (or a
stubbed `fetch` for `findByMarker`), and `payload.timeoutMs: 50`. Server tests need the test DB (Postgres 5433). If it
is not up in the build shift, say so in the handoff.

| AC | Design | Tests |
|---|---|---|
| AC1: completed run posts findings as PR comments, PR shows reviewed | `runPrReview` → `completed`; `applyPrReviewRunResult` stores the findings and enqueues `pr_review.post`; `postPrReview` → one `GitHubReviewPoster.post`; `PrReviewPosted` → `reviewed`, `reviewed_by='first'`, `duration_ms`; web badge | **`apps/runner/test/pr-review-run.test.ts`:** the fake adapter emits a valid block with 3 findings (2 on diff lines, 1 off). Expect `completed`, `anchored` = [true, true, false], `headSha`/`baseSha` from the fake heads, and `durationMs`. `startChat` gets model `sonnet`, `readOnly: true`, `reviewRun` set, and no `AOM_SHIFT_TOKEN` in env. `prepare` gets a spec that passes `ReviewerRunSpecSchema`. **`apps/runner/test/pr-review-post.test.ts`:** with a stubbed `fetch`, the GET finds no marker, then exactly **one** POST to `/pulls/{n}/reviews` holds the 2 anchored inline comments. The body holds the off-diff finding and the marker and does **not** contain "sonnet" or "first". When the marker already exists: no POST, `alreadyPosted: true`. **`apps/server/test/pr-review-runs.test.ts`:** a recorded eligible PR, a reviewer-token report of `present`, and a fake runner (hello with `pr-review:1`). The scheduler pass enqueues `pr_review.run` with model `sonnet`, timeout 600000 and `prNumber`. A `completed` answer gives finding rows and `pr_review.post` (spec with the SHAs; 2 findings with `line`, 1 without). A post answer `ok` makes the `pull-requests` API show `state:'reviewed'`, `reviewer:'first'`, `lastRun.durationMs` and `postedCount:3`. **`apps/web/src/test/pull-requests.test.tsx`:** the Reviewed badge and the run time render |
| AC2: timeout posts nothing, PR not reviewed | The runner timer stops the session and returns `timeout` (no posting code in `runPrReview`); the server appends only `PrReviewRunTimedOut`; the backstop does the same; a late `completed` is ignored | **Runner:** the session never ends, `timeoutMs: 50` → `timeout` (`phase: 'review'`), `session.stop` called, `dispose` called. A `prepare` that hangs → `timeout` (`phase: 'checkout'`), and `dispose` runs once it settles. **Server:** a `timeout` answer → no `pr_review.post` row, `not_reviewed`, run `timed_out`. Backstop: clock past 15 min → `timed_out` (`by:'server'`); then a late `completed` → no `pr_review.post` |
| AC3: no send-back, no needs-split on timeout | The timeout branch appends one event and nothing else; no automatic restart; no card, shift or transition code touched | **Server:** after a timeout, the only new event is `PrReviewRunTimedOut`; `cards` and `shifts` counts are unchanged; `closed_at` is null and the state is `not_reviewed`; the next scheduler pass enqueues no `pr_review.run` for that PR. The reviewer checks that the diff does not touch card, dispatcher-claim or transition code |
| AC4: other failure posts nothing, stays not reviewed, error visible | Runner `failed` codes; server `PrReviewRunFailed` (no post); a post-stage failure keeps `not_reviewed`; web `Callout` | **Runner:** exit code 1 → `model_error`; prose with no block → `bad_output`; `usageLimit` → `runtime_unavailable`, retryable; refused `reviewer_token_missing` → `no_token`, not retryable; `ReviewHeadMovedError` → `head_moved`, retryable. In each case nothing is posted, because `runPrReview` has no poster. **Server:** a `failed` answer → no `pr_review.post`, `not_reviewed`, and `lastRun.error` holds the text; a post answer `ok:false` → `not_reviewed`, `error_stage='post'`; a model-error PR is not restarted; with the token gate `missing`, nothing is dispatched. **Web:** the error `Callout` shows the text |

Also cover the dedupe: the same `runId` delivered twice while live → one adapter session and two answers. A second
identical result on the server is ignored.

## 6. Risks and traps

- **Requeue after reconnect** can deliver either command twice. The runner dedupes live commands by `runId`. The post
  command also checks the marker (`findByMarker`) before posting. The server ignores results for runs that are not
  `running`.
- **Inline comment on a line that is not in the diff:** GitHub rejects the whole review with 422, and the poster then
  moves every finding into the body. Send `line` only for anchored findings.
- **Head moved:** between the heads lookup and the fetch → `head_moved` (retryable). Between the run and the post,
  `commit_id = headSha` pins the review to the reviewed commit. A 422 is `stale_head` and is not retried here
  (GWP-201 re-runs).
- **Shared Claude config dir:** a per-run `pr-review-<runId>` agent dir avoids concurrent `settings.json` writes.
  Sweep leftovers at startup.
- **Prompt injection from the PR:** `reviewerPolicy` is offline, has a read-only cwd and no `aom` token. Fence the
  title as untrusted. Validate the output with zod and cap its sizes.
- **Blindness for GWP-199:** never write the model or the reviewer slot into the GitHub review.
- **Data kept on the server:** the server stores finding text but never the diff or file contents. The token stays in
  the workstation's sealed store, and the poster redacts errors.
- **Cost:** a Sonnet session per run on the workstation's Claude account. Usage is kept on the run record. The daily
  cap (GWP-200) limits spend.
- **Scope:** no needs-split, size check, cap or manual trigger. The seams are `selectFindingsToPost` and the
  `reviewer` column.

## 7. Files

New:
- `apps/server/migrations/2920_pr_review_runs.sql`
- `apps/server/src/commands/pr-review-runs.ts`
- `apps/server/src/projections/pr-review-runs.ts`
- `apps/runner/src/review/run.ts`
- `apps/runner/src/review/post.ts`
- `apps/runner/src/review/instructions.ts`
- `apps/web/src/pages/PullRequests.tsx`
- `apps/web/src/api/queries/pr-reviews.ts`
- `packages/shared/src/api/pr-reviews.ts` (or extend `api/projects.ts`)

Changed:
- `packages/shared/src/review/pr-review.ts`
- `packages/shared/src/review/reviewer-run.ts` (export the shared `Sha40` only)
- `packages/shared/src/protocol/runner.ts`
- `packages/shared/src/events/project.ts`
- `packages/shared/src/index.ts`
- `apps/server/src/runner-gateway/handlers.ts`
- `apps/server/src/scheduler/scheduler.ts`
- `apps/server/src/projections/index.ts`
- `apps/server/src/routes/projects.ts`
- `apps/runner/src/runner.ts`
- `apps/runner/src/forge/types.ts` and `apps/runner/src/forge/github.ts` (`changeHeads`; other forges `unsupported`)
- `apps/runner/src/adapters/types.ts` (`ChatStartInput.reviewRun`)
- `apps/runner/src/adapters/claude-code.ts` (use `reviewerPolicy` when `reviewRun` is set)
- `apps/runner/src/review/review-poster.ts` (`findByMarker`)
- `apps/runner/src/review/reviewer-sandbox.ts` or `runner.ts` (sweep of `agents/pr-review-*`)
- `apps/runner/src/delegate/delegate.ts` (export `readSession`, or move it to `adapters/read-session.ts`)
- `apps/web/src/components/ProjectTabs.tsx`
- `apps/web/src/router.tsx`
- `docs/USER-GUIDE.md`
- `docs/RUNNER.md`

Other forge adapters, if the `Forge` interface requires it: a stub `changeHeads` that answers `unsupported`.

New tests:
- `apps/runner/test/pr-review-run.test.ts`
- `apps/runner/test/pr-review-post.test.ts`
- `apps/server/test/pr-review-runs.test.ts`
- `apps/web/src/test/pull-requests.test.tsx`

No existing test file changes. GWP-196's `review-poster.test.ts` and `reviewer-sandbox.test.ts` must still pass
unchanged.

## 8. Recommendation

Build option B in both choices, on top of the landed GWP-196 pieces:
- The run is a runner command. It looks up the PR heads, prepares GWP-196's read-only run, and runs a Sonnet session
  under `reviewerPolicy` with a 10-minute timer around the whole run.
- It returns findings and never posts.
- The server is the only party that can start a post, and only for a completed run.
- Posting goes through GWP-196's `GitHubReviewPoster` as one atomic review. A marker check makes a repeated command
  harmless.

"Not reviewed" and "reviewed" are the PR field. Each run's outcome, reviewer, model, reviewed commit and run time sit on
its run record. A timeout or failure writes one event and nothing else.

## 9. Assumptions about the dependencies (status after revision 1)

| # | Assumption | Status |
|---|---|---|
| A1 | Checkout call with SHAs | Revised: `prepareReviewerRun`/`disposeReviewerRun`, with the SHAs looked up by the runner (`Forge.changeHeads`), the `reviewRun` adapter input and per-run config dir (sections 0, 3.4, 4.5) |
| A2 | A way to post with the comment-only token | Revised: `GitHubReviewPoster.post` plus a new `findByMarker`; payload is `spec` + `ReviewFinding[]` + summary (sections 0, 4.4, 4.5) |
| A3 | Server-side "no token, no run" check | Confirmed: `listReviewablePrs` + `reviewerGate` |
| A4 | GWP-195 as designed | Confirmed; the migration number moves to 2920 because GWP-196 took 2910 |
| A5 | Token can create a review with inline comments | Confirmed |
