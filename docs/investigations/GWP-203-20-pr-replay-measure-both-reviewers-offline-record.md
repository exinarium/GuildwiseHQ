# GWP-203: 20-PR replay: measure both reviewers offline, record precision per reviewer and baseline review effort

Design report. Repository GuildwiseHQ. First written on the working branch at b023544d, before GWP-195, GWP-196,
GWP-197, GWP-198 and GWP-199 landed. **Revised at 0663032e, after all five landed.** Section 0 lists what the landed
code changed. Section 8 records the result of checking each assumption.

## 0. Revision against the landed dependencies (0663032e)

Assumptions 4 (GWP-195) and 5 (GWP-198) hold as written. Assumptions 1, 2 and 3 hold in substance, but one part of
each does not match the landed code. The design changes only where the landed code makes it wrong:

| # | What did not hold | Change in this report |
|---|---|---|
| 1 | `prepareReviewerRun` always refuses without a token (`reviewer-sandbox.ts:65`, `reviewer_token_missing`, then `no_token`, not retryable). There is no option to skip that check. | The `requireToken` option is now **definite** (not "if missing"). `runPrReview` already takes a `heads(payload)` dependency, so the replay plugs `resolveReplayBase` in there and leaves the checkout code alone (4.5). |
| 2 | There is no helper that enqueues `pr_review.post`. The **only** enqueue is inline in `applyPrReviewRunResult` (`pr-review-runs.ts:362`). Live dispatch does not loop over `PR_REVIEWERS`: `startRun` hardcodes `REVIEWER_MODEL.first` / `'first'`. Finding ids are `randomUUID()` (v4), not uuidv7. GWP-198's `disposition` column (`posted`/`held_back`, NOT NULL DEFAULT `'posted'`) and `posted boolean` already exist. | The guard goes on that one site, pulled out into a small `enqueueReviewPost` helper that throws for a replay run. `LIVE_REVIEWERS` stays as a constant for GWP-204, plus a test that live dispatch never sends `opus`. **No `replay_disposition` column**: replay findings use `disposition` (`posted` means would post) and keep `posted = false`. The md5 order stays, because it does not depend on how ids are made (4.3, 4.4). |
| 3 | `FindingMark.tsx` takes **no** mutation prop. It calls `useMarkFinding(projectId)` itself and shows "Reviewer shown after you mark". It lives in `components/pull-requests/`, not `components/pr-review/`. GWP-199's `reviewerPrecision` drops every row with `posted === false`. The mark event field is `prReviewId` (not `reviewId`), and the DTO is `PostedFindingDto`. | Add the optional props `onMark`/`pending`/`error` and `hint` to `FindingMark`. The live call sites stay unchanged. The replay calls `reviewerPrecision` **without** the `posted` field (or with `posted: true`), or every replay finding is dropped. Names and paths are corrected throughout (4.2, 4.4, 4.6). |

Smaller corrections made while checking (not assumption failures):

- `PrReviewRunResultSchema` already has a required `baseSha` and an optional `changedLines`, so no result schema change
  is needed.
- `pr_review_runs.base_sha` already exists.
- `PrReviewRunPayloadSchema` is `.strict()` and requires `prReviewId`. The replay puts the `replayPrId` in it.
- `MAX_RUNNING_PER_WORKSTATION = 2` counts every `running` row, including replay runs. One replay run per workstation
  still leaves a live slot. `MAX_RUNNING_PER_REPO` joins `pr_reviews`, so it ignores replay runs.
- The Pull requests page is `apps/web/src/components/pull-requests/PullRequestsPage.tsx` (route
  `/p/:projectKey/pull-requests`).
- `PR_REVIEWER_LABEL` is a `Record<PrReviewer, string>` and needs `second: 'Opus reviewer'` once `PR_REVIEWERS` grows.
- GWP-200 (daily cap) has not landed. GWP-205 landed project review settings (`size_budget`, `size_unit`,
  `risk_map`), with no targets. Both match sections 3.5 and 8.
- The highest migration is `2940_pr_review_finding_marks.sql`, so this card's migration is `2950_pr_replay.sql`.

## 1. Question

PRD "Review Gates & Reviewer Workflow" v22 (doc 61871304):

- §10: "A 20-PR replay measures the second reviewer offline before it runs on live PRs. It works if the precision ratio
  is recorded per reviewer."
- §2: today's review cost, in **owner hours per week**, is not known; "the baseline review effort goal (section 3)
  measures it during the 20-PR replay."
- §3: the rollout ends when the replay is done and the target levels for reviewer precision and baseline review
  effort are set. "Target level to be set immediately after the 20-PR replay, using its result as the baseline."
- §9, open item 1: the owner sets the targets from the replay results.

This design answers:

1. How does the owner start a replay over 20 already-merged PRs of a PR-only repo, and how do both reviewers (Sonnet,
   Opus) review them **with nothing posted** (AC1)? What happens when the repo has fewer than 20 merged PRs?
2. How are replay findings stored and marked useful/noise **blind**, reusing GWP-199's marks (AC2)?
3. What exactly is "precision per reviewer" in a replay, how is **review effort** measured (open point on the card),
   and how is it recorded (AC3)?
4. Where are the owner's **targets** stored on the project, and how are they entered (AC4)?

## 2. Findings

### 2.1 What exists on the working branch

- **Project switches and settings pattern.** `setRegressionLoop` in `apps/server/src/commands/projects.ts`:
  `withAppendTx`, `loadVisibleProject`, owner check, no event when nothing changes, one event on
  `streamId.project(id)`. The projection in `apps/server/src/projections/projects.ts` updates a `projects` column. The
  route is `PUT /api/projects/:id/regression-loop` in `apps/server/src/routes/projects.ts` and answers with
  `getProjectDetail`. The DTO field is in `packages/shared/src/api/projects.ts` and is mapped in
  `apps/server/src/queries/misc.ts`. The targets follow this pattern.
- **Server event row ids are time-ordered** (`uuidv7()`, `packages/shared/src/ids.ts`). GWP-197 makes finding ids with
  `randomUUID()` (v4). The marking order still uses `md5(id)`, never the id itself, so it does not depend on how ids are
  made (section 4.6).
- **Stream names matter to the web.** `ids.ts` notes that a stream kind must not start with `release-` so that the web
  can route it. The new stream is `prreplay-<id>`.
- **GitHub through `gh`.** `apps/runner/src/forge/github.ts`:
  - `listOpenChanges` runs `gh pr list --state open --json ...` (GWP-195).
  - `changeHeads` runs `gh pr view --json headRefOid,baseRefOid` (GWP-197).
  - `changeMergeCommit` reads `mergeCommit`.

  The merged list follows `listOpenChanges`. The diff base of a merged PR is worked out locally from the merge commit
  (section 4.5). It does not use `baseRefOid`, whose meaning for a long-merged PR is the base tip GitHub last recorded.
- **Models.** `packages/shared/src/models/choices.ts` already has `sonnet` and `opus` for `claude-code`.
- **Docs.** `docs/USER-GUIDE.md` §4.3c "PR-only repositories" has a "PR-only reviews" subsection (GWP-197/199).

### 2.2 What the dependencies ship (landed)

- **GWP-195** (`2900_pr_only_review.sql`, `commands/pr-only.ts`):
  - `project_repos.pr_only` / `pr_only_since`.
  - The `pr_reviews` table (open PRs from `pr_only_since`). Merged PRs from before the switch are never in it.
  - `repo.list_prs` with `PR_LIST_CAPABILITY = 'pr-list:1'` (`protocol/runner.ts`).
  - The card-branch exclusion: `SELECT branch_name FROM cards WHERE project_id=$1 AND branch_name IS NOT NULL`.
  - The workstation pick: `workstation_repos`, `status='active'`, capability, then connected, owner and `last_seen_at`.
- **GWP-196** (`apps/runner/src/review/`):
  - `createReviewCheckout`: fetches `refs/pull/<n>/head` into a private ref and checks it equals `spec.headSha`
    (`ReviewHeadMovedError` otherwise). It fetches `spec.baseRef` when `spec.baseSha` is not in the clone. It builds a
    standalone read-only repo with `refs/review/base` and `refs/review/head`.
  - `prepareReviewerRun(deps, spec)`: token check (no way to skip it), then GitHub only, sandbox enforced, the clone,
    and the checkout.
  - `GitHubReviewPoster`. `ReviewerRunSpecSchema` (`shared/review/reviewer-run.ts`): runId, projectId, projectRepoId,
    remoteUrlNormalized, prNumber, headSha, baseSha, baseRef.
