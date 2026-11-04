# GWP-67 Journey waits, gates and webhooks

Status: design, revised on 2026-11-04 after GWP-65 (public forms, client links) and GWP-66 (journeys) landed in the working
branch. Section 9 lists every assumption, whether it held, and what changed. The changes are written into the sections
below, so this file is the design to build. Target branch `release/1.5.0`. Repository: GuildwiseHQ only. Hosted ingress
for the new public endpoint is GWP-69. The runner-offline wait is GWP-68: this card leaves room for it as another wait
kind.

## 1. The question

GWP-66 gives journeys made of workflow steps linked by handoffs on one shared record. This card adds the steps that
**pause**, **gate**, **start** and **end** a journey:

1. **Wait** steps. The user picks what the step waits for (a duration, a date, a form submission or upload through a
   per-client link, or a webhook event), how long it lasts, and one timeout action (remind and keep waiting, go to a
   named step, escalate to the desk, cancel the journey). Owner decision 2 says waits are never silent: every wait shows
   its deadline on the instance, and every timeout writes a visible event.
2. **Wait-for-form**. The step creates a GWP-65 per-client link for the record, hands it to the firm (desk or webhook)
   and resumes when the submission is stored in the firm's storage.
3. **Gate** steps. An approval by a named role or user, shown on the desk. Approve follows the approve handoff, reject
   follows the reject handoff.
4. **Webhooks**. An inbound, signed webhook starts a journey on a new or matched record. An outbound webhook step calls a
   URL with a body template, retries with backoff and shows the final result.
5. **Timers** survive a server restart and fire once.

The planner's three questions are answered in D4 (where inbound payload mapping runs), D6 (are outbound webhook secrets
credentials) and D3 (how an escalation reaches the desk).

## 2. Findings in the code

| Where | What is there | Use in this card |
|---|---|---|
| `packages/shared/src/journeys/schema.ts` (GWP-66) | `JourneyStepSchema` = discriminated union on `kind`: `WorkflowStepSchema` and an unconfigured placeholder `{ kind: 'wait' \| 'gate', id, label, position? }`. `StepIdSchema` is a slug `^[a-z][a-z0-9_]{0,59}$`. Handoffs are `{ id, from, on: 'done' \| 'cancelled' \| 'any', to: stepId \| 'end', condition?, label? }`; the first matching handoff wins | Replace the placeholder variant with configured `wait` and `gate` schemas and add `webhook_call`; extend `on` with `approved`, `rejected`, `failed` (D1) |
| `packages/shared/src/journeys/validate.ts` | `validateJourney(def, opts)` gives errors and warnings. Saving with errors is allowed (a draft), starting needs none. Unconfigured parts are errors (`no_workflow`). `placeholder_cycle` refuses a loop made only of wait/gate steps | Call `validateJourneyWaitsAndGates(def, opts)` from it; replace the cycle rule (4.1) |
| `packages/shared/src/journeys/resolve.ts` | `resolveHandoff` / `nextMove(def, stepId, { result: 'done' \| 'cancelled', card, record, visits })` → `next` / `end` / `stuck` | Add an optional `outcome` to the context (D1) |
| `packages/shared/src/journeys/record.ts`, migration `2810_journeys.sql` | Records are **project-scoped**: `id, org_id, project_id, record_type, external_id, display_name, status, current_instance_id, current_step_id`, timestamps. References have a fixed `kind` (`document`, `form_submission`, `card`, `playbook_session`), a `ref` and a `label`. No dates, no keyed values, no index on `external_id` | Hook matching on `(project_id, record_type, external_id)`; mapping is limited to external id and display name; date waits read a card field (D3, D4) |
| `apps/server/src/commands/journey-runtime.ts` | **No event-log reactor or cursor.** State lives in the projected `journey_step_runs` (one row per visit, `pending/open/waiting/done/cancelled/skipped/refused`). `sweepJourneys(ctx)` runs from `Scheduler.triggers()` (15 s tick, plus `kickTriggers` 750 ms after any new event) and makes each move in one `withAppendTx` with `lockInstance(tx, id, visit, status)`. `advance()` (private) appends `JourneyStepCompleted{result}` plus `JourneyStepEntered` / `JourneyInstanceCompleted` / `JourneyInstanceStuck` + desk alert. `startStep` turns `Refused` errors into `JourneyStepRefused` + stuck + alert. `continuePlaceholder` moves a waiting placeholder on with `skipped`. `cancelInstance(ctx, id, byUserId)` | Plug in as extra sweep passes and an executor registry called from a new `enterServerStep`; export `advance` with an outcome (D2, 4.3) |
| `apps/server/src/projections/journeys.ts` | `JourneyStepEntered` with `kind !== 'workflow'` → run `waiting`, instance `waiting`. `JourneyInstanceCancelled{instanceId, by}` ends the instance | Unchanged, except that `webhook_call` is also a non-workflow kind |
| `packages/shared/src/events/journey.ts` | `JourneyStepEntered.kind: 'workflow' \| 'wait' \| 'gate'`, `JourneyStepCompleted.result: 'done' \| 'cancelled' \| 'skipped'`, `JourneyStepRefused.reason` enum, `JourneyInstanceCancelled{ instanceId, by: Id }` (a user is required) | Add `webhook_call`, an optional `outcome`, the `not_published` refusal, an optional `by` and a `reason` (all backward compatible) |
| `apps/server/src/commands/journeys.ts`, `routes/journeys.ts` | `startInstance(ctx, who, body)` (own transaction; new record or `recordId`, no match by external id; `startedBy = who.userId`); `continueStep`, `cancelInstance`; routes under `/api/journeys`, `/api/journey-instances/:id/{continue,cancel,playbook}`, `/api/journey-records/:id` | Extract `startInstanceIn(tx, …)` for the hook start; the `continue` route goes through the wait (4.3) |
| `apps/web/src/components/journeys/StepEditor.tsx`, `pages/JourneyInstance.tsx`, `components/journeys/InstanceHistory.tsx`, `JourneyDesigner.tsx` | Wait/gate badge "Coming with waits and gates"; a Continue button for a waiting non-workflow step | Step config forms and the instance wait panel go here (4.7) |
| `packages/shared/src/journeys/templates.ts` | Rentals: `wait_documents` (wait) and `approval` (gate) placeholders; `build()` takes `[id, label, kind, workflowKey?]` | The builder configures both steps (§5) |
| `apps/server/src/commands/public-forms.ts` (GWP-65) | `createClientLink(ctx, who, formId, { reference ≤120, expiresInDays 1..90, recordKind?, recordId? })` opens **its own** transaction, needs a published form and a user (`by`); `revokeClientLink(ctx, who, …)` likewise. Link URL = public URL + `#c=<signed token>`, computed on read (`toDto`) | Extract `createClientLinkIn(tx, …)` and `revokeClientLinkIn(tx, …)`; existing callers unchanged (D8) |
| `apps/server/src/public-forms/routes.ts` + `projections/public-forms.ts` | `FormClientLinkUsed{linkId, submissionId}` + `FormSubmitted{submissionId, formId, linkId?, answers, files}` appended in the one transaction that sets `form_submissions.status='complete'`, i.e. only when the answers and every file are stored. A link is single-use (`form_client_links.used_at`, `used_by_submission`) | Form waits resolve on `form_client_links.used_by_submission` (D2) |
| `apps/server/src/public-forms/limits.ts` | `KeyedBuckets(perMinute, burst, now)` + `clientKey(ctx, ip)` | Reused as is for the hook route |
| `apps/server/src/scheduler/scheduler.ts` | `triggers()` runs `sweepJourneys` then other sweeps, each `.catch(log)`; new events kick it | `journeyTick` runs right after `sweepJourneys` |
| `apps/server/src/commands/schedules.ts` `fireDueSchedules` | `next_fire_at <= now … FOR UPDATE SKIP LOCKED`, events appended in the same transaction | **Pattern** for fire-once timers (D2) |
| `apps/server/src/commands/approval.ts` | Human approval desk item: `QuestionRaised` subkind `approval_step`, `addresseeUserId`, `resolveApprover`, `mayDecide` | **Pattern** for the gate desk item (journey-bound, not card-bound) |
| `packages/shared/src/testing/index.ts` `DESK_SUBKIND` | has `journeyStepRefused` | Add `journeyGate`, `journeyWaitEscalated`, `journeyWaitLink` |
| `apps/web/src/components/ApprovalDeskItem.tsx`, `pages/Desk.tsx` | Approve / send back with a note, `sticky-actions` | **Pattern** for the gate, escalation and link desk items |
| `apps/server/src/commands/schedule-delivery.ts` | Outbound webhook signature `sha256=hex(HMAC(secret, "<ts>.<body>"))`, `assertWebhookUrl`, `webhookBackoffMs`, `WEBHOOK_MAX_ATTEMPTS`, `isRetryableStatus`, **`dispatchToRunner`** (`delivery.send`) | Reuse backoff, retry rule and signature format; copy the `dispatchToRunner` shape (D6) |
| `apps/runner/src/outbound-delivery/send.ts`, `packages/shared/src/integrations/seal.ts`, Integrations page | Runner sends with sealed credentials; the browser seals secrets to the runner | `journey.webhook.call` + kind `webhook_credential` (D6) |
| `apps/server/src/webhook-relay/route.ts`, `auth/secrets.ts` | Hardened public raw-body route; `AOM_SECRET_KEY` encryption | Pattern for `/hooks/in/:token` and the `jhsec_` secret (D4, D5) |
| `apps/server/src/projections/index.ts` `PROJECTION_TABLES`, `projections/rebuild.ts` `SAVED` | Every projection table is listed; operational tables are saved over a rebuild | List the three new projection tables; `journey_hook_calls` in `SAVED` |
| `apps/server/migrations` | last is `2830_public_forms.sql` | This card: `2840_journey_waits.sql` |
| `CHANGELOG.md` | `## [1.5.0]` exists | Add the entry under it |

