# GWP-151: a builder's test-run question under "Test without an environment" when the workstation has no DevOps engineer

## Question

GWP-42 made a builder's `--topic tests` question non-blocking when the project has "Test without an environment" switched on. The question becomes a DevOps request, and the card records the "tests not run" marker (`BuilderTestsNotRun`, table `card_test_gaps`). That only happens when the builder's workstation has a DevOps engineer. Without one, the question takes the normal blocking question chain and the card waits.

This card asks two things:

1. Is the behaviour already on release/1.6.0?
2. If not, how do we record the same marker without a DevOps request, keep the question from blocking, and leave every other case unchanged?

## Check of release/1.6.0 (AC 1)

`git diff origin/release/1.6.0 HEAD` is empty for these files: `apps/server/src/commands/question-flow.ts`, `apps/server/src/commands/devops.ts`, `apps/server/src/projections/testing.ts` and `packages/shared/src/events/testing.ts`. So the card branch and release/1.6.0 have the same code on this path.

**The behaviour does not exist yet. The card must be built, not closed.**

- `devopsTopicQuestion` (`question-flow.ts:251`) returns `undefined` at line 266 when `devopsAgentOn` finds no engineer. That happens before the GWP-42 test-gap check at lines 279-293, so `raiseQuestion` (`questions.ts:91`) continues into the normal chain (`QuestionRaised`, a blocking desk item, the claim released).
- `builderTestGap` (`question-flow.ts:374`) always calls `createDevOpsRequestIn`. That function throws `no_devops_agent` when the workstation has no engineer (`devops.ts:296`).
- The marker cannot be stored without a request. In `card_test_gaps` (`migrations/2743_card_test_gaps.sql`), `request_id uuid NOT NULL` is part of `PRIMARY KEY (card_id, request_id)`. The `BuilderTestsNotRun` payload requires `requestId: Id`, and `reason` is `z.literal('test_without_environment')`.

Pieces that already exist and can be reused:

- the GWP-42 classification (`report.topic === 'tests'`, the builder role, not DevOps, the project flag, the runner capability `question-continue:1`)
- the `continueShift: true` answer and the runner's handling of it
- the `BuilderTestsNotRun` projection
- the reviewer and tester brief section "Tests the builder did not run"
- the card view notice (`EvidencePanel.tsx`, `data-testid="test-gap-notice"`)

## Findings

### F1. Classification (reused as is)

GWP-42 section 4 / option A1 classifies a question as test-run / test-environment only by the explicit topic `tests`, never by its text. A builder who asks with `--topic environment` keeps the blocking behaviour. This card keeps that rule unchanged (card constraint).

### F2. Every place that reads the marker

| Reader | File | Handles a gap with no request? |
|---|---|---|
| Projection insert / result update | `apps/server/src/projections/testing.ts:135-151` | Insert: only after the column becomes nullable. Update: keyed on `request_id`, so it never touches a null row (correct, no result ever arrives). |
| Dispatcher result pass | `apps/server/src/dispatcher/bottleneck.ts:26` (`testGapResultPass`) | Yes. The INNER JOIN on `devops_requests` skips null rows, so no change is needed. |
| GWP-42 reuse check | `question-flow.ts:389` (`builderTestGap`, `existing`) | Yes. The join on `devops_requests` skips null rows. |
| Waiting-question convert | `question-flow.ts:513` | Yes. It looks up by a real request id. |
| Builder/reviewer/tester brief | `apps/server/src/runner-gateway/brief.ts:426` (`testGapsOf`) | No. It sends `requestId: g.request_id`, and the brief schema requires a string. |
| Prompt rendering (runs in the runner) | `packages/shared/src/prompt/shift-prompt.ts:~410` | No. It always writes "DevOps request <id>" and "Result: not arrived yet". |
| Card view API | `apps/server/src/queries/testing.ts:59`, `packages/shared/src/api/testing.ts:71` | No. `requestId: z.uuid()` is required. |
| Card view | `apps/web/src/components/EvidencePanel.tsx:103` | No. It uses `key={g.requestId}` and the text "DevOps request <id>". |

Nothing at finalisation reads `card_test_gaps`. "Treated the same at review/finalisation" therefore means two things: the gap appears in the reviewer and tester briefs, and it appears in the card view. Both stay true if the readers above accept a gap without a request.