- **GWP-197** (`2920_pr_review_runs.sql`, `commands/pr-review-runs.ts`, `runner/src/review/run.ts`,
  `pr-review-commands.ts`):
  - `pr_review.run` **never posts**. `runPrReview(deps, payload)` takes injected `heads`, `prepare`, `dispose`,
    `diff` and `numstat`.
  - The diff is `refs/review/base...HEAD` (three dots, from the merge base).
  - `pr_review.post` is enqueued at **one** inline site in `applyPrReviewRunResult`.
  - `pr_review_runs` has reviewer, runtime, model, state, base_sha and more. `pr_review_findings` has one row per
    finding, `randomUUID()` ids, and `posted boolean DEFAULT false`. Both have `pr_review_id uuid NOT NULL` and no
    foreign keys.
  - Constants: `PR_REVIEWERS = ['first']`, `REVIEWER_MODEL`, `PR_REVIEW_TIMEOUT_MS`, `PR_REVIEW_CAPABILITY`.
  - `sweepStalePrReviewRuns`: `running` past timeout plus grace, and `completed` past the post wait.
- **GWP-198** (`2930_pr_review_findings_cap.sql`, `shared/review/findings.ts`):
  - `applyFindingsCap(findings, changedLines)` returns `{cap, heldBackCount, ordered[{rank, disposition}]}`. It runs on
    the **server** in `applyPrReviewRunResult`.
  - The columns `pr_review_findings.rank` and `disposition` (`posted`/`held_back`), and on `pr_review_runs`:
    `changed_lines`, `findings_cap`, `held_back_count`. The runner sends `changedLines`.
- **GWP-199** (`2940_pr_review_finding_marks.sql`, `commands/pr-review-marks.ts`, `shared/review/marks.ts`):
  - `pr_review_finding_marks` (`finding_id` PK, `pr_review_id`, `run_id`, `project_id`, `mark`, `blind_mark`,
    `marked_at`, `first_marked_at`; no foreign keys).
  - `PrReviewFindingMarked { projectId, prReviewId, runId, findingId, mark, previousMark, markedBy, at }`, with no
    reviewer. Its projection is a plain upsert with no join.
  - The view `pr_review_finding_attribution`. `findingView(PostedFindingRow, {canMark})` reveals once marked.
    `reviewerPrecision(rows)` skips `posted === false`.
  - Every live read (`listPostedFindings`, `loadPostedFinding`, `markFinding`, `reviewerPrecisionForProject`,
    `findingMarksForReplay`) filters `f.posted` and/or joins `pr_reviews`, so replay rows drop out with no change.
  - `FindingMark.tsx` in `components/pull-requests/` has no mutation prop.

### 2.3 Facts that shape the design

1. **Nothing may post.** GWP-197 already separates running from posting, so the replay is safe if (a) the server never
   enqueues `pr_review.post` for a replay run, and (b) the runner gets no token or poster for a replay run. Both are
   enforced in code and asserted in tests (section 4.4, AC1).
2. **"Findings that would have been posted"** (requirement 3) means the live posting rule, which is GWP-198's cap. A
   replay that counted every finding would set a precision baseline that live precision (useful ÷ posted after the cap)
   can never be compared with. The design applies the cap and explains why in section 3.3.
3. **Blindness for a replay is stricter than live.** Live marking (GWP-199) reveals the reviewer as soon as a finding
   is marked. In a replay both reviewers review the same 20 PRs. Revealing after each mark would teach the owner each
   reviewer's style halfway through, and the remaining marks would no longer be blind. The reviewer stays hidden until
   marking is complete **for the whole replay**.

## 3. Options compared

### 3.1 Where replay runs and findings are stored

| Option | Pros | Cons |
|---|---|---|
| A. Separate tables for replay runs, findings and marks | Fully isolated from live | Second mark store, which the planner rules out. GWP-199's precision function and `FindingMark` would need a parallel path |
| B. Add replay PRs to `pr_reviews` with a flag | One PR table | Every live query (eligibility, PR list, daily cap, precision) would have to exclude replay rows. Merged PRs would also break GWP-195's open/closed logic |
| **C. Own tables for the replay and its 20 PRs (`pr_replays`, `pr_replay_prs`). Runs and findings go in GWP-197's `pr_review_runs`/`pr_review_findings` with `replay_id`/`replay_pr_id` set and `pr_review_id` NULL. Marks go in GWP-199's table** (chosen) | One mark store and one precision function. Live queries join `pr_reviews` on `pr_review_id` or filter `f.posted`, so replay rows drop out on their own. A distinct run state (`offline_completed`) keeps them out of every "post pending" path | `pr_review_id` becomes nullable (one ALTER each; there are no foreign keys). The live code must branch on `replay_id` in one place (the run result handler) |

Replay runs use **their own events** (`PrReplayRun*`), not GWP-197's `PrReviewRun*`. Their projections write to the
same tables. So no live projection, handler or activity view ever sees a replay event as a live one.

### 3.2 Which runs, and which command

| Option | Verdict |
|---|---|
| A new runner command `pr_replay.run` | Duplicates GWP-197's `runPrReview` (checkout, diff, sandbox, timer, parsing) |
| **GWP-197's `pr_review.run` with an optional `replay` block in the payload (pinned head and merge commit, `offline: true`)** | **Chosen.** The same reviewer prompt, sandbox and 10-minute timer as live, so the measurement matches what live review would do. The command never posts (GWP-197) |

### 3.3 "Would have been posted": apply the cap?

| Option | Verdict |
|---|---|
| A. Every finding counts as would-post | The baseline is not comparable with live precision. It also inflates marking effort beyond what live review costs |
| **B. Apply the live selection (`applyFindingsCap` from GWP-198) per reviewer run, as if that reviewer were the only one on the PR** | **Chosen.** It matches the PRD definition and GWP-198's own note. Held-back findings are stored, visible on request, not marked and not counted, exactly as live |

The cap is applied **per reviewer**, not to a merged list. Merging two reviewers' findings is GWP-204's live behaviour.
The replay measures each reviewer alone, which is what §10 asks for. GWP-200's **daily cap is not used**: replay runs
are not automatic live reviews and do not count against the 20 per day.

### 3.4 Review effort (open point on the card)

| Option | Measures | Pros | Cons |
|---|---|---|---|
| A. Self-reported hours | What the owner thinks | Trivial | Not measured; memory bias; needs an extra input |
| B. Wall clock, from first finding shown to last finding marked | Calendar time | Simple | Marking over several days counts nights and weekends |
| **C. Active marking time per finding: from the moment the finding is shown in the marking view until the owner marks it, capped at 10 minutes per finding (idle cap). Effort = the sum** (chosen) | Hands-on review time | Measured by the server, robust against breaks, and splittable per reviewer and per PR after the reveal | Needs a "shown" record. Reading the PR on GitHub in another tab beyond 10 minutes is not counted (documented) |

**Choice: C**, with B shown next to it for context. "First shown to last marked" is applied **per finding**:

- `shown_at` is the last time the finding was shown before its first mark. A reload after a break restarts the clock,
  so the break is not counted.
- Changing a mark does not add time.

The PRD baseline is in **hours per week**, so the result also shows an estimate. It is labelled "estimate":

```
minutes per PR = active marking time ÷ 20
PRs per week   = 20 ÷ max(1, weeks between the oldest and newest mergedAt of the 20 PRs)
estimated owner hours per week = minutes per PR × PRs per week ÷ 60
```

The estimate is shown, never saved as a target. The owner types the targets (requirement 4).

### 3.5 Where the targets are stored

| Option | Verdict |
|---|---|
| A. In GWP-205's per-project review settings (`size_budget`, `size_unit`, `risk_map`, landed in `2900_project_review_settings.sql`) | Its scope is "no defaults" sizing settings, not rollout targets. Not a dependency |
| **B. Columns on `projects`, written by a new event `ProjectReviewTargetsSet`, following the `regression_loop` pattern** | **Chosen.** Small, follows an existing pattern, and is "saved on the project" (AC4). GWP-205's settings panel can show them later without moving them |

One **precision target** applies to every reviewer: one number, 0 to 1. The PRD has a single "reviewer precision"
goal. The **review effort target** is in owner hours per week, the PRD §2 unit. Each target set records the replay it
was based on.

## 4. Design

### 4.1 Flow and states

