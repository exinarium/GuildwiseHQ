# GWP-210: Size exception request (Johnny asks with a reason, the owner decides, it lapses after 2 working days)

Design report for the GuildwiseHQ repository. It was first written against `b023544d`, before GWP-202, GWP-208 and
GWP-209 had landed. **This revision checks it against the working branch at `c973566a`, where they have landed.**
Section 0 lists what changed. Sections 4, 5 and 8 are updated to match. Everything else stands as first designed.

## 0. Assumption review against the landed code (revision of 2026-11-15)

| # | Assumption | Result | Evidence in the landed code |
|---|---|---|---|
| 1 | `pr_reviews.review_state` is a text state, so `size_exception_pending` can be added | **Holds** | `migrations/2900_pr_only_review.sql:19` `review_state text NOT NULL`; `PR_REVIEW_STATES` is in `packages/shared/src/review/pr-review.ts:17` |
| 2 | GWP-209 exposes one `markPrNeedsSplitIn` that marks needs-split and notifies the author | **Revised** | There is no such command. Marking and notifying are one event, `PrReviewNeedsSplit`, appended by the **private** `sendBack(...)` in `apps/server/src/commands/pr-size-check.ts`. The projection (`projections/pr-size-check.ts`) sets `needs_split` and the `split_*` columns, and inserts a `pending` row into `pr_split_notices`. The scheduler's `deliverSplitNotices` then posts the notice on the PR. The cause is `reason: z.enum(SPLIT_REASONS)`. |
| 3 | GWP-209 stores the size result (`sizeCheckOf`) and has **one** over-budget decision point | **Revised** | There is no `sizeCheckOf`. The live verdict is `verdictOf(await loadSizeContext(db, projectId, repoId), changeId)`, and both are exported. The `split_*` columns hold the result only while the PR is `needs_split`. There are **two** decision points: `evaluateRepoSizes` (on every poll, `pr-only.ts:312`) and `onPrReviewTimedOut` (`pr-review-runs.ts:538/736`). |
| 4 | GWP-202 has `addWorkingDays(start, n, tz)` and an owner time-zone helper | **Revised (name only)** | `addWorkingDays(start, n, tz)` exists exactly as assumed (`packages/shared/src/time/working-days.ts:59`). The time-zone helper is `userTimezone(db, userId)` (`apps/server/src/commands/owner-pending.ts:34`). It takes the owner's **user** id, not an org id, so `ownerTimeZone(tx, orgId)` does not exist. |
| 5 | `ownerPendingSweep` reads only its own table and never reminds on `size_exception` | **Holds** | It reads `owner_pending_timers` only. `OWNER_PENDING_KINDS = ['second_timeout','manual_trigger','over_cap_spend']`, and `registerOwnerPending` refuses other kinds ("a size exception request, for one"). |
| 6 | Review eligibility accepts only `not_reviewed` | **Holds** | `manualReviewAction` (`apps/server/src/review/manual-action.ts:21`), `startRound` (`pr-review-rounds.ts:134`), and the auto queue (`pr-only.ts:339/367`) all require `review_state = 'not_reviewed'`. GWP-209's `lockRecordedPrs` only picks `not_reviewed` or `needs_split`, so polls leave a pending PR alone. |
| 7 | No GWP-208 code is needed | **Holds** | `commands/needs-split.ts` (`requestNeedsSplitIn` and the rest) is card-level only and never touches `pr_reviews`. |

What changes in the design (details are in 4.1, 4.3 and 5):

- **R2. The needs-split call.** Export GWP-209's `sendBack` from `pr-size-check.ts` (name it `sendPrBackToAuthorIn`;
  the internal callers keep working). Add `'size_exception_rejected'` and `'size_exception_lapsed'` to `SPLIT_REASONS`.
  The event schema picks them up through `z.enum(SPLIT_REASONS)`, and `split_reason` is a plain text column.
  "Author notified" means the `pr_split_notices` row that the projection creates, which `deliverSplitNotices` then posts.
  Optional: add one sentence for these reasons to `splitNoticeBody`: "A size exception was asked for and not
  approved."
- **R2a. Use a fresh verdict when deciding.** On reject or lapse, recompute the size with
  `loadSizeContext` + `verdictOf`.
  - The size-exception projection first sets every chain member that is still `size_exception_pending` back to
    `needs_split`.
  - If the verdict is still `over`, append `PrReviewNeedsSplit` (through `sendPrBackToAuthorIn`, one shared `checkId`)
    for each such member, with the new reason. That creates the author notice.
  - If the author has already got the PR within budget, no notice is sent. The next poll clears it through GWP-209's
    existing `PrReviewSplitCleared`.
  - Without this step, a PR that was split while the request was pending would be stuck, or would get a stale "please
    split" notice.
