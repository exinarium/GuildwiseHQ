# GWP-198: Reviewer findings cap (1 per 100 changed lines, min 1, max 5); findings past the cap held back

Revision 2 (2026-11-13): checked against the landed GWP-197 code. What changed and why is in §0; the rest of the report is the design as it now stands.

## 0. Assumption review against the landed GWP-197

| # | Assumption | Holds? | What the landed code does | Effect on this design |
|---|---|---|---|---|
| 1 | Findings are posted only after a completed run, from one runner-side step that GWP-198 hooks between "completed" and "post" | **No (placement)** | The runner's `pr_review.run` never posts. It returns all findings to the server (`applyPrReviewRunResult`, `apps/server/src/commands/pr-review-runs.ts`). The server stores them (`PrReviewRunCompleted`) and then sends `pr_review.post` with the findings to post, built by `buildReviewPost`, which calls `selectFindingsToPost` ("GWP-198 replaces this: which of the run's findings are posted. Today: all of them"). The runner posts exactly what the server sends, as one review. | The cap moves from the runner to the **server**, in `selectFindingsToPost` / `buildReviewPost`. The token still stays on the workstation; the server only decides which findings are in the post command. The runner's only new job is to count changed lines and send them with the completed result. Posting is already all at once, so nothing moves into an output collector. |
| 2 | Structured findings (title, body, optional path/line); prompt/parser can take a severity | **Partly** | Structured JSON block already exists (`ReviewerFindingSchema`: `path` required, `line` nullable, `severity` `high`/`medium`/`low`, `title`, `body`; at most 50). The prompt already asks for a severity and "most important first". The parser (`parseReviewerOutput`) is strict: one unknown or missing severity makes the whole answer `bad_output`, and so does a 51st finding. The instructions also say "Fewer, sharper findings are better than many". | Use the **existing three levels** (`high > medium > low`); no `critical` (adding it would make an older server reject a newer runner's result). The runner normalises severity before validation (unknown or missing → `low`, `critical`/`blocker` → `high`) instead of failing the run. The prompt changes from "fewer findings" to "report every real defect, at most 50; the number posted is limited afterwards". |
| 3 | Completed run reported to the server (message → event → projection), findings stored, PR review view in apps/web | **Partly** | Message → event → projection exists and stores every finding in `pr_review_findings` (with `severity`, `idx`, and a `posted` flag set from `PrReviewPosted`). apps/web has a **Pull requests** tab (`components/pull-requests/PullRequestsPage.tsx`) with one row per pull request showing state, run time, comment count and a GitHub link. There is **no** view that shows finding text. | The "PR's review view" for AC2 is the pull request's row on the Pull requests tab. GWP-198 adds a "Posted X of Y findings" line and the "Show N held-back findings" disclosure to that row (a new component), plus the counts in `PrReviewDto.lastRun`. About +30 % web scope, not 2x: table, event and projection exist. |
| 4 | Base/head SHAs in a local read-only checkout; `git diff --numstat` works there | Yes | `runPrReview` resolves `headSha`/`baseSha` and already runs `git diff refs/review/base...HEAD` in the read-only checkout (`gitDiff`). | Count with `git diff --numstat refs/review/base...HEAD` in the same checkout (same range as the diff the reviewer reads). |
| 5 | Each run gets its own cap; a timed-out run stores no findings; with a second reviewer the cap applies after the merge | Yes | Timeout and failure emit one event and store no findings. Each run is its own `pr_review_runs` row; findings carry `run_id`. The Pull requests tab shows the latest run (latest `started_at`). | Held-back query is scoped to the same latest run the tab shows, so the counts and the list always match. GWP-204 still caps after the merge. |

## 1. Question

PRD "Review Gates & Reviewer Workflow" v22 (doc 61871304), F2 additions:

- **F2a**: the reviewer posts at most 1 finding per 100 changed lines, rounded up, with a minimum of 1 and a maximum of 5, most important first.
- **F2b**: findings past the cap are held back and can be viewed on request. They are not discarded.

This report answers where the cap is applied, how "changed lines" is defined, how importance is expressed, how held-back findings are stored and shown, and how this fits GWP-197 (landed) and the later cards GWP-199, GWP-201, GWP-203 and GWP-204. Base branch: **main**.

## 2. Findings

- **GWP-197's flow** (landed): server dispatches `pr_review.run` → runner builds the read-only checkout, writes the diff, runs the model, parses the JSON block, computes `anchored` per finding, returns `completed` with all findings → server `applyPrReviewRunResult` emits `PrReviewRunCompleted` (projection inserts `pr_review_findings`) and enqueues `pr_review.post` built by `buildReviewPost(selectFindingsToPost(...))` → runner posts one review with the comment-only token → server `PrReviewPosted` marks `posted=true` for the sent finding ids and the pull request `reviewed`.
- **The server already chooses what is posted** and has a stub for exactly this card (`selectFindingsToPost`). The token never leaves the workstation either way.
- **"Changed lines" already has a meaning**: `apps/runner/src/git/diffstat.ts` `computeDiffStats` sums `git diff --numstat` added + removed, binary (`-`) = 0; `riskTier()` uses it (USER-GUIDE §4.12). The PRD gives no other definition, so the card's definition (added + removed) stands.
- **Severity exists with three levels** and is shown in the posted title (`[high] ...`).
- **No finding text is shown in the web app today**; only `postedCount`.
- **The server cannot count lines itself**: it holds no checkout and no diff (migration 2920: "Never holds a token, a diff or file contents"). The runner must send the count.

## 3. Options compared

### 3.1 Where the cap is applied

| Option | Pros | Cons |
|---|---|---|
| **A. Server, in `buildReviewPost` (replacing `selectFindingsToPost`); runner sends `changedLines`; the pure cap function lives in `packages/shared`** (recommended) | Uses GWP-197's existing decision point; the server already stores all findings before posting, so held-back findings are stored by construction. No extra round trip (the post command is already built there). | Needs `changedLines` from the runner; an older runner does not send it (fallback below). |
| B. Runner caps and returns only `posted`/`held_back` labels | Runner knows the line count. | The runner does not post at that point; the server would just copy labels. Splits one policy over two places and breaks GWP-197's "server decides the post" rule. |
| C. Prompt asks the model for at most N | Simplest. | Not deterministic; over-cap findings never exist, so F2b is impossible. |

### 3.2 How importance is expressed

| Option | Pros | Cons |
|---|---|---|
| **A. Existing severity (`high > medium > low`), tie-broken by the reviewer's own order** (recommended) | Already in the output contract and the posted title; deterministic and testable; no wire change. | Three levels only; ties are common, so the reviewer's order decides within a level. |
| B. Add `critical` | Finer top level. | Wire enum change: an older server rejects a newer runner's whole result. Not worth it. |
| C. Reviewer order only / numeric score | Trivial / fine-grained. | Not checkable; scores not comparable across Sonnet and Opus (GWP-204). |

### 3.3 What "on request" means

| Option | Pros | Cons |
|---|---|---|
| **A. Stored with the run (already the case); the pull request row shows "Show N held-back findings", collapsed, which loads them through a separate request** (recommended) | Meets AC2; works when the workstation is offline; the default list carries counts only. | Finding text on the server: already true for every finding today. |
| B. Posted to the PR collapsed | Visible on the host. | Breaks F2b ("not posted to the PR"). |

## 4. Design

### 4.1 Definitions

- **Changed lines** of a run = added + removed lines of `git diff --numstat refs/review/base...HEAD` in the run's read-only checkout (base and head are the SHAs the run reviewed; the same three-dot range as the diff the reviewer reads and as the host's "Files changed"). Binary files count 0; renames count only edited lines. Per pull request; summing linked PRs is GWP-209's size check.
- **Cap** = `min(5, max(1, ceil(changedLines / 100)))`. 0 lines → 1. **Unknown** line count (a runner older than this change, or the numstat call failed) → cap **5** (`FINDINGS_CAP_MAX`), `changedLines` stored as null, and the server logs it.
- **Importance**: order by severity `high` (2) > `medium` (1) > `low` (0); within a severity keep the reviewer's output order (stable). `rank` = 1-based position after ordering.
- **Posted** = `rank <= cap`; **held back** = `rank > cap`. Fewer findings than the cap → all posted; zero findings → the existing "No findings." review, nothing held back.
- **Unit of capping** = one posting round on one PR = one run today. GWP-204 caps the merged, de-duplicated list (never per reviewer), so a PR never gets more than 5 comments per round. Each finding keeps its reviewer for GWP-199/203.

