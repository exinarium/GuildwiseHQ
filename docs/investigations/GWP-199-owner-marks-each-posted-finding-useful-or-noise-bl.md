# GWP-199: Owner marks each posted finding useful or noise, blind to the reviewer; precision per reviewer

> **Revised 2026-11-14 against the landed GWP-197 and GWP-198 code** (merge 6d5e3846).
> - Assumptions 2, 4 and 6 hold.
> - Assumptions 1, 3 and 5 hold only in part. §0 says what changed. §4 and §5 now use the names that shipped.
> - Every decision in §3 stands except the placement of the precision panel (§3.6).

## 0. What the landed code changed (assumption review)

| # | Assumption | Landed code | Verdict and effect |
|---|---|---|---|
| 1 | Each posted finding is its own row: uuid `id`, `review_id`, title/body/path/line, `posted_at`, comment URL | `pr_review_findings` (migration `2920_pr_review_runs.sql`): `id uuid`, `run_id`, `pr_review_id`, `idx`, `path NOT NULL`, `line`, `anchored`, `severity` (`high/medium/low`), `title`, `body`, `posted boolean`. There is **no per-finding `posted_at` or comment URL**: all findings of a run go out as **one** GitHub review, and `pr_review_runs.posted_at` / `review_url` hold the time and link. `posted` becomes true only on `PrReviewPosted`. Projection tables have **no foreign keys** (rebuild). | **Partly wrong.** Finding ids are stable uuids, so the mark table keys on `finding_id`. But: (a) use `pr_review_id` and `run_id`, not `review_id`; (b) the posted filter is **`f.posted`**, not `posted_at IS NOT NULL`; (c) `postedAt` and `reviewUrl` come from the run; (d) no `REFERENCES` in the migration. |
| 2 | Reviewer key and exact model recorded per finding or per run | `pr_review_runs.reviewer` (`'first'`), `runtime` (`'claude-code'`), `model` (`'sonnet'`, from `REVIEWER_MODEL.first`). Recorded per run and reached through `f.run_id`. | **Holds.** The model is the alias the run used (`sonnet`), not a dated id. The design reveals whatever the run stored. |
| 3 | PR review row (project, repo, PR number/URL, head SHA), PR review read and web view, PR-review stream and projection | `pr_reviews` has `project_id`, `project_repo_id`, `change_id` (the PR number as text) and `url`. **`head_sha` is on the run.** Read: `listPrReviews` → `GET /api/projects/:id/pull-requests` → `PullRequestsPage.tsx` (Pull requests tab). Projection: `projections/pr-review-runs.ts`. Events are in `packages/shared/src/events/project.ts` on **`streamId.project(projectId)`**; there is no PR-review stream. **There is no list of posted findings anywhere** (API or web): the tab shows counts, a "View on GitHub" link and GWP-198's held-back list. The row says **"Reviewed … by Sonnet reviewer"** (`PrReviewDto.reviewer` → `REVIEWER_LABEL`), unconditionally. | **Partly wrong.** The card grows by one read and one UI list. It adds `GET /api/pr-reviews/:id/findings` (posted findings with marks, blind) and a `PostedFindings` list in each row, shaped like `HeldBackFindings`. The event goes on the project stream. `listPrReviews` must hide `reviewer` and the "by Sonnet reviewer" text while that PR has unmarked posted findings. |
| 4 | `disposition` (`posted`/`held_back`) and `rank` per finding in the same table | `2930_pr_review_findings_cap.sql` adds `rank` and `disposition` to `pr_review_findings`. | **Holds.** Note: `disposition='posted'` means "chosen for posting". A completed run whose post failed has `disposition='posted'` but `posted=false`. Count `f.posted` (held-back rows are never `posted`). |
| 5 | One comment-only identity for every reviewer, with a runner-side formatter | Identity: one comment-only token per repository (`ReviewerTokenStore`, keyed by remote). Every reviewer posts through it as a single `COMMENT` review, with no check runs or statuses. Formatter: mostly **on the server**: `buildReviewPost` in `apps/server/src/commands/pr-review-runs.ts` builds the title `[severity] title`, the body, the summary and the run marker `<!-- review-run:<runId> -->`. The runner (`review-poster.ts` `findingText`/`whereOf`) only lays the text out. The strict `PrReviewPostPayloadSchema` has **no reviewer or model field**, so the runner cannot add one. One gap: the **summary is written by the model** and nothing stops it naming itself. | **Identity holds; formatter location wrong.** No production change is needed for the formatter. Add one instruction line in `apps/runner/src/review/instructions.ts` so the model does not name itself, the model or the tool. Testing changes too (§5): runner test on the poster's request body, plus a server assertion on `buildReviewPost` (Postgres, testers). |
| 6 | A timed-out run stores no findings; each re-run has its own findings; all posted findings count | `PrReviewRunTimedOut` writes no findings. `mayStart` never restarts a run automatically. A manual re-run (GWP-201) will be a new `pr_review_runs` row with its own findings. | **Holds.** Precision and replay count every `posted` finding of every run. No latest-run filter. |

