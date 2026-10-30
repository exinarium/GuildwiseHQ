# GWP-42: a builder's test-run question to DevOps under "Test without an environment"

## Question

When a project has "Test without an environment" on and a builder asks DevOps to run the tests, or asks about the test environment, the card must not be parked. The card keeps moving. It records that the DB-backed tests were not run by the builder, and the reviewer and the tester see that. The DevOps result is attached to the card when it arrives, whatever stage the card is in by then. Projects with the setting off keep today's behaviour exactly.

## Findings

### 1. Today's path (`apps/server/src/commands/question-flow.ts`)

`raiseQuestion` (`commands/questions.ts:56`) runs the ledger duplicate check, then `repeatGuard`, then `devopsTopicQuestion`. `devopsTopicQuestion` (`question-flow.ts:249`) takes a question whose `topic` is in `DEVOPS_TOPICS` (`environment`, `sandbox`, `tooling`), provided the shift's workstation has an active DevOps engineer:

- **Non-blocking** (`--non-blocking`, or the first leg of `--wait`): it files a request (or attaches to any open request of the card), posts the question on the card thread and returns "Carry on". The card is not parked.
- **Blocking** (the default): with an open request it appends `TestEnvironmentParked`. Without one it calls `environmentNotReadyEvents`. In both cases it wraps everything in `releaseClaimEvents(..., 'question', ...)`, so the claim is released.
- **`--wait` that times out**: `convertWaitingQuestion` (`question-flow.ts:407-436`) parks the card on the shift's open DevOps request (`TestEnvironmentParked`, problem `tooling`) and releases the claim.

Nothing on this path looks at the project's test settings, except by accident (see finding 3).

### 2. The runner ends the shift on any blocking question

`isTerminalReport` (`packages/shared/src/protocol/ipc.ts:74`) counts `kind: 'question' && blocking` as terminal. When the server accepts such a report, `ShiftSupervisor` (`apps/runner/src/shifts/supervisor.ts:2527-2535`) sets `reportState='accepted'` and stops the session after `exitGraceMs` (120 s). It also refuses every later terminal report, the builder's handoff included. A `converts: true` report is blocking as well.

**So the server alone cannot keep the builder's shift going.** The `shift.report.result` reply needs a flag saying "accepted, not terminal", and the runner has to honour it. An older runner would ignore the flag and end the session. That leaves a claimed card whose shift ended without a report. For that reason the new path is gated on a runner capability (see the design below).

### 3. A bug on today's ON path

`environmentNotReadyEvents` (`commands/testing.ts:303-317`) returns early when `projects.test_without_environment` is on. It then appends only one card message, written for testers ("...goes back to the tester..."): no DevOps request and no park. `devopsTopicQuestion` still wraps this in `releaseClaimEvents`. Today, with the setting on, **any** blocking DevOps-topic question from **any** role on a card with no open request therefore:

- creates no DevOps request,
- releases the claim and ends the shift,
- and posts a message about the tester.

AC 7 says "a non-test DevOps question with the setting ON still parks the card as today". The card's author assumes that today it parks, which is true only with the setting off. To meet AC 7, the question path must skip that tester-only shortcut. The tester's own `shift.rejected{environment_not_ready}` path (`commands/shifts.ts:1216`) keeps it. This change happens only with the setting on, so the "OFF unchanged" constraint holds.

### 4. Classifying a question as test-run / test-environment

`QUESTION_TOPICS` (`packages/shared/src/questions/index.ts:9`) has no test topic. A test question today arrives as `environment` (mapped to problem `app_not_deployed`), and so does "deploy the app". Telling them apart from the text alone (keywords such as test, DB, postgres) is not reliable. For example, "deploy the app so the E2E tests can run" is a deploy question. A wrong guess either breaks AC 7 (a deploy question would stop blocking) or misses the case the card is about.

### 5. One flag or two (requirement 8)

**Two independent settings in code:**