### 4.2 packages/shared

New `packages/shared/src/review/findings.ts`, exported from the package index next to `pr-review.ts`:

```ts
import { z } from 'zod';

export const FINDINGS_LINES_PER_FINDING = 100;
export const FINDINGS_CAP_MIN = 1;
export const FINDINGS_CAP_MAX = 5;

/** F2a. `null`/undefined (line count unknown) gives the maximum. */
export function findingsCap(changedLines: number | null | undefined): number {
  if (changedLines == null || !Number.isFinite(changedLines)) return FINDINGS_CAP_MAX;
  const n = Math.ceil(Math.max(0, Math.floor(changedLines)) / FINDINGS_LINES_PER_FINDING);
  return Math.min(FINDINGS_CAP_MAX, Math.max(FINDINGS_CAP_MIN, n));
}

export const FindingDispositionSchema = z.enum(['posted', 'held_back']);
export type FindingDisposition = z.infer<typeof FindingDispositionSchema>;

const WEIGHT = { high: 2, medium: 1, low: 0 } as const;

/** Most important first (severity, then the reviewer's order), rank 1..n, split at the cap. Pure. */
export function applyFindingsCap<T extends { severity: 'high' | 'medium' | 'low' }>(
  findings: readonly T[],
  changedLines: number | null | undefined,
): { cap: number; heldBackCount: number; ordered: Array<T & { rank: number; disposition: FindingDisposition }> } {
  const cap = findingsCap(changedLines);
  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (WEIGHT[b.f.severity] ?? 0) - (WEIGHT[a.f.severity] ?? 0) || a.i - b.i)
    .map(({ f }, k) => ({ ...f, rank: k + 1, disposition: (k < cap ? 'posted' : 'held_back') as FindingDisposition }));
  return { cap, heldBackCount: Math.max(0, ordered.length - cap), ordered };
}

/** Added + removed lines of `git diff --numstat` output; binary entries ("-\t-\t") count 0. */
export function changedLinesFromNumstat(numstat: string): number { /* same loop as computeDiffStats */ }

/** Model output: unknown/missing severity -> 'low', 'critical'/'blocker' -> 'high'. Never drops a finding. */
export function normaliseSeverity(v: unknown): 'high' | 'medium' | 'low' { /* ... */ }
```