## 1. Question

PRD "Review Gates & Reviewer Workflow" v22 (doc 61871304), F2:

- Replace valid/invalid with **useful/noise**, one mark per finding. The precision measure counts *useful* findings out of findings *posted*.
- **F2c**: the owner can mark each posted finding useful or noise.
- **F2d**: the marks are stored and used as input to the 20-PR replay, which sets the reviewer precision target.
- Decision log: *Blind marking, reviewer revealed after* (to keep the precision ratio unbiased).
- §10: *It works if the precision ratio is recorded per reviewer.*

This report designs:

1. the mark type and storage
2. the owner-only mark command
3. how blindness is enforced
4. the replay query
5. precision per reviewer per project
6. the touch-friendly marking UI
7. the PR comment text.

## 2. Findings

- **The PR-review code is in place** (GWP-196/197/198). See §0 for the tables, events, read and page.
- **A mark-on-a-record pattern already exists**: digest item rating.
  - The command (`commands/digests.ts::rateDigestItem`) runs `withAppendTx`, locks the row `FOR UPDATE`, checks membership, appends an event and returns the DTO.
  - The web side (`components/DigestRating.tsx`) shows verdict buttons, then a badge and a **Change** button.
  - GWP-199 copies it, but **owner-only** and **with no free-text reason**: one tap and no soft keyboard.
- **Owner check**:
  - `authz/scope.ts::requireProjectMember` returns `'owner' | 'manager'` and throws 404 for a non-member.
  - `forbidden()` gives 403.
  - `conflict(code, msg)` gives 409.
- **Server tests all need Postgres** (`apps/server/vitest.config.ts` `globalSetup`). This includes tests of pure functions such as `buildReviewPost`. The pure logic therefore goes in `packages/shared` and is unit-tested there. The server suite is for the testers or DevOps (standing order GWP-99).
- **Migrations**: the latest is `2930_pr_review_findings_cap.sql`. Use `2940_pr_review_finding_marks.sql` or the next free number at build time.
- **Where the reviewer leaks today, and what to do about each:**

  | Where | What leaks | Action |
  |---|---|---|
  | `PrReviewDto.reviewer` and the row text "by Sonnet reviewer" | The reviewer | **Gate it** |
  | `PrReviewPosted` / `PrReviewRunStarted` events (`reviewer`, `model`) | The reviewer and model | These are internal event payloads, not served to the web. No change. The new mark event carries no reviewer. |
  | The held-back list | Nothing: already reviewer-free (GWP-198) | None |
  | The model-written review summary | The model could name itself | Instruction line |
  | The precision panel's posted counts | Per-reviewer counts while a new PR is unmarked | §3.6 |

## 3. Options compared (unchanged decisions in brief)

- **3.1 Storage**: a new table `pr_review_finding_marks` (PK `finding_id`), written by a projection of a `PrReviewFindingMarked` event. History is in the event log. *Chosen.* The alternatives were columns on `pr_review_findings` or events only.
- **3.2 Blindness enforced on the server**:
  - The finding DTO has `reviewers: null` while unmarked.
  - PR-level reviewer details are withheld until every posted finding of that PR is marked.
  - Hiding the reviewer only in the web would leave it in the payload. *Chosen: server.*