### F3. Old runners drop an invalid `shift.start` frame

`apps/runner/src/connection/client.ts:218` parses every server frame with `ServerToRunnerSchema.safeParse` and **drops** a frame that fails. `shift.start` carries `brief: ShiftBriefSchema`, and `brief.testGaps[].requestId` is `z.string()` (required).

If the brief schema made `requestId` optional or nullable and the server sent a gap without it, a runner on an older version would silently drop the shift start for every later shift on that card (review, test). **The brief must keep sending `requestId` as a string.** The web API is served together with the server, so it can change shape freely.

### F4. `builderTestsNonBlocking` (planning blocker 2)

`brief.ts:405` sets the flag from the project switch, the builder role and `!is_devops` only. Today a builder on a workstation without DevOps is told "ask with `--topic tests`, the card is not parked", but the question then blocks. After this card the statement is true in both cases. **The flag needs no new condition.**

The prompt text says "the DevOps engineer is asked". It should become conditional wording so it is right without an engineer (see Shared below).

The flag still ignores the runner capability, so an old runner is told "non-blocking" but gets the park. That mismatch is older than this card, harmless (it parks safely) and out of scope.

### F5. Runner capability (planning blocker 3)

Keep the `QUESTION_CONTINUE_CAPABILITY` check on the new path. Without it the runner treats `accepted: true` as terminal and ends the shift. The card would then still hold its claim with nobody working it, and no question would be open to recover it. So a runner without the capability keeps today's behaviour: the normal blocking chain, which is safe.

### F6. How often the case happens

Every paired workstation normally gets a built-in DevOps engineer that cannot be fired (ledger d7096210). So "no DevOps engineer" is rare. It happens when the engineer is `retired` or `needs_rehome`, after an agent move, or when `devopsAgentOn` finds nobody active. The change is small and low risk, which matches the Low priority.

## Options compared

### Storing a marker without a request

| Option | Same marker (AC 7) | Old runners safe | Honest display | Cost |
|---|---|---|---|---|
| **S1. `request_id` nullable, surrogate key, optional `requestId` in the event, `reason` widened** | yes: same table, event, projection, brief section and card notice | yes, if the brief sends `''` (F3) | yes | 1 migration, a few reader edits |
| S2. A made-up `requestId` (a random uuid with no `devops_requests` row) | yes | yes | no: the brief and card view show "DevOps request abc12345: result not arrived yet" forever | smallest |
| S3. A second table or event for request-less gaps | no: forbidden by the card ("no second marker type") | yes | yes | most |

**Choice: S1.** S2 is a lie in the UI and the brief, and it breaks the "request id means a `devops_requests` row" invariant that `builderTestGap` and `testGapResultPass` rely on. S3 is ruled out by the card.

### Where the new branch goes

| Option | Notes |
|---|---|
| **R1. In `devopsTopicQuestion`: evaluate the GWP-42 test-gap condition before the "no DevOps, return undefined" exit; with no engineer call a new `builderTestGapWithoutDevops`** | One place owns the classification. GWP-42 and the new path share the exact predicate (AC 4-6 stay identical). Runs in the same transaction as the rest of `raiseQuestion`. |
| R2. A new check in `raiseQuestion` before `devopsTopicQuestion` | Duplicates the predicate. Risk of drift. |

**Choice: R1.** Pull the predicate into a small helper so both branches use it literally.

## Recommendation and design

### Data model

New migration `apps/server/migrations/<next free number>_card_test_gaps_without_request.sql`. At the time of writing the highest is `2860_*`, so use for example `2870_`. Migrations run once (`schema_migrations`).

```sql
-- A builder test gap may have no DevOps request: no DevOps engineer was on the workstation.
ALTER TABLE card_test_gaps ADD COLUMN IF NOT EXISTS gap_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE card_test_gaps DROP CONSTRAINT IF EXISTS card_test_gaps_pkey;
ALTER TABLE card_test_gaps ADD PRIMARY KEY (gap_id);
ALTER TABLE card_test_gaps ALTER COLUMN request_id DROP NOT NULL;
-- Keeps "one gap per card and request" for gaps with a request; NULLs are distinct, so request-less gaps are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS card_test_gaps_card_request ON card_test_gaps (card_id, request_id);
```