| Setting | Storage | Event | Read by |
|---|---|---|---|
| "Test without an environment" | `projects.test_without_environment boolean` | `ProjectSettingsChanged`-style event with `testWithoutEnvironment` (`projections/projects.ts:336`) | `environmentNotReadyEvents`, `testDeploySkipReason`, `dispatcher/candidates.ts:123`, `brief.ts:374` (tester only) |
| Integration tests (`off` / `local` / `remote`, suites, ...) | `projects.integration_tests jsonb` | `ProjectIntegrationTestsSet` (`projections/runs.ts:25`) | `integrationTestsOf`, `test-environments.ts`, card field `integrationTests` |

The new behaviour keys on `test_without_environment` only. "Integration tests off" on its own changes nothing in the builder flow. No setting or UI toggle is added.

### 6. How a DevOps result reaches a card today

`DevOpsRequestCompleted` is emitted from five places (`devops.ts:702`, `devops.ts:841`, `runs.ts:786`, `workstations.ts:299`, `brief.ts:934`). The projection only updates `devops_requests`. A card hears about the result only if it is parked on the request: `dispatcher/bottleneck.ts:unparkPass` then appends `TestEnvironmentReady` (re-queue). The result itself goes only to the DevOps thread (thread id = request id), not to the card thread. `DevOpsRequestCompleted` is already a dispatcher trigger (`dispatcher.ts:66`) and `testingPass` runs on every dispatcher pass.

### 7. Where the reviewer and the tester read card facts

`buildBrief` (`apps/server/src/runner-gateway/brief.ts:193`) gives them `leanBrief` → `buildEvidence` (`REVIEW_SIDE` + `test`/`qa_steps`). The prompt is rendered in `packages/shared/src/prompt/shift-prompt.ts:342`. The card thread in the brief is capped at 3 messages (`THREAD_MAX_MESSAGES`), so a thread message alone is **not** a reliable marker: it needs its own brief field. In the web card view, `CardTesting` (`apps/server/src/queries/testing.ts`) feeds `EvidencePanel.tsx`, which already shows `parkedOn` as a status line.

## Options compared

### A. Classification

| Option | Reliable | AC 7 safe | Cost |
|---|---|---|---|
| A1. New topic `tests` (`aom question --topic tests`) | yes: explicit | yes: `environment` keeps its meaning | one enum value, CLI help, instructions, docs |
| A2. Text heuristic on `environment` questions | no | no: deploy texts mention tests | small, but wrong silently |
| A3. A1 plus a heuristic fallback | partly | no | most |

**Choice: A1.** A builder sees the hint only when the setting is on (see the brief field below), so the topic gets used where it matters. A builder who still asks with `--topic environment` gets today's blocking behaviour, which is safe.

### B. How the DevOps result reaches the card

| Option | Notes |
|---|---|
| B1. Add events at each of the five `DevOpsRequestCompleted` emitters | easy to miss one; spreads card logic into DevOps code |
| B2. `ctx.store.subscribe` hook | runs after commit; a failure is lost unless retried |
| B3. A dispatcher pass next to `unparkPass` (choice) | idempotent (row lock plus `result_at IS NULL`); retries on its own; already triggered by `DevOpsRequestCompleted`; never touches `cards` |

### C. Keeping the builder's shift alive

| Option | Notes |
|---|---|
| C1. Server answers "accepted" only | the runner ends the session anyway (finding 2): fails AC 2 |
| C2. Rewrite the report as non-blocking in the CLI | the CLI does not know the project setting |
| C3. `continueShift: true` on `shift.report.result`, honoured by the runner, gated by the runner capability `question-continue:1` (choice) | an old runner gets today's behaviour |

## Recommendation and design

### Data model (events, projected)

New events in `packages/shared/src/events/testing.ts`, card stream, `projectScope`:

```ts
/** "Test without an environment": a builder's test-run question went to DevOps without parking the card. */
defineEvent('BuilderTestsNotRun', z.object({
  cardId: Id, requestId: Id, agentId: Id, stage: z.string(),
  reason: z.literal('test_without_environment'), detail: z.string().default(''),
})),
/** The DevOps request of a `BuilderTestsNotRun` completed (done or failed); the card's stage, status and claim do not change. */
defineEvent('BuilderTestsResultArrived', z.object({
  cardId: Id, requestId: Id, status: z.enum(['done', 'failed']), summary: z.string().default(''),
})),
```