- **3.3 Surfaces**: only the owner's web view shows the mark and the revealed reviewer. The PR comment never names the reviewer or model and is never edited. *Chosen.*
- **3.4 Denominator**: `useful / posted`, where unmarked posted findings count, returned with `useful`, `noise` and `unmarked`. This is the literal PRD v22 definition. *Chosen.*
- **3.5 Changing a mark**:
  - Precision uses the **current** mark.
  - `blind_mark` and `first_marked_at` keep the first mark and are never overwritten. The replay returns both.
  - There is no unmark.

### 3.6 Precision panel placement (revised)

The original design put the panel on a PR reviews *list* page, apart from a per-PR marking view. The landed code has **one page**, the project's **Pull requests** tab, and marking is added to its rows. The options:

| Option | Pros | Cons |
|---|---|---|
| **A. Panel on the Pull requests tab, collapsed by default** ("Reviewer precision" disclosure button, 44 px; counts load only when opened) (recommended) | No new page or route. The owner does not have per-reviewer counts in view while marking unless they open it. | Opening it while a PR is unmarked can still let the owner work out per-reviewer counts (accepted as minor, as before). |
| B. A new project page for precision | Full separation. | New route, tab and help entry for one small table. |
| C. Always-open panel at the top of the tab | Simplest. | Puts per-reviewer counts next to unmarked findings. |

## 4. Recommendation and design

### 4.1 packages/shared: `src/review/marks.ts` (new, exported from `src/index.ts` like `findings.ts`)

```ts
import { z } from 'zod';
import { PrReviewerSchema, type PrReviewer } from './pr-review.ts';

/** PRD v22 F2: one mark per posted finding. Never valid/invalid. */
export const FindingMarkSchema = z.enum(['useful', 'noise']);
export type FindingMark = z.infer<typeof FindingMarkSchema>;

export const MarkFindingRequestSchema = z.object({ mark: FindingMarkSchema }).strict();
export type MarkFindingRequest = z.infer<typeof MarkFindingRequestSchema>;

/** Display names; moved here from PullRequestsPage.tsx so the server can fill `label`. */
export const PR_REVIEWER_LABEL: Record<PrReviewer, string> = { first: 'Sonnet reviewer' };

/** Who produced a finding; present only once the finding is marked. */
export const FindingReviewerSchema = z.object({
  key: PrReviewerSchema,        // pr_review_runs.reviewer ('first'; GWP-204 adds a second)
  label: z.string(),            // PR_REVIEWER_LABEL[key]
  model: z.string().nullable(), // pr_review_runs.model, e.g. 'sonnet'
});
export type FindingReviewer = z.infer<typeof FindingReviewerSchema>;

/** One posted finding as the owner sees it on the Pull requests tab. */
export const PostedFindingDtoSchema = z.object({
  id: z.uuid(),
  prReviewId: z.uuid(),
  runId: z.uuid(),
  rank: z.number().int().positive().nullable(),
  severity: z.enum(['high', 'medium', 'low']),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  title: z.string(),
  body: z.string(),
  postedAt: z.string().nullable(),   // pr_review_runs.posted_at
  reviewUrl: z.string().nullable(),  // pr_review_runs.review_url (one review per run; no per-comment URL)
  mark: FindingMarkSchema.nullable(),
  markedAt: z.string().nullable(),
  /** Blind marking: null while `mark` is null. */
  reviewers: z.array(FindingReviewerSchema).nullable(),
  canMark: z.boolean(),
});
export type PostedFindingDto = z.infer<typeof PostedFindingDtoSchema>;

export const PostedFindingsResponseSchema = z.object({ findings: z.array(PostedFindingDtoSchema) });

export type PostedFindingRow = Omit<PostedFindingDto, 'reviewers' | 'canMark'> & { reviewers: FindingReviewer[] };

/** The ONLY way the server builds a finding DTO: drops the reviewers while unmarked. */
export function findingView(row: PostedFindingRow, opts: { canMark: boolean }): PostedFindingDto {
  const { reviewers, ...rest } = row;
  return { ...rest, reviewers: row.mark ? reviewers : null, canMark: opts.canMark };
}

/** PR-level reviewer details only once every posted finding is marked (an empty list reveals). */
export function reviewersRevealed(findings: ReadonlyArray<{ mark: FindingMark | null }>): boolean {
  return findings.every((f) => f.mark !== null);
}

export const ReviewerPrecisionSchema = z.object({
  reviewer: PrReviewerSchema,
  label: z.string(),
  models: z.array(z.string()),
  posted: z.number().int().nonnegative(),
  useful: z.number().int().nonnegative(),
  noise: z.number().int().nonnegative(),
  unmarked: z.number().int().nonnegative(),
  /** useful / posted; null when nothing was posted. */
  precision: z.number().min(0).max(1).nullable(),
});
export type ReviewerPrecision = z.infer<typeof ReviewerPrecisionSchema>;

/**
 * useful / posted per reviewer. A row counts when disposition is 'posted' and `posted` is not false
 * (live: f.posted; the offline replay of GWP-203 leaves `posted` undefined). Held-back rows never count.
 */
export function reviewerPrecision(
  rows: ReadonlyArray<{ reviewer: PrReviewer; model?: string | null; disposition: 'posted' | 'held_back';
                        posted?: boolean; mark: FindingMark | null }>,
): ReviewerPrecision[] { /* group, count, precision = posted ? useful/posted : null; sort by reviewer */ }

export const FindingMarkReplayRowSchema = z.object({
  findingId: z.uuid(), runId: z.uuid(), prReviewId: z.uuid(), projectId: z.uuid(),
  repoId: z.uuid(), repoName: z.string(), changeId: z.string(), prUrl: z.string(), headSha: z.string().nullable(),
  reviewer: PrReviewerSchema, model: z.string(),
  severity: z.enum(['high', 'medium', 'low']), rank: z.number().int().nullable(),
  path: z.string(), line: z.number().int().nullable(), title: z.string(),
  mark: FindingMarkSchema, blindMark: FindingMarkSchema,
  markedBy: z.uuid(), markedAt: z.string(), firstMarkedAt: z.string(), postedAt: z.string().nullable(),
});
```