Check the real name of the primary key constraint (`\d card_test_gaps`; the default is `card_test_gaps_pkey`). The projection's `ON CONFLICT DO NOTHING` has no conflict target, so it still applies to the new unique index and still deduplicates replays of gaps with a request. Nothing references `gap_id`, so a replay that regenerates it is harmless (`card_test_gaps` is already in `PROJECTION_TABLES`, `projections/index.ts:258`).

Event `BuilderTestsNotRun` (`packages/shared/src/events/testing.ts:108`), widened and backward compatible (every stored event still validates):

```ts
z.object({
  cardId: Id,
  requestId: Id.optional(),                 // absent: no DevOps engineer, nobody was asked
  agentId: Id,
  stage: z.string(),
  reason: z.enum(['test_without_environment', 'no_devops_engineer']),
  detail: z.string().default(''),
}),
```

The two values are the "reason text" the card allows to differ (requirement 4). Keep the `reason` column as is (text).

Projection (`projections/testing.ts:135`): insert `p.requestId ?? null`. No other change. `BuilderTestsResultArrived` keeps a required `requestId`, because a result only exists for a request.

### Server

`apps/server/src/commands/question-flow.ts`, in `devopsTopicQuestion`:

```ts
const ws = await one<...>(tx, `SELECT id, user_id FROM workstations WHERE id=$1 AND status='active'`, [shift.workstation_id]);
if (!ws) return undefined;
const devops = await devopsAgentOn(tx, ws.id, card.org_id);
const detail = report.text.replace(/\s+/g, ' ').trim().slice(0, 300);
// "Test without an environment": a builder's test-run question never parks the card.
if (await isBuilderTestGapQuestion(tx, ws.id, card, agent, topic)) {
  if (!devops) return builderTestGapWithoutDevops(ctx, tx, shift, card, agent, detail);
  // ...existing summary / requestedBy, then return builderTestGap(...) exactly as today
}
if (!devops) return undefined;
// ...the rest unchanged (problem, summary, open, non-blocking and blocking DevOps paths)
```

`isBuilderTestGapQuestion` is the existing predicate moved verbatim: `topic === 'tests' && agent.role_key === 'builder' && !agent.is_devops && project.test_without_environment && workstation has QUESTION_CONTINUE_CAPABILITY`. The order of the SQL checks does not matter. Keep `summary`, `open` and `requestedBy` computed only where they are used, or compute them after the no-DevOps exits as today. Either way the existing DevOps paths must produce exactly the same events.

New function:

```ts
/**
 * A builder's test-run question under "Test without an environment" on a workstation with no DevOps engineer: nobody can
 * run the tests, so no request is filed. The card records the same gap (`BuilderTestsNotRun`, no request), is not parked
 * and keeps its claim, and the builder carries on.
 */
async function builderTestGapWithoutDevops(ctx, tx, shift, card, agent, detail): Promise<Result> {
  const stage = String(shift.stage ?? card.stage);
  const already = await one(tx,
    `SELECT 1 AS ok FROM card_test_gaps WHERE card_id=$1 AND request_id IS NULL AND stage=$2`, [card.id, stage]);
  const events: AppendInput[] = [
    cardMessage(card, { kind: 'agent', agentId: agent.id }, 'question',
      `${detail}\n\n(topic tests: no DevOps engineer on this workstation, not sent)`),
  ];
  if (!already)
    events.push(
      { streamId: streamId.card(card.id),
        event: { type: 'BuilderTestsNotRun',
                 payload: { cardId: card.id, agentId: agent.id, stage, reason: 'no_devops_engineer', detail } },
        actor: agentActor(agent.id), scope: projectScope(card.org_id, card.project_id) },
      cardMessage(card, { kind: 'system' }, 'system',
        `${agent.name} did not run the DB-backed tests: 'Test without an environment' is on for this project and there is no test environment and no DevOps engineer on this workstation, so nobody was asked to run them. They are not passed.`,
        { reason: 'no_devops_engineer' }),
    );
  await ctx.store.append(events, { tx });
  return {
    accepted: true,
    continueShift: true,
    message: `Recorded. There is no test environment and no DevOps engineer on this workstation, so those tests cannot be run here. ${card.ref} is not parked: carry on without them, do not record them as passed, and say in your handoff note that they were not run (no environment, no DevOps engineer).`,
  };
}
```