```
owner: POST /api/projects/:id/pr-replays {repoId}
  PrReplayStarted (state listing) + repo.list_merged_prs -> workstation with clone + pr-replay:1
runner: gh pr list --state merged (most recent 50) -> result
server applyMergedPrList
  < 20 usable PRs -> PrReplayFailed {reason: not_enough_prs, found: N}       (no runs)
  >= 20           -> PrReplayPrsSelected (20 newest by mergedAt) (state reviewing)
scheduler: dispatchReplayRuns  (live reviews first; 1 replay run per workstation at a time)
  for each replay PR x reviewer in REPLAY_REVIEWERS ['first','second']:
    PrReplayRunStarted + pr_review.run {.., prReviewId: replayPrId, offline:true, replay:{replayId, replayPrId, headSha, mergeCommitSha}}
runner: runPrReview (GWP-197) with heads = resolveReplayBase, prepare with requireToken:false; NEVER posts
server applyPrReviewRunResult -> run.replay_id set -> applyReplayRunResult (never enqueues pr_review.post)
  completed -> PrReplayRunCompleted (findings with rank + disposition posted|held_back, posted stays false)
  timeout/failed -> PrReplayRunTimedOut / PrReplayRunFailed (auto retry rules in 4.4)
  all 40 slots terminal -> PrReplayReviewsDone (state marking); 0 would-post findings -> finish at once
owner marks would-post findings one at a time, blind (POST shown, PUT mark)
  last finding marked -> PrReplayMarkingFinished {result snapshot} (state finished; reviewers revealed)
owner: PUT /api/projects/:id/review-targets {precisionTarget, effortTargetHoursPerWeek}
  ProjectReviewTargetsSet (needs a finished replay)
```

States: `listing → reviewing → marking → finished`, plus `failed` (from listing) and `cancelled` (owner, from listing,
reviewing or marking). At most one active replay (listing, reviewing or marking) per project.

### 4.2 Shared (`packages/shared`)

New file `src/review/replay.ts`, exported from `src/review/index.ts`:

```ts
export const REPLAY_PR_COUNT = 20;
export const REPLAY_LIST_LIMIT = 50;                  // merged PRs fetched to find 20 usable ones
export const REPLAY_REVIEWERS = ['first', 'second'] as const; // both offline
export const REPLAY_CAPABILITY = 'pr-replay:1';
export const REPLAY_IDLE_CAP_MS = 10 * 60_000;        // effort cap per finding
export const REPLAY_STATES = ['listing', 'reviewing', 'marking', 'finished', 'failed', 'cancelled'] as const;
export const ReplayFailureReason = z.enum(['not_enough_prs', 'no_workstation', 'unsupported', 'not_connected', 'error']);

export const MergedChangeSchema = z.object({
  id: z.string().min(1).max(40), url: z.string().max(500), title: z.string().max(300),
  author: z.string().max(100).nullable(), head: z.string().max(200), base: z.string().max(200),
  headSha: z.string().regex(/^[0-9a-f]{40}$/), mergeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  mergedAt: z.iso.datetime({ offset: true }), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
});
export const RepoListMergedPrsPayloadSchema = z.object({ requestId: z.uuid(), replayId: z.uuid(), repoId: z.uuid(),
  remoteUrlNormalized: z.string().max(500), forge: ForgeKindSchema.optional(), limit: z.number().int().max(100) });
export const RepoListMergedPrsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), changes: z.array(MergedChangeSchema).max(100) }),
  z.object({ ok: z.literal(false), reason: z.enum(['no_clone', 'unsupported', 'not_connected', 'error']), error: z.string().max(400).optional() }),
]);

/** Added to GWP-197's PrReviewRunPayloadSchema as optional fields. */
export const ReplayRunBlockSchema = z.object({
  replayId: z.uuid(), replayPrId: z.uuid(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/), mergeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();

export const ReplayReviewerResultSchema = z.object({
  reviewer: PrReviewerSchema, label: z.string(), model: z.string(),
  prsReviewed: z.number().int(), prsNotReviewed: z.number().int(),
  wouldPost: z.number().int(), heldBack: z.number().int(), useful: z.number().int(), noise: z.number().int(),
  precision: z.number().min(0).max(1).nullable(),       // useful / wouldPost; null when wouldPost = 0
  effortMs: z.number().int().nonnegative(),             // marking time on this reviewer's findings
});
export const ReplayResultSchema = z.object({
  prCount: z.number().int(), reviewers: z.array(ReplayReviewerResultSchema),
  effort: z.object({
    activeMs: z.number().int(), perPrMs: z.number().int(), perFindingMs: z.number().int().nullable(),
    findingsMarked: z.number().int(), wallClockMs: z.number().int(), idleCapMs: z.number().int(),
    prsPerWeek: z.number(), hoursPerWeekEstimate: z.number(),
  }),
});

/**
 * Pure. Precision reuses GWP-199's reviewerPrecision on { reviewer, model, disposition, mark }.
 * TRAP: do NOT pass `posted` (replay rows have posted = false; reviewerPrecision drops posted === false rows).
 */
export function replayResult(input: {
  prs: { id: string; mergedAt: string }[];
  runs: { replayPrId: string; reviewer: PrReviewer; model: string; state: string }[];
  findings: { id: string; reviewer: PrReviewer; model: string; disposition: FindingDisposition; mark: FindingMark | null }[];
  views: { findingId: string; shownAt: string; markedAt: string }[];   // shownAt = last shown before first mark
}, opts?: { idleCapMs?: number }): ReplayResult;

/**
 * Blind view for replay findings: reviewers only once the whole replay is finished. Wraps GWP-199's findingView
 * (PostedFindingRow -> PostedFindingDto; prReviewId = replayPrId, postedAt/reviewUrl null). findingView reveals once
 * marked, so this MUST override reviewers to null until revealed.
 */
export function replayFindingView(row: PostedFindingRow, o: { revealed: boolean; canMark: boolean }): PostedFindingDto {
  const v = findingView(row, { canMark: o.canMark });
  return o.revealed ? v : { ...v, reviewers: null };
}

/** Reviewer-independent marking order: PR order, then a hash of the finding id (never the id itself). */
export function replayOrderKey(f: { prIdx: number; id: string }): string;

export const StartReplayRequestSchema = z.object({ repoId: z.uuid() }).strict();
export const SetReviewTargetsRequestSchema = z.object({
  precisionTarget: z.number().min(0).max(1).multipleOf(0.01),
  effortTargetHoursPerWeek: z.number().min(0).max(168).multipleOf(0.1),
}).strict();
export const ReviewTargetsDtoSchema = z.object({
  precisionTarget: z.number().nullable(), effortTargetHoursPerWeek: z.number().nullable(),
  replayId: z.uuid().nullable(), setAt: IsoTime.nullable(),
});
export const ReplayDtoSchema = z.object({
  id: z.uuid(), projectId: z.uuid(), repoId: z.uuid(), repoName: z.string(),
  state: z.enum(REPLAY_STATES), startedAt: IsoTime, finishedAt: IsoTime.nullable(),
  failure: z.object({ reason: ReplayFailureReason, found: z.number().int().nullable(), detail: z.string().nullable() }).nullable(),
  prs: z.array(z.object({ id: z.uuid(), changeId: z.string(), url: z.string(), title: z.string(), mergedAt: IsoTime })),
  /** Blind before finished: totals only, never per reviewer. */
  progress: z.object({ runsTotal: z.number().int(), runsDone: z.number().int(), runsFailed: z.number().int(),
                       findingsToMark: z.number().int(), findingsMarked: z.number().int() }),
  result: ReplayResultSchema.nullable(),                 // null until finished
  canManage: z.boolean(),                                // project owner
});
```

The multipleOf checks on floats (0.7 / 0.01) can fail from rounding. Validate with a rounding refine
(`Math.abs(v*100 - Math.round(v*100)) < 1e-9`) instead.

Extend GWP-197's `src/review/pr-review.ts` and GWP-199's `src/review/marks.ts`:

- `PR_REVIEWERS = ['first', 'second']`.
- `REVIEWER_MODEL.second = { runtime: 'claude-code', model: 'opus' }`.
- `PR_REVIEWER_LABEL.second = 'Opus reviewer'` (`marks.ts`; the `Record` type forces it).
- **`LIVE_REVIEWERS = ['first'] as const`**. GWP-197's `startRun`/`mayStart` hardcode `'first'` today, so adding
  `'second'` to `PR_REVIEWERS` does not start live Opus. Keep that, and write `LIVE_REVIEWERS` down as the gate GWP-204
  extends. If GWP-204 has landed first, keep its definitions.
- `PR_REVIEW_RUN_STATES` gets `'offline_completed'`. Check every `switch`/`as` on the run state, for example
  `listPrReviews` casts `run_state` to the five live states.