Migration `apps/server/migrations/2750_card_test_gaps.sql` (take the next free number):

```sql
CREATE TABLE IF NOT EXISTS card_test_gaps (
  card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  agent_id uuid,
  stage text NOT NULL,
  reason text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  result_status text,
  result_summary text,
  result_at timestamptz,
  PRIMARY KEY (card_id, request_id)
);
```

Add `'card_test_gaps'` to `PROJECTION_TABLES` (`projections/index.ts`, next to `test_runs`). Projectors in `projections/testing.ts`:

- `BuilderTestsNotRun` → `INSERT ... ON CONFLICT DO NOTHING`.
- `BuilderTestsResultArrived` → `UPDATE card_test_gaps SET result_status, result_summary, result_at=e.createdAt WHERE card_id AND request_id`.

Neither projector touches `cards`, so there is no `mutateCard` and no transition. Old events are unchanged, so replay of existing logs is unaffected.

### Shared

- `questions/index.ts`: add `'tests'` to `QUESTION_TOPICS`, `DEVOPS_TOPICS` and `ROUTINE_TOPICS`. Doc comment: "tests: running tests or the test environment they need".
- `protocol/runner.ts`:
  - `ShiftReportResultSchema` gains `continueShift: z.boolean().optional()` ("accepted, but not terminal: the shift carries on").
  - New `QUESTION_CONTINUE_CAPABILITY = 'question-continue:1'`.
  - `ShiftBriefSchema` gains:
    - `testGaps: z.array(z.object({ requestId, stage, agentName, at, detail, result: z.object({ status: z.enum(['done','failed']), summary, at }).optional() })).optional()`
    - `builderTestsNonBlocking: z.boolean().optional()`
- `prompt/shift-prompt.ts`:
  - a section **"Tests the builder did not run"** when `testGaps` is non-empty (text below);
  - a section **"Tests that need an environment"** when `builderTestsNonBlocking` is set: "This project tests without an environment. If you need DB-backed or environment-dependent tests run, ask with `aom question --topic tests --text ...`: the DevOps engineer is asked and the card is not parked. Carry on, do not record those tests as passed, and say in your handoff note that they were not run."
- `prompt/instructions.ts:93` and `aom-cli.ts:2729` help: add `tests` to the topic list. The CLI validation already uses `QUESTION_TOPICS`.

Marker text (also checked by the brief tests):

```
## Tests the builder did not run
The builder did not run the DB-backed (environment-dependent) tests: 'Test without an environment' is on for this project. They are not passed; judge the change knowing they did not run.
- DevOps request <requestId> (asked by <agentName> in <stage>, <at>): <detail>
  Result: not arrived yet.            | Result arrived <at> (done|failed): <summary>
```

### Server

**`question-flow.ts` `devopsTopicQuestion`.** After the workstation and DevOps engineer checks, and before the `!report.blocking` branch:

```ts
const gap = topic === 'tests' && agent.role_key === 'builder' && !agent.is_devops
  && (await projectTestsWithoutEnvironment(tx, card.project_id))       // projects.test_without_environment
  && (await workstationHas(tx, ws.id, QUESTION_CONTINUE_CAPABILITY));
if (gap) return builderTestGap(ctx, tx, shift, card, agent, report, { ws, summary, detail, requestedBy });
```

`builderTestGap` does the following, for blocking and waiting questions alike:

- It reuses an open request only if that request already has a `card_test_gaps` row. Otherwise it creates one with `createDevOpsRequestIn` (`orgId: card.org_id`).
- It appends:
  - the card message with the question (as in the non-blocking branch);
  - `BuilderTestsNotRun` (only for a new request);
  - a system card message: "<agent> did not run the DB-backed tests: 'Test without an environment' is on for this project. DevOps request <id> was asked to run them; its result is posted here when it arrives." with `{ requestId }`.