Rules for this function:

- No `createDevOpsRequestIn`, no `QuestionRaised`, no desk item, no `releaseClaimEvents`, no `TestEnvironmentParked`. The card keeps `status='claimed'`, its claim and its stage. Everything is in the one `ctx.store.append` inside the `raiseQuestion` transaction, so the card can never be both waiting on a question and carrying the marker (constraint "atomic").
- A second test question in the same stage records no second gap and no second system message. It still gets the same answer, like the GWP-42 "attached to the open request" case.
- The `repeatGuard` runs earlier in `raiseQuestion` and only matches desk items, so it does not interfere. The new path creates none.

`builderTestGap` (the GWP-42 path) is unchanged. It keeps writing `reason: 'test_without_environment'` with a `requestId`.

`apps/server/src/runner-gateway/brief.ts` `testGapsOf`: send `requestId: g.request_id ?? ''` (F3: the brief must stay a string for old runners) and add `reason: g.reason`. `builderTestsNonBlocking` is unchanged (F4).

`apps/server/src/queries/testing.ts:59`: `requestId: g.request_id ?? null`, add `reason: g.reason`.

### Shared

- `packages/shared/src/protocol/runner.ts:376` (brief `testGaps` item): keep `requestId: z.string()` and document that `''` means no request. Add `reason: z.enum(['test_without_environment','no_devops_engineer']).optional()` (additive, old runners ignore it).
- `packages/shared/src/api/testing.ts:71`: `requestId: z.uuid().nullable()`, and add `reason: z.string()`. An enum is fine too. Use a shared constant `BUILDER_TEST_GAP_REASONS` exported next to the event, and use it in all three schemas.
- `packages/shared/src/prompt/shift-prompt.ts`:
  - **"Tests the builder did not run" section:** for a gap with `requestId === ''`, render `- Not run: no DevOps engineer on the workstation, nobody was asked (asked by <agent> in <stage>, <at>): <detail>\n  Result: none will arrive.` Gaps with a request render exactly as today.
  - **`builderTestsNonBlocking` section:** change "the DevOps engineer is asked and the card is not parked" to "the card is not parked; the DevOps engineer is asked to run them if this workstation has one". The rest of the text is unchanged.

### Web

`apps/web/src/components/EvidencePanel.tsx:103`:

- use `key={g.requestId ?? \`gap-${g.at}\`}`
- when `g.requestId` is null, the line reads: "The builder did not run the DB-backed tests ('Test without an environment' is on). No DevOps engineer was on the workstation, so nobody was asked to run them."
- the `role="status"`, the `data-testid="test-gap-notice"` and the styling stay the same, so it is the same marker and the same display.
- gaps with a request render unchanged.

This is a text-only line. It wraps on narrow and touch screens like the existing notice and adds no new control.

### Docs

`docs/RUNNER.md:2463`, bullet "Builders under 'Test without an environment'": add one sentence. When the workstation has no DevOps engineer, the server files no request, records `BuilderTestsNotRun` without a request (`reason: no_devops_engineer`), posts the reason on the card thread and answers with `continueShift: true`. No result ever arrives for such a gap. The brief carries `requestId: ''` for it.

### Tests (apps/server/test/question-flow.test.ts, describe 'a builder\'s test question under "Test without an environment"')

To simulate "no DevOps engineer", run `UPDATE agents SET status='retired' WHERE is_devops` (`devopsAgentOn` filters on `status='active'`). Restore it to `'active'` in `afterEach` or `finally`, because `reset()` keeps DevOps agents and other tests depend on them. The shared runner already announces `question-continue:1`.