`PrReviewDtoSchema` (in `pr-review.ts`) gets two optional fields: `reviewersHidden: z.boolean().optional()` and `unmarkedCount: z.number().optional()`, the number of this PR's posted findings without a mark. `reviewer` stays nullable and is `null` while `reviewersHidden`. Then `apps/web/src/components/pull-requests/PullRequestsPage.tsx` imports `PR_REVIEWER_LABEL` instead of its local `REVIEWER_LABEL`.

### 4.2 Event: `packages/shared/src/events/project.ts`, next to `PrReviewPosted`

```ts
/** The project owner marked a posted finding useful or noise. No reviewer in the payload (blind marking). */
defineEvent('PrReviewFindingMarked', z.object({
  projectId: Id, prReviewId: Id, runId: Id, findingId: Id,
  mark: FindingMarkSchema, previousMark: FindingMarkSchema.nullable(), markedBy: Id, at: IsoDate,
})),
```

Stream: `streamId.project(projectId)`, as with every other PR-review event.

### 4.3 apps/server

**Migration** `apps/server/migrations/2940_pr_review_finding_marks.sql` (no foreign keys, following the projection convention):

```sql
-- Owner marks (useful/noise) on posted PR review findings. Projection of PrReviewFindingMarked. No foreign keys.
CREATE TABLE IF NOT EXISTS pr_review_finding_marks (
  finding_id      uuid PRIMARY KEY,
  pr_review_id    uuid NOT NULL,
  run_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  mark            text NOT NULL CHECK (mark IN ('useful','noise')),
  blind_mark      text NOT NULL CHECK (blind_mark IN ('useful','noise')),  -- first mark, given blind; never updated
  marked_by       uuid NOT NULL,
  marked_at       timestamptz NOT NULL,
  first_marked_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_review_finding_marks_project ON pr_review_finding_marks (project_id, marked_at);
CREATE INDEX IF NOT EXISTS pr_review_finding_marks_pr ON pr_review_finding_marks (pr_review_id);

-- Who produced a finding. One reviewer per finding today (the run's). GWP-204 redefines this view when merged
-- findings carry several reviewers; the finding, precision and replay queries read only this view.
CREATE OR REPLACE VIEW pr_review_finding_attribution AS
  SELECT f.id AS finding_id, run.reviewer, run.model, run.runtime
    FROM pr_review_findings f JOIN pr_review_runs run ON run.id = f.run_id;
```