- It does **not** call `releaseClaimEvents`, `environmentNotReadyEvents` or `testEnvironmentHardStop`, and appends no `TestEnvironmentParked`.
- It returns `{ accepted: true, continueShift: true, message: 'Recorded. The DevOps engineer was asked (request <id>). This project tests without an environment, so <ref> is not parked: carry on without those tests, do not record them as passed, and say in your handoff note that they were not run. The result is posted on the card.' }`.

**Same file, blocking path.** Call `environmentNotReadyEvents(..., { summary, requestedBy, fromQuestion: true })`. In `testing.ts` the `test_without_environment` early return applies only when `!opts.fromQuestion`. This fixes finding 3 and is what makes AC 7 testable. In the blocking path, map `tests` to problem `app_not_deployed`, as for `environment`.

**`convertWaitingQuestion`, DevOps branch (line 408).** If `req.id` has a `card_test_gaps` row, return `{ accepted: true, continueShift: true, message: 'The DevOps engineer has not finished yet; the card is not parked ...carry on...' }` with no events. Otherwise keep today's behaviour.

**`Result` (`question-flow.ts`), `QuestionResult` (`questions.ts`), `ReportResult` (`shifts.ts:79`).** Add `continueShift?: boolean`. `runner-gateway/handlers.ts:334` passes it into `shift.report.result`.

**New dispatcher pass `testGapResultPass(ctx)`**, in `dispatcher/bottleneck.ts`, called from `testingPass` after `unparkPass`:

```sql
SELECT g.card_id, g.request_id, r.status, r.result_summary, c.org_id, c.project_id, c.ref
  FROM card_test_gaps g JOIN devops_requests r ON r.id = g.request_id JOIN cards c ON c.id = g.card_id
 WHERE g.result_at IS NULL AND r.status IN ('done','failed')
```

For each row, in a `withAppendTx`, it re-selects the gap `FOR UPDATE ... AND result_at IS NULL`, then appends:

- `BuilderTestsResultArrived`;
- a card message: "DevOps finished the DB-backed tests the builder did not run (request <id>): <summary>", or "DevOps could not run ...: <summary>", with `{ requestId, status }`.

It appends nothing that changes the card's stage, status or claim.

**`runner-gateway/brief.ts`.**

- `testGaps`: rows of `card_test_gaps` joined with `agents.name`, for every non-DevOps shift of the card. Put them in `leanBrief`, or next to `testerEnvironment`. They are needed for review, test and qa_steps, and they help a builder on rework.
- `builderTestsNonBlocking: true`: when `project.test_without_environment && agent.role_key === 'builder' && !agent.is_devops`.

**`queries/testing.ts` `cardTesting` + `packages/shared/src/api/testing.ts` `CardTesting`.** Add `testGaps: [{ requestId, stage, at, detail, result: { status, summary, at } | null }]`. Update the `CardTesting` mocks in the web tests.

### Runner

- `runner.ts:1315`: announce `QUESTION_CONTINUE_CAPABILITY`.
- `shifts/supervisor.ts`:
  - `ReportVerdict` gains `continueShift?`; the result handler (~line 676) passes it on.
  - In the report path (~2527): if `terminal && result.continueShift`, set `s.reportState = 'none'`, set no `reportAccepted` and no grace timer, and return the server's message.

### Web

`components/EvidencePanel.tsx` (the testing-links block):

- Show one `role="status"` line per gap (`data-testid="test-gap-notice"`): "The builder did not run the DB-backed tests ('Test without an environment' is on). DevOps request <short id>: result not arrived yet". When the result has arrived, the line ends with "result arrived: <status>, <summary>" instead.
- Include `testGaps.length` in the early `return null` check.
- Link the request the same way the DevOps panel does, if a request route exists. If not, show the id.

### Docs

- `docs/RUNNER.md`, section "Integration tests by the tester": add a bullet **"Builders under 'Test without an environment'"**. It covers the `tests` topic, no park, the claim kept, `continueShift` and the capability, the marker in the reviewer and tester briefs and the card view, the result posted by the dispatcher pass, and the two-settings decision.
- Add `tests` to the topic list in the RUNNER.md "Questions" section.
- Optionally a what's-new entry.