## 3. Options compared and decisions

### D1. Where the new steps live: journey steps, not workflow stages

| | A. **Journey step kinds** next to GWP-66's workflow step (**recommended**) | B. New workflow stage kinds inside card workflows |
|---|---|---|
| Matches the owner's model (rentals: "application → WAIT → screening → approval (gate)") | yes | no: hidden inside one workflow |
| GWP-66 placeholders `wait` / `gate` become real | yes | no |
| Touches the card lifecycle, dispatcher and built-in workflows | no | yes: high regression risk |
| "Go to a named step", "reject follows the reject handoff" | handoffs already link steps | needs outcome routing inside a workflow |

**D1: A.** Three server-run step kinds: `wait`, `gate` (both replace GWP-66's placeholder variant) and `webhook_call`.
They never create a card. Outcomes and handoffs:

GWP-66 handoffs match on `on: 'done' | 'cancelled' | 'any'` against the run's `result`. This card extends `on` with
`approved`, `rejected`, `failed`, and `JourneyStepCompleted` with an optional `outcome`. `resolveHandoff` matches a
handoff when `on === 'any'`, `on === ctx.outcome`, or `on === ctx.result`. Each server-run outcome also has a plain
result, so the handoffs GWP-66 already builds (`done → next`) keep working:

| Step kind | Outcome → result | Handoff `on` values the designer offers |
|---|---|---|
| `wait` | (none) → `done` | `done` |
| `gate` | `approved` → `done`, `rejected` → `cancelled` | `approved`, `rejected` (a saved `done`/`cancelled` handoff is read as approve/reject) |
| `webhook_call` | (none) → `done` on 2xx, `failed` → `cancelled` when retries are used up or the error is final | `done`, `failed` |

`validateJourneyWaitsAndGates` refuses `on` values that cannot occur for the from-step kind (e.g. `approved` from a
workflow step). No matching handoff leads to GWP-66's existing `stuck` path (`JourneyInstanceStuck` + a
`journey_step_refused` desk alert). That path also covers a webhook call that failed and has no `failed` handoff.

"Go to a named step" and "cancel" are timeout actions (D3), not handoffs. A goto ends the run with `result: 'skipped'`
and appends `JourneyStepEntered` for the named step at `visit + 1`, with no `handoffId`.

### D2. Timers and resumption: rows swept in the scheduler, claimed in the append transaction

