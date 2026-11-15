# GWP-193: POST /api/discovery/:id/questions/:questionId/answer fails with ZodError

## Question

Answering a discovery question sometimes returns 500 with a `ZodError` thrown from `PgEventStore.append`. Which
event field fails validation, why, and what is the smallest fix?

## Findings

### Where the error is thrown

The reported stack is `(anonymous) <- Array.forEach <- PgEventStore.append <- (anonymous)`.

- `Array.forEach` is the **pre-validation loop** at the top of `PgEventStore.append`
  (`apps/server/src/eventstore/pg-event-store.ts:53-57`, `DomainEventSchema.parse(i.event)`), not the second parse
  after the interceptors (that one is a `.map`).
- The caller is anonymous, so it is the `withAppendTx(ctx.pool, async (tx) => ...)` callback inside
  `DiscoveryService.answer` (`apps/server/src/sessions/discovery.ts:1132-1226`). The later appends in `answer`
  (`configEvent` on review done, `requestFacilitator`) are called from named methods and would show up as named frames.

So the failing event is one of the two that `answer` appends inside its transaction:
`DiscoveryQuestionAnswered` (always) or `DiscoveryNoteAdded` (only for `kind: 'park'`).

### Ruling out each field

`DiscoveryQuestionAnswered` (`packages/shared/src/events/discovery.ts:60-72`):

| Field | Constraint | Source in `answer` | Can it fail? |
|---|---|---|---|
| `threadId`, `questionId` | `z.uuid()` | route params, already validated by `DiscoveryQuestionParamsSchema` (`z.uuid()`) | no |
| `by` | `Id.nullable()` (`z.uuid()`) | session user id; `users.id` defaults to `uuidv7()`, which Zod 4 accepts | no |
| `kind`, `source` | enums | set from fixed literals | no |
| `optionId` | max 20 | request (`max(20)`), or the stored proposal (`DiscoveryAnswerProposed.optionId` max 20, an id from `QuestionOptionSchema` max 20) | no |
| `text` | max 8000 | request text trimmed (`max(8000)`), or the proposal text (max 4000, prose proposals are clipped to 4000) | no |

`DiscoveryNoteAdded` (park only, `discovery.ts:1197-1204`, built by `noteEvent`):

| Field | Constraint | Source | Can it fail? |
|---|---|---|---|
| `noteId` | uuid | `randomUUID()` | no |
| `text` | min 1, max 2000 | `clip(q.question, 300)`; questions are min 1 | no |
| `by.id` | max 80, nullable | user uuid (36 chars) | no |
| **`by.name`** | **`z.string().min(1).max(100)`** (`Author`, `events/discovery.ts:10-14`) | `userName()` = `users.display_name ?? 'Owner'` (`discovery.ts:1120-1123`) | **yes** |

`users.display_name` is `text NOT NULL` with no length limit (`apps/server/migrations/0002_users.sql`). The user events
only require `min(1)` (`packages/shared/src/events/user.ts`), and accepting an invitation takes a display name of up to
**120** characters (`packages/shared/src/api/invitations.ts:26`). A user whose display name is 101 to 120 characters long
(or longer, from other account paths) therefore produces a `DiscoveryNoteAdded` whose `by.name` breaks `max(100)` →
`ZodError` → 500.

**Root cause:** `DiscoveryService.userName()` passes the stored display name into event `Author.name` without fitting
it to the event's limit of 100.

### Same defect elsewhere in the same service

`userName()` feeds an `Author` (max 100) in every one of these, so they fail the same way for the same user:

| Call site | Event | Endpoint |
|---|---|---|
| `discovery.ts:1202` | `DiscoveryNoteAdded` (park) | POST `/questions/:qid/answer` **(this report)** |
| `discovery.ts:1290` | `DiscoveryNoteAdded` | POST `/api/discovery/:id/notes` |
| `discovery.ts:1327` | `DiscoveryNoteUpdated.by` | PATCH note |
| `discovery.ts:1430` | `DiscoveryNoteAdded` (apply a proposal) | resolve proposal |
| `discovery.ts:1487` | `DiscoveryPhaseChanged.by` | set phase |
| `discovery.ts:1021` | `DiscoveryPhaseChanged.by` | time action "wrap up" |
| `discovery.ts:1004` | system message text (no length issue) | time action "extend" |