Wire and event changes in `packages/shared/src/review/pr-review.ts` and `events/project.ts` (all **optional**, so an older runner and older stored events stay valid):

- `PrReviewRunResultSchema` `completed`: `changedLines: z.number().int().nonnegative().optional()`.
- `PrReviewRunCompleted` event payload: `changedLines: z.number().int().nonnegative().nullable().optional()`, `findingsCap: z.number().int().min(1).max(5).optional()`, and per finding `rank: z.number().int().positive().optional()`, `disposition: FindingDispositionSchema.optional()`.
- `PrReviewDto.lastRun`: `findingsCount`, `heldBackCount`, `findingsCap` (`z.number().optional()`), `changedLines` (`z.number().nullable().optional()`). Optional so the existing web test fixtures stay valid.
- New `HeldBackFindingDtoSchema` = `{ id, rank, severity, path, line, title, body }` (no reviewer, no anchored).

Optionally switch `computeDiffStats`'s loop to `changedLinesFromNumstat`; if so `apps/runner/test/worktrees.test.ts` must pass unchanged and must not be edited. If unsure, leave it.

### 4.3 apps/runner (count lines, accept every finding)

`apps/runner/src/review/run.ts`:
1. After the diff is written (step 3), run `git diff --numstat refs/review/base...HEAD` in `run.checkout` through a new injectable dep `numstat?: (run) => Promise<string>` (production uses `git`, like `gitDiff`), then `changedLinesFromNumstat`. On error, log and leave `changedLines` out (the server then uses cap 5); do not fail the run.
2. Return `changedLines` in the `completed` result. Timeout and failure are unchanged (nothing stored, nothing posted).
3. `parseReviewerOutput`: before `ReviewerOutputSchema.safeParse`, normalise each raw finding's `severity` with `normaliseSeverity`; if the model returned more than 50 findings keep the first 50 and log the number cut (better than losing the whole review as `bad_output`). Log the count of coerced severities.

`apps/runner/src/review/instructions.ts`:
- Replace "Fewer, sharper findings are better than many." with: "Report every real defect you find, up to 50; do not hold any back to keep the list short. How many are posted is decided afterwards." Keep "Do not guess".
- Keep "`severity` is `high`, `medium` or `low`. Order the findings with the most important first."
- Add: "The `summary` describes the change as a whole in one or two sentences; do not list or repeat the findings in it." (The summary is posted as the review body; a summary that lists every finding would leak held-back text to the PR.)

The runner does not apply the cap and does not change `postPrReview`: it posts what the server sends.

### 4.4 apps/server (cap, storage, held-back query)

`apps/server/src/commands/pr-review-runs.ts`, `applyPrReviewRunResult`, `completed` branch:

