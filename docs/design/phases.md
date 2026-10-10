# Design: named phases, post-phase follow-ups, and the BA as the manager's reporter

Oct 5, 2026 · status: Part A and Part B implemented (see "Implementation status" at the end) · companion to `docs/SPEC.md`, `docs/ARCHITECTURE.md` (referenced as §n)

Part A (phases and follow-ups) is the feature the owner decided. Part B (the BA as the manager's reporter) is the broader role that phases are the first instance of; it ships separately, after Part A, and reuses Part A's BA task queue.

Note: `apps/runner/src/adapters/claude-policy.ts`, `claude-code.ts` and `packages/shared/src/roles/builtin.ts` were being changed (DevOps shifts unsandboxed) while this was written. Steps that touch `builtin.ts` must be rebased onto that work. This design assumes DevOps shifts run on the workstation with the user's own Docker and SSH credentials, as the current `DEVOPS_INSTRUCTIONS` already say.

---

## 0. Decision summary

| Decision | Chosen | Rejected alternatives (one line each) |
| --- | --- | --- |
| Where phase state lives | New `phases` and `phase_followups` projections fed by `events/phase.ts` events on stream `phase-<id>`, plus `cards.phase_id` | A "phase card" on a new workflow: it would clutter the board, needs claims and stages, and a card cannot hold a list of other cards. Ledger tags: these carry no state machine. |
| How a card joins a phase | A column on the card (`cards.phase_id`, `cards.phase_assignment` `proposed`/`confirmed`), changed by `CardPhaseChanged` on the card stream | A join table: "at most one phase per card" is a column. |
| How the BA proposes and the manager confirms | The BA creates a `proposed` phase and proposed card assignments during intake, then submits one desk approval `phase_proposal`. The manager approves it (`PhaseConfirmed`) or rejects it. | Confirming per card: too many desk items. Confirming in chat: not recorded on the desk, and the spec says decisions go on the desk. |
| Completion detection | `phasePass()`, a sweep in each dispatcher pass, like `unparkPass()` in `dispatcher/bottleneck.ts`. It is state based and idempotent; the phase row is locked with `FOR UPDATE`. | Detecting in every command that can end a card (finalize result, cancel, manual move, reassignment): about 6 call sites to keep in step. Detecting in a projector: projectors must not append events (§3.3). |
| BA background work | A new non-card queue, `ba_tasks`, with a new shift kind `ba_task`, dispatched by `baTaskPass()`. It is modelled on `devopsPass()` and `questionPass()`: one at a time per BA agent, outside card capacity, with a system fallback when no BA takes the task. | Reusing Finalize: Finalize is a card stage claimed through `candidateCards`, and a phase has no card to claim. A BA shift per follow-up result: costs tokens for a state change that is deterministic. |
| Who sequences follow-ups | The server, deterministically (strict order, `onFailure` stop/continue). The BA writes the delegation brief for each follow-up once, after approval, and writes the two notices. A BA shift runs again only for `custom` follow-ups the BA does itself. | The BA re-deciding after every result: several shifts per phase for no new judgement, and nothing to fall back on when no BA is online. |
| Deploy targets | Project-level `deploy_targets` rows: name, kind `local_docker` or `remote_ssh`, the workstation whose DevOps engineer deploys, host alias, app URL and notes. No secrets: SSH keys and config stay on the workstation. | Free text in each follow-up: no reuse, no validation, and the tester cannot be pinned to the right workstation. Workstation-level targets: targets are per project (compose file, URL). |
| Regression follow-up | Reuse `regressionRunEvents()` (regression cards queued at Test). Cards carry `phaseFollowupId`; a local target pins them to the deploy workstation (`CardCreated.homeWorkstationId`) and passes the app URL as `fields.targetUrl`. | A new test-run entity: the regression card path already exists, including evidence, `FullSuitePassed`/`FullSuiteFailed` and bug cards. |
| Ordering model | Strictly sequential list with `onFailure: 'stop' \| 'continue'` per item | A dependency graph (`dependsOn`): more than the stated need ("regression after deploy"). |

---

## Part A: Phases and post-phase follow-ups

### A1. Concepts and definitions

- **Phase**: a named slice of one project's work, for example "Phase 2: autosave". Its ref is `<PROJECTKEY>-P<n>` (for example `WEB-P2`), with `n` taken from `projects.next_phase_number`.
- **Member card**: a card with `phase_id = phase.id`. A card belongs to at most one phase, which must be in the same project. Assignment is `proposed` (the BA suggested it and the manager has not confirmed it) or `confirmed`.
- Only cards of the project's own workflow can be members: origin `manual` or `intake`, or a standalone bug card. Suite and regression cards (`isSuiteOrigin`) and bug children that share a worktree (`worktree_card_id` set) are refused: they ride on their parent card.
- **Assignment is editable** while the card is not terminal (`status NOT IN ('done','cancelled')`) and both the old and the new phase are `proposed` or `open`.

**What "resolved" means for a member card (phase completion):**

| Card end state | How the card got there | Counts as | Shown in the report as |
| --- | --- | --- | --- |
| `status='done'` with `finalized_at` set (`CardFinalized`) | Completion action ran: `merge` (merge commit), `push_branch` (pushed branch), `pr` (PR opened) | resolved | `finalized` with `resultRef`. For `pr`, it is also listed as **outstanding: PR not merged** (the site cannot see GitHub, and the BA sandbox has no GitHub login) |
| `status='done'` without `CardFinalized` (`CardMovedByManager` to `done`) | The manager closed it by hand | resolved | `closed_manually` (no completion action ran) |
| `status='cancelled'` (`CardCancelled`) | Withdrawn or cancelled | resolved, delivers nothing | `cancelled` with its reason |
| anything else (`draft`, `queued`, `claimed`, `blocked`, `waiting`, including `waiting` on `finalize_state` `awaiting_approval` or `running`) | | not resolved | |

A finalize that is running or waiting for a large-merge approval is **not** resolved: the completion action has not run yet.

**Phase completion rule** (pure function `phaseCompletion(cards)` in `packages/shared/src/phases/index.ts`): a phase in `open` is complete when

1. it has at least one confirmed member, and
2. it has no `proposed` assignments (the BA is still adding cards), and
3. every confirmed member is resolved.

A phase whose members were all cancelled still completes. The report then says "nothing delivered" and recommends rejecting the follow-ups (see open question A-Q4).

Completion does not wait for the post-finalize full E2E suites (spec: they never block). The BA's report lists their state: passed, failed with bug ref, or still running. Bug cards that a suite spawns after finalize are not added to the phase; the report lists them.

### A2. State machines

**Phase** (`phases.status`):

```
                    (BA in intake)                      (manager)
 PhaseCreated ──► proposed ──PhaseConfirmed──► open ◄──── PhaseCreated{status:'open'}
                     │                          │  ▲
       PhaseProposalRejected                    │  └──── PhaseReopened (manager; from reporting|awaiting_approval)
                     ▼                          │
                 discarded          PhaseCompleted (phasePass; BaTask phase_report queued)
                                                ▼
                                           reporting ──PhaseReportPosted (BA, or system fallback)──► awaiting_approval
                                                                                                         │
                     ┌────────────────────PhaseFollowupsRejected (manager)─────────────────────────────┤
                     ▼                                                                                   │ PhaseFollowupsApproved (manager)
             followups_rejected                                                                          ▼
                                                     (empty list: straight to done)              running_followups
                                                                                                         │ PhaseFollowupsFinished (phasePass)
                                                                                                         ▼
                                                                  reporting_results ──PhaseResultsReported (BA / fallback)──► done | done_with_failures
```

- `proposed` phases never complete; their cards count only once the manager confirms.
- With an empty follow-up list, the "phase done" desk item is an `alert` (acknowledge). Acknowledging it appends `PhaseFollowupsApproved{followups:[]}` and `PhaseFollowupsFinished{status:'done'}` in one append. There is no second notice.
- The follow-up list is editable in `proposed`, `open`, `reporting` and `awaiting_approval`. It is frozen from `running_followups` on (owner: "editable until the phase completes"; the manager may still edit while deciding). Approving snapshots the current list into the `PhaseFollowupsApproved` payload.
- `PhaseReopened` is allowed only before approval. It supersedes the open desk item (`DeskItemResolved` with resolution `dismissed`, note "phase reopened") and cancels a queued `phase_report` task.

**Follow-up** (`phase_followups.status`):

```
pending ──(phase approved)──► queued ──PhaseFollowupBriefed──► briefed ──PhaseFollowupStarted──► running ──PhaseFollowupFinished──► succeeded | failed
   │                                                                                                         ▲
   └── phase rejected ──► cancelled        queued/briefed ── an earlier one failed with onFailure 'stop' ──► skipped
```

- Follow-ups start strictly in `position` order, one at a time. The next one starts when the previous is `succeeded`, or `failed` with `onFailure: 'continue'`. A failure with `onFailure: 'stop'` marks every later follow-up `skipped`.
- Defaults: `deploy` is `stop`; `regression` and `custom` are `continue`.
- `briefed` means the BA wrote the delegation text and picked the delegate (`devops` | `tester` | `ba`). Without a BA, the system writes a template brief (see A5.4).

### A3. Data model: migration `apps/server/migrations/NNNN_phases.sql`

> Migration number: use the next free number at build time (1300 is taken by transcripts, the loop breaker takes the next one, and interests reserves 1500).

Numbering follows the post-M10 pattern (`1100_`, `1102_`, `1103_`, `1200_`): one hundred-block per feature. Part B gets `1400_`.

```sql
-- Named phases of a project, their post-phase follow-ups, deploy targets and the BA's background task queue
-- (docs/design/phases.md). Projections of the Phase*, DeployTarget*, ProjectFollowupDefaultsSet and BaTask* events.
ALTER TABLE projects
  ADD COLUMN next_phase_number integer NOT NULL DEFAULT 1,
  ADD COLUMN default_followups  jsonb   NOT NULL DEFAULT '[]';   -- FollowupSpec[] that pre-fills new phases

CREATE TABLE deploy_targets (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES users(id),
  project_id     uuid NOT NULL REFERENCES projects(id),
  name           text NOT NULL,                                   -- "local", "staging"
  kind           text NOT NULL CHECK (kind IN ('local_docker','remote_ssh')),
  workstation_id uuid NOT NULL REFERENCES workstations(id),       -- whose DevOps engineer deploys (and tests, for local)
  host           text,                                            -- remote_ssh: SSH host alias from ~/.ssh/config, no secrets
  app_url        text,                                            -- where the deployed app answers (testers use it)
  notes          text NOT NULL DEFAULT '',                        -- how to deploy: compose file, script, env name
  created_by     uuid NOT NULL REFERENCES users(id),
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX deploy_targets_name ON deploy_targets (project_id, lower(name)) WHERE removed_at IS NULL;

CREATE TABLE phases (
  id                     uuid PRIMARY KEY,
  org_id                 uuid NOT NULL REFERENCES users(id),
  project_id             uuid NOT NULL REFERENCES projects(id),
  number                 integer NOT NULL,
  ref                    text NOT NULL,                           -- WEB-P2
  name                   text NOT NULL,
  description            text NOT NULL DEFAULT '',
  status                 text NOT NULL CHECK (status IN ('proposed','open','reporting','awaiting_approval',
                           'running_followups','reporting_results','done','done_with_failures',
                           'followups_rejected','discarded')),
  created_by_kind        text NOT NULL CHECK (created_by_kind IN ('user','agent')),
  created_by_user_id     uuid REFERENCES users(id),
  created_by_agent_id    uuid REFERENCES agents(id),
  intake_id              uuid REFERENCES intakes(id),             -- the intake the BA proposed it in
  proposal_desk_item_id  uuid,
  report_desk_item_id    uuid,                                    -- "phase done, approve follow-ups"
  results_desk_item_id   uuid,                                    -- "follow-ups finished"
  card_outcomes          jsonb NOT NULL DEFAULT '[]',             -- snapshot from PhaseCompleted
  report                 text,                                    -- BA summary (markdown)
  outstanding            jsonb NOT NULL DEFAULT '[]',             -- [{kind:'pr_open'|'suite_failed'|'suite_running'|'bug'|'other', text, cardId?, url?}]
  results_report         text,
  completed_at           timestamptz,
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  finished_at            timestamptz,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  UNIQUE (project_id, number)
);
CREATE UNIQUE INDEX phases_name ON phases (project_id, lower(name)) WHERE status <> 'discarded';
CREATE INDEX phases_active ON phases (status) WHERE status IN ('open','running_followups');

CREATE TABLE phase_followups (
  id                  uuid PRIMARY KEY,
  phase_id            uuid NOT NULL REFERENCES phases(id),
  position            integer NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('deploy','regression','custom')),
  target_id           uuid REFERENCES deploy_targets(id),       -- deploy: required; regression: optional (run against it)
  platform            text CHECK (platform IN ('web','mobile','both')),
  instruction         text NOT NULL DEFAULT '',                 -- custom: required; others: optional extra note
  on_failure          text NOT NULL CHECK (on_failure IN ('stop','continue')),
  status              text NOT NULL CHECK (status IN ('pending','queued','briefed','running','succeeded','failed','skipped','cancelled')),
  delegate            text CHECK (delegate IN ('devops','tester','ba')),
  brief               text,                                     -- the delegation text the BA wrote
  devops_request_id   uuid REFERENCES devops_requests(id),
  regression_card_ids uuid[] NOT NULL DEFAULT '{}',
  ba_task_id          uuid,
  result_summary      text,
  evidence            jsonb NOT NULL DEFAULT '{}',              -- {requestId?, threadId?, cardRefs?, testRunIds?, bugCardIds?, links?[]}
  mock                jsonb,                                    -- AOM_MOCK_UI only: script copied to regression cards
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  UNIQUE (phase_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX phase_followups_request ON phase_followups (devops_request_id) WHERE devops_request_id IS NOT NULL;

ALTER TABLE cards
  ADD COLUMN phase_id         uuid REFERENCES phases(id),
  ADD COLUMN phase_assignment text CHECK (phase_assignment IN ('proposed','confirmed')),
  ADD COLUMN phase_followup_id uuid;                            -- regression cards a follow-up created (never members)
CREATE INDEX cards_phase ON cards (phase_id) WHERE phase_id IS NOT NULL;
ALTER TABLE cards ADD CONSTRAINT cards_phase_pair CHECK ((phase_id IS NULL) = (phase_assignment IS NULL));

-- BA background queue (non-card work: phase reports, follow-up briefs, custom follow-ups; Part B adds floor reports).
CREATE TABLE ba_tasks (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES users(id),
  project_id  uuid REFERENCES projects(id),
  phase_id    uuid REFERENCES phases(id),
  followup_id uuid REFERENCES phase_followups(id),
  kind        text NOT NULL CHECK (kind IN ('phase_report','followups_brief','followup_custom','followups_report')),
  status      text NOT NULL CHECK (status IN ('queued','running','done','failed','fallback','cancelled')),
  preferred_agent_id uuid REFERENCES agents(id),               -- the intake's BA, if any
  agent_id    uuid REFERENCES agents(id),                      -- set on dispatch
  shift_id    uuid,
  attempts    integer NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX ba_tasks_queue ON ba_tasks (created_at) WHERE status = 'queued';

ALTER TABLE shifts DROP CONSTRAINT shifts_kind_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_kind_check CHECK (kind IN ('card','chat','question','devops','ba_task'));
ALTER TABLE shifts ADD COLUMN ba_task_id uuid;
CREATE INDEX shifts_ba_task ON shifts (ba_task_id) WHERE ba_task_id IS NOT NULL;

-- Phase threads (thread id = phase id): agent comments and system notes on follow-up progress.
ALTER TABLE threads DROP CONSTRAINT threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check CHECK (kind IN ('card','chat','devops','intake','phase'));
```

The builder must check the real names of the `shifts.kind` and `threads.kind` CHECK constraints in `0008_shifts_threads.sql`; they are unnamed, so Postgres calls them `shifts_kind_check` and `threads_kind_check`, unless a later migration already replaced them.

Add every new table to the truncate list in `apps/server/src/projections/index.ts` / `rebuild.ts`, so the replay test covers it. On rebuild, reset `ba_tasks.status = 'running'` to `queued` (operational, like leases).

### A4. Events: `packages/shared/src/events/phase.ts`

Stream `phase-<phaseId>` (add `streamId.phase`); BA tasks use `ba-task-<taskId>` (add `streamId.baTask`); deploy targets use `project-<id>`; `CardPhaseChanged` goes on `card-<id>` so it shows in the card timeline. Audience is `project` for all of them (scope `projectScope(org, project)`). Each event is listed in `events/index.ts` with a one-line spread.

Shared schemas (`packages/shared/src/phases/index.ts`):

```ts
export const FollowupOnFailure = z.enum(['stop', 'continue']);
const base = { id: z.uuid().optional(), note: z.string().max(4000).default('') };
export const FollowupSpecSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('deploy'), targetId: z.uuid(), onFailure: FollowupOnFailure.default('stop') }),
  z.object({ ...base, kind: z.literal('regression'), platform: RegressionPlatform.default('web'),
             targetId: z.uuid().optional(), onFailure: FollowupOnFailure.default('continue'),
             mock: MockScriptSchema.optional() /* AOM_MOCK_UI only */ }),
  z.object({ ...base, kind: z.literal('custom'), instruction: z.string().min(1).max(4000),
             onFailure: FollowupOnFailure.default('continue') }),
]);
export const FollowupListSchema = z.array(FollowupSpecSchema).max(10);
export const PhaseStatus = z.enum([...]);  FollowupStatus = z.enum([...]);  FollowupDelegate = z.enum(['devops','tester','ba']);
export const PhaseCardOutcome = z.object({ cardId: z.uuid(), ref: z.string(), title: z.string(),
  outcome: z.enum(['finalized','closed_manually','cancelled']), action: CompletionAction.optional(),
  resultRef: z.object({ mergeCommit, prUrl, pushedBranch }).partial().optional(), reason: z.string().optional() });
export const PHASE_DESK_SUBKIND = { proposal: 'phase_proposal', done: 'phase_done', results: 'phase_results' } as const;
export function phaseCompletion(cards: Array<{status, finalizedAt, assignment}>): 'incomplete' | 'complete';
export function nextFollowup(list): { start?: id; skip: id[]; finished: boolean; failed: boolean };
export const phaseRef = (projectKey: string, n: number) => `${projectKey}-P${n}`;
```

| Event | Payload | Projection effect |
| --- | --- | --- |
| `PhaseCreated` | `{phaseId, projectId, number, ref, name, description, status:'proposed'\|'open', createdBy: DeskActor, intakeId?, followups: FollowupSpec[] (ids filled)}` | insert `phases` + `phase_followups` (status `pending`); `projects.next_phase_number + 1` |
| `PhaseUpdated` | `{phaseId, changes:{name?, description?}, by: DeskActor}` | update |
| `PhaseFollowupsSet` | `{phaseId, followups: FollowupSpec[] (with ids), by: DeskActor}` | replaces the `pending` rows (delete + insert, keeping ids); only in editable states |
| `CardPhaseChanged` | `{cardId, phaseId: uuid\|null, previousPhaseId?: uuid, assignment:'proposed'\|'confirmed'\|null, by: DeskActor}` | `cards.phase_id/phase_assignment`; one `card_activity` row (`kind 'phase'`) |
| `PhaseProposalSubmitted` | `{phaseId, deskItemId, proposedCardIds[], newPhase: boolean}` (with `DeskItemCreated` approval `phase_proposal` in the same append) | `proposal_desk_item_id` |
| `PhaseConfirmed` | `{phaseId, by, confirmedCardIds[]}` | status `open` (if it was `proposed`); listed cards: assignment `confirmed` |
| `PhaseProposalRejected` | `{phaseId, by, reason?, clearedCardIds[], discard: boolean}` | `discard`: status `discarded`; listed cards: `phase_id` NULL |
| `PhaseCompleted` | `{phaseId, cardOutcomes: PhaseCardOutcome[], baTaskId}` (with `BaTaskQueued` in the same append) | status `reporting`, `card_outcomes`, `completed_at` |
| `PhaseReportPosted` | `{phaseId, deskItemId, report, outstanding[], by: DeskActor (agent, or system for the fallback)}` (+ `DeskItemCreated` `phase_done`) | status `awaiting_approval`, `report`, `outstanding`, `report_desk_item_id` |
| `PhaseReopened` | `{phaseId, by, reason}` (+ `DeskItemResolved` dismissed on the open item; `BaTaskCompleted{status:'cancelled'}` if a report task is queued) | status `open`, clears `completed_at`/`card_outcomes` |
| `PhaseFollowupsApproved` | `{phaseId, by, deskItemId, followups: FollowupSpec[] (snapshot), baTaskId?}` (+ `BaTaskQueued` kind `followups_brief` when the list is non-empty) | status `running_followups` (or stays until `PhaseFollowupsFinished` for the empty list); follow-ups `queued`; `approved_by/at` |
| `PhaseFollowupsRejected` | `{phaseId, by, deskItemId, note?}` | status `followups_rejected`; follow-ups `cancelled` |
| `PhaseFollowupBriefed` | `{phaseId, followupId, delegate, brief, by: DeskActor}` | follow-up `briefed`, delegate, brief |
| `PhaseFollowupStarted` | `{phaseId, followupId, delegate, devopsRequestId?, regressionCardIds?: uuid[], baTaskId?}` (the `DevOpsRequested` / `CardCreated`+`RegressionRequested` / `BaTaskQueued` is in the same append) | `running`, links, `started_at` |
| `PhaseFollowupFinished` | `{phaseId, followupId, status:'succeeded'\|'failed'\|'skipped', summary, evidence}` | status, `result_summary`, `evidence`, `finished_at` |
| `PhaseFollowupsFinished` | `{phaseId, status:'done'\|'done_with_failures', baTaskId?}` (+ `BaTaskQueued` `followups_report` when follow-ups ran) | status `reporting_results` (or `done` directly for the empty list) |
| `PhaseResultsReported` | `{phaseId, deskItemId, report, finalStatus:'done'\|'done_with_failures', by}` (+ `DeskItemCreated` `phase_results`) | status = `finalStatus`, `results_report`, `results_desk_item_id`, `finished_at` |
| `ProjectFollowupDefaultsSet` | `{projectId, followups: FollowupSpec[], changedBy}` | `projects.default_followups` |
| `DeployTargetAdded` / `DeployTargetUpdated` / `DeployTargetRemoved` | `{targetId, projectId, name, kind, workstationId, host?, appUrl?, notes}` / `{targetId, changes}` / `{targetId}` | `deploy_targets` |
| `BaTaskQueued` | `{taskId, projectId?, phaseId?, followupId?, kind, preferredAgentId?}` | insert `ba_tasks` queued |
| `BaTaskDispatched` | `{taskId, shiftId, agentId, workstationId}` | running, agent, shift; insert `shifts` row (`kind 'ba_task'`), like `QuestionShiftDispatched` |
| `BaTaskRequeued` | `{taskId, reason}` | queued, `attempts + 1` |
| `BaTaskCompleted` | `{taskId, status:'done'\|'failed'\|'fallback'\|'cancelled', note?}` | status |

Additive changes to existing events (old events stay valid):

- `CardCreated` gains `homeWorkstationId?: uuid` (sets `home_workstation_id`, so a regression card runs where the local stack was deployed) and `phaseFollowupId?: uuid`. `projections/cards.ts` sets both columns.
- `DeskItemCreated` needs no change. The phase items use `kind 'approval'` (`phase_proposal`, `phase_done`) or `kind 'alert'` (`phase_done` with no follow-ups, `phase_results`), with `projectId` set and `askedBy {kind:'agent', agentId: BA, role:'ba'}` (or `system` for the fallback).
- Card fields (`cards/fields.ts` `CodeFieldsSchema`): `targetUrl?: string` (http(s), validated with `safe.ts`) and `deployTarget?: string` (name), for regression cards. Rendered in the tester's prompt.
- `CardDraftSchema` (`intake/index.ts`) gains `phase?: string` (a phase ref `WEB-P2` or a phase name in the draft's project): the assignment is created as `proposed`.

### A5. Commands, authorization and flows

New files: `apps/server/src/commands/phases.ts` (manager and BA commands), `commands/phase-followups.ts` (delegation and result mapping), `commands/ba-tasks.ts` (task reports and shift end), `dispatcher/phases.ts` (`phasePass`) and `dispatcher/ba-tasks.ts` (`baTaskPass`).

#### A5.1 Authorization (adds rows to §17.2)

| Action | Allowed for |
| --- | --- |
| Create phase, rename/describe, reopen | any active project member (owner or manager) |
| Assign or unassign a card | anyone who may edit the card (card owner or project owner, `loadManageable`) |
| Edit a phase's follow-ups, project default follow-ups, deploy targets | project owner |
| Confirm or reject a BA phase proposal (`phase_proposal`) | project owner. A shared project's members see the item but cannot act (`canAnswerItem` for project-level items) |
| Approve, reject or acknowledge `phase_done`; acknowledge `phase_results` | project owner |
| A deploy target's workstation | must be one of the project owner's own active workstations (v1; see open question A-Q9) |
| BA (agent) via `aom phase ...` | the org's BA, in an intake chat about the project, or in a `ba_task` shift for that phase only |

Every route uses the existing guards (`requireProjectMember`, `requireProjectOwner`, `loadManageable`). Every list query joins the visibility predicate (§17.1). The two-user isolation suite gets phase cases.

#### A5.2 Manager flow (REST)

- `createPhase(ctx, user, projectId, {name, description?, followups?})`: `followups` defaults to `projects.default_followups`. Validation: each `targetId` is a live target of the project; `custom` has an instruction. It appends `PhaseCreated{status:'open'}`.
- `setPhaseFollowups`: only in editable states (phase row `FOR UPDATE`). An open "phase done" item is not rewritten: the desk renderer reads the current list live from the phase, and approval snapshots it.
- `assignCard(ctx, user, cardId, phaseId|null)`: card and phase rows `FOR UPDATE`. It checks the editable rule (A1) and the member-card rule, then appends `CardPhaseChanged{assignment:'confirmed'}`. 409 codes: `card_terminal`, `phase_not_open`, `wrong_project`, `not_a_member_card`.
- `reopenPhase`: allowed in `reporting` and `awaiting_approval`.
- Desk resolve (`commands/desk.ts closeItem`) gets one branch per subkind, calling `resolvePhaseDeskItemIn(ctx, tx, user, item, resolution, note)`:
  - `phase_proposal`: `approved` → `PhaseConfirmed`; `rejected` → `PhaseProposalRejected{discard: newPhase}`.
  - `phase_done` approval: `approved` → `PhaseFollowupsApproved` (snapshot of the current list) + `BaTaskQueued(followups_brief)`; `rejected` → `PhaseFollowupsRejected`.
  - `phase_done` alert (empty list): `acknowledged` → approved-empty + finished `done`.
  - `phase_results`: `acknowledged` only (no domain effect).
  - `dismissed` on a `phase_done` item counts as reject, so a phase can never sit open without a desk item.

#### A5.3 BA proposal flow (intake chat)

These are chat-scoped RPCs. Add them to `INTAKE_METHODS` in `runner-gateway/handlers.ts` and to `CHAT_RPC` in `apps/runner/src/chat/chat.ts`; `commands/intake.ts intakeRpc` dispatches them to `commands/phases.ts`.

1. `phase.list {project?}` lists the project's phases (ref, name, status, follow-ups, member count) and the deploy targets.
2. `phase.propose {project?, name, description?, followups?}`: if an `open`/`proposed` phase with that name exists, the BA reuses it (an existing phase is returned, never duplicated). Otherwise `PhaseCreated{status:'proposed', createdBy: BA, intakeId}`, with follow-ups defaulting to the project defaults.
3. `card.create`/`card.update` with `phase: "<ref|name>"` → `CardPhaseChanged{assignment:'proposed'}` in the same append as the `CardCreated`/`CardUpdated`.
4. `phase.assign {card, phase|null}` for existing cards (proposed).
5. `phase.submit {phase}` → `PhaseProposalSubmitted` + one `DeskItemCreated(approval, phase_proposal)`. The body lists the phase (new or existing), the proposed cards and the proposed follow-ups. Re-submitting while an item is open supersedes the old item (`DeskItemResolved dismissed`, note "superseded by a newer proposal").

The manager can edit the proposed phase's name and follow-ups on the phase page before approving. Approval confirms exactly the cards listed in the item that are still proposed for this phase.

#### A5.4 Completion and follow-up orchestration: `dispatcher/phases.ts phasePass(ctx)`

`Dispatcher.pass()` calls it **first** (before card claims, `devopsPass`, `questionPass` and the new `baTaskPass`), so requests, cards and tasks it creates are dispatched in the same pass. `TRIGGER_TYPES` gains `CardCancelled`, `CardPhaseChanged`, `PhaseConfirmed`, `PhaseReopened`, `PhaseFollowupsApproved`, `PhaseFollowupBriefed`, `PhaseFollowupFinished`, `BaTaskQueued`, `BaTaskCompleted`, `FullSuitePassed`, `FullSuiteFailed` (`CardFinalized`, `CardMovedByManager` and `DevOpsRequestCompleted` are already there). It is wrapped in try/catch like `testingPass`.

Each step runs one `withAppendTx` per phase, locks the phase row with `FOR UPDATE`, and re-checks the status (idempotent: on a race the second pass sees the new status and does nothing).

1. **Completion**: `SELECT` the `open` phases where there is no member with `phase_assignment='proposed'`, at least one member, and no member with `status NOT IN ('done','cancelled')`. For each, append `PhaseCompleted{cardOutcomes}` and `BaTaskQueued{kind:'phase_report', preferredAgentId: intake BA}`. `cardOutcomes` comes from `cards` + `finalize_result`/the latest `CardFinalized` payload (`resultRef`).
2. **Start**: for phases in `running_followups` with no `running` follow-up, take `nextFollowup(list)`:
   - Skip ids → `PhaseFollowupFinished{status:'skipped', summary:'skipped: <ref of failed follow-up> failed'}`.
   - The next `briefed` item → `startFollowup()` in `commands/phase-followups.ts`:
     - `devops` (deploy, or custom delegated to DevOps): `createDevOpsRequestIn(ctx, tx, {workstationId: target.workstation_id (custom: the first deploy target's workstation, else the project owner's DevOps-equipped workstation most recently seen), summary: brief, requestedBy:{kind:'agent', id: BA id, name} (system when fallback)})` + `PhaseFollowupStarted{devopsRequestId}`. `devops_requests.card_id` stays NULL. The DevOps thread is linked from the phase page through `phase_followups.devops_request_id`.
     - `tester` (regression): `regressionRunEvents(tx, project, {platform, ownerUserId: project owner, requestedBy: approver, actor: system, scheduled: true, startedBy: 'Phase <ref> follow-up'})`. It is extended with `extra: {homeWorkstationId?, phaseFollowupId, fields:{targetUrl?, deployTarget?, context: brief, mock?}}`. A local target pins the cards to `target.workstation_id`; a remote target only sets `targetUrl`. `scheduled: true` lets the run jump the queue and use the overflow rule, so a phase is not stuck behind normal work.
     - `ba` (custom the BA does itself): `BaTaskQueued{kind:'followup_custom', followupId}`.
   - If the next item is still `queued` (not briefed), nothing happens: the `followups_brief` task is pending.
3. **Results**: for `running` follow-ups, map the delegate's state:
   - DevOps request `done` → `succeeded` (summary = `result_summary`; evidence: `{requestId, threadId, commands from environment_changes}`). `failed` → `failed`. `needs_approval`, `queued`, `running` → still running (the DevOps approval is the manager's own desk item).
   - Regression cards: all `status='done'` → the latest `test_runs` row per card decides. All `passed` → `succeeded`; any `failed` → `failed`, with evidence of `testRunIds`, bug card ids/refs from `BugReported`, and the evidence summary. Any card `cancelled` → `failed` ("regression run cancelled").
   - BA custom: set by the BA's report (A5.5), not here.
4. **Finish**: when every follow-up is terminal, append `PhaseFollowupsFinished{status: any failed ? 'done_with_failures' : 'done'}` + `BaTaskQueued{kind:'followups_report'}`.
5. **BA task fallback** (no agent ever blocks): for `queued` BA tasks older than `BA_TASK_STALL_MS` (15 min), or immediately when the org has no active BA agent, or after `MAX_ATTEMPTS = 2` failed shifts, the system does the task deterministically:
   - `phase_report` / `followups_report`: a template report from `card_outcomes`, `outstanding` and the follow-up rows (`renderPhaseReportFallback` in `shared/phases`), posted as `PhaseReportPosted`/`PhaseResultsReported` by `system`. The body starts with "Your BA was not available; this summary was generated."
   - `followups_brief`: a template brief per follow-up (`renderFollowupBriefFallback`: target, notes, app URL, phase cards, "report the deployed commit and URL in devops-done"), delegate by kind (deploy → devops, regression → tester, custom → devops).
   - `followup_custom`: `PhaseFollowupFinished{status:'failed', summary:'no BA was available to carry out this instruction'}`.
   - Each appends `BaTaskCompleted{status:'fallback'}`.

Why this ordering satisfies "nothing runs before approval": only `PhaseFollowupsApproved` moves follow-ups out of `pending`, and `phasePass` starts only `briefed` follow-ups of `running_followups` phases.

#### A5.5 BA task queue: `dispatcher/ba-tasks.ts baTaskPass(ctx, skipAgent)`

This is a copy of the `questionPass` structure:

- **Candidates**: `ba_tasks` with status `queued`, ordered by `created_at`.
- **Agent choice**: `preferred_agent_id` if it is active and online, else any active `role_key='ba'` agent of the org whose scope covers the project (`project_id IS NULL OR project_id = task.project_id`), online with its runtime available, ordered by `last_shift_ended_at NULLS FIRST`.
- **Concurrency**: one `ba_task` shift per agent at a time (`busy` set + `SELECT 1 FROM shifts WHERE agent_id=$1 AND kind='ba_task' AND status<>'ended'`). It does not count against card capacity, like question shifts. A BA in a Finalize card shift can still take a BA task, because the chat and question kinds already run alongside card work.
- **Dispatch**: `BaTaskDispatched` in a `withAppendTx` with the task row `FOR UPDATE`, then `buildBaTaskShiftStart(ctx, taskId, shiftId)` (new `runner-gateway/ba-task-brief.ts`) and `runners.send(ws, 'shift.start', payload)`.
- **Stale shifts**: `endStaleShifts` handles `kind='ba_task'` (max shift 30 min + 10 min slack), like question shifts.

Protocol (`protocol/runner.ts`): `ShiftStartSchema.kind` gains `'ba_task'` and `baTask?: BaTaskShiftSchema`:

```ts
export const BaTaskShiftSchema = z.object({
  taskId: z.uuid(), kind: z.enum(['phase_report','followups_brief','followup_custom','followups_report']),
  phase: z.object({ id, ref, name, description, status, projectKey }),
  cards: z.array(PhaseCardOutcome.extend({ suite: z.object({ ref, status, result: z.enum(['passed','failed','running']).optional(), bugRefs: z.array(z.string()) }).optional() })),
  followups: z.array(z.object({ id, position, kind, target: DeployTargetDto.nullable(), platform, instruction, onFailure, status, delegate, brief, resultSummary, evidence })),
  followupId: z.uuid().optional(),       // followup_custom
  openPrs: z.array(z.object({ ref, url })),
});
```

The brief carries a placeholder card, like DevOps shifts (`brief.card` = the phase rendered as a pseudo card). There is no worktree; `cwd` is the agent scratch directory. The vault is the project's domain vault, read-only, as for question shifts. The runner supervisor treats `ba_task` like `question` (no worktree, no rebase, no guard beyond `mayCommit:false`). The prompt is `renderBaTaskPrompt(brief.baTask)` in a new `packages/shared/src/prompt/ba-task.ts`, wired into `aom card` in `aom-cli.ts` and into the supervisor's prompt choice.

Reports (outcome reports validated server-side in `commands/ba-tasks.ts applyBaTaskReport`, the same shape as `applyDevopsReport`; outcome ids and data schemas in `shared/phases`):

| Task kind | Non-terminal (RPC) | Terminal (`/v1/report`, outcome id → effect) |
| --- | --- | --- |
| `phase_report` | `thread.read`, `card.get` (any member card by ref, read-only), `ledger.search` | `phase_report {report, outstanding[]}` → `PhaseReportPosted` + desk item, `BaTaskCompleted done` |
| `followups_brief` | `phase.followup.brief {position, to: devops\|tester\|ba, text}` → `PhaseFollowupBriefed` (validates: deploy → devops, regression → tester, custom → any) | `phase_ready {note}` → refused with the missing positions unless every queued follow-up is briefed; then `BaTaskCompleted done` |
| `followup_custom` | as `phase_report` | `followup_done {summary, links[]}` / `followup_failed {summary}` → `PhaseFollowupFinished` |
| `followups_report` | as `phase_report` | `phase_results {report}` → `PhaseResultsReported` + desk item |

The BA may also use `comment` (posted to the phase's activity, stored as a phase timeline entry via `ThreadMessagePosted` on a phase thread; see A6). Questions are refused in BA task shifts ("put what the manager must decide into the report"). A shift that ends with no terminal report → `BaTaskRequeued` (rejected, lost, stopped) or `attempts + 1` and requeue (no_report, crashed, timeout). After `MAX_ATTEMPTS` the fallback in A5.4 takes over. This is `endBaTaskShift`, added next to `endDevopsShift` and wired into `commands/shifts.ts` and the reaper the same way.

#### A5.6 Desk items (rendering content)

- `approval/phase_proposal`. Title: "Confirm phase WEB-P2: autosave (3 cards)". Body: the BA's description, the cards (ref, title), the follow-ups. Actions: Approve, Reject. There is a link to edit the phase first.
- `approval/phase_done`. Title: "WEB-P2 autosave is done: approve 3 follow-ups?". Pinned: no; blocking: no (nothing else waits). Body = the BA report. Structured data comes from `GET /api/desk` via a `phase` block on `DeskItemDto` (`phaseId`, `ref`, card outcomes with merge commits/PR links, outstanding, live follow-up list). Actions: Approve all, Reject, Edit follow-ups (inline editor, the same component as on the phase page), Reopen phase.
- `alert/phase_done` when there are no follow-ups: Acknowledge.
- `alert/phase_results`. Title: "WEB-P2 follow-ups finished: 2 succeeded, 1 failed". Pinned when any failed. Body = the BA results report plus a table per follow-up: status, summary, evidence links (DevOps thread, regression card refs, bug card refs, URLs). Action: Acknowledge.

Add `PHASE_DESK_SUBKIND` labels to `SUBKIND_LABEL` in `apps/web/src/lib/desk.ts`.

### A6. Phase timeline and threads

A phase gets a thread for agent comments and system notes, so the BA's working notes and "follow-up 1 started: DevOps request …" are readable. Add `'phase'` to `threads.kind` (the CHECK constraint, changed in `NNNN_phases.sql`; and the `api/threads.ts` enum). The thread id is the phase id (the DevOps pattern, where `thread_id = requestId`), with `card_id` NULL; `PhaseCreated`'s projector creates it. `phasePass` posts a `system` message on each follow-up start and finish.

### A7. Remote host target configuration

- **Where**: per project, in `deploy_targets`, managed on the project settings page by the project owner (A5.1). Rationale: a target is "this app's staging": compose file, URL and host are project facts. The workstation reference says whose DevOps engineer, and therefore whose SSH keys and Docker, does it.
- **What is stored**: `name`, `kind`, `workstation_id`, `host` (an SSH host alias as in `~/.ssh/config`, or `user@host` without a password; validated with `safe.ts` rules: no spaces, no leading `-`), `app_url` (http(s)), `notes` (free text: "`docker compose -f deploy/compose.staging.yml up -d` in `/srv/app`; env file lives on the host"). **No credentials, ever**: the DevOps engineer uses the workstation user's own SSH agent and keys (unsandboxed DevOps shift).
- **How the DevOps request reads**: the brief the BA writes (or the fallback template) contains target name/kind/host/app URL/notes, the phase ref and its finalized cards (merge commits), the working branch to deploy, and "finish with `aom devops-done --summary` that states the deployed commit and the URL you verified". Anything destructive still goes through `aom devops-approval` (the existing guardrail). A pending approval keeps the follow-up `running`.
- **Local Docker**: `kind='local_docker'` with the workstation; `host` is NULL; `app_url` is usually `http://localhost:<port>`.

### A8. `aom` CLI additions (`apps/runner/src/aom/aom-cli.ts`, one verb `phase`)

```
aom phase list [--project <KEY>]                                   BA intake/BA task: phases, follow-ups, deploy targets
aom phase propose --name "<name>" [--project <KEY>] [--description "<text>"] [--followups-file <json>]
                                                                   BA intake: propose a phase (or reuse the open one with that name)
aom phase assign <CARD-REF> --phase <WEB-P2|"name"> | --none       BA intake: propose putting a card in a phase
aom phase submit <WEB-P2>                                          BA intake: ask the manager to confirm the phase and its cards
aom phase followup brief <n> --to devops|tester|ba --text "<instructions>"   BA task (followups_brief): delegate follow-up n
aom phase ready --note "<text>"                                    BA task (followups_brief): all follow-ups briefed (terminal)
aom phase report --summary-file <md> [--outstanding "<item>"]...   BA task (phase_report): tell the manager the phase is done (terminal)
aom phase followup done <n> --summary "<text>" [--link <url>]...   BA task (followup_custom): you carried it out (terminal)
aom phase followup fail <n> --summary "<why>"                      BA task (followup_custom): it could not be done (terminal)
aom phase results --summary-file <md>                              BA task (followups_report): report the follow-up results (terminal)
```

- `card create` drafts accept `"phase": "WEB-P2"` (or the name).
- RPC methods added to `RpcMethodSchema`: `phase.list`, `phase.propose`, `phase.assign`, `phase.submit`, `phase.followup.brief`.
- Outcome ids added to `commandForOutcome`: `phase_report`, `phase_ready`, `followup_done`, `followup_failed`, `phase_results`.
- Add the lines to `USAGE`.

### A9. BA instructions (draft text for `BA_INSTRUCTIONS`, role `ba` version 6)

Changes to the existing text:

1. The opening becomes "...and background work (answering colleagues' questions, finalizing finished cards, and reporting phases to the manager)".
2. Intake step 4's draft list gains `phase (a phase ref or name, optional)`.
3. Add after intake step 7:

> 9. Group the work into a phase when the manager talks about a release, milestone or "phase" (or when the cards together deliver one thing the manager will want to ship and check as a whole). Look first: `aom phase list` shows the project's phases and deploy targets. Reuse an open phase that fits; otherwise propose one: `aom phase propose --name "<Phase n: what it delivers>" --description "<one paragraph>" --followups-file <followups.json>`. The follow-ups start from the project's defaults. Adjust them to what this phase needs: deploy to a named target (`{"kind":"deploy","targetId":"..."}`), a full regression run (`{"kind":"regression","platform":"web","targetId":"..."}`, after the deploy it should test), or a custom instruction (`{"kind":"custom","instruction":"..."}`). Order matters: they run one after the other, and a failed deploy stops the ones after it. Put each card you draft in it (`"phase": "<ref>"` in the draft, or `aom phase assign <REF> --phase <ref>`). When the cards are drafted, `aom phase submit <ref>`: the manager confirms the phase, its cards and its follow-ups on the desk. Tell the manager in the conversation what you proposed and why. Never propose deploy targets that do not exist; if one is missing, say so and ask the manager to add it in the project settings.

4. Add a new section:

> ## Phases (background)
> You are the manager's eyes on a phase. The server tells you when to act; you never wait or poll.
> - **Phase done** (`phase_report` task): every card of the phase is finalized, closed or cancelled. Write the manager a short report and post it with `aom phase report --summary-file <report.md> --outstanding "<item>"...`. Report: what was delivered (each card: ref, title, how it was finalized, merge commit or PR link), what was cancelled and why, and what is outstanding. Outstanding items: PRs not merged yet (a deploy from the working branch will not contain them; say so), full E2E suites that failed or are still running, bug cards they filed. Then the follow-ups that will run if the manager approves, in order, and anything that makes one of them doubtful. The manager approves, edits or rejects; nothing runs before that.
> - **Follow-ups approved** (`followups_brief` task): write the instruction each follow-up's delegate will work from, with `aom phase followup brief <n> --to <devops|tester|ba> --text "<instructions>"`, then `aom phase ready`. Deploys go to the DevOps engineer of the target's workstation: name the target, host, URL and the target's notes, what to deploy (the working branch at the phase's merge commits), and ask them to finish with the deployed commit and the URL they checked. Regression runs go to a tester: say what the phase changed, the URL to test against, and the platform. A custom instruction goes to whoever can do it: DevOps for anything on a machine, a tester for checks, or yourself (`--to ba`) for analysis or writing you can do read-only. The server runs them in order and comes back to you when they are finished.
> - **Custom follow-up** (`followup_custom` task): do what the instruction asks, read-only, and finish with `aom phase followup done <n> --summary "<what you did>" [--link <url>]` or `aom phase followup fail <n> --summary "<why not>"`.
> - **Follow-ups finished** (`followups_report` task): report each follow-up's result with its evidence (DevOps summary and commands, regression evidence, bug cards). Lead with failures, say what you recommend, and post it with `aom phase results --summary-file <report.md>`. A result that is marked succeeded but whose evidence does not show success (no URL checked, no deployed commit) is called out as doubtful.
> Never ask questions in these shifts. Anything the manager must decide goes into the report.

5. `TESTER_INSTRUCTIONS`, "Suite and regression cards": add "If the card has a `targetUrl`, run the suite against that URL (the deployed app), not a local dev server."

Version: BA `version: 5` → `6`, tester → next version. The owner sees "new default version" on the HR board (M9 flow). Coordinate with the concurrent `builtin.ts` change.

### A10. REST API (`packages/shared/src/api/phases.ts`, `apps/server/src/routes/phases.ts`)

| Method & path | Purpose | Who |
| --- | --- | --- |
| `GET /api/projects/:id/phases` | list: ref, name, status, counts (members, resolved), follow-up summary | member |
| `POST /api/projects/:id/phases` `{name, description?, followups?}` | create (open) | member (follow-ups other than the defaults: owner) |
| `GET /api/phases/:id` | detail: members with card status, card outcomes, follow-ups (with links), reports, desk item ids, thread id | member |
| `PATCH /api/phases/:id` `{name?, description?}` | edit | member |
| `PUT /api/phases/:id/followups` `{followups}` | replace the list (editable states only; 409 `followups_frozen`) | owner |
| `POST /api/phases/:id/reopen` `{reason}` | reopen before approval | member |
| `PUT /api/cards/:id/phase` `{phaseId: uuid\|null}` | assign or unassign (confirmed) | card editor |
| `GET/PUT /api/projects/:id/followup-defaults` | project default list | member / owner |
| `GET /api/projects/:id/deploy-targets` · `POST` · `PATCH /api/deploy-targets/:id` · `DELETE` | targets (a removed target used by a pending follow-up → 409 `target_in_use`) | member / owner |
| `GET /api/board?projectId=&phaseId=` | board filtered to a phase (`phaseId=none` = cards without a phase) | member |
| `GET /api/cards/:id` | gains `phase: {id, ref, name, status, assignment} \| null` | member |

Approvals go through the existing `POST /api/desk/:id/resolve`.

### A11. Web UI (`apps/web`)

- **Project page**: `pages/ProjectSettings.tsx` gains a "Phases" section (list with status chips + "New phase" dialog) and links to a new page `pages/Phase.tsx` at `/p/:projectKey/phases/:number` (add to `router.tsx`). It also gains "Deploy targets" (`components/DeployTargetsPanel.tsx`) and "Default follow-ups" (`components/FollowupEditor.tsx` in `mode='defaults'`).
- **Phase page**: header (ref, name, status, created by BA/manager), members table (ref, title, column, outcome, merge commit/PR), add/remove card (searchable select of the project's non-terminal member-eligible cards), `FollowupEditor` (ordered list: add deploy/regression/custom, reorder with up/down buttons, target select, platform, on-failure, instruction text; read-only after approval with live status and evidence links), reports (markdown), and the phase thread (reuse the `ChatPanel` message list read-only).
- **Board**: `BoardView.tsx` gains a phase filter select (All / each open phase / No phase) bound to the `phaseId` query param, and a small phase chip on each card (`BoardCardSchema.phase: {id, ref} | null`). There is no separate column: phases are orthogonal to stage columns. Swimlanes by phase are a later option.
- **Card detail**: `CardDetail.tsx` / `CardEdit.tsx` gain a Phase select (disabled with a reason when the card is terminal, the phase is not open, or the card is a suite/bug child). A "proposed" badge shows when the BA proposed it and it is not yet confirmed.
- **Desk**: `pages/Desk.tsx DeskItem` routes `phase_proposal`, `phase_done` and `phase_results` to `components/PhaseDeskItem.tsx` (renders A5.6; the Edit follow-ups button opens `FollowupEditor` in a Radix dialog and saves via `PUT /api/phases/:id/followups` before the Approve button is enabled again).
- **Live updates**: `ws/invalidate.ts` maps `Phase*` events → `['phases', projectId]`, `['phase', phaseId]`, `['board', projectId]`, `['desk']`; `CardPhaseChanged` → card + board + phase; `DeployTarget*` / `ProjectFollowupDefaultsSet` → `['project', id]`.
- MSW handlers in `apps/web/src/mocks/handlers-extra.ts` for the new routes.

### A12. Mock runtime support (token-free e2e)

`apps/runner/src/adapters/mock-agent.ts`:

- **`baTaskMain(brief)`**, dispatched from `main()` when `brief.shift.kind === 'ba_task'`, deterministic:
  - `phase_report`: builds markdown from `brief.baTask.cards` (and `openPrs` as outstanding) and runs `aom phase report --summary-file <tmp> --outstanding ...`.
  - `followups_brief`: for each queued follow-up runs `aom phase followup brief <n> --to <deploy→devops | regression→tester | custom: '[ba]' in instruction → ba, '[tester]' → tester, else devops> --text "mock brief: <instruction or target name> <note>"`, then `aom phase ready`. The follow-up's `note`/`instruction` is copied into the brief, so tokens reach the delegate: `[no_report]` and `[crash]` in a deploy note make the mock DevOps request fail (existing `devopsMain` behaviour), and needs-approval words trigger `devops-approval`.
  - `followup_custom`: `followup fail` when the instruction contains `[fail]`, else `followup done --summary "mock: did <instruction>"`.
  - `followups_report`: `aom phase results` with a per-follow-up line.
  - `[ba_no_report]` in the phase description: the mock ends without reporting (exercises retry and system fallback).
- **`intakeMain`**: the mock source JSON (`AOM_MOCK_SOURCES_DIR/<key>.json`) gains `phase?: {name, description?, followups?}` and per card `phase?: true`. The mock then runs `aom phase propose`, adds `"phase"` to the drafts and ends with `aom phase submit`.
- **Regression follow-ups**: `FollowupSpec.mock` (accepted only with `AOM_MOCK_UI=true`, like other mock fields) is copied to the regression cards' `fields.mock`, so the mock tester passes or fails the suite (`{"test":[{"action":"fail"}]}`).
- **Local deploy target in e2e**: a `local_docker` target on the e2e runner's workstation with `app_url` `http://localhost:4601`. The mock DevOps "deploy" calls `markEnvironmentFixed`, so the pinned regression card's environment check passes.

### A13. Test plan

**Shared (vitest)** in `packages/shared/test/phases.test.ts`:

- `phaseCompletion`: every row of the A1 table, empty phase, proposed pending, all cancelled.
- `nextFollowup`: order, stop/continue, skip propagation, finished/failed flags.
- `FollowupSpecSchema` round trip and defaults.
- Every new event schema round trip.
- `renderBaTaskPrompt` snapshot per task kind.
- `commandForOutcome` for the new outcome ids.

**Server (vitest + `aom_test`)**, new files in `apps/server/test/`:

- `phases.test.ts`: create/edit/list with defaults pre-fill; name uniqueness; assign/unassign rules (terminal card 409, cross project 409, suite card 409, one phase per card via reassign); follow-up edit freeze; deploy target validation (workstation not the owner's → 403, URL rules).
- `phase-proposal.test.ts`: BA intake RPCs (propose reuses by name, draft with `phase`, submit creates one desk item, resubmit supersedes); approve confirms only listed cards; reject discards a new phase and clears assignments; a member manager cannot resolve.
- `phase-completion.test.ts`: finalize `merge`/`push_branch`/`pr` (pr listed outstanding), `CardMovedByManager` to done, cancel. A large-merge awaiting approval does not complete. A proposed assignment blocks completion. Unassigning the last open card completes it. Two concurrent passes append `PhaseCompleted` once. Reopen before approval.
- `phase-followups.test.ts`: approval snapshot; nothing starts before approval; `followups_brief` task, brief, devops request on the target's workstation; DevOps done → next follow-up; regression cards pinned (`home_workstation_id`) with `targetUrl`; regression fail → `failed` with bug refs; deploy failure with `stop` skips the rest; `done_with_failures`; results desk item; empty list → alert → acknowledge → done.
- `ba-tasks.test.ts`: one `ba_task` shift per BA; preferred agent; no BA hired → immediate fallback; BA offline 15 min (test clock) → fallback; 2 no_report shifts → fallback; terminal report validation (`phase_ready` with unbriefed positions refused); questions refused; lost shift requeued.
- `phases-rebuild.test.ts`: replay equals live state for every new table (the pattern of `testing-rebuild.test.ts`).
- Extend `isolation.test.ts` (another user sees no phases, targets or tasks) and `migrate.test.ts`.

**Runner (vitest)**:

- `test/aom-cli-phase.test.ts`: arg parsing and IPC payloads for every `phase` sub-verb.
- `test/ba-task-shift.test.ts`: the supervisor starts `ba_task` without a worktree; the mock BA script against `fake-server.ts`.

**Web (vitest + testing-library)**: `test/phases.test.tsx` covers the FollowupEditor (reorder, validation, frozen view), board phase filter and chip, the card phase select disabled states, and the PhaseDeskItem actions.

**E2E (Playwright, mock runtime)**: `e2e/tests/phases.spec.ts`

1. Owner adds a `local_docker` target and default follow-ups (deploy, regression). Intake with a mock source carrying a phase and two cards. Confirm the phase on the desk. Both cards flow to Done (mock builder/reviewer/tester/BA finalize). The "phase done" desk item shows both cards with merge commits. Edit the follow-ups (add a custom `[ba]` item) and approve. The mock DevOps deploys, the regression card is claimed on that workstation and passes, and the BA does the custom item. The "follow-ups finished" item shows 3 succeeded.
2. Same setup with the deploy note `[no_report]`: the deploy fails and the regression is skipped; a pinned results item shows the failure.
3. Reject on the "phase done" item: nothing is requested from DevOps (assert the DevOps requests list is empty).

---

## Part B: The BA as the manager's reporter

The owner's framing: the BA is the manager's eyes and ears on the floor and is responsible for reporting to the manager. Phases (Part A) are the first instance. Part B generalizes it while keeping two rules: no agent blocks, and urgent blocking questions are never delayed. It ships after Part A and reuses `ba_tasks` and `baTaskPass`.

### B1. What the BA reports (signals)

Every signal comes from deterministic server-side detectors over the projections. They cost no tokens; the BA spends tokens only when a signal fires.

| Signal | Detector (data) | Default threshold | Urgency |
| --- | --- | --- | --- |
| **Shift loop** (today's case: a tester shift ended `no_report` about every 12 s for about 2 min, and the card bounced back to the queue each time) | `ClaimReleased{reason:'shift_failed'}` per card in a window; also `ShiftEnded.outcome IN ('no_report','crashed','timeout')` per agent | ≥ 3 on one card in 10 min, or ≥ 5 per agent in 10 min | urgent (it burns tokens) |
| **Repeated DevOps approval** (today: the same approval asked 6 times) | `DevOpsApprovalNeeded` per workstation with the same normalized `action` (`topicWords` overlap ≥ 0.6, from `hr/index.ts`) | ≥ 3 in 24 h, or a re-ask after the same action was approved or rejected | urgent if rejected before, else normal |
| **Stuck card** | blocked longer than N (`cards.blocked_since`); queued with workability not ok (`queries/workability.ts`) longer than 30 min; `waiting` on a DevOps park longer than 1 h; claimed with a shift running past `maxShiftMinutes` + slack | blocked > 4 h, unworkable > 30 min | normal |
| **Repeated failures** | `rework_round` ≥ 3; `FinalizeFailed` ≥ 2 on a card; ≥ 2 `BugReported` from one phase or one day; `RebaseConflict` ≥ 2 on a card | as stated | normal |
| **Existing system alerts** (already in code) | `TesterBottleneck` (`dispatcher/bottleneck.ts`, pinned per project), `schedule_failed` (HR), `finalize_failed`, `bug_reported`, `test_environment` hard stop, `outbound_failed`, `repo_create_failed`, `vault_conflict` | already raised | stay as they are; the BA adds context (B2) |
| **Phase milestones** | Part A | | as Part A |

Loop note: reporting a loop is not enough. The loop itself should be broken by the dispatcher: after `ClaimReleased(shift_failed)` ×3 in 10 min on a card, it stops re-claiming the card for an exponential backoff (a per-card `retry_after` column, honoured by `candidateCards`). That is a small separate fix, listed as step B0. It is independent of the BA and should ship first.

### B2. Routing: one consolidated voice without delaying anything

Today any agent's question reaches the desk through `raiseQuestion` (`commands/questions.ts`) and the escalation chain (peer → BA → desk, recorded in `desk_items.escalation_trail`; `aom answer`/`aom escalate` in question shifts). System alerts go straight to the desk (`DeskItemCreated`). DevOps approvals go straight to the workstation owner (`desk-port.ts raiseDeskItem`).

Recommendation: **annotate and consolidate; do not gatekeep.**

- **Blocking questions and approvals keep their current path, unchanged.** The escalation chain already lets the BA answer what it can before the desk, and it already moves on by itself after 10 minutes (`QUESTION_STALL_MS`). DevOps approvals, large merges and outbound approvals stay direct, because only the manager can decide them and a BA hop would only add latency.
- **The BA adds context to open items** instead of re-posting them. A new event `DeskItemAnnotated {deskItemId, note, by, relatedDeskItemIds[], signalId?}` and a `desk_items.ba_note` column. Example: on the 6th DevOps approval, "This is the 6th request for `docker compose up` on WS-1 in 24 h; granting `allowDocker` in the workstation's DevOps access would stop these." The desk shows the note under the item. Nothing is delayed, because annotation happens after creation.
- **Non-blocking system alerts can be merged by the BA.** When the BA's report covers several open non-blocking `alert` items (for example 4 `bug_reported` alerts from one regression run), it may supersede them with its report: `DeskItemResolved{resolution:'dismissed', note:'covered by BA report <id>'}` plus `status='superseded'` and a `superseded_by` column. Only `kind='alert'` with `blocking=false` and `pinned=false` may be superseded, so the manager can never lose a decision.
- Rejected: routing every desk item through the BA first. It delays urgent items by at least one BA shift, breaks when no BA is online, and duplicates the escalation chain.

### B3. Form of reports

- **Immediate desk notice** for urgent signals: `alert/ba_report` (pinned for loops), one per signal fingerprint while open. The body is the BA's analysis (what is happening, evidence links, a recommendation with one-click options where an existing action exists: "Stop the card" (release + manual move), "Grant Docker access", "Hire a tester").
- **Daily floor report**: one `alert/floor_report` desk item per org per day at `dailyAt` (default 08:00 in the user's timezone), and only if anything happened. It holds the non-urgent signals since the last report, phase states, and stuck work. It replaces nothing; it groups. The existing `digest_items` table is **not** reused: it holds feed-digest articles for rating (`DigestPosted` → rating desk items → `taste.md`) and has the wrong shape. The floor report reuses only the idea of one grouped desk item.
- **Chat**: each report also links to a standing "BA reports" chat thread with the BA (the existing chat, kind `chat`, created on first report). The manager can ask "why?" there. The desk item remains the record; the chat holds the discussion.
- **Frequency and quiet hours**: the spec says alerts are in-app only (no email or push), so quiet hours only control batching. Org setting `reporting: {dailyAt, timezone, quietHours?: {from, to}, urgentDuringQuiet: true}`. Inside quiet hours, normal signals wait for the next floor report. Urgent signals still post (they cost money while they run). Default: no quiet hours, daily report at 08:00.

### B4. How the BA gets the signals (no polling)

- **Detectors**: a server module `apps/server/src/reporter/detectors.ts` runs in a 60 s timer like the reaper (not in the dispatcher pass, to keep passes fast). Each detector is an SQL query plus a fingerprint (for example `loop:card:<id>`, `devops-approval:<ws>:<normalized action>`).
- **Persisted signals**: new table `ba_signals` (`id, org_id, project_id, kind, fingerprint, urgency, subject jsonb, evidence jsonb, first_seen_at, last_seen_at, count, status ('open','reported','resolved'), report_desk_item_id`) via `BaSignalRaised {signalId, ...}` / `BaSignalUpdated {signalId, count, lastSeenAt}` / `BaSignalResolved`. There is one open signal per fingerprint (dedup). The signal resolves itself when the condition clears; an open `alert/ba_report` is then resolved `acknowledged` with note "cleared", like the tester bottleneck.
- **Work for the BA**: an urgent signal queues `BaTaskQueued{kind:'floor_alert', signalIds}` at once. Normal signals accumulate, and the reporter timer queues `floor_report` at `dailyAt`, outside quiet hours. The BA shift's brief carries the signals with evidence. Its tools are read-only plus `aom report post --summary-file <md> [--supersede <deskItemId>]... [--annotate <deskItemId> --note "<t>"]...` (terminal). There is no question verb.
- **Fallback**: the same as Part A. With no BA within 15 min, the system posts the signal as a template alert, so the manager is never left uninformed.

### B5. Part B data and files (summary)

Migration `apps/server/migrations/1400_ba_reporter.sql`:

- `ba_signals`
- `desk_items` gains `ba_note`, `superseded_by`
- `users` (org owner) gains `reporting jsonb`
- `ba_tasks.kind` CHECK gains `floor_alert`, `floor_report`
- `ba_tasks` gains `signal_ids uuid[]`
- B0: `cards` gains `retry_after timestamptz`

Files:

- events: `events/reporter.ts` (`BaSignalRaised/Updated/Resolved`, `DeskItemAnnotated`, `ReportingPrefsChanged`)
- `reporter/detectors.ts`, `reporter/reporter.ts` (timer)
- `projections/reporter.ts`
- the `aom report` verb, plus `report.annotate` and `report.supersede` checks in `commands/ba-tasks.ts`
- BA instruction section "Reporting to the manager"
- web: the `ba_note` on `DeskItem`, `alert/ba_report` and `floor_report` renderers, a reporting prefs form in settings
- tests: `reporter-detectors.test.ts` (one fixture per detector plus a control fixture, as in `recommendations.test.ts`), `ba-reporter.test.ts`, `e2e/tests/reporter.spec.ts` (a mock tester `[no_report]` loop → pinned BA report and backoff)

---

## Risks

- **Token cost of BA tasks**: Part A uses 3 BA shifts per phase (report, briefs, results), plus one per BA-delegated custom item. Part B is bounded by fingerprint dedup and the daily batching.
- **Deploys from the working branch**: deploys use the working branch, so phases with `pr` cards deploy without unmerged PRs. The BA report must say so (it is in the instructions). Mitigation option: A-Q2.
- **Regression pinned to the local deploy workstation**: if that workstation has no tester agent, the card waits. The workability warning (`queries/workability.ts`) explains why, and Part B's stuck-card detector reports it. The phase-done report should warn when the target workstation has no tester (`phase.list` exposes it).
- **`builtin.ts` contention**: the concurrent DevOps change edits the same file. Land the instruction text last (step A9).
- **Desk resolve branches**: `closeItem` in `commands/desk.ts` keeps growing. Keep the phase branches in one `resolvePhaseDeskItemIn` call.

---

## Open questions (Part A), each with a recommended default

1. **A-Q1. Who may create and edit phases in a shared project?** Default: any active member creates phases and assigns cards they may edit. Follow-ups, deploy targets and approvals: project owner only, because deploys act on infrastructure.
2. **A-Q2. Should a phase wait for its PRs to be merged?** Default: no. The completion action ran, which is the owner's definition. Unmerged PRs are listed as outstanding and the report warns that a deploy will not contain them. Possible later: a per-phase "wait for PR merges" flag once something tracks PR state (the BA sandbox has no GitHub login).
3. **A-Q3. Do cards moved to Done by hand count?** Default: yes, as `closed_manually`, shown separately.
4. **A-Q4. A phase whose cards were all cancelled.** Default: it completes. The report says nothing was delivered and the desk item recommends Reject.
5. **A-Q5. Should completion wait for post-finalize full E2E suites?** Default: no (the spec says they never block). The report lists them as passed, failed (with bug refs) or still running.
6. **A-Q6. Bug cards filed after finalize (full-suite failures).** Default: not added to the phase automatically; listed in the report. The manager can put them in a later phase.
7. **A-Q7. Ordering.** Default: strictly sequential. `onFailure` defaults to `stop` for deploy and `continue` for regression and custom. No parallel follow-ups in v1.
8. **A-Q8. Does the BA judge each result, or does the server decide by status?** Default: the server decides by delegate status (DevOps `done`/`failed`, regression pass/fail). The BA's results report may call a "succeeded" result doubtful but does not change sequencing.
9. **A-Q9. Whose workstation may a deploy target use?** Default: only the project owner's own workstations in v1, because their DevOps engineer and their SSH keys do it and approvals route to them. Possible later: members' workstations, with the approval routed to that member.
10. **A-Q10. Can follow-ups be edited while the "phase done" item is open?** Default: yes. Approval snapshots the list. They are frozen once running (owner: "editable until the phase completes" is read as "until approved").
11. **A-Q11. Can a phase be reopened?** Default: yes, before approval only (`PhaseReopened`, the desk item is dismissed). Not after approval: create a new phase instead.
12. **A-Q12. No BA hired, or BA offline.** Default: the system fallback (template report and briefs) after 15 min, or immediately if the org has no BA. Custom follow-ups delegated to `ba` then fail with "no BA available".
13. **A-Q13. How does a tester's suite take the target URL?** Default: `fields.targetUrl` is rendered in the prompt and the tester instructions say to use it. The runner also exports `AOM_TARGET_URL` in tester shifts so Playwright configs can read it. The project's suite must honour a base-URL variable; if it does not, that is a card for the project.
14. **A-Q14. Board "phase column".** Default: a filter plus a chip, not a column, because stages own the columns. Swimlanes later if wanted.

## Open questions (Part B), each with a recommended default

1. **B-Q1. Thresholds** (loop 3 in 10 min; repeated approval 3 in 24 h; blocked 4 h; unworkable 30 min). Default as listed, kept in `shared/reporter` constants (org settings later).
2. **B-Q2. May the BA supersede system alerts?** Default: only non-blocking, unpinned `alert` items, always with a link back. Never questions or approvals.
3. **B-Q3. Should the BA annotate items in the escalation chain it already saw?** Default: no. The `escalation_trail` already shows its part.
4. **B-Q4. Daily report time and quiet hours.** Default: 08:00 local, no quiet hours (alerts are in-app only). Urgent signals ignore quiet hours.
5. **B-Q5. Loop breaker (B0).** Default: ship it independently of the BA. Per-card backoff 1, 2, 4… min (capped at 1 h) after 3 `shift_failed` in 10 min. The manager's "release" or "move" clears it.
6. **B-Q6. Should reports go to chat as well as the desk?** Default: the desk is the record; post a link in a standing BA chat thread so the manager can discuss there.

---

## Implementation plan (ordered, small steps; Part A first)

Each step ends green (`pnpm typecheck && pnpm lint && pnpm test`). Paths are relative to the repo root.

**Part A: phases (all 19 steps built, see "Implementation status")**

1. **Contract: schemas.**
   - Create `packages/shared/src/phases/index.ts` (FollowupSpec, statuses, `PhaseCardOutcome`, `PHASE_DESK_SUBKIND`, `phaseRef`, `phaseCompletion`, `nextFollowup`, fallback renderers, outcome ids and data schemas).
   - Export it from `packages/shared/src/index.ts`.
   - Add `streamId.phase` and `streamId.baTask` in `packages/shared/src/ids.ts`.
   - Tests: `packages/shared/test/phases.test.ts`.
2. **Contract: events.**
   - Create `packages/shared/src/events/phase.ts`.
   - Add the one-line registry entry in `events/index.ts`.
   - `CardCreated` gains `homeWorkstationId?` and `phaseFollowupId?` in `events/card.ts`.
   - `ShiftKind` gains `'ba_task'` in `events/shift.ts`.
   - Card fields gain `targetUrl` and `deployTarget` in `cards/fields.ts`, with labels.
   - `CardDraftSchema.phase` in `intake/index.ts`.
3. **Contract: protocol and API.**
   - `protocol/runner.ts`: `ShiftStart.kind` + `BaTaskShiftSchema`.
   - `protocol/ipc.ts`: RPC methods.
   - `prompt/commands.ts`: new outcome ids.
   - Create `prompt/ba-task.ts` (`renderBaTaskPrompt`).
   - Create `api/phases.ts` and register it in `api/index.ts`.
   - `api/board.ts`: `phase` chip and `phaseId` query.
   - `api/cards.ts`: `phase` on the detail.
   - `api/desk.ts`: optional `phase` block on `DeskItemDto`.
   - `api/threads.ts`: `'phase'` kind.
4. **Migration.** Create `apps/server/migrations/NNNN_phases.sql` (A3); update `apps/server/test/migrate.test.ts` if it lists versions.
5. **Projections.**
   - Create `apps/server/src/projections/phases.ts` (phases, follow-ups, deploy targets, defaults, ba_tasks, the phase thread).
   - `projections/cards.ts`: `CardCreated` new columns, `CardPhaseChanged` + `card_activity`.
   - `projections/shifts.ts`: `BaTaskDispatched` inserts the shift.
   - Register in `projections/index.ts` and the truncate list; operational reset in `projections/rebuild.ts`.
   - Test: `apps/server/test/phases-rebuild.test.ts`.
6. **Manager commands and routes.**
   - Create `apps/server/src/commands/phases.ts` (create, update, follow-ups, assign, reopen, defaults, deploy targets; authz per A5.1).
   - Create `apps/server/src/routes/phases.ts` and register it in `apps/server/src/app.ts`.
   - Create `apps/server/src/queries/phases.ts` (list, detail, board filter).
   - `queries/cards.ts`: board `phaseId` filter and chip.
   - Test: `apps/server/test/phases.test.ts`.
7. **BA intake RPCs.**
   - `commands/intake.ts`: `intakeRpc` cases `phase.*`, and `phase` in `createDraft`/`updateDraft`.
   - `runner-gateway/handlers.ts`: `INTAKE_METHODS`.
   - Proposal submit/resolve in `commands/phases.ts`.
   - Test: `apps/server/test/phase-proposal.test.ts`.
8. **Desk integration.**
   - `commands/desk.ts closeItem`: branch to `resolvePhaseDeskItemIn`.
   - `queries/desk.ts`: `phase` block on the DTO and `canAnswerItem` (owner only for phase subkinds).
9. **Completion sweep.**
   - Create `apps/server/src/dispatcher/phases.ts` with `phasePass` steps 1 (completion) and 4–5 (finish, fallback reports).
   - `dispatcher/dispatcher.ts`: call it first in `pass()`; extend `TRIGGER_TYPES`.
   - Test: `apps/server/test/phase-completion.test.ts`.
10. **BA task queue.**
    - Create `apps/server/src/commands/ba-tasks.ts` (`applyBaTaskReport`, `endBaTaskShift`, task RPCs).
    - Create `apps/server/src/dispatcher/ba-tasks.ts` (`baTaskPass`, stale shifts).
    - Create `apps/server/src/runner-gateway/ba-task-brief.ts`.
    - Wire `kind === 'ba_task'` into `commands/shifts.ts` (report, ended, rejected), `runner-gateway/handlers.ts` (RPC routing for ba_task shifts) and `dispatcher/reaper.ts`.
    - Test: `apps/server/test/ba-tasks.test.ts`.
11. **Follow-up orchestration.**
    - Create `apps/server/src/commands/phase-followups.ts` (`startFollowup`, `followupResult`).
    - `phasePass` steps 2–3.
    - `commands/regression.ts`: `regressionRunEvents` gains an `extra` arg (homeWorkstationId, phaseFollowupId, fields).
    - `commands/spawn.ts`: pass `homeWorkstationId` through.
    - Test: `apps/server/test/phase-followups.test.ts`.
    - Extend `isolation.test.ts`.
12. **Runner.**
    - `apps/runner/src/aom/aom-cli.ts`: `phase` verb + `USAGE`.
    - `apps/runner/src/chat/chat.ts`: `CHAT_RPC` additions.
    - `apps/runner/src/shifts/supervisor.ts`: `ba_task` like `question` (no worktree, prompt via `renderBaTaskPrompt`).
    - Tester shifts export `AOM_TARGET_URL` when `fields.targetUrl` is set.
    - Tests: `apps/runner/test/aom-cli-phase.test.ts`, `apps/runner/test/ba-task-shift.test.ts`.
13. **Mock runtime.** In `apps/runner/src/adapters/mock-agent.ts`: `baTaskMain`, intake phase support, regression `mock` pass-through (server side: accept `FollowupSpec.mock` only with `AOM_MOCK_UI`, `apps/server/src/commands/phases.ts`).
14. **Instructions.** `packages/shared/src/roles/builtin.ts`: BA text (A9) with version 6, and the tester line on `targetUrl`. Rebase on the concurrent DevOps change first. Update prompt snapshots.
15. **Web: data layer.** `apps/web/src/api/queries/phases.ts`, `ws/invalidate.ts` mappings, MSW handlers in `apps/web/src/mocks/handlers-extra.ts`.
16. **Web: project page.** `components/FollowupEditor.tsx`, `components/DeployTargetsPanel.tsx`, the Phases section in `pages/ProjectSettings.tsx`, a new `pages/Phase.tsx` and its route in `router.tsx`.
17. **Web: board, card, desk.**
    - `components/BoardView.tsx` (filter, chip).
    - `pages/CardDetail.tsx` / `components/CardEdit.tsx` (phase select).
    - Create `components/PhaseDeskItem.tsx`, routed from `pages/Desk.tsx`.
    - `lib/desk.ts` labels.
    - Test: `apps/web/src/test/phases.test.tsx`.
18. **E2E.** `e2e/tests/phases.spec.ts` (the 3 flows in A13), plus a mock source fixture with a phase.
19. **Docs.**
    - `docs/ARCHITECTURE.md`: §4.2 tables, §5.2 "Phases" events table, §9.2 pass order (`phasePass`, `baTaskPass`), §13.4 `aom phase`, §17.2 rows, §19 routes.
    - `docs/USER-GUIDE.md`: a "Phases and follow-ups" section.

**Part B: reporter (separately shippable, after Part A)**

- **B0. Loop breaker: implemented** (migration `1301_card_retry_backoff.sql`; events `CardRetryDeferred`, `CardRetryReleased`; test `apps/server/test/shift-loop-backoff.test.ts`; see ARCHITECTURE section 9.7). Original plan: (independent, can ship any time): `cards.retry_after` (in `1400_`, or a small `1301_card_retry_after.sql` if it ships before Part B), set by `commands/shifts.ts` on the 3rd `shift_failed` in 10 min (a new event `CardRetryDeferred{cardId, until, failures}`). `dispatcher/candidates.ts` honours it; a manager release or move clears it. Test: `apps/server/test/shift-loop-backoff.test.ts`.
- **B1. Contract**: `packages/shared/src/reporter/index.ts` (signal kinds, thresholds, prefs schema), `events/reporter.ts`, the `aom report` outcome ids, and `ba_tasks` kinds `floor_alert`/`floor_report`.
- **B2. Migration**: `1400_ba_reporter.sql`; `projections/reporter.ts`.
- **B3. Detectors and timer**: `apps/server/src/reporter/detectors.ts`, `reporter/reporter.ts` (60 s timer started in `main.ts` beside the reaper; queues tasks; daily report; quiet hours); fallback in `baTaskPass`. Test: `apps/server/test/reporter-detectors.test.ts`.
- **B4. BA side**: report, annotate and supersede handling in `commands/ba-tasks.ts`; the BA instruction section "Reporting to the manager"; the mock `floor_alert`/`floor_report` scripts. Test: `apps/server/test/ba-reporter.test.ts`.
- **B5. Web**: `ba_note` under desk items, the `ba_report`/`floor_report` renderers, the reporting prefs form, a link to the BA chat thread.
- **B6. E2E**: `e2e/tests/reporter.spec.ts` (a mock tester `[no_report]` loop → backoff + pinned BA report; repeated DevOps approval → annotation).

## Addendum: DevOps repository hygiene and the working branch (owner decisions, 2026-10-05)

- A scheduled DevOps job per workstation receives that workstation's project repositories (`workstation_repos` joined to
  `project_repos`: local path, remote, working branch). For each one it fetches and pulls, **commits any uncommitted
  changes to the working branch** and pushes, pushes unpushed commits, and prunes worktrees and agent branches of cards
  that are done. It logs with `aom devops-done`; whatever it cannot resolve becomes a BA reporter signal (Part B).
- **The working branch must be confirmed, never guessed.** `project_repos.working_branch` is empty today (TEST01).
  While it is unset, the DevOps agent does not commit or push to that repository; it asks the manager on the desk which
  branch is the working branch, and the answer is stored on the repo (event + projection; a ledger entry so later
  shifts do not ask again).
- **Re-confirm on change.** When a new intake starts for the project or a new phase is created/activated, the DevOps agent
  confirms the working branch with the manager (keep current or name a new one). A phase may carry its own working
  branch (`phases.working_branch`, defaulting to the repo's); the job uses the active phase's branch when there is one.
- Until confirmed, uncommitted changes are reported (not committed), so nothing lands on a branch the manager did not name.

## Owner decisions on the open questions (2026-10-05)

These override the recommended defaults above where they differ.

### Part A
| # | Decision |
|---|---|
| A1 | Any project member may do everything: create phases, assign cards, edit follow-ups and deploy targets, and approve. |
| A2 | **A phase waits until every card's work is merged into the project's working branch.** This is the internal working branch (see the working-branch addendum), not `main` on the Git server. A card finalized with `merge` counts at once. A card finalized with `pr` or `push_branch` counts once its branch is merged into the working branch, checked with git (the card branch's head is an ancestor of the working branch) by the workstation's runner or the DevOps repo-hygiene job. No GitHub PR status is needed. |
| A3 | Cards moved to Done by hand count, and are listed as "closed manually". |
| A4 | If every card was cancelled, the phase completes and the desk item recommends rejecting the follow-ups. |
| A5 | Completion does not wait for post-merge full suites; they are listed in the report. |
| A6 | **Bug cards filed after finalize join the phase automatically**, and the phase waits for them. |
| A7 | **Any failed follow-up stops the follow-ups after it** (deploy, regression and custom alike). |
| A8 | The server decides each result from its status; the BA may flag a result as doubtful. |
| A9 | **A "deploy to local stack" follow-up fans out to every workstation of every project member**: one DevOps request per workstation, each run by that workstation's DevOps engineer. The follow-up succeeds only when all of them succeed. Remote-host targets name their workstation as before. |
| A10/A11 | Follow-ups are editable until approval, then frozen. A phase can be reopened only before approval. |
| A12 | With no BA, or no BA within 15 minutes, the server posts template reports. A custom follow-up the BA was to do itself fails with "no BA available". |
| A13/A14 | Testers get the target URL in the card and as `AOM_TARGET_URL`. The board gets a phase filter and a chip on each card. |

### Part B
| # | Decision |
|---|---|
| B1 | Thresholds as recommended: loop = 3 failed shifts on one card in 10 min; repeated approval = 3 in 24 h; blocked > 4 h; unclaimed > 30 min. |
| B2/B3 | **Everything goes through the BA.** Every agent-raised desk item is routed to the BA first, and the BA decides what reaches the manager and in what form: consolidate, deduplicate, answer from the ledger, or escalate. **Urgent blocking questions and approvals still go straight to the manager, with no delay.** The BA annotates them afterwards. Design the routing so the BA never blocks an agent: an item the BA has not triaged within the urgency window reaches the manager unchanged. |
| B4 | Daily floor report at 08:00 local time, no quiet hours. Urgent notices are sent immediately at any hour. |
| B5/B6 | The loop breaker ships first: after 3 failures in 10 min the card backs off from 1 min, doubling to a 1 h cap, and the manager can release it by hand. Each report is a desk item linking to a standing BA chat thread. |

### Build order
1. Loop breaker (B0 implemented)
2. Phases and follow-ups (Part A)
3. BA reporter (Part B)
4. Scheduled DevOps repo hygiene with working-branch confirmation (addendum above)
5. The global Interests page (separate design)

## Addendum: worktree and branch cleanup once work is merged (owner decision, 2026-10-05)

Rule: a card's worktree and branch are removed as soon as its code is in the working branch. The runner does this
deterministically; agents do not have to remember it.

- **Today:** a successful finalize already enqueues `worktree.remove` (apps/server/src/commands/finalize.ts). The branch
  is deleted only for `merge`.
- **`pr` / `push_branch`:** the same git check that decides A2 (the card branch's head is an ancestor of the working
  branch) also removes the card branch, locally and, for `push_branch`, on the remote, once it is merged. That avoids a
  second mechanism.
- **Cards that end without a merge** (cancelled, moved to Done by hand, project archived, agent fired): the server
  enqueues `worktree.remove`. An unmerged branch is kept and listed in the BA's report.
- **Safety net:** the DevOps repo-hygiene job, and a runner sweep at start-up, remove worktrees under
  `~/.aom-runner/worktrees` whose card is finalized, cancelled or unknown to the server, plus empty project folders, and
  run `git worktree prune`.
- Agent instructions: builders, testers and reviewers never create worktrees outside the runner, and leave nothing
  behind in scratch that references a worktree.

## Implementation status (Part A, built Oct 5, 2026)

Built in the order of the implementation plan, migration `1303_phases.sql`:

| Steps | Where |
| --- | --- |
| 1-5 contract, events, migration, projections | `packages/shared/src/phases`, `events/phase.ts`, `apps/server/src/projections/phases.ts`, `apps/server/test/phases-rebuild.test.ts` |
| 6-8 manager commands, routes, BA intake RPCs, desk | `commands/phases.ts`, `commands/deploy-targets.ts`, `commands/phase-events.ts`, `routes/phases.ts`, `queries/phases.ts`; tests `phases.test.ts`, `phase-proposal.test.ts` |
| 9, 11 completion, merge check, follow-up orchestration | `dispatcher/phases.ts`, `commands/phase-followups.ts`; tests `phase-completion.test.ts`, `phase-followups.test.ts` |
| 10 BA task queue | `dispatcher/ba-tasks.ts`, `commands/ba-tasks.ts`, `runner-gateway/ba-task-brief.ts`; test `ba-tasks.test.ts` |
| 12-14 runner, mock, instructions | `aom phase`, `branch.check_merged` (`git/merged.ts`), `AOM_TARGET_URL`, `mock-agent.ts baTaskMain`, BA v6, tester v4 |
| 15-17 web | `pages/Phase.tsx`, `FollowupEditor`, `PhasesPanel`, `DeployTargetsPanel`, `PhaseDeskItem`, `CardPhase`, `PhaseFilter` |
| 18 e2e | `e2e/tests/phases.spec.ts` |
| 19 docs | ARCHITECTURE sections 4.2, 5.2, 9.8, 13.4, 17.2, 19; USER-GUIDE "Phases and follow-ups" |

Where the build differs from the text above (owner decisions of 2026-10-05 win):

- **A1**: every route needs only active project membership; there is no owner-only phase action. A remote deploy target's workstation may belong to any active member.
- **A2**: completion needs the working-branch merge, not just a completion action. New: `cards.merged_into_working_at`, `CardMergeVerified`, the runner command `branch.check_merged`, the manual `POST /api/cards/:id/confirm-merged`, and `phases.working_branch` (used by the check; the claim path still branches from the repository's working branch).
- **A6**: bug cards filed by a suite or a regression follow-up join the phase (`CardPhaseChanged.cause 'bug_filed'`); a phase waiting for its report or approval is reopened.
- **A7**: no per-item `onFailure`; any failure skips the rest.
- **A9**: `deploy_targets.workstation_id` is NULL for `local_docker`; `phase_followups.devops_request_ids` is an array; the regression card is pinned to a deployed workstation that has a tester.
- Added: phase status `cancelled` and event `PhaseCancelled` (archiving a project), `BaTaskRequeued.attempt`, desk item re-issue when the follow-up list changes between empty and non-empty while the report waits.
- The merge-check interval is `AOM_MERGE_CHECK_SECONDS` (default 180).

**Deferred** (listed in the addenda, not part of this step; built afterwards, see "Implementation status (repository hygiene ...)" below): the runner start-up sweep of stale worktrees and the DevOps repo-hygiene job (including the working-branch confirmation, the active phase's branch for hygiene and the BA reporter signals); the cleanup for "agent fired" (the card returns to the queue there, so nothing ends); the phase "wait for PR merges" flag (replaced by the git check).

## Implementation status (Part B, built Oct 5-6, 2026)

Migration `1304_ba_reporter.sql` (the design's `1400_ba_reporter.sql`, renumbered to the next free number). Built with the owner decisions B1-B6 of 2026-10-05; the first commit of the step fixed `rebuildProjections` so a rebuild keeps the non-projection `transcripts` table.

| Part | Where |
| --- | --- |
| Contract, thresholds (one `REPORTER` object), prefs, signals, digest, task data, template texts | `packages/shared/src/reporter`, `events/reporter.ts`, `prompt/reporter-task.ts` |
| Migration, projections | `migrations/1304_ba_reporter.sql`, `projections/reporter.ts`, `users` (timezone, reporting, standing chat, last report day), `desk_items` (ba_note, triage, data, chat_thread_id), `ba_signals`, `ba_tasks` (signal_ids, desk_item_ids, local_date) |
| Routing (B2/B3) | `eventstore/pg-event-store.ts` interceptor hook, `reporter/routing.ts`, `reporter/tasks.ts`, `commands/questions.ts` + `escalation.ts` (`via`) |
| Detectors, signals, sweep (B1, B4, B5) | `reporter/detectors.ts`, `reporter/reporter.ts` (60 s, `AOM_REPORTER_SECONDS`), `reporter/digest.ts` |
| BA tasks, fallback (B6) | `commands/reporter-tasks.ts`, `reporter/report-items.ts`, `dispatcher/ba-tasks.ts`, `runner-gateway/ba-task-brief.ts` |
| Settings | `commands/reporting.ts`, `routes/reporting.ts`; web `pages/Settings.tsx`, first-login time zone in `components/Layout.tsx` |
| Runner, mock BA, instructions | `aom report` verb, `mock-agent.ts reporterTaskMain`, BA instructions v7 ("Reporting to the manager") |
| Web | `components/BaNote.tsx` (BA note, triage hints, chat link, floor report sections), `lib/desk.ts` labels |
| Tests | server `ba-routing`, `reporter-detectors`, `ba-reporter`; shared `reporter`; runner `aom-cli-report`, `ba-task-shift`; web `reporter`; e2e `reporter.spec.ts` (`playwright test --project=reporter --no-deps`) |
| Docs | USER-GUIDE "Your BA reports to you", ARCHITECTURE §5.2, §9.9, §19, §22 |

Where the build differs from the text above (owner decisions win):

- **B2/B3 routing** is the "route everything through the BA" variant, not "annotate and consolidate". Urgent = blocking, pinned, any approval or escalation, and the loop alert; it is delivered unchanged and noted afterwards. Non-urgent alerts are held up to 10 minutes (`REPORTER.triageWindowMinutes`) for a `desk_triage` task; a blocking question skips the chain (`via 'desk'`) and a non-blocking one starts at the BA (`via 'ba'`), which is the existing escalation step with its own 10-minute stall. The setting is `users.reporting.routeViaBa` (default on), edited on the Settings page; the test helpers create users with it off.
- **B4** the report time is `users.reporting.dailyAt` (default 08:00) on the manager's `users.timezone` (browser-detected at first login, editable; UTC while unset). A report is skipped on a day with nothing to say, and an organization created after today's boundary waits for tomorrow's. There are no quiet hours; urgent notices are immediate.
- **B5** the loop breaker's alert is never held. The loop episode (`retry_failures >= 3` with `retry_after` set) is a signal; the BA's analysis is a note on that alert instead of a second item.
- **B6** `alert/floor_report` carries the digest in `desk_items.data`; `alert/ba_report` is used for urgent signals that have no alert of their own. Both link to one standing BA chat per organization owner.
- Signals use fingerprints per card (`loop:card:<id>`, `blocked:card:<id>`, ...) and per approval cluster. `finalize_failures` and `rework` are the "repeated failures" of B1; "stuck" is the blocked and unclaimed detectors.
- Reports go to the organization owner (org-level desk items). Other project members do not get a floor report.

**Deferred**: nothing from the owner decisions. Not built because the design left it open or optional: quiet hours (decided against), a per-project report, the supersede flag on `aom report` (the triage `merge` action covers it), org-level threshold settings (one constants object, as decided in B1).

## Implementation status (repository hygiene and the working branch, built Oct 6, 2026)

Migration `1305_repo_hygiene.sql`. Built with the owner decisions 1-6 of the hygiene addendum and the remaining part of the worktree cleanup addendum (the runner start-up sweep and the hygiene job's sweep).

| Part | Where |
| --- | --- |
| Contract (`HygieneSpec`, `HygieneReport`, sweep result, cadence, the working-branch question's ids) | `packages/shared/src/hygiene`, `events/hygiene.ts`, `ProjectRepoWorkingBranchSet` (`events/project.ts`), `DevOpsRequested.hygiene`, `QuestionRaised.triage/data`; protocol `worktrees.query` / `worktrees.live`, runner command `worktrees.sweep` |
| Stale-worktree sweep (owner decision 4) | runner `git/sweep.ts` (conservative: needs the server's answer and an empty outbox, never removes a running shift's worktree or one with uncommitted changes, branches are kept), `runner.ts` (15 s after the first connection, and the `worktrees.sweep` command); server `commands/worktree-sweep.ts` (live = card of this workstation not done or cancelled, or done with a finalize pending, or whose worktree a live card shares) |
| Hygiene git (decisions 1 and 2) | runner `devops/hygiene.ts`, verb `aom hygiene run` (ends the request with `devops_done` + the structured report); mock DevOps runs the same verb |
| Scheduled job, request, findings (decisions 1 and 5) | server `commands/hygiene.ts` (`hygieneSpecFor`, `requestHygiene`, `fireDueHygiene`, `hygieneReportEvents`, sweep result), `Scheduler.runHygiene`, projections `projections/hygiene.ts`, table `hygiene_findings`, `routes/devops.ts` (cadence, run now), `reporter/detectors.ts detectHygiene` (signal kind `repo_hygiene`) |
| Working-branch question and answer (decisions 2 and 3) | `workingBranchQuestionEvents`, `workingBranchAnsweredEvents` (hook in `commands/desk.ts answerDeskItem`), `commands/branch-confirm.ts` (intake, phase created or activated), routing hold in `reporter/routing.ts`, `PUT /api/projects/:id/repos/:repoId/working-branch` |
| Web (decision 5) | `DevOpsPanel` (cadence, Run hygiene now), `WorkingBranchControl` (project settings repository row), `WorkingBranchQuestion` (desk) |
| Tests | runner `sweep`, `hygiene` (real git); server `worktree-sweep`, `repo-hygiene`, `hygiene-schedule`, `hygiene-routing`; shared `protocol`; web `hygiene`; e2e `hygiene.spec.ts` (`playwright test --project=hygiene --no-deps`) |
| Docs | USER-GUIDE "Repository hygiene and the working branch", RUNNER.md "Stale-worktree sweep" and "Repository hygiene (DevOps)", ARCHITECTURE 5.2, 9.10, 11.2, 11.3, 16.2, 19, 22 |

Where the build differs from the text above (decisions of the task win):

- **The git work is deterministic runner code, not the model's.** The DevOps agent runs `aom hygiene run`; the model neither commits nor pushes. This keeps the "never commit to an unconfirmed branch" rule enforceable and makes the mock DevOps run the real thing. (The DevOps permission set denies the agent's own `git push`; the verb's push is the runner's.)
- **Unset branch:** the effective branch is the active phase's `working_branch`, else `project_repos.working_branch`; the project-level default (`main`) is not a fallback. A repository counts as confirmed when `project_repos.working_branch` is set: by the answer, by the project settings, or when the repository was added with a branch (including repositories created through `aom repo create`, which start on `main`).
- **The question is a `question` desk item** (`subkind working_branch`, asked by the project owner's DevOps engineer, no card, `routedTo manager`), not an approval or alert, so the standard answer form and ledger entry apply. Non-urgent ones are held for the BA's triage window like other non-urgent items (they are not routed to the BA as a question to answer, because a card-less question shift does not exist); a blocking one (changes are waiting) goes straight to the manager with the BA's urgent note.
- **Re-confirmation** asks only for repositories that already have a confirmed branch and are cloned on some workstation; an unconfirmed one is asked about by the hygiene run, with its branches. Not asked again within an hour of the last confirmation, nor while a question is open, nor for a phase that names its own branch. Naming another branch sets it on the repository (the phase's own `working_branch` is still set in the phase).
- **On another branch** hygiene never switches the user's checkout: it reports a dirty tree there, and only moves and pushes the working branch ref.
- **A hygiene request per workstation at a time**; a workstation with no clone of a project repository gets none (409 for "Run hygiene now"). Cadences: off, hourly, 6 h, 12 h, daily (default), weekly; the first scheduled run is one cadence after pairing.
- A confirmed answer for a repository that had none starts a `branch_confirmed` hygiene run on the workstations that hold it, so held-back work is committed at once.
- **The DevOps engineer prepares a workstation (2026-10-10, Track E items 1, 3, 4).** As built, see docs/RUNNER.md "Repository setup, toolchain and rights" and docs/ARCHITECTURE.md "Workstation setup". (1) A repository added in Project settings is cloned onto the project's workstations by `repo.clone` (first repository folder; an existing clone is reported, a non-empty foreign folder is never touched; "Create a new repository" creates it with `gh` on one workstation through the existing `RepoCreator`, others clone afterwards; state per workstation shown as Cloning / Cloned on X / Failed: reason with a retry). (3) `env.ensure` detects the stacks from a data-driven table (`apps/runner/src/toolchain/stacks.ts`: .NET, .NET MAUI with the right workloads per OS, Node and its package manager, Python, Docker, Go, Rust, Java, Ruby, PHP), verifies each tool and installs what is missing within the rights the manager ticked; `project_environments` gates the project's builder and tester cards per workstation until `ready` (a project with no row is never gated, so nothing existing is held back; the row appears when a project repository first shows up on a workstation). (4) `rights.verify` proves each ticked right on the machine (verified/failed badge with reason and fix); the sudo password is encrypted in the browser with the runner's RSA key (`hello.sudoKey`), relayed by the server as ciphertext, kept on the runner (`secrets/sudo.enc`, 0600), redacted from logs and used only through `sudo -S` on stdin (the toolchain installer and `aom sudo -- <cmd>` for the DevOps engineer). Decisions for the owner: creating a repository from the settings page skips the desk approval that `aom repo create` needs; the sudo design (browser-side RSA-OAEP versus an OS keychain); gating by builder/tester claim role; the first-run environment check of existing projects on a newly paired workstation.
- **A working branch the clone does not have is created (2026-10-10, Track E item 2; supersedes the ask-first flow below).** `ensureWorktree` no longer rejects at once: when the base branch exists neither locally nor on `origin` it creates it from the repository's default branch (`origin/HEAD`, else the only branch, else `main`/`master`; `createWorkingBranch` in `apps/runner/src/git/worktrees.ts`), pushes it with upstream (`push -u origin base:base`; a refused push deletes the local branch again) and tells the server with `shift.started.branchCreated{base, from, pushed}`; the server posts a system note on the card thread ("Created working branch X from Y and pushed it to origin") and the shift's progress shows it. Only when no default can be told, or the creation or push fails, does the runner send the rejection below, now with `branchProblem.createFailed` (the question says the runner tried and why it failed). The confirmed branch setting is not touched. Earlier text:
- **A confirmed or unset working branch the clone does not have (2026-10-09).** A repository added without a branch stays unset; the dispatcher still hands a card the project's branch as its base, so the runner can tell: `shift.rejected{worktree_failed, branchProblem:{base, defaultBranch?, branches}}` (`defaultBranch` = `origin/HEAD`, else the only branch). The server raises one `working_branch` question per repository (deduplicated by the open-question check; system-asked and pinned, linked to the card, the default or only branch as the recommendation), holds the card back with `rejectionBackoffEvents` (1 min, doubling, cap 1 h; the agent's 30 s dispatcher cooldown still applies) and stores `cards.last_rejection` through `ClaimReleased.rejection`. Workability shows it as "Last attempt failed: ..." with a link to the repository settings; it is cleared by `ShiftStarted` and by `ProjectRepoWorkingBranchSet` (which also ends the back-off). The confirmed branch is never changed by this; the answer is the manager's.
- `AOM_HYGIENE_SCHEDULE=false` turns the scheduled job off (the e2e stack, whose specs move the clock by days); "Run hygiene now" works regardless.

**Deferred**: nothing from the owner decisions. Not built: deleting branches on the remote (the `branch.check_merged` check does that for `push_branch`), hygiene for repositories no runner has reported (it needs a clone), per-repository cadence, and a web mock-API (`apps/web/src/mocks`) handler set for the new endpoints.

## Implementation status (DevOps everywhere, track t2a, 2026-10-10)

Owner decisions G-Q1, G-Q2, G-Q5, G-Q8, G-Q12, D3, D5, D6 built; design in `docs/design/git-free-and-devops-instructions.md` part 2, adjusted by the decisions.

| Item | Built |
|---|---|
| G-Q1 DevOps chat unsandboxed | `claude-policy.ts` `buildDevopsChatSettings`, `claude-code.ts` `startChat` / `buildClaudeChatCommand` (real HOME for `isDevops`), `chat.ts` (`devops.request` for DevOps chats only, no read-only worktree), chat prompt in `packages/shared/src/prompt/chat.ts`; RUNNER.md |
| Ask DevOps everywhere | web `components/devops/AskDevOps.tsx` (provider, dialog, button), header, command palette, card, desk item, Workstations; `CreateDevOpsRequest.origin/context`, `DevOpsRequested` origin/context, `migrations/1410_devops_request_context.sql`, brief renders the context |
| G-Q5 | RUNNER.md says plainly that DevOps shifts and chats are unsandboxed and the access ticks are guidance |
| G-Q8 | `resolveDevOpsApprovalIn` two-party (Owner/Admin + workstation user; one answer when the same person), event `DevOpsApprovalAgreed`, desk item stays open, requests visible to org managers |
| G-Q2 | `commands/conflict-attempts.ts`, event `ConflictAttemptStarted`, cards park on the request, card note + desk notice, two attempts then `conflict_unresolved`; hygiene conflicts too; SPEC rule changed |
| G-Q12 | builder role v2 allows `git rebase/checkout/switch`, other roles keep the deny |
| D3 | dispatcher clause `env` gates all agent claim roles except `devops` |
| D5 | `syncEnvironmentNotice`: `environment_attention` alert, one per project and workstation, closed when ready |
| D6 | `toolchain/stacks.ts` `deps` per stack, `android` stack and Android SDK tools, `ensure.ts` `installDependencies` |

Decisions to confirm: the DevOps engineer's own stages stay exempt from D3 (they repair the environment); a dependency install failure makes the environment `failed`; conflict attempts are counted per card (not per rebase) and the card goes through Rework after each attempt even when DevOps succeeded.

## Implementation status (accounts and email, built Oct 9, 2026)

| Item | Built |
|---|---|
| Password reset | `migrations/1330_password_resets.sql`, `commands/password-reset.ts`, auth routes `/api/auth/password-reset/{request,:token,confirm}`, `POST /api/platform/users/:id/send-password-reset`, event `PasswordResetLinkSent` + audit projector, web `ForgotPassword`, `ResetPassword`, Accounts "Send reset link" |
| Branded mail | `mail/layout.ts` (`brandedMail`, `senderName`), all templates moved onto it, scheduled-report mail wrapped, `scripts/render-mails.ts` (`mails:render`) |
| Autoresponder | `supportReceivedMail`: reference, what happens next, response time (`SUPPORT_RESPONSE_TIME`) |
| Notification addresses | platform settings `support_email` and `contact_email` (comma-separated lists), Support page form |
| Support From | `AOM_SUPPORT_FROM`: the autoresponder and the super admin's replies come from the support address (unset: unchanged); findings and DNS checklist in `docs/design/support-mail-from.md` |
| Tests | server `password-reset`, `mail-layout`, `support`; web `password-reset`, `support` |

Decisions: platform (super admin) accounts are excluded from self-service reset and from the admin-sent link (they are managed on the server, as for deactivation); organization Owners/Admins cannot send reset links (accounts are global, and the Owner can already reset 2FA); the reset never signs in; a reset spends pending two-factor challenges; response time is "within 24 to 48 hours" (owner decision); the logo is the existing PNG mark (apple-touch-icon) because SVG is not safe in mail.

## Built: console notifications, password resets, sender names (2026-10-10, track t1)

- Desk-email removed (`85d99e5` reverted; migration 1400 drops `desk_mail_log` and the `desk_mail_*` settings; `AOM_SUPPORT_FROM` stays).
- Console notifications: tickets, Contact us and user replies always mail the support address(es); switches (off) for new organizations/sign-ups and platform audit events on the Support page (`commands/platform-notify.ts`).
- Autoresponder says "within 24 to 48 hours". Super admin invitations and replies come from "The Guildwise HQ team"; org invitations name the inviter and the organization.
- Super admins may use Forgot password and the super admin's Send reset link (also for other super admins).
- Owner resets a member's password to a temporary one (`migrations/1401_must_change_password.sql`, `MemberPasswordReset`, forced change page). Owner only; Admins are not offered it.
- 2x PNG mail logo (`public/brand/logo-mark-mail@2x.png`). Legal: liability cap, jurisdiction (Western Cape), sub-processors (Namecheap, SendGrid). RUNNER.md: DevOps keeps `git push`.

## Built: installer fixes and several pairings per runner (overnight, 2026-10-09)

- **Windows installer.** The generated PowerShell piped text to `wsl.exe`, which makes Windows PowerShell append CR LF: the user-setup script then ended in `fi` + CR (a bash syntax error) and the chosen Ubuntu password gained a CR. All text for bash now travels as base64 on the command line, as does the line that launches the Linux installer (Windows PowerShell 5.1 also strips embedded double quotes, which split paths with spaces). Non-ASCII text (a smart quote in the workstation name is a quote character to PowerShell) is emitted as `[char]` code units, so the script stays pure ASCII. The one-line command asks for TLS 1.2 first. The elevated copy refuses to run as a different user than the one who started it. After a restart the saved copy is reused (the one-time link may be gone). `.wslconfig` is read and written as UTF-8 without BOM. `scripts/lint-installers.sh` parses the script with the PowerShell image when `pwsh` is not installed.
- **Existing runner.** The installers keep a runner that is already installed (upgrade only when the server's is newer), and pair it with the new workstation instead of skipping the pairing or failing on a spent code (a re-run reports the used code and keeps the pairing).
- **Several pairings.** One runner process holds several pairings (one per account or server), each isolated in its own data directory, with a shared concurrency budget; `aom-runner pair` adds, `pairings` lists, `unpair` forgets. See `docs/RUNNER.md` "Several pairings" and `docs/ARCHITECTURE.md` 11.1. Deferred: a Workstations-page hint that two workstations are the same machine; reservation of shift slots per pairing; a Windows-native service for several pairings.

## Built: cloud workstations (track t7, 2026-10-10)

Part 1 of `docs/design/cloud-workstations-and-forges.md`, with the owner's decisions C1, C2, C3, C6 to C8. Server: `cloud/` (SSH connector, GitHub client, service, tick, bootstrap script, mail), `routes/cloud.ts`, migration `1470_cloud_workstations.sql`, scheduler hook; runner: `aom-runner up`, `auth`, `devcontainer`; shared: `cloud/` (cost, office hours, devcontainer) and `api/cloud.ts`; web: Add a workstation offers My computer / VPS (SSH) / Codespaces, cloud workstation cards (status, Wake/Stop, estimate, idle time, office hours, Docker notice). Docs: RUNNER "Cloud workstations", ARCHITECTURE 11.4, DEPLOY, USER-GUIDE 4.18, help "Cloud workstations", `docs/BYO-VPS.md`.

Decisions taken: SSH credentials are used for the one install login and never stored (start/stop of a VPS is manual); the GitHub token is stored encrypted because wake/stop need it; a Codespace enrolls with its own `GITHUB_TOKEN` (no secret in the repository file); Codespaces idle timeout is set to GitHub's maximum and Guildwise stops it sooner; the API key is typed on the machine (`aom-runner auth api-key`) or set as a Codespaces secret, never sent through the server. Not built: provider APIs to start and stop a VPS (Hetzner, AWS), GitHub OAuth connect (a token is pasted), committing the devcontainer file for the user, per-project cloud workstations in the UI (the API supports `projectId`), waking for DevOps requests (cards only), and a real SSH or GitHub integration test (everything is stubbed).

## Built: setup checklist, card notices and the landing-page assistant (overnight, 2026-10-10)

- **Get started checklist.** Five steps computed from live state per organization (project, repository, workstation, team of ba/builder/reviewer/tester, talk to the BA), sidebar button and dialog, hide per user, reopen from Help, deep links with forms opened. Members see the progress; project and repository steps are Owner/Admin. The tour's last step points at it.
- **Card notices (T1).** The board card carries `blockedReason`, `hygiene` and `budget`; each shows as a `CardNotice` banner with a fix link.
- **Landing-page assistant (I1).** Public Q&A helper on Haiku 4.5 with a committed knowledge pack, SSE, per-IP limits, proof of work, daily spend cap ($10), env kill switch and a super admin switch. No in-app assistant. See ARCHITECTURE section 30 and DEPLOY.

## Built: git hosts per repository (overnight, 2026-10-10, track t6)

| Item | Built |
|---|---|
| Forge layer | `packages/shared/src/forge/` (kinds, URL parsing and detection, per-provider create fields, connection schema), runner `apps/runner/src/forge/` (`Forge` interface; GitHub via `gh`, GitLab, Azure DevOps and Bitbucket Cloud over REST, plain git), `docs/ARCHITECTURE.md` 16.6 |
| Per repository | `migrations/1460_forges.sql` (`project_repos.forge_kind`, `workstations.git_connections`, `forge_repo_lists`), `ProjectRepoAdded.forge`, `ProjectRepoForgeSet`, `PATCH /api/projects/:id/repos/:repoId` |
| URL fix | `normalizeRemoteUrl`: Azure DevOps https/ssh/visualstudio.com and Bitbucket Data Center https/ssh are one repository |
| Completion | `pr` through the repository's forge (plain git: push + desk notice); `merge` checks branch protection first (forge `branchRules`) and opens a change instead when direct pushes are refused (owner decision C9); the result is reported as `pr` with `protectedBranch`, so the server records a PR, sets the project default to PR (track t2b) and posts a card message |
| Credentials on the workstation | `aom-runner git-connect <provider>` (`--ssh-key`, `--status`, `--disconnect`), token store `secrets/git-tokens.json` (0600), `git.report` (facts only) shown on the Workstations page and in repository settings with a Connect helper |
| Agents on every git host (owner decisions F2, F3, 2026-10-10) | `aom repo create --provider github|gitlab|azure-devops|bitbucket-cloud [--host]` (`RepoCreateParamsSchema` validates the provider's name shape; `migrations/1500_repo_request_provider.sql` adds `repo_requests.provider/host`; `RepoCreateRequested` carries them; the desk item names the git host; the runner payload carries `provider`/`host`; the project repository gets that `forge`), `aom git status|connect` for the DevOps engineer (`apps/runner/src/forge/agent-git.ts`, rpc `git.status`/`git.connect` answered by the runner, refused for other agents, never takes a secret), Azure DevOps Microsoft Entra service principal / workload identity (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` or `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_DEVOPS_ORGANIZATION`) as the main Azure sign-in before the 2026-12-01 PAT cutoff; BA/DevOps role instructions (BA v8, DevOps v5) and chat/shift prompts updated |
| Forms | new-repository form per provider (no GitHub assumption), URL provider detection with override, repository picker from the connected provider (`forge.repos`) |
| Tests | shared `normalize-remote`; runner `forge` (incl. Entra service principal), `agent-git`, `aom-intake`, `completion-protected`, `repo-create-forge`; server `forges`, `repo-create` (all providers); web `forge-hosts` (all stubbed: no real forge is called) |

Not built: Gitea/Forgejo, CodeCommit, Bitbucket Data Center API, server-held forge connections and webhooks, rewriting stored `remote_url_normalized` of Azure DevOps / Data Center repositories added before the fix.

## Implementation status (the platform blog, built Oct 10, 2026, track t5)

| Item | Built |
|---|---|
| Content model, moderation, kill switch | events `Blog*`, projection `blog_posts` (migration 1450), `commands/blog.ts`, statuses draft/in_review/published/rejected/unpublished, review period then hold window, `blog_enabled` switch |
| Public pages | server-rendered `/blog`, `/blog/:slug`, tags, RSS, sitemap, robots, Open Graph, JSON-LD, ETag cache; default covers; landing header and footer link; Help > Blog (`/help/blog`, reserved slug, search group) |
| Agent API | `/api/v1` Bearer keys (hashed, shown once, scopes, last used, request log, 60 reads/min, 10 writes/h, 8 posts/24 h, idempotent on slug); Platform > API keys |
| Review queue UI | Platform > Blog and Blog post (preview, edit, approve, reject, unpublish), pending badge |
| Writer agent | documented schedule, card template and prompt in `docs/BLOG-API.md` (nothing hard-wired into the database) |
| Weekly digest | migration 1451, `commands/blog-digest.ts`, `brandedMail`, Monday 08:00 Johannesburg, `AOM_BLOG_DIGEST`, Owners default in, opt-in checkbox at invitation acceptance and in Settings, one-click unsubscribe with `List-Unsubscribe` headers, exactly-once deliveries |
| Facebook and LinkedIn | migration 1452, `commands/social.ts` behind `SocialClient`, encrypted tokens, retries with backoff, never twice, status per post and network, expiry alerts |
| Tests | server `blog`, `blog-public`, `blog-digest`, `blog-social`, `blog-signup`; shared `blog-markdown`; web `blog` |

Not built: OAuth connect flows for Facebook and LinkedIn (tokens are pasted until the apps are approved), post images other than the
default covers, view analytics, scheduled publish time, a public newsletter signup, an `Idempotency-Key` header (the slug and content hash are the key).

## Built: Paystack, USD prices with VAT included, billing profile and tax invoices (2026-10-10, track t10)

Supersedes the PayFast-first, VAT-exclusive parts of the billing track below. A Paystack adapter behind `PaymentProvider` (hosted checkout, `charge_authorization`, verify, refunds, signed webhooks, card brand/last4/expiry from the authorization, card update, reconciliation by reference), `AOM_PAYMENT_PROVIDER=paystack|payfast|fake`; prices shown as USD "VAT included" everywhere with the rand charged at the day's rate; 15% VAT (setting) computed out of the inclusive price and shown in USD and ZAR on every invoice, proration included; business-only sign-up (company name), the Owner's billing profile, a printable tax invoice page whose supplier details the super admin edits; provider status, VAT rate and invoice details in Platform > Billing. Migration `1490_billing_vat_profile.sql`. Tests: server `paystack`, `billing-paystack`, `vat`, `billing`; web `billing`. Not verified against a real Paystack account (see `docs/DEPLOY.md`); the exact SARS tax-invoice layout needs the accountant's sign-off.

## Built: billing (overnight, 2026-10-10, track t4)

Plans in a table the super admin edits, self-service sign-up with email verification and card capture, a 7-day trial, first invoice at the trial end, monthly renewals, prorated plan changes, Business add-ons, cancellation to a pause, 3-attempt failure schedule then pause, card-expiry and trial reminders, a PayFast adapter (unverified against a live account) and a fake provider, ZAR conversion with a daily rate and override, the Owner's Billing tab, the platform's catalogue editor and per-org billing panel, and the landing Pricing section. See `docs/SPEC.md` Billing, `docs/ARCHITECTURE.md` section 32, `docs/DEPLOY.md` Billing. Migration `1440_billing.sql`. Tests: server `billing`, `payfast`; web `billing`, `landing`.

## Built: simulation organizations (overnight, 2026-10-10, track t12)

Flag, banner, billing exemption, `[Simulation]` mail prefix, server-hosted simulated workstation with local throwaway repositories, demo scenario and the complete wipe. See `docs/SPEC.md` Simulation organizations, `docs/ARCHITECTURE.md` section 33, `docs/RUNNER.md` Simulated workstation, `docs/DEPLOY.md`, `docs/OWNER-SETUP.md` section 10. Migrations `1540_simulation.sql`, `1541_simulated_workstation.sql`. Tests: server `simulation-wipe`, `simulation-dispatch`, `simulation-host`; runner `scripted-replies`; web `platform`, `simulation-banner`.

## Built: blog launch articles (overnight, 2026-10-10, track t13)

Four owner-approved launch articles (`apps/server/src/blog/launch/*.md`) and the one-time data migration `blog-launch-2026-10` (published when the blog is on, drafts when it is off, skipped per existing slug, `launch` flag so no social share, no digest and no review-period start). Migration `1560_blog_launch.sql`, `parseBlogArticle` in `@aom/shared`. See `docs/BLOG-API.md` Launch articles, `docs/DEPLOY.md`. Tests: server `blog-launch`.

## Built: gated onboarding until the card is saved, and the tour starts with the video (2026-10-10)

An Owner of an organization paused for `billing:setup` (new sign-up), `billing:payment_failed` or `billing:cancelled` sees only a full-page "Start your 7-day free trial" / "Resubscribe" screen (`me.activeOrg.gate`, web `pages/BillingGate.tsx`, route guard in `components/Layout.tsx`); no shell, tour, Get started checklist or What's new until the card is saved, then the app opens and the tour starts. Verified sign-ups that never saved a card are removed after 14 days (`billing/abandoned.ts`). The first step of the Owner, Admin and Member tours is the getting-started video (`components/tour/TourVideo.tsx`). See `docs/SPEC.md` Billing, `docs/ARCHITECTURE.md` section 32, `docs/DEPLOY.md`. No migration. Tests: server `billing-gate`, `billing-abandoned-signup`; web `billing-gate`, `tour`.