**Projection**: add `PrReviewFindingMarked` to `prReviewRunProjectors` in `projections/pr-review-runs.ts`, which is already registered:

```sql
INSERT INTO pr_review_finding_marks (finding_id, pr_review_id, run_id, project_id, mark, blind_mark, marked_by, marked_at, first_marked_at)
VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$7)
ON CONFLICT (finding_id) DO UPDATE SET mark=EXCLUDED.mark, marked_by=EXCLUDED.marked_by, marked_at=EXCLUDED.marked_at;
```

**Command**: new file `apps/server/src/commands/pr-review-marks.ts`.

```ts
export async function markFinding(ctx, user, findingId, req: MarkFindingRequest): Promise<PostedFindingDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const f = await one(tx, `SELECT f.id, f.posted, f.run_id, f.pr_review_id, pr.project_id
                               FROM pr_review_findings f JOIN pr_reviews pr ON pr.id = f.pr_review_id
                              WHERE f.id=$1 FOR UPDATE OF f`, [findingId]);
    if (!f) throw notFound('finding not found');
    const role = await requireProjectMember(tx, user.id, f.project_id);     // 404 for non-members
    if (role !== 'owner') throw forbidden('only the project owner marks findings');
    if (!f.posted) throw conflict('finding_not_posted', 'only posted findings can be marked'); // held back, or post failed
    const prev = await one(tx, 'SELECT mark FROM pr_review_finding_marks WHERE finding_id=$1', [findingId]);
    if (prev?.mark !== req.mark) {
      await ctx.store.append([{ streamId: streamId.project(f.project_id), event: { type: 'PrReviewFindingMarked',
        payload: { projectId: f.project_id, prReviewId: f.pr_review_id, runId: f.run_id, findingId,
                   mark: req.mark, previousMark: prev?.mark ?? null, markedBy: user.id, at: ctx.clock.now().toISOString() } },
        actor: userActor(user.id), scope: /* as in pr-review-runs.ts scopeOf(orgId, projectId) */ }], { tx });
    }
    return loadPostedFinding(tx, findingId, { canMark: true });   // same mark again: no event, same DTO
  });
}
```

Only a signed-in owner marks. No agent tool, CEO action or `aom` command gets a mark action.

**Queries**: new file `apps/server/src/queries/pr-review-marks.ts`. If the repository keeps reads in `commands/`, as `listPrReviews` does, put them in `commands/pr-review-marks.ts` instead.

- **`listPostedFindings(db, prReviewId, { canMark })` / `loadPostedFinding(db, findingId, { canMark })`**:
  - Select `pr_review_findings f WHERE f.posted` for that PR, across all runs.
  - Join `pr_review_runs run` to get `posted_at` and `review_url`.
  - Left-join `pr_review_finding_marks m`.
  - Build `reviewers` from `pr_review_finding_attribution` (`json_agg(json_build_object('key',a.reviewer,'model',a.model))`); the label comes from `PR_REVIEWER_LABEL`.
  - Map every row through **`findingView`**.
  - Order `run.posted_at DESC, f.rank NULLS LAST, f.path, f.line NULLS FIRST, f.id`. This order never depends on the reviewer.
- **`listPrReviews` (existing, `commands/pr-review-runs.ts`)**:
  - Add `(SELECT count(*)::int FROM pr_review_findings f LEFT JOIN pr_review_finding_marks m ON m.finding_id=f.id WHERE f.pr_review_id=pr.id AND f.posted AND m.finding_id IS NULL) AS unmarked_count`.
  - Return `unmarkedCount` and `reviewersHidden: unmarked_count > 0`.
  - Return `reviewer: reviewersHidden ? null : reviewed_by`.
  - `postedCount`, `findingsCount`, `heldBackCount` and run times stay. They are PR-level, and with one live reviewer they are not per-reviewer. When GWP-204 adds per-reviewer counts, those go behind the same gate.
