# Journeys: model, designer and runtime (design)

Release 1.5.0. Scope: the journey definition, the shared record, instances and their runtime, playbooks in steps, the rentals
template, the journeys page. Waits, gates and webhooks are a later change that builds on this one; forms, storage and the
runner-offline flow are out of scope.

## 1. The question

A journey is one organisational process from trigger to outcome: existing workflows (the workflow builder's) linked by
handoffs, all working on one shared record (a client, matter or deal). We need:

1. a definition model (steps = workflows, handoffs with an optional condition, loops allowed), stored with a migration;
2. a designer to build, save and reopen it unchanged;
3. a record that holds only status, step, timestamps and references (never answers or document content);
4. instances started by hand on a record, that move along handoffs when a step's workflow completes, idempotently and
   safely across a server restart;
5. a playbook that can be used inside a step without changing the playbook feature;
6. a rentals template whose wait and gate steps are placeholders for now;
7. a journeys page with journeys and running instances, filtered by step and status.

## 2. Findings in the code

- **A workflow runs as a card.** `WorkflowDefinition` (`packages/shared/src/workflows/schema.ts`) is a stage graph; a
  card in a project runs one workflow version. A card has ended when `cards.status` is `done` or `cancelled`.
  So "a journey step runs a workflow" means "the step creates a card in that workflow, and the step completes when the
  card ends".
- **The server already does exactly this for sub-workflows.** `apps/server/src/commands/subworkflows.ts` creates a child
  card with `createCardIn(ctx, tx, user, req, { origin: 'subworkflow', actor: SYSTEM_ACTOR, parentCardId })` and
  resolves the waiting parent when the child is `done`/`cancelled`. It is driven by a reactor (`sweepSubworkflows`,
  called from `Scheduler.triggers()` in `apps/server/src/scheduler/scheduler.ts`) under `withAppendTx` with
  `SELECT ... FOR UPDATE` row locks, a dedupe key per run (`subworkflow_runs`, migration `1720_subworkflows.sql`) and a
  projection (`apps/server/src/projections/subworkflows.ts`). It also shows the refusal pattern (event + card message +
  blocking desk alert, `DESK_SUBKIND.subworkflowRefused`). Journeys reuse this pattern; they do **not** reuse sub-workflow
  stages, because a journey is not a card and its record must not become a card.
- **Field lookups on a card** already exist: `readField`/`outcomeApplies` in `packages/shared/src/workflows/resolve.ts`
  (card column first, then `card.fields`) and `workflowView(card)` in `apps/server/src/commands/cards.ts`.
- **Playbooks** (`packages/shared/src/playbooks/index.ts`, `apps/server/src/sessions/playbooks.ts`): a person starts a
  guided session with `runPlaybookSession(ctx, who, { key, title, input, projectId, workstationId })`, which checks the
  key is a runnable, visible playbook and creates a Discovery session (`/discovery/<threadId>`). The web has
  `useSlashCommands` and `useRunPlaybook` (`apps/web/src/api/queries/playbooks.ts`). Calling `runPlaybookSession` as it is
  from a journey command runs a playbook in a step with no change to playbooks.
- **Event sourcing rules** (CLAUDE.md): behaviour changes through new events; projections must be replay-safe; schema
  changes are a new numbered migration (latest on main: `2801_deploy_target_computer_removed.sql`). Events are defined
  per domain in `packages/shared/src/events/*.ts` and registered in `events/index.ts`; stream ids in
  `packages/shared/src/ids.ts`; projectors registered in `apps/server/src/projections/index.ts`.
- **Card origins** are a zod enum (`CardOrigin`, `packages/shared/src/cards/types.ts`) mirrored by the
  `cards_origin_check` constraint (last changed in `1720_subworkflows.sql`). A journey card needs origin `journey`.
- **The six business workflows** (`business-enquiry`, `-follow-up`, `-document-request`, `-reminder`, `-report`,
  `-quote`; `packages/shared/src/workflows/business.ts`) are built in and enabled on every project. They are the natural
  default workflows of the rentals template, so it is usable without first building custom workflows.
- **Web**: routes in `apps/web/src/router.tsx`; the navigation in `apps/web/src/components/shell/nav-config.ts` (the
  "work" group has Automations and Projects); query hooks per domain in `apps/web/src/api/queries/*.ts`; the workflow
  template gallery `components/builder/TemplateGallery.tsx` is the model for a journey template gallery.
  `useWorkflows` (`api/queries/agents.ts`) has many importers: do not change it. The designer's workflow picker uses
  `useProjectWorkflows(projectId)` (`api/queries/project-workflows.ts`), which lists the workflows enabled in a project.

## 3. Options compared

### 3.1 How a step runs a workflow

| Option | For | Against |
|---|---|---|
| A. A journey is a generated workflow with `subworkflow` stages | Reuses everything | The record becomes a card with fields (client content creeps in); loops and conditions on handoffs fight the stage model; changes the workflow feature |
| **B. A journey is its own object; each step creates a card (origin `journey`) like a sub-workflow child** | Workflows unchanged; the record stays a thin reference object; handoff conditions and loops are ours | A second reactor (small, copies a proven pattern) |

**B.**

### 3.2 Where state lives and how transitions stay idempotent across restarts

| Option | For | Against |
|---|---|---|
| A. Event-log cursor (like `workflow_reactor_cursor`) | Proven | State is "where the cursor is"; a skipped event after 5 failures loses a transition |
| **B. State-table driven sweep: projected `journey_step_runs` rows say what is pending; each tick handles `pending` runs and `open` runs whose card has ended** | Restart-safe by construction (state is durable before any side effect); no cursor; a failed attempt is simply retried | One indexed query per tick (partial indexes keep it cheap) |

**B**, with every transition done under `withAppendTx` + `FOR UPDATE` on the instance row and guarded by an expected
`visit` number (see 5.4).

### 3.3 Playbook in a step

| Option | For | Against |
|---|---|---|
| A. A new step kind "playbook" that completes when the guided session ends | | Discovery sessions have no reliable "done" signal for a journey; would need changes in sessions |
| **B. A workflow step may carry a playbook reference; at that step the user starts it (existing `runPlaybookSession`), the session id is stored as a reference on the step and the record** | No change to playbooks; matches "an agent helps a user process a step"; the step still completes through its workflow card | The playbook is an assist, not the step's completion |
| C. Auto-start the playbook on entering the step | No click | A guided session needs a person and a workstation; starting sessions nobody asked for floods the desk |

**B** (manual start). Auto-start can be added later as an option.

### 3.4 Handoff conditions and loops

Conditions are evaluated by the server only (never by an agent), in shared pure code so the designer can explain them and
the tests can drive them. A condition reads the **ended card of the step** (its fields, through the existing `readField`
lookup) or the **record's own metadata** (type, status, visits of the step). Loops are allowed; each visit of a workflow
step creates a new card, so a loop can never spin without work. Bounds: at most `MAX_STEP_VISITS = 240` visits of one
step (twenty years of monthly rent) and `MAX_INSTANCE_VISITS = 1000` per instance; past either, the instance becomes
`stuck` with a desk alert. Validation refuses a cycle made only of placeholder steps (it could not move anyway, but it is a
design error).

## 4. Recommendation

Journeys as a new object (option 3.1 B) with a state-table driven runtime (3.2 B), playbooks referenced on workflow steps
and started by a person through the existing playbook API (3.3 B), and conditions over the ended card and record metadata
(3.4). Definitions are versioned; an instance pins the version it started on. Wait and gate steps exist in the model as
`placeholder` kinds that render and stop the instance at that step with a "Continue past this step" action until the
waits and gates change activates them.

## 5. Design

### 5.1 Shared model: `packages/shared/src/journeys/` (new; export from `packages/shared/src/index.ts`)

`schema.ts`

```ts
export const RECORD_TYPES = ['client', 'matter', 'deal'] as const;
export const JourneyRecordTypeSchema = z.enum(RECORD_TYPES);

const StepId = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);

export const JourneyConditionSchema = z.object({
  /** `card`: a field of the card the step just ended with (column first, then card.fields). `record`: type | status | visits. */
  source: z.enum(['card', 'record']),
  field: z.string().min(1).max(100),
  op: z.enum(['equals', 'not_equals', 'is_set', 'is_not_set', 'lt', 'gte']),
  value: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
});

export const JourneyStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workflow'),
    id: StepId, label: z.string().min(1).max(120),
    workflowKey: z.string().min(1).nullable(),          // null in a template until the user picks one
    cardType: z.string().optional(),
    /** Card title and field text from the record: `{record.name}`, `{record.type}`, `{record.externalId}`, `{step.label}`. */
    fieldsIn: z.array(z.object({ to: z.string().min(1), template: z.string().max(500) })).max(20).default([]),
    playbook: z.object({ key: z.string().min(1).max(130), name: z.string().max(200) }).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),   // designer layout only
  }),
  z.object({
    kind: z.enum(['wait', 'gate']),                     // placeholders in this release; config added later (optional fields)
    id: StepId, label: z.string().min(1).max(120),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
]);

export const JourneyHandoffSchema = z.object({
  id: StepId,
  from: StepId,
  /** The result of the from-step: its card finished (`done`) or was cancelled. Placeholders end with `done`. */
  on: z.enum(['done', 'cancelled', 'any']).default('done'),
  /** A step id (may equal `from` or an earlier step: a loop) or `end` (the instance completes). `end` is reserved. */
  to: z.union([StepId, z.literal('end')]),
  condition: JourneyConditionSchema.optional(),
  label: z.string().max(120).optional(),
});

export const JourneyDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  recordType: JourneyRecordTypeSchema,
  firstStepId: StepId,
  steps: z.array(JourneyStepSchema).min(1).max(50),
  /** Order matters: for one from-step the first handoff whose `on` and condition match is taken. */
  handoffs: z.array(JourneyHandoffSchema).max(200).default([]),
});
```

`validate.ts`: `validateJourney(def, { enabledWorkflowKeys?, playbookKeys? }) -> { errors, warnings }` with stable codes:
duplicate step/handoff id, a step with the reserved id `end`, unknown `firstStepId`/`from`/`to`, a step not reachable from the first step (warning), a
workflow step without `workflowKey` (error for start, allowed when saving a draft), a workflow not enabled in the
journey's project (error for start), an unknown playbook (warning), a cycle through placeholders only (error), a condition
on an unknown record field (error). Saving is allowed with errors marked "draft"; **starting** an instance requires zero
errors (server re-validates with the project's enabled workflows).

`resolve.ts` (pure, the heart of the unit tests):

```ts
export interface HandoffContext {
  result: 'done' | 'cancelled';
  card: WorkflowCardView | null;                 // the ended card of a workflow step; null for a placeholder
  record: { type: JourneyRecordType; status: JourneyRecordStatus };
  visits: number;                                // visits of the from-step including this one
}
export function conditionHolds(c: JourneyCondition, ctx: HandoffContext): boolean;
/** First handoff from `stepId` whose `on` matches `ctx.result` and whose condition holds; null: none. */
export function resolveHandoff(def: JourneyDefinition, stepId: string, ctx: HandoffContext): JourneyHandoff | null;
/** What happens after a step ends: next step, end (no handoff leaves the step), or stuck (handoffs exist, none match). */
export function nextMove(def, stepId, ctx): { kind: 'next'; handoff } | { kind: 'end' } | { kind: 'stuck'; reason };
export const MAX_STEP_VISITS = 240, MAX_INSTANCE_VISITS = 1000;
```

Semantics: a step with **no** outgoing handoffs is an end step: the instance completes. A step **with** handoffs where
none matches puts the instance in `stuck` (desk alert, never silent). `is_set`/`is_not_set` treat `null`, `undefined`
and `''` as not set; a missing boolean counts as `false` (same rule as `outcomeApplies`).

`record.ts`: the record and reference DTOs, **strict** (`.strict()`) so unknown keys are refused:

```ts
export const JourneyRecordStatusSchema = z.enum(['active', 'closed']);
export const JourneyReferenceKindSchema = z.enum(['document', 'form_submission', 'card', 'playbook_session']);
export const JourneyReferenceSchema = z.object({
  kind: JourneyReferenceKindSchema,
  /** An id or a URI into the firm's own storage (`onedrive:...`, `s3://...`, `runner://...`); never content. */
  ref: z.string().min(1).max(500).regex(/^\S+$/),
  label: z.string().max(200).optional(),          // a file or form name, never its content
  addedAt: IsoDate,
}).strict();
export const JourneyRecordDtoSchema = z.object({
  id, orgId, projectId, type: JourneyRecordTypeSchema,
  externalId: z.string().max(120).nullable(),     // the firm's own id for the client/matter/deal
  displayName: z.string().min(1).max(200),
  status: JourneyRecordStatusSchema,
  currentInstanceId: z.uuid().nullable(), currentStepId: z.string().nullable(),
  createdAt, updatedAt,
  references: z.array(JourneyReferenceSchema),
}).strict();
export const RECORD_KEYS = [...] as const;        // the allow-list the "no content" test checks
```

`templates.ts`: `JOURNEY_TEMPLATES: JourneyTemplate[]` with `{ id, name, description, definition }`; the rentals template
is in 5.7. `dto.ts`: API request/response schemas (5.5).

### 5.2 Events (`packages/shared/src/events/journey.ts`, registered in `events/index.ts`)

Streams (add to `streamId`): `journey(id)` = `journey-<id>`, `journeyInstance(id)` = `journey-instance-<id>`,
`journeyRecord(id)` = `journey-record-<id>`. Scope: project scope of the journey's project.

| Event | Payload |
|---|---|
| `JourneySaved` | `journeyId, orgId, projectId, version, definition` (full `JourneyDefinition`) |
| `JourneyArchived` | `journeyId` |
| `JourneyRecordCreated` | `recordId, orgId, projectId, recordType, externalId?, displayName` |
| `JourneyRecordReferenceAdded` | `recordId, kind, ref, label?` |
| `JourneyRecordClosed` | `recordId` |
| `JourneyInstanceStarted` | `instanceId, journeyId, version, recordId, startedBy` |
| `JourneyStepEntered` | `instanceId, visit, stepId, fromVisit?, handoffId?` |
| `JourneyStepCardStarted` | `instanceId, visit, cardId, workflowKey, workflowVersion` |
| `JourneyStepRefused` | `instanceId, visit, reason ('not_enabled','not_found','not_member','invalid_mapping','visit_limit'), detail` |
| `JourneyStepCompleted` | `instanceId, visit, result ('done','cancelled','skipped'), cardId?` |
| `JourneyStepPlaybookStarted` | `instanceId, visit, playbookKey, threadId` |
| `JourneyInstanceStuck` | `instanceId, visit, reason` |
| `JourneyInstanceCompleted` | `instanceId, visit` |
| `JourneyInstanceCancelled` | `instanceId, by` |

No event carries a form answer or document content: only ids, keys, labels, the display name and the firm's external id.

### 5.3 Database: `apps/server/migrations/2810_journeys.sql` (next free number at merge time)

```sql
ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_origin_check;
ALTER TABLE cards ADD CONSTRAINT cards_origin_check CHECK (origin IN (
  'manual','intake','schedule','test_failure','full_suite','regression','interest','subworkflow','trigger','email','journey'));