## Risks and traps

1. **Old runner.** Without the capability the server takes today's path, so the card is parked and nothing breaks. The FakeRunner in the tests must announce `question-continue:1` for the ON/test path (`w.connectRunner({ capabilities: [...] })`).
2. **Duplicate delivery.** `withInbox` returns no result on a duplicate (`handlers.ts:331`), so `continueShift` is lost and the runner treats the report as terminal. This is rare (an outbox resend). Accept it and note it in the docs, or store the result in the inbox. Not required.
3. **Behaviour change ON + non-test topic.** It now parks on a real DevOps request instead of releasing with a tester message (finding 3). This is intended (AC 7). Say it in the handoff.
4. **Testers under ON.** A tester's `--topic tests` question is not a builder's, so it takes the blocking path. Testers are already told not to ask DevOps under ON.
5. **No DevOps engineer on the workstation.** `devopsTopicQuestion` returns undefined, as today, and the question takes the normal chain. That case is out of scope; suggest it as a backlog follow-up.
6. **Projection guards.** A test likely checks that every table is in `PROJECTION_TABLES` or `SAVED`, and that every event has a projector. Add both.
7. **The tests of this card need Postgres (127.0.0.1:5433)**: `question-flow.test.ts`, the brief tests and the replay test are DB-backed. GWP-41, in the same group, is about reaching that database from the builder's sandbox. There is no code dependency, so no `block`. If the database is unreachable, the builder says so in the handoff.

## Acceptance criteria mapped to the design

| AC | Design | Test |
|---|---|---|
| ON + test topic: request created, card stays in stage, unparked, claimed | `builderTestGap`: `createDevOpsRequestIn`, no `releaseClaimEvents` | question-flow: `topic: 'tests'`, setting on → `devops_requests` 1 row; card `status='claimed'`, same `claim_shift_id`, `parked_request_id IS NULL`, same stage |
| ON: no env-not-ready / hard-stop events, shift not ended | no `TestEnvironmentParked`, `ClaimReleased` or test_environment desk item; `continueShift` | same test: `eventsOfType('TestEnvironmentParked'/'ClaimReleased')` empty, no desk item with subkind `test_environment`, report result has `continueShift: true`; the shift can still hand off afterwards. Runner unit test: supervisor keeps the session and accepts a later handoff after a `continueShift` verdict |
| ON: marker with request reference | `BuilderTestsNotRun` → `card_test_gaps`; system card message with `requestId`; `CardTesting.testGaps` | row in `card_test_gaps` with `request_id`; `cardTesting` returns it; web test for the notice |
| Reviewer and tester briefs show the marker | `brief.testGaps` + shift-prompt section | brief test: review and test shift prompts contain "did not run the DB-backed"; a card without a gap does not (also in `packages/shared/test/prompt.test.ts`) |
| Result posted, marker updated, in Build or Review/Test; stage and claim unchanged | `testGapResultPass` → `BuilderTestsResultArrived` + card message | after the ON case, move the card to review (handoff), complete the request (`DevOpsRequestCompleted` done), run the dispatcher → thread message, `result_status='done'`, stage/status/claim the same as before the pass; run the pass again → no second message |
| OFF + test topic still parks | the gap branch is not taken; blocking path as today | `status='waiting'`, `claim_id IS NULL`, `parked_request_id` set (the same assertions as the existing environment test) |
| ON + non-test topic still parks | `fromQuestion: true` skips the tester shortcut | setting on, `topic: 'environment'` (deploy text) → parked on a request, claim released |
| Tests cover the paths | as above, plus replay | rebuild projections after the cases → identical `card_test_gaps`/`cards` snapshot (the pattern of `testing-rebuild.test.ts`) |
| Waiting variant (no AC, needed for consistency) | `convertWaitingQuestion` gap branch | `--wait` timeout on a gap request → accepted, `continueShift`, card still claimed |

Requirement 8 decision: two settings; only `test_without_environment` drives this card (finding 5).