- **R3. Two exemption hooks, not one.** Both GWP-209 decision points must call `sizeExemptionOf(tx, pr.id, v.total)`.
  Without the `evaluateRepoSizes` hook, an approved PR (back at `not_reviewed`) is sent back on the very next poll, and
  AC2 fails.
- **R3a. Size data at request time** comes from the live verdict (`v.total`, `v.budget`, `v.unit`, `v.members`). The
  request requires `v.state === 'over'`. There is no `sizeCheckOf`.
- **R3b. Closing a PR.** `pr-only.ts:310` already reacts to `PrReviewClosed` (it calls `resolveTimedOutTwice`). Add
  `withdrawSizeExceptionOnClose(ctx, tx, prReviewId)` there, so the desk item closes at once. The sweep remains the
  backstop.
- **R4. Owner and time zone.** Look up the project owner the way `tellOwnerTimedOutTwice` does
  (`project_members role='owner' ORDER BY (status='active') DESC LIMIT 1`). Then `tz = userTimezone(tx, ownerUserId)`
  and `dueAt = addWorkingDays(now, 2, tz)`. Put the owner in the desk item's `addresseeUserId`. If the project has no
  owner, refuse with `conflict('no_owner')`.

Other notes from the check:
- `FOLLOW_UP_SKIP_SUBKINDS` is still at `agent-ux/follow-up.ts:51`.
- The scheduler runs `followUpSweep` at line 196 and `ownerPendingSweep` at line 198. The new sweep goes after them.
- `ceo/actions8.ts` is free.
- The highest migration number is 2970, and there are several of them, so use the next free number (for example 2980).

## 1. Question

How should the size exception flow be built?

1. Johnny (the CEO agent) raises a size exception request for an over-budget PR, with his reason. A request without a
   reason is refused.
2. The owner sees a desk item with the reason and the PR's size against the budget, and approves or rejects it.
   - Approved: the PR is an approved exception. It is not sent to needs-split and is exempt from the hard size check.
   - Rejected: the PR goes to needs-split and its author is notified.
3. No answer within 2 working days: the request lapses, the PR goes to needs-split and the author is notified. The
   owner gets **no** reminder.
4. Requests, reasons and outcomes are stored so the owner can review what was accepted.

On the PRD ID: v22 says "Add to the size check (F3)", but section 10 calls F3 "settings", while the size check and
needs-split are F6. **This card implements an F6 addition (the size check).** "F3" in the v22 text is a numbering slip.

### Planning question: needs-split through GWP-208 (the BA) or straight to the PR author?

**Straight to the PR author, through GWP-209's PR-level needs-split.**
- GWP-208 is the card-level route: the architect's design-time verdict sends a card back to the BA.
- GWP-209 (PRD F6.1/F1.5) routes "the PR straight back to the PR author to split, with no owner decision needed."

A size exception concerns a PR that the size check found over budget, so a rejected or lapsed request goes back into the
PR-level route. The landed code confirms this (assumption 7).

## 2. Findings

These are the original findings, now confirmed or corrected against `c973566a`.

- **PR records (GWP-195/209, landed).**
  - `pr_reviews` has `review_state text`, `closed_at`, `project_repo_id`, `change_id`, `url`, `title`, `author`, and
    GWP-209's `split_reason`, `split_at`, `split_total`, `split_budget`, `split_unit`, `split_members jsonb` and
    `attention`.
  - `pr_open_changes` holds the open list with sizes. `prChain` and `prSizeVerdict` (`packages/shared/src/review/size-check.ts`)
    compute chains and verdicts.
  - `listPrReviews` (`commands/pr-review-runs.ts:839`) builds the Pull requests DTO.
- **Desk items.** `DeskItemCreated` carries `kind`, `subkind`, `projectId`, `data`, `askedBy`, `subjectKey` and
  `addresseeUserId`. `tellOwnerTimedOutTwice` in `pr-size-check.ts` is now the closest model of a project-scoped,
  PR-related desk item addressed to the owner.
- **Who may resolve.** `canAnswerItem` (`queries/desk.ts`) lets the project owner resolve a project item that has no
  card.
- **The resolve path.** `closeItem` in `commands/desk.ts` branches on `kind`/`subkind` and calls a `resolve…In` in the
  same transaction. `resolveLargeMergeIn` is the model for approving or rejecting.
- **The CEO cannot approve.** `answer` refuses approvals, `triage` dismisses only plain alerts, and `resolve-notice`
  handles notices only.
- **CEO actions.** These involve `CEO_ACTIONS` (`ceo/ipc.ts`), `ACTION_CLASSES`/`CLASS_LABEL`/`DEFAULT_CEO_POLICY`
  (`ceo/policy.ts`), the `ActionDef`s registered in `ceo/registry.ts`, and `CEO_CLI_HELP` (`prompt/ceo.ts`).
  `aom ceo act` keeps `--reason` for its own audit, so the reason the owner reads goes in `--text`.