| # | Case | Asserts |
|---|---|---|
| T1 | ON, no DevOps, `topic: 'tests'`, blocking | `{accepted: true, continueShift: true}`; the message mentions no DevOps engineer and "carry on"; the card is `claimed`, same claim and stage, `parked_request_id` null; **0** `devops_requests` rows; **0** `QuestionRaised` events and **0** desk items for the card; **0** `ClaimReleased`/`TestEnvironmentParked`; exactly one `card_test_gaps` row with `request_id: null`, `reason: 'no_devops_engineer'`; a thread message containing "no DevOps engineer" and "did not run the DB-backed tests". A second test question gives the same answer and leaves 1 gap row and 1 system message. The shift can still hand off. |
| T2 | ON, DevOps present, tests | The existing "ON + tests" test, unchanged (request created, gap with `request_id`, `reason: 'test_without_environment'`). |
| T3a | OFF, DevOps present, tests | The existing "OFF + tests" test, unchanged. |
| T3b | OFF, no DevOps, tests | Normal chain: a `QuestionRaised` desk item for the card, the card `blocked` with no claim (as for any blocking question), 0 `card_test_gaps`, 0 `devops_requests`, `continueShift` undefined. |
| T4 | ON, no DevOps, an ordinary question (no topic, and also `topic: 'environment'`) | Normal chain as in T3b, 0 gaps. |
| T5 | Same marker | After T1, the reviewer's brief (`nextShift('Rex')`) has `testGaps` length 1 with `requestId: ''`, `reason: 'no_devops_engineer'`, `stage: 'build'`, `agentName: 'Bea'`. `testGapResultPass` returns 0 and does not touch the row. Also add a mixed case: a card with one gap of each kind lists both in the brief. |
| T6 | Card view / API | `GET` of the card's testing facts returns the gap with `requestId: null` (where the existing tests read `queries/testing.ts`). |
| T7 | Replay | If the replay or projection test suite rebuilds from events, include a `BuilderTestsNotRun` without `requestId`. |
| Shared | `packages/shared/test/prompt.test.ts` | A gap with `requestId: ''` renders "no DevOps engineer" and "none will arrive"; a gap with an id renders as before; the event schema accepts the old payload (literal reason, with `requestId`) and the new one. |
| Web | `apps/web/src/test/testing.test.tsx`, "the test gap notice" | A gap with `requestId: null` shows "No DevOps engineer was on the workstation"; the existing two tests stay green. |

The server tests are DB-backed (Postgres on 127.0.0.1:5433). If the builder's sandbox cannot reach it, say so in the handoff and leave them to the tester/DevOps under the test-mode standing order. The shared and web unit tests run without a DB.

## Risks and traps

1. **Old runners (F3).** Never send `requestId` as `null` or omit it in the brief. An older runner drops the whole `shift.start` frame. Send `''`. An old runner will render "DevOps request  (asked by ...) Result: not arrived yet" for such a gap, which is cosmetic.
2. **The primary key change** must keep replay dedup for gaps with a request. The unique index on `(card_id, request_id)` does that, and `ON CONFLICT DO NOTHING` (no target) covers it.
3. **Disabling DevOps in tests** must be undone, or every later test in the file loses its engineer.
4. **Do not move `devopsAgentOn` before the test-gap predicate in a way that changes the DevOps-present path.** The events produced when an engineer exists must be byte-for-byte the same (AC 4). Only the order of the checks changes.
5. **Inactive workstation** (`ws` not found): keep `return undefined` (normal chain), as today.
6. **Capability**: a runner without `question-continue:1` keeps the normal chain on the no-DevOps path too (F5). This is deliberate, not a missed case.

## Acceptance criteria mapped to the design

| AC | Design |
|---|---|
| Architect's check of release/1.6.0 recorded; close if done | Section "Check of release/1.6.0": not done, build needed. Also posted on the card. |
| ON + no DevOps + test question: marker, no request, not in the blocking chain | `builderTestGapWithoutDevops`: `BuilderTestsNotRun` without `requestId`, no `createDevOpsRequestIn`, no `QuestionRaised`, no claim release, one append in the question transaction. T1. |
| Builder told to continue; thread shows the reason | Return `continueShift: true` with the "no environment, no DevOps engineer" message, plus the system thread message. T1. |
| ON + DevOps present: exactly GWP-42 | The `builderTestGap` call and its events are unchanged; only the predicate is factored out. T2. |
| OFF, with or without DevOps: normal chain | The predicate is false. With DevOps the existing park path runs; without DevOps `return undefined` sends it to the normal chain. T3a, T3b. |
| Non-test question: normal chain in every configuration | The predicate requires `topic === 'tests'`. Other topics follow today's code. T4 plus the existing "ON + environment" test. |
| Same marker type, shown and treated the same | Same table, event, projection, brief section and card notice. Only `reason` and the missing request differ. T5, T6, shared and web tests. |
| Tests cover the four combinations plus one non-test question | T1, T2, T3a, T3b, T4. |
