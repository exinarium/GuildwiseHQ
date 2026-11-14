# GWP-200 Daily cap: 20 automatic reviews per project per day, queue oldest first, owner trigger goes past it

This design covers PRD "Review Gates & Reviewer Workflow" v22, F1.4 and the Capacity NFR ("a cost constraint, not a
goal-bearing feature: it exists to limit spend, and the owner decides extra spend"). It sits on top of GWP-197 (the
first reviewer run), and GWP-197 sits on top of GWP-195 (the PR-only switch and the `pr_reviews` table). Both have now
landed on `main`. Section 0 records how the design was checked against the landed code. Section 8 lists the original
assumptions and their status.

## 0. Assumption review against the landed code (2026-11-13, `main` at 19d6ae65)

The design was written before GWP-197 landed. Each assumption was checked against the landed code. The rules (cap
setting, day window, distinct-PR count, derived queue, strict admission window, one start function, manual bypass) are
unchanged. What changed is where the hooks attach:

| # | Assumption | Status | Landed code |
|---|---|---|---|
| 1 | `pr_review_runs` and `PrReviewRunStarted` as designed | Holds | `migrations/2920_pr_review_runs.sql` has `project_id`, `pr_review_id`, `reviewer`, `state`, `started_at`, `workstation_id`. The event is in `packages/shared/src/events/project.ts` ~202. **The migration number changes**: the landed numbers are 2900/2910/2920, so this card's migration is `2930_pr_review_daily_cap.sql`, not 2902 |
| 2 | `dispatchPrReviews` on the 15 s pass is the only automatic start | Holds | `scheduler.ts` (`TICK_MS = 15_000`) calls `dispatchPrReviews`. `PrReviewRunStarted` is appended only in the private `startRun` (`commands/pr-review-runs.ts` ~94) |
| 3 | `opened_at` is the forge created time; listing is `gh pr list --json` | Holds | `apps/runner/src/forge/github.ts` ~159 (`number,url,title,author,headRefName,baseRefName,createdAt`). `applyPrListResult` (`commands/pr-only.ts` ~245) stores `openedAt` from `createdAt` |
| 4 | GWP-196 readiness is callable per repo and returns a reason | **Partly** | `reviewerGate(db, repoId)` (`review/reviewer-gate.ts`) is callable and returns `ready` or `reviewer_token_missing` with a `problem`. But it checks only the token. The capability (`pr-review:1`) and `connected` checks, and the per-workstation busy limit, are inline in `startRun`. `listReviewablePrs` drops gated PRs, so it cannot feed a queue that shows them as blocked. **Revised in section 4.3** |
| 5 | GWP-197 adds the Pull requests tab and `PrReviewDto` | Holds | Tab at `/p/:projectKey/pull-requests` with `apps/web/src/components/pull-requests/PullRequestsPage.tsx` (not `src/pages/PullRequests.tsx`). `PrReviewDtoSchema` is in `packages/shared/src/review/pr-review.ts` ~184. Hooks are in `apps/web/src/api/queries/pr-reviews.ts` |
| 6 | Timed-out and model-error PRs are never restarted automatically | Holds | `mayStart` (`commands/pr-review-runs.ts` ~79): `running`, `completed`, `posted` and `timed_out` never start again, and a `failed` run starts again only when `error_code = 'no_token'`. So the only automatic retry is a `no_token` retry, and it does not add to the day's count (the count is distinct PRs) |

Other landed details the builder must follow (these are names, not rule changes):

- **The eligibility filter is `listReviewEligiblePrs` (`commands/pr-only.ts` ~304) plus `mayStart`.** GWP-197 did not
  add the "a retryable failure older than 30 min, 3 attempts" rule. Export `mayStart` (or a batched version that takes
  the PR ids) and reuse it. Do not copy it.
- **The landed `startRun` opens its own transaction per PR** (`withAppendTx`) and locks the `pr_reviews` row. It
  becomes `startPrReviewRun(ctx, tx, …)`, which takes the transaction from the caller. The dispatcher opens one
  transaction per project (section 4.3).
- **`PrReviewRunStarted` has no trigger yet.** Add `trigger` and `requestedBy` with defaults, as designed.

## 1. Question

1. How do we count "automatic reviews per project per day", and what counts as a "day"?
2. How are PRs past the cap kept in a queue, and how does the dispatcher drain it on later days, oldest first, with the
   smaller PR first when two PRs are the same age?
3. How does an owner's manual trigger go past the cap without opening a second start path?
4. Where does the owner see today's used count (n/20) and the queue in run order?

The card leaves these points open. This design settles them (section 3 gives the reasons):

