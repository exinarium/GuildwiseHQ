# Design: named phases, post-phase follow-ups, and the BA as the manager's reporter

Oct 5, 2026 · status: proposed (design only, nothing built) · companion to `docs/SPEC.md`, `docs/ARCHITECTURE.md` (referenced as §n)

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

### A3. Data model: migration `apps/server/migrations/1300_phases.sql`

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

A phase gets a thread for agent comments and system notes, so the BA's working notes and "follow-up 1 started: DevOps request …" are readable. Add `'phase'` to `threads.kind` (the CHECK constraint, changed in `1300_`; and the `api/threads.ts` enum). The thread id is the phase id (the DevOps pattern, where `thread_id = requestId`), with `card_id` NULL; `PhaseCreated`'s projector creates it. `phasePass` posts a `system` message on each follow-up start and finish.

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

**Part A: phases**

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
4. **Migration.** Create `apps/server/migrations/1300_phases.sql` (A3); update `apps/server/test/migrate.test.ts` if it lists versions.
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

- **B0. Loop breaker** (independent, can ship any time): `cards.retry_after` (in `1400_`, or a small `1301_card_retry_after.sql` if it ships before Part B), set by `commands/shifts.ts` on the 3rd `shift_failed` in 10 min (a new event `CardRetryDeferred{cardId, until, failures}`). `dispatcher/candidates.ts` honours it; a manager release or move clears it. Test: `apps/server/test/shift-loop-backoff.test.ts`.
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
1. Loop breaker
2. Phases and follow-ups (Part A)
3. BA reporter (Part B)
4. Scheduled DevOps repo hygiene with working-branch confirmation (addendum above)
5. The global Interests page (separate design)