- **Replay input `findingMarksForReplay(db, projectId, { since?, reviewer? })`**:

  ```sql
  SELECT m.finding_id, m.run_id, m.pr_review_id, m.project_id, pr.project_repo_id AS repo_id, r.name AS repo_name,
         pr.change_id, pr.url AS pr_url, run.head_sha, a.reviewer, a.model,
         f.severity, f.rank, f.path, f.line, f.title,
         m.mark, m.blind_mark, m.marked_by, m.marked_at, m.first_marked_at, run.posted_at
    FROM pr_review_finding_marks m
    JOIN pr_review_findings f ON f.id = m.finding_id
    JOIN pr_review_runs run ON run.id = f.run_id
    JOIN pr_reviews pr ON pr.id = f.pr_review_id
    JOIN project_repos r ON r.id = pr.project_repo_id
    JOIN pr_review_finding_attribution a ON a.finding_id = f.id
   WHERE m.project_id = $1 AND f.posted
     AND ($2::timestamptz IS NULL OR m.marked_at >= $2) AND ($3::text IS NULL OR a.reviewer = $3)
   ORDER BY run.posted_at, f.rank NULLS LAST, m.finding_id;
  ```

- **Precision `reviewerPrecisionForProject(db, projectId)`**:

  ```sql
  SELECT a.reviewer, array_agg(DISTINCT a.model) AS models,
         count(*)::int AS posted,
         count(*) FILTER (WHERE m.mark = 'useful')::int AS useful,
         count(*) FILTER (WHERE m.mark = 'noise')::int  AS noise,
         count(*) FILTER (WHERE m.mark IS NULL)::int    AS unmarked
    FROM pr_review_findings f
    JOIN pr_reviews pr ON pr.id = f.pr_review_id
    JOIN pr_review_finding_attribution a ON a.finding_id = f.id
    LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id
   WHERE pr.project_id = $1 AND f.posted
   GROUP BY a.reviewer ORDER BY a.reviewer;
  ```

  Then `precision = posted ? useful / posted : null` in TypeScript. Held-back findings (never `posted`), findings whose post failed and timed-out runs (no findings) are all excluded.

**Routes**: new file `apps/server/src/routes/pr-review-marks.ts`, registered in `app.ts`. Alternatively, add them to `routes/projects.ts` next to `/api/pr-reviews/:id/held-back`.

| Method and path | Auth | Returns |
|---|---|---|
| `GET /api/pr-reviews/:id/findings` | Project member (`loadVisibleProject` via `pr_reviews.project_id`), else 404 | `{ findings: PostedFindingDto[] }`, blind. `canMark` = role is owner. |
| `PUT /api/pr-review-findings/:id/mark`, body `{ mark }` | `requireUser`. Non-member gets 404, manager gets 403, not posted gets 409 `finding_not_posted` | `PostedFindingDto` with the reviewers revealed |
| `GET /api/projects/:id/reviewer-precision` | Project member | `{ reviewers: ReviewerPrecision[] }` |
| `GET /api/projects/:id/pr-review-marks?since=&reviewer=` | Project member | `{ marks: FindingMarkReplayRow[] }` (replay input) |

### 4.4 PR comment text (server `buildReviewPost` and runner poster)

- **No change to `buildReviewPost` or `review-poster.ts`.** The post payload schema is strict and has no reviewer or model field. The title is `[severity] title`, and the marker `<!-- review-run:<runId> -->` is an opaque uuid. Everything is posted through the repository's one comment-only token as one `COMMENT` review, with no check run or status.
- **`apps/runner/src/review/instructions.ts`**: add one rule: "Do not name yourself, the model, the tool or the vendor in the summary or in any finding." The summary is free model text and the only place a name could appear.
- The comment is never edited after marking.

### 4.5 apps/web

**`apps/web/src/components/pull-requests/PostedFindings.tsx`** (new):

- Placed in each `Row` of `PullRequestsPage.tsx`, above `HeldBackFindings`, when `pr.lastRun?.postedCount > 0` or `unmarkedCount > 0`.
- A 44 px disclosure button: "Show N posted findings", with "(M to mark)" for the owner. Opening it fetches `usePostedFindings(prReviewId, open)` (`GET /pr-reviews/:id/findings`). Each finding's `canMark` decides whether its buttons show.
- Each finding shows `[severity] title`, `path:line`, the body (Markdown as plain text, as `HeldBackFindings` does), and **`FindingMark`**.