- `PrReviewRunPayloadSchema` (strict) gets `offline: z.literal(true).optional()` and
  `replay: ReplayRunBlockSchema.optional()`, with a refine: `replay` requires `offline`. `prReviewId` stays required.
  For a replay run it carries the `replayPrId`.
- `PrReviewRunResultSchema`: **no change** (`baseSha` is already required and `changedLines` is optional).

Events (new file `src/events/pr-replay.ts`, registered in `events/index.ts`; stream `streamId.prReplay(id)` =
`prreplay-<id>` in `ids.ts`):

- `PrReplayStarted { replayId, projectId, repoId, requestId, workstationId|null, by, at }`
- `PrReplayPrsSelected { replayId, prs: [{ replayPrId, idx, changeId, url, title, author|null, headBranch, baseBranch, headSha, mergeCommitSha, mergedAt, additions, deletions }] }`
- `PrReplayFailed { replayId, reason, found?: number, detail?: string }`
- `PrReplayRunStarted { replayId, replayPrId, projectId, runId, reviewer, runtime, model, workstationId, timeoutMs, attempt, at }`
- `PrReplayRunCompleted { replayId, replayPrId, runId, headSha, baseSha, durationMs, changedLines|null, findingsCap, summary, findings: [{ findingId, idx, rank, path, line, anchored, severity, title, body, disposition: 'posted'|'held_back' }] }`
- `PrReplayRunTimedOut { replayId, replayPrId, runId, durationMs, phase, by }`
- `PrReplayRunFailed { replayId, replayPrId, runId, code, error, retryable, durationMs? }`
- `PrReplayReviewsDone { replayId, at }`
- `PrReplayFindingShown { replayId, findingId, at }`
- `PrReplayMarkingFinished { replayId, result: ReplayResult, at }`
- `PrReplayCancelled { replayId, by, at }`
- `PrReplayRetryRequested { replayId, by, at }` (state back to `reviewing`; the failed slots reopen with a new attempt)
- In `events/project.ts`: `ProjectReviewTargetsSet { projectId, precisionTarget, effortTargetHoursPerWeek, replayId, by }`