```ts
const { cap, heldBackCount, ordered } = applyFindingsCap(r.findings, r.changedLines);
if (r.changedLines === undefined) ctx.log.info({ runId: p.runId }, 'no changed-line count from the runner; findings cap 5');
const findings: StoredFinding[] = ordered.map((f) => ({ ...f, findingId: randomUUID() }));
await emit('PrReviewRunCompleted', { ...base, ..., changedLines: r.changedLines ?? null, findingsCap: cap, findings });
const post = buildReviewPost(run, spec, findings); // posts disposition !== 'held_back', in rank order
```

- Replace `selectFindingsToPost` with `findings.filter((f) => f.disposition !== 'held_back')` (keep the export name so callers and tests compile; findings without a disposition count as posted, so the existing `buildReviewPost` tests stay valid). Findings are already in rank order. `heldBackCount` is derived in the projection from the findings, not sent separately.
- Held-back findings must never be in a `pr_review.post` payload, so `PrReviewPosted.postedFindingIds` only ever holds posted ones.

**Migration** `apps/server/migrations/2930_pr_review_findings_cap.sql` (next free number after `2920_pr_review_runs.sql`; recheck at build time):

```sql
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS rank integer;
ALTER TABLE pr_review_findings ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'posted'
  CHECK (disposition IN ('posted','held_back'));
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS changed_lines integer;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS findings_cap integer;
ALTER TABLE pr_review_runs ADD COLUMN IF NOT EXISTS held_back_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS pr_review_findings_disposition ON pr_review_findings (run_id, disposition, rank);
```

`disposition` (decided at completion) is separate from the existing `posted` flag (set when the host accepted the review): a `posted`-disposition finding of a failed post has `posted=false` but is not held back.

**Projection** `apps/server/src/projections/pr-review-runs.ts`, `PrReviewRunCompleted`: insert `rank` and `disposition` (`f.disposition ?? 'posted'`, `f.rank ?? null`), and set `changed_lines`, `findings_cap`, `held_back_count` (count of held_back findings) on the run. Old events replay as all posted, rank null.

**List** `listPrReviews`: add `findings_count` (all findings of the run), `held_back_count`, `findings_cap`, `changed_lines` to the select and to `lastRun`. `postedCount` stays as it is (findings the host accepted).

**Held-back query and route**: new `heldBackFindings(db, prReviewId)` next to `listPrReviews`. It picks the same latest run as `listPrReviews` (latest `started_at` for the pull request) and returns its `disposition='held_back'` findings ordered by `rank`, as `{ runId, findings: HeldBackFindingDto[] }`. Route in a small new file or next to the pull-requests route: `GET /api/pr-reviews/:id/held-back` (`IdParamsSchema`). Authz as the Pull requests tab: `requireUser`, look up `pr_reviews.project_id` (404 when unknown), then `loadVisibleProject(ctx.pool, userId, projectId)`. Empty list when nothing is held back. No reviewer name in the response (GWP-199 blind marking).

Out of scope: held-back findings take no useful/noise marks and do not count in precision (GWP-199 filters on `disposition='posted'`).

### 4.5 apps/web (Pull requests tab row)

- `apps/web/src/components/pull-requests/PullRequestsPage.tsx`, `Detail` for a reviewed pull request: when `lastRun.heldBackCount > 0`, show "Posted X of Y findings: 250 changed lines allow 3 (1 per 100 lines, at most 5)" instead of "N comments" (X = posted count, Y = `findingsCount`; when `changedLines` is null, "the limit is 5"). Otherwise keep the current "N comments" text (the existing test asserts it).
- New `apps/web/src/components/pull-requests/HeldBackFindings.tsx`, rendered under `Detail` when `heldBackCount > 0`:
  - a real `<button type="button" aria-expanded aria-controls>` "Show 4 held-back findings" / "Hide held-back findings", `min-h-11` (44 px) touch target, works by tap, keyboard and screen reader; nothing hover-only.
  - first open fetches through a new hook `useHeldBackFindings(prReviewId, enabled)` in `apps/web/src/api/queries/pr-reviews.ts` (`enabled` only after the first open; cached afterwards). Inline loading and error (with retry) states.
  - each row: "Held back: not posted to the PR" label, rank, severity as text (badge plus word, never colour alone), `path` and `:line` when present, title, body as Markdown with the existing `help/Markdown.tsx`. No reviewer name, no useful/noise controls.
- `apps/web/src/help/page-help-content.ts`, entry `/p/:projectKey/pull-requests`: one sentence on the cap and held-back findings.

### 4.6 docs