**`apps/web/src/components/pull-requests/FindingMark.tsx`** (new; GWP-203 reuses it with its own mutation):

- **Unmarked**:
  - A `<fieldset>` with `<legend class="sr-only">Mark finding: {title}</legend>`.
  - Two buttons, **Useful** and **Noise**, `grid grid-cols-2 gap-2`, each `min-h-11`.
  - No text input and no hover-only state.
  - The hint "Reviewer shown after you mark".
  - Disabled while pending.
  - **No optimistic update**: the reviewer arrives only in the server response.
- **Marked**:
  - A badge, **Useful** (green) or **Noise** (neutral), plus "marked {date}" and "Reviewer: {label} · {model}".
  - A **Change** button (44 px) re-opens the two buttons, with the current one `aria-pressed="true"`.
- **Not the owner**: no buttons. Unmarked shows "Not marked yet"; marked shows the badge and the reviewer.
- Errors are shown inline with `ErrorBox`.

**`PullRequestsPage.tsx` `Detail`**: when `pr.reviewersHidden`, render "Reviewed {date} · reviewer shown once every posted finding is marked" instead of "by Sonnet reviewer". Use `PR_REVIEWER_LABEL` from shared.

**`apps/web/src/components/pull-requests/ReviewerPrecisionPanel.tsx`** (new):

- Top of the Pull requests tab, **collapsed**: a "Reviewer precision" disclosure button, 44 px, which fetches on open (§3.6).
- A table on wider screens and stacked cards on phones. Columns: reviewer, model(s), posted, useful, noise, unmarked, precision.
- Precision is shown as `0.75` (`toFixed(2)`), with the percent in `title`, and "–" when null.
- Caption: "Precision = useful ÷ posted. Held-back findings are not counted. Unmarked findings count as posted."

**Hooks**: add to `apps/web/src/api/queries/pr-reviews.ts`:

- `usePostedFindings(prReviewId, enabled)`, key `['pr-posted-findings', id]`
- `useMarkFinding()`: PUT. On success it sets the returned DTO into the list cache and invalidates `['pull-requests', projectId]` and `['reviewer-precision', projectId]`.
- `useReviewerPrecision(projectId, enabled)`
- `usePrReviewMarks(projectId)`, for API completeness only.

Update the Pull requests help entry in `apps/web/src/help/page-help-content.ts` with one sentence on marking.

### 4.6 docs/USER-GUIDE.md

Add to the **PR-only reviews** subsection of §4.3c, after the held-back paragraph:

> **Marking findings (useful or noise):** on the **Pull requests** tab, **Show N posted findings** lists what the reviewer posted. The project owner marks each one **Useful** or **Noise** with one tap. Until you mark a finding you do not see which reviewer or model produced it, and neither the pull request comment nor the tab says so (the tab shows the reviewer once every posted finding of that pull request is marked), so your mark is not influenced by who wrote it. You can change a mark with **Change**. Held-back findings are not marked. **Reviewer precision** (open it at the top of the tab) is useful findings divided by posted findings, per reviewer, for this project. Unmarked findings count as posted, so mark them all for a true figure. The marks are also the input to the 20-PR replay that sets the precision target.

## 5. Acceptance criteria mapped to the design and tests