Marks reuse GWP-199's `PrReviewFindingMarked { projectId, prReviewId, runId, findingId, mark, previousMark,
markedBy, at }`. For a replay finding, **`prReviewId` is the `replayPrId`**. Its projection upserts
`pr_review_finding_marks` without a join, so it works unchanged. Append it on `prreplay-<replayId>`. The event carries
no reviewer, as in GWP-199.

`src/protocol/runner.ts`: the command `'repo.list_merged_prs'` with its payload schema in `CommandPayloadSchemas` (next
to `repo.list_prs` and `PR_LIST_CAPABILITY`), and export `REPLAY_CAPABILITY`.

### 4.3 Data model: migration `apps/server/migrations/2950_pr_replay.sql`

The highest migration at 0663032e is 2940. Re-check it at build time.

```sql
-- 20-PR replay (offline reviewer measurement) and the owner's review targets. Projections of PrReplay* and
-- ProjectReviewTargetsSet. Replay runs and findings live in pr_review_runs / pr_review_findings with replay_id set and
-- pr_review_id NULL; marks live in pr_review_finding_marks. No foreign keys (projection rebuild).
CREATE TABLE IF NOT EXISTS pr_replays (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  project_repo_id uuid NOT NULL,
  state text NOT NULL,                    -- REPLAY_STATES
  request_id uuid NOT NULL,               -- current repo.list_merged_prs request
  workstation_id uuid,
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL,
  reviews_done_at timestamptz,
  finished_at timestamptz,
  failure_reason text,
  failure_found integer,
  failure_detail text,
  result jsonb                            -- ReplayResult snapshot, written once at finish
);
CREATE INDEX IF NOT EXISTS pr_replays_project ON pr_replays (project_id, started_at DESC);
CREATE TABLE IF NOT EXISTS pr_replay_prs (
  id uuid PRIMARY KEY,
  replay_id uuid NOT NULL,
  idx integer NOT NULL,                   -- 0 = most recently merged
  change_id text NOT NULL, url text NOT NULL, title text NOT NULL, author text,
  head_branch text NOT NULL, base_branch text NOT NULL,
  head_sha text NOT NULL, merge_commit_sha text NOT NULL,
  merged_at timestamptz NOT NULL, additions integer NOT NULL, deletions integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_replay_prs_idx ON pr_replay_prs (replay_id, idx);
CREATE TABLE IF NOT EXISTS pr_replay_finding_views (
  finding_id uuid PRIMARY KEY,
  replay_id uuid NOT NULL,
  first_shown_at timestamptz NOT NULL,
  last_shown_at timestamptz NOT NULL,     -- only moved while the finding is unmarked
  shown_count integer NOT NULL DEFAULT 1
);
ALTER TABLE pr_review_runs ALTER COLUMN pr_review_id DROP NOT NULL;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS replay_id uuid;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS replay_pr_id uuid;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
-- base_sha already exists (GWP-197)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pr_review_runs_one_parent') THEN
    ALTER TABLE pr_review_runs ADD CONSTRAINT pr_review_runs_one_parent
      CHECK ((pr_review_id IS NULL) <> (replay_pr_id IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS pr_review_runs_replay ON pr_review_runs (replay_id, replay_pr_id, reviewer) WHERE replay_id IS NOT NULL;
ALTER TABLE pr_review_findings ALTER COLUMN pr_review_id DROP NOT NULL;
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS replay_id uuid;
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS replay_pr_id uuid;
-- would-post / would-hold is GWP-198's disposition column ('posted' / 'held_back'); posted stays false for replay rows
CREATE INDEX IF NOT EXISTS pr_review_findings_replay ON pr_review_findings (replay_id) WHERE replay_id IS NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_precision_target numeric(3,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_effort_target_hours numeric(4,1);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_targets_replay_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_targets_set_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS review_targets_set_by uuid;
```

- Register `pr_replays`, `pr_replay_prs` and `pr_replay_finding_views` in `PROJECTION_TABLES`
  (`projections/index.ts`).
- In the read model, "would post" means `disposition = 'posted'` and "would hold" means `'held_back'`. The UI and the
  ReplayDto use the words "would be posted" and "held back". **Replay rows never set `posted = true`.** That keeps them
  out of every live read (`f.posted` filter) and of `listPostedFindings`.
- `pr_review_finding_marks.pr_review_id` (NOT NULL) holds the `replay_pr_id` for replay findings. GWP-199's live
  readers of marks join `pr_reviews` or filter `f.posted`, so they ignore these rows.

### 4.4 Server (`apps/server`)

**New `src/commands/pr-replays.ts`:**

- `startReplay(ctx, user, projectId, { repoId })`:
  - `withAppendTx`. Lock the project row. `loadVisibleProject`: a non-member gets 404, and anyone who is not
    `my_role === 'owner'` gets 403 (`forbidden('only the project owner can start a replay')`).
  - The repo must exist, not be removed, and have `pr_only = true`. Otherwise 409 `repo_not_pr_only`.
  - Refuse if there is an active replay (listing, reviewing or marking) for the project: 409 `replay_active`.
  - Pick a workstation with the same query shape as GWP-195's poll in `commands/pr-only.ts`: `workstation_repos` with
    the repo, `w.status='active'`, the capabilities `REPLAY_CAPABILITY`, `PR_REVIEW_CAPABILITY` and
    `PR_LIST_CAPABILITY`, ordered by connected, owner, then `last_seen_at`. The reviewer token
    (`workstation_repos.reviewer_token`) is **not** required, because nothing is posted.
  - With no workstation: append `PrReplayStarted` and `PrReplayFailed { reason: 'no_workstation' }`. The owner then
    sees why on the replay page, and no command is sent.
  - Otherwise append `PrReplayStarted`, `enqueueRunnerCommand(..., 'repo.list_merged_prs', { requestId, replayId, repoId, remoteUrlNormalized, forge, limit: REPLAY_LIST_LIMIT })`,
    and after commit `deliverPending`.
  - Skip simulation orgs (409), as GWP-195 does.
- `applyMergedPrList(ctx, payload, ok, result, error)` (from `applyCommandResult`), in one transaction:
  1. Ignore the answer unless the replay is `listing` and `request_id` matches.
  2. `ok:false` or an unparsable result: `PrReplayFailed { reason }` (`no_clone` → `no_workstation`).
  3. Usable PRs: drop any whose `head` is a card branch of the project (GWP-195's
     `SELECT branch_name FROM cards WHERE project_id=$1 AND branch_name IS NOT NULL`), sort by `mergedAt` descending,
     and remove duplicates by `id`.
  4. **Fewer than 20: `PrReplayFailed { reason: 'not_enough_prs', found: n }`.** No runs start. The message reads
     "This repository has N merged pull requests that can be replayed; the replay needs 20."
  5. Otherwise take the newest 20 and append `PrReplayPrsSelected` (state `reviewing`).
- `dispatchReplayRuns(ctx)` (scheduler, `.catch(log)`):
  - For each `reviewing` replay, the open slots are each `(replay PR × reviewer ∈ REPLAY_REVIEWERS)`. A slot is open
    when it has no run in `running` or `offline_completed`, and its last run is retryable under these rules:
    - `timed_out`: one automatic retry (attempt 2).
    - `failed` with `retryable` (`runtime_unavailable`, `no_checkout`, `head_moved`): retried after 30 minutes, up to
      3 attempts.
    - Anything else is terminal for the slot.
  - **Live first**: skip a workstation that has a GWP-197 eligible live PR waiting (`listReviewablePrs`), or a live run
    in progress. **At most one replay run per workstation at a time**, which gives about 40 runs in sequence. GWP-197's
    `MAX_RUNNING_PER_WORKSTATION = 2` counts replay runs too, so one live slot always stays free.
  - The workstation must still be active with the clone and `REPLAY_CAPABILITY`. With none, wait. The replay page shows
    "Waiting for a workstation".
  - Order: PR idx, with `first` and `second` alternating. The order cannot leak anything, because marking starts only
    after all runs are done.
  - In one transaction: `PrReplayRunStarted` (`runtime`/`model` from `REVIEWER_MODEL[reviewer]`,
    `timeoutMs = PR_REVIEW_TIMEOUT_MS`, the same 10 minutes as live), then
    `enqueueRunnerCommand(tx, ws, 'pr_review.run', payload, expiry)`. The payload is GWP-197's
    `PrReviewRunPayloadSchema`: `prReviewId = replayPrId`, `prNumber = Number(changeId)`, `baseRef = baseBranch`
    (`GitRefSchema`), `reviewer`, `runtime`, `model`, plus `offline: true` and
    `replay: { replayId, replayPrId, headSha, mergeCommitSha }`.
- **One branch in GWP-197's `applyPrReviewRunResult`** (`pr-review-runs.ts:273`): right after
  `SELECT * FROM pr_review_runs WHERE id=$1 FOR UPDATE` and the `running` check, add
  `if (run.replay_id) return applyReplayRunResult(tx, ctx, run, p, ok, parsed, error);`. **Nothing after that line runs
  for a replay run**, so there is no `pr_review.post`, no `pr_reviews` change and no `PrReviewRun*` event. `postTo`
  stays undefined, so no `deliverPending` happens.
- `applyReplayRunResult`:
  - `completed`: `applyFindingsCap(r.findings, r.changedLines)` (GWP-198, the same call as live). Each finding gets a
    `randomUUID()`, as live does. Append `PrReplayRunCompleted` with `rank`, `disposition`, `findingsCap` and
    `changedLines` (run state `offline_completed`).
  - `timeout` → `PrReplayRunTimedOut`. `failed` or a command error → `PrReplayRunFailed`.
  - Then, if every slot is terminal: append `PrReplayReviewsDone` (state `marking`). If there are no would-post findings
    at all, also append `PrReplayMarkingFinished` with the result.
- **Guard on GWP-197's post enqueue.** The only enqueue of `pr_review.post` is the inline call at
  `pr-review-runs.ts:362`. Move it into `enqueueReviewPost(tx, run, post, expiresAt)` in the same file. The helper
  throws `Error('replay runs are never posted')` when `run.replay_id` is set, and the old call site uses it. Also check
  with `grep "'pr_review.post'" apps/server/src` that no other site exists at build time. `applyPrReviewPostResult`
  ignores and logs any result whose run has `replay_id`. This is a backstop, and AC1 tests it.
- **GWP-197's `sweepStalePrReviewRuns`**: its `running` branch builds `PrReviewRunTimedOut` with `run.pr_review_id`,
  which is null for a replay run. Branch on `run.replay_id`: append `PrReplayRunTimedOut { by: 'server' }` to the
  replay stream instead. Its `completed` (post pending) branch matches `state='completed'` only, so it never touches
  `offline_completed`. Add `AND replay_id IS NULL` to that branch anyway.
- `recordFindingShown(ctx, user, findingId)`: owner only. Only for a would-post finding of a `marking` replay that the
  owner has not marked yet. Append `PrReplayFindingShown`, throttled: no event if the last one for this finding was less
  than 5 s ago.
- `markReplayFinding(ctx, user, findingId, { mark })`: modelled on GWP-199's `markFinding`. GWP-199's `markFinding`
  joins `pr_reviews`, so a replay finding gets 404 there. Keep it that way: replay marks only go through this command.
  - Owner only (404 for non-members, 403 for others).
  - 409 `replay_not_marking` unless the replay is in `marking`. 409 `finding_not_markable` for `held_back`.
  - The same mark again is idempotent.
  - Append `PrReviewFindingMarked` (`prReviewId = replay_pr_id`, `runId`, `previousMark`).
  - In the **same transaction**, if this was the last unmarked would-post finding: compute `replayResult(...)` from the
    current marks and the views, and append `PrReplayMarkingFinished { result }` (state `finished`).
  - Returns `{ finding: replayFindingView(..., { revealed: finished }), replay: ReplayDto }`. A changed mark while still
    `marking` is still blind, so the **current** mark counts. After `finished`, marks are read-only (409).
- `cancelReplay(ctx, user, replayId)` and `retryFailedReplayRuns(ctx, user, replayId)`, both owner only:
  - Cancel works from `listing`, `reviewing` or `marking`. Late run results are then ignored, because the run is no
    longer `running` (append `PrReplayRunFailed { code: 'cancelled' }` for running runs, and supersede their pending
    `runner_commands` as the sweep does).
  - Retry works from `marking` when a slot is not reviewed. It reopens those slots with a new attempt, and the state goes
    back to `reviewing` (`PrReplayRetryRequested`).
- `setReviewTargets(ctx, user, projectId, req)`: owner only.
  - 409 `no_finished_replay` unless the project has a `finished` replay (PRD: "using its result as the baseline").
  - Append `ProjectReviewTargetsSet` with the latest finished `replayId`. There is no event when the values are
    unchanged.
  - The values are exactly what the owner typed. Nothing is computed or defaulted.

**New `src/queries/pr-replays.ts`:**

- `getReplay(db, userId, replayId)` → `ReplayDto`. Before `finished`: totals only (`progress`), `result: null`, and no
  reviewer, model, per-reviewer count, per-run duration or run summary anywhere.
- `listReplays(db, userId, projectId)`.
- `nextReplayFinding(db, replayId)`: the first unmarked would-post finding in `replayOrderKey` order (in SQL:
  `ORDER BY p.idx, md5(f.id::text)`), plus `{ position, total }`, the PR (`changeId`, `url`, `title`), and the finding
  through `replayFindingView`. Build the row from `pr_review_findings` and `pr_review_finding_marks`; read the reviewer
  only through `pr_review_finding_attribution`, as GWP-199 does.
- `listReplayFindings(db, replayId, { held?: boolean })`: would-post findings in the same order, through
  `replayFindingView`. `held=1` returns the held-back findings, read-only and blind, shown "on request" as in live.
- `getReviewTargets(db, projectId)`, also added to `getProjectDetail` as `reviewTargets` (an optional DTO field).

**New `src/routes/pr-replays.ts`** (registered in `app.ts`):

| Method and path | Who | Errors |
|---|---|---|
| `POST /api/projects/:id/pr-replays` `{repoId}` → `ReplayDto` | owner | 404, 403, 409 `repo_not_pr_only` / `replay_active` |
| `GET /api/projects/:id/pr-replays` → `ReplayDto[]` | members | 404 |
| `GET /api/pr-replays/:id` → `ReplayDto` | members | 404 |
| `POST /api/pr-replays/:id/cancel`, `POST /api/pr-replays/:id/retry-failed` | owner | 403, 409 |
| `GET /api/pr-replays/:id/next-finding` → `{ finding, pr, position, total } \| null` | members (blind) | 404 |
| `GET /api/pr-replays/:id/findings?held=1` | members (blind) | 404 |
| `POST /api/pr-replay-findings/:id/shown` → 204 | owner | 403, 409 |
| `PUT /api/pr-replay-findings/:id/mark` `{mark}` | owner | 403, 404, 409 |
| `PUT /api/projects/:id/review-targets` `SetReviewTargetsRequest` → `ProjectDetail` | owner | 403, 409 `no_finished_replay`, 400 out of range |

**Other server changes:**

- `runner-gateway/handlers.ts` `applyCommandResult`: a `repo.list_merged_prs` branch (terminal: `completeCommand`, then
  `applyMergedPrList`). `pr_review.run` keeps going through `applyPrReviewRunResult` (handlers.ts ~622), which now
  branches on `replay_id`.
- `scheduler/scheduler.ts`: `await dispatchReplayRuns(ctx).catch(log)`, after `dispatchPrReviews`.
- **New** `projections/pr-replays.ts`:
  - The `PrReplay*` events go into `pr_replays`, `pr_replay_prs`, `pr_replay_finding_views` and the replay rows of
    `pr_review_runs` (`pr_review_id` NULL, `replay_id`, `replay_pr_id`, `attempt`) and `pr_review_findings`
    (`pr_review_id` NULL, `disposition`, `rank`, `posted` false). Do **not** touch `pr_reviews.last_run_id`, which
    GWP-197's `PrReviewRunStarted` projector sets.
  - `PrReplayFindingShown` updates `last_shown_at` only when the finding has no row in `pr_review_finding_marks`.
  - `ProjectReviewTargetsSet` updates the `projects` columns. Put it in `projections/projects.ts`, next to
    `ProjectRegressionLoopSet`.
- **GWP-200's daily cap** has not landed. When it does, its count must use live runs only (`replay_id IS NULL`, or a
  join to `pr_reviews`).

### 4.5 Runner (`apps/runner`)

- `src/forge/types.ts`: optional `listMergedChanges?(repo, limit): Promise<MergedChange[]>`, next to
  `listOpenChanges`.
- `src/forge/github.ts`:
  - Model it on `listOpenChanges`: `gh pr list --repo <full> --state merged --limit <limit> --json number,url,title,author,headRefName,baseRefName,headRefOid,mergeCommit,mergedAt,additions,deletions`.
  - Map `author.login` and `mergeCommit.oid`. Drop rows without a `mergeCommit` oid. Sort by `mergedAt` descending.
  - Exit 127 throws `ForgeUnavailableError`.
  - Other forges leave the method out, and the runner answers `unsupported`.
- `src/runner.ts`:
  - Announce `REPLAY_CAPABILITY` in `hello.capabilities` (next to `PR_REVIEW_CAPABILITY`, ~1605).
  - Add a `repo.list_merged_prs` branch (`findRepo`, then the forge, then `done(true, result)`), modelled on
    `repo.list_prs`.
  - `pr_review.run` (~2325) is unchanged: `this.prReviews.run(p)`.
- `src/review/pr-review-commands.ts` `PrReviewCommands.start`: when `payload.replay` is set, call the same
  `runPrReview` with two different dependencies:
  1. **`heads`** = `resolveReplayBase` (new `src/review/replay-base.ts`), instead of `forge.changeHeads`. It sets
     `this.clones` as the live `heads` does, so `prepare` can find the clone. Under `withRepoLock`:
     - Fetch `baseRef` (the merge commit's branch) when `mergeCommitSha` is not in the clone.
     - `baseSha = git merge-base <mergeCommitSha>^1 <headSha>`. This works for merge, squash and rebase merges, because
       `mergeCommit^1` is the base branch tip when the PR was merged.
     - Return `{ headSha: replay.headSha, baseSha }`. GWP-196's `createReviewCheckout` then fetches
       `refs/pull/<n>/head` and checks it equals the pinned `headSha` (a mismatch is `head_moved`, retryable). Its diff
       is `refs/review/base...HEAD`.
  2. **`prepare`** = `prepareReviewerRun(deps, spec, { requireToken: false })`. **Add this option to GWP-196's
     `prepareReviewerRun`** (`reviewer-sandbox.ts:61`): it skips **only** the `deps.tokens.has(...)` check. The GitHub
     check, the enforced sandbox, the clone check and the read-only checkout stay as they are. The default stays
     `true`, so live runs are unchanged.
  3. **No poster or token is reachable** on this path. `runPrReview` never posts (GWP-197), and `PrReviewCommands.post`
     is a separate command the server never sends for a replay run.
  4. The result is GWP-197's, unchanged: `baseSha`, `changedLines`, findings.
  - Dedupe by `runId` is GWP-197's. Nothing changes there.
- The reviewer prompt and instructions (`instructions.ts`) are **identical for both reviewers** and never name the
  model. This keeps the finding text from revealing who wrote it.

### 4.6 Web (`apps/web`)

All pages follow the standing order for all devices, including touch:
- Tap targets are at least 44 px (`min-h-11`).
- Layouts are stacked at 320 px, with no horizontal-scroll tables.
- Nothing is hover-only, and status is never shown by colour alone.

Text inputs only exist in the targets form. Those inputs use `inputMode="decimal"` so the numeric soft keyboard opens.

- **Entry point**: on GWP-197's Pull requests page (`src/components/pull-requests/PullRequestsPage.tsx`), a "20-PR
  replay" link in the header, which goes to `/p/:projectKey/pull-requests/replay`. Add the routes in
  `src/router.tsx`, next to `/p/:projectKey/pull-requests` (~125): `/p/:projectKey/pull-requests/replay` and
  `/p/:projectKey/pull-requests/replay/:replayId`.
- **New `src/components/pull-requests/PrReplayPage.tsx`** (list and start):
  - Past replays: state, repo, started time, and a finished/failed badge.
  - **Start panel** (owner only), in `src/components/pull-requests/ReplayStartPanel.tsx`:
    - A repo picker, listing PR-only repos only. With one repo, it is shown as text.
    - A note: "Runs 40 offline reviews (Sonnet and Opus on the 20 most recently merged pull requests) on your
      workstation. Nothing is posted to the pull requests. This can take several hours."
    - A **Start replay** button, disabled while a replay is active.
  - Errors appear inline (`ErrorBox`). `not_enough_prs` shows the count.
- **New `src/components/pull-requests/PrReplayDetailPage.tsx`**, by state:
  - `listing` / `reviewing`: the progress line "Reviewing: 23 of 40 reviews done (1 failed)", with no per-reviewer
    numbers. The list of 20 PRs links to GitHub. Refetch every 30 s. A Cancel button for the owner.
  - `failed`: the reason in plain words (no workstation with the clone, not enough merged PRs (N of 20), git host not
    supported, not signed in to the git host).
  - `marking`: **`src/components/pull-requests/ReplayMarkingQueue.tsx`** shows one finding at a time:
    - "Finding 7 of 53", the PR title (external link), `path:line`, severity, title and body (Markdown, as live).
    - GWP-199's **`FindingMark`** with the replay mutation (`useMarkReplayFinding`) passed through the new props, and
      `hint="Reviewers are shown when every finding is marked"`.
    - When a finding is shown, call `POST .../shown` once, from `useEffect` keyed on the finding id. Do not call it again
      on re-renders.
    - After a mark, load the next finding. There is no optimistic update.
    - A "Previous" link lets the owner change an earlier mark while still marking.
    - "Show held-back findings (N)" is a disclosure, read-only and blind.
    - When reviews are missing, show the neutral "1 review did not finish. Retry missing reviews" (owner). Never name
      the reviewer ("Opus did not review 1 PR"), because that would reveal per-reviewer data before the end.
  - `finished`: **`src/components/pull-requests/ReplayResults.tsx`**:
    - Per reviewer (a table on desktop, stacked cards on phones): reviewer and model, PRs reviewed, would-post, useful,
      noise, held back, **precision** (`0.75`, the same format as GWP-199's `ReviewerPrecisionPanel`; "–" when null)
      and marking time.
    - Effort: total active marking time, minutes per PR, minutes per finding, wall-clock span, and "≈ X h per week
      (estimate at N merged PRs per week)".
    - Caption: "Precision = useful ÷ findings that would have been posted (after the findings cap). Marking time counts
      at most 10 minutes per finding."
    - The findings list, now with the reviewer revealed (`FindingMark` marked state, read-only).
  - **`src/components/pull-requests/ReviewTargetsForm.tsx`**, on a finished replay (owner):
    - Two labelled inputs: "Reviewer precision target" (percent, 0–100, saved as 0–1) and "Baseline review effort
      target" (hours per week, 0–168, one decimal).
    - Both are `type="text" inputMode="decimal"` with `aria-describedby` help text, which shows the replay's measured
      value as reference ("Replay: Sonnet 0.70, Opus 0.75" / "Replay estimate: 2.4 h/week").
    - The fields start **empty** when no targets exist. They are never pre-filled from the result, because the targets
      are typed, not computed.
    - **Save** sends PUT. On success: "Targets saved. The rollout is complete." Members see the saved targets
      read-only.
- **New `src/api/queries/pr-replays.ts`**: `useReplays`, `useReplay`, `useStartReplay`, `useNextReplayFinding`,
  `useMarkReplayFinding`, `useRecordShown`, `useCancelReplay`, `useRetryReplay`, `useSetReviewTargets` (invalidates
  `['project', id]`).
- **`src/components/pull-requests/FindingMark.tsx` (GWP-199) gets optional props.** Today it calls
  `useMarkFinding(projectId)` itself and has the hint "Reviewer shown after you mark" built in. Add:

  ```tsx
  export function FindingMark({ finding, projectId, onMark, pending, error, hint }: {
    finding: PostedFindingDto; projectId?: string;
    /** Replay: its own mutation. Absent: the live useMarkFinding(projectId). */
    onMark?: (mark: Mark, done: () => void) => void; pending?: boolean; error?: unknown;
    /** Replaces "Reviewer shown after you mark". */
    hint?: string;
  })
  ```

  Rules of hooks: always call `useMarkFinding(projectId)` and use it only when `onMark` is absent. The live call site in
  `PostedFindings.tsx` does not change. Keep the existing GWP-199 web test green, and add replay cases in the new test
  file.

### 4.7 Docs (`docs/USER-GUIDE.md`)

Add a new subsection, **"20-PR replay and ending the rollout"**, under §4.3c, after the "PR-only reviews" subsection
(`####` level, ~602). Proposed text:

> Before the second, deeper reviewer (Opus) reviews live pull requests, you measure both reviewers offline. On the
> **Pull requests** tab choose **20-PR replay**, pick a PR-only repository and select **Start replay**. Guildwise takes
> the 20 most recently merged pull requests (pull requests from cards are left out; the repository needs at least 20),
> and your workstation reviews each one with Sonnet and with Opus: 40 reviews, each with the usual 10-minute limit,
> one after the other, after any live reviews. **Nothing is posted** to the pull requests and no reviewer token is
> needed. When all reviews are done, mark each finding **Useful** or **Noise**, one at a time. Findings over the
> findings cap are held back, as on live pull requests: you can open them, but they are not marked or counted. You do
> not see which reviewer wrote a finding until every finding is marked. Guildwise times how long each finding takes you
> to mark (at most 10 minutes per finding, so breaks do not count). When the last finding is marked the replay is
> finished and shows, per reviewer, the precision (useful ÷ findings that would have been posted), and your marking
> time: in total, per pull request, and as an estimate in hours per week. Use these figures to type your **targets**
> for reviewer precision and baseline review effort (hours per week) and select **Save**. Saving the targets ends the
> rollout. You can change the targets later; each change is recorded.

## 5. Acceptance criteria mapped to the design and tests

All tests go in **new files**. Use fake models (a mock runtime, or a FakeRunner that answers `pr_review.run`), a fake git
host (stubbed `gh` exec and `fetch`, and a local bare repo), and a fake clock for effort. Copy the fixtures from
GWP-197/198/199's existing server and runner tests.

| AC | Design | Tests |
|---|---|---|
| **AC1**: at least 20 merged PRs → both reviewers review all 20, nothing posted | `startReplay` → `repo.list_merged_prs` → `applyMergedPrList` → `dispatchReplayRuns` (both reviewers, `offline:true`) → the `replay_id` branch in `applyPrReviewRunResult` → `applyReplayRunResult` (never enqueues a post) + the guard in `enqueueReviewPost`; runner `requireToken:false`, no poster on the path | `apps/server/test/pr-replay-run.test.ts` (Postgres): the FakeRunner (capabilities `pr-replay:1`, `pr-review:1`, `pr-list:1`, **no reviewer token**) answers the listing with 25 merged PRs, one on a card branch. Exactly 20 are selected, the newest by `mergedAt`. The dispatch loop gives **40** `pr_review.run` commands, 20 `model:'sonnet'` + 20 `model:'opus'`, all with `offline:true` and a `replay` block. Every run answers `completed` with fixture findings. **Zero `pr_review.post` rows** in `runner_commands`, `pr_reviews` unchanged, no `PrReviewRun*`/`PrReviewPosted` events, no finding with `posted = true`, and the replay state is `marking`. `enqueueReviewPost` for a replay run throws. A `timeout` answer gets one retry. The stale sweep times out a replay run with `PrReplayRunTimedOut`. With 12 usable PRs: `failed`, `not_enough_prs`, `found: 12`, no `pr_review.run`. A non-PR-only repo gives 409. GWP-197's live dispatch with a waiting live PR never sends `opus` (`LIVE_REVIEWERS`). `apps/runner/test/pr-replay-runner.test.ts`: `listMergedChanges` parses `gh` JSON (stubbed exec) and drops rows with no merge commit. `resolveReplayBase` on a local repo with a squash merge and a merge commit gives the expected base. `prepareReviewerRun(..., { requireToken: false })` with an **empty token store** builds the checkout, while the default still refuses `reviewer_token_missing`. A replay `pr_review.run` through `PrReviewCommands` returns `completed` with `baseSha`. The `fetch` spy and the poster spy are never called |
| **AC2**: the owner marks useful/noise without seeing the reviewer | `replayFindingView` (reviewers null until `finished`), `ReplayDto` totals only, run summaries and durations hidden, order by `md5(id)` not id, identical prompt, the marking queue UI, `FindingMark` `hint` | `packages/shared/test/pr-replay.test.ts`: `replayFindingView` with `revealed:false` gives `reviewers: null` **even when `mark` is set**, and `JSON.stringify` holds none of `first`, `second`, `sonnet`, `opus` or the model ids. `replayOrderKey` does not follow id order. `apps/server/test/pr-replay-marking.test.ts` (Postgres): before the last mark, the JSON of `GET /api/pr-replays/:id`, `/next-finding`, `/findings` and the PUT mark response contains no reviewer key or model string (search the whole JSON, case-insensitive). A manager gets 403 on mark and shown, a non-member 404. A `held_back` finding gives 409. Marks land in `pr_review_finding_marks` with `pr_review_id = replay_pr_id`. GWP-199's live `PUT /api/pr-review-findings/:id/mark` on a replay finding gives 404. Live `reviewerPrecisionForProject` is unchanged by replay marks. After the last mark, findings carry `reviewers`. `apps/web/src/test/pr-replay.test.tsx`: the marking queue renders no reviewer text and shows the replay hint, and tapping **Useful** sends PUT `/pr-replay-findings/:id/mark` `{mark:'useful'}` and loads the next finding |
| **AC3**: a finished replay shows precision per reviewer and the recorded effort | `replayResult` (precision from GWP-199's `reviewerPrecision` on would-post findings, called without `posted`; effort from shown/marked times with the 10-minute cap) snapshotted in `PrReplayMarkingFinished`; `ReplayResults.tsx` | `packages/shared/test/pr-replay.test.ts`: fixture with Sonnet 10 would-post (7 useful), 2 held back, and Opus 8 would-post (6 useful) gives 0.70 and 0.75. Held-back findings are not counted. Effort: durations 2, 3 and 25 minutes give 2 + 3 + 10 = 15 min; per PR = total ÷ 20; per-reviewer split; hours/week estimate from the `mergedAt` span; 0 would-post gives precision null and effort 0. `pr-replay-marking.test.ts`: with a fake clock, shown → mark timings give `result.effort.activeMs` as expected, a reload (second shown) restarts the clock, and the replay is `finished` with `result` stored. A mark after finish gives 409. `pr-replay.test.tsx`: results render `0.70`, `0.75` and the effort lines |
| **AC4**: the owner enters the targets and they are saved on the project | `setReviewTargets` → `ProjectReviewTargetsSet` → `projects` columns → `getProjectDetail.reviewTargets`; `ReviewTargetsForm.tsx` | `apps/server/test/review-targets.test.ts` (Postgres): without a finished replay, 409 `no_finished_replay`. The owner PUTs `{precisionTarget: 0.7, effortTargetHoursPerWeek: 3}` → GET project shows both and the `replayId`. The same values again add no event. A manager gets 403. Values 1.2 and -1 give 400. `pr-replay.test.tsx`: the form starts empty, has `inputMode="decimal"`, converts 70 % to 0.7, sends PUT and shows "Targets saved" |

The builder runs the shared, runner and web unit suites. The server suites (`pr-replay-run`, `pr-replay-marking`,
`review-targets`) need Postgres (5433). If the build shift cannot reach it, name them in the handoff for the testers or
DevOps (standing order GWP-99). No e2e tests. The existing GWP-197/199 suites (`pr-review-runs`, marks, the
`FindingMark` web test) must stay green. They cover the live paths this card touches (regression).

## 6. Risks

- **Posting by accident (AC1).** There are three layers: `pr_review.run` never posts (GWP-197), the replay branch
  returns before the only post enqueue, and `enqueueReviewPost` refuses replay runs. The runner path has no token.
  Tests cover each layer.
- **Leaks of the reviewer** through id order, per-reviewer progress, run summaries, durations or model names in the
  text. GWP-199's `findingView` reveals on mark, so `replayFindingView` must override it. Covered in sections 4.4 to
  4.6 and tested by searching the whole JSON. A residual leak remains: a reviewer's writing style. It is inherent and
  accepted.
- **Cost and duration.** 20 Opus runs plus 20 Sonnet runs, up to 10 minutes each and one at a time, so up to about
  7 hours. The start panel says so. Live reviews always go first.
- **Live and replay tables shared.** Any live query on `pr_review_runs`/`pr_review_findings` that neither joins
  `pr_reviews` nor filters `f.posted` must filter `replay_id IS NULL`. At 0663032e, every one does join or filter except
  three: the `pr_review_finding_attribution` view (by finding id only, harmless), the stale sweep (handled in 4.4), and
  `startRun`'s per-workstation busy count (intended: a replay run takes a slot). The builder greps both tables again at
  build time.
- **`reviewerPrecision` drops `posted === false` rows.** If the replay passes the stored `posted` column, every
  precision is null. This is called out in 4.2 and tested by the AC3 fixture.
- **Merged PRs whose head ref is gone** (rare on GitHub: `refs/pull/<n>/head` stays) or whose `headRefOid` differs from
  the ref. The run fails as `no_checkout`/`head_moved` (not retried after 3 attempts). The slot shows as not reviewed,
  and the owner can retry it or accept 19 of 20.
- **Fewer than 20 merged PRs** is a clear failure state, not a partial replay. The owner can start again later.
- **Effort is an approximation.** It does not count reading outside the marking view beyond the 10-minute cap. This is
  stated in the UI and the guide.

## 7. Files

New:
- `packages/shared/src/review/replay.ts`
- `packages/shared/src/events/pr-replay.ts`
- `apps/server/migrations/2950_pr_replay.sql`
- `apps/server/src/commands/pr-replays.ts`
- `apps/server/src/queries/pr-replays.ts`
- `apps/server/src/routes/pr-replays.ts`
- `apps/server/src/projections/pr-replays.ts`
- `apps/runner/src/review/replay-base.ts`
- `apps/web/src/components/pull-requests/PrReplayPage.tsx`
- `apps/web/src/components/pull-requests/PrReplayDetailPage.tsx`
- `apps/web/src/components/pull-requests/ReplayStartPanel.tsx`
- `apps/web/src/components/pull-requests/ReplayMarkingQueue.tsx`
- `apps/web/src/components/pull-requests/ReplayResults.tsx`
- `apps/web/src/components/pull-requests/ReviewTargetsForm.tsx`
- `apps/web/src/api/queries/pr-replays.ts`

Changed:
- `packages/shared`:
  - `src/review/pr-review.ts` (reviewers, `LIVE_REVIEWERS`, run state, payload fields)
  - `src/review/marks.ts` (`PR_REVIEWER_LABEL.second`)
  - `src/review/index.ts`
  - `src/events/project.ts`
  - `src/events/index.ts`
  - `src/ids.ts`
  - `src/protocol/runner.ts`
  - `src/api/projects.ts` (`reviewTargets`)
- `apps/server`:
  - `src/commands/pr-review-runs.ts` (replay branch, `enqueueReviewPost` guard, post-result guard, sweep)
  - `src/runner-gateway/handlers.ts`
  - `src/scheduler/scheduler.ts`
  - `src/projections/index.ts`
  - `src/projections/projects.ts`
  - `src/queries/misc.ts`
  - `src/app.ts`
- `apps/runner`:
  - `src/forge/types.ts`
  - `src/forge/github.ts`
  - `src/runner.ts`
  - `src/review/pr-review-commands.ts` (replay `heads` and `prepare`)
  - `src/review/reviewer-sandbox.ts` (`requireToken` option)
- `apps/web`:
  - `src/router.tsx`
  - `src/components/pull-requests/PullRequestsPage.tsx`
  - `src/components/pull-requests/FindingMark.tsx` (`onMark`/`pending`/`error`/`hint` props)
- `docs/USER-GUIDE.md`

New tests:
- `packages/shared/test/pr-replay.test.ts`
- `apps/server/test/pr-replay-run.test.ts`
- `apps/server/test/pr-replay-marking.test.ts`
- `apps/server/test/review-targets.test.ts`
- `apps/runner/test/pr-replay-runner.test.ts`
- `apps/web/src/test/pr-replay.test.tsx`

## 8. Assumptions, checked against 0663032e

1. **GWP-196: partly wrong, revised.**
   - **Holds**: `createReviewCheckout` takes a fixed `headSha`/`baseSha` and fetches `refs/pull/<n>/head`.
   - **Wrong**: the token check cannot be skipped (`reviewer-sandbox.ts:65`).
   - **Change**: add `requireToken` (default `true`) in this card. The base is passed as a sha through `runPrReview`'s
     `heads` dependency (4.5).
2. **GWP-197: partly wrong, revised.**
   - **Holds**: `pr_review.run` never posts. Findings are one row each with a uuid. Runs carry reviewer and model.
     `applyPrReviewRunResult` is the one entry point.
   - **Wrong**: there is no post helper (the only enqueue is inline at `pr-review-runs.ts:362`). Live dispatch hardcodes
     `'first'`. The ids are v4.
   - **Change**: extract `enqueueReviewPost` with the guard. `pr_review_id` can be made nullable (no foreign keys), so
     the check constraint stays. Reuse GWP-198's `disposition`, with no `replay_disposition`.
3. **GWP-199: partly wrong, revised.**
   - **Holds**: `PrReviewFindingMarked` carries no reviewer (the field is `prReviewId`). The marks projection is a plain
     upsert with no join. The live precision and mark queries join `pr_reviews` and filter `f.posted`, so no
     `replay_id IS NULL` filters are needed.
   - **Wrong**: `FindingMark.tsx` takes no mutation prop.
   - **Change**: add the `onMark`/`pending`/`error`/`hint` props. Call `reviewerPrecision` without `posted`.
     `replayFindingView` wraps `findingView` (`PostedFindingRow`/`PostedFindingDto`).
4. **GWP-195: holds.**
   - `project_repos.pr_only` (+ `pr_only_since`) is in place.
   - `PR_LIST_CAPABILITY = 'pr-list:1'` (`protocol/runner.ts`) is in place.
   - The card-branch rule is `cards.branch_name` (`commands/pr-only.ts`).
5. **GWP-198: holds.**
   - `applyFindingsCap(findings, changedLines)` (`shared/review/findings.ts`, applied on the server) is in place.
   - `changedLines` is optional on the run result.
6. **GWP-200**: has not landed. When it does, its count is live only (4.4).
7. **GWP-204**: has not landed. This card adds `'second'` to `PR_REVIEWERS` and `REVIEWER_MODEL`, and keeps
   `LIVE_REVIEWERS = ['first']`.
8. **GWP-205**: landed with sizing settings only and no targets. Section 3.5 stands.

## 9. Answers to the planning note's open points

1. **Effort measure**: active marking time per finding (last shown → first mark, capped at 10 minutes), summed, split
   per reviewer and per PR, plus an hours-per-week estimate. No self-reported hours (section 3.4).
2. **Where the targets are stored**: `projects` columns written by `ProjectReviewTargetsSet`, owner only, needing a
   finished replay. They are not in GWP-205's settings (section 3.5).
3. **"At least 20 merged PRs"**: the runner lists up to 50 merged PRs. The server drops card-branch PRs and needs 20
   usable ones. With fewer, the replay is `failed` with `not_enough_prs` and the count shown to the owner, and no run
   starts (section 4.4).
4. **GWP-204 gating**: Opus runs only with `offline: true` here. Live dispatch stays on `'first'`
   (`LIVE_REVIEWERS = ['first']`). GWP-204 should be blocked on this card. This card does not record that block,
   because it is GWP-204's dependency.
