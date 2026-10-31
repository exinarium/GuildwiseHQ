# GWP-34 Business mode: the Brief pattern and two playbooks (Morning plan, Weekly owner brief)

Design report, release 1.4.0, Business mode Phase 1. First written before GWP-30 (business card types), GWP-32
(delivery of agent output) and GWP-33 (business roles) landed. **Revised on 31 Oct 2026 against the landed code** (see
section 8): assumptions 3, 5 and 7 did not hold. The others were confirmed. The research file can now be read in the
vault (section 4.1.1).

## 1. Question

How do we add a reusable "Brief" workflow and two ready-made playbooks on top of it, so that:

- a business org manager installs Morning plan or Weekly owner brief in one action and picks where it goes;
- at the scheduled time (or on "Run now"/"Send test") a report card runs the Brief workflow, the agent writes a short,
  plain brief that cites real cards and rules, and the text reaches each chosen destination;
- time, destinations and owner role can be changed later, or the playbook removed, and the change applies to the next run;
- the Brief workflow passes `validateCustomWorkflow` and has no repository, branch or merge step;
- dev orgs and Guildwise Cloud see no change?

## 2. Findings

| Area | File | Finding |
| --- | --- | --- |
| Schedules | `apps/server/src/commands/schedules.ts` | `createSchedule` (l. 684) = `normalizeCreate` → `authorize` → `validate` (calls `assertCronAndZone` for cron triggers, `checkTemplate` for `create_card`, `validateDeliverOutput` for `deliverOutput`) → `ScheduleCreated`. Generating and encrypting the webhook signing secret (`deliverOutput.secretEnc`) also happens here. `patchSchedule` (l. 756) re-validates, keeps the stored `secretEnc`, and recomputes `next_fire_at` when the trigger changes. `deleteSchedule` (l. 967) appends `ScheduleDeleted`, and the projection deletes the row. `runScheduleNow` and `testSchedule` exist. Everything runs inside `withAppendTx`; there is no `…In(tx)` variant yet. |
| Run of a `create_card` | `schedule-actions.ts` `executeAction` → `scheduledCard` | The card is built from `action.template` at every run (title expanded with `{date}`), with `extra.fields` written over `template.fields`. So anything stored in the template (workflow key, fields) takes effect at the next run. The card starts at `specifyTarget(def).to` (the first agent stage after a manual initial stage), with `scheduled: true` and the org owner as owner. |
| Template | `packages/shared/src/events/schedule.ts` `CardTemplateSchema`, `ScheduleActionSchema` | `create_card` has `projectId`, `template`, `ratePerHour`, `dedupe` and (GWP-32) `deliverOutput: DeliverOutputSchema` = `{ destinations: OutputDestination[1..5], secretEnc? }`, where `OutputDestination` is email / webhook / whatsapp / google_sheet. Actions are stored as JSON, so a new optional key needs no migration. |
| Who works a stage | `workflows/validate.ts` rule 3, `roles/business.ts`, `dispatcher/candidates.ts` | A stage's role is `stage.claimRole`, and the dispatcher matches `st.claim_role = agent.role_key`. **Landed (GWP-33):** the seven business roles are built in (`BUILTIN_ROLES` ends with `...BUSINESS_ROLES`), all at version 1, and each has `claimableStages: [{ workflowKey: '*', stageId: '*' }]`. Rule 3 therefore passes for any business role on any stage. There is no per-card role override. |
| Business workflows | `packages/shared/src/workflows/business.ts`, `apps/server/src/catalogue/business-workflows.ts` | **Landed (GWP-30):** six `business-<type>` workflows (request → prepare → approve → done). `business-report` is claimed by `operations_analyst`. `businessWorkflowEvents` and `ensureBusinessWorkflows` work only on that fixed list, so there is **no generic "register and enable" helper**. Their payload pattern: `WorkflowVersionRegistered { workflowVersionId, orgId, key, version, name, definition, status: 'active' }`, validated first with `validateCustomWorkflow(def, BUSINESS_ROLES, { builtinWorkflowKeys, departments: [] })`. `ProjectWorkflowsSet { projectId, enabled: [...every existing entry, new], by: project.created_by }`. |
| Due dates | `workflows/business.ts` `BUSINESS_CARD_FIELDS` | `follow_up.dueDate`, `reminder.remindOn`, `enquiry.dueBy`, `document_request.deadline`, `quote.validUntil` (text, `format: 'date'`). The `report` type has `subject` (required), `period` and `audience` when it runs `business-report`. |
| Repo-less brief | `runner-gateway/brief.ts:209`, `commands/completion.ts` | `isBusinessCardType(card.card_type)` decides `repoless: true`, `fieldLabels` and `completionAction: null`, whatever the workflow. A `report` card on a Brief workflow gets all three. |
| Prompt | `packages/shared/src/prompt/shift-prompt.ts:255-270` | **Landed (GWP-30):** for a card with `fieldLabels`, a "Details" section prints every custom field under its label, and then `context` and `requirements` are printed again in their own sections. Without a change, a Brief card would print its Context snapshot (up to 12 000 characters) twice (see 4.3.7). |
| Delivery | `commands/schedule-output.ts`, `schedule-triggers.ts:329,360`, `schedule-delivery.ts:267`, `packages/shared/src/schedules/output.ts` | **Landed (GWP-32):** `cardOutput()` is the single place that builds the output text (the last agent handoff note, or the investigation summary). Email/webhook use it when the delivery is queued; WhatsApp/Sheets use it again when the runner command is sent. There is no per-card hook. The delivery is queued by `sendCardOutput`, **only on the `card_done` trigger**, which is read from `CardFinalized` (to `done`), `QaPassed` and `QaSkipped`. A custom workflow whose agent stage leads straight to a `terminal` stage through `StageCompleted` sets `status='done'` in the projection (`projections/cards.ts:758`) but emits **no `CardFinalized`**. GWP-30 even tests that its business cards do not. So, as landed, a Brief card would never deliver (see 4.3.6). `queueOutputDeliveries` reads `schedules WHERE id=$1 AND enabled`, so a deleted (row gone) or disabled schedule delivers nothing. `testSchedule` → `testOutputDeliveries` sends one test per destination, using `sampleOutput` (the schedule's newest done card, or a fixed text). WhatsApp text is flattened and cut at `WHATSAPP_EXCERPT_MAX = 500` characters, followed by the card link. |
| Web delivery editor | `apps/web/src/components/schedules/OutputSection.tsx`, `apps/web/src/lib/schedules.ts` | `OutputSection({ outputs, onChange, errors, workstations })` with `OutputDraft`, `emptyOutput`, `buildOutputs(drafts)`, `draftsFrom(destinations)`. Reusable as is. |
| Org mode | `packages/shared/src/orgs/mode.ts`, `apps/server/src/orgs/mode.ts`, `apps/web/src/lib/orgMode.ts` | `isBusinessOrg(org)` (shared, "THE gate"); server `assertBusinessOrg(db, orgId, msg)` → 409 `business_only`; web `useBusinessMode()`. |
| Handoff check precedent | `commands/shifts.ts` | The `StageCompleted` branch already refuses a report for one stage (`QA_STEPS_STAGE`, empty note) with `{accepted:false, error}`. The agent fixes it and reports again in the same shift. |
| "What changed" queries | `commands/weekly-briefing.ts` `gatherBriefing`, `schedule-digest.ts` `projectSummary`, `queries/ledger.ts` | Ready SQL for done in a period, blocked cards, open manager desk items and phases. Links are app paths `/cards/<ref>`; mail uses `ctx.config.publicOrigin` for absolute links. Ledger rows are in `ledger_entries`; by convention notes cite them by an 8-hex short id. |
| Org time zone | `ceo/prefs.ts` `reportingOf(db, orgId).timezone` | The Owner's reporting zone, which the Monday briefing uses as "the organization's time zone". |
| Name clash | `packages/shared/src/playbooks/*`, `apps/web/src/components/slash/*` | "Playbook" is already a capability (`/` commands, `aom playbook run`, `PLAYBOOK_*`). Code for this card must not reuse those names. |
| Web | `pages/Automations.tsx`, `components/schedules/ScheduleWizard.tsx` | One list grouped by project, a wizard to create and edit, and Run now / Test / Pause / Delete on each row. |

## 3. Options

### 3.1 How the owner role is chosen and changed per playbook

| Option | How | Verdict |
| --- | --- | --- |
| A. One `business-brief` workflow, fixed role | Every playbook uses the same claim role | Fails req. 4 (edit the owner role) and "owned by the **matching** role". **Rejected.** |
| B. One workflow per installed playbook, role change = new workflow version | `WorkflowVersionRegistered` + approval on each role edit | Works, but piles up versions and writes vault copies. **Rejected.** |
| C. Per-card role override (new card column, dispatcher change) | `COALESCE(c.stage_roles->>c.stage, st.claim_role)` in the candidate SQL | Touches the dispatcher hot path of every dev org, which contradicts "dev orgs behave exactly as today". **Rejected.** |
| D. **One Brief workflow per owner role, named by the playbook's template** | `briefWorkflow(role)` produces key `business-brief-<role>` (stage `brief` claimed by that role). Installing a playbook, or giving it a new owner, registers that role's Brief workflow in the org if it is missing and sets `template.workflowKey` to it | Pure data that uses only existing events. The next run picks up the new key, because cards are built from the template at run time. The roles already claim every stage (GWP-33 wildcard), so no role changes. **Recommended.** |

### 3.2 How the agent gets "what changed"

| Option | Verdict |
| --- | --- |
| Agent gathers it with CLI calls | No `aom` command lists the org's cards, so the agent would guess and real refs cannot be guaranteed. **Rejected.** |
| New `ShiftBrief.briefContext` rendered by the prompt | Needs a new runner version; an older runner drops the field silently. **Rejected for Phase 1.** |
| **Server snapshot at run time into the card's `context` field** | Built in `executeAction` from the DB (cards, ledger, desk), with links, and limited to the org's existing data. Every runner renders it as "Context". It can be tested on the server and stays on the card as the record of what the brief was based on. **Recommended.** |

### 3.3 How the cap and citations are enforced

| Option | Verdict |
| --- | --- |
| Prompt only | AC3 ("stays within the cap", "names real cards") would rest on the model alone. **Rejected as the only guard.** |
| Truncate at delivery | Cuts sentences and may drop the citations. **Rejected.** |
| **Check the handoff note on the `brief` stage** (like `QA_STEPS_STAGE`) | Refuses notes over the cap and unknown refs or rule ids with a clear message; the agent shortens the note and reports again in the same shift. **Recommended.** |

### 3.4 How a Brief card reaches GWP-32's delivery (new in the revision)

| Option | Verdict |
| --- | --- |
| Emit `CardFinalized` when a Brief card reaches `done` | It would run finalize paths (graph refresh, worktree release, QA open) and mislabel a report as merged. **Rejected.** |
| Add `StageCompleted` to the `card_done` trigger for every workflow | Changes the trigger for dev orgs' custom workflows that end through `StageCompleted`, and for user automations with a `card_done` trigger. **Rejected** (dev orgs must stay unchanged). |
| **In `handleEvent`, also call `sendCardOutput` for a `card_stage_reached` event whose card runs a Brief workflow and whose `toStage` is the Brief's `done` stage** | One gated line next to the existing `card_done` call. The `output:<cardId>:<i>` dedupe key already makes a repeat safe, and the existing `enabled` and row checks still apply (AC5). **Recommended.** |

## 4. Design

### 4.1 Shared (`packages/shared`, all additive)

#### 4.1.1 Content from the research file

The research file is now readable at `projects/gwp/docs/business-mode/2026-10-27-business-mode-game-plan.md` in the GWP
vault. It contains:

- **Pattern table, Brief row:** shape "pull numbers → read-only digest → email/WhatsApp/Sheet", trigger "cron (07:00
  daily, Monday weekly)", approval default "none". The workflow therefore has **no approval step** (request → brief →
  done).
