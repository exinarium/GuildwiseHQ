# GWP-226: public form complete can answer "received" after the submission expired

## 1. Question

`POST /api/public/forms/:publicId/submissions/:sid/complete` claims the row (`status='storing'`), writes the answers
documents through the write relay, and then runs `UPDATE … SET status='complete' … WHERE status='storing'`. The
scheduled sweep `pruneFormSubmissions` expires `storing` rows as soon as `expires_at` has passed. When the sweep runs
while the documents are being written, the final UPDATE changes 0 rows, `if (!n.rowCount) return;` leaves the
transaction quietly and the handler still answers `done()`. The respondent sees "received", no `FormSubmitted` is
appended and the desk shows "Timed out".

How do we (1) stop the sweep from expiring a row that is still being written, (2) never answer success unless the row is
`complete`, (3) clean up the answers documents of a complete that ended expired, and (4) show the respondent the right
message?

## 2. Findings (code as of `61a8843a`)

| Area | Where | What it does today |
| --- | --- | --- |
| Claim | `apps/server/src/public-forms/routes.ts:1372-1381` | `UPDATE … SET status='storing', updated_at=now WHERE status IN ('receiving','failed') RETURNING *`. On no row: re-read; `complete` → `done()`, anything else → `409 submission_busy` (also when the row is `expired`). |
| `failWith` | `routes.ts:1384-1389` | `UPDATE … SET status='failed', error_code, updated_at WHERE id=$1`, **no status guard**: if the sweep expired the row meanwhile, a write failure revives it to `failed`. |
| Document writes | `routes.ts:1439-1480` | html (with `derive.pdf`), then json. Each `ctx.services.storage.write` ends by the relay deadline `start + storage.writeTimeoutMs` (`storage-relay/hub.ts:181`). After each write `UPDATE … SET answers_refs, updated_at WHERE id=$1` (no status guard, does not touch status). So `updated_at` is refreshed after every document: the longest gap between two `updated_at` stamps while a complete is alive is one write (≤ `writeTimeoutMs`) plus a few queries. |
| Final update | `routes.ts:1485-1561` | Inside `withAppendTx` (returns the callback's value, `db/tx.ts:49`). `if (!n.rowCount) return;` then the handler falls through to `return done()` at `:1572`. |
| Catch | `routes.ts:1562-1571` | Sets `failed` only `WHERE status='storing'`, then rethrows. A `PfError` thrown inside the try passes through it harmlessly when the row is no longer `storing`. |
| Sweep | `apps/server/src/commands/public-forms.ts:467-481` | `UPDATE … SET status='expired', updated_at=now WHERE expires_at < now AND status IN ('receiving','failed','storing')`, then `queueFormUploadCleanup`, then the 30-day delete. Called from `Scheduler.triggers`. |
| Cleanup queue | `apps/server/src/public-forms/cleanup.ts:28-70` | Queues the **part files** of rows that are `expired`, `completed_at IS NULL`, **`answers_refs = '{}'`** (rule R6 of GWP-143: never touch a submission that has an answers file) and `expires_at < now - cleanupGraceMs`. `cleanupGraceMs = 2 × writeTimeoutMs + 60 s`. The sweep re-checks R6 before each delete (`cleanup.ts:95`). Answers documents are never queued. |
| Desk list | `commands/public-forms.ts:395-460` | Lists `answers_refs` as "Answers (JSON)", "Answers (readable)", "Answers (PDF)" and the parts by field id; the cleanup state of each is matched by `label + path`. `errorCode` is in the DTO but not shown by `SubmissionsList`. |
| Config | `apps/server/src/config.ts:223,533` | `AOM_STORAGE_WRITE_TIMEOUT_MS`, 5 000–300 000, default 60 000 → `ctx.config.storage.writeTimeoutMs`. |
| Shared code | `packages/shared/src/forms/public.ts:38` | `submission_expired` already exists in `PublicFormErrorCode`. No new code. |
| Web | `apps/web/src/public-form/PublicFormPage.tsx:409-467`, `messages.ts` | `submit()` treats `submission_expired` (from any step) as "start again": up to 3 tries it drops the submission, loads a fresh session and re-sends answers and files. `describePublicError` has **no** `submission_expired` case: an exhausted retry shows the generic "Something went wrong". |
| Schema | `migrations/2830_public_forms.sql`, `2870_form_submission_cleanup.sql` | `updated_at` is maintained by the claim and by every write, so the grace rule needs no migration. `error_code text` is free text. `form_submission_cleanup.seq smallint`, key `(submission_id, seq)`. |
| Overlap with GWP-143 | `cleanup.ts`, migration 2870 | GWP-143 is already on main. This change edits its queue/sweep SQL (one condition each) and the complete handler; no parallel change is open on these files. |

Why the race exists: the sweep's rule is "expired by the clock", but a complete that started before `expires_at` may
legitimately still be writing up to two write timeouts later (GWP-143 already reasoned this way for the cleanup grace,
see its design §4.6). The expire UPDATE did not apply that reasoning to `storing` rows.

## 3. Options

### 3.1 Prevent the race (sweep)

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Keep `storing` rows out of expiry until `updated_at < now − 2 × writeTimeoutMs`** | One SQL condition. `updated_at` is already a heartbeat (claim + each document). A crashed write is still expired after the grace. Grace comes from the same setting the relay uses. | Expiry of an abandoned `storing` row comes up to 2 min (default) later. |
| B. Base the grace on `expires_at` (`expires_at < now − grace` for storing) | No dependency on `updated_at`. | A complete that starts just before `expires_at` and is slow is still cut off; the ticket asks for `updated_at`. |
| C. Row lock (`SELECT … FOR UPDATE` for the whole write) | Exact. | Holds a transaction open across remote writes of up to minutes; blocks the sweep. Rejected. |

**Choose A.**

### 3.2 Never answer a false success (handler)

The final UPDATE stays conditional (`WHERE status='storing'`). On 0 rows, read the status in the same transaction and
return it out of `withAppendTx`; the handler decides after the transaction: `complete` → `done()` (no events, none were
appended), anything else → `410 submission_expired`. Same treatment when `failWith` (now guarded) hits 0 rows, and in the
claim-failure branch when the re-read row is `expired` (today that answers `409 submission_busy`, which the page shows as
a generic error).

### 3.3 Answers documents of a complete that ended expired

| Option | Pros | Cons |
| --- | --- | --- |
| D1. Handler deletes them itself (`ctx.services.storage.delete`) before answering | Immediate. | No retry: runner offline or a transient error leaves them orphaned; the desk shows nothing; doubles the cleanup logic. |
| D2. Clear `answers_refs` on the row and insert cleanup rows from the handler | Fits R6 as written. | The desk no longer lists the documents, so their cleanup state is invisible; the handler grows queue code. |
| **D3. Mark the row and let the existing queue/sweep take the documents too** | Uses the queue's retry, backoff, 30-day bound, desk display and the 30-day row delete as they are. The handler only sets a marker. R6 still protects every submission the respondent may have been told was received. | R6 gets one exception (`OR error_code='expired_during_complete'`) in two SQL statements; the queue must insert rows for the answers references. |

**Choose D3.** The marker is set only in the branch that answers the respondent `submission_expired`, only on a row that
is `expired` and has `completed_at IS NULL`, in the same statement. No migration: `error_code` is free text and not shown
on the desk.

### 3.4 Respondent's page

Decision (product owner, 2026-11-14): when **complete** answers `submission_expired`, the page does **not** restart on its
own any more. It shows a clear expired message with "Try again"; answers and files stay in the page, so pressing it starts
a new submission. The restart on other steps (the status check before uploading, `submission_not_found`,
`session_used`, `session_invalid`, `form_changed`) is unchanged.

## 4. Design

### 4.1 `apps/server/src/public-forms/cleanup.ts`

```ts
/** A complete keeps `updated_at` fresh after each document; a storing row older than this has no write running. */
export function storingGraceMs(ctx: Ctx): number {
  return 2 * ctx.config.storage.writeTimeoutMs;
}
/** A write that started before `expires_at` can still end up to two write timeouts later: wait for it. */
export function cleanupGraceMs(ctx: Ctx): number {
  return storingGraceMs(ctx) + 60_000;
}
/** error_code of a row the sweep expired while its complete was writing; the respondent was told to send again. */
export const EXPIRED_DURING_COMPLETE = 'expired_during_complete';
```

Queue (`queueFormUploadCleanup`): relax R6 for marked rows and also queue their answers documents.

```sql
SELECT id, org_id, parts, answers_refs FROM form_submissions
 WHERE status='expired' AND cleanup_queued_at IS NULL AND completed_at IS NULL
   AND (answers_refs = '{}'::jsonb OR error_code = $2)          -- R6, or told "expired, send again"
   AND expires_at < $1
 ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED
```

For each row: the part rows as today (`seq` = part index, label = field id); then for each of `json`, `html`, `pdf`
present in `answers_refs`, one row with a fixed negative `seq` (−1 json, −2 html, −3 pdf, so it can never meet a part
index) and the **same label the desk list uses** ("Answers (JSON)", "Answers (readable)", "Answers (PDF)").
Move those three labels to one exported constant (for example `ANSWERS_LABELS` in `cleanup.ts`) and use it in
`listSubmissions` too, so the desk shows each document's cleanup state and the two cannot drift. `ON CONFLICT DO
NOTHING` as today.

Sweep (`sweepFormUploadCleanup`): same exception in the R6 re-check:
`AND s.completed_at IS NULL AND (s.answers_refs = '{}'::jsonb OR s.error_code = $3)`.

`settleOne` needs no change: an answers document is a normal file reference (`connectionId`, `path`, `providerId`).

### 4.2 `apps/server/src/commands/public-forms.ts` — `pruneFormSubmissions`

```ts
const now = ctx.clock.now();
await ctx.pool.query(
  `UPDATE form_submissions SET status='expired', updated_at=$1
    WHERE expires_at < $1
      AND (status IN ('receiving','failed') OR (status='storing' AND updated_at < $2))`,
  [now, new Date(now.getTime() - storingGraceMs(ctx))],
);
```

Everything after it (queue, 30-day delete) is unchanged. Update the doc comment: "a `storing` row is expired only when
no write has touched it for 2 × the write timeout".

Value: with the default `AOM_STORAGE_WRITE_TIMEOUT_MS=60000`, the storing grace is **120 s** (cleanup grace stays 180 s).
State this in the PR.

Why 2 × is enough: the longest gap between two `updated_at` stamps of a live complete is one relay write (bounded by
`writeTimeoutMs` in `hub.ts`) plus a few local queries. **The per-document `answers_refs` UPDATE (`routes.ts:1476`) is
now load-bearing as the heartbeat: keep it, and keep it setting `updated_at`.** Add a one-line comment there.

### 4.3 `apps/server/src/public-forms/routes.ts` — complete handler

1. Move `type AnswersRefs` above the `try` (it is needed by the helper below).
2. Add, before the `try`, one helper used by every "the row is no longer `storing`" branch:

```ts
/** The row left 'storing' under us (the sweep expired it, or another request finished it). Never a false success. */
const notStoring = async (found: string | null, refs: AnswersRefs): Promise<SubmissionCompleteDto> => {
  // ids and status only: no answers, file names or paths
  ctx.log.warn(
    { publicForm: { op: 'complete', submissionId: sid, orgId: pub.orgId, found: found ?? 'missing' } },
    'public form complete: the submission is no longer being stored',
  );
  if (found === 'complete') return done();
  if (found === 'expired')
    // the respondent is told to send again: let the expiry cleanup take the answers documents too
    await ctx.pool.query(
      `UPDATE form_submissions SET error_code=$2, answers_refs=$3::jsonb
        WHERE id=$1 AND status='expired' AND completed_at IS NULL`,
      [sid, EXPIRED_DURING_COMPLETE, JSON.stringify(refs)],
    );
  throw new PfError(410, 'submission_expired', 'This submission timed out. Please send the form again.');
};
```

   Do not touch `updated_at` in the marker UPDATE (it dates the expiry for the 30-day delete). `refs` is a superset of
   the row's `answers_refs` (it starts from `claimed.answers_refs`), so writing it back loses nothing.

3. Final update: return an outcome from the transaction instead of a bare `return`.

```ts
const outcome = await withAppendTx(ctx.pool, async (tx) => {
  const n = await tx.query(`UPDATE … SET status='complete' … WHERE id=$1 AND status='storing'`, [...]);
  if (!n.rowCount) {
    const r = await tx.query<{ status: string }>('SELECT status FROM form_submissions WHERE id=$1', [sid]);
    return { ok: false as const, found: r.rows[0]?.status ?? null };
  }
  // … events exactly as today (FormClientLinkUsed, FormSubmitted, the PDF-missing desk item) …
  return { ok: true as const };
});
if (!outcome.ok) return await notStoring(outcome.found, refs);
```

   `FormSubmitted` (and the link-used event and the desk notice) stay inside the `rowCount` branch, so they are appended
   at most once and only for the row this request turned `complete`.

4. `failWith`: add `AND status='storing'` and return whether it changed a row. At its two call sites, when it changed
   nothing, re-read the status (`SELECT status …`) and `return await notStoring(found, refs)` instead of the offline
   answer or the storage error. (In the `destination_missing` branch `refs` is `have`.) This closes the "write failure
   revives an expired row" hole and keeps the constraint that nothing revives an expired row.

5. Claim failure (`:1377-1380`): when the re-read row is `expired`, throw the same `410 submission_expired` (no marker:
   this request wrote nothing). `complete` → `done()` and others → `409 submission_busy` as today.

6. The catch block stays as it is (its UPDATE is already guarded; it rethrows the 410).

Response shape: success is still `done()` (`SubmissionCompleteDto`), the error is the existing
`{ error: { code: 'submission_expired', message } }` body with status 410. No shared type changes.

### 4.4 Web: `apps/web/src/public-form/PublicFormPage.tsx`, `messages.ts`

- `messages.ts`: add
  `case 'submission_expired': return msg('This submission timed out before it was saved. Please send the form again. Your answers and files are still here.', true);`
  (not `closed`; `retry` shows the existing "Try again" button, which calls `submit()`).
- `PublicFormPage.tsx` `finish()`: wrap only the `publicApi.complete(...)` call. When it throws a `PublicApiError` with
  code `submission_expired`, rethrow it marked as coming from complete (a small `class CompleteExpired { constructor(readonly err: PublicApiError) {} }`,
  like the existing `LinkLater`). The `submission_expired` thrown by the status check at `:249` is not wrapped and keeps
  restarting.
- `submit()` inner catch: `if (e instanceof CompleteExpired) { sub.current = null; throw e.err; }` before the restart
  logic. `sub.current = null` makes the next Send start a new submission; `files.current` and the answers (state and
  sessionStorage) are kept. The outer catch then shows the message through `describePublicError` → `setNotice`, and
  `setDone` is never called, so the "received" screen does not show.

Touch: the notice is a `role="alert"` block with a 44 px "Try again" button, already usable on phones; no new input.

### 4.5 Docs (builder)

- `docs/USER-GUIDE.md` §public forms (around line 1525): one sentence: if a submission times out while it is being
  saved, the client is asked to send the form again and the desk shows it as **Timed out**; its answers copies and files
  are removed like any timed-out submission.
- `docs/ARCHITECTURE.md` §43 "Kept" bullet: a `storing` row is expired only after 2 × the write timeout without an update;
  a complete that finds its row expired answers `410 submission_expired` and marks it `expired_during_complete` so the
  cleanup removes its answers documents too.
- `docs/security/public-forms.md` "Residual risks": the uploads bullet is out of date since GWP-143; reword to say that
  answers documents of a submission that timed out during complete are now removed too.

## 5. Risks

- **Deleting answers a respondent was told were received.** The marker is only set by the branch that answers 410, on a
  row that is `expired` with `completed_at IS NULL`, and both queue and sweep still require `completed_at IS NULL`. A
  completed row clears `error_code` (`routes.ts:1487`), so a stale marker can never sit on a completed row.
- **Expiry delayed for abandoned `storing` rows** by up to 2 × the write timeout (2 min default, 10 min at the maximum
  setting). Acceptable; they are still expired and cleaned.
- **Heartbeat dependency.** If a later change removes the per-document `answers_refs` UPDATE, a complete with two slow
  writes could exceed the grace. The comment from §4.2 and the prune tests guard this.
- **Behaviour change on the page** (owner decision): no automatic restart when complete says expired; the respondent
  presses "Try again". Mention in the PR.
- **A row found `failed`/`receiving` on the re-read** (only reachable through a bug) answers 410 without a marker; its
  documents stay referenced by the row (listed on the desk), not orphaned.

## 6. Tests (unit suite, `apps/server/test` with the test database, and `apps/web/src/test`)

Server, in `apps/server/test/public-forms-cleanup.test.ts` (prune) and `public-forms-submit.test.ts` or a new
`public-forms-complete-race.test.ts` (handler). Seed with the existing `stalled()` / `pf.submit` helpers and `q(...)`;
move time with `ctx().clock`.

1. Prune (a): `storing`, `expires_at` past, `updated_at = now − (storingGrace − 1 s)` → stays `storing`, no cleanup row.
2. Prune (b): `storing`, `expires_at` past the cleanup grace, `updated_at = now − (storingGrace + 1 s)` → `expired`, part
   cleanup rows queued (`cleanup_queued_at` set).
3. Prune (c): `receiving` and `failed` with `expires_at` past (and a fresh `updated_at`) → `expired` as before; `complete`
   untouched. (d): any status with `expires_at` in the future → untouched.
4. Race: `vi.spyOn(ctx().services.storage, 'write')` wrapping the real method; after the real `json` write resolves, run
   `UPDATE form_submissions SET status='expired' WHERE id=$1`. Assert: 410 `submission_expired`; no `FormSubmitted` (and
   no `FormClientLinkUsed`) event for the submission; row `expired` with `error_code='expired_during_complete'` and both
   answers refs; after advancing past the cleanup grace, `pruneFormSubmissions` queues the json/html (and pdf with
   `stub.pdf='ok'`) documents plus the parts, and `sweepFormUploadCleanup` sends deletes for all of them;
   `listSubmissions` shows them with their cleanup state.
5. Retry: same spy, set the row `complete` (with `completed_at`) before the final UPDATE → success body equals `done()`,
   zero `FormSubmitted` appended by this request (the test seeds no event, so the count stays 0; or run a real complete
   first and assert the count stays 1 after a second call that hits the 0-row path).
6. Happy path: a plain complete → `complete`, exactly one `FormSubmitted`, `done()` body, `listSubmissions` status
   `complete`.
7. Log: `vi.spyOn(ctx().log, 'warn')` in tests 4 and 5 → one call with `publicForm.submissionId`, `orgId`, `found`
   (`'expired'` / `'complete'`), and `JSON.stringify(args)` contains no answer value (for example the `full_name` typed in
   the test) and no stored path.
8. `failWith` guard: make the json write fail (`stub.failWhen` for `ext==='json'`) after the spy expired the row → 410,
   row stays `expired` (not revived to `failed`).
9. Existing tests in `public-forms-cleanup.test.ts` (AC6 "never touches … one with an answers file") must still pass
   unchanged: an unmarked row with answers refs is still never queued.

Web, `apps/web/src/test/public-form-page.test.tsx`:

10. Complete answers `err(410, 'submission_expired')` → `public-notice` shows the expired text, no `form-confirmation`,
    exactly one `POST /submissions` (no restart). Then the complete handler is let through, "Try again" (`public-retry`)
    → a second `POST /submissions` and the confirmation.
11. The existing "starts over with a fresh session when the submission ran out" test (status check says expired) still
    passes unchanged.
12. `messages` unit: `describePublicError({ code: 'submission_expired', status: 410, retryable: false })` → the
    expired text with `retry: true`, `closed: false`.

Not run here: the manual/E2E check on a deployed build from the ticket's test plan (slow upload, short expiry, scheduler
during the write) is for the testers.

## 7. Acceptance criteria → design

| AC | Where |
| --- | --- |
| Storing row within grace not expired | §4.2 SQL; test 1 |
| Storing row past grace expired, cleanup queued as today | §4.2 (queue call unchanged); test 2 |
| Other statuses unchanged | §4.2 (`receiving`,`failed` keep the clock rule); test 3, existing cleanup tests |
| Expired between claim and final UPDATE → 410, no `FormSubmitted` | §4.3 steps 2-3; test 4 |
| Page shows the expired message, not "received" | §4.4; tests 10, 12 |
| Answers documents removed or queued | §3.3 D3, §4.1, §4.3 marker; test 4 |
| Already `complete` → success, no second `FormSubmitted` | §4.3 `notStoring` (`complete` → `done()`), events only inside the rowCount branch; test 5 |
| Normal path unchanged | §4.3 (events and response untouched); test 6 |
| Log line per 0-rows outcome, no answer content | §4.3 `notStoring`; test 7 |

Constraints: success shape unchanged; the final UPDATE stays `WHERE status='storing'`; the grace comes from
`storage.writeTimeoutMs` through `storingGraceMs` (also used by `cleanupGraceMs`); abandoned rows still expire; no
migration; logs carry ids and status only.

## 8. Size

About 130 changed lines of product code across the server handler, the sweep, the cleanup queue/sweep and the web page,
plus about 250 lines of tests: a multi-module change touching the cleanup safety rule. Treat as large.
