# GWP-201 Owner can trigger a PR review by hand, including a re-run of a timed-out PR

Design for the manual review trigger on PR-only repositories (PRD "Review Gates & Reviewer Workflow" v22, F1.5, and
PRD section 5, Owner scenario "triggers reviews by hand"; decision log "Over-cap PR skipped, 'not reviewed', manual
trigger").

**Revision (assumption review after GWP-197 and GWP-200 landed).** The first version of this design was written before
GWP-195/197/200 existed. GWP-200 has since landed most of the server side of a manual trigger: `startPrReviewRun`
with `trigger: 'auto' | 'manual'`, `triggerPrReview`, the route `POST /api/projects/:id/pull-requests/:prReviewId/review`,
the `trigger` / `requested_by` columns, the "not counted" rule and a **Review now** button on queued PRs. This card
now **extends that path**. It does not add a second one. Section 8 lists each assumption and what changed.

The second-timeout rule of F1.5 (the size check runs straight away after a second timeout) is GWP-209. This card only
stores the link GWP-209 needs (section 4.3).

## 1. Question

1. How does the owner start a reviewer run by hand for any PR that is "not reviewed" (queued, over cap, timed out,
   failed), using the one run path (requirement 1, AC1)?
2. How does a manual run get past the daily cap (requirement 2, AC4)?
3. What does the run record store so that "owner-triggered" and "re-run of timed-out run X" can be read later
   (requirement 3, AC2)?
4. How is the trigger refused for anyone but the owner, on the server and not only in the UI (requirement 4, AC3)?

Settled points:
- **Re-run offer.** A re-run is offered only when the PR's **latest** first-reviewer run timed out, and the link always
  points at that run. If the latest run failed (even if an older one timed out), the owner gets **Review now** with no
  link. A reviewed PR has no button.
- **Daily count of a manual run.** Settled by the CEO (ledger a03646c3) and already built by GWP-200: a manual run
  never uses one of the automatic slots. It is counted separately (`manualToday`, "+ n started by hand (not counted)").
  This card changes nothing there.

## 2. Findings: what landed (working branch at 4b5644cf)

### 2.1 Server

- `apps/server/src/commands/pr-review-runs.ts`
  - `startPrReviewRun(ctx, tx, { projectId, prReviewId, trigger, requestedBy, enforceConcurrency })` (line ~122) is
    **the only place a run starts**. It locks the `pr_reviews` row `FOR UPDATE`, refuses `gone` / `closed` /
    `not_eligible` (not `not_reviewed`, or the repo is not PR-only), then:
    - `auto`: `mayStart(tx, prReviewId)` (no run yet, or the last run failed with `no_token`);
    - `manual`: refuses `running` if any run of the PR is `running` or `completed`.
    It then checks `reviewerGate` and `pickReviewerWorkstation` (`not_ready` with a reason detail), applies the
    per-repo and per-workstation limits only when `enforceConcurrency`, appends `PrReviewRunStarted` (with `trigger`,
    `requestedBy`) and enqueues `pr_review.run`. **It has no cap check.** The cap is the dispatcher's
    `item.slot === 'today'` test on `prReviewQueue`.
  - `triggerPrReview(ctx, user, org, projectId, prReviewId): Promise<PrReviewDto>` (line ~236):
    `requireSpendOwner` → project row lock (serialises with the dispatcher) → `startPrReviewRun({ trigger: 'manual',
    requestedBy: user.id, enforceConcurrency: false })` → maps refusals to `404 not found`, `409 pr_closed`,
    `409 review_running`, `409 reviewer_not_ready` (with `reason`), `409 not_reviewable` → `deliverPending` → returns
    the updated `PrReviewDto`.
  - `listPrReviews(db, projectId, ctx?)` returns `PrReviewDto[]` with `queuePosition` / `queueSlot` and
    `lastRun.trigger` (the latest run of any reviewer; today only `first` exists).
- `apps/server/src/commands/pr-review-cap.ts`: `requireSpendOwner` allows the **project Owner or an organization
  Owner/Admin** of that org ("the people who decide spend"; also used by `setPrReviewDailyCap`); anyone else → 403, a
  non-member → 404 (`loadVisibleProject`). `autoReviewsUsed` counts `trigger='auto'` only; `manualReviewsToday` counts
  `trigger='manual'`. There is no queue table: the queue is the candidates that `mayStart` allows, sorted.
- `apps/server/src/review/may-start.ts`: **there is no 30-minute retry.** A PR whose latest run is running, completed,
  posted, timed out or failed is never started again by itself. The one exception is a failure with
  `error_code = 'no_token'` (refused before any model spend: "not an attempt").
- `apps/server/src/review/reviewer-gate.ts`: `reviewerGate` (state `ready` / `reviewer_token_missing`) and
  `pickReviewerWorkstation` (`{ blocked: 'runner_outdated' | 'workstation_offline' }`, `{ busy }`, or a pick;
  `ignoreBusy` for manual runs).
- Route (`apps/server/src/routes/projects.ts` ~140): `POST /api/projects/:id/pull-requests/:prReviewId/review`, params
  only, **no body schema**, `requireOrg`, returns the DTO. `GET /api/projects/:id/pull-requests` uses `requireUser` +
  `loadVisibleProject`.
- Migrations: `2920_pr_review_runs.sql` (`pr_review_runs`, `pr_reviews.last_run_id`) and `2950_pr_review_daily_cap.sql`
  (`pr_review_runs.trigger text NOT NULL DEFAULT 'auto'`, `requested_by uuid`). The next free number is **2960**.
- Event `PrReviewRunStarted` (`packages/shared/src/events/project.ts` ~215) has `trigger:
  PrReviewTriggerSchema.default('auto')` and `requestedBy: Id.nullable().default(null)`. The projection
  `apps/server/src/projections/pr-review-runs.ts` writes both.
- Tests: `apps/server/test/pr-review-daily-cap.test.ts` (its "AC3" block already checks a manual run past the cap,
  `trigger='manual'`, `requested_by`, not counted, 403 for a member, 409 for running and closed),
  `pr-review-runs.test.ts`.

### 2.2 Shared

`packages/shared/src/review/pr-review.ts`: `PR_REVIEW_TRIGGERS`, **`PrReviewTriggerSchema` / `PrReviewTrigger` is
the enum `'auto' | 'manual'`**. The name the first design used for the request payload is taken. `PrReviewDtoSchema`
has `lastRun.trigger` (optional), `queuePosition`, `queueSlot`. `PR_REVIEW_RUN_STATES` and `PR_REVIEW_STATES` are as
assumed.

### 2.3 Web

- `apps/web/src/components/pull-requests/PullRequestsPage.tsx` (not `pages/PullRequests.tsx`):
  - `Queue` lists the queued PRs. For `project.myRole === 'owner'` each has a **Review now** button (`min-h-11`,
    `data-testid="pr-review-now-<changeId>"`) behind a `ConfirmDialog` ("This review is not counted toward the daily
    cap and adds to today's spend"), with an `ErrorBox`.
  - `Row` / `Detail` show the PR list. A timed-out PR shows a warning callout and a failed PR shows a danger callout,
    **with no action**. Timed-out and failed PRs are not in the queue (`mayStart` is false), so today **the owner has
    no button for them**. That gap is this card's main web work.
- `apps/web/src/api/queries/pr-reviews.ts`: `useTriggerPrReview(projectId)` posts `{}` with `prReviewId` as the
  mutation argument, and invalidates `['pull-requests', id]` and `['pr-review-queue', id]`.
- `docs/USER-GUIDE.md` ~line 613 to 614: "A timed-out or failed review ... is only run again by hand" and "**Review
  now** (project Owner) starts a review at once, past the limit; it is not counted".

## 3. What is left for this card

| Requirement / AC | Already landed (GWP-200) | Left here |
|---|---|---|
| R1/AC1 trigger any "not reviewed" PR | Server accepts it for queued, timed-out and failed PRs; button only on queued PRs | Button on timed-out / failed rows; the server computes `manualAction` so button and server agree |
| R2/AC4 past the cap | Yes, tested from the cap side | Test from the trigger side in a new file |
| R3 owner-triggered + re-run link | `trigger='manual'`, `requested_by` | `rerun_of_run_id` (column, event field, projection, DTO) |
| R4/AC3 owner only | `requireSpendOwner` | `manualAction: null` for others; tests in a new file |
| Constraint: no automatic retries | `mayStart` never restarts timed-out / failed runs | A regression test only (no filter needed) |

## 4. Design (revised)

### 4.1 Flow

```
owner taps "Review now" / "Re-run review" (Queue item or PR row) → confirm dialog
  └─ POST /api/projects/:id/pull-requests/:prReviewId/review   body (optional): { previousRunId?: uuid }
       triggerPrReview (existing; one transaction)
         1. requireSpendOwner                                   (403 other roles, 404 non-members)   ← AC3, first
         2. project row lock (existing)
         3. startPrReviewRun({ trigger:'manual', requestedBy, enforceConcurrency:false, expectedPreviousRunId })
              lock pr_reviews row; closed / not eligible as today
              manual: load the latest 'first' run → manualReviewAction()
                running|completed → 'running' ; timed_out → rerun of that run ; else review_now
              expectedPreviousRunId given and ≠ action.previousRunId → 'stale'
              gate + workstation pick as today                   (no cap check: AC4)
              append PrReviewRunStarted { ..., trigger:'manual', requestedBy, rerunOfRunId }
       commit → deliverPending → 200 PrReviewDto (lastRun.rerunOf set for a re-run)
runner + applyPrReviewRunResult / applyPrReviewPostResult / sweep: unchanged
  posted → PR 'reviewed' ; timed_out / failed → stays 'not_reviewed', nothing restarts it   ← AC1
```

### 4.2 Shared (`packages/shared`)

In `src/review/pr-review.ts` (reuse `PrReviewTriggerSchema`; **no second trigger enum**):

```ts
/** Body of POST /api/projects/:id/pull-requests/:prReviewId/review. Empty body = review the PR as it is now. */
export const PrReviewTriggerRequestSchema = z
  .object({
    /** The timed-out run this re-run replaces, as the page showed it. The server checks it is still the latest run. */
    previousRunId: z.uuid().optional(),
  })
  .strict();
export type PrReviewTriggerRequest = z.infer<typeof PrReviewTriggerRequestSchema>;

/** What the viewer may start by hand on a PR; null = nothing (not a spend owner, reviewed, closed, run active, ...). */
export const PrReviewManualActionSchema = z
  .object({ kind: z.enum(['review_now', 'rerun']), previousRunId: z.uuid().nullable() })
  .nullable();
export type PrReviewManualAction = z.infer<typeof PrReviewManualActionSchema>;
```

- `PrReviewDtoSchema`:
  - `manualAction: PrReviewManualActionSchema.optional()` (optional so older fixtures and tests still parse);
  - on `lastRun`: `rerunOf: z.object({ runId: z.uuid(), startedAt: z.string() }).nullable().optional()`.
- Event `PrReviewRunStarted` (`src/events/project.ts`): add `rerunOfRunId: Id.nullable().default(null)` (same style as
  `requestedBy`, so older events still parse).
- Export the new names from the package index.

### 4.3 Data model: `apps/server/migrations/2960_pr_review_rerun.sql`

```sql
-- The timed-out run a manual re-run replaces. Projection of PrReviewRunStarted.rerunOfRunId. No foreign keys.
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS rerun_of_run_id uuid;
CREATE INDEX IF NOT EXISTS pr_review_runs_rerun_of ON pr_review_runs (rerun_of_run_id) WHERE rerun_of_run_id IS NOT NULL;
```

- `trigger` and `requested_by` already exist (2950). **Do not add `trigger` or `triggered_by`.**
- If another migration has taken 2960 by build time, use the next free number.
- Add the new column wherever the test helpers rebuild projections, if they list columns (GWP-199 had to add its marks
  table to "the rebuilt projections": check the same place).
- GWP-209 reads "second timeout" as: a `timed_out` run whose `rerun_of_run_id` points at a `timed_out` run.

### 4.4 Server (`apps/server`)

**New pure function `src/review/manual-action.ts`**, used by both `startPrReviewRun` (manual branch) and
`listPrReviews`, so the button and the server cannot disagree:

```ts
export type ManualActionInput = {
  reviewState: PrReviewState; closed: boolean; prOnly: boolean;
  lastRun: { id: string; state: PrReviewRunState } | null; // latest reviewer='first' run by started_at
};
export type ManualAction =
  | { kind: 'review_now' | 'rerun'; previousRunId: string | null }
  | { refused: 'closed' | 'not_eligible' | 'running' };
// closed                          → refused 'closed'
// !prOnly || reviewState !== 'not_reviewed' → refused 'not_eligible'
// lastRun running | completed     → refused 'running'        (completed = post pending)
// lastRun timed_out               → { kind:'rerun', previousRunId: lastRun.id }
// otherwise (no run, failed)      → { kind:'review_now', previousRunId: null }
```

Queued and over-cap PRs have no run (or a `no_token` failure) and get `review_now`.

**`src/commands/pr-review-runs.ts`:**

- `startPrReviewRun` input gains `expectedPreviousRunId?: string` (manual only). The `StartResult` reason union gains
  `'stale'`, and the started result gains `rerunOfRunId: string | null`.
  - Replace the manual branch's "any live run" query with: load the latest `first` run
    (`SELECT id, state FROM pr_review_runs WHERE pr_review_id=$1 AND reviewer='first' ORDER BY started_at DESC
    LIMIT 1`), then call `manualReviewAction`. A refusal `running` → `{ started:false, reason:'running' }`.
    **Keep the behaviour the same as today**: the latest run is the only one that can be `running`/`completed`
    because a manual start is refused while one is.
  - If `expectedPreviousRunId` is set and differs from `action.previousRunId` → `{ started:false, reason:'stale' }`.
    If it is not set, a re-run is still linked when the latest run timed out: the link is a server fact, not the
    client's choice (AC2). The GWP-200 queue button sends no body and keeps working unchanged.
  - Append `rerunOfRunId: action.previousRunId` (null for `review_now` and for every `auto` run) in
    `PrReviewRunStarted`.
  - The auto branch is unchanged (`mayStart`, the concurrency limits, `rerunOfRunId: null`).
- `triggerPrReview(ctx, user, org, projectId, prReviewId, req: PrReviewTriggerRequest = {})`: pass
  `expectedPreviousRunId: req.previousRunId`. Add the mapping `'stale'` → `conflict('stale_action', 'This pull request
  changed since the page loaded. Refresh and try again.')`. Keep the existing codes and order (`requireSpendOwner`
  first, before the PR is read: AC3). Keep the return type `PrReviewDto`. The first design's
  `{ runId, rerunOfRunId }` response is dropped: the DTO carries `lastRun.rerunOf`.
- **Dropped from the first design** (the landed code decides differently and GWP-200's tests cover it): the separate
  `pr-review-trigger.ts` file, the codes `no_workstation` / `workstation_busy` / `run_in_progress` /
  `already_reviewed` / `not_pr_only` (use the landed `reviewer_not_ready` / `review_running` / `not_reviewable` /
  `pr_closed`), and the 3-per-workstation ceiling for manual runs. GWP-200 settled that manual runs skip the
  concurrency limits, and "one active run per PR" plus the confirm dialog bound a burst.
- **No dispatcher retry filter.** `mayStart` never restarts a timed-out or failed run (the first design's assumption of
  a 30-minute retry was wrong). The only automatic restart is a `no_token` failure. That is refused before any model
  spend, puts the PR back in the queue and uses an automatic slot like any queued PR. Leave it as GWP-197/200 built it.
- `listPrReviews(db, projectId, ctx?, viewer?: { canTrigger: boolean })`:
  - add `run.id AS run_id`, `run.reviewer`, `run.rerun_of_run_id`, the linked run's `started_at`
    (`LEFT JOIN pr_review_runs prev ON prev.id = run.rerun_of_run_id`) and `r.pr_only`;
  - `lastRun.rerunOf = rerun_of_run_id ? { runId, startedAt } : null`;
  - `manualAction`: when `viewer?.canTrigger`, from `manualReviewAction(...)` (the latest run is a `first` run today;
    when GWP-204 adds `second`, use the latest `first` run here), with refusals mapped to `null`. Otherwise `null`.
  - `triggerPrReview`'s own `listPrReviews` call passes `{ canTrigger: true }` (the caller just passed
    `requireSpendOwner`).
- Route `GET /api/projects/:id/pull-requests`: switch to `requireOrg` (as the POST does) to get the org role. Compute
  `canTrigger` with the same rule as `requireSpendOwner`: project `my_role === 'owner'`, or `isOrgManager({ orgRole })`
  and `org.id === p.org_id`. Best is a small non-throwing helper `isSpendOwner(...)` in `pr-review-cap.ts` that
  `requireSpendOwner` also uses, so the rule lives in one place. Check that `requireOrg` accepts every caller the GET
  has today (a project member with an org membership). If it does not, keep `requireUser` and read the org role the way
  `requireOrg` does.
- Route `POST .../review`: add `body: PrReviewTriggerRequestSchema.optional()` (or a default `{}`) to the schema and pass
  `req.body ?? {}`.
- Projection `PrReviewRunStarted`: also write `rerun_of_run_id = p.rerunOfRunId ?? null`.

**Not touched:** the runner, `applyPrReviewRunResult`, `applyPrReviewPostResult`, `sweepStalePrReviewRuns`,
`prReviewQueue` and the cap counts, `mayStart`, the size check (GWP-209), findings and marks (GWP-198/199).

### 4.5 Web (`apps/web`)

- **New** `src/components/pull-requests/PrReviewTriggerButton.tsx`: props `{ pr: PrReviewDto; projectId }`, rendered
  in `Row` (in `PullRequestsPage.tsx`) when `pr.manualAction` is set **and `pr.queueSlot` is null** (queued PRs already
  have **Review now** in the Queue section; do not show two buttons for one PR).
  - Label **Re-run review** for `kind: 'rerun'`, **Review now** for `review_now`.
    `data-testid="pr-review-trigger-<changeId>"`.
  - Same `ConfirmDialog` text as the Queue button (the tap is the owner's spend decision). For a re-run, add: "The last
    run timed out after 10 minutes. A re-run starts a new review now."
  - `Button` with `min-h-11 w-full sm:w-auto`, disabled while the request runs (no second request from a double tap),
    `ErrorBox` under it with the server text (409 messages from 4.4).
  - Sends `{ previousRunId: pr.manualAction.previousRunId ?? undefined }`.
- `useTriggerPrReview` (`src/api/queries/pr-reviews.ts`): change the mutation argument to
  `{ prReviewId, previousRunId? }` and post `{ previousRunId }` (or `{}`). Update the one existing caller (`Queue`) to
  `trigger.mutate({ prReviewId: confirm.prReviewId }, ...)`. Invalidations stay.
- `Detail`: when `lastRun.trigger === 'manual'` add "started by hand" to the running/timeout/failed text, and when
  `lastRun.rerunOf` is set add "Re-run of the run that timed out at <time>". Keep the existing texts and test ids.
- Optional alignment (small, same page): the Queue button shows for `project.myRole === 'owner'` while the server also
  lets an organization Owner/Admin trigger. Showing it when the item's PR row has `manualAction` set (or adding a
  `canTrigger` flag to the queue response) makes them match. Do this only if it stays small. The server rule is the
  source of truth either way.
- **All devices, including touch:** 44 px targets (`min-h-11`), full width on narrow screens, no hover-only
  information, no text input (no soft keyboard). The button is not rendered for viewers without `manualAction`.

### 4.6 Docs

`docs/USER-GUIDE.md`, in the PR-only review section (~line 613 to 614), add a short paragraph **Reviewing a pull
request by hand**:
- Who: the project Owner (and an organization Owner or Admin, the same people who set the daily cap) sees **Review
  now** / **Re-run review**.
- When: on an open, Not reviewed pull request: waiting in the queue (button in the Queue), or after a failed run or a
  timed-out run (button on the pull request row; after a timeout it says **Re-run review** and the new run is recorded
  as a re-run of the timed-out one).
- A run started by hand starts at once, even when today's automatic reviews are used up. It is not counted toward the
  limit and shows as "started by hand". It is extra spend you choose.
- The result follows the run: comments posted and **Reviewed**, or **Not reviewed** again after a timeout or failure.
  Nothing is retried by itself.
- Why it can be refused: a review is already running, no reviewer workstation is ready (token, runner version,
  offline), the page is out of date (refresh).
- Fix the existing "(project Owner)" wording on line 614 so it matches.

## 5. Acceptance criteria mapped to design and tests

All tests go in **new files** (the cap test file of GWP-200 stays unchanged). Server tests use the test DB, the world
helpers, `addMember`, and the `FakeRunner` / `command.result` pattern of `pr-review-runs.test.ts` and
`pr-review-daily-cap.test.ts` (copy their `addPr` / `addRun` helpers locally, or move them to a shared helper if both
files can use it without changing their behaviour).

| AC | Design | Test (new file) |
|---|---|---|
| AC1 trigger starts a run; PR state follows the result | `triggerPrReview` → `startPrReviewRun` → existing result handling | `apps/server/test/pr-review-manual-trigger.test.ts`: owner POSTs on a `not_reviewed` PR whose run **failed** (not in the queue) → 200 DTO with `lastRun.state='running'`, `trigger='manual'`; the fake runner receives `pr_review.run`; the run row has `requested_by=owner`, `rerun_of_run_id` null. (a) Answer `completed`, then the post `ok` → PR `reviewed`, `manualAction` null. (b) Answer `failed` → PR stays `not_reviewed`, `manualAction.kind='review_now'` again. Refusals with no new run row: reviewed PR → 409 `not_reviewable`; PR with a `running` run → 409 `review_running`; closed → 409 `pr_closed`; no ready reviewer → 409 `reviewer_not_ready`. Two POSTs at once → one 200 and one 409. Empty body still works (the Queue button). |
| AC2 re-run of a timed-out run is recorded as such | `manualReviewAction` → `rerun`; `rerun_of_run_id` | `apps/server/test/pr-review-rerun.test.ts`: first run answers `timeout` (or is timed out by the sweep) → owner GET shows `manualAction {kind:'rerun', previousRunId: firstRun}`; POST with it → new run with `rerun_of_run_id=firstRun`, `trigger='manual'`; DTO `lastRun.rerunOf.runId=firstRun`. POST without a body also links. Wrong `previousRunId` → 409 `stale_action`, no run row. Latest run `failed` with an older timed-out run → `review_now`, link null, and sending the old id → 409 `stale_action`. Re-run answers `timeout` → PR stays `not_reviewed`, and a scheduler pass (`dispatchPrReviews`) enqueues no `pr_review.run` (no automatic retry); `manualAction` is `rerun` of the second run. An event replay or projection rebuild keeps `rerun_of_run_id`; an old `PrReviewRunStarted` without the field projects null. |
| AC3 non-owner refused | `requireSpendOwner` first; `manualAction` null for others | `apps/server/test/pr-review-trigger-permissions.test.ts`: a project member from `addMember` → 403 on POST, no event appended, no `pr_review.run` enqueued, run count unchanged; not a member of the project → 404; the member's GET shows `manualAction: null` on every PR while the owner's shows actions. An organization Admin who is not a project owner → allowed, and `manualAction` is set (the GWP-200 spend-owner rule). |
| AC4 cap used up, owner trigger still starts | Manual path never consults `prReviewQueue` / the cap | `apps/server/test/pr-review-trigger-cap.test.ts`: set the cap to 1 and use it up today with an automatic run; precondition: a scheduler pass starts nothing for a queued PR (slot `later`). Then (a) owner POSTs on the queued PR → run starts; (b) owner re-runs a PR whose run timed out → run starts with the link. The queue shows `used` unchanged and `manualToday` +1 per PR. |
| No automatic retries | `mayStart` unchanged | In `pr-review-rerun.test.ts` (above) and `pr-review-manual-trigger.test.ts`: a manual run that fails (`model_error`) is not started by a scheduler pass after the clock moves on 1 hour. |
| Web (touch, owner only) | `PrReviewTriggerButton` | `apps/web/src/test/pr-review-trigger.test.tsx`: a timed-out row with `manualAction rerun` shows **Re-run review** and the hint; a failed row with `review_now` shows **Review now**; no button when `manualAction` is null or the PR is in the queue; confirming POSTs `{ previousRunId }` once (button disabled while pending); a 409 shows the server text; the button has `min-h-11`; the Queue button still posts `{}`. |

Regression: `pr-review-runs.test.ts`, `pr-review-daily-cap.test.ts`, `pr-review-findings-cap.test.ts`,
`pr-review-marks.test.ts`, `pr-only-*.test.ts`, and the web `pull-requests.test.tsx` and `pr-review-queue.test.tsx`
must pass unchanged (only the `useTriggerPrReview` call signature changes for the Queue). `e2e/tests/pr-review-daily-cap.spec.ts`
is the tester's. Its Review now flow must still work (empty body).

## 6. Risks and traps

- **One run path.** Extend `startPrReviewRun` / `triggerPrReview`. Do not add a new command file, a new route or a
  runner change.
- **Name clash.** `PrReviewTrigger` is already the `'auto' | 'manual'` type. The request type is
  `PrReviewTriggerRequest`.
- **Old events.** `rerunOfRunId` must default to null in the event schema.
- **Server-derived link.** The client's `previousRunId` is only a staleness check. Without it the server still links.
- **Auth on the GET.** Switching the GET to `requireOrg` must not lock out project members who could read the list
  before. Test the member GET in the permissions file.
- **Duplicate buttons.** A queued PR keeps its Queue button only. The row button is for PRs outside the queue.
- **Second reviewer.** Only `first` runs are started or looked at. Whether a manual trigger also starts the Opus run is
  GWP-204's decision.

## 7. Out of scope (follow-ups)

- Reviewing a PR that GWP-195 did not record (opened before PR-only was on).
- Re-reviewing a `reviewed` PR after new commits.
- The size check after a second timeout (GWP-209), which reads `rerun_of_run_id`.

## 8. Assumption review against the landed code

| # | Assumption | Result | What changed |
|---|---|---|---|
| 1 | Runs in `pr_review_runs` (`reviewer`, `state` running/completed/posted/timed_out/failed, `started_at`); PR state `pr_reviews.review_state` not_reviewed/reviewed | **Holds** | Also `pr_reviews.last_run_id` exists (not needed here). |
| 2 | Dispatcher's one start step can be extracted as `startPrReviewRun` | **Did not hold (already done)** | GWP-200 extracted it with a different signature and also built `triggerPrReview` and the route in `pr-review-runs.ts`. This card extends both (4.4). There is no new `pr-review-trigger.ts`. |
| 3 | Readiness check returns a reason when none is ready | **Holds in substance, codes differ** | `reviewerGate` + `pickReviewerWorkstation`. `triggerPrReview` already answers 409 `reviewer_not_ready` with `reason`. The `no_workstation` code and the 3-per-workstation `workstation_busy` ceiling are dropped (manual runs skip the concurrency limits by GWP-200's design). |
| 4 | Cap checked only in the automatic dispatch path; counts from `pr_review_runs`; no queue table | **Holds** | Manual runs never use a slot (CEO ledger a03646c3), and `manualToday` is shown. |
| 5 | GWP-200 may add its own trigger column/kind | **It did; design reused it** | `trigger` and `requested_by` exist (2950), with `PrReviewTriggerSchema` in shared and on the event. Drop `trigger`/`triggered_by` and the second enum. Only `rerun_of_run_id` is added (2960). |
| 6 | Dispatcher retries retryable failed runs after 30 minutes | **Did not hold** | `mayStart` never restarts timed-out or failed runs (only `no_token`). No dispatcher filter. The no-retry test stays. |
| 7 | GWP-197 delivers the Pull requests tab, `PrReviewDto`, `listPrReviews`, `usePullRequests` | **Holds, paths and existing button differ** | The page is `components/pull-requests/PullRequestsPage.tsx`. GWP-200 already has **Review now** on Queue items (`useTriggerPrReview`, ConfirmDialog). The new button goes on rows outside the queue (timed-out / failed). `manualAction` is computed by the server. The trigger returns the DTO. |

## 9. Files

New:
- `apps/server/migrations/2960_pr_review_rerun.sql`
- `apps/server/src/review/manual-action.ts`
- `apps/web/src/components/pull-requests/PrReviewTriggerButton.tsx`

Changed:
- `packages/shared/src/review/pr-review.ts` (request schema, `manualAction`, `lastRun.rerunOf`) and the package index
- `packages/shared/src/events/project.ts` (`PrReviewRunStarted.rerunOfRunId`)
- `apps/server/src/commands/pr-review-runs.ts` (`startPrReviewRun` manual branch, `triggerPrReview` body + `stale_action`,
  `listPrReviews` viewer + fields)
- `apps/server/src/commands/pr-review-cap.ts` (non-throwing `isSpendOwner`, used by `requireSpendOwner`)
- `apps/server/src/projections/pr-review-runs.ts`
- `apps/server/src/routes/projects.ts` (POST body schema; GET passes `canTrigger`)
- `apps/web/src/components/pull-requests/PullRequestsPage.tsx` (row button, detail text, Queue mutate call)
- `apps/web/src/api/queries/pr-reviews.ts` (`useTriggerPrReview` argument)
- `docs/USER-GUIDE.md`

New tests:
- `apps/server/test/pr-review-manual-trigger.test.ts` (AC1, no retry)
- `apps/server/test/pr-review-rerun.test.ts` (AC2, no retry)
- `apps/server/test/pr-review-trigger-permissions.test.ts` (AC3)
- `apps/server/test/pr-review-trigger-cap.test.ts` (AC4)
- `apps/web/src/test/pr-review-trigger.test.tsx` (web, touch)