- **Role table:** the roles whose Patterns column names Brief are Billing Clerk ("Brief (cash)"), Operations Analyst
  ("Brief") and Personal Assistant ("Brief (morning plan)"). So `BRIEF_OWNER_ROLES = ['personal_assistant',
  'operations_analyst', 'billing_clerk']` (the keys GWP-33 shipped).
- Context lines: "daily plan and morning brief; weekly owner brief (sales, cash, orders). The weekly owner brief is the
  lowest-risk, highest-retention job (read-only)." and "Core pack for every business: morning plan + weekly owner brief".

The file has **no separate playbook table, no word cap and no requirements text**. Take the playbook settings from the
file where it gives them, and from the card otherwise:

| Setting | Morning plan | Weekly owner brief | Source |
| --- | --- | --- | --- |
| Default owner role | `personal_assistant` | `operations_analyst` | Role table ("Brief (morning plan)"; "Brief" + "Draft (reports)", read-only). Inferred: say so in the handoff. |
| Cadence and time | Mon–Fri 07:00 | Monday 07:00 | Pattern table "07:00 daily, Monday weekly"; card "on working days". The file gives no weekly time, so 07:00 is a fallback: say so. |
| Word cap | 150 | 300 | Not in the file: fallback, say so. Editable at install. |
| Period | 1 day (Monday: since Friday's run) | 7 days | Derived from the cadence. |
| What the brief covers (`requirements`) | Today's priorities, due follow-ups and reminders, overdue items | What was done, what is stuck, decisions made, what needs the owner | The card's requirement 2 lists, word for word, plus the pattern's "read-only digest". Do not add sales/cash/orders figures: there are no connectors in Phase 1, so the brief only reports what the Context holds. |

Phrase each `requirements` text as instructions for the agent, using the card's own list items as the headings. Do not
add topics, rules or compliance claims that neither the card nor the file states. Name in the handoff which values were
inferred or fallbacks, as the GWP-30 precedent asks (ledger 62847e4d).

#### 4.1.2 `src/workflows/brief.ts` (new, export from `workflows/index.ts`)

```ts
export const BRIEF_STAGE_ID = 'brief';
export const BRIEF_DONE_STAGE_ID = 'done';
export const BRIEF_WORKFLOW_PREFIX = 'business-brief-';
export const briefWorkflowKey = (roleKey: string) => `${BRIEF_WORKFLOW_PREFIX}${roleKey.replace(/_/g, '-')}`;
export const isBriefWorkflowKey = (k: string | null | undefined) => !!k?.startsWith(BRIEF_WORKFLOW_PREFIX);
/** Business roles whose Patterns column in the research role table names Brief. */
export const BRIEF_OWNER_ROLES = ['personal_assistant', 'operations_analyst', 'billing_clerk'] as const;
export function briefWorkflow(roleKey: string): WorkflowDefinition // WorkflowDefinitionSchema.parse(...), like businessWorkflow()
```

Build it the same way as `businessWorkflow()` in `workflows/business.ts`, using the same `outcome()` shape and stage
fields:

| Step id | Kind | Column | What happens | Outcomes |
| --- | --- | --- | --- | --- |
| `request` | manual (initial), `claimRole: null` | Request | Scheduled cards skip it (`specifyTarget`) | `specified` → `brief` (`CardSpecified`) |
| `brief` | agent, `claimRole: roleKey`, `requiredFields: ['requirements', 'maxWords']`, `maxShiftMinutes: 20`, `worktree: 'none'`, `environment: 'none'` | Writing | Reads the Context snapshot (and its knowledge folder for notes changed in the period) and writes the brief as its handoff note | `done` → `done` (`StageCompleted`) |
| `done` | terminal | Done | `status='done'`; delivery through 4.3.6 | – |

The definition: `key: briefWorkflowKey(role)`, `name: "Brief (<role name from BUSINESS_ROLES>)"`, `version: 1`,
`builtIn: false`, `fieldSet: 'custom'`, `cardTypes: ['report']`, and these `customFields`:

| Key | Label | Type | Required | Filled by |
| --- | --- | --- | --- | --- |
| `requirements` | What to write | markdown | yes | the playbook (4.1.1) |
| `maxWords` | Word cap | number | yes | the playbook (editable) |
| `context` | What changed | markdown | no | the server at run time (4.3.3) |
| `period` | Period | text | no | the server at run time |

The `brief` stage's `doneCriteria`: "The brief is your full handoff note: plain language, at most the word cap, every
card named by its ref and every rule by its ledger id from the Context, nothing that is not in the Context or the
knowledge folder."

#### 4.1.3 `src/schedules/brief-playbooks.ts` (new, export from `schedules/index.ts`; names avoid `PLAYBOOK_*`)

```ts
export const BriefPlaybookKey = z.enum(['morning_plan', 'weekly_owner_brief']);
export interface BriefPlaybook {
  key: BriefPlaybookKey; version: number; name: string; description: string;
  cadence: 'workdays' | 'weekly';
  defaultTime: string;              // 'HH:MM'
  defaultWeekday?: number;          // weekly: 0-6 (Monday = 1)
  defaultOwnerRole: (typeof BRIEF_OWNER_ROLES)[number];
  maxWords: number;
  periodDays: number;
  requirements: string;
}
export const BRIEF_PLAYBOOKS: Record<BriefPlaybookKey, BriefPlaybook>;   // values from 4.1.1
export function briefPlaybookCron(p: BriefPlaybook, time: string, weekday?: number): string;
  // workdays: `${m} ${h} * * 1-5`; weekly: `${m} ${h} * * ${weekday ?? p.defaultWeekday}`
export function briefPlaybookTemplate(p: BriefPlaybook, ownerRole: string, maxWords?: number): CardTemplate;
  // { title: `${p.name} {date}`, cardType: 'report', workflowKey: briefWorkflowKey(ownerRole),
  //   fields: { requirements: p.requirements, maxWords: maxWords ?? p.maxWords }, start: 'queued' }
export const InstallBriefPlaybookRequestSchema = z.object({
  projectId: z.uuid().optional(),           // only needed when the org has more than one project
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  timezone: z.string().min(1).max(60).optional(),   // default: the org's zone
  ownerRole: z.enum(BRIEF_OWNER_ROLES).optional(),  // default: the playbook's role
  maxWords: z.number().int().min(30).max(1000).optional(),
  destinations: z.array(OutputDestinationSchema).min(1).max(5),   // GWP-32's shape
});
export const PatchBriefPlaybookRequestSchema = InstallBriefPlaybookRequestSchema.omit({ projectId: true }).partial()
  .extend({ enabled: z.boolean().optional() });
export const BriefPlaybookDtoSchema = z.object({ key, name, description, cadence, defaultTime, defaultWeekday,
  defaultOwnerRole, maxWords, scheduleId: z.uuid().nullable(), /* installed settings when installed */ });
```

The request takes `destinations` only. The server wraps them into `deliverOutput: { destinations }`, and
`createScheduleIn`/`patchScheduleIn` generate or keep `secretEnc` as for any automation. `secretEnc` is never sent to
or read from the browser.

#### 4.1.4 `src/events/schedule.ts`

The `create_card` action gains:

```ts
/** Installed from a brief playbook: the Automations page shows its own editor, and the run adds the Context snapshot. */
playbook: z.object({ key: z.string().min(1).max(60), version: z.number().int().min(1) }).optional(),
```

This is a plain string key, not the enum, so an older reader never rejects a newer playbook key.

#### 4.1.5 `src/schedules/output.ts` (GWP-32's formatters, additive)

`CardOutput` gains an optional `links?: Array<{ label: string; url: string }>`, set only for Brief cards (4.3.5).

- `outputEmail`: after the text, `"\n\nLinks:\n" + "- label: url"` lines, then the card link as today.
- `outputWebhookBody`: `generic` → `data.links` (array); chat formats → the links appended after the excerpt.
- `sheetRow`: the links appended to the text column.
- `whatsappText`: unchanged. It ignores `links`, so the 500-character excerpt holds the brief, not the links (the card
  link that follows opens the full brief and its links).

When `links` is absent, every output is byte-for-byte what it is today (dev orgs and other automations).

#### 4.1.6 `src/cards/…` (next to GWP-30's business types)

`BUSINESS_DUE_FIELDS: Partial<Record<BusinessCardType, string>>` = `{ follow_up: 'dueDate', reminder: 'remindOn',
enquiry: 'dueBy', document_request: 'deadline', quote: 'validUntil' }` (the names GWP-30 shipped, confirmed).

### 4.2 Roles: no change

GWP-33's roles already claim `{ workflowKey: '*', stageId: '*' }`, so `validateCustomWorkflow` accepts every
`business-brief-<role>` workflow for any business role. Do **not** edit `roles/business.ts` or bump role versions. The
choice of owner is limited to `BRIEF_OWNER_ROLES` by the install/patch schema and the dialog.

### 4.3 Server (`apps/server`)

**1. `src/commands/schedules.ts`: in-transaction variants (refactor, no behaviour change).** Extract the bodies into
`createScheduleIn(ctx, tx, user, org, req)` and `patchScheduleIn(ctx, tx, user, org, id, patch)`; the exported
`createSchedule`/`patchSchedule` wrap them in `withAppendTx` exactly as today. The playbook install can then register
the workflow and create the schedule in one transaction, and keeps one validation path (`assertCronAndZone`,
`checkTemplate`, `validateDeliverOutput`, secret handling).

**2. New `src/commands/brief-playbooks.ts`.**

```ts
export async function listBriefPlaybooks(ctx, user, orgId): Promise<BriefPlaybookDto[]>
export async function installBriefPlaybook(ctx, user, org, key, req): Promise<{ scheduleId: string }>
export async function patchBriefPlaybook(ctx, user, org, scheduleId, req): Promise<void>
async function ensureBriefWorkflow(ctx, tx, orgId, projectId, roleKey): Promise<string /* workflow key */>
```

- `installBriefPlaybook`, in one `withAppendTx`:
  1. Org manager only (`isOrgManager`), else 403. Business org only: `assertBusinessOrg(tx, orgId, "Playbooks are
     available in business mode.")` → 409 `business_only`.
  2. One install per playbook per org: if a schedule with `action->'playbook'->>'key' = key` exists in the org,
     return 409 `playbook_installed` with its `scheduleId` (the page opens its editor instead).
  3. Project: `req.projectId`, else the org's only active project of kind `project`. If there are several and none
     was given: 400 `project_required`.
  4. Role: `req.ownerRole ?? playbook.defaultOwnerRole` (the schema limits it to `BRIEF_OWNER_ROLES`).
  5. `ensureBriefWorkflow` (GWP-30 has no reusable helper, so write it here and follow `businessWorkflowEvents` /
     `ensureBusinessWorkflows`):
     - If the org has no row in `workflow_versions` for `briefWorkflowKey(role)`, validate `briefWorkflow(role)` with
       `validateCustomWorkflow(def, BUSINESS_ROLES, { builtinWorkflowKeys: BUILTIN_WORKFLOWS.map(w => w.key),
       departments: [] })`. Errors → 409 `brief_workflow_invalid` with the issue codes (never register an invalid
       workflow). Otherwise append `WorkflowVersionRegistered { workflowVersionId: randomUUID(), orgId, key, version:
       def.version, name: def.name, definition: def, status: 'active' }` on `streamId.workflow(orgId, key)`, with
       `SYSTEM_ACTOR` and `orgScope(orgId)`.
     - If the project has not enabled the key, append one `ProjectWorkflowsSet { projectId, enabled: [...every current
       entry with its defaultCardTypes, { workflowKey, defaultCardTypes: [] }], by: project.created_by }`, with
       `projectScope`. The list is empty so that manual "Report" cards keep going to `business-report`. GWP-30's
       `ensureBusinessWorkflows` keeps every enabled entry when it runs later (at boot), so the Brief entry survives.
  6. `createScheduleIn` with `{ name: playbook.name, enabled: true, trigger: { kind: 'cron', cron:
     briefPlaybookCron(...), timezone: req.timezone ?? reportingOf(org).timezone ?? 'UTC' }, action: { kind:
     'create_card', projectId, template: briefPlaybookTemplate(...), deliverOutput: { destinations: req.destinations },
     playbook: { key, version: playbook.version } } }`.
- `patchBriefPlaybook`: loads the schedule. It must carry `action.playbook`, else 400 `not_a_playbook`. Rebuild the
  trigger (time/weekday/timezone) and the action (`ensureBriefWorkflow` for a new role, then `template.workflowKey`,
  `fields.maxWords`, `deliverOutput.destinations`), and call `patchScheduleIn`, which keeps `secretEnc`. A changed
  trigger recomputes `next_fire_at`. The template is read at each run, so every edit applies to the next run (AC5). The
  `requirements` text cannot be edited here (it is the shipped playbook).
- Remove: the existing `DELETE /api/schedules/:id`. The projection deletes the row, so a card still in flight no longer
  delivers (`queueOutputDeliveries` finds no schedule). The org's Brief workflow rows stay; they are harmless and a later
  install reuses them.
- Routes (a new file next to the schedules routes): `GET /api/brief-playbooks`, `POST /api/brief-playbooks/:key/install`,
  `PATCH /api/brief-playbooks/schedules/:id`. The path avoids `/api/playbooks` (the existing `/` playbooks).

**3. New `src/commands/brief-context.ts`: the snapshot.** It is called from `executeAction`'s `create_card` branch when
`action.playbook` is set (before `scheduledCard`), and its result is merged into `extra.fields`:

```ts
export async function buildBriefContext(tx, a: {
  orgId: string; projectId: string; scheduleId: string; playbook: BriefPlaybook | undefined;
  now: Date; timezone: string; origin: string;
}): Promise<{ context: string; period: string }>
```

- Period: from the `started_at` of the schedule's last `ok` run with a card (`schedule_runs`) to `now`, at most
  `periodDays` (+2 for a Monday morning plan) and at least 1 day. The `period` text reads like "since Fri 31 Oct
  07:00 (Africa/Johannesburg)".
- Scope: **the schedule's project only**.
- Sections (each at most 15 lines, newest or most urgent first). Every card line has the form `- REF Title (type,
  status/stage, due YYYY-MM-DD): <origin>/cards/REF`.
  - Due today and overdue: open cards whose `BUSINESS_DUE_FIELDS[card_type]` date is on or before today (in
    `timezone`), split into "Due today" and "Overdue (n days)".
  - Priorities: open cards by `priority`, then oldest first.
  - Done in the period: `status='done'` and `finalized_at` in the period. The projection sets `finalized_at` for the
    terminal `StageCompleted` too.
  - Stuck: `status='blocked'` (with the number of days), plus cards waiting on a person (open approval desk items).
  - New in the period: cards created in the period.
  - Decisions and rules in the period: the org's `ledger_entries` (org-wide or this project) created in the period and
    not retired: `- [rule <first 8 of id>] <title>: <origin>/ledger?entry=<id>`.
  - Needs the owner: open manager desk items of this project or the org (`DESK_VISIBLE`, as in `gatherBriefing`);
    titles only.
  - Leave the playbook's own earlier report cards (`schedule_id = this schedule`) out of every list.
  - A section with nothing in it prints "none". The whole text is capped at 12 000 characters (drop lines from the end
    of the longest list first).
- The Context ends with one fixed line: "Knowledge notes: check your knowledge folder for notes changed in this period."

**4. Handoff check: new `src/commands/brief-check.ts`, called from `commands/shifts.ts` in the `StageCompleted` case**
(next to the `QA_STEPS_STAGE` check), only when `isBriefWorkflowKey(wf.definition.key) && card.stage === BRIEF_STAGE_ID`:

```ts
export async function checkBriefNote(tx, card, note): Promise<string | null /* error for the agent */>
```

- Words (`note.trim().split(/\s+/)`) > `card.fields.maxWords` → "The brief has N words; the cap is M. Shorten it and
  report again."
- Card refs (`/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g`) that are not cards of the org → "These refs are not cards of this
  organization: X, Y. Use only refs from the Context."
- Rule ids (`/\brule ([0-9a-f]{8})\b/gi`) that match no ledger entry of the org → the same kind of message.
- The Context lists at least one card and the note cites none → "Name the cards you mention by their ref."
- An empty note is refused.
The check returns `{ accepted: false, error }` like the QA check. No event is written, and the shift goes on.

**5. Output for delivery: `cardOutput()` in `schedule-output.ts`.** This is the only place the text is built, used both
when the delivery is queued and when the runner command is sent. Add a gated Brief case: read the card's workflow key
(`LEFT JOIN workflow_versions v ON v.id = c.workflow_version_id`). When `isBriefWorkflowKey(v.key)`, the text stays the
last agent handoff note (the brief, as today), and `links` is filled from the refs and rule ids cited in it:
`{ label: 'REF title', url: <origin>/cards/REF }` and `{ label: '<rule title>', url: <origin>/ledger?entry=<id> }`
(org-scoped lookups). Any other card returns exactly what it returns today. The formatters (4.1.5) render the links.
`sampleOutput` ("Send test") needs no change: it uses the schedule's newest done Brief card (with links), or GWP-32's
fixed test text before the first run.

**6. Delivery trigger for Brief cards: `schedule-triggers.ts` `handleEvent`.** Next to line 329, add:

```ts
if (
  name === 'card_stage_reached' && ec.card?.scheduleId && ec.sourceId &&
  isBriefWorkflowKey(ec.card.workflowKey) && ec.card.toStage === BRIEF_DONE_STAGE_ID
) n += await sendCardOutput(ctx, ec);
```

The sweep already reads `StageCompleted` whenever an enabled schedule with `deliverOutput` exists (`any` check, line
291), so a Brief card's `done` arrives here. `queueOutputDeliveries` keeps its checks: an enabled schedule row (AC5:
removed or paused → nothing is sent), an operational org, `assertOwnerStillAllowed`, and one run per
`output:<cardId>:<i>`. Dev cards never match `isBriefWorkflowKey`, so nothing changes for them, nor for the generic
`card_done` trigger.