| | A. In-memory `setTimeout` | B. Generic job queue table | C. **Open waits as a projection of wait events, swept with `FOR UPDATE SKIP LOCKED`, firing appends the event in the same transaction (recommended)** |
|---|---|---|---|
| Survives a restart | no | yes | yes |
| Fires once | no | needs a claim protocol | yes: the row lock and the event commit together |
| Same after a projection rebuild | n/a | no | yes |
| Matches the code base | no | partly | yes (`fireDueSchedules`, and GWP-66's own state-table sweep) |

**D2: C.** GWP-66 has no event-log reactor: its runtime sweeps state tables and locks the instance per move. This
card follows the same model. All server-run work happens in `journeyTick(ctx)`, which `Scheduler.triggers()` calls
right after `sweepJourneys`. New events kick `triggers()` within 750 ms, so entering a step or receiving a submission is
handled quickly. The tick runs these passes in order, each item in its own `withAppendTx`, each wrapped like
`sweepJourneys`' `attempt` so one failure never stops the rest:

1. **enter**: runs with `status='waiting'` at the instance's `current_visit`, where the instance is `waiting` and no
   `journey_waits` or `journey_webhook_calls` row exists for `(instance_id, visit)` → `enterServerStep(ctx, instanceId,
   visit)`. It locks the instance with `lockInstance(tx, id, visit, 'waiting')`, loads the definition and calls the
   executor for the step kind (`executors.ts`). A `Refused` error from an executor becomes `JourneyStepRefused` +
   `JourneyInstanceStuck` + alert, exactly as in `startStep` (the retry pass in `sweepJourneys` then re-enters the step).
   A step that is still the unconfigured GWP-66 placeholder (only possible in instances started before this card) gets
   `JourneyWaitStarted{kind:'manual'}`: no deadline, ended only by Continue. It is shown as "Waiting for someone to
   continue" and is never picked up again.
2. **forms**: `open`/`escalated` form waits whose `form_client_links.used_by_submission` is set →
   `resolveFormWait`.
3. **due waits**: `fireDueWaits(ctx)`:

```ts
const due = await rows(tx, `SELECT * FROM journey_waits
  WHERE status = 'open' AND next_fire_at <= $1
  ORDER BY next_fire_at, id FOR UPDATE SKIP LOCKED LIMIT 50`, [now]);
for (const w of due) {
  const d = timeoutDecision(waitView(w), now);          // pure, shared, unit tested with a fake clock
  await ctx.store.append(eventsFor(w, d, now), { tx });  // each event carries firedFor = w.next_fire_at
}
```

   A decision that moves the journey (`elapsed`, `date_reached`, `goto`, `cancel`) also locks the instance and checks
   the visit in the same transaction, then calls `advanceIn` / `cancelInstanceIn` (4.3).
4. **due calls**: `callDue(ctx)` for outbound webhook calls (D6).

The projector applies `JourneyWaitReminded` / `JourneyWaitTimedOut` / `JourneyWaitResolved{reason:'elapsed'}` only
when `firedFor` equals the row's `next_fire_at` and the row is `open`. A second append for the same fire is a no-op,
also on replay. Side effects outside the transaction (desk notification push, runner commands) run after commit from
the committed events. A missed fire (the server was down for a day) fires once at the next tick. A reminder series that
fell behind sends one reminder and schedules the next from `now`, never a burst.

### D3. Timeout actions, date waits and the desk

Form and webhook waits (and gates with a deadline) have a deadline (`startedAt + duration`) and exactly one timeout action:

| Action | What happens at the deadline | Visible events |
|---|---|---|
| `remind` (`every?`, `maxReminders` 1..10, default 3, `afterLast: 'escalate' \| 'cancel'`, default escalate) | Form waits: the link is shown again on the desk (a new `journey_wait_link` item) or passed to the webhook step again (D8). The link is single-use, so the same link is shown while it is unused and unexpired; otherwise a new one is created and the old one revoked. Gates: the approver is notified again. Webhook waits: a note on the instance and to the desk addressee. The deadline moves on by `every` (default: the step's duration). After the last reminder, `afterLast` runs | `JourneyWaitTimedOut{action:'remind', n}`, `JourneyWaitReminded{n, of, nextFireAt}` |
| `goto` (`stepId`) | Ends the wait and enters the named step (D1) | `JourneyWaitTimedOut{action:'goto'}`, `JourneyStepCompleted{result:'skipped'}`, `JourneyStepEntered` |
| `escalate` (`to?`: a `JourneyApprover`, default the project owner) | The wait stays, state `escalated`. A desk item asks the addressee: **Extend** (by a duration), **Continue now** (`done`), **Go to step...**, **Cancel the journey** | `JourneyWaitTimedOut{action:'escalate'}`, `JourneyWaitEscalated{deskItemId, addresseeUserId}`, then the answer's event |
| `cancel` | Cancels the instance with `reason: 'wait_timeout'` (4.3). Open links are revoked | `JourneyWaitTimedOut{action:'cancel'}`, `JourneyInstanceCancelled{reason}` |

Escalation reaches the desk as a `QuestionRaised` with subkind `journey_wait_escalated`, `addresseeUserId`, the
instance and record in `data`, and `options` = the four answers. A dedicated endpoint (4.5) applies the answer and
checks it against the wait's state. `remind` with `afterLast: 'escalate'` is the default because it can never end
silently.

`duration` waits end at their end time with `JourneyWaitResolved{reason:'elapsed'}`.

**Date waits (revised).** GWP-66 records hold no dates and their references have no keys. So a `date` wait reads its
date from the **card of the most recent completed workflow step of this instance**, field `dateFrom.field`. The lookup
is the same as a handoff condition with `source: 'card'`: the card column first, then `card.fields`. Accepted values
are an ISO date or date-time. An offset and a time of day in the org time zone can be added. The wait ends at that
moment with `reason:'date_reached'`. A missing or invalid date, or no earlier workflow step, escalates at once
(`JourneyWaitEscalated{reason:'date_missing'}`) to the project owner. So **every** way out of a wait writes an event
shown on the instance.

### D4. Inbound webhook: where the payload is mapped

| | A. Relay to the runner, the runner verifies and maps | B. **Dedicated server route: verify the signature on the raw bytes, parse in memory, pick the mapped values, drop the rest (recommended)** |
|---|---|---|
| Journey start when the runner is offline | refused (503) | works |
| Payload stored or logged | no | no: only the mapped values reach the record |
| Where the verification secret lives | workstation | server, encrypted (D5) |
| Code | relay plus a new runner rpc and handler | one route plus pure mapping helpers |

**D4: B.** The relay stays a raw pass-through for runner-side integrations. A journey hook's job is to create or match a
record on the server, where the record lives. The payload is never written to a table, an event or a log line; sentinel
tests prove it (§6).

**Mapping (revised to the landed record).** A record has `record_type`, `external_id`, `display_name` and typed
references only. The mapping is therefore `{ externalId: '/pointer' (required), displayName?: '/pointer' }`. JSON Pointer
picks scalars only: external id ≤ 120 characters (the column limit), display name 1..200. Nothing else from the payload
can reach the record. Matching is on `(project_id, record_type, external_id)` within the trigger's journey's project,
active records only. Several matches → 422 `ambiguous_record`; there is no unique index, because manual starts may
already have made duplicates. A matched record with a running instance → 409 `record_busy`. No match: `on_no_match =
create` creates the record (display name falls back to the external id), `refuse` → 422 `no_record`.

**Who started it.** `JourneyInstanceStarted.startedBy` is a required user id, and GWP-66 refuses a step when the starter
is no longer a project member. A hook start uses the **trigger's creator** as `startedBy`, and `JourneyStartedByHook`
records the trigger. If that person leaves the project, the steps refuse with `not_member` on the desk, and someone
recreates the trigger. The panel says so.

### D5. Inbound signature scheme and secret

The trigger has a server-generated secret `jhsec_<32 random bytes base64url>`. It is shown once at create and at
rotate, encrypted with `AOM_SECRET_KEY` (`auth/secrets.ts`) in the event and the column, and never put in a DTO. **It is
not a firm credential**: Guildwise issues it, it authenticates calls *to* Guildwise only, and it grants no access to any
firm system. It is the same kind of secret as the schedule `whsec_` secret the server already keeps this way.

| Scheme | Header | Signed text | Replay protection |
|---|---|---|---|
| `guildwise` (default) | `X-Guildwise-Signature: sha256=<hex>`, `X-Guildwise-Timestamp: <unix s>` | `<timestamp>.<raw body>` | timestamp within ±300 s, plus the idempotency key |
| `body_sha256` (GitHub/Meta style senders) | `X-Hub-Signature-256: sha256=<hex>` or `X-Signature: sha256=<hex>` | raw body | idempotency key only (a warning in the UI) |

Verification: `timingSafeEqual` on equal-length buffers, before the body is parsed. Optional `Idempotency-Key` or
`X-Guildwise-Delivery` header (max 100 chars): its SHA-256 is kept for 24 h on the call row. A repeat answers 200 with
the first result and starts nothing.

### D6. Outbound webhook: who sends it, and are the secrets credentials

Header values such as `Authorization: Bearer <the firm's CRM key>` **are** firm credentials.

| | A. Server sends | B. **The firm's runner sends; credentials stay on the workstation (recommended)** | C. Split |
|---|---|---|---|
| Standing order 1800e58c | broken as soon as a header carries a key | kept | kept |
| Firm endpoints on the office network | unreachable | reachable | half |
| SSRF exposure of the hosted service | yes (guarded) | none | yes |
| Runner offline | works | the try fails as retryable and is retried | half |
| Code paths | 1 | 1 | 2 |

**D6: B**, as `delivery.send` already does for WhatsApp and Sheets. The server renders the body from record values and
the wait link (D8). The runner adds the credential headers and the optional signature from `secrets/webhooks.json`
(sealed, entered on the Integrations page as integration kind `webhook_credential`, instance = credential name). It
sends the call and answers with status, duration and an error text only. The response body is read and discarded. A
runner that does not answer by the command deadline counts as a failed, retryable try, so an offline runner shows as
"retrying", not as silence.

### D7. Gate approvers

`JourneyApproverSchema` = `org_owner`, `org_role{role: 'owner' | 'admin'}`, `project_owner`, `member{userId}`. There is
no `starter` and no `record_owner`: GWP-66 records have no owner. Only the named role or user may decide: the Owner and
Admins do **not** decide for a named user. The one exception is a named user who is no longer an active project member:
the gate falls back to the organization Owner and shows the fallback (`JourneyGateOpened{fellBack:true}`). A role gate
goes to every active holder (one desk item for the role, first decision wins, later attempts get 409 `gate_decided`).

A gate may have an optional deadline with the same timeout actions as a wait. Reject needs a note (required, max 2000).
GWP-66's generic Continue cannot pass a gate (409 `gate_needs_decision`).

### D8. Link delivery for wait-for-form (revised: owner decided, no e-mail)

The owner (CEO decision on this card) chose **no contact e-mail on the record**. `send.via` has two values:

| `send.via` | What happens |
|---|---|
| `desk` (default) | The link and its QR code show on the instance, and a desk task (subkind `journey_wait_link`) "Send this link to <record>" is raised with copy and share buttons, addressed to the project owner |
| `webhook` | The link is available as `{wait.link}` to the next `webhook_call` step, which the firm's runner sends (CRM, SMS) |

Reminders show the link again on a new desk task, or pass it to the webhook step again. They add no address. There is no
mail template. GWP-68 decides its own address mechanism; this card adds no contact field and the executor registry takes
a later `runner_offline` wait kind without other changes.

Link creation uses `createClientLinkIn(tx, ctx, { orgId, formId, by: instance.started_by, reference, recordKind:
record.record_type, recordId: record.id, expiresAt })` with `reference = (record.external_id ?? record.display_name)`
cut to 120. `expiresAt` = the last possible deadline (with reminders) + 1 day, capped at 90 days (GWP-65's limit).
An unpublished form refuses the step (`JourneyStepRefused{reason:'not_published'}`, stuck + alert, retried after the
alert is acknowledged). The link URL holds a signed token, so it is computed on read (as `toDto` does) and never stored
in an event or a column.

## 4. Design

### 4.1 Shared types (`packages/shared/src/journeys/steps-wait.ts`, exported from `journeys/index.ts`)

```ts
export const JourneyDurationSchema = z.object({
  amount: z.number().int().min(1).max(525_600),
  unit: z.enum(['minutes', 'hours', 'days', 'weeks']),
}); // total between 5 minutes and 365 days (refined)

export const JourneyApproverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('org_owner') }),
  z.object({ kind: z.literal('org_role'), role: z.enum(['owner', 'admin']) }),
  z.object({ kind: z.literal('project_owner') }),
  z.object({ kind: z.literal('member'), userId: z.uuid() }),
]);

export const WaitForSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duration') }),
  z.object({ kind: z.literal('date'), dateFrom: z.object({ field: z.string().min(1).max(100) }),
             offset: JourneySignedDurationSchema.optional(),
             atTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00') }),          // org time zone
  z.object({ kind: z.literal('form'), formId: z.uuid().nullable(),                    // null in a template until picked
             purpose: z.enum(['answers', 'upload']).default('answers'),
             send: z.object({ via: z.enum(['desk', 'webhook']) }).default({ via: 'desk' }) }),
  z.object({ kind: z.literal('webhook'), triggerId: z.uuid().nullable() }),           // a hook trigger with purpose 'resume'
  // GWP-68 adds { kind: 'runner_offline' } here; the executor registry (4.3) takes it without other changes.
]);

export const TimeoutActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('remind'), every: JourneyDurationSchema.optional(),
             maxReminders: z.number().int().min(1).max(10).default(3),
             afterLast: z.enum(['escalate', 'cancel']).default('escalate') }),
  z.object({ action: z.literal('goto'), stepId: StepIdSchema }),
  z.object({ action: z.literal('escalate'), to: JourneyApproverSchema.optional() }),
  z.object({ action: z.literal('cancel') }),
]);

const StepBase = { id: StepIdSchema, label: z.string().min(1).max(120), position: Position.optional() };

// Config is optional so GWP-66 placeholders and drafts still parse (journey_versions are re-parsed by loadDefinition);
// validation (not parsing) requires it, like workflowKey: null.
export const JourneyWaitStepSchema = z.object({ ...StepBase, kind: z.literal('wait'),
  waitFor: WaitForSchema.optional(),
  duration: JourneyDurationSchema.optional(),                   // required except for 'date'
  onTimeout: TimeoutActionSchema.optional(),                    // required for form | webhook; absent for duration | date
});
export const JourneyGateStepSchema = z.object({ ...StepBase, kind: z.literal('gate'),
  approver: JourneyApproverSchema.optional(), question: z.string().max(500).optional(),
  deadline: z.object({ duration: JourneyDurationSchema, onTimeout: TimeoutActionSchema }).optional(),
});
export const JourneyWebhookCallStepSchema = z.object({ ...StepBase, kind: z.literal('webhook_call'),
  workstationId: z.uuid().nullable().default(null),             // the runner that sends (holds the credentials)
  url: z.string().max(2000).default(''),                        // http(s), no user:pass; checked by validation
  method: z.enum(['POST', 'PUT', 'PATCH', 'GET', 'DELETE']).default('POST'),
  headers: z.array(z.object({ name: HeaderName, value: z.string().max(1000) })).max(20).default([]),   // plain, not secret
  credentialHeaders: z.array(z.object({ name: HeaderName, credential: CredName })).max(5).default([]), // value on the runner
  signWith: CredName.optional(),
  contentType: z.enum(['application/json', 'application/x-www-form-urlencoded', 'text/plain']).default('application/json'),
  body: z.string().max(20_000).default(''),
});
```

`schema.ts` changes: `JourneyStepSchema = z.discriminatedUnion('kind', [WorkflowStepSchema, JourneyWaitStepSchema,
JourneyGateStepSchema, JourneyWebhookCallStepSchema])`. `PlaceholderStepSchema` is removed, and its type users
(`templates.ts`) move to the new types. `JourneyHandoffSchema.on` becomes `z.enum(['done', 'cancelled', 'any', 'approved',
'rejected', 'failed']).default('done')`. Name the gate type `JourneyGateStep`, not `Gate`:
`packages/shared/src/delivery/gate.ts` already exports `Gate`. `resolve.ts`: `HandoffContext` gets `outcome?: 'approved'
| 'rejected' | 'failed'`, and the match rule is D1's.

Pure helpers (same file, unit tested):
- `durationMs(d)`, `deadlineOf(startedAt, d)`, `dateWaitFireAt(value, offset, atTime, timeZone)` (null on an invalid
  value).
- `timeoutDecision(wait, now) → { kind: 'elapsed' } | { kind: 'remind', n, nextFireAt } | { kind: 'goto', stepId } |
  { kind: 'escalate', to } | { kind: 'cancel' }` (covers `afterLast` and catch-up after downtime).
- `renderBodyTemplate(template, vars, contentType)`. Tokens use GWP-66's names: `{record.name}`, `{record.type}`,
  `{record.externalId}`, `{journey.name}`, `{instance.id}`, `{step.id}`, `{step.label}`, `{submission.id}` (the last
  form submission of the instance), `{wait.link}` (the open link of the previous form wait), `{now}`. Values are
  JSON-string-escaped for JSON (the template must be valid JSON after rendering, checked at save with sample values),
  and URL-encoded for form bodies. An unknown token is a validation error at save, never a silent empty string at run
  time.
- `readPointer(obj, pointer)` (RFC 6901) and `mapHookPayload(mapping, json) → { externalId, displayName? } | { error:
  'missing_match' | 'value_too_long' | 'not_scalar' }`.
- `validateJourneyWaitsAndGates(def, opts)`, called from `validateJourney` (errors unless stated):
  - unconfigured steps: `no_wait_config`, `no_form`, `no_trigger`, `no_approver`, `no_question`, `no_url`,
    `no_workstation`;
  - a wait needs a `done`/`any` handoff;
  - a gate needs handoffs for approved (`approved`/`done`/`any`) and rejected (`rejected`/`cancelled`/`any`); a missing
    reject handoff is a **warning** (the instance would get stuck);
  - a `webhook_call` needs `done` (a missing `failed` handoff is a warning);
  - `on` values must fit the from-step kind (D1);
  - `goto` targets an existing other step;
  - `onTimeout` is present exactly when required;
  - `{wait.link}` is only allowed in a webhook step reachable from a form wait with `send.via: 'webhook'`;
  - a form that is not published is a warning; `opts.publishedFormIds` is passed by the server.
- The `placeholder_cycle` rule becomes `server_step_cycle`: a loop with no workflow step is an error unless it contains a
  wait (`duration`, `date`, `form`, `webhook`) or a gate. A loop of `webhook_call` steps alone would call out without
  pause. The message is the same rule in plain words.

### 4.2 Data model (migration `apps/server/migrations/2840_journey_waits.sql`)

```sql
-- projection of JourneyWait* and JourneyGate* events (rebuilt from the log)
CREATE TABLE IF NOT EXISTS journey_waits (
  id uuid PRIMARY KEY,                       -- uuidv7, one per entry into a wait or gate step
  org_id uuid NOT NULL, project_id uuid NOT NULL,
  journey_id uuid NOT NULL, instance_id uuid NOT NULL, visit integer NOT NULL, step_id text NOT NULL,
  kind text NOT NULL,                        -- duration | date | form | webhook | gate | manual | (runner_offline: GWP-68)
  status text NOT NULL,                      -- open | escalated | resolved | timed_out | cancelled
  started_at timestamptz NOT NULL,
  deadline_at timestamptz,                   -- shown on the instance; NULL only for manual and a gate without deadline
  next_fire_at timestamptz,                  -- deadline or next reminder; the sweep key
  reminders_sent int NOT NULL DEFAULT 0,
  config jsonb NOT NULL,                     -- the step's waitFor / onTimeout / approver as entered (snapshot)
  link_id text,                              -- GWP-65 form_client_links.id (form waits)
  link_expires_at timestamptz,
  trigger_id uuid,                           -- webhook waits
  desk_item_id uuid,                         -- gate, escalation or link task
  approver_user_id uuid, approver_role text, fell_back boolean NOT NULL DEFAULT false,
  resolved_at timestamptz, resolution text,  -- elapsed | date_reached | form_submitted | webhook_received | approved | rejected | continued | goto | cancelled
  resolved_by uuid, submission_id uuid,
  UNIQUE (instance_id, visit)
);
CREATE INDEX IF NOT EXISTS journey_waits_due ON journey_waits (next_fire_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS journey_waits_link ON journey_waits (link_id) WHERE status IN ('open','escalated');
CREATE INDEX IF NOT EXISTS journey_waits_instance ON journey_waits (instance_id, started_at DESC);

-- projection of JourneyWebhookCall* events
CREATE TABLE IF NOT EXISTS journey_webhook_calls (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, instance_id uuid NOT NULL,
  visit integer NOT NULL, step_id text NOT NULL, workstation_id uuid NOT NULL,
  status text NOT NULL,                      -- pending | dispatched | ok | failed | cancelled
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz, command_id uuid, command_deadline timestamptz,
  last_http_status int, last_error text,     -- error text max 500, never a response body
  finished_at timestamptz,
  UNIQUE (instance_id, visit)
);
CREATE INDEX IF NOT EXISTS journey_webhook_calls_due ON journey_webhook_calls (next_attempt_at) WHERE status = 'pending';

-- projection of JourneyHookTrigger* events
CREATE TABLE IF NOT EXISTS journey_hook_triggers (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL, journey_id uuid NOT NULL,
  purpose text NOT NULL,                     -- start | resume
  name text NOT NULL, token_hash text NOT NULL UNIQUE,   -- sha256 of the URL token
  secret_enc text NOT NULL,                  -- jhsec_ encrypted with AOM_SECRET_KEY
  scheme text NOT NULL,                      -- guildwise | body_sha256
  mapping jsonb NOT NULL,                    -- { externalId: '/pointer', displayName?: '/pointer' }
  on_no_match text NOT NULL,                 -- create | refuse   (start only; resume always refuses)
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL, rotated_at timestamptz
);

-- operational (not event sourced; saved over a rebuild like relay call rows); metadata only, NO payload, NO IP
CREATE TABLE IF NOT EXISTS journey_hook_calls (
  id uuid PRIMARY KEY, trigger_id uuid, org_id uuid, at timestamptz NOT NULL,
  status int NOT NULL, outcome text NOT NULL, -- started | matched | resumed | duplicate | bad_signature | stale_timestamp | no_record | ambiguous_record | record_busy | invalid_payload | unsupported_type | too_large | rate_limited | disabled
  size_bytes int NOT NULL, latency_ms int NOT NULL,
  instance_id uuid, idempotency_hash text
);
CREATE INDEX IF NOT EXISTS journey_hook_calls_trigger ON journey_hook_calls (trigger_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS journey_hook_calls_idem ON journey_hook_calls (trigger_id, idempotency_hash)
  WHERE idempotency_hash IS NOT NULL;

-- hook matching on the landed record (no unique index: manual starts may have made duplicates)
CREATE INDEX IF NOT EXISTS journey_records_external ON journey_records (project_id, record_type, external_id)
  WHERE external_id IS NOT NULL;
```

Add `journey_waits`, `journey_webhook_calls` and `journey_hook_triggers` to `PROJECTION_TABLES`
(`projections/index.ts`), and add `journey_hook_calls` to `SAVED` (`projections/rebuild.ts`). The five-minute
maintenance tick deletes call rows older than 30 days and nulls `idempotency_hash` after 24 h. The run is identified by
`(instance_id, visit)`, GWP-66's key; there is no separate entry sequence.

Events (`packages/shared/src/events/journey-waits.ts`, registered in the events index). Wait, gate and call events go on
`journey-instance-<id>`; trigger events go on `journey-<journeyId>`. All use project scope. None carries payload content,
an address, a link token or a secret in clear text.

- `JourneyWaitStarted { waitId, instanceId, visit, stepId, kind, startedAt, deadlineAt?, nextFireAt?, config, linkId?, linkExpiresAt?, triggerId? }`
- `JourneyWaitLinkSent { waitId, linkId, via: 'desk' | 'webhook', expiresAt, deskItemId? }`
- `JourneyWaitTimedOut { waitId, firedFor, action, n? }`, `JourneyWaitReminded { waitId, n, of, nextFireAt, linkId? }`
- `JourneyWaitEscalated { waitId, deskItemId, addresseeUserId, reason: 'timeout' | 'date_missing' }`
- `JourneyWaitExtended { waitId, by, deadlineAt }`
- `JourneyWaitResolved { waitId, reason, by?, submissionId?, firedFor? }` / `JourneyWaitCancelled { waitId, reason }`
- `JourneyGateOpened { waitId, deskItemId, approverUserId?, approverRole?, fellBack }`, `JourneyGateDecided { waitId, decision: 'approved' | 'rejected', by, note? }`
- `JourneyWebhookCallStarted { callId, instanceId, visit, stepId, workstationId }`, `JourneyWebhookCallDispatched { callId, attempt, commandId, deadline }`, `JourneyWebhookCallAttempted { callId, attempt, ok, httpStatus?, error?, durationMs, nextAttemptAt? }`, `JourneyWebhookCallFinished { callId, ok, attempts, httpStatus? }`
- `JourneyHookTriggerCreated { triggerId, journeyId, orgId, projectId, purpose, name, tokenHash, secretEnc, scheme, mapping, onNoMatch, by }`, `...Updated`, `...Rotated { tokenHash, secretEnc }`, `...Disabled`
- `JourneyStartedByHook { triggerId, instanceId, recordId, recordMatched }` (next to GWP-66's `JourneyInstanceStarted`)

Changes to GWP-66 events in `events/journey.ts`. All are backward compatible, so old events still parse:

- `JourneyStepEntered.kind`: add `'webhook_call'`.
- `JourneyStepCompleted`: add `outcome?: 'approved' | 'rejected' | 'failed'`.
- `JourneyStepRefused.reason`: add `'not_published'`.
- `JourneyInstanceCancelled`: `by` becomes optional and `reason?: 'user' | 'wait_timeout' | 'gate_timeout' | 'escalation'` is added. The projector is unchanged.

### 4.3 Server modules (`apps/server/src/journeys/`)

| File | Content |
|---|---|
| `executors.ts` | Registry `{ wait: enterWaitStep, gate: enterGateStep, webhook_call: enterWebhookCallStep }`, signature `(ctx, tx, inst, def, run) => Promise<AppendInput[]>`; throws the runtime's `Refused` for refusals. GWP-68 adds its own kind here |
| `enter.ts` | `enterServerStep(ctx, instanceId, visit)` (D2 pass 1): lock, load, unconfigured → `manual` wait, else the executor, refusals as in `startStep` |
| `waits.ts` | `enterWaitStep` (deadline; form: `createClientLinkIn` + `JourneyWaitLinkSent` + link desk task for `desk`; date: `dateWaitFireAt` from the last workflow card, escalation on a missing date), `fireDueWaits(ctx)`, `resolveFormWait` (→ `JourneyWaitResolved{form_submitted, submissionId}`, `JourneyRecordReferenceAdded{kind:'form_submission', ref: submissionId, label: form name}`, `advanceIn(…, 'done')`), `extendWait`, `continueWait` (also used by GWP-66's Continue for a wait, and by GWP-68), `gotoFromWait`, `cancelWaitsIn(tx, ctx, inst)` (`JourneyWaitCancelled`, revokes an open link, marks a pending call cancelled) |
| `gates.ts` | `enterGateStep`, `resolveJourneyApprover(db, inst, approver)`, `mayDecideGate(db, user, wait)`, `decideGate(ctx, who, waitId, decision, note)`: locks the wait row and the instance (`waiting`, the wait's visit), then appends `JourneyGateDecided` + `advanceIn(…, approved ? 'done' : 'cancelled', null, outcome)` + desk item resolved, all in one transaction |
| `webhook-calls.ts` | `enterWebhookCallStep`, `callDue(ctx)` (`pending` rows due → `dispatchJourneyWebhook`, modelled on `dispatchToRunner`: an unanswered command past its deadline counts as a failed retryable try and is emptied), `applyJourneyWebhookResult` from the gateway, `recordCallAttempt` (`webhookBackoffMs`, `WEBHOOK_MAX_ATTEMPTS`, `isRetryableStatus`). The final result appends `JourneyWebhookCallFinished` and `advanceIn` with `done`, or `cancelled` + `outcome:'failed'` |
| `hooks/route.ts`, `hooks/signature.ts`, `hooks/triggers.ts` | Public route (4.4); `verifyHookSignature(scheme, secret, headers, raw, now) → 'ok' \| 'missing' \| 'bad' \| 'stale'`; create / update / rotate / disable; `startOrResumeFromHook(tx, ctx, trigger, mapped)` |
| `tick.ts` | `journeyTick(ctx)`: the four passes of D2. Called in `Scheduler.triggers()` right after `sweepJourneys` with its own `.catch(log)` |

Changes to GWP-66 and GWP-65 code. These are refactors; existing behaviour stays the same and keeps its tests:

- `commands/journey-runtime.ts`:
  - export `lockInstance`, `Refused` and `loadDefinition`;
  - rename `advance` to an exported `advanceIn(ctx, tx, inst, def, run, result, card, outcome?)` that passes `outcome`
    to `nextMove`;
  - `kindOf` returns the four kinds;
  - `continuePlaceholder` ends the run's open `manual` or configured wait with `JourneyWaitResolved{continued}` before
    advancing. A gate or webhook call answers 409 (`gate_needs_decision`, `call_running`), so every exit writes a wait
    event;
  - extract `cancelInstanceIn(tx, ctx, inst, by | null, reason)` from `cancelInstance`, which also calls
    `cancelWaitsIn`; `cancelInstance` calls it with `reason: 'user'`.
- `commands/journeys.ts`: extract `startInstanceIn(tx, ctx, { project, journey, def, record: { recordId } | { create },
  startedBy, actor })` from `startInstance` (validation, events); `startInstance` calls it unchanged.
  `validationFor` passes `publishedFormIds`.
- `commands/public-forms.ts`: extract `createClientLinkIn(tx, ctx, { orgId, formId, by, reference, recordKind?,
  recordId?, expiresAt })` (checks published, appends `FormClientLinkCreated`) and `revokeClientLinkIn(tx, ctx, { orgId,
  formId, linkId, by })`; the existing functions call them.
- `projections/journeys.ts`: no change needed (`webhook_call` is a non-workflow kind → `waiting`).
- The public form route and `FormSubmitted` are not touched: resolution is the sweep join on `used_by_submission`.

### 4.4 Inbound hook route (`apps/server/src/journeys/hooks/route.ts`, registered in `app.ts` next to `relayPublicRoutes`)

Registered without fastify-plugin, with `logLevel: 'silent'`. It calls `removeAllContentTypeParsers()` and adds one
raw-buffer parser with `bodyLimit = AOM_JOURNEY_HOOK_MAX_BYTES` (default 65 536). It has its own error handler with
empty bodies, and the token is redacted in `redactUrl` (`/hooks/in/…`). The route is not under `/api`, so the Origin
check does not apply (like `/relay/in`). Order:

1. `onRequest`: token format (`^[A-Za-z0-9_-]{32}$`, 24 random bytes) → hash lookup → empty 404 for an unknown or
   disabled trigger, an archived journey or a non-operational org (the same answer for all; no enumeration). Rate limits
   use `new KeyedBuckets(…)` from `public-forms/limits.ts`: `ip:<clientKey(ip)>` 120/min burst 60, `hook:<id>`
   `AOM_JOURNEY_HOOK_PER_MIN` 60, burst 30 → 429 + `Retry-After`. `content-type` must be `application/json` → 415.
2. `preHandler` (raw bytes in hand): signature (D5) → **401** for a missing, wrong or stale signature. Write a call row
   (`bad_signature`/`stale_timestamp`, size, latency) and one log line `{ hook: { triggerId, outcome } }`. Nothing of
   the body, the headers or the query is logged or stored.
3. Idempotency key → an existing row answers 200 with its first result.
4. `JSON.parse` → 400 `invalid_payload` on failure; `mapHookPayload` → 422 with a code only.
5. One `withAppendTx`.
   - Purpose `start`: match the record (D4). If none matches, `create` makes a `JourneyRecordCreated` and `refuse`
     answers 422. Then `startInstanceIn(…, startedBy: trigger.created_by, actor: system)` + `JourneyStartedByHook`.
     `startInstanceIn`'s `journey_invalid` → 409.
   - Purpose `resume`: the record must exist. Every `open`/`escalated` webhook wait on that record's running instance
     with `trigger_id = trigger` → `JourneyWaitResolved{webhook_received}` + `advanceIn`. Nothing open → 200 with
     `{ resumed: 0 }` (recorded, not an error).
6. Answer 202 `{ instanceId, recordId, matched }` (start) or 200 `{ resumed: n }`. The parsed object goes out of scope.

### 4.5 Authenticated API (`apps/server/src/routes/journey-waits.ts`, paths follow GWP-66's)

| Route | Who | What |
|---|---|---|
| `GET /api/journey-instances/:id/waits` | project members | the instance's waits and webhook calls with deadlines and history. GWP-66's instance DTO also gets `currentWait` and the link URL (computed on read) |
| `POST /api/journey-waits/:waitId/extend` `{ duration }` | project owner, org Owner/Admin, the escalation addressee | `JourneyWaitExtended` |
| `POST /api/journey-waits/:waitId/continue` | same | `JourneyWaitResolved{continued, by}`; also the "continue once the upload landed" action GWP-68 needs |
| `POST /api/journey-waits/:waitId/goto` `{ stepId }`, `POST …/cancel` | same | timeout answers from the desk |
| `POST /api/journey-waits/:waitId/resend-link` | same | issues a new link (revokes the old) and shows or passes it on; `JourneyWaitLinkSent` |
| `POST /api/journey-gates/:waitId/decide` `{ decision, note? }` | `mayDecideGate` only | 403 `not_approver`, 409 `gate_decided`, 400 `note_required` on reject |
| `GET/POST /api/journeys/:id/hooks`, `PATCH /api/journeys/:id/hooks/:hookId`, `POST …/rotate` | org Owner/Admin and the project owner | create returns `{ url, secret }` once; the list never returns the secret |

The existing `POST /api/journey-instances/:id/continue` keeps working for waits (through `continueWait`) and answers 409
for gates and calls (4.3).

### 4.6 Runner (`apps/runner/src/outbound-delivery/journey-webhook.ts`)

- Command `journey.webhook.call`. The shared `JourneyWebhookCallPayloadSchema` goes in
  `packages/shared/src/protocol/runner.ts`: `callId, attempt, url, method, headers[], credentialHeaders[{ name,
  credential }], signWith?, contentType, body`. The result is `DeliverySendResultSchema`. The command is terminal and
  never re-sent blindly; the server empties the payload on the answer or at expiry. Capability `journey-webhook:1`: the
  designer only offers workstations that announce it.
- `fetch` with `redirect: 'manual'`, a 10 s timeout and these headers: `user-agent: GuildwiseHQ-Journey/1`,
  `x-guildwise-delivery: <callId>`, `x-guildwise-timestamp`, and `x-guildwise-signature` (signed with `signWith`'s
  secret over `<ts>.<body>`). The response body is drained and discarded. The log line has the call id, status and
  duration only. Credential values are registered with the redaction registry.
- Credentials: `secrets/webhooks.json` (`SealedFile`, `{ credentials: { <name>: { value } } }`) and the integration
  adapter `apps/runner/src/integrations/webhook-credential.ts`. It adds kind `webhook_credential` to
  `INTEGRATION_KIND_IDS`, with scope `workstation` and instances = names. Connect and remove go through the sealed
  envelope; `status` = present or not.
- Private addresses are allowed from the runner. The server-side check covers only the scheme and no credentials in the
  URL.

### 4.7 Web

| File | Content |
|---|---|
| `apps/web/src/components/journeys/StepEditor.tsx` | Remove the "Coming with waits and gates" badge; render the config component by `step.kind`; the step palette in `JourneyDesigner.tsx` gets "Webhook call"; the handoff editor offers the `on` values valid for the from-step (D1) |
| `apps/web/src/components/journeys/WaitStepConfig.tsx` | "Wait for": Time / Date from the last step's card / Form / Document upload / Webhook event (big radio cards). Duration as number + unit (`inputMode="numeric"`). Timeout action as a radio list with its options inline. A live sentence: "Waits up to 5 days. If nothing arrives: reminds 3 times every 5 days, then asks the project owner on the desk." Form waits: the form picker (published forms; unpublished forms marked) and "Send by: desk / webhook step" |
| `GateStepConfig.tsx` | Approver (person, role, project owner, org owner), question text, optional deadline; warns when the reject handoff is missing |
| `WebhookCallStepConfig.tsx` | Workstation, method, URL (`type="url"`, `inputMode="url"`, `autoCapitalize="off"`, `spellCheck={false}`), plain headers, credential headers (names from the workstation's `webhook_credential` instances, with a link to Integrations), body template with a token picker and a preview from a sample record |
| `HookTriggerPanel.tsx` | In the journey designer's settings: name, purpose, mapping (external id and display name pointers, with a "paste a sample payload" helper that runs only in the browser), scheme, on-no-match. After create: a one-time panel with the URL and secret, copy buttons, a `curl` example and the signature recipe. Recent calls (time, outcome, status, size). A note that the journey starts in the creator's name |
| `InstanceWaitPanel.tsx` | On `pages/JourneyInstance.tsx`: the current wait with kind, what it waits for, start, **deadline** (absolute in the user's time zone and relative), reminders "1 of 3", the link (URL, QR, copy/share, expiry, resend), call attempts and the final result. Actions Extend / Continue now (permission-gated) replace the generic Continue for configured waits; gates show "Waiting for <approver>". `InstanceHistory.tsx` gets timeline entries for every `JourneyWait*`, `JourneyGate*`, `JourneyWebhookCall*` event |
| `JourneyGateDeskItem.tsx`, `JourneyEscalationDeskItem.tsx`, `JourneyWaitLinkDeskItem.tsx` | Desk items with the same layout rules as `ApprovalDeskItem`: link to the instance, note field (required on reject), `sticky-actions` with full-width buttons on small screens, link copy/share (Web Share API where available). Registered by subkind in `pages/Desk.tsx` |
| `apps/web/src/api/queries/journey-waits.ts` | React Query hooks |

All devices: every control is reachable by touch with targets of at least 44 px. The sticky action bar stays above the
soft keyboard (the note field is the only field typed into on the desk). The deadline text wraps on narrow screens.
There is no hover-only information.

### 4.8 Configuration (`apps/server/src/config.ts`, documented in `docs/SELF-HOSTING.md`)

`AOM_JOURNEY_HOOK_MAX_BYTES` (65 536), `AOM_JOURNEY_HOOK_PER_MIN` (60), `AOM_JOURNEY_HOOK_BURST` (30),
`AOM_JOURNEY_HOOK_TOLERANCE_SEC` (300).

### 4.9 Docs and CHANGELOG

- `CHANGELOG.md`: under the existing `## [1.5.0]` heading, `### Added`: "Journey waits, gates and webhooks: wait steps
  for a time, a date from the previous step, a form or document upload through a personal link (handed to you on the
  desk or to your own system through a webhook step), or a webhook event. Each wait has a deadline shown on the journey
  and one timeout action (remind and keep waiting, go to a step, ask on the desk, cancel). Approval gates on the desk
  where approve and reject follow their own handoffs. Journeys that start from a signed webhook on a new or matched
  record. Webhook steps sent by your workstation with its own stored credentials, retried with backoff. Migration 2840;
  new runner command `journey.webhook.call`; new optional environment variables `AOM_JOURNEY_HOOK_*`." Name the
  migration number actually used.
- `docs/ARCHITECTURE.md` section 10: a subsection "Journey waits and webhook calls" (the passes, fire-once, the hook
  route).
- `docs/RUNNER.md`: `journey.webhook.call` and `secrets/webhooks.json`.
- User guide and videos: GWP-70.

## 5. Acceptance criteria → design → tests

All tests go in **new** files. No file under `e2e/**`. Existing GWP-66 tests (`packages/shared/src/journeys/journeys.test.ts`
and the server journey tests) must keep passing after the refactors; name any one that has to change in the handoff.

| AC | Design | Tests |
|---|---|---|
| 1. Wait configured with what, duration, one timeout action; instance shows the wait and deadline | 4.1 schemas + validation, 4.2 `deadline_at`, 4.7 | `packages/shared/test/journey-waits.test.ts` (schema incl. old placeholder still parses, validation rules, `on` per kind, `server_step_cycle`, `deadlineOf`, `dateWaitFireAt` across DST, `resolveHandoff` with outcome); `apps/web/src/test/journey-wait-config.test.tsx`; `apps/web/src/test/journey-instance-wait.test.tsx` (deadline absolute + relative) |
| 2. Timeout runs the chosen action and an event shows (desk for escalate); no silent end | D3, `timeoutDecision`, `fireDueWaits` | shared: `timeoutDecision` for each action, `afterLast`, catch-up (fake clock); `apps/server/test/journey-wait-timeouts.test.ts`: each action end to end with the test clock and `scheduler.run()`; escalate creates the `journey_wait_escalated` item for the right addressee; date wait with a missing card field escalates; GWP-66 Continue on a wait writes `JourneyWaitResolved{continued}`; invariant: every wait leaving `open` has a resolved/timed-out/cancelled event |
| 3. Wait-for-form sends a per-client link and resumes when the submission is stored | D8, `enterWaitStep`, `resolveFormWait` | `apps/server/test/journey-wait-form.test.ts`, using the GWP-65 test harness, the mock runner and the local-folder connector. Checks: the link is bound to the record (`record_kind`, `record_id`); `JourneyWaitLinkSent` + desk task; submit → the answers file is in the folder → the run is `done` and the record has a `form_submission` reference; a failed storage write does **not** resume; another record's link does not resume; an unpublished form refuses the step with an alert |
| 4. Gate on desk; approve → next handoff, reject → reject handoff | D7, `gates.ts` | `apps/server/test/journey-gates.test.ts`: approve; reject with a note; reject without a note → 400; a non-approver → 403, including an Admin for a named user; role gate, first decision wins; fallback to the Owner when the named user left; generic Continue → 409; a legacy `done`/`cancelled` handoff from a gate works. Also `apps/web/src/test/journey-gate-desk-item.test.tsx` |
| 5. Valid signature starts a journey on a new or matched record; invalid → 401, logged without payload | D4, D5, 4.4 | `apps/server/test/journey-hook-signature.test.ts` (both schemes, stale, length mismatch). `apps/server/test/journey-hook-route.test.ts`: start new, start matched by external id, `ambiguous_record`, `record_busy`, `no_record`, resume, duplicate idempotency key, 415, 413, 429, 404; the instance's `started_by` is the trigger creator. A **no-content test** copied from `relay-no-content.test.ts`: a sentinel string in the payload and headers, then every table dumped with `SELECT t::text` and the captured logs searched; the sentinel appears nowhere except in a value the mapping picked |
| 6. Outbound webhook calls the URL, retries with backoff, final result on the instance | D6, 4.3, 4.6 | `apps/server/test/journey-webhook-calls.test.ts`: dispatch, answer, retry schedule 1/5/30/120 min with the test clock, 4xx final, offline runner retryable, `failed` handoff, stuck + alert without one. `apps/runner/test/journey-webhook-call.test.ts` against a local HTTP server that fails twice then answers 200 (headers, signature, credential header from the sealed store, redirect not followed, value never in the log). Shared `renderBodyTemplate` tests (escaping, unknown token, `{wait.link}`) |
| 7. Timer set before a restart fires once after it | D2 | `apps/server/test/journey-timer-restart.test.ts`: start a wait, stop the app and scheduler, build a new app on the same database, move the clock past the deadline, run the tick twice and two ticks concurrently → exactly one `JourneyWaitTimedOut`; a projection rebuild gives the same `journey_waits` row |
| 8. CHANGELOG 1.5.0 entry | 4.9 | the existing changelog test keeps passing; the reviewer checks the entry |

Rentals template (`packages/shared/src/journeys/templates.ts`). The builder extends `build()` so a spec can carry step
config, then sets:
- `wait_documents` → `{ kind: 'wait', waitFor: { kind: 'form', formId: null, purpose: 'upload', send: { via: 'desk' } },
  duration: 5 days, onTimeout: { action: 'remind', maxReminders: 2, afterLast: 'escalate' } }`. The user picks the form;
  until then the template shows the `no_form` error, the same way it shows `no_workflow`.
- `approval` → `{ kind: 'gate', approver: { kind: 'project_owner' }, question: 'Approve this application?' }`, with a
  handoff `{ from: 'approval', on: 'rejected', to: 'end', label: 'Application declined' }` placed before its `done`
  handoff.
- The template description drops "placeholders until waits and gates are available".

Test plan item 4 (manual on UAT) is for the testers.

## 6. Security notes

- The hook route follows the GWP-65 / relay hardening: rate limits per IP and per trigger, the signature checked before
  parsing, silent logging, empty error bodies, a size limit before reading, no enumeration, and the token redacted from
  URLs in logs.
- Payloads are never persisted. Only the external id and display name chosen by the mapping reach the record.
- Firm credentials for outbound calls never reach the server (sealed envelope to the runner). The inbound verification
  secret is a Guildwise-issued secret encrypted at rest (D5).
- Link tokens are never stored: the URL is signed on read. When the link is passed to a webhook step, it is only in the
  runner command payload, which is emptied after the answer.
- No contact e-mail or other personal data is added to the record (D8).
- Gate decisions are checked server-side against the wait's approver. Desk items for a role are only visible to its
  holders.
- Client links are revoked when a journey is cancelled or the wait ends another way.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Refactors of GWP-66/GWP-65 functions (`advance`, `cancelInstance`, `startInstance`, `createClientLink`) break existing behaviour | Extract-only refactors; the existing callers keep their signatures; existing tests must pass unchanged |
| Old journey versions and events from GWP-66 (placeholders, `JourneyInstanceCancelled.by`) | All schema changes are additive or make fields optional; unconfigured placeholders in running instances become `manual` waits |
| A hook-started journey depends on the trigger creator staying a member | Shown in the panel; GWP-66's `not_member` refusal reaches the desk |
| Duplicate external ids from manual starts | 422 `ambiguous_record`, visible in the trigger's recent calls |
| Outbound calls fail while the runner is offline | Retries over about 2.5 h show as "retrying"; a final failure shows on the instance and the desk |
| Hosted ingress for `/hooks/in/*` | GWP-69 |
| Per-process rate buckets with several server instances | Same accepted limitation as public forms and the relay |

## 8. Assumptions about dependencies (original list)

1. GWP-66 definition = steps discriminated by kind + handoffs `{from, outcome, to, condition?}` validated by
   `validateJourney`.
2. GWP-66 instances advance through a server reactor over the event log with step-entered / step-completed(outcome)
   events and a complete-step function.
3. GWP-66 records have org, kind, id, display name, references and can be matched by an external reference.
4. GWP-66 instances have a project scope and a cancel path with a reason.
5. GWP-66 records expose dates by key.
6. The rentals template has placeholder wait and gate steps this card replaces.
7. GWP-65 has a transactional create/revoke client link function, and `FormSubmitted` carries `linkId` and is emitted
   only when everything is stored.
8. GWP-65's `KeyedBuckets` is reusable.
9. The owner allows one contact e-mail per record.

## 9. Assumption review against the landed code (2026-11-04)

| # | Held? | What the code has | What changed in this design |
|---|---|---|---|
| 1 | **No, partly** | Discriminated union and `validateJourney` exist. Wait/gate are already unconfigured placeholder kinds. Handoffs use `on: done \| cancelled \| any`, not an outcome id. Step ids are slugs | Configured `wait`/`gate` replace the placeholder variant with optional config (old versions parse; validation requires config). `on` gets `approved/rejected/failed`; `JourneyStepCompleted.outcome`; outcome→result mapping (D1); `server_step_cycle` replaces `placeholder_cycle` |
| 2 | **No** | No reactor or cursor: a state-table sweep (`sweepJourneys`) with instance locks; `advance` is private; non-workflow steps project to `waiting` | Four passes in `journeyTick` after `sweepJourneys` (D2); `enterServerStep` + executor registry; `advanceIn` exported with an outcome; form waits resolve by joining `form_client_links.used_by_submission`; GWP-66's Continue routes through the wait. Run key is `(instance_id, visit)`, not `entry_seq` |
| 3 | **No, partly** | Records are project-scoped, with `record_type`, `external_id`, `display_name` and typed references with no keys. There is no index on `external_id`, and `startedBy` is a required user | Match on `(project_id, record_type, external_id)` with a non-unique index; `ambiguous_record` and `record_busy`; the mapping is only external id + display name; `startInstanceIn` extracted; `startedBy` = trigger creator; template tokens use GWP-66's names |
| 4 | **No, partly** | Project scope: yes. Cancel exists but has no reason and requires a user | `JourneyInstanceCancelled.by` becomes optional and gets a `reason`; `cancelInstanceIn` is extracted and also ends open waits and links. "Blocked" becomes GWP-66's `stuck` + `journey_step_refused` alert, so there is no `journey_step_failed` subkind |
| 5 | **No** | Records hold no dates, and references have no keys (so the planned fallback does not work either) | Date waits read a date field from the card of the last completed workflow step; missing → escalate (D3) |
| 6 | Yes | `wait_documents` and `approval` placeholders in the rentals template | The builder configures them as in §5 (form id left for the user, reject → end) |
| 7 | **No, partly** | `FormSubmitted` carries `linkId` and is appended only on `complete`: yes. Links are single-use. `createClientLink`/`revokeClientLink` open their own transaction and need a user | Extract `createClientLinkIn` / `revokeClientLinkIn`; `by` = instance starter; expiry capped at 90 days; the step is refused (`not_published`) for an unpublished form; reminders reuse an unused link |
| 8 | Yes | `KeyedBuckets(perMinute, burst, now)` and `clientKey` | The hook route creates its own buckets |
| 9 | **No** | The owner decided: no contact e-mail on the record | `send.via` is `desk \| webhook`; no mail template; the link desk task is subkind `journey_wait_link` (D8) |