Fixing `userName()` fixes them all, and changes nothing for names of 100 characters or fewer.

`apps/server/src/sessions/board.ts:1404` has the same `display_name ?? 'Owner'` helper for the boardroom. That is outside
this card (different route and events); I am filing it as a backlog suggestion, not part of this fix.

## Options

1. **Fit the name in `userName()`** (trim, clip to 100, fall back to `'Owner'` when blank). One function, covers every
   discovery call site, no schema or data change. Recommended.
2. Raise `Author.name` to `max(120)` or more. This changes the shared event contract. It still breaks for names from
   paths without a limit, and it moves the problem to every reader that assumes 100 characters. Rejected.
3. Clip at each call site. Six edits doing the same thing, easy to miss the next one. Rejected.
4. Limit `users.display_name` at the database level. That needs a migration and a data fix for existing long names,
   and other events take the name with other limits. Too wide for this card. Rejected.

## Recommendation / design

### Change (one file, `apps/server/src/sessions/discovery.ts`)

Make `userName()` return a value that always satisfies `Author.name` (`min(1).max(100)`):

```ts
/** Longest `name` an event `Author` takes (packages/shared/src/events/discovery.ts). */
const AUTHOR_NAME_MAX = 100;

private async userName(db: Queryable, userId: string): Promise<string> {
  const u = await one(db, 'SELECT display_name FROM users WHERE id=$1', [userId]);
  const name = String(u?.display_name ?? '').trim();
  return name ? clip(name, AUTHOR_NAME_MAX) : 'Owner';
}
```

- `clip` is the local helper at `discovery.ts:96`. It returns at most `n` characters (`n - 1` plus `…`), so the result
  is always at most 100.
- Trimming and falling back on blank also protects `min(1)` against a whitespace-only name.
- The "extended the session" system message (line 1004) will show the clipped name too. That is fine, and it reads
  better.
- No change to shared schemas, the request schema, the web client or the database.

### Regression test (`apps/server/test/discovery.test.ts`)

Add one `it(...)` in the existing describe, modelled on the park part of
`'answers: quick pick, free text, skip and park ...'` (lines 211-251):

1. `const s = await create({ title: 'Long name' })`, then `const { questionId } = await facilitatorAsks(...)`.
2. Give the owner a display name longer than 100 characters, e.g.
   `await q('UPDATE users SET display_name=$1 WHERE id=$2', ['N'.repeat(120), <owner user id>])`. Get the owner's user
   id from the world helper (`w.owner`, created with `t.userSession(...)` in `test/helpers/world.ts:127`), or look it up
   by the owner's email. Restore the original name in a `finally` so the later tests are unaffected.
3. `await answer(s.threadId, questionId, { kind: 'park' })`, which expects 200. **Without the fix this returns 500**
   (ZodError on `DiscoveryNoteAdded.by.name`).
4. Assert the question status is `'parked'` and a `parked` note exists with `byName.length <= 100`.
5. Optional, cheap, and covers the shared helper: `POST /api/discovery/:id/notes` with the same user returns 201
   (also 500 before the fix).
6. Finish the queued facilitator turn (`await finish(await nextStart())`) as the neighbouring tests do, so the runner
   queue stays clean.

Run `apps/server` vitest for `test/discovery.test.ts` (it uses the test Postgres like the rest of the server suite).

### Risks

- Very low. Only names over 100 characters change (they are clipped in discovery event payloads); shorter names
  produce exactly the same events as before.
- Events already stored are not affected. No replay issue: the failing events were never stored.

### Acceptance criteria

| AC | Covered by |
|---|---|
| The failure no longer happens | `userName()` always returns 1 to 100 characters, so `DiscoveryNoteAdded`, `DiscoveryNoteUpdated` and `DiscoveryPhaseChanged` authors validate |
| A regression test reproduces the bug without the fix and passes with it | new test in `apps/server/test/discovery.test.ts`: a 120-character display name, then park → 500 before the fix, 200 and a parked note after |