| AC | Design | Tests (new files) |
|---|---|---|
| **AC1** | `PUT /api/pr-review-findings/:id/mark` → `markFinding` → `PrReviewFindingMarked` → projection (§4.2, §4.3). `FindingMark.tsx` shows the badge and **Change**. | `apps/server/test/pr-review-marks.test.ts` (Postgres, testers): owner marks useful, then `GET /api/pr-reviews/:id/findings` shows `mark: 'useful'`; change to noise, then `blind_mark` stays `useful` and 2 events exist; same mark again appends no event; manager gets 403; non-member gets 404; held-back finding and a `posted=false` finding get 409. `apps/web/src/test/pr-finding-mark.test.tsx`: tap Useful sends PUT `{mark:'useful'}` and shows the badge; Change shows `aria-pressed`; non-owner sees no buttons. |
| **AC2** | `findingView`, `reviewersRevealed`, the `listPrReviews` gate (`reviewer: null`, `reviewersHidden`), the event without a reviewer, and the instruction rule (§4.1–§4.4) | `packages/shared/test/review-marks.test.ts`: unmarked gives `reviewers: null`, and the JSON has no `first`/`sonnet`/label; marked shows them; `reviewersRevealed` cases. `apps/runner/test/pr-review-comment.test.ts`: the request body `GitHubReviewPoster` sends (fetch mock), for inline and loose findings and the 422 fallback, contains no `sonnet`, `opus` or `claude` (case-insensitive) and no "reviewer:"; the instructions contain the do-not-name-yourself rule. Server test: `buildReviewPost` output has no reviewer or model; `/pull-requests` before marking has `reviewer: null`, `reviewersHidden: true` and no "sonnet" in the JSON; after every posted finding is marked, `reviewer: 'first'`. `apps/web/src/test/pr-finding-mark.test.tsx`: unmarked shows no reviewer text, the reviewer appears after the mark response, and the row shows "reviewer shown once…" when `reviewersHidden`. |
| **AC3** | `findingMarksForReplay` and `GET /api/projects/:id/pr-review-marks` | Server test: mark 2 of 3 posted findings; exactly those 2 come back with `reviewer`, `model`, `changeId`, `prUrl`, `repoName`, `mark`, `blindMark`, `markedAt` and `postedAt`; unmarked and held-back findings are absent; the `reviewer` filter works. |
| **AC4** | `reviewerPrecision` (shared), the `reviewerPrecisionForProject` SQL and `ReviewerPrecisionPanel` | Shared test: 4 posted (3 useful, 1 noise) plus 2 held-back marked useful gives `posted 4, useful 3, precision 0.75`; 3 useful + 1 unmarked gives 0.75 with `unmarked 1`; `posted:false` rows are not counted; 0 posted gives `null`. Server test: the same fixture through `/reviewer-precision` gives 0.75. `apps/web/src/test/reviewer-precision.test.tsx`: opening the panel renders `0.75`, and "–" for null. |

The builder runs the shared, runner and web unit suites. `apps/server/test/pr-review-marks.test.ts` needs Postgres: name it in the handoff for the testers. No e2e.

## 6. Risks

- **Indirect leaks**:
  - The server-side mapping, the reviewer-free event, reviewer-independent ordering, one token identity, no check runs, the PR-level gate and the instruction rule cover them.
  - *Remaining 1*: the precision panel counts move when a new PR's findings arrive. The panel is collapsed and fetched on request (§3.6). Accepted as minor.
  - *Remaining 2*: with only the first reviewer live, the owner knows every finding is Sonnet's. Blindness matters with GWP-204 and the GWP-203 replay.
- **The model could still name itself** despite the instruction. That is low likelihood; a server-side scrub would be a follow-up if it is ever seen.
- **Bias after reveal**: `blind_mark` is kept for GWP-203.
- **GWP-204 attribution**: everything reads `pr_review_finding_attribution`, and `reviewers` is an array. GWP-204 redefines the view.
- **Existing tests**: `apps/web/src/test/pull-requests.test.tsx` expects "by Sonnet reviewer" text. A fixture without `reviewersHidden` must still show it, so the field is optional and absent means revealed. Check `pr-review-held-back.test.tsx` still passes.

## 7. Builder checklist

1. Shared: `review/marks.ts`, the `PrReviewDto` fields, the `PrReviewFindingMarked` event in `events/project.ts`, and the index export. Test: `packages/shared/test/review-marks.test.ts`.
2. Server: migration `2940_pr_review_finding_marks.sql`, the projector in `projections/pr-review-runs.ts`, `commands/pr-review-marks.ts` (command and reads), the routes, and the `listPrReviews` gate. Test: `apps/server/test/pr-review-marks.test.ts` (testers).
3. Runner: the instruction rule in `review/instructions.ts`. Test: `apps/runner/test/pr-review-comment.test.ts`.
4. Web: `PostedFindings.tsx`, `FindingMark.tsx`, `ReviewerPrecisionPanel.tsx`, the hooks, the `Detail` gate and the help text. Tests: `pr-finding-mark.test.tsx` and `reviewer-precision.test.tsx`.
5. `docs/USER-GUIDE.md` paragraph.
6. Handoff: walk AC1–AC4 against the tests and name the server suite left for the testers.