| Open point | Decision |
|---|---|
| Is 20 fixed or a per-project setting? | **A per-project setting, `projects.pr_review_daily_cap`, default 20, range 1 to 100. Only the owner changes it.** The PRD summary says "The owner sets all limits per project, because every organization differs". The boardroom's "Max 20 PRs per project per day" supplies the default. The "no defaults" decision in the PRD's decision log covers the size budget and the risk map only, not the cap. |
| Which time zone defines "day"? | **The organization's reporting time zone** (the Owner's `users.timezone`, read through `reportingOf()`), with UTC when it is not set. Costs (month budget) and the daily reports already use this time zone. |
| Do owner manual triggers count toward the 20? | **No.** The card says so, and the decision log says "owner decides extra spend". A manual run does not use up a slot and is not refused when the cap is used up. |
| What counts as one review? | **One PR that got an automatic review run that day.** The count is the distinct PRs with an automatic run started that day. A retry of the same PR that day (in the landed code only a `no_token` retry), or the second reviewer (GWP-204) on the same PR, does not add to the count. Timed-out and failed runs still count, because they spent the model time. |
| "Same age" granularity | **The same local calendar day of the PR's `opened_at`** (the forge's created time), in the same time zone. With full timestamps two PRs are almost never the same age, so the PRD's tie-break would never apply. |
| Queue by open time or eligibility time? | **By open time (`opened_at`).** GWP-195 only records PRs opened after the repo became PR-only, so open time and the time a PR becomes eligible are close anyway, and open time is the "age" the owner sees on GitHub. |
| Who carries the manual bypass, GWP-200 or GWP-201? | **GWP-200 carries the rule and the server entry point.** That is one start function with `trigger: 'auto' \| 'manual'`, plus an owner-only "Review now" for queued PRs. GWP-201 (which depends on this card) extends it: re-running timed-out and failed PRs, its wording, and the second-timeout path with GWP-209. |

## 2. Findings

### 2.1 Platform pieces this design uses

- **Clock.** All server time goes through `ctx.clock.now()` (`apps/server/src/clock.ts`). Tests move it with
  `t.clock.advance(ms)` / `t.clock.setOffset(ms)` (for example `apps/server/test/lease-reaper.test.ts`). The scheduler
  says "Tests call `run()` after moving the test clock" (`scheduler/scheduler.ts` ~38).
- **Organization time zone.**
  - `reportingOf(db, orgId).timezone` (`apps/server/src/ceo/prefs.ts:21`) is the Owner's `users.timezone`, or null.
  - `orgCostCtx` uses it with `?? 'UTC'` (`apps/server/src/costs/index.ts:31`).
- **Shared day helpers** (`packages/shared/src`):
  - `localParts(date, tz)` (`reporter/index.ts` ~123) returns `{ date: 'YYYY-MM-DD', minutes }` and falls back to UTC
    for an unknown zone.
  - `zonedDayStart(ymd, tz)` and `nextDay(ymd)` (`costs/index.ts:361`, `:367`).
  - So a local day window `[start, next)` needs no new date maths.
- **Per-project setting pattern.** For a numeric value:
  - `ConcurrencyCapPanel.tsx` (number input, 1..50, `inputMode="numeric"`) and `PUT /api/projects/:id/concurrency-cap`
    (`routes/projects.ts`).
  - For an owner-only guard: `setRegressionLoop` (`commands/projects.ts`, project Owner or org Owner/Admin).
  - It appends a `Project…Set` event, a projector updates `projects` (`projections/projects.ts`), and
    `queries/misc.ts` maps it into the project DTO.
- **Migrations.** The highest number on `main` is `2920_pr_review_runs.sql`. This card uses 2930.

### 2.2 What GWP-195 and GWP-197 landed

- **GWP-195:**
  - `pr_reviews` has one row per PR: `opened_at`, `review_state`, `closed_at`, and more.
  - `PrReviewRecorded` and `PrReviewClosed` events. `applyPrListResult` (`commands/pr-only.ts`) records new PRs and
    closes missing ones. It does not update known open PRs.
  - The runner's GitHub `listOpenChanges` returns `OpenChange { id, url, title, author, head, base, createdAt }`. It has
    **no size**.
  - `listReviewEligiblePrs(db, projectId)` lists open, `not_reviewed` PRs of live PR-only repos.
- **GWP-196 / GWP-197:**
  - `reviewerGate(db, repoId)` and `listReviewablePrs(db, projectId)` (`review/reviewer-gate.ts`). The latter is "THE
    ONLY LIST a reviewer dispatcher may take work from" and keeps only PRs of repos whose gate is `ready`.
  - `pr_review_runs` has one row per run, with `reviewer`, `state`, `started_at`, `workstation_id`, and more.
  - Events: `PrReviewRunStarted`, `PrReviewRunCompleted`, `PrReviewRunTimedOut`, `PrReviewRunFailed`, `PrReviewPosted`.
  - `dispatchPrReviews(ctx)` runs on each scheduler pass (15 s). Per project it walks `listReviewablePrs` (oldest
    first), skips PRs that `mayStart` refuses, and calls `startRun`. `startRun` locks the PR row, checks the gate again,
    picks a connected workstation with the `pr-review:1` capability and fewer than 2 running reviews, and checks that
    the repo has no running review. Then it appends `PrReviewRunStarted` and enqueues `pr_review.run`, all in one
    transaction.
  - The project **Pull requests** tab (`/p/:projectKey/pull-requests`, `PullRequestsPage.tsx`) lists PRs with their
    latest run.
  - A timed-out PR, or one whose run failed (other than `no_token`), is **never started again automatically**.

