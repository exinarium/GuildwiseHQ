# GWP-204: Second reviewer (Opus) on live PR-only PRs, findings merged with the first reviewer

This is the design for the second reviewer on PR-only repositories (PRD "Review Gates & Reviewer Workflow" v22: "Two
reviewers, a smaller model (Sonnet) and a deeper one (Opus), comment on PRs". Section 10: "A 20-PR replay measures the
second reviewer offline before it runs on live PRs").

It was first written before its dependencies landed. GWP-196, GWP-197, GWP-198, GWP-199, GWP-200 and GWP-203 are now
in the working branch (`main`, HEAD 26dcb434). Section 0 records the check of each assumption against the landed code.
The rest of the report has been revised to match. Where it names a function, a table or an event, the name is the one
that landed.

## 0. Revision against the landed code (2026-11-14)

| # | Assumption | Holds? | What landed, and what changed in this design |
|---|---|---|---|
| A1 | GWP-197: `pr_review.run` never posts; `pr_review_runs.reviewer`; the server builds one post and sends `pr_review.post`; results for non-running runs are ignored; the runner dedupes by `runId` | **Yes** | `applyPrReviewRunResult` (`apps/server/src/commands/pr-review-runs.ts:356`) ignores non-`running` runs and is the only place a post is enqueued (`enqueueReviewPost`, which refuses replay runs). The runner's `PrReviewCommands` (`apps/runner/src/review/pr-review-commands.ts`) dedupes runs and posts by `payload.runId`. The post payload's `runId` is used **only** as the marker and the dedupe key on the runner, so the post can carry the round id in that field. No runner change is needed for posting (4.4.4). |
| A2 | `applyFindingsCap` is pure and shared, results carry `changedLines`, and the cap can run in `buildReviewPost` | **Partly** | `applyFindingsCap` is pure (`packages/shared/src/review/findings.ts:26`), and results carry an optional `changedLines`. **But** the cap runs per run at completion, inside `applyPrReviewRunResult`, **before** `PrReviewRunCompleted`. That event stores `rank` and `disposition` on every finding, and `findings_cap` and `held_back_count` on the run. `buildReviewPost` only filters out `held_back`. **Change:** keep the per-run cap as it landed (round of one is unchanged). At the end of a round, `mergeAndPostRound` applies the cap again to the merged list, and the new `PrReviewRoundMerged` overwrites `rank`/`disposition` for every finding of the round (4.4.4). `selectFindingsToPost` must also leave out `merged`. `FindingDispositionSchema` is `['posted','held_back']` and gains `'merged'`. |
| A3 | Attribution only through `pr_review_finding_attribution`, precision over `disposition='posted'`, finding DTO `reviewers[]` hidden until marked | **Partly** | The view exists (migration 2940), but its columns are `(finding_id, reviewer, model, runtime)`. A `CREATE OR REPLACE VIEW` with three columns would fail, so the redefinition keeps all four (4.3). Precision (`reviewerPrecisionForProject`) and `findingMarksForReplay` filter on the **boolean `f.posted`** (set by `PrReviewPosted`), not on `disposition`. Merged rows are never in `postedFindingIds`, so they stay `posted = false` and are not counted. The finding DTO hides `reviewers[]` until marked (`findingView`), as assumed. The PR-level `reviewer` in `PrReviewDto` is **one value** read from `pr_reviews.reviewed_by` (text). A pair needs `reviewers[]` there too (4.4.7). |
| A4 | One start function `startPrReviewRun`, one dispatchable-PR query, the cap counts `DISTINCT pr_review_id` over automatic runs per local day | **Partly** | Start: holds. `startPrReviewRun` is the only start (dispatcher `dispatchProject` and owner `triggerPrReview`). Cap: holds. `autoReviewsUsed` counts `count(DISTINCT pr_review_id)` over `pr_review_runs` with `trigger='auto'`, and replay runs have `pr_review_id NULL`. So a pair already counts as 1 and **the cap code needs no change**. **The dispatch filter is different:** it is `mayStart(db, prReviewId)` (`apps/server/src/review/may-start.ts`), called by `prReviewQueue`, by `startPrReviewRun` and by GWP-203's replay dispatcher. Its rule is "one run per PR; only a `no_token` failure is tried again". There is no "retryable after 30 minutes, 3 attempts" rule. **Change:** `mayStart` moves to rounds with the landed rule, plus one retry code for this card (`heads_differ`, at most 3 rounds) (4.4.2). Concurrency counts move to rounds: a pair is 2 running runs on one repo and would hit `MAX_RUNNING_PER_REPO = 1`. |
| A5 | A query like `latestRecordedReplay(db, projectId)` exists | **No** | GWP-203 has no such query. Replays are **per repository** (`pr_replays.project_repo_id`, with `project_id` as well). "Recorded" is `state = 'finished'` with `result` (jsonb `ReplayResult`, `reviewers[].prsReviewed`). A replay can finish with the Opus side all timed out. **Change:** this card adds `latestRecordedReplay` in `apps/server/src/queries/pr-replays.ts`: the latest `finished` replay on a live PR-only repo of the project in which **both** reviewers reviewed at least one PR (4.4.1). `LIVE_REVIEWERS = ['first']` stays as the reviewers of every live round, and `reviewersFor` adds `'second'` (4.2). |
| A6 | Checkout per run id; readiness can require a capability | **Yes** | The run folder is `<reviews>/<runId>` (`reviewer-sandbox.ts:73`) and the agent is `pr-review-<runId>`, so two runs on one PR run side by side. `pickReviewerWorkstation` checks `PR_REVIEW_CAPABILITY` itself. It gains a `capabilities` list and a `slots` count (4.4.2), which is the fallback the assumption named. `runPrReview` has no outside stop, so it gains an optional `AbortSignal` for `pr_review.cancel` (4.5). |
| A7 | GWP-201's re-run calls the start function | Open | GWP-201 has not landed yet. Its re-run must call `startPrReviewRound`. |

**Owner question answered (ledger 402ee50a):** the Sonnet + Opus pair counts as **1** of the 20 automatic reviews per
day. A pair that times out still used its slot. Manual triggers stay outside the automatic slots (ledger a03646c3).
The USER-GUIDE says that switching Opus on roughly doubles model spend per reviewed PR, while the 20-PR limit stays.

**Gap found while checking:** `buildReviewPost` puts the run's model-written `summary` in the review body. For a pair,
either summary would show which model wrote it, which breaks blind marking. A pair's review body is a neutral line
written by the server (4.4.4).

## 1. Question

1. How is the Opus reviewer switched on per project, and how is the switch refused until a replay has been recorded
   (requirement 1, AC1)?
2. How do two reviewer runs on one PR become one unit, so that both run and exactly one merged set is posted
   (requirement 2, AC2)?
3. What is the duplicate rule, and how does a merged finding stay attributable to both reviewers for blind marking and
   precision (requirements 2 and 3, AC3)?
4. How do the timeout, no-partial-comments and daily cap rules apply to the pair (requirement 4, AC4)?

| Open point | Decision |
|---|---|
| Duplicate detection rule | A deterministic rule in one pure shared function (4.2): same file, and the same line, or lines no more than 5 apart with similar titles. One-to-one matching between the two runs. No model call. |
| Does the pair count as 1 or 2 against the daily cap? | **1** (owner answer, ledger 402ee50a). The landed counter already does this. No change. |

## 2. Findings (landed code at 26dcb434)

- **Opus is already a model choice.** `REVIEWER_MODEL.second = { runtime: 'claude-code', model: 'opus' }` and
  `PR_REVIEWERS = ['first','second']` are in `packages/shared/src/review/pr-review.ts` (GWP-203 added them for the
  replay). `LIVE_REVIEWERS = ['first']` is the gate that GWP-203 left for this card.
- **Run and post (GWP-197):** see A1. Run states: `running | completed | posted | timed_out | failed |
  offline_completed`. A run is `completed` while its post is out, and `posted` after. `PrReviewPosted` sets the run
  `posted`, flags `pr_review_findings.posted = true` for `postedFindingIds`, and sets `pr_reviews.review_state =
  'reviewed'` and `reviewed_by = <reviewer>`.
- **Cap (GWP-198):** see A2. Per run, on the server, at completion.
- **Marks (GWP-199):** see A3. `PrReviewFindingMarked` carries the finding's `runId`. A canonical finding's mark is
  stored once.
- **Daily cap and queue (GWP-200):** see A4. The project row lock (`SELECT … FOR UPDATE` on `projects`) serialises a
  dispatcher pass and a manual trigger. `pickReviewerWorkstation` counts running runs per workstation
  (`MAX_RUNNING_PER_WORKSTATION = 2`). `startPrReviewRun` counts running runs per repo (`MAX_RUNNING_PER_REPO = 1`).
- **Replay (GWP-203):** see A5. Replay runs and findings live in `pr_review_runs`/`pr_review_findings` with
  `replay_id` set and `pr_review_id NULL`. They are never posted. The replay dispatcher runs one replay run per
  workstation, after live work (it calls `mayStart`). `sweepStalePrReviewRuns` handles replay runs first.
- **Owner switch pattern:** `setPrReviewDailyCap`/`requireSpendOwner` (`commands/pr-review-cap.ts`) allows the
  project Owner or an organization Owner/Admin. That is the guard for this switch too.
- **Switch UI pattern:** `apps/web/src/components/ReleaseDocsPrepPanel.tsx` uses
  `<input type="checkbox" role="switch" aria-checked>`. The panels live on `pages/ProjectSettings.tsx`.

## 3. Options

### 3.1 How the pair is modelled

| | A. **A review round: two independent `pr_review.run` commands sharing a `round_id`; the server waits for both, merges and posts once** | B. One runner command that runs both sessions and returns both results | C. Sequential: Opus gets Sonnet's findings |
|---|---|---|---|
| Reuses GWP-197's run, timer, dedupe, result schema | Unchanged | New command and result | Changes prompt and result |
| Independent findings (fair precision per reviewer) | Yes | Yes | **No** |
| Wall time | max(Sonnet, Opus) | max | Sonnet + Opus |
| Replay reuse | Same `runPrReview` | Needs the pair command | No |

**Choice: A.** A round is the unit the rules apply to: one post, one timeout outcome, one daily-cap count. A
single-reviewer review is a round of one, so there is one code path whether Opus is on or off.

### 3.2 Duplicate detection rule

| | A. **Deterministic: same path, line and title-similarity rule, one-to-one** | B. A third model call judges | C. Exact (same path and line) only |
|---|---|---|---|
| Testable with fixtures | Yes | No | Yes |
| Extra cost and failure surface | None | Another session | None |
| Catches the same issue a few lines apart | Yes | Yes | **No** |
| Risk of merging two different issues | Low (title overlap needed when lines differ) | Low | Lowest |

**Choice: A.**

### 3.3 Partner run when one run times out or fails

**Choice: mark the partner `cancelled` in the same transaction and send `pr_review.cancel`** (rather than letting it
finish and discarding it). The daily cap limits spend, so do not pay for a run whose result can never be posted. The
landed "ignore a result for a run that is not `running`" rule covers a late answer.

### 3.4 Where the replay gate is checked

**Choice: in the switch command (refuse) and again at round start (defensive).** A flag set before the gate, a
projection rebuild or a deleted replay then still never starts Opus.

## 4. Design

### 4.1 Flow

```
owner: Project settings → "Second reviewer (Opus)" on
  └─ setSecondReviewer: requireSpendOwner → latestRecordedReplay? no → 409 replay_required (AC1)
                                                                   yes → ProjectSecondReviewerSet
dispatcher pass (dispatchProject) / owner trigger (triggerPrReview) / GWP-201 re-run
  └─ startPrReviewRound(ctx, tx, { projectId, prReviewId, trigger, requestedBy, enforceConcurrency })
       reviewers = reviewersFor(tx, projectId)  → ['first'] or ['first','second']
       PrReviewRoundStarted (round 'running')
       per reviewer: PrReviewRunStarted { roundId, reviewer, model } + enqueue pr_review.run   (same workstation)
runner: independent runPrReview() sessions, each with its own 10-minute timer; never posts
server applyPrReviewRunResult (per run; round row locked, then run row)
  run timeout / failed → round 'timed_out' / 'failed'; partners → PrReviewRunCancelled + pr_review.cancel;
                         nothing posted; PR stays not_reviewed                                       (AC4)
  run completed (per-run cap as landed), a partner still running → store findings, wait
  last run completed → heads equal? no → round failed 'heads_differ'
                       → mergeFindings → applyFindingsCap(merged) → PrReviewRoundMerged → round 'posting'
                       → buildReviewPost(round) → enqueueReviewPost (one review, runId field = roundId)  (AC2, AC3)
server applyPrReviewPostResult (looks up the round)
  ok → PrReviewPosted { roundId, reviewers, postedFindingIds } → round 'posted', PR 'reviewed'
```

### 4.2 Shared (`packages/shared`)

**`src/review/pr-review.ts`, extend:**

```ts
/** Reviewers of every live round. The second reviewer is added per project by reviewersFor() (GWP-204). */
export const LIVE_REVIEWERS = ['first'] as const;           // unchanged value; doc comment updated
/** Runner can stop a live reviewer run (pr_review.cancel). Required on the workstation for two-reviewer rounds. */
export const PR_REVIEW_PAIR_CAPABILITY = 'pr-review-pair:1';

export const PR_REVIEW_ROUND_STATES = ['running', 'posting', 'posted', 'timed_out', 'failed'] as const;
export const PrReviewRoundStateSchema = z.enum(PR_REVIEW_ROUND_STATES);
// PR_REVIEW_RUN_STATES gains 'cancelled'; PR_REVIEW_FAILURE_CODES gains 'cancelled'.

export const PrReviewCancelPayloadSchema = z.object({ runId: z.uuid(), reason: z.enum(['partner_timeout', 'partner_failed']) }).strict();
export const PrReviewCancelResultSchema = z.object({ found: z.boolean() });

export const SetSecondReviewerRequestSchema = z.object({ enabled: z.boolean() }).strict();
```

- Keep the existing test `packages/shared/test/pr-replay.test.ts` (`LIVE_REVIEWERS` equals `['first']`) green: the
  value does not change.
- Both reviewers get the same prompt (`renderReviewerInstructions`). Only the model differs.
- `PrReviewPostPayloadSchema` keeps its field name `runId`. For a round it carries the **round id** (document it as
  "the posting id: the round id"). The runner uses it only for the marker and dedupe, so older runners keep posting.
- **`src/review/findings.ts`:** `FindingDispositionSchema = z.enum(['posted', 'held_back', 'merged'])`. Check every
  user of `FindingDisposition` (`replayResult`, `reviewerPrecision`, `selectFindingsToPost`). `merged` never counts as
  posted.

**New `src/review/merge.ts`** holds the duplicate rule. It is pure, exported from the index, and reusable by the replay:

```ts
export const DUPLICATE_LINE_WINDOW = 5;             // lines apart, same file
export const DUPLICATE_TITLE_SIMILARITY = 0.3;      // token Jaccard of the normalised titles
export const DUPLICATE_FILE_TITLE_SIMILARITY = 0.5; // both findings have no line

export interface MergeInput { id: string; reviewer: PrReviewer; idx: number; path: string; line: number | null;
  severity: FindingSeverity; anchored: boolean; title: string; body: string }
export interface MergedFinding<T extends MergeInput> {
  canonical: T;                 // the row that is posted (its text) and marked
  duplicates: T[];              // rows from the other run, stored with merged_into = canonical.id
  reviewers: PrReviewer[];      // every reviewer that produced it, sorted ['first','second']
  severity: FindingSeverity;    // highest severity among canonical and duplicates
}

export function titleTokens(title: string): Set<string>;    // lower case, split on non-alphanumerics, 3+ chars, short stop list removed
export function titleSimilarity(a: string, b: string): number; // |A ∩ B| / |A ∪ B|, 0 when both are empty

export function isDuplicate(a: MergeInput, b: MergeInput): boolean {
  if (a.reviewer === b.reviewer || normPath(a.path) !== normPath(b.path)) return false;
  if (a.line !== null && b.line !== null) {
    if (a.line === b.line) return true;
    return Math.abs(a.line - b.line) <= DUPLICATE_LINE_WINDOW && titleSimilarity(a.title, b.title) >= DUPLICATE_TITLE_SIMILARITY;
  }
  if (a.line === null && b.line === null) return titleSimilarity(a.title, b.title) >= DUPLICATE_FILE_TITLE_SIMILARITY;
  return false;                 // one about a line, the other about the file: kept apart
}

/**
 * Merge one round's runs into one list, in the input order for applyFindingsCap (which sorts stably by severity).
 * One-to-one: every isDuplicate pair is scored (same line first, then higher title similarity, then smaller distance,
 * then lower idx sum, then ids) and taken greedily, so no finding is matched twice. Never within one run.
 * Canonical of a pair: higher severity; then anchored; then lower idx; then 'first'.
 * Result order: found by both first; then best relative position (idx / run length); then 'first'; then id.
 * Pure: inputs are not mutated. With one run it returns that run's findings unchanged, in idx order.
 */
export function mergeFindings<T extends MergeInput>(runs: ReadonlyArray<ReadonlyArray<T>>): MergedFinding<T>[];
```

`idx` is the position the landed projection stores, which is the per-run capped order (severity first). That order is
the right input. `normPath` strips a leading `./` and `/`.

**Events** (next to the PR review events in `packages/shared/src/events/project.ts`):

| Event | Payload | Notes |
|---|---|---|
| `ProjectSecondReviewerSet` | `{ projectId, enabled, by, replayId: Id.nullable() }` | `replayId` is the replay that allowed `enabled: true` (audit) |
| `PrReviewRoundStarted` | `{ projectId, prReviewId, roundId, reviewers, trigger, requestedBy, workstationId, at }` | |
| `PrReviewRunStarted` | add `roundId: Id.optional()` | Old events without it: `round_id = runId` (4.3) |
| `PrReviewRunCancelled` | `{ projectId, prReviewId, roundId, runId, reason, at }` | Run state `cancelled` |
| `PrReviewRoundMerged` | `{ projectId, prReviewId, roundId, changedLines, findingsCap, findings: [{ findingId, disposition: 'posted' \| 'held_back' \| 'merged', rank: number \| null, mergedInto: Id \| null, severity }], at }` | Overwrites `rank`, `disposition`, `merged_into`, `severity` for every finding of the round |
| `PrReviewRoundEnded` | `{ projectId, prReviewId, roundId, outcome: 'timed_out' \| 'failed', causeRunId: Id.nullable(), code: string \| null, at }` | Codes: the cause run's code, `heads_differ`, `post_unfinished`, or the post's failure code |
| `PrReviewPosted` | add `roundId: Id.optional()`, `reviewers: PrReviewer[].optional()`; keep `runId` and `reviewer` (old events; for a round: its first run and `'first'`) | |

No event says which reviewer produced which finding. The link is the finding's `run_id`.

### 4.3 Data model: migration `apps/server/migrations/2960_pr_review_rounds.sql`

The highest numbers today are `2950_pr_replay.sql` and `2950_pr_review_daily_cap.sql`. Re-check at build time.

```sql
-- Review rounds: one posting unit per PR review, of one or two reviewer runs. Projections; no foreign keys.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pr_review_second_reviewer boolean NOT NULL DEFAULT false;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS reviewed_by_all text[];   -- every reviewer of the posted round

CREATE TABLE IF NOT EXISTS pr_review_rounds (
  id uuid PRIMARY KEY,
  pr_review_id uuid NOT NULL,
  project_id uuid NOT NULL,
  reviewers text[] NOT NULL,            -- {first} or {first,second}
  trigger text NOT NULL DEFAULT 'auto',
  requested_by uuid,
  workstation_id uuid,
  state text NOT NULL,                  -- running | posting | posted | timed_out | failed
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  changed_lines integer,
  findings_cap integer,
  held_back_count integer NOT NULL DEFAULT 0,
  merged_count integer NOT NULL DEFAULT 0,
  end_code text,
  cause_run_id uuid,
  review_url text,
  posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS pr_review_rounds_pr ON pr_review_rounds (pr_review_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pr_review_rounds_active ON pr_review_rounds (state) WHERE state IN ('running', 'posting');

ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS round_id uuid;
CREATE INDEX IF NOT EXISTS pr_review_runs_round ON pr_review_runs (round_id);
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS merged_into uuid;

-- disposition gains 'merged' (the landed column CHECK has the default name)
ALTER TABLE pr_review_findings DROP CONSTRAINT IF EXISTS pr_review_findings_disposition_check;
ALTER TABLE pr_review_findings ADD CONSTRAINT pr_review_findings_disposition_check
  CHECK (disposition IN ('posted', 'held_back', 'merged'));

-- Backfill: every live run recorded before rounds is a round of one with the run's id.
INSERT INTO pr_review_rounds (id, pr_review_id, project_id, reviewers, trigger, requested_by, workstation_id, state,
                              started_at, finished_at, changed_lines, findings_cap, held_back_count, end_code,
                              review_url, posted_at)
SELECT r.id, r.pr_review_id, r.project_id, ARRAY[r.reviewer], r.trigger, r.requested_by, r.workstation_id,
       CASE r.state WHEN 'completed' THEN 'posting' ELSE r.state END,
       r.started_at, r.finished_at, r.changed_lines, r.findings_cap, r.held_back_count, r.error_code,
       r.review_url, r.posted_at
  FROM pr_review_runs r
 WHERE r.replay_id IS NULL AND r.round_id IS NULL
ON CONFLICT (id) DO NOTHING;
UPDATE pr_review_runs SET round_id = id WHERE replay_id IS NULL AND round_id IS NULL;
UPDATE pr_reviews SET reviewed_by_all = ARRAY[reviewed_by] WHERE reviewed_by IS NOT NULL AND reviewed_by_all IS NULL;

-- Attribution, redefined with the SAME columns as migration 2940: a canonical finding is credited to its own run's
-- reviewer and to the reviewer of every duplicate merged into it (AC3).
CREATE OR REPLACE VIEW pr_review_finding_attribution AS
  SELECT f.id AS finding_id, run.reviewer, run.model, run.runtime
    FROM pr_review_findings f JOIN pr_review_runs run ON run.id = f.run_id
   WHERE f.disposition <> 'merged'
  UNION
  SELECT d.merged_into AS finding_id, run.reviewer, run.model, run.runtime
    FROM pr_review_findings d JOIN pr_review_runs run ON run.id = d.run_id
   WHERE d.disposition = 'merged' AND d.merged_into IS NOT NULL;
```

- Add `pr_review_rounds` to `PROJECTION_TABLES` (`apps/server/src/projections/index.ts`, used by the rebuild).
- **Rebuild safety:** the projection of `PrReviewRunStarted` without `roundId` inserts a round of one (`id = runId`)
  and sets `round_id = runId`. `PrReviewRunCompleted` on such a run sets that round to `posting`, and
  `PrReviewRunTimedOut`/`PrReviewRunFailed` end it. `PrReviewPosted` without `roundId` maps to round `runId`. The
  rebuild then gives the same rows as the backfill.
- Replay runs never get a round (`round_id NULL`). Every round query reads `pr_review_rounds`, so replay runs stay
  out of it. The view also serves replay findings (`queries/pr-replays.ts`); they are never `merged`, so nothing
  changes for them.

### 4.4 Server (`apps/server`)

#### 4.4.1 The switch (AC1)

New in `src/commands/pr-review-rounds.ts`:

```ts
export async function setSecondReviewer(ctx, user, org, projectId, enabled: boolean): Promise<void> {
  return withAppendTx(ctx.pool, async (tx) => {
    await requireSpendOwner(tx, user, org, projectId);        // 404 non-member, 403 manager (landed guard)
    const p = await one(tx, 'SELECT org_id, pr_review_second_reviewer FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (enabled && !(await hasLivePrOnlyRepo(tx, projectId)))
      throw conflict('no_pr_only_repo', 'the second reviewer reviews PR-only repositories; this project has none');
    const replay = enabled ? await latestRecordedReplay(tx, projectId) : null;
    if (enabled && !replay)
      throw conflict('replay_required', 'record a 20-PR replay for this project before switching on the second reviewer');
    if (Boolean(p.pr_review_second_reviewer) === enabled) return;   // no event when unchanged
    append ProjectSecondReviewerSet { projectId, enabled, by: user.id, replayId: replay?.id ?? null } on the project stream;
  });
}
```

New in `src/queries/pr-replays.ts` (the A5 query):

```ts
/** The latest finished replay on a live PR-only repo of the project in which both reviewers reviewed at least one PR. */
export async function latestRecordedReplay(db: Queryable, projectId: string):
  Promise<{ id: string; finishedAt: string; result: ReplayResult } | null> {
  // SELECT rp.id, rp.finished_at, rp.result FROM pr_replays rp
  //   JOIN project_repos r ON r.id = rp.project_repo_id AND r.pr_only AND r.removed_at IS NULL
  //  WHERE rp.project_id = $1 AND rp.state = 'finished' AND rp.result IS NOT NULL
  //  ORDER BY rp.finished_at DESC
  // then, in TS, take the first whose ReplayResultSchema.parse(result).reviewers has prsReviewed >= 1
  // for both 'first' and 'second'
}
```

- Switching off is always allowed. Running rounds keep their reviewers (fixed at round start).
- Projection: `ProjectSecondReviewerSet` runs `UPDATE projects SET pr_review_second_reviewer = $2`.
- Route: `PUT /api/projects/:id/second-reviewer` with `{ enabled }`, in `routes/projects.ts` next to the daily cap
  route. It returns the project detail.
- Project DTO (`queries/misc.ts`, `api/projects.ts`): `secondReviewer: { enabled, replayRecordedAt: IsoTime | null,
  replayId: Id | null, precision: { first: number | null, second: number | null } | null }`, from
  `latestRecordedReplay`.

#### 4.4.2 Round start: `startPrReviewRun` becomes `startPrReviewRound`

```ts
export async function reviewersFor(tx, projectId): Promise<PrReviewer[]> {
  const p = await one(tx, 'SELECT pr_review_second_reviewer FROM projects WHERE id=$1', [projectId]);
  if (!p?.pr_review_second_reviewer) return [...LIVE_REVIEWERS];
  return (await latestRecordedReplay(tx, projectId)) ? [...LIVE_REVIEWERS, 'second'] : [...LIVE_REVIEWERS];
}
```

`startPrReviewRound(ctx, tx, input)` keeps the landed signature and checks of `startPrReviewRun` (PR row lock,
closed, `not_reviewed`, `pr_only`, `mayStart` for `auto`, gate, picker, PR number and base ref), and returns
`{ started: true, target, roundId, runIds }`. The changes:

- `reviewers = await reviewersFor(tx, projectId)`, then one `PrReviewRoundStarted`, then per reviewer one
  `PrReviewRunStarted { roundId, reviewer, ...REVIEWER_MODEL[reviewer] }` plus one `pr_review.run`. Both go to **the
  same workstation**.
- **Picker:** `pickReviewerWorkstation(db, gate, { ignoreBusy, capabilities, slots })`. `capabilities` is
  `[PR_REVIEW_CAPABILITY]`, plus `PR_REVIEW_PAIR_CAPABILITY` for a pair. A workstation is usable when
  `busy + slots <= MAX_RUNNING_PER_WORKSTATION`. A pair with no capable workstation is `blocked: 'runner_outdated'`
  (the existing reason). **Never fall back to one reviewer.** `prReviewQueue`'s `blockedOf` must pass the same
  capabilities, so the queue shows the PR as blocked.
- **Per-repo limit:** count running **rounds** of the repo, not running runs (`MAX_RUNNING_PER_REPO = 1`). Otherwise
  a pair blocks itself.
- **Manual "review running" check** in `triggerPrReview`: a round in `running` or `posting` (instead of runs in
  `running`/`completed`).
- **`mayStart` moves to rounds**, keeping the landed rule. Latest round of the PR: none → true. `failed` with
  `end_code = 'no_token'` → true. `failed` with `end_code = 'heads_differ'` and fewer than 3 rounds for the PR → true.
  Anything else → false. A `timed_out` round is never restarted by itself; the owner re-runs it (GWP-201). It stays
  one function, used by `prReviewQueue`, `startPrReviewRound` and the replay dispatcher.
- Rename every caller: `dispatchProject` and `triggerPrReview` (and GWP-201's re-run when it lands).
- The daily cap (`autoReviewsUsed`) is **unchanged**: it counts distinct PRs with an automatic run, so a pair counts
  as 1 (owner answer) and a timed-out pair still used its slot.

#### 4.4.3 Run results: `applyPrReviewRunResult`, changed

The replay branch stays first and unchanged. For a live run, in one transaction, **lock the round row first**
(`SELECT … FROM pr_review_rounds WHERE id = run.round_id FOR UPDATE`), then the run row. Lock in this order everywhere
(results, post results, sweep, cancel), so that two partner results cannot deadlock.

1. **The run is not `running`** (a duplicate, a late answer, or `cancelled`): ignore it and log (as landed).
2. **`timeout`:** `PrReviewRunTimedOut` (as landed). If the round is `running`: `PrReviewRoundEnded { outcome:
   'timed_out', causeRunId }`. For every partner still `running`: `PrReviewRunCancelled { reason: 'partner_timeout' }`,
   enqueue `pr_review.cancel { runId }`, and supersede the partner's pending `pr_review.run` command. Nothing else (AC4).
3. **`failed`** (including the "did not answer properly" case): the same, with `outcome: 'failed'`, `code` and
   `reason: 'partner_failed'`. A `no_token` cause keeps `end_code = 'no_token'`, so `mayStart` retries it as today.
4. **`completed`:** cap and store as landed (`applyFindingsCap` per run, `PrReviewRunCompleted`). **Remove the
   inline `buildReviewPost` and `enqueueReviewPost`.** Then, if any partner is still `running`, stop: the round waits.
   If this is the last run, call `mergeAndPostRound`.

#### 4.4.4 Merge, cap and post (AC2, AC3): `mergeAndPostRound(ctx, tx, round)`

1. **Head check:** if the round's completed runs report different `head_sha`, append `PrReviewRoundEnded { outcome:
   'failed', code: 'heads_differ' }` and post nothing. `mayStart` lets the next pass run a new round (at most 3).
2. Load each run's findings in `idx` order.
3. `merged = mergeFindings(rows)`.
4. `changedLines` = the first run's `changed_lines`, or `pr_reviews.changed_lines` when the run has none.
5. `{ cap, ordered } = applyFindingsCap(merged.map(m => ({ ...m.canonical, severity: m.severity })), changedLines)`.
   **The cap applies to the merged set**, so a round never posts more than 5 comments (AC2).
6. Append **`PrReviewRoundMerged`**: canonicals get `posted`/`held_back`, `rank` and the merged severity; duplicates
   get `merged`, `mergedInto` and `rank: null`. The projection updates the findings and the round (`changed_lines`,
   `findings_cap`, `held_back_count`, `merged_count`, state `posting`). With one run, the values are the same as the
   per-run cap already stored.
7. `buildReviewPost` takes the round: `{ postId: round.id, summary, headSha, baseSha }`.
   - `summary`: for a round of one, the run's summary (unchanged). For a pair, a neutral server line, for example
     "Automated review: 3 findings posted." **No model-written summary for a pair** (blind marking).
   - `selectFindingsToPost` keeps only `disposition === 'posted'` (it leaves out `held_back` and `merged`).
   - The marker is `prReviewMarker(round.id)`. The payload's `runId` field and `spec.runId` carry `round.id`.
   - Comment text is the canonical finding's own text, with the merged severity. Nothing says that two reviewers found
     it, or which one did.
   - `enqueueReviewPost(tx, run, round.workstation_id, post, …)`. It still refuses replay runs.
8. `applyPrReviewPostResult` reads `commandPayload.runId` as the round id and locks the round (old posts map too,
   because their round id is the run id):
   - `ok` → `PrReviewPosted { roundId, reviewers: round.reviewers, runId: <first run>, reviewer: 'first',
     reviewUrl, postedFindingIds }`. The projection sets the round and all its runs to `posted`, sets `posted = true`
     on `postedFindingIds` of the round's runs, and sets the PR to `reviewed`, `reviewed_by = reviewers[0]`,
     `reviewed_by_all = reviewers`.
   - `ok: false` on a `posting` round → `PrReviewRoundEnded { outcome: 'failed', code }` (at post stage). Also append
     the landed `PrReviewRunFailed { stage: 'post' }` for each run, so the run rows stay accurate.

**Precision credit (AC3).** A posted canonical finding with one merged duplicate has two rows in the view, one per
reviewer. `reviewerPrecisionForProject` groups by reviewer over `f.posted`, so the finding counts once in `posted`
for each reviewer, and its single mark counts as `useful` or `noise` for each. `findingMarksForReplay` lists it once
per reviewer. The duplicate row stays `posted = false` and is never marked or counted on its own.

#### 4.4.5 Sweeps (`sweepStalePrReviewRuns`), changed

- The replay branch stays first and unchanged.
- `running` live runs past `timeout_ms + RUN_GRACE_MS`: `PrReviewRunTimedOut { by: 'server' }`, then the round rule
  of 4.4.3 step 2.
- Replace "`completed` run older than `POST_WAIT_MS`" with "**`posting` round** older than `POST_WAIT_MS`" →
  `PrReviewRoundEnded { outcome: 'failed', code: 'post_unfinished' }`, and supersede its `pr_review.post` (match the
  payload's `runId`, which is the round id). In a pair, a completed run waiting for its partner is normal, not stale.
- Repair: a `running` round whose runs are all terminal (after a crash between transactions) is merged or ended as
  its runs dictate.

#### 4.4.6 Daily cap

No change (A4, owner answer 402ee50a). Add one test that a pair adds 1 to `used`.

#### 4.4.7 Read model (`listPrReviews`, `heldBackFindings`)

- **Keep the DTO key `lastRun`.** GWP-197/198/199/200's server tests, the web and the GWP-200 e2e read it. It now
  describes the latest **round**:
  - `state` maps `running → running`, `posting → completed`, `posted`, `timed_out`, `failed`.
  - `durationMs` is the slowest run, `findingsCount` and `heldBackCount` come from the round, and `error`/`code` come
    from the round's end or its cause run.
  - Add optional `runCount`, `mergedCount` and `runs: Array<{ state, durationMs, reviewer, model }>`.
  - For a round of one, every existing field keeps its value.
- **Blindness:** `runs[].reviewer`/`model` and `mergedCount` are `null` while `reviewersHidden` is true.
  `PrReviewDto.reviewer` stays (a single reviewer for a round of one, `null` for a pair). Add `reviewers:
  PrReviewer[] | null` (from `reviewed_by_all`) behind the same gate.
  - **Exception:** for a `timed_out` or `failed` round nothing was posted, so nothing is blind. Return the cause run's
    reviewer there, so the owner can see "the Opus run timed out".
- `heldBackFindings`: the latest round's runs, `disposition = 'held_back'` (merged rows are never listed).
- `listPostedFindings` needs no change. It reads `f.posted`, and `reviewers[]` comes from the view.

### 4.5 Runner (`apps/runner`)

- **`runPrReview`** (`src/review/run.ts`) gains `deps.signal?: AbortSignal`. On abort it behaves like the timer
  (stops the session, waits for the grace) but answers `failed`, code `cancelled`, not retryable. `cleanup` still runs.
- **`PrReviewCommands`** keeps an `AbortController` per live run id next to `runs`, and adds
  `cancel(payload): { found }`:
  - A live run → abort it and answer `{ found: true }`.
  - Otherwise → remember the `runId` for 15 minutes and answer `{ found: false }`. A later `pr_review.run` for a
    remembered id answers `failed`/`cancelled` at once, without a checkout or a session.
- `runner.ts`: route `pr_review.cancel` to `cancel`, and announce `PR_REVIEW_PAIR_CAPABILITY` in `hello.capabilities`
  next to `PR_REVIEW_CAPABILITY`.
- Server `runner-gateway/handlers.ts`: a `pr_review.cancel` result is logged only.
- Two runs on one PR already have separate folders, agents and logs (A6). Posting needs no change (A1).

### 4.6 Web (`apps/web`)

**New `src/components/SecondReviewerPanel.tsx`** on `pages/ProjectSettings.tsx`. It is shown only when the project
has a PR-only repo, and it is modelled on `ReleaseDocsPrepPanel.tsx`'s switch.

- Title "Second reviewer (Opus)". Help text: "Each pull request on a PR-only repository is reviewed by both reviewers.
  Their findings are combined before posting, and duplicates are posted once. It roughly doubles model spend per
  reviewed pull request; the daily limit still counts pull requests, so a pair is one review."
- The switch is `<input type="checkbox" role="switch" aria-checked>` in a `<label>` with a tap area of at least 44 px
  (`min-h-11`), with `data-testid="second-reviewer-switch"`.
- **No replay recorded:** the switch is disabled, with a `Callout` (`data-testid="second-reviewer-replay-required"`):
  "Record a 20-PR replay first. It measures both reviewers offline so you can compare them before the second reviewer
  comments on live pull requests." It links to GWP-203's replay page. A 409 `replay_required` (a race) is shown inline.
- **Replay recorded:** "Replay recorded <date>", plus the replay's precision per reviewer when present ("Sonnet 0.70 ·
  Opus 0.80"). The replay result is no longer blind once the replay has finished.
- People who are not the owner see read-only text. Hook `useSetSecondReviewer(projectId)` (PUT) invalidates the
  project detail.
- **All devices:** there is no text input, so no soft keyboard opens. Nothing is hover-only. The panel stacks at 320 px.

**Pull requests tab** (`pages/PullRequests.tsx`, from `lastRun`):

- Reviewed: "Reviewed <time> · 2 review runs · took 6 min 40 s · 4 comments (3 held back)". Reviewer names and
  "1 combined duplicate" appear only once revealed.
- Running: "Review running: 1 of 2 runs finished".
- Timed out (AC4): "Not reviewed: the Opus review run timed out after 10 minutes. No comments were posted by either
  reviewer."
- A cancelled run shows as "stopped (the other run did not finish)".
- The finding mark UI already renders `reviewers[]`. Check that `PR_REVIEWER_LABEL` covers `second` (it does, because
  GWP-203 added it).

### 4.7 Docs

`docs/USER-GUIDE.md`, in the PR-only reviews section, add **Second reviewer (Opus)**:

- It is switched on per project, only after a 20-PR replay in which both reviewers reviewed PRs has finished.
- Both reviewers run at the same time, each with a 10-minute limit.
- The findings are combined: the same issue is posted once (same file, and the same line, or nearby lines with a
  similar title), and the findings cap applies to the combined list.
- If either run times out or fails, nothing is posted, the PR stays "Not reviewed", and it is not retried by itself.
- A pair counts as one of the 20 automatic reviews a day. Switching Opus on roughly doubles model spend per reviewed
  PR.
- A finding found by both counts toward both reviewers' precision, and reviewers are shown only after marking.
- Manual reviews and re-runs use both reviewers while the switch is on.

`docs/RUNNER.md`: one line on `pr_review.cancel` and `pr-review-pair:1`.

## 5. Acceptance criteria mapped to the design and tests

All tests go in **new files**. Use fake models only: the fake runtime adapter on the runner, and fake
`command.result` answers on the server. Server tests need the test DB (Postgres 5433). If it is not reachable, name
the files in the handoff for the testers (standing order GWP-99). To seed a recorded replay, use GWP-203's events (see
`apps/server/test/pr-replay-run.test.ts`): a `finished` replay whose result has `prsReviewed >= 1` for both reviewers.

| AC | Design | Tests |
|---|---|---|
| **AC1** | `setSecondReviewer` → 409 `replay_required` (4.4.1); `reviewersFor` re-checks at round start (4.4.2); switch disabled in the web (4.6) | `apps/server/test/pr-review-second-reviewer-switch.test.ts`: (a) no replay → PUT `{enabled:true}` gives 409, no event, DTO `enabled=false`; (b) a replay that is `finished` but where Opus reviewed 0 PRs → still 409; (c) a recorded replay → 200, the event carries `replayId`; (d) manager 403, non-member 404; (e) switching off is always allowed; (f) flag set in the DB with no replay → the next round has `reviewers = {first}` only. `apps/web/src/test/second-reviewer-panel.test.tsx`: disabled with the Callout; with a replay a tap sends PUT; non-owner sees read-only text |
| **AC2** | `startPrReviewRound` enqueues 2 runs; the round waits; `mergeFindings` → `applyFindingsCap` → one post (4.4.2–4.4.4) | `apps/server/test/pr-review-pair-merge.test.ts`: Opus on, a fake workstation with `pr-review:1` and `pr-review-pair:1` → one dispatch pass enqueues exactly 2 `pr_review.run` (sonnet and opus, the same `roundId`, the same workstation). The first `completed` gives no `pr_review.post`. The second (4 + 4 findings, 1 duplicate, `changedLines` 250 → cap 3) gives exactly one post with 3 findings, `runId = roundId`, marker `review-run:<roundId>`, and a neutral summary. Post `ok` → PR `reviewed`, round `posted`, both runs `posted`, `reviewed_by_all = {first,second}`. The pair adds 1 to `used`. A workstation without `pr-review-pair:1` → queue `blocked`/`runner_outdated`, no run. `packages/shared/test/review-merge.test.ts`: one run is returned unchanged; findings found by both come first; the cap over the merged list never exceeds 5 |
| **AC3** | `isDuplicate`/`mergeFindings`; `merged` + `merged_into`; the view redefined (4.2–4.4.4) | `review-merge.test.ts`: same line → duplicate; 3 apart with "Null check missing on user" / "Missing null check for user" → duplicate; 3 apart with unrelated titles → not; 8 apart → not; one with a line and one without → not; same reviewer → never; one-to-one; canonical = higher severity, merged severity = the max; inputs not mutated. `pr-review-pair-merge.test.ts`: the pair is one comment; the view returns 2 rows (first, second) for the canonical; after the owner marks it `useful`, `reviewerPrecisionForProject` counts it in `posted` and `useful` for **both**; the merged row is not counted; before the mark the finding DTO has `reviewers: null` and the post contains neither "sonnet" nor "opus" |
| **AC4** | The round ends on the first timeout or failure; partners cancelled; late result ignored (4.4.3, 4.4.5); runner cancel (4.5) | `apps/server/test/pr-review-pair-timeout.test.ts`: (a) Sonnet completes, then Opus times out → no `pr_review.post` row, no finding with `posted = true`, round `timed_out`, PR `not_reviewed`, the next pass starts nothing; (b) Opus times out first → `pr_review.cancel` for Sonnet, Sonnet `cancelled`, a later Sonnet `completed` is ignored; (c) Opus `failed` → the same; (d) the backstop sweep with Opus silent → the same; (e) different heads → round `failed`/`heads_differ`, nothing posted, the next pass starts a new round; (f) Opus off: a round of one behaves as before (regression). `apps/runner/test/pr-review-cancel.test.ts`: a live fake session plus cancel → `stop` is called, `failed`/`cancelled`, cleanup runs, `found: true`; cancel before run → `found: false`, then the run answers `cancelled` without `startChat` |

**Regression (likely-regression standing order):**

- Re-run unchanged: `apps/server/test/pr-review-runs.test.ts`, `pr-review-daily-cap.test.ts`,
  `pr-review-marks.test.ts`, `pr-replay-run.test.ts`, `pr-only-*.test.ts`, `apps/runner/test/pr-review-*.test.ts`,
  `packages/shared/test/pr-replay.test.ts`, `review-marks.test.ts` and `pr-review-queue.test.ts`. With Opus off they
  must pass as they are. If one fails only because it asserts an internal detail that rounds replace (for example
  "a completed run older than 15 minutes"), say so in the handoff rather than weakening it.
- Search for every user of `startPrReviewRun`, `mayStart`, `pickReviewerWorkstation`, `buildReviewPost`,
  `selectFindingsToPost`, `FindingDisposition`, `PrReviewPosted`, `reviewed_by`, `lastRun` and
  `pr_review_finding_attribution`.
- Run `apps/server/test/dispatch-full.test.ts`. Unit and server tests only. Leave the GWP-200 e2e
  (`e2e/**`) to the testers.

## 6. Risks

- **Opus is slower, so more rounds time out.** The whole PR is then "Not reviewed". The replay shows run times per
  reviewer. Do not change the timeout in this card.
- **Spend roughly doubles per PR** while the cap stays at 20 PRs (owner decision). Cancelling the partner limits waste.
- **The duplicate rule can miss paraphrased duplicates or merge two different issues.** The merged row is kept, the
  thresholds are named constants, and the round stores `merged_count`.
- **Blindness through writing style.** The canonical choice does not depend on the reviewer, and a pair's summary is
  neutral.
- **Head moved between the two checkouts.** The round fails with `heads_differ` and is retried up to 3 rounds.
- **Lock order.** Round row before run row everywhere, or two partner results can deadlock.
- **Workstation capacity.** A pair takes both run slots, so automatic reviews on a workstation run one PR at a time.
  The replay dispatcher already waits for live work.

## 7. Files

New:
- `packages/shared/src/review/merge.ts`
- `apps/server/migrations/2960_pr_review_rounds.sql`
- `apps/server/src/commands/pr-review-rounds.ts` (switch, `reviewersFor`, `startPrReviewRound`, `mergeAndPostRound`, round end and cancel helpers)
- `apps/server/src/projections/pr-review-rounds.ts`
- `apps/web/src/components/SecondReviewerPanel.tsx`

Changed:
- `packages/shared/src/review/pr-review.ts`, `review/findings.ts`, `events/project.ts`, `protocol/runner.ts`
  (`pr_review.cancel`), `api/projects.ts`, the index exports
- `apps/server/src/commands/pr-review-runs.ts` (start → round, result handling, post result, sweep, `listPrReviews`,
  `heldBackFindings`, `buildReviewPost`/`selectFindingsToPost`)
- `apps/server/src/review/may-start.ts`, `apps/server/src/review/reviewer-gate.ts` (picker capabilities and slots)
- `apps/server/src/commands/pr-review-cap.ts` (`blockedOf` passes the pair capability; the counter is unchanged)
- `apps/server/src/queries/pr-replays.ts` (`latestRecordedReplay`), `apps/server/src/queries/misc.ts` (project DTO)
- `apps/server/src/projections/pr-review-runs.ts` (round id, `cancelled`, `PrReviewPosted` per round),
  `projections/projects.ts`, `projections/index.ts` (projectors and `PROJECTION_TABLES`)
- `apps/server/src/routes/projects.ts`, `apps/server/src/runner-gateway/handlers.ts`
- `apps/runner/src/runner.ts`, `apps/runner/src/review/pr-review-commands.ts`, `apps/runner/src/review/run.ts`
- `apps/web/src/pages/ProjectSettings.tsx`, `apps/web/src/pages/PullRequests.tsx`,
  `apps/web/src/api/queries/pr-reviews.ts`
- `docs/USER-GUIDE.md`, `docs/RUNNER.md`

New tests:
- `packages/shared/test/review-merge.test.ts`
- `apps/server/test/pr-review-second-reviewer-switch.test.ts`
- `apps/server/test/pr-review-pair-merge.test.ts`
- `apps/server/test/pr-review-pair-timeout.test.ts`
- `apps/runner/test/pr-review-cancel.test.ts`
- `apps/web/src/test/second-reviewer-panel.test.tsx`

## 8. Recommendation

- Model the pair as a **review round**: two independent runs (Sonnet and Opus) on one workstation, sharing a
  `round_id`. A round of one is today's behaviour.
- The server waits for both runs, merges them with one deterministic shared rule, applies the landed cap again to the
  merged list, and sends one post keyed by the round id.
- Any timeout or failure ends the round at once, cancels the partner and posts nothing.
- The landed attribution view, redefined with its four columns, credits a merged finding to both reviewers.
- The switch is refused until a replay in which both reviewers reviewed PRs has finished, and it is checked again at
  round start.
- The pair counts as one automatic review (owner decision). The landed counter already does this.

## 9. Assumptions (checked 2026-11-14)

See section 0. A1 and A6 hold. A2, A3, A4 and A5 were revised in this report. A7 (GWP-201 calls
`startPrReviewRound`) stays open until GWP-201 lands.