**7. Brief and prompt: one gated change in `runner-gateway/brief.ts`.** The card is a `report` card, so GWP-30's
repo-less brief applies as is (`repoless`, `completionAction: null`, no working branch). But the landed Details
section would print `context` and `requirements` twice. When `isBriefWorkflowKey(wf.definition.key)`, build
`fieldLabels` without the keys `context` and `requirements` (Details then shows only Word cap and Period, and the two
long fields render once in their own sections). There is no protocol change, and other business cards are unchanged.

### 4.4 Web (`apps/web`)

- **`components/schedules/BriefPlaybooks.tsx`** (new): a "Playbooks" section at the top of `pages/Automations.tsx`,
  rendered only when `useBusinessMode()` is true and the user is Owner/Admin. One tile per playbook shows the name,
  description, cadence and owner role. A playbook that is not installed has "Install". An installed one shows the next
  run and the destinations, with Edit / Run now / Send test / Remove (Run now, Send test and Remove reuse the existing
  schedule hooks).
- **`components/schedules/BriefPlaybookDialog.tsx`** (new), used to install and to edit. Fields: time
  (`<input type="time">`), weekday select (weekly only), time zone select (default the org's), owner role select
  (`BRIEF_OWNER_ROLES`, labels from the role catalogue), word cap (number, `inputMode="numeric"`), destinations
  (GWP-32's `OutputSection` with `emptyOutput`/`buildOutputs`/`draftsFrom`), and a project select only when the org has
  several projects. One primary button: "Install" (one action) or "Save". For touch: native time and select pickers,
  full width on small screens, 44 px targets, and a scrolling dialog body so the focused field stays above the soft
  keyboard.
- **`pages/Automations.tsx` `ScheduleRow`**: for a schedule with `action.playbook`, "Edit" opens `BriefPlaybookDialog`
  instead of the generic wizard, and the row shows a "Playbook" badge.
- **`api/queries/briefPlaybooks.ts`** (new): list, install and patch; each invalidates the schedule list.
- **`pages/Ledger.tsx`**: honour `?entry=<id>` (scroll to the entry and highlight it), so rule links open the rule.
- Dev orgs: nothing is rendered, and the API also refuses (409 `business_only`).

## 5. Data model and API summary

- No migration, no new table, no new event type. New rows come only through the existing `WorkflowVersionRegistered`,
  `ProjectWorkflowsSet`, `ScheduleCreated`/`ScheduleUpdated`/`ScheduleDeleted` and `ScheduleRunRecorded`.
- Additive shared changes: `workflows/brief.ts`, `schedules/brief-playbooks.ts`, optional `create_card.playbook`,
  optional `CardOutput.links`, `BUSINESS_DUE_FIELDS`. No change to `CardType`, `ScheduleKind`, `ShiftBrief` or the role
  types, so Guildwise Cloud compiles as before.
- New API: `GET /api/brief-playbooks`, `POST /api/brief-playbooks/:key/install`, `PATCH /api/brief-playbooks/schedules/:id`.
  Errors: 403, 409 `business_only`, 409 `playbook_installed`, 400 `project_required`, 409 `brief_workflow_invalid`,
  400 `not_a_playbook`, plus the existing `invalid_cron` / `invalid_timezone` and GWP-32's destination errors.

## 6. Acceptance criteria → design → tests

| AC | Design | Tests (builder; new files only) |
| --- | --- | --- |
| 1. Install each playbook in one action, choosing destinations | 4.3.2 install, 4.4 dialog | Server `brief-playbooks.test.ts`: a manager of a business org installs each playbook with two destinations. Expect one schedule with a cron trigger in the org's zone, `action.playbook`, `template.workflowKey = business-brief-<role>`, `deliverOutput.destinations` (and `secretEnc` for a webhook), and the Brief workflow registered and enabled on the project with `defaultCardTypes: []`. A second install → 409 `playbook_installed`; a member → 403; a dev org → 409 `business_only` and no rows. Web `brief-playbooks.test.tsx`: the section is hidden in a dev org; the install dialog posts the chosen time/role/destinations in one request. |
| 2. Scheduled, run-now or test run → report card runs Brief, output reaches each destination | 4.3.3, 4.3.4, 4.3.5, 4.3.6 | Server: `fireDueSchedules` at the cron time creates a `report` card at stage `brief`, `scheduled`, with fields `requirements`, `maxWords`, `context`, `period`. An agent of the owner role (hire the GWP-33 role) claims it. A `done` report with a valid note → `status='done'` → `sweepEventTriggers` records one delivery run per destination (mocked mail/webhook/runner) whose text is the brief plus the Links block. The same through `runScheduleNow`. `testSchedule` returns one result per destination. Also assert a dev custom workflow ending through `StageCompleted` in a schedule with `deliverOutput` still sends nothing (unchanged). E2E (tester, `e2e/**`): install Morning plan in a business org, Run now, and the brief arrives at a local test webhook. |
| 3. Names real cards and rules, links them, within the cap | 4.3.3, 4.3.4, 4.3.5, 4.1.5 | Server `brief-context.test.ts`: the due-today/overdue/done/stuck/new/decisions/needs-owner lists from seeded cards and ledger entries; only the schedule's project; the playbook's own report cards excluded; the 12 000-character cap. `brief-check.test.ts`: a note over the cap, an unknown ref, an unknown rule id, and a note without refs when the Context lists cards are each refused; a valid note is accepted. Shared `brief-output.test.ts`: with `links`, email/webhook/sheet carry absolute URLs for each cited ref and rule, and WhatsApp keeps the brief; without `links`, the outputs equal today's. |
| 4. Brief passes `validateCustomWorkflow`, no repo/branch/merge stage | 4.1.2 | Shared `brief-workflow.test.ts`: for each role in `BRIEF_OWNER_ROLES`, `validateCustomWorkflow(briefWorkflow(role), BUSINESS_ROLES, ctx)` has no errors; `workflowUsesRepos` is false; no stage has `worktree≠none`, `environment≠none`, `rebaseBefore`/`syncMainBefore`, `requireBuildEvidence`, kind `server`, a finalize step, or an outcome event other than `StageCompleted`/`CardSpecified`. Shared `brief-playbooks.test.ts`: `briefPlaybookCron` passes `assertCronAndZone` (workdays `* * 1-5`, weekly Monday), and the templates parse with `CardTemplateSchema`. Server: the brief for a Brief card has `repoless`, `completionAction: null`, and `fieldLabels` without `context`/`requirements`. |
| 5. Edit time/destination/role or remove → next run | 4.3.2 patch, delete; 4.3.6 | Server: a new time moves `next_fire_at`; a new role makes `ensureBriefWorkflow` register the new key and the next fired card uses it; new destinations → the next delivery goes only to them; a new cap → the next card's `maxWords`; delete, or pause, while a card is in flight → the card finishes and nothing is delivered. Existing schedule tests stay untouched and green (refactor in 4.3.1). |

Dev orgs unchanged: the server tests above also assert that a dev org gets no `business-brief-*` rows, that
`/api/brief-playbooks` refuses, and that existing `schedules*`, `schedule-output*`, `shifts*` and prompt tests pass
without changes.

## 7. Risks and traps

- **Research file content.** The file is readable now, but it has no playbook table, cap or requirements text. Use
  4.1.1. The requirements text is the card's own lists, not invented copy. Name the inferred defaults (owner roles,
  weekly time, caps) in the handoff.
- **"Playbook" name clash** with the existing `/` playbooks: keep code names `BriefPlaybook*` and routes
  `/api/brief-playbooks`. Say in the handoff that the UI word "Playbooks" is shared with Capabilities.
- **Shared hot paths**: the `shifts.ts` check, the `executeAction` hook, the `handleEvent` line, the `cardOutput` case
  and the `fieldLabels` filter must all be gated on `isBriefWorkflowKey` / `action.playbook`, so dev cards never reach
  them.
- **Do not widen `card_done`** to `StageCompleted` for all workflows, and do not emit `CardFinalized` for Brief cards
  (3.4).
- **Refactor of `createSchedule`/`patchSchedule`**: behaviour must stay identical. Do not edit existing test files
  (runner flag `out_of_scope_test_change`, ledger 901a6d34, bd3b1486); add new test files only.
- **No agent of the owner role hired**: the card waits in `brief`. The install dialog should say "Hire a <role> to run
  this playbook" when the org has no active agent of that role, but still allow the install.
- **WhatsApp**: GWP-32 cuts the text at 500 characters. A 150-word Morning plan can be longer, so WhatsApp gets the
  start of the brief and the card link. That is GWP-32's agreed behaviour; do not change the limit here.
- **Context size and privacy**: lists are capped; only the schedule's project and the org's own ledger and desk are
  read; desk item titles only, no bodies; nothing from outside the org.
- **E2E belongs to the tester** (ledger aadf93f9, 3c469f98): builders do not edit `e2e/**`.

## 8. Assumption review (31 Oct 2026, against the landed GWP-30, GWP-32, GWP-33)

| # | Assumption | Result | What the landed code shows → design change |
| --- | --- | --- | --- |
| 1 | `CardType` has `report`; due fields `dueDate`/`remindOn`/`dueBy`/`deadline`/`validUntil` | Holds | `BUSINESS_CARD_FIELDS` in `workflows/business.ts` uses exactly these names. |
| 2 | Repo-less brief applies to every `report` card whatever its workflow | Holds | `isBusinessCardType(card.card_type)` gates `repoless`, `fieldLabels` and `completionAction: null`. Related correction (4.3.7): the landed Details section would duplicate `context`/`requirements`, so filter `fieldLabels` for Brief cards. |
| 3 | GWP-30 exposes a helper to register an org workflow and enable it on a project | **Does not hold** | `businessWorkflowEvents`/`ensureBusinessWorkflows` work only on the fixed `BUSINESS_WORKFLOWS` list. `ensureBriefWorkflow` appends `WorkflowVersionRegistered` and `ProjectWorkflowsSet` itself, with GWP-30's payload shape and validation (4.3.2 step 5). |
| 4 | `create_card.deliverOutput` (1-5 destinations, shared schema) and a web destination editor | Holds | `DeliverOutputSchema`/`OutputDestinationSchema` in shared; `OutputSection` + `buildOutputs`/`draftsFrom` in the web. The install request takes `destinations`, and the server wraps them and handles `secretEnc`. |
| 5 | GWP-32 delivers on `card_done` from the last agent handoff note, with a per-card hook for the text | **Does not hold** | No hook: `cardOutput()` is the single builder. More important: `card_done` fires only on `CardFinalized`/`QaPassed`/`QaSkipped`, and a Brief card ends through `StageCompleted` into a terminal stage, so it would never deliver. Added the gated `handleEvent` call (4.3.6, option 3.4), a Brief case in `cardOutput()` (4.3.5) and the optional `CardOutput.links` rendered by the formatters (4.1.5). |
| 6 | `testSchedule` tests each destination of a `create_card` with `deliverOutput`; delivery skips a deleted or disabled schedule | Holds | `testOutputDeliveries` (one run per destination, `sampleOutput`); `queueOutputDeliveries` reads `WHERE id=$1 AND enabled`, and delete removes the row. No playbook-specific test path is needed. |
| 7 | GWP-33's seven roles are built in, offered in business orgs, and can take extra `claimableStages` with a version bump | **Does not hold (simpler)** | The roles are built in and offered in business orgs, but they already claim `{ workflowKey: '*', stageId: '*' }`. No role edit and no version bump (4.2). `BRIEF_OWNER_ROLES` comes from the role table's Brief entries (4.1.1) and is enforced by the install schema. |
| 8 | GWP-27 provides `isBusinessOrg` (server) and `useBusinessMode` (web) | Holds | `isBusinessOrg` is in shared, the server has `assertBusinessOrg` (409 `business_only`, which the design now uses instead of `business_mode_only`), and the web has `useBusinessMode()`. |