### 2.3 The gap: changed lines

The tie-break needs each PR's changed lines, and neither dependency stores them. GitHub's `gh pr list --json` returns
`additions` and `deletions` per PR in the same call GWP-195 already makes. This card adds them to `OpenChange` and
stores `changed_lines = additions + deletions` on `pr_reviews`. The size check (GWP-209) and the findings cap (GWP-198)
can read the same column later.

## 3. Options

### 3.1 How the queue is kept

| | A. A persisted queue table (enqueue on cap hit, dequeue on start) | B. **A derived queue**: eligible PRs not yet started, sorted by one ordering function |
|---|---|---|
| Single source of truth | No. The queue rows and `pr_reviews`/`pr_review_runs` can drift (closed PR still queued, PR-only switched off) | Yes. It is `listReviewEligiblePrs` plus `mayStart` plus a sort |
| Projection rebuild | Needs extra events (`PrQueued`/`PrDequeued`) | Nothing new to rebuild |
| A PR that grows (changed lines) or closes | Must update the queue row | Picked up on the next read |
| Read model for AC4 | A simple select | The same query plus the sort, shared by the dispatcher and the API |

**Choice: B.** "Queued" is not a stored state. It means "eligible, not started, and not inside today's admitted set".
The PR keeps `review_state = 'not_reviewed'` (AC1) all along.

### 3.2 How the cap is counted

| | A. A counter row per project and day, incremented on start | B. **Count the runs**: distinct PRs with an automatic run started inside today's window |
|---|---|---|
| Correct after a crash or rebuild | The counter can drift from the runs | Always matches `pr_review_runs` |
| Time zone change mid-day | The stored day key is wrong | The window is computed again each time |
| Cost | One row | One indexed count per project per pass (small) |

**Choice: B.** Add `pr_review_runs.trigger` and an index on `(project_id, started_at) WHERE trigger = 'auto'`.

### 3.3 Admission at the cap boundary (strict oldest-first)

GWP-197's concurrency limits (1 per repo, 2 per workstation) can stop the head of the queue from starting right away.
If the dispatcher simply skipped it and started the next PR, a younger PR could take the day's last slot, and the
oldest PR would wait another day. That breaks AC2.

**Rule:** `remaining = cap - usedToday`. Only the first `remaining` PRs of the queue (the **admission window**) may
start today. Inside the window the dispatcher starts whatever concurrency allows, in queue order. A PR blocked only by
concurrency keeps its place in the window and starts as soon as a slot frees up. Which PRs run on a day is therefore
always "the oldest `remaining` PRs", whatever the concurrency.

One exception keeps a dead PR from holding a slot all day: a PR whose repo has **no ready reviewer workstation** does
not count toward the window. The queue view still lists it at its place in run order, with the reason. With the landed
code, "no ready reviewer workstation" means one of these (section 4.3 says where each check lives):

- the gate is not `ready` (no comment-only reviewer token: `reviewer_token_missing`, with its `problem`);
- none of the gate's workstations has the `pr-review:1` capability (`runner_outdated`);
- none of the capable workstations is connected (`workstation_offline`).

A connected, capable workstation that is only busy (2 running reviews), or a repo with a running review, is
concurrency. The PR keeps its slot.

### 3.4 Manual triggers

| | A. A separate manual start path in GWP-201 | B. **One `startPrReviewRun(tx, { trigger })`**: the dispatcher passes `'auto'`, the owner action passes `'manual'` |
|---|---|---|
| The bypass rule lives in one place | No | Yes. Only `'auto'` checks the cap and is counted |
| GWP-201 re-run and GWP-209 second timeout | Copy the start logic | Call the same function |

**Choice: B.** The planner asked for exactly this: "the bypass should be one rule in the dispatcher and not a second
path".

## 4. Design

### 4.1 Shared (`packages/shared`)