CREATE TABLE journeys (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES orgs(id), project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL, record_type text NOT NULL CHECK (record_type IN ('client','matter','deal')),
  current_version integer NOT NULL, status text NOT NULL CHECK (status IN ('active','archived')),
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE journey_versions (
  journey_id uuid NOT NULL REFERENCES journeys(id), version integer NOT NULL,
  definition jsonb NOT NULL, saved_by uuid REFERENCES users(id), saved_at timestamptz NOT NULL,
  PRIMARY KEY (journey_id, version));

-- The shared record: status, step, timestamps and references only (owner decision 5).
CREATE TABLE journey_records (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES orgs(id), project_id uuid NOT NULL REFERENCES projects(id),
  record_type text NOT NULL CHECK (record_type IN ('client','matter','deal')),
  external_id text, display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','closed')),
  current_instance_id uuid, current_step_id text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE journey_record_refs (
  record_id uuid NOT NULL REFERENCES journey_records(id),
  kind text NOT NULL CHECK (kind IN ('document','form_submission','card','playbook_session')),
  ref text NOT NULL, label text, added_at timestamptz NOT NULL,
  PRIMARY KEY (record_id, kind, ref));

CREATE TABLE journey_instances (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id),
  journey_id uuid NOT NULL REFERENCES journeys(id), journey_version integer NOT NULL,
  record_id uuid NOT NULL REFERENCES journey_records(id),
  status text NOT NULL CHECK (status IN ('running','waiting','stuck','completed','cancelled')),
  current_visit integer NOT NULL, current_step_id text NOT NULL,
  started_by uuid NOT NULL REFERENCES users(id), started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL, ended_at timestamptz);
CREATE INDEX journey_instances_list ON journey_instances (project_id, status, current_step_id);

-- One row per visit of a step: the history and the dedupe key of the runtime.
CREATE TABLE journey_step_runs (
  instance_id uuid NOT NULL REFERENCES journey_instances(id), visit integer NOT NULL,
  step_id text NOT NULL, handoff_id text, from_visit integer,
  -- pending: entered, card not yet created. open: card running. waiting: placeholder. done/cancelled/skipped: ended.
  -- refused: could not start (desk alert open).
  status text NOT NULL CHECK (status IN ('pending','open','waiting','done','cancelled','skipped','refused')),
  card_id uuid UNIQUE REFERENCES cards(id), playbook_thread_id uuid,
  entered_at timestamptz NOT NULL, started_at timestamptz, ended_at timestamptz,
  PRIMARY KEY (instance_id, visit));
CREATE INDEX journey_step_runs_pending ON journey_step_runs (instance_id) WHERE status = 'pending';
CREATE INDEX journey_step_runs_open ON journey_step_runs (card_id) WHERE status = 'open';
```

Projections: new `apps/server/src/projections/journeys.ts` (`journeyProjectors`, registered in `projections/index.ts`
like `subworkflowProjectors`). Each projector is a plain insert/update keyed by the event's ids, so a rebuild gives the
same rows. `JourneyStepEntered` inserts the run (`pending` for a workflow step, `waiting` for a placeholder) and sets
`journey_instances.current_visit/current_step_id/status` and `journey_records.current_step_id`.
`JourneyStepCardStarted` sets `open`, `card_id`, `started_at` and adds a `card` reference to the record.
`JourneyStepPlaybookStarted` sets `playbook_thread_id` and adds a `playbook_session` reference.

### 5.4 Runtime: `apps/server/src/commands/journeys.ts` (new) and `journey-runtime.ts` (new)

State machine of an instance (one step run per visit):

```
start ──> [visit 1 entered] ──workflow step──> pending ──card created──> open ──card done/cancelled──┐
                          └──placeholder────> waiting ──"Continue past this step"──> skipped ───────┤
                                                                                                    v
                                     nextMove(): next ──> [visit n+1 entered] (loop allowed)
                                                 end  ──> instance completed
                                                 stuck──> instance stuck + desk alert
  pending ──refused (workflow not enabled, ...)──> refused + desk alert (instance stuck; acknowledge → retried)
  any running state ──Cancel──> instance cancelled (open card left alone, noted on the card)
```

`sweepJourneys(ctx)` is called from `Scheduler.triggers()` right after `sweepSubworkflows` (same `.catch` logging; the
notifier kick already re-runs `triggers()` soon after new events). Each pass:

1. `SELECT instance_id, visit FROM journey_step_runs WHERE status='pending'` → `startStep(ctx, instanceId, visit)`.
2. `SELECT r.instance_id, r.visit FROM journey_step_runs r JOIN cards c ON c.id=r.card_id
    WHERE r.status='open' AND c.status IN ('done','cancelled')` → `completeStep(ctx, instanceId, visit)`.

Both run in `withAppendTx(ctx.pool, tx => ...)` and start with
`SELECT * FROM journey_instances WHERE id=$1 FOR UPDATE`, then re-read the run and return without doing anything when
`instance.current_visit !== visit`, the instance is not `running`, or the run is no longer in the expected status. That
makes every transition idempotent: a second pass, a replay or two server processes at once do it once.

- `startStep`: load the pinned definition (`journey_versions`), the step and the record. Check visit limits. Resolve the
  workflow in the project like `startChild` does (`resolveWorkflow`, `enabledWorkflows`, card type, membership of
  `started_by`), build the title `"<step label>: <record display name>"` and fields from `fieldsIn` templates
  (`expandMapping` from shared), then `createCardIn(ctx, tx, { id: startedBy }, {..., workflowKey}, { origin: 'journey',
  actor: SYSTEM_ACTOR })` and append `JourneyStepCardStarted` **in the same transaction**. The card and the event commit
  together or not at all, so a crash in between leaves the run `pending` and the next pass starts it once. A refusal
  (`HttpError` from `createCardIn`, or a check above) appends `JourneyStepRefused` + `JourneyInstanceStuck` + a blocking
  desk alert (new `DESK_SUBKIND.journeyStepRefused`, body says what to fix); resolving that desk item appends a new
  `JourneyStepEntered` for the same step (next visit number) so it is tried again.
- `completeStep`: result from the card (`done`/`cancelled`), `ctx` for conditions = `workflowView(card)`, record
  metadata and the visit count of this step (`count(*) FROM journey_step_runs WHERE instance_id AND step_id`). Then
  `nextMove()` and append, in one transaction, `JourneyStepCompleted` plus one of `JourneyStepEntered(visit+1)`,
  `JourneyInstanceCompleted`, or `JourneyInstanceStuck` + desk alert. State is persisted before the next side effect (the
  next card is only created by the next `startStep`).
- `continuePlaceholder(ctx, who, instanceId, visit)` (manual, project member): requires a `waiting` run at the current
  visit; appends `JourneyStepCompleted { result: 'skipped' }` and the next move with `result: 'done'` semantics. The
  later waits/gates change replaces this for real waits and gates.
- `cancelInstance`: appends `JourneyInstanceCancelled`; an open card is not cancelled automatically (a card message on it
  says the journey was cancelled); `completeStep` ignores cards of a cancelled instance.

Server restart mid-journey: nothing is held in memory. Pending and open runs are rows; the first sweep after the restart
picks them up. Cards that ended while the server was down are found by query 2.

Hooks for later changes (do not build now, keep room): GWP-67 gives `wait`/`gate` steps config fields and replaces the
placeholder `waiting` handling; GWP-68 adds a "documents pending" wait and a desk "continue" action, which can reuse
`continuePlaceholder`'s guarded transition.

### 5.5 API: `apps/server/src/routes/journeys.ts` (new; register next to `playbookRoutes` in `app.ts`)

All bodies are zod-validated with the shared DTOs (strict where they touch the record).

| Method and path | Who | What |
|---|---|---|
| `GET /api/journeys?projectId=` | member | Journeys (name, record type, version, step count, running count) |
| `POST /api/journeys` `{projectId, definition}` or `{projectId, templateId}` | admin or project owner | Create (version 1); returns id and validation |
| `GET /api/journeys/:id[?version=]` | member | Definition + validation against the project's enabled workflows |
| `PUT /api/journeys/:id` `{definition, baseVersion}` | admin or project owner | New version; 409 when `baseVersion` is stale |
| `POST /api/journeys/:id/archive` | admin or project owner | Archive (running instances finish on their version) |
| `GET /api/journey-templates` | member | `JOURNEY_TEMPLATES` (static) |
| `GET /api/journey-instances?projectId=&journeyId=&status=&stepId=` | member | Instances with record name, current step label, status, timestamps |
| `POST /api/journey-instances` `{journeyId, record: {recordId} or {type, displayName, externalId?}}` | member | Validate (no errors), create the record when new, `JourneyInstanceStarted` + `JourneyStepEntered(visit 1)` in one tx |
| `GET /api/journey-instances/:id` | member | Instance, record (with references), history (all step runs with timestamps, card refs, playbook links) |
| `POST /api/journey-instances/:id/continue` `{visit}` | member | Continue past a placeholder step |
| `POST /api/journey-instances/:id/cancel` | member | Cancel |
| `POST /api/journey-instances/:id/playbook` `{visit, workstationId?}` | member | Calls `runPlaybookSession(ctx, who, { key: step.playbook.key, projectId, title: "<step>: <record>", input: '', workstationId })` unchanged, then appends `JourneyStepPlaybookStarted`; returns `{threadId, path}` |
| `GET /api/journey-records/:id` | member | The record DTO |
| `POST /api/journey-records/:id/references` `{kind, ref, label?}` | member | Add a document or form-submission reference (used by the forms and storage changes) |

Scope checks: the project must be visible to the caller (same helpers the card routes use); the journey's project and the
instance's project must match the caller's org.

### 5.6 Web (`apps/web`)

- `api/queries/journeys.ts` (new): `useJourneys(projectId?)`, `useJourney(id)`, `useSaveJourney`, `useCreateJourney`,
  `useJourneyTemplates`, `useJourneyInstances(filters)`, `useJourneyInstance(id)` (refetch every 5 s while running),
  `useStartJourneyInstance`, `useContinueJourneyStep`, `useCancelJourneyInstance`, `useRunJourneyPlaybook`.
- `pages/Journeys.tsx` (new), route `/journeys`: two tabs, **Journeys** (list + "New journey" opening the template
  gallery or a blank journey) and **Running** (instances table: record, journey, current step, status, started, last
  change; filters: project, journey, step (from the selected journey's steps), status). Each row links to the instance.
- `pages/JourneyDesigner.tsx` (new), route `/journeys/:id`: name, record type, project; an ordered step list (each step a
  card: label, kind, workflow picker from `useProjectWorkflows(projectId)` enabled workflows, optional playbook picker
  from `useSlashCommands({context: 'session', projectId})` filtered to `kind === 'playbook'`, field templates); a handoff
  editor per step ("When this step is **done / cancelled / either**, [if <condition>], go to <step>"), loops shown with a
  loop icon; validation issues inline (reuse `components/builder/IssueBar.tsx` style). Placeholder steps show a
  "Coming with waits and gates" badge. Save sends `baseVersion`; reopening loads the saved definition as it is.
- `components/journeys/` (new): `StepList.tsx`, `HandoffEditor.tsx`, `ConditionEditor.tsx`, `JourneyTemplateGallery.tsx`
  (same layout as `TemplateGallery.tsx`), `InstanceHistory.tsx`, `StartInstanceDialog.tsx`.
- `pages/JourneyInstance.tsx` (new), route `/journeys/instances/:id`: record header (type, name, external id, status),
  current step, actions (Run playbook when the step has one, Continue past this step on a placeholder, Cancel), history
  (visit, step, entered/started/ended times, result, card link `/cards/<ref>`, playbook session link), references list.
- `router.tsx`: the three routes; `components/shell/nav-config.ts`: a **Journeys** entry in the work group next to
  Automations (icon `Route` from lucide). Do not change `useWorkflows`.
- All devices including touch: ordering uses **Move up / Move down buttons** (drag is optional on top, never the only
  way); every control has a visible label and a 44 px target; nothing is hover-only; the condition and field inputs are
  plain inputs with the right `inputMode` and stay visible when the soft keyboard opens (the page scrolls the focused
  field into view; the save bar is not `position: fixed` over inputs on small screens); the designer is a single column
  below `md`.

### 5.7 The rentals template (`JOURNEY_TEMPLATES[0]`, id `rentals`, record type `client`)

| Step id | Label | Kind | Default workflow |
|---|---|---|---|
| `lead` | Lead | workflow | `business-enquiry` |
| `viewing` | Viewing | workflow | `business-follow-up` |
| `application` | Application | workflow | `business-document-request` |
| `wait_documents` | Wait for forms and documents | wait (placeholder) | |
| `screening` | Screening | workflow | `business-report` |
| `approval` | Approval | gate (placeholder) | |
| `lease_signed` | Lease signed | workflow | `business-document-request` |
| `deposit_invoice` | Deposit and first-rent invoice | workflow | `business-quote` |
| `move_in` | Move-in | workflow | `business-follow-up` |
| `monthly_rent` | Monthly rent | workflow | `business-reminder` |

Handoffs (in this order per step):

- each step `done` → the next step in the table (placeholders end with `done` when continued);
- `lead` `cancelled` → `end` ("lead lost"), `screening` `cancelled` → `end` ("application declined");
- `monthly_rent` `done` → `monthly_rent` (the loop, label "Next month");
- `monthly_rent` `cancelled` → `end` ("Lease ended": cancel that month's card to end the journey).

A handoff to the literal `end` ends the instance (`nextMove` returns `end`); `end` is a reserved step id.

The template opens in the designer with all ten steps. The designer shows any default workflow that is not enabled in the
chosen project as an error to fix before starting.

### 5.8 CHANGELOG

Add `## [1.5.0] - unreleased` between `## [Unreleased]` and `## [1.4.0]` with an **Added** entry: journeys (designer,
handoffs with conditions and loops, the shared record holding only status, step, timestamps and references, instances,
playbooks in steps, the rentals template, the Journeys page), naming migration 2810 and the new events.