- **TRAP: the follow-up chase.** `followUpSweep` nudges open `approval` items after the org's window, which can be as
  short as 1 day. The subkind **must** go into `FOLLOW_UP_SKIP_SUBKINDS`.
- **Fake clock.** `ctx.clock.now()`. The test app has `clock.advance(ms)` and `clock.setOffset(ms)`.
- **Snapshots.** None found. The CEO tests use `toContain`.

## 3. Options compared

These are unchanged and still hold against the landed code.

- **3.1 PR state while the request is pending: B.** Raising a request moves the PR to `size_exception_pending`. Reject
  or lapse marks it `needs_split` again, and approval sets it to `not_reviewed`. The landed eligibility checks
  (assumption 6) and `lockRecordedPrs` exclude the new state with no change.
- **3.2 Storage: A.** A new table `pr_size_exceptions` keeps one row per request, as history.
- **3.3 Lapse timer: B.** An own sweep, `sizeExceptionSweep`, with `dueAt` from GWP-202's `addWorkingDays`. It never
  uses `owner_pending_timers` (GWP-202 refuses that kind anyway).
- **3.4 Reason:** a required `--text`, at least 20 characters after trimming. It is checked in the shared schema, in the
  server command, and by an SQL CHECK.

## 4. Design

### 4.1 Flow (revised: R2, R2a, R3, R4)

```
GWP-209 evaluateRepoSizes: PR over budget -> PrReviewNeedsSplit (needs_split + pr_split_notices row) (unchanged)
Johnny: aom ceo act size-exception --pr <pr id | url> --text "<why this size is justified>" --reason ... --confidence ...
  server requestSizeExceptionIn (one append tx):
    refuse: short/blank text (AC5); PR not found/closed; review_state <> 'needs_split';
            fresh verdict (loadSizeContext + verdictOf) not 'over'; an open request for this PR or chain;
            a rejected/lapsed request for this PR at a size >= v.total; no project owner
    owner = project owner; tz = userTimezone(tx, owner); dueAt = addWorkingDays(now, 2, tz)
    SizeExceptionRequested {id, prReviewId, chainPrReviewIds, size=v.total, budget=v.budget, unit=v.unit, members, reason, dueAt}
    DeskItemCreated {kind approval, subkind size_exception, projectId, addresseeUserId owner, data{...},
                     subjectKey size_exception:<prReviewId>}
    -> projection: pr_size_exceptions row 'pending'; review_state = 'size_exception_pending' on the PR and chain members
Owner on the Desk: POST /api/desk/:id/resolve {resolution: approved|rejected, note?}
  closeItem -> resolveSizeExceptionIn (same tx)
    approved: SizeExceptionApproved -> row 'approved'; review_state = 'not_reviewed' (the review goes ahead)
    rejected: SizeExceptionRejected -> row 'rejected'; review_state back to 'needs_split' on pending members;
              fresh verdict 'over' -> sendPrBackToAuthorIn(reason 'size_exception_rejected') per member -> notice row (AC3)
Poll (GWP-209 evaluateRepoSizes) and timeout (onPrReviewTimedOut): over budget -> sizeExemptionOf(tx, pr.id, v.total)
    covered -> skip the needs-split (AC2); grown past the approved size -> SizeExceptionWithdrawn{grew} then normal needs-split
Scheduler: sizeExceptionSweep (after followUpSweep and ownerPendingSweep, separate from both)
    pending AND due_at <= now: SizeExceptionLapsed + DeskItemResolved(system, 'dismissed', 'Lapsed ...')
    + the same fresh-verdict step as reject, with reason 'size_exception_lapsed' -> notice row (AC4)
    No notifyUsers to the owner, no DeskItemNudged, no owner_pending timer.
PrReviewClosed (pr-only.ts:310): withdrawSizeExceptionOnClose -> SizeExceptionWithdrawn{pr_closed} + desk item closed
```

### 4.2 packages/shared

New file `packages/shared/src/review/size-exception.ts` (next to `review/owner-pending.ts` and `review/size-check.ts`),
exported from the review index:

```ts
export const SIZE_EXCEPTION_SUBKIND = 'size_exception';
export const SIZE_EXCEPTION_REASON_MIN = 20;
export const SIZE_EXCEPTION_LAPSE_WORKING_DAYS = 2;
export const SIZE_EXCEPTION_STATES = ['pending', 'approved', 'rejected', 'lapsed', 'withdrawn', 'superseded'] as const;
export const SizeExceptionStateSchema = z.enum(SIZE_EXCEPTION_STATES);

export const SizeExceptionReason = z.string().trim()
  .min(SIZE_EXCEPTION_REASON_MIN, `give the reason this PR may stay over budget (at least ${SIZE_EXCEPTION_REASON_MIN} characters)`)
  .max(2000);

/** `aom ceo act size-exception --pr <id|url> --text "<reason>"` */
export const SizeExceptionParamsSchema = z.object({
  pr: z.string().trim().min(1).max(500),          // pr_reviews id, or the PR URL
  text: SizeExceptionReason,
}).strict();

export const SizeExceptionDtoSchema = z.object({
  id: z.uuid(), prReviewId: z.uuid(), prUrl: z.string(), changeId: z.string(), repoName: z.string(),
  chainPrReviewIds: z.array(z.uuid()),
  size: z.number().int(), budget: z.number().int(), unit: SizeUnitSchema,   // GWP-205's unit
  reason: z.string(), state: SizeExceptionStateSchema,
  requestedAt: z.iso.datetime(), dueAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(), decidedBy: z.uuid().nullable(), note: z.string().nullable(),
});

export function sizeExceptionDue(r: { state: string; dueAt: Date; prClosed: boolean }, now: Date):
  'lapse' | 'withdraw' | null {
  if (r.state !== 'pending') return null;
  if (r.prClosed) return 'withdraw';
  return now.getTime() >= r.dueAt.getTime() ? 'lapse' : null;
}

/** An approved exception covers the PR only up to the approved size. */
export function exemptionCovers(e: { state: string; size: number } | null, currentSize: number): boolean {
  return !!e && e.state === 'approved' && currentSize <= e.size;
}

export function sizeExceptionDeskText(i: { changeId: string; repoName: string; size: number; budget: number;
  unit: SizeUnit; reason: string; dueAt: Date }): { title: string; body: string }
// title: "Size exception: PR #<n> in <repo> (<size> of <budget> <sizeUnitWord(unit)>)"
// body:  the reason, then "Approve to keep it as one PR, reject to send it back to its author to split.
//         If you do not answer by <due date>, it goes back to the author to split; you will not be reminded."
```