Extend `src/review/pr-review.ts` (GWP-197's file).

```ts
export const PR_REVIEW_TRIGGERS = ['auto', 'manual'] as const;
export const PrReviewTriggerSchema = z.enum(PR_REVIEW_TRIGGERS);
export type PrReviewTrigger = z.infer<typeof PrReviewTriggerSchema>;

/** Boardroom default; the owner sets the cap per project (PRD summary: "The owner sets all limits per project"). */
export const PR_REVIEW_DAILY_CAP_DEFAULT = 20;
export const PR_REVIEW_DAILY_CAP_MAX = 100;
export const PrReviewDailyCapSchema = z.number().int().min(1).max(PR_REVIEW_DAILY_CAP_MAX);

/** The local calendar day of `at` in `timeZone` (UTC when unknown), with its [start, next) instants. */
export function reviewDayOf(at: Date, timeZone: string | null | undefined): { day: string; start: Date; next: Date } {
  const day = localParts(at, timeZone).date;
  return { day, start: zonedDayStart(day, timeZone), next: zonedDayStart(nextDay(day), timeZone) };
}

export interface QueueCandidate { id: string; openedAt: Date; changedLines: number | null }
/**
 * Run order of the queue (PRD v22 F1.4): oldest first by the local day the PR was opened; the same day: fewer changed
 * lines first (unknown size last); then the earlier open time; then the id (stable).
 */
export function compareQueue(tz: string | null | undefined) {
  return (a: QueueCandidate, b: QueueCandidate): number => {
    const da = localParts(a.openedAt, tz).date, db = localParts(b.openedAt, tz).date;
    if (da !== db) return da < db ? -1 : 1;
    const la = a.changedLines ?? Number.POSITIVE_INFINITY, lb = b.changedLines ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    if (a.openedAt.getTime() !== b.openedAt.getTime()) return a.openedAt.getTime() - b.openedAt.getTime();
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** How many automatic reviews may still start today (never negative: the owner may lower the cap mid-day). */
export const autoReviewsLeft = (used: number, cap: number): number => Math.max(0, cap - used);
```

`localParts`, `zonedDayStart` and `nextDay` already exist. Import them, do not copy them. If importing
`reporter/index.ts` into `review/` causes a cycle, move `localParts` to a small `time/local-day.ts` and re-export it
from the old place.

**`OpenChangeSchema`** (`pr-review.ts` ~20): add `changedLines: z.number().int().nonnegative().nullable().optional()`,
which is additions plus deletions, or null when the forge does not say.

**Events** (`src/events/project.ts`):
- `PrReviewRunStarted` (~202): add
  `trigger: PrReviewTriggerSchema.default('auto'), requestedBy: Id.nullable().default(null)`. With the default, events
  stored before this change still read as automatic.
- New `PrReviewSizeChanged { projectId, repoId, prReviewId, changedLines: number | null }`. `applyPrListResult`
  appends it when a listed PR's `changedLines` differs from the stored value.
- `PrReviewRecorded` (~183): add `changedLines: z.number().int().nonnegative().nullable().default(null)`.
- New `ProjectPrReviewCapSet { projectId, cap: number, by: Id }`.

**API DTOs** (in `src/review/pr-review.ts`, next to `PrReviewDtoSchema`):

```ts
export const PR_REVIEW_BLOCKED_REASONS = ['reviewer_token_missing', 'runner_outdated', 'workstation_offline'] as const;
export const PrReviewQueueItemSchema = z.object({
  prReviewId: z.uuid(), position: z.number().int().positive(),        // 1 = runs next
  repoId: z.uuid(), repoName: z.string(), changeId: z.string(), title: z.string(), url: z.string(),
  author: z.string().nullable(), openedAt: IsoTime, openedDay: z.string(), changedLines: z.number().int().nullable(),
  /** today: inside today's admission window; later: waits for a following day; blocked: no ready reviewer (reason). */
  slot: z.enum(['today', 'later', 'blocked']),
  blockedReason: z.enum(PR_REVIEW_BLOCKED_REASONS).nullable(),
  /** The gate's problem when the reason is reviewer_token_missing ('unreadable' | 'unsupported_host' | null). */
  blockedProblem: z.string().nullable(),
});
export const PrReviewQueueDtoSchema = z.object({
  day: z.string(), timeZone: z.string(), resetsAt: IsoTime,
  used: z.number().int().nonnegative(), cap: z.number().int().positive(),
  manualToday: z.number().int().nonnegative(),                          // shown, never counted
  items: z.array(PrReviewQueueItemSchema),
});
export const SetPrReviewCapRequestSchema = z.object({ cap: PrReviewDailyCapSchema });
```

- `PrReviewDto` gains `queuePosition: number | null` and `queueSlot: 'today' | 'later' | 'blocked' | null`, so the PR
  row can say why it waits. `lastRun` gains `trigger`.
- The project DTO (`ProjectDetailResponse['project']`) gains `prReviewDailyCap: z.number().int().optional()`.

### 4.2 Data model: migration `apps/server/migrations/2930_pr_review_daily_cap.sql`

The number comes after `2920_pr_review_runs.sql`. Re-check the highest number at build time.

```sql
-- Daily cap on automatic PR reviews (PRD v22 F1.4 / Capacity NFR). Projections of ProjectPrReviewCapSet,
-- PrReviewRunStarted.trigger and PrReviewRecorded/PrReviewSizeChanged.
ALTER TABLE projects       ADD COLUMN IF NOT EXISTS pr_review_daily_cap integer NOT NULL DEFAULT 20;
ALTER TABLE pr_reviews     ADD COLUMN IF NOT EXISTS changed_lines integer;          -- additions + deletions; NULL: unknown
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'auto';   -- auto | manual
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS requested_by uuid;              -- the owner, for manual runs
CREATE INDEX IF NOT EXISTS pr_review_runs_auto_day ON pr_review_runs (project_id, started_at) WHERE trigger = 'auto';
```

- No new projection table, so `PROJECTION_TABLES` does not change. `projects` already rebuilds from its events.
- Add a CHECK `pr_review_daily_cap BETWEEN 1 AND 100` only if the other project settings use CHECKs. Otherwise zod is
  the guard.

### 4.3 Server (`apps/server`)

**Readiness, extracted (revised after the assumption review, see section 0 #4).** In `src/review/reviewer-gate.ts`:

- Move the workstation pick out of `startRun` into
  `pickReviewerWorkstation(db, gate): Promise<{ id: string } | { busy: true } | { blocked: 'runner_outdated' | 'workstation_offline' }>`.
  It runs the same capability/connected/busy query `startRun` runs today (`workstation_capabilities` has
  `PR_REVIEW_CAPABILITY`, `connected`, fewer than `MAX_RUNNING_PER_WORKSTATION` running). No capable workstation is
  `runner_outdated`. Capable ones exist but none is connected: `workstation_offline`. Capable and connected, but all
  busy: `busy` (concurrency, the PR keeps its slot). Move `MAX_RUNNING_PER_WORKSTATION` with it.
- Add `listQueueCandidates(db, projectId)`, which returns `listReviewEligiblePrs` with each PR's gate (one
  `reviewerGate` call per repo, as `listReviewablePrs` does today). Rewrite `listReviewablePrs` as a filter over it
  (gate `ready`), so there is still one list and its comment ("THE ONLY LIST a reviewer dispatcher may take work from")
  stays true. The dispatcher only starts `slot:'today'` items, and those always have a `ready` gate.

**New `src/commands/pr-review-cap.ts`.** It holds the cap and the queue. `pr-review-runs.ts` imports from it.

- `reviewDayFor(db, orgId, now)`: `reviewDayOf(now, (await reportingOf(db, orgId)).timezone)`, which also returns the
  zone (`?? 'UTC'`).
- `autoReviewsUsed(db, projectId, day)`:
  ```sql
  SELECT count(DISTINCT pr_review_id)::int AS n FROM pr_review_runs
   WHERE project_id=$1 AND trigger='auto' AND started_at >= $2 AND started_at < $3
  ```
- `manualReviewsToday(db, projectId, day)`: the same query with `trigger='manual'`. It is for display only.
- `prReviewQueue(db, ctx, projectId)` is the **single** queue function, used by both the dispatcher and the API. It
  returns `{ day, timeZone, resetsAt, used, cap, manualToday, items }`:
  1. Candidates are `listQueueCandidates` filtered by `mayStart` (export it from `pr-review-runs.ts`, or add a batched
     `mayStartMany(db, ids)` with the same rule; **do not write a second copy of the rule**). `listReviewEligiblePrs`
     already drops non-open and reviewed PRs, and `mayStart` drops PRs with a `running`, `completed`, `posted` or
     `timed_out` run, or a failed run other than `no_token`. The query needs `changed_lines`: add it to
     `listReviewEligiblePrs`'s select and to `ReviewEligiblePr` (`changedLines: number | null`).
  2. Sort them with `compareQueue(tz)`. Do it in TypeScript, so the "same local day" rule is the shared function the
     tests exercise, not SQL that has to match it.
  3. Mark `blocked` when the gate is not `ready` (`reviewer_token_missing`, `blockedProblem` = the gate's `problem`), or
     when `pickReviewerWorkstation` returns `blocked` (`runner_outdated` / `workstation_offline`). Call it once per repo,
     not per PR.
  4. Walk the unblocked PRs in order: the first `autoReviewsLeft(used, cap)` get `slot:'today'`, the rest `'later'`.
     `position` counts all items, blocked ones included, in run order.
- `setPrReviewDailyCap(ctx, user, org, projectId, cap)`:
  - Same guard as `setRegressionLoop`: the project Owner or an organization Owner/Admin, else 403.
  - No event when the value is unchanged. Otherwise append `ProjectPrReviewCapSet`.
  - Lowering the cap below today's used count stops new automatic starts today. It does not stop running reviews.

**Changes to `src/commands/pr-review-runs.ts`:**

- Turn the private `startRun` into **`startPrReviewRun(ctx, tx, { projectId, pr, trigger, requestedBy, enforceConcurrency })`**.
  It takes the caller's transaction instead of opening its own `withAppendTx`. It keeps what `startRun` does today:
  lock the `pr_reviews` row `FOR UPDATE`, check `closed_at`, `review_state` and `pr_only`, `mayStart` (for `'auto'`
  only; a manual trigger has its own refusals, see below), the gate again, then the workstation from
  `pickReviewerWorkstation`. With `enforceConcurrency` (auto) it also applies the busy-workstation and
  `MAX_RUNNING_PER_REPO` checks. Then it appends `PrReviewRunStarted` (with `trigger` and `requestedBy`) and enqueues
  `pr_review.run`. It returns the target workstation id, or a reason it did not start. It is the only place a run
  starts. `deliverPending(target)` stays outside, after the commit.
- `dispatchPrReviews(ctx)`, per project:
  1. Open one `withAppendTx` per project and **lock the project row** (`SELECT id FROM projects WHERE id=$1 FOR
     UPDATE`). Two dispatcher passes, or a pass and a manual trigger, then cannot both read `used = 19` and start two
     runs.
  2. `q = prReviewQueue(...)` inside the transaction.
  3. For each item with `slot === 'today'`, in order, call
     `startPrReviewRun(..., { trigger:'auto', requestedBy:null, enforceConcurrency:true })`. If it does not start
     because of concurrency, `continue`: the item keeps its place in the window.
  4. Never start a `'later'` or `'blocked'` item. This is the cap (AC1).
  5. After the transaction commits, call `deliverPending` for each target, as `startRun` does today. Keep the
     per-project `catch` and logging, so one failing project does not stop the others.
  6. The scheduler pass (every 15 s) is enough at midnight: the first pass after the local day changes computes
     `used = 0` and starts the oldest queued PRs (AC2). No midnight job is needed.
- **New `triggerPrReview(ctx, user, org, projectId, prReviewId)`**, the owner's manual trigger:
  1. Guard: the same owner check as `setPrReviewDailyCap`, else 403. 404 when the PR is not in the project.
  2. 409 `pr_closed` when `closed_at` is set. 409 `review_running` when the PR has a `running` or `completed` (post
     pending) run.
  3. Gate and workstation from `pickReviewerWorkstation` (a busy workstation is acceptable here). If none is usable,
     answer 409 `reviewer_not_ready` with the reason (`reviewer_token_missing` / `runner_outdated` /
     `workstation_offline`).
  4. **No cap check, and GWP-197's concurrency limits do not apply** (the owner decides extra spend). The run starts at
     once with `startPrReviewRun(..., { trigger:'manual', requestedBy:user.id, enforceConcurrency:false })` and leaves
     the queue, because it now has a run (AC3). Take the project row lock too, so it serialises with the dispatcher.
  5. In this card it is offered for PRs that are waiting (queued or never run). It also works for a timed-out or failed
     PR, because the only refusals are the ones above. GWP-201 adds the wording, the button on those rows and the
     second-timeout path.
  6. Returns the updated `PrReviewDto`.
- `listPrReviews` adds `queuePosition` and `queueSlot` from one `prReviewQueue` call, and `lastRun.trigger`.

**`applyPrListResult` (`commands/pr-only.ts`):**
- Pass `changedLines` into `PrReviewRecorded`.
- For known open rows (today the loop `continue`s on them), append `PrReviewSizeChanged` when the value differs (for
  example, the PR got new commits). Read `changed_lines` in the `known` query.

**Projections:**
- `ProjectPrReviewCapSet`: `UPDATE projects SET pr_review_daily_cap=$2`.
- `PrReviewRunStarted` (`projections/pr-review-runs.ts`): also write `trigger` and `requested_by`.
- `PrReviewRecorded` / `PrReviewSizeChanged`: write `changed_lines`.

**Routes** (`src/routes/projects.ts`, next to `GET /api/projects/:id/pull-requests`):
- `GET /api/projects/:id/pull-requests/queue` returns `PrReviewQueueDto`. It uses the visibility guard
  `loadVisibleProject`, the same as the PR list (members can read).
- `POST /api/projects/:id/pull-requests/:prReviewId/review` calls `triggerPrReview`, owner only, and returns
  `PrReviewDto`.
- `PUT /api/projects/:id/pr-review-cap` with `{ cap }` calls `setPrReviewDailyCap` and returns `getProjectDetail`.
- `queries/misc.ts` (project DTO): `prReviewDailyCap: p.pr_review_daily_cap ?? PR_REVIEW_DAILY_CAP_DEFAULT`.

**Do not touch** card, shift or dispatcher-claim code. Nothing here creates a card, a shift or a desk item.

### 4.4 Runner (`apps/runner`)

`apps/runner/src/forge/github.ts`, `listOpenChanges`:
- Add `additions,deletions` to the `gh pr list --json` field list, and to `GhPr`.
- Map them to `changedLines = additions + deletions`, or null when either is missing.
- Other forges leave it null. A null size sorts last among PRs of the same day.

There is no other runner change. The cap is enforced on the server only.

### 4.5 Web (`apps/web`)

**Pull requests tab** (`src/components/pull-requests/PullRequestsPage.tsx`):

- A header strip, `data-testid="pr-review-cap"`:
  - The text "Automatic reviews today: **7/20**" (`data-testid="pr-review-used"`).
  - A small text line: "Resets at midnight (Africa/Johannesburg)".
  - When the cap is used up, a neutral `Callout`: "Today's 20 automatic reviews are used up. New pull requests wait in
    the queue and are reviewed from tomorrow, oldest first. You can still review one now by hand."
  - When there were manual runs, also "+ 2 started by hand (not counted)".
- A **Queue** section, `data-testid="pr-review-queue"`. It is an ordered list in run order (`<ol>`), and each row has
  `data-testid="pr-review-queue-item-<changeId>"`:
  - The position number ("1", "2", …), the title as an external link, the repo, the opened date, and "312 lines
    changed" (or "size unknown").
  - A slot label, as text and not colour alone: "Today" / "Waits for a following day" / "Blocked: <reason>". Reasons:
    "no reviewer token on any workstation" / "the runner needs an update" / "no reviewer workstation is online".
  - For owners only, a **Review now** button (`data-testid="pr-review-now-<changeId>"`, `min-h-11`). It asks for
    confirmation first: "This review is not counted toward the daily cap and adds to today's spend. Review now?" It
    then calls the POST route, and the row moves to "Review running".
  - Empty state: "No pull requests waiting."
  - A short line under the heading explains the order: "Oldest first; pull requests opened the same day run smallest
    first."
- On the PR list rows, the waiting detail becomes "Not reviewed · queued #5 (waits for a following day)" when
  `queueSlot === 'later'` (AC1). The badge stays **Not reviewed**.
- Refresh: refetch the queue with the PR list (GWP-197's polling while runs are active) and after a manual trigger.
- New hooks in `src/api/queries/pr-reviews.ts`: `usePrReviewQueue(projectId)` and `useTriggerPrReview(projectId)`.
- Update the Pull requests entry in `src/help/page-help-content.ts` with the cap and queue.

**Project settings** (`src/pages/ProjectSettings.tsx`): add a new `PrReviewCapPanel.tsx`, modelled on
`ConcurrencyCapPanel.tsx`.
- Show it only when the project has a PR-only repo, and only owners can edit.
- Title "Daily automatic reviews", badge "20 per day".
- A number input: `type="number"`, `inputMode="numeric"`, min 1, max 100, error "Enter a whole number from 1 to 100".
- A "Save" button and the hook `useSetPrReviewCap`.
- Help text: "At most this many pull requests are reviewed automatically each day (midnight to midnight in your time
  zone). The rest wait in the queue, oldest first. Reviews you start by hand are not counted."

**All devices, including touch:**
- No hover-only information. The slot and the reason are row text.
- Tap targets are at least 44 px.
- Queue rows stack at 320 px, with no horizontal table scroll.
- The confirmation is a dialog that works by keyboard and by touch.
- The only text input is the cap field in Settings. It uses `inputMode="numeric"`, so phones open the number keyboard,
  and the Save button stays visible when the soft keyboard opens (keep it in the same row, as
  `ConcurrencyCapPanel` does).

### 4.6 Docs

- `docs/USER-GUIDE.md`, in the PR-only reviews section: add **Daily cap and queue**. It covers:
  - The cap is per project, 20 by default, and set in Project settings.
  - What counts: one PR that got an automatic review that day. A second run on the same PR the same day does not count
    again, and timed-out or failed runs do count.
  - The day runs midnight to midnight in the organization Owner's time zone, or UTC when it is not set.
  - Queue order: oldest first by the day the PR was opened. On the same day the smaller PR goes first (fewer changed
    lines). A PR of unknown size goes last.
  - Blocked PRs (no reviewer token, runner needs an update, no workstation online) do not use a slot.
  - Where the owner sees n/20 and the queue.
  - "Review now" goes past the cap, is not counted, and adds to spend.
- `docs/ARCHITECTURE.md` section 19 (routes): add the three routes.

## 5. Acceptance criteria mapped to the design and tests

All tests go in **new files**. Server tests use the test DB (Postgres 5433) and the test clock (`t.clock.setOffset` /
`advance`), and call `Scheduler.run()` / `dispatchPrReviews(ctx)` directly after moving the clock. They seed workstations
and runs the way `apps/server/test/pr-review-runs.test.ts` does, with fake `command.result` answers, and no real model
runs. Seed the Owner's `users.timezone` (for example `Africa/Johannesburg`) so the day boundary is not UTC.

| AC | Design | Test |
|---|---|---|
| **AC1** 21st PR on a day: not reviewed, in the queue | Admission window in `prReviewQueue` and `dispatchPrReviews` steps 3 and 4. Distinct-PR count over `pr_review_runs.trigger='auto'`. The badge stays `not_reviewed`, and the row shows "queued #n" | `apps/server/test/pr-review-daily-cap.test.ts`: seed 21 eligible PRs and run the dispatcher until 20 automatic runs have started. Concurrency limits apply (1 per repo, 2 per workstation), so either seed enough repos/workstations, or finish runs between passes with fake `command.result`. Expect: exactly 20 distinct PRs with automatic runs today. The 21st has no run, `review_state='not_reviewed'`, and `GET …/pull-requests/queue` lists it with `slot:'later'`. More passes the same day start nothing. Also: a `no_token` retry of a counted PR the same day does not raise `used`, and timed-out runs count. A PR on a repo whose workstation lacks `pr-review:1` is `blocked` (`runner_outdated`) and does not take a slot |
| **AC2** New day: oldest first, same age smaller first | `compareQueue(tz)` (local open day, then `changedLines`, then `openedAt`, then id). `used` resets with `reviewDayOf`. A strict window, so concurrency cannot let a younger PR take a slot | `apps/server/test/pr-review-queue-order.test.ts`: fill today's cap, queue PRs opened on day D-2 (two PRs on that day: 300 lines at 08:00 and 40 lines at 15:00), on D-1, and a new PR on D. Set the cap to 3 for the test. Move the clock past local midnight (also check 23:59 → 00:01 local is a new day while UTC is still the same day) and run the dispatcher. Started, in order: D-2/40, D-2/300, D-1. The D PR waits. Also: with the head of the window blocked by the repo limit, a younger PR in another repo outside the window does not start. **Unit** `packages/shared/test/pr-review-queue.test.ts`: `compareQueue` (different days, same day with different sizes, null size last, equal size by time, stable id), `reviewDayOf` across a zone boundary, `autoReviewsLeft` never negative |
| **AC3** Cap used up, owner triggers, review runs | `triggerPrReview`: no cap check, `trigger:'manual'`, not counted | `apps/server/test/pr-review-manual-trigger.test.ts`: with `used = cap`, the owner POSTs `…/review` for a queued PR. Expect 200, a run row `running` with `trigger='manual'`, `requested_by` set, a `pr_review.run` command enqueued, and `used` still equal to the cap (`manualToday = 1`). A member gets 403. A running PR gets 409 `review_running`. A closed PR gets 409 `pr_closed`. With no ready workstation, 409 `reviewer_not_ready`. Next day: the manually reviewed PR is not in the queue |
| **AC4** Project view shows n/20 and the queue in run order | `GET …/pull-requests/queue` from the same `prReviewQueue` the dispatcher uses. Pull requests tab header and queue list | Server: `pr-review-queue-order.test.ts` asserts that the read model returns `used/cap`, `resetsAt` and `items` in the same order the dispatcher then starts them (one function, two callers). Cap setting: `apps/server/test/pr-review-cap-setting.test.ts`. The default is 20. The owner sets 5 and the window shrinks. A member gets 403. Values 0 and 101 get 400. Runner: new `apps/runner/test/forge-pr-size.test.ts` (modelled on the existing `forge-list-prs.test.ts`) checks `changedLines` from a fake `gh` output, and null when the fields are missing. Web: `apps/web/src/test/pr-review-queue.test.tsx` renders "Automatic reviews today: 7/20", the ordered list with its slot labels, the "Review now" button for owners only (not for members), and the used-up Callout. `apps/web/src/test/pr-review-cap-panel.test.tsx` checks validation and save |

**Regression (likely-regression order):**
- Re-run `apps/server/test/pr-review-runs.test.ts`, `apps/web/src/test/pull-requests.test.tsx` and GWP-195's PR-only
  tests unchanged. `startPrReviewRun` and `pickReviewerWorkstation` are extractions, and `listReviewablePrs` becomes a
  filter, so their behaviour must not change below the cap.
- Add one case to the new cap test: with fewer than `cap` PRs, all of them start, as before (subject to the same
  concurrency limits).
- Run `apps/server/test/dispatch-full.test.ts` to check that card dispatch is untouched.

Unit and server tests only. There is no e2e spec in this card (e2e/** belongs to the tester).

## 6. Risks

- **Time zone changes mid-day.** The window is computed again, so the count can jump for one day. This is rare and the
  owner sees it. Accepted.
- **Changed lines unknown** (non-GitHub forge, or an old runner without the new fields): those PRs sort last within
  their day. They are not lost.
- **Concurrent starts.** The project row lock serialises automatic starts and manual triggers per project. The PR row
  lock in `startPrReviewRun` stays, so one PR never gets two runs.
- **Longer transaction.** The dispatcher now holds one transaction per project for the whole pass over that project
  (the landed code used one per PR). It covers at most `cap` starts and a few small queries. Keep the queue read and
  the starts in it; deliver after the commit.
- **Cost of the queue read.** `prReviewQueue` runs per project per pass (15 s). It is bounded by the open PRs of
  PR-only repos (≤ 200 per repo). `mayStart` is one query per PR today; use a batched version if it shows up. Sorting in
  TypeScript is cheap.
- **A workstation that flaps online/offline.** Its PRs move between `blocked` and `today` from pass to pass. That is
  correct (a dead PR must not hold a slot all day), and the order is unchanged.
- **GWP-201 overlap.** `triggerPrReview` and its route exist here. GWP-201 must extend them, not add a second path.

## 7. Follow-ups (backlog suggestions, not in this card)

- The PRD's "owner-pending items" reminder after 2 working days (it lists "extra spend beyond the daily cap"). Check
  whether the landed `2900_owner_pending.sql` work already covers it before suggesting it.

## 8. Assumptions about the dependencies (checked 2026-11-13, see section 0)

1. GWP-197 provides `pr_review_runs` and `PrReviewRunStarted` as designed. **Holds.** (Migration number moves to
   2930.)
2. GWP-197's `dispatchPrReviews` on the 15 s pass is the only automatic start. **Holds.**
3. GWP-195 stores `opened_at` as the forge created time and lists PRs with `gh pr list --json`. **Holds.**
4. GWP-196's readiness is callable per repo and returns a reason. **Partly: revised.** `reviewerGate` covers the token
   only. The capability/connected pick moves out of `startRun` into `pickReviewerWorkstation`, and the queue uses
   `listQueueCandidates` (eligible PRs with their gate) so gated PRs are listed as blocked (sections 3.3 and 4.3).
5. GWP-197's Pull requests tab and `PrReviewDto` exist. **Holds.** (The page is
   `components/pull-requests/PullRequestsPage.tsx`.)
6. Timed-out and model-error PRs are not started again automatically. **Holds.** Only a `no_token` failure is retried.