## 6. Risks

- **Client content in the record.** Mitigated by the narrow table, the strict DTOs and the test in 7. `display_name`
  and `external_id` are identifying metadata the requirement asks for; nothing else is free text.
- **Double transitions** (two server processes, replays, retries): the `FOR UPDATE` lock on the instance plus the
  expected-visit and run-status guards; card creation and `JourneyStepCardStarted` in one transaction; `card_id UNIQUE`.
- **Loop runaway**: one card per visit, visit limits, stuck with a desk alert.
- **Workflow disabled or archived project after the journey was built**: start-time re-validation and the refusal alert.
- **Migration number** collision with other 1.5.0 changes: take the next free number when merging.
- **Existing behaviour**: the only shared touch points are the `CardOrigin` enum and its constraint, `streamId`, the event
  and projector registries, the scheduler's `triggers()` and the router/nav. Search all users of `CardOrigin` (board
  filters, card DTOs, origin labels in the web) and add a label for `journey` where origins are rendered.

## 7. Acceptance criteria → design and tests

| AC | Design | Tests (all in new files) |
|---|---|---|
| Create a journey from workflows, handoffs with a condition and a loop back, save and reopen unchanged | 5.1 schema, 5.5 `POST/PUT/GET /api/journeys`, 5.6 designer | shared `journeys/schema.test.ts` (round trip); server `test/journeys-api.test.ts` (create, save v2 with condition + loop, GET equals what was sent); web `JourneyDesigner.test.tsx` (load, edit, save payload) |
| Start on a record → instance at the first workflow; completing it follows the matching handoff; history with timestamps | 5.4 runtime, 5.5 instances API, 5.6 instance view | shared `journeys/resolve.test.ts` (conditions, `on`, loops, end, stuck, visit limits); server `test/journeys-runtime.test.ts` (start → card created with origin `journey`; finish the card → next step; cancelled → condition branch; loop creates visit n+1; idempotency: run `sweepJourneys` twice and call `completeStep` concurrently → one transition; "restart": build a fresh ctx/scheduler on the same database mid-journey and continue) |
| Record stores only status, step, timestamps and references; a test proves it | 5.1 strict DTOs, 5.3 tables | server `test/journeys-record-content.test.ts`: `information_schema.columns` of `journey_records` and `journey_record_refs` equal the allow-list; starting with extra keys (`answers`, `documents: [{content}]`) gets 400; payload schemas of the `JourneyRecord*` events have only allow-listed keys; a reference with whitespace/inline data (`data:...` longer than the limit) is refused |
| A step references a playbook and it runs there, playbooks unchanged | 3.3 B, 5.5 `/playbook` route | server `test/journeys-playbook.test.ts`: the route starts a guided session through `runPlaybookSession` (thread exists, `/discovery/<id>`), the run and the record get the reference; an unknown playbook is refused with the playbook feature's own error |
| Rentals template from the template list opens in the designer with all steps | 5.7, `GET /api/journey-templates`, `POST /api/journeys {templateId}` | shared: template validates (only "pick a workflow"-free errors), has the ten steps in order, the loop and the two placeholders; web `JourneyTemplateGallery.test.tsx` and designer shows ten steps |
| Existing playbooks and workflows behave as before | No change to workflow, sub-workflow or playbook code | Run the existing shared, server workflow/sub-workflow/playbook tests and web builder tests unchanged; name any touched existing test file in the handoff |
| CHANGELOG 1.5.0 entry | 5.8 | Review |

Manual on UAT (testers): create the rentals journey in a business project, start it on a client, finish the Lead and
Viewing cards and see the instance reach Application, then the placeholder wait.