**Changes to GWP-209's shared code (R2):** in `review/size-check.ts`, `SPLIT_REASONS` becomes `['over_budget',
'timeout_over_budget', 'second_timeout_over_budget', 'size_exception_rejected', 'size_exception_lapsed']`. Optionally
`splitNoticeBody` takes `reason?` and adds "A size exception was asked for and not approved." for the two new reasons.
`queueNotice` passes `pr.split_reason`.

**Events:** a new file `packages/shared/src/events/size-exception.ts`, registered where the event lists are combined:
- `SizeExceptionRequested {sizeExceptionId, orgId, projectId, repoId, prReviewId, chainPrReviewIds, size, budget, unit, members, reason, dueAt, deskItemId, ownerUserId, requestedBy: DeskActorSchema}`
- `SizeExceptionApproved {sizeExceptionId, by: userId, note?}`
- `SizeExceptionRejected {sizeExceptionId, by: userId, note?}`
- `SizeExceptionLapsed {sizeExceptionId}` (system actor)
- `SizeExceptionWithdrawn {sizeExceptionId, cause: 'pr_closed' | 'grew'}`

Add `streamId.sizeException(id)`, or append to `streamId.project(projectId)` as GWP-209's `ev(...)` does. The builder
picks one and uses it for all five events.

**PR state:** `PR_REVIEW_STATES` (`review/pr-review.ts:17`) gets `'size_exception_pending'`. `PrReviewDtoSchema` gets
an optional `sizeException: { id, state: 'pending' | 'approved', dueAt, size } | null`.

**CEO:**
- `CEO_ACTIONS` gets `'size-exception'`.
- `ACTION_CLASSES` gets `'pr.request_size_exception'`, with the label "Ask the owner for a PR size exception" and the
  default policy **`decide`**.
- `CEO_CLI_HELP` gets `size-exception --pr <id|url> --text "<why this size is justified>"`.
- `CEO_RULES_TEXT` gets one sentence: ask only when the size is justified, give the concrete reason, never approve or
  remind, and accept the outcome.

**Follow-up:** add `'size_exception'` to `FOLLOW_UP_SKIP_SUBKINDS` (`agent-ux/follow-up.ts:51`). Update its comment.

### 4.3 apps/server

**Migration** `apps/server/migrations/<next free number, e.g. 2980>_pr_size_exceptions.sql`:

```sql
CREATE TABLE IF NOT EXISTS pr_size_exceptions (
  id                    uuid PRIMARY KEY,
  org_id                uuid NOT NULL,
  project_id            uuid NOT NULL,
  project_repo_id       uuid NOT NULL,
  pr_review_id          uuid NOT NULL,          -- pr_reviews.id (no FK: projection rebuild)
  chain_pr_review_ids   uuid[] NOT NULL DEFAULT '{}',
  size                  integer NOT NULL,
  budget                integer NOT NULL,
  unit                  text NOT NULL,
  members               jsonb NOT NULL DEFAULT '[]',
  reason                text NOT NULL CHECK (length(btrim(reason)) >= 20),
  state                 text NOT NULL,
  owner_user_id         uuid NOT NULL,
  requested_by_agent_id uuid,
  desk_item_id          uuid NOT NULL,
  requested_at          timestamptz NOT NULL,
  due_at                timestamptz NOT NULL,   -- addWorkingDays(requested_at, 2, userTimezone(owner)), fixed at request
  decided_at            timestamptz,
  decided_by            uuid,
  note                  text
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_size_exceptions_one_pending ON pr_size_exceptions (pr_review_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS pr_size_exceptions_due ON pr_size_exceptions (due_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS pr_size_exceptions_project ON pr_size_exceptions (project_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS pr_size_exceptions_chain ON pr_size_exceptions USING gin (chain_pr_review_ids);
```

**Projection** `apps/server/src/projections/size-exception.ts`, registered with the others:
- **Requested:** insert a `pending` row. `UPDATE pr_reviews SET review_state='size_exception_pending' WHERE id =
  ANY(chain) AND review_state='needs_split'`. Leave the `split_*` columns alone so the numbers stay visible.
- **Approved:** state `approved`, `decided_*`, `note`. `UPDATE pr_reviews SET review_state='not_reviewed',
  split_reason=NULL, split_at=NULL, split_total=NULL, split_budget=NULL, split_unit=NULL, split_members=NULL WHERE id =
  ANY(chain) AND review_state='size_exception_pending'`.
- **Rejected / Lapsed / Withdrawn:** state and `decided_at`. Then `UPDATE pr_reviews SET review_state='needs_split'
  WHERE id = ANY(chain) AND review_state='size_exception_pending'`. This restores the earlier state. A fresh
  `PrReviewNeedsSplit` that follows in the same transaction (R2a) overwrites the numbers and adds the notice. With no
  such event, the next poll's `PrReviewSplitCleared` handles a PR that is now within budget. `Withdrawn{grew}` only
  happens on an approved PR (`not_reviewed`), so the `WHERE` makes it a no-op on `review_state`. Its row state is
  `superseded`.

**Command module** `apps/server/src/commands/size-exception.ts`:

```ts
export async function requestSizeExceptionIn(ctx, tx, req: {
  orgId: string; prRef: string; reason: string; by: DeskActor; agentId?: string;
}): Promise<{ sizeExceptionId: string; deskItemId: string; dueAt: Date }>
// 1. SizeExceptionReason.safeParse(req.reason) -> badRequest('reason_required')                     (AC5)
// 2. resolve prRef (uuid or pr_reviews.url) in the org, FOR UPDATE; closed -> conflict('pr_closed')
// 3. review_state must be 'needs_split' -> else conflict('not_over_budget')
// 4. size = await loadSizeContext(tx, projectId, repoId); v = verdictOf(size, changeId);
//    v.state !== 'over' -> conflict('not_over_budget')                                           (R3a)
//    chain = prChain(changeId, size.open) mapped to pr_reviews ids of this repo in 'needs_split'
// 5. an open request covering the PR or chain -> conflict('already_pending');
//    a rejected/lapsed request with size >= v.total -> conflict('already_decided')
// 6. owner = project owner (as tellOwnerTimedOutTwice); none -> conflict('no_owner')
//    tz = await userTimezone(tx, owner); dueAt = addWorkingDays(ctx.clock.now(), SIZE_EXCEPTION_LAPSE_WORKING_DAYS, tz)   (R4)
// 7. append SizeExceptionRequested + DeskItemCreated{ kind:'approval', subkind: SIZE_EXCEPTION_SUBKIND, projectId,
//    addresseeUserId: owner, title/body from sizeExceptionDeskText, data:{sizeExceptionId, prReviewId, url, changeId,
//    repoName, size, budget, unit, members, reason, dueAt}, askedBy: req.by, pinned:false, blocking:false,
//    subjectKey:`size_exception:${prReviewId}` }

export async function resolveSizeExceptionIn(ctx, tx, user, item: Row, resolution: DeskResolution, note?: string)
  : Promise<AfterCommit>
// 'acknowledged' | 'dismissed' -> badRequest('wrong_resolution', 'a size exception is approved or rejected')
// lock the row by item.data.sizeExceptionId; state must be 'pending' (else conflict, including after a lapse)
// PR closed -> SizeExceptionWithdrawn{pr_closed}, return
// approved -> SizeExceptionApproved
// rejected -> SizeExceptionRejected, then sendBackIfStillOver(ctx, tx, row, 'size_exception_rejected')   (AC3)

/** R2a: the shared end of reject and lapse. Runs after the Rejected/Lapsed event is appended in the same tx. */
async function sendBackIfStillOver(ctx, tx, row, reason: 'size_exception_rejected' | 'size_exception_lapsed')
// size = loadSizeContext(tx, row.project_id, row.project_repo_id); checkId = randomUUID()
// for each pr in chain (pr_reviews FOR UPDATE, closed_at IS NULL, review_state = 'needs_split' after the projection):
//   v = verdictOf(size, pr.change_id); if v.state === 'over' -> sendPrBackToAuthorIn(ctx, tx, at, pr, v, checkId, reason)
// the PrReviewNeedsSplit projection creates the pr_split_notices row; deliverSplitNotices posts it to the author

export async function sizeExceptionSweep(ctx): Promise<{ lapsed: number; withdrawn: number }>
// candidates: state='pending' AND due_at <= now, LIMIT 500; for each, withAppendTx + advisory lock `size-exception:<id>`,
// re-read FOR UPDATE, sizeExceptionDue(...):
//   lapse    -> SizeExceptionLapsed + DeskItemResolved{resolution:'dismissed', by:{kind:'system'},
//               note:'Lapsed: no answer within 2 working days; sent back to the author to split'}
//               + sendBackIfStillOver(..., 'size_exception_lapsed')                               (AC4)
//   withdraw -> SizeExceptionWithdrawn{pr_closed} + DeskItemResolved(dismissed, 'PR closed')
// NEVER notifyUsers, never DeskItemNudged, never registerOwnerPending.

export async function withdrawSizeExceptionOnClose(ctx, tx, prReviewId): Promise<void>       // R3b
export async function sizeExemptionOf(db, prReviewId, currentSize?: number)
  : Promise<{ id: string; size: number; budget: number; decidedAt: Date } | null>
// the latest 'approved' row WHERE pr_review_id = $1 OR $1 = ANY(chain_pr_review_ids); when currentSize is given it must
// be covered (exemptionCovers)
export async function listSizeExceptions(db, projectId, filter?: { state?: SizeExceptionState })
```

**Hooks into existing code (revised: R2, R3, R3b):**
- `commands/pr-size-check.ts`:
  - **Export `sendBack` as `sendPrBackToAuthorIn`**, and keep the two internal calls. Its existing
    `resolveTimedOutTwice(..., 'closed')` call is harmless here.
  - **`evaluateRepoSizes`, `v.state === 'over'` branch** (after the existing `not_reviewed`/in-flight guard, before
    `sendBack`):
    ```ts
    const ex = await latestApprovedExemption(tx, pr.id);       // from size-exception.ts
    if (ex && exemptionCovers(ex, v.total)) continue;          // AC2: approved exception, not sent back
    if (ex) await supersedeExemption(ctx, tx, ex, 'grew');     // grown past the approved size: normal needs-split
    ```
    Without this hook, an approved PR goes back to needs-split on the next poll.
  - **`onPrReviewTimedOut`:** before `timeoutFollowUp`, if `v.state === 'over'` and an approved exemption covers
    `v.total`, treat the verdict as within budget. A first timeout then does nothing, and a second timeout tells the
    owner (`owner_pending`), as for a within-budget PR. The same chain loop applies the exemption to each member.
- `commands/pr-only.ts:310`: next to `resolveTimedOutTwice(..., 'closed')` on `PrReviewClosed`, call
  `withdrawSizeExceptionOnClose(ctx, tx, prReviewId)`.
- `commands/pr-review-runs.ts` `listPrReviews`: add `sizeException` to the DTO (one query by project for pending and
  approved rows). Keep `split` for `needs_split` only. `sizeOf` already returns the live size for a pending PR.
- `commands/desk.ts` `closeItem`: `else if (item.kind === 'approval' && item.subkind === SIZE_EXCEPTION_SUBKIND) after
  = await resolveSizeExceptionIn(...)`.
- `scheduler/scheduler.ts`: `await sizeExceptionSweep(this.ctx).catch(err => log 'size exception sweep failed')` after
  the `ownerPendingSweep` call (line ~198). `deliverSplitNotices` (line ~165) then posts the notices on its next pass.
- **GWP-211 (not landed):** it reads `sizeExemptionOf(db, prReviewId, size)`. This card provides the helper and its unit
  test.

**CEO action:** a new file `apps/server/src/ceo/actions8.ts` (`ACTIONS8`, spread into `registry.ts`):

```ts
const sizeException: ActionDef<SizeExceptionParams> = {
  cls: 'pr.request_size_exception',
  schema: SizeExceptionParamsSchema,             // AC5 at the schema level
  auditRefusals: true,
  describe: (p, pr) => `Ask the owner for a size exception on ${pr.subjectLabel}: ${truncate(p.text, 80)}`,
  async prepare(env, p) { /* reads only: PR, live verdict, open/decided requests, owner -> refuse(...) */ },
  async execute(env, p, pr) {
    const r = await withAppendTx(env.ctx.pool, (tx) => requestSizeExceptionIn(env.ctx, tx,
      { orgId: env.orgId, prRef: p.pr, reason: p.text, by: ceoBy(env), agentId: env.agentId }));
    return { message: `Asked the owner (desk item ${r.deskItemId}); lapses ${r.dueAt.toISOString()} if unanswered`, result: r };
  },
};
```

**CEO snapshot** (`ceo/snapshot.ts`) gets two sections, both rendered through `renderCeoData`:
- "Over-budget PRs (needs split)": `review_state='needs_split'` with no pending request and no decided request at the
  current size. Show the PR, repo, author, `split_total` of `split_budget` and the unit.
- "Size exceptions waiting for the owner": the PR and the due date.

Add the line "the owner decides; do not remind them".

**Route:** `GET /api/projects/:id/size-exceptions?state=` uses the same visibility as the Pull requests list. It returns
`SizeExceptionDto[]`, newest first.

### 4.4 apps/web (unchanged)

- **`apps/web/src/components/desk/SizeExceptionDeskItem.tsx`**, chosen in `pages/Desk.tsx` for
  `approval`/`size_exception`. It shows:
  - the PR link;
  - **size vs budget with the unit** ("1,240 of 800 changed lines, 155%"), using `sizeUnitWord`;
  - the reason as plain text;
  - "Answer by <date>; if you do not, it goes back to the author to split. No reminder.";
  - an optional note;
  - **Approve** / **Reject** buttons. There is no Dismiss and no Snooze.
- **`components/pull-requests/SizeCheckInfo.tsx`:**
  - `size_exception_pending` shows "Size exception pending, owner answers by <date>".
  - An approved exception shows "Over budget, approved exception (up to <size> <unit>)".
  - A needs-split PR whose reason is `size_exception_rejected` or `size_exception_lapsed` adds "Size exception not
    approved" or "Size exception lapsed".
- **History** on the Pull requests page: a "Size exceptions" section with a state filter. It shows stacked cards on
  phones.
- **Touch:** targets of at least 44 px, nothing that works only on hover, and the note `<textarea>` scrolls into view
  when focused so the soft keyboard can open.

### 4.5 docs (unchanged)

- `docs/USER-GUIDE.md` "Size exceptions": Johnny asks with a reason, and you approve or reject on the Desk. Approved PRs
  are reviewed as usual and pass the size check up to the approved size. Rejected PRs go back to the author. **If you do
  not answer within 2 working days (Mon–Fri, your time zone), the PR goes back to the author, and you are not reminded.**
  The history is on the Pull requests page.
- `docs/ARCHITECTURE.md` section 45: the table, the events, the sweep, the two exemption hooks, and the rule that this is
  the one timer that lapses instead of reminding.
- `apps/server/src/assistant/pack/topics/desk.md`: one line.

## 5. Acceptance criteria mapped to the design and tests

All in new test files, using the fake clock (`app.clock.setOffset` to a fixed Wednesday or Friday, then `advance`). Set
up the PR as `apps/server/test/pr-size-check.test.ts` does: write the open-list snapshot and settings, then run the poll.

| AC | Design | Test (new file) |
|---|---|---|
| AC1: Johnny raises a request with a reason, and the owner sees a desk item with the reason and size vs budget | `requestSizeExceptionIn` + `DeskItemCreated(approval/size_exception, addressee owner)`; `SizeExceptionDeskItem` | `apps/server/test/size-exception-request.test.ts`: a CEO action on a `needs_split` PR → desk item for the project owner, `data.reason/size/budget/unit` set, PR (and chain members) `size_exception_pending`, a poll leaves it alone. Web: `SizeExceptionDeskItem.test.tsx` shows the reason and "1,240 of 800 changed lines". |
| AC2: approval → approved exception, not sent to needs-split | `resolveSizeExceptionIn(approved)`; the exemption hooks in `evaluateRepoSizes` and `onPrReviewTimedOut` | `apps/server/test/size-exception-decide.test.ts`: approve → row `approved`, PR `not_reviewed`. **A following poll does not append `PrReviewNeedsSplit`**. A timeout of the approved PR does not send it back. Growth past the approved size → `superseded` and needs-split. `sizeExemptionOf` checks. |
| AC3: rejection → needs-split, author notified | `resolveSizeExceptionIn(rejected)` → `sendBackIfStillOver` → `PrReviewNeedsSplit(reason size_exception_rejected)` | same file: reject → PR `needs_split`, `split_reason='size_exception_rejected'`, one `pending` row in `pr_split_notices` (and `deliverSplitNotices` queues it, as in `pr-size-check.test.ts`). A PR already within budget at rejection gets no notice and is cleared on the next poll. `dismissed`/`acknowledged` → 400. |
| AC4: no answer in 2 working days → needs-split, author notified, no owner reminder | `sizeExceptionSweep`, `dueAt = addWorkingDays(now, 2, userTimezone(owner))`; subkind in `FOLLOW_UP_SKIP_SUBKINDS` | `apps/server/test/size-exception-lapse.test.ts`: (a) Wed 10:00 → Fri 09:59 still pending, Fri 10:00 lapsed, `needs_split`, `split_reason='size_exception_lapsed'`, a notice row, the desk item closed. (b) **Fri 15:00 → lapses Tue 15:00**, nothing before. (c) Request on a Saturday → due Tue 00:00 in the owner's time zone. (d) Over the whole span with the org follow-up window set to 1 day and `ownerPendingSweep` run as well: **no `DeskItemNudged`, no `follow_ups` push, no `owner_pending_timers` row, no `owner_pending_reminder` item**. (e) A second sweep does nothing. (f) The owner answers after the lapse → 409. (g) The owner's `users.timezone` set to a non-UTC zone moves the due time. |
| AC5: no reason → refused | `SizeExceptionParamsSchema` + server check + SQL CHECK | `packages/shared/test/size-exception.test.ts`: missing, blank and 19-character `text` refused, 20 accepted; `sizeExceptionDue`, `exemptionCovers`. Server: a blank reason → 400, no event, no desk item. |
| Req. 4: history | table + route + web section | `size-exception-decide.test.ts`: the list returns approved, rejected and lapsed requests with their reasons. |
| Guard: Johnny cannot approve | existing CEO refusals | `size-exception-request.test.ts`: CEO `answer`/`triage` refused; a member who is not the owner gets 403. |
| Guard: CEO wiring | `CEO_ACTIONS`, class, help | `packages/shared/test/ceo-size-exception.test.ts` (`toContain`; the default policy is `decide`). |
| Guard: closing the PR | `withdrawSizeExceptionOnClose` | `size-exception-decide.test.ts`: `PrReviewClosed` while pending → row `withdrawn`, desk item closed. |

Regression (the "Likely regression" standing order): the existing `pr-size-check.test.ts`, `follow-up` tests,
`owner-pending.test.ts`, `pr-only-eligibility.test.ts` and `packages/shared/test/pr-size-check.test.ts` must still pass
after the `SPLIT_REASONS` extension, the export of `sendBack` and the exemption hooks.

## 6. Risks

- **The exemption hooks in GWP-209's code** (R3) are the largest risk. Missing either one makes AC2 fail on the next poll
  or timeout. The AC2 tests cover both.
- **Single writer of `review_state`.** It is now shared by GWP-209's projection and this card's projection. Each
  `UPDATE` is guarded by a `WHERE review_state = ...`, so the two never fight.
- **The follow-up chase:** covered by the skip-list entry and AC4 test (d).
- **Johnny stalling a split:** bounded by the 2-working-day lapse and one decided request per PR per size.
- **The PR grows after approval:** the exemption covers the approved size only (`exemptionCovers`).
- **Chains:** GWP-209 marks every member, so the request covers every member that is `needs_split`.
  `sizeExemptionOf` matches any member.

## 7. Builder checklist

1. Shared:
   - `review/size-exception.ts` and `events/size-exception.ts`;
   - `SPLIT_REASONS` (and optionally `splitNoticeBody`);
   - `size_exception_pending` in `PR_REVIEW_STATES`, and the DTO field;
   - `FOLLOW_UP_SKIP_SUBKINDS`;
   - the CEO action, class, label, policy, help and rule.
2. Server:
   - the migration, the projection and `commands/size-exception.ts`;
   - in `pr-size-check.ts`: export `sendBack` as `sendPrBackToAuthorIn`, plus the two exemption hooks;
   - the hook in `pr-only.ts:310`;
   - the DTO in `listPrReviews`;
   - the `closeItem` branch, the scheduler call, `ceo/actions8.ts` plus the registry entry, the snapshot and the route.
3. Web: `SizeExceptionDeskItem`, the Desk branch, the `SizeCheckInfo` states, and the history section.
4. Docs: USER-GUIDE, ARCHITECTURE section 45, and the assistant's `desk.md`.
5. Tests as in section 5. Run unit suites only.

## 8. Assumptions about the dependencies (now landed)

These were checked on 2026-11-15 against `c973566a`. Section 0 has the evidence.

| # | Assumption | Status |
|---|---|---|
| 1 | `review_state` is text, and `size_exception_pending` can be added | Holds |
| 2 | A single command marks needs-split and notifies the author | Revised: export `sendBack`, add two `SPLIT_REASONS`, and the notice comes through the `pr_split_notices` row (R2, R2a) |
| 3 | The size result is stored, with one decision point | Revised: live `loadSizeContext` + `verdictOf`, and two decision points (R3, R3a, R3b) |
| 4 | `addWorkingDays` and an owner time-zone helper exist | Revised (name): `addWorkingDays` as assumed, plus `userTimezone(db, ownerUserId)` (R4) |
| 5 | `ownerPendingSweep` never reminds on this item | Holds |
| 6 | Only `not_reviewed` is eligible for review | Holds |
| 7 | No GWP-208 code is needed | Holds |
| 8 | GWP-205 settings give the budget and unit | Holds (`reviewSettingsOf`, through `loadSizeContext`) |
| 9 | GWP-211 reads `sizeExemptionOf` | Not landed, unchanged |