- `docs/USER-GUIDE.md`, "PR-only reviews" (§4.3c, after the **Reviewed** bullet):
  > - **How many findings are posted:** at most one finding per 100 changed lines (added plus removed), rounded up: at least 1, at most 5. Findings are ordered by severity (high, medium, low), then by the reviewer's own order. Findings past the limit are not posted to the pull request and are not thrown away: on the **Pull requests** tab the pull request shows **Posted X of Y findings** and **Show N held-back findings** opens them.
- `docs/SPEC.md` and `docs/ARCHITECTURE.md`: one line each next to the PR-only review text: cap formula; "decided on the server when the run completes, from the runner's changed-line count; held-back findings stored with the run and never sent to the poster".

## 5. Acceptance criteria → design → tests (new files)

| AC | Design | Tests |
|---|---|---|
| **AC1 (F2a)**: 250 lines, 7 findings → exactly 3 posted, the 3 most important; 30 → 1; 900 → 5 | `findingsCap`, `applyFindingsCap` (§4.2); server posts only `posted` (§4.4); runner counts lines (§4.3) | `packages/shared/test/review-findings-cap.test.ts`: `findingsCap` at 0, 1, 30, 100, 101, 250, 500, 501, 900 → 1, 1, 1, 1, 2, 3, 5, 5, 5; null → 5. `applyFindingsCap` with 7 mixed findings at 250 → ranks 1-3 posted are the highest severities, ties keep reviewer order; fewer than cap → all posted; 0 → empty; input not mutated. `changedLinesFromNumstat` with text and binary lines. `normaliseSeverity`. `apps/server/test/pr-review-findings-cap.test.ts` (pure part, no DB): `buildReviewPost` with 7 capped findings at 250/30/900 → 3/1/5 post findings in rank order, no held-back id in the payload. `apps/runner/test/pr-review-changed-lines.test.ts`: `runPrReview` with fake deps returns `changedLines` from the numstat dep; numstat failure → no `changedLines`, run still completes; `parseReviewerOutput` keeps a finding with unknown severity as `low`. |
| **AC2 (F2b)**: over-cap findings not posted; owner opens them on request from the PR's review view | Server stores all with `disposition`, serves `GET /api/pr-reviews/:id/held-back` (§4.4); row disclosure (§4.5) | `apps/server/test/pr-review-held-back.test.ts` (**integration, needs Postgres**: leave to testers/DevOps): apply a completed result with 7 findings at 250 lines → `pr_review.post` command has 3 findings; `listPrReviews` shows `heldBackCount: 4`, `findingsCount: 7`, no finding text; the route returns 4 in rank order with no reviewer; 404 for unknown id; other project's member refused; result without `changedLines` → cap 5; old event without new fields replays as all posted. `apps/web/src/test/pr-review-held-back.test.tsx`: no button when `heldBackCount` is 0; "Posted 3 of 7" text; click fetches once and shows 4 rows labelled "not posted", `aria-expanded` toggles; error state. |

Run the shared, runner and web unit suites and the pure server test. The DB-backed server test goes to the testers or DevOps (standing order GWP-99); name it in the handoff. Existing `pull-requests.test.tsx`, `pr-review-runs.test.ts` and `pr-review-run.test.ts` must pass unchanged.

## 6. Risks

- **Summary leak**: the review body is the model's summary; if it lists all findings, held-back text reaches the PR. Mitigation: the prompt line in §4.3. Not enforceable in code; the 20-PR replay (GWP-203) should check it.
- **Model under-reports or over-reports**: unknown severity → `low`, more than 50 → first 50 kept and logged; the prompt no longer asks for fewer findings.
- **Version skew**: all new fields optional; old runner → cap 5 (the most the PRD allows), never "post all".
- **GWP-204**: must cap the merged list, not per reviewer.
- **Data stored**: unchanged in kind; finding text was already stored for every finding. No credentials or tokens.

## 7. Builder checklist

1. `packages/shared/src/review/findings.ts` + export; optional wire/event/DTO fields; held-back DTO; tests.
2. Runner: numstat dep and `changedLines`; severity normalisation and 50-cut in `parseReviewerOutput`; prompt wording; test.
3. Server: cap in `applyPrReviewRunResult`/`buildReviewPost`; migration 2930; projection; list fields; held-back query and route; pure test + DB test (for testers).
4. Web: Detail text, `HeldBackFindings` component, query hook, page help; test.
5. Docs: USER-GUIDE bullet, SPEC and ARCHITECTURE lines.
6. Handoff: walk AC1 and AC2 against the tests; name the DB-backed server test left for testers.
