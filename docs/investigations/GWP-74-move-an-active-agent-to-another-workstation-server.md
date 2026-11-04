# GWP-74: Move an active agent to another workstation (server, agent page and org chart)

## Question

GWP-59 already let an Owner or Admin move an `active` agent through the re-home path. What is still missing for
GWP-74's acceptance criteria, and how do we close those gaps without adding a second move path?

## Overlap decision

- **GWP-59** is done, and its design (`docs/investigations/GWP-59-move-any-agent-to-another-workstation-server-owner.md`,
  "Recommendation and design") is on this checkout (commit `eef76cf4`). GWP-74 does **not** design the move again. It
  widens GWP-59 where this card asks for more. Everything below is a delta on GWP-59.
- **GWP-56** (draft) is cancelled. Nothing to merge.
- **GWP-75** (bulk move) already records its dependency on GWP-74. GWP-76 (CEO action) and GWP-77 (guide and video)
  follow GWP-75. The user guide video belongs to GWP-77. This card updates only the guide text.

## Owner decision (asked during design, answer "o2")

1. **Who may move**: the Owner, an Admin, **or the agent's hiring manager** (an active org member whose id is
   `manager_user_id`). A hiring manager may move only **non-built-in** agents. Everyone uses the same org-wide target
   list (`listMoveTargets`, unchanged).
2. **Claims**: a running shift (`shifts.status <> 'ended'`) is still refused with `agent_busy`. Claims the agent holds
   **with no open shift** are released in the same transaction (`ClaimReleased`, new reason `agent_moved`), and so is a
   stranded BA task (`BaTaskRequeued`). A held claim no longer refuses the move.
3. **DevOps engineer** (built-in, `is_devops`): only the Owner and Admins may move it, only **off an unpaired workstation**
   and only **onto a workstation with no active DevOps engineer**. The refusal names the one-DevOps-per-workstation
   rule (`agents_one_devops`) and the engineer already there. The dialog warns before the user confirms. The CEO still
   moves only on the CEO page (`moveCeo` unchanged).
4. **Status codes**: 403 for org members (and the hiring manager) who may not move the agent. 404 stays for users
   outside the organization, so the agent's existence is not revealed (this is how AC 2 is read).

Reading of requirement 3 / AC 3: "the org owner's active workstations that serve the org" is read as **the
organization's** workstations, which is what the existing `listMoveTargets` / `orgWorkstationSql` returns (active
workstations of active org members, or the org's simulated one, filtered by `wsServesOrgSql`, current one excluded).
The owner's answer confirms that the existing query stays. It is not narrowed to the Owner's own machines, because that
would break GWP-59's AC ("an Owner moves an agent to an Admin's or Member's workstation").

## Findings: state of the code vs. the acceptance criteria

| AC | Today (GWP-59 code) | Gap |
| --- | --- | --- |
| 1. Owner/Admin/hiring manager opens "Move to workstation" on the agent page and the org chart dialog | Agents page: **Move** for Owner/Admin (`canMove`, `Agents.tsx:116`). Org chart `AgentDialog.tsx`: no control at all | Hiring manager is refused (403, `loadMovableAgent`, `sharing.ts:363`). No control on the org chart. Visible label is "Move" |
| 2. Others don't see it; API gives 403 | Member non-manager: 403. Non-member: 404 | Hiring manager must pass. 404 for outsiders is kept (decision 4) |
| 3. Only the org's active workstations, never the current one | `listMoveTargets` does this | none |
| 4. No change keeps runtime and model | Dialog falls back to the target's first runtime when the agent's runtime is missing there, without saying so (`Agents.tsx:570`) | Say so in the dialog. No silent change |
| 5. Sandbox refusal / limit refusal, nothing changes | `sandboxGate` with role, `assertWithinLimit` when delta > 0, all before the append | Built-in agents (DevOps) must skip the limit (they are free) |
| 6. DevOps to a workstation with one: refused, names the rule; dialog warns | Every built-in is refused `builtin_agent` (`sharing.ts:394`). Without that guard, the unique index `agents_one_devops` would raise a 500 | New DevOps rules and messages; move targets carry each target's DevOps engineer for the warning |
| 7. No claims from before the move; cards/tasks can be claimed again | A held claim refuses the move (`agent_busy`, `sharing.ts:412-421`) | Release instead of refusing |
| 8. Running shift refused, nothing changes | Done (`sharing.ts:403-411`) | none (test stays) |
| 9. Exactly one `AgentRehomed` with old and new workstation; next shift on the new one | Done (`fromWorkstationId`), projection sets `workstation_id` | Test the next claim lands on the new workstation |
| 10. `needs_rehome` unchanged | Done | Regression test stays |

Other facts that shape the design:

- A claim creates its shift row (`starting`) in the same append (`projections/shifts.ts:6`). So a held claim with no
  open shift is a **stranded** claim (shift ended `lost`, runner gone, lease not yet expired). Releasing it is the same
  thing the reaper does an hour later.
- `ClaimReleased` projection (`projections/cards.ts:539`) puts a `claimed` card back to `queued`. `home_workstation_id`
  and `worktree_path` are cleared only for `workstation_unlinked`. For `agent_moved` they stay: the work in progress
  lives in that worktree. When the old workstation was unpaired, the unpairing already released the claims and cleared
  the home, so the pinned-card case only happens for an offline (still paired) workstation, and its own agents (or the
  card page's **Re-home**) take the card from there.
- The runner gateway acts on `ClaimReleased` only for `agent_retired`, `member_removed` and `manual`
  (`gateway.ts:259`). `agent_moved` needs no stop: there is no open shift.
- `BaTaskRequeued` (`events/phase.ts:283`) sets the task back to `queued` and clears `agent_id`/`shift_id`. Shift end
  already requeues a BA task, so this is a safety net for a `running` task whose shift is gone.
- Every active org workstation gets its DevOps engineer automatically (`devopsHireEvent`, `commands/devops.ts:90`).
  Unpairing does **not** touch the agents on it (`projections/workstations.ts:42`), so the DevOps engineer of an
  unpaired workstation stays active and points at a dead machine. That is the only DevOps move that makes sense. In
  practice most targets already have a DevOps engineer, so the move is usually refused with the rule. That refusal is
  what AC 6 asks for.
- `OrgChartAgent.reportsTo.userId` is the hiring manager. The chart is for the tab's organization, so
  `useActiveOrgRole()` gives the caller's role there.

## Options considered

| Question | Option | Verdict |
| --- | --- | --- |
| Where the permission rule lives | (a) one helper on the server (`loadMovableAgent`) plus one web helper used by both pages; (b) a server-computed `canMove` flag on every DTO | **(a)**: the Agents page already decides client-side from `me.orgs`; a shared web helper keeps both pages identical. The server stays authoritative |
| Org chart dialog | (a) open `MoveAgentDialog` inside `AgentDialog` (nested dialog); (b) `AgentDialog` asks its page to open the move dialog | **(b)**: no nested modal (focus traps and the soft keyboard on touch). The org chart dialog closes, the move dialog opens |
| DevOps warning source | (a) the client looks at `OrgChart.workstations[].devopsAgentId`; (b) `move-targets` returns each target's DevOps engineer | **(b)**: the Agents page has no chart data, and the server knows the exact rule |
| Claims | (a) refuse (GWP-59); (b) release in the same append | **(b)**, owner decision 2 |

## Recommendation and design

### 1. Shared (`packages/shared`)

- `src/cards/types.ts`, `ClaimReleaseReason`: add `'agent_moved'`.
- `src/api/agents.ts`, `MoveTargetDtoSchema`: add (optional, so old mocks and fixtures stay valid)
  ```ts
  /** The DevOps engineer already on this workstation for the agent's organization (one per workstation). */
  devops: z.object({ agentId: z.uuid(), name: z.string() }).nullable().optional(),
  ```
- `RehomeAgentRequestSchema`: **unchanged** (it already carries `workstationId`, `runtime`, `model`,
  `acknowledgeUnsandboxed`). Existing `needs_rehome` callers keep working.
- `src/api/org-chart.ts`, `OrgChartAgentSchema.workstation`: add `unpaired: z.boolean().optional()`. The Move
  control for a DevOps engineer needs it.

### 2. Server

**`apps/server/src/commands/sharing.ts`, `loadMovableAgent`**

```ts
const a = await one(tx, 'SELECT * FROM agents WHERE id=$1', [agentId]);
const role = a ? await orgRoleOf(tx, user.id, a.org_id) : null;
if (!a || (!role && a.manager_user_id !== user.id)) throw notFound('agent not found');   // outsiders: 404 (unchanged)
const orgManager = isOrgManager({ orgRole: role });
const hiringManager = !!role && a.manager_user_id === user.id;
if (a.is_builtin && a.is_devops && !orgManager)
  throw forbidden('only the organization Owner and Admins can move a DevOps engineer');
if (!orgManager && !(hiringManager && !a.is_builtin))
  throw forbidden("only the organization Owner, its Admins and the agent's hiring manager can move it to another workstation");
return a;
```

The CEO keeps flowing through to `rehomeAgentIn`, which still answers `409 builtin_agent` "the CEO moves on the CEO
page". The `GET /api/agents/:id/move-targets` route already uses `loadMovableAgent`, so the hiring manager gets the
list too. No route change.

**`rehomeAgentIn`**: new order. Every check runs before the single append, so a refusal changes nothing.

1. `retired` → 409 `agent_retired` (unchanged).
2. CEO (`is_builtin && role_key === 'ceo'`) → 409 `builtin_agent` "the CEO moves on the CEO page" (unchanged). Remove
   the DevOps branch of this guard.
3. Running shift → 409 `agent_busy` (unchanged, still skipped for `needs_rehome`).
4. **Delete** the held-claim refusal (`sharing.ts:412-421`).
5. Target lookup: `workstation_unpaired` / `workstation_not_found` / `same_workstation` (unchanged).
6. DevOps rules, only when `a.is_devops`:
   - current workstation still paired (`SELECT status FROM workstations WHERE id = a.workstation_id` is `'active'`) →
     409 `devops_stays`: "{name} is the DevOps engineer of {ws}, which is still paired, so it stays there. Only the DevOps
     engineer of an unpaired workstation can move."
   - `SELECT id, name FROM agents WHERE org_id=$1 AND workstation_id=$2 AND is_devops AND status='active' AND id<>$3`
     finds one → 409 `one_devops_per_workstation`: "{target ws} already has a DevOps engineer, {other}: the rule is one
     DevOps engineer per workstation (agents_one_devops), so {name} cannot move there."
   This runs inside `withAppendTx` (global append lock), so it cannot race `devopsHireEvent`.
7. `sandboxGate(... { roleKey, isDevops, permissions, model: req.model })` (unchanged).
8. Workstation limit: compute `delta` as today, but **only for non-built-in agents** (built-ins are free, owner
   decisions 15/15a). Call `assertWithinLimit` when `delta > 0` (unchanged otherwise).
9. Stranded work, collected after all checks:
   ```ts
   const claims = await rows(tx,
     `SELECT id, org_id, project_id, claim_id FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL`, [a.id]);
   const tasks = await rows(tx,
     `SELECT id, org_id, project_id FROM ba_tasks WHERE agent_id=$1 AND status='running'`, [a.id]);
   ```
   For each card: `ClaimReleased { cardId, claimId, agentId: a.id, reason: 'agent_moved' }` (actor `by.actor`, project
   scope as in `unlinkWorkstationIn`) plus `cardMessage(c, { kind: 'system' }, 'system', 'Claim released: {name} moved
   to another workstation.')`. For each task: `BaTaskRequeued { taskId, reason: 'agent_moved', attempt: false }`.
10. **One** `ctx.store.append([...releases, ...requeues, AgentRehomed], { tx })`. `AgentRehomed` payload is unchanged
    (`agentId`, `workstationId`, `fromWorkstationId`, `runtime`, `model`, `unsandboxedAck?`), actor `by.actor`. Return
    `{ fromWorkstationId, toWorkstationId, releasedCardIds }` (the extra field is harmless for GWP-60/61 callers).

Audit: unchanged from GWP-59. The `AgentRehomed` event with the user actor and `fromWorkstationId` is the audit entry
(`GET /api/org/audit/export`). The `ClaimReleased` events are exported next to it.

**`apps/server/src/queries/move-targets.ts`, `listMoveTargets`**: add the DevOps engineer per target:
```sql
SELECT ..., d.id AS devops_id, d.name AS devops_name
  FROM workstations w JOIN users u ON u.id = w.user_id
  LEFT JOIN agents d ON d.workstation_id = w.id AND d.org_id = $1::uuid AND d.is_devops AND d.status = 'active'
```
Map it to `devops: d ? { agentId, name } : null`. The filter and order are unchanged. The unique index guarantees at most
one row per workstation.

**`apps/server/src/queries/org-chart.ts`**: select `ws.status AS ws_status` and set
`workstation.unpaired = a.ws_status === 'unlinked'`.

`moveCeo`, `ceo/provision.ts`, the `needs_rehome` path and the projections stay unchanged.

### 3. Web

**`apps/web/src/lib/agentMove.ts` (new)**: the one UI rule, used by both pages.
```ts
export function canMoveAgent(x: {
  myId?: string; orgRole?: OrgRole | null; managerUserId: string | null;
  roleKey: string; isDevops: boolean; status: string; unpaired: boolean;
}): boolean {
  if (!x.myId || x.status === 'retired' || x.roleKey === 'ceo') return false;
  const orgManager = x.orgRole === 'owner' || x.orgRole === 'admin';
  if (x.isDevops) return orgManager && x.unpaired;
  return orgManager || (!!x.orgRole && x.myId === x.managerUserId);
}
```

**`apps/web/src/components/agents/MoveAgentDialog.tsx` (new, moved out of `Agents.tsx`)**: same component, prop
`agent: MovableAgent | null` where
`MovableAgent = { id; name; status: 'active' | 'needs_rehome'; runtime; model; isDevops }`. Changes from today:

- Runtime: preselect `agent.runtime` when the target offers it, and the model text field stays empty (it means "keep
  `agent.model`", as today). When the target lacks the agent's runtime, show a hint (`data-testid="move-runtime-changes"`):
  "{runtime} is not available on {ws}: the agent will use {effRuntime}." Then nothing changes silently (AC 4).
- DevOps warning: when `agent.isDevops` and the selected target has `devops`, show
  `role="alert"` `data-testid="move-devops-warning"`: "One DevOps engineer per workstation: {ws} already has {devops.name},
  so this move will be refused." Disable submit while it shows. Option text gets "· has DevOps" for such targets, so the
  user sees it before picking.
- Sandbox warning and acknowledgement, `ErrorBox` for server errors (`agent_busy`, `devops_stays`,
  `one_devops_per_workstation`, `sandbox_unavailable`, `runtime_not_for_role`, `limit_reached`, ...) and "Now on" stay as
  they are. Errors stay inside the dialog, never only as a toast.
- All devices, including touch: native `Select`s. Do **not** autofocus the Model text field (the soft keyboard must not
  open on its own), so first focus goes to the Workstation select. Button row is `flex-wrap`, and the dialog body
  scrolls when the keyboard is open.

**`apps/web/src/pages/Agents.tsx`**:

- `canMove(a)` = `canMoveAgent({ myId, orgRole: orgRole(a), managerUserId: a.managerUserId, roleKey: a.roleKey,
  isDevops: a.isDevops, status: a.status, unpaired: a.workstationState === 'unpaired' })`.
- Visible label of the button becomes **Move to workstation**. Keep `aria-label={`Move ${a.name} to another
  workstation`}` and the `needs_rehome` **Re-home** button exactly as they are (existing tests and e2e use them).
- The DevOps action row (`a.isDevops ? ...`, line ~471) gets the same Move button next to Reset when `canMove(a)`.
- Import `MoveAgentDialog` from the new component.

**`apps/web/src/components/orgchart/AgentDialog.tsx`**: new props `canMove: boolean` and `onMove: () => void`. When
`canMove`, add a button in the footer next to "Open on the Agents page": **Move to workstation**,
`aria-label={`Move ${agent.name} to another workstation`}`. When the agent's status is `working`, add a small hint
"In a running shift: the move waits until it ends" (the server still decides).

**`apps/web/src/pages/OrgChart.tsx`**: hold `moving: OrgChartAgent | null`. `canMove` from `canMoveAgent({ myId:
me.data?.user.id, orgRole: role, managerUserId: agent.reportsTo.userId, roleKey, isDevops, status: agent.status ===
'needs_rehome' ? 'needs_rehome' : 'active', unpaired: !!agent.workstation?.unpaired })`. `onMove` closes the agent
dialog and opens `MoveAgentDialog` with the mapped `MovableAgent`.

**`apps/web/src/api/queries/members.ts`, `useRehomeAgent`**: on success also invalidate `['org-chart']` (it already
invalidates `['agents']` and `['move-targets']`).

`apps/web/src/mocks/handlers-deploy-setup.ts` `moveTargets` is the **deploy** move-target mock (environments), not the
agent move. Leave it alone. The web tests declare their own msw handlers, as `agent-move.test.tsx` does.

### 4. Docs

- `docs/USER-GUIDE.md` (agent move section, around line 609): the hiring manager may move their own agents. A move
  releases claims held without a running shift. A DevOps engineer moves only off an unpaired workstation, onto one
  without a DevOps engineer. "Move to workstation" is also on the org chart. The video belongs to GWP-77.
- `docs/design/organizations.md` section 4.2: rehome/move becomes Owner and Admins for any agent, plus the hiring
  manager for their own non-built-in agents.
- `docs/ARCHITECTURE.md` (around line 732): `ClaimReleased.reason` gains `agent_moved`, and the move releases stranded
  claims in the same append.
- `CHANGELOG.md`: unreleased entry.

### 5. Risks

- **Hiring manager places an agent on someone else's machine**: allowed by the owner's decision (same org-wide list).
  Mitigated: the dialog names the workstation's person and the scope hint, and the move is audited.
- **Pinned cards**: a released card keeps `home_workstation_id` on the old (offline, still paired) workstation, so only
  an agent there or the card page's Re-home picks it up. This is the same as today's lease expiry, and it is documented
  in the guide text.
- **Group builder lock**: a moved builder keeps its `GroupBuilderAssigned` window. Cards of the group pinned to the old
  workstation wait for the window to end. Not changed here (GWP-62 territory).
- **DevOps**: moving the engineer of an unpaired workstation onto a workstation without one is the only allowed move,
  so the unique index can never raise a 500.

## Acceptance criteria mapping

| AC | Design | Test |
| --- | --- | --- |
| 1. Owner/Admin/hiring manager opens the control on the agent page and the org chart dialog, active agent | `loadMovableAgent` allows the hiring manager; `canMoveAgent`; button on both pages | S1, S2; W1, W2 |
| 2. Others don't see it; API 403 | `loadMovableAgent` 403 for members (404 for outsiders, decision 4); `canMoveAgent` false | S3; W1, W2 |
| 3. Only org active workstations, never the current one | `listMoveTargets` unchanged | existing server test "lists the move targets"; W3 |
| 4. No change keeps runtime and model | Preselect `agent.runtime`, empty model means keep; the hint when the runtime is missing | S1 (asserts runtime/model); W3 |
| 5. Sandbox / limit refusal, nothing changes | `sandboxGate` and `assertWithinLimit` before the one append | S6, S7 |
| 6. DevOps one-per-workstation refusal and dialog warning | `one_devops_per_workstation`, `devops_stays`; `move-targets.devops`; dialog warning | S8; W4 |
| 7. No old claims after the move; cards/tasks claimable again | Step 9: `ClaimReleased(agent_moved)`, `BaTaskRequeued` in the same append | S4 |
| 8. Running shift refused, nothing changes | Step 3 (unchanged) | existing test (kept) + S5 |
| 9. Exactly one `AgentRehomed`; next shift on the new workstation | One append, one event; projection sets `workstation_id` | S1, S9 |
| 10. `needs_rehome` still works | Path unchanged | existing test "a needs_rehome agent leaves that status" |

## Tests

Run unit tests only (`pnpm --filter server test` with the DB-backed unit suite as the repo runs it; `pnpm --filter web
test`). The e2e flow ("an Owner moves an active agent from the org chart, and the agent page shows the new
workstation") belongs to the tester under `e2e/`.

**Server, new file `apps/server/test/agent-move-active.test.ts`** (same helpers as `agent-move.test.ts`):

- S1: the hiring manager (org Member, `manager_user_id`) moves their active agent: 200, `workstationId` = target, runtime
  and model unchanged, exactly one new `AgentRehomed` with `fromWorkstationId` = old and actor = the manager.
- S2: Owner and Admin still move (smoke).
- S3: Member who is not the manager → 403 on `POST rehome` and on `GET move-targets`. Hiring manager of a **DevOps**
  engineer (a Member) → 403. Non-member → 404.
- S4: agent holds a card claim with no open shift (insert the claim, or claim and then end the shift `lost`) plus a
  `running` BA task: move succeeds. Afterwards the card has `claim_id IS NULL` and status `queued`, a `ClaimReleased`
  event has reason `agent_moved`, the BA task is `queued` with `agent_id` NULL, and another agent can claim the card.
- S5: open shift (`starting` and `running`) → 409 `agent_busy`, and the agent row and the event count are unchanged.
- S6: target runtime `sandbox: 'unavailable'` → 409 `sandbox_unavailable` with the reason. Nothing changes.
- S7: stub `ctx.ext.planLimits.assertWithin` to throw for `workstations` (pattern in `pack-teams.test.ts:385`), move to
  a workstation with no agents of the org → refused with the limit message, nothing changes. A built-in DevOps move
  does not call it.
- S8: DevOps engineer of an **unpaired** workstation → target that has a DevOps engineer: 409
  `one_devops_per_workstation`, and the message contains "one DevOps engineer per workstation" and the other engineer's
  name. Target without one (retire that target's engineer in the test setup): 200. DevOps of a **paired** workstation:
  409 `devops_stays`. `GET move-targets` returns `devops` for targets that have one.
- S9: after a successful move, the next claim for the agent (normal dispatch with the fake runner on the target) carries
  `workstationId` = the target.
- Every refusal case asserts that `agents.workstation_id` and the number of events in the agent stream are unchanged.

**Existing tests that change because the rules changed** (they assert the old GWP-59 rules):

- `apps/server/test/agent-move.test.ts`: "a Member (also the hiring manager) gets 403" (line 100) → the manager is now
  allowed (keep the plain Member 403 and the non-member 404); "refuses ... holding a claim" (line 132) → keep the
  running-shift half, move the claim half to S4; "refuses built-in agents" (line 166) → keep the CEO `builtin_agent`,
  and the DevOps case becomes `devops_stays`.
- `apps/web/src/test/agent-move.test.tsx`: "a member, even the hiring manager, sees neither" (line 198) → the hiring
  manager sees Move, and a plain member does not.

**Web, new file `apps/web/src/test/agent-move-orgchart.test.tsx`** (msw handlers in the file):

- W1: Agents page: the hiring manager (Member) sees "Move {name} to another workstation". A plain Member does not. A
  DevOps engineer on an unpaired workstation shows Move to an Owner and not to a Member.
- W2: Org chart: clicking an agent opens the card. For Owner, Admin and the hiring manager it has "Move to workstation",
  for a plain Member it does not. Clicking it opens the move dialog.
- W3: the dialog lists the `/move-targets` workstations (the mock leaves out the current one, and the test asserts it is
  not offered), preselects the agent's runtime, and submits `POST /agents/:id/rehome` with that runtime and the
  agent's model when nothing was changed. With a target lacking the runtime, the "will use" hint shows.
- W4: DevOps agent and a target with `devops` → the warning shows and submit is disabled. The sandbox warning shows for
  an unsandboxed runtime.
- W5: a 409 (`one_devops_per_workstation` or `agent_busy`) shows in the dialog's `ErrorBox`, and the dialog stays open.

Existing tests expected to stay green without edits: `member-removal.test.ts`, `sharing.test.ts`, `org-chart.test.tsx`
(the new props are optional/false by default), `sandbox.test.tsx`, `pack-team.test.tsx`, `ceo-misc.test.tsx`,
`provider-runtimes.test.tsx`, `e2e/tests/sharing.spec.ts`.

## Rework round 3: merging release/1.5.0 (CHANGELOG conflict and the bulk move paths)

The card branch (head `2eea001f`, merge base `09abc0df`) does not contain `origin/release/1.5.0` (`e7c24241`): 46
release commits are missing, among them GWP-62 (retire a workstation with agent handover). `aom git merge-main` answers
"already contains the latest main" because it merges `main`, not the card's base `release/1.5.0`. So the base has to be
merged by hand: `git merge --no-edit origin/release/1.5.0` (no fetch needed, the ref is local). The git directory was
read-only during this design shift, so the merge is not done here; it is the first step of the next build.

### Files both sides changed

| File | Three-way result | Action |
| --- | --- | --- |
| `CHANGELOG.md` | conflict in `## [Unreleased]` | resolve as below |
| `apps/server/src/commands/sharing.ts` | clean | apply the fix in "Bulk paths" below |
| `docs/ARCHITECTURE.md` | clean | none |
| `docs/USER-GUIDE.md` | clean, wording consistent (Move to workstation, hiring manager, DevOps rules) | none |

### CHANGELOG.md

Both sides added a section at the top of `## [Unreleased]`: this card a `### Changed` "Moving an agent" entry, release a
`### Added` "Retire a workstation with agent handover" entry. Both must stay, in Keep a Changelog order:

```md
## [Unreleased]

### Added

- Retire a workstation with agent handover. ...   (release's text, unchanged)

### Changed

- Moving an agent. ...                              (this card's text, unchanged)

## [1.5.0]
```

The card branch's `CHANGELOG.md` already has this layout (the release entry is copied word for word above `### Changed`).
The merge still reports a conflict there, but it is one-sided: the release side of the hunk is empty, so **keep the card
branch's side of that hunk** (or both, which gives the same text). Never take only the release side there, which would
drop the "Moving an agent" entry. Every other change release made to `CHANGELOG.md` (the `[1.5.0]` runner line,
storage, public forms) merges in cleanly; check afterwards that `## [1.5.0]` starts with "Runner 0.1.66." and that
`packages/shared/test/release-changelog.test.ts` passes.

### Bulk paths: the held-claim refusal moved, the bulk callers still need it

This card removed the held-claim refusal from `checkAgentMove` and put the release of those claims into `rehomeAgentIn`
only. But `checkAgentMove` is also reached, through `prepareAgentMove`, by:

- `moveAllAgents` (GWP-61, already on the card branch, `sharing.ts` ~line 690), and
- `retireWorkstation` (GWP-62, arrives with the merge, `workstation-retire.ts` ~line 220),

and neither of them releases claims. Before this card a claim-holding agent without a shift was refused there with
`agent_busy` (bulk: skipped as `running_shift`; retire: listed as failed). After the merge such an agent is moved with
its card claim (and running BA task) still pointing at it, i.e. exactly the stranded work this card is meant to remove.
`moveAllAgents` even still counts such agents as busy in its `emptiesSource` pre-check, so the two disagree. No test
covers it (the bulk tests only open shifts).

Fix (smallest change, keeps GWP-61/62 behaviour as built and tested):

```ts
// sharing.ts
export async function checkAgentMove(ctx, tx, by, a, req,
  opts: { skipLimitCheck?: boolean; releaseHeldClaims?: boolean } = {}) {
  ...
  if (shift) throw conflict('agent_busy', ...);                    // unchanged
  if (!opts.releaseHeldClaims) {                                   // restored for the bulk callers
    const claim = await one(tx,
      `SELECT ref FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL LIMIT 1`, [a.id]);
    if (claim) throw conflict('agent_busy',
      `${a.name} is working on ${claim.ref}: release the card or wait until the shift ends.`);
  }
  ...
}
// prepareAgentMove: same opts type, passed through unchanged.
// rehomeAgentIn: prepareAgentMove(ctx, tx, by, a, req, { releaseHeldClaims: true }), then the releases as built.
// ceo/actions7.ts precheck: checkAgentMove(..., req, { releaseHeldClaims: true }), because its execute goes
//   through rehomeAgent, which releases the claims; otherwise the CEO would refuse a move the UI allows.
```

`moveAllAgents` and `retireWorkstation` keep calling without the flag, so they skip or fail claim-holding agents as
before. Moving claim-holding agents in bulk (with the release) belongs to GWP-75, which can then pass the flag and append
the releases.

Tests to add (unit, `apps/server/test/agent-move-active.test.ts`):

- M1: an agent holds a card claim with no open shift; `POST /api/workstations/:id/move-agents` skips it with reason
  `running_shift`, the agent stays on the source, the claim is unchanged and it has no `AgentRehomed`.
- M2: `checkAgentMove(..., { releaseHeldClaims: true })` passes for that agent and the default call gives `agent_busy`.
- Keep S4 (the single move releases the claim) green.
- After the merge also run `workstation-retire.test.ts`, `move-all-agents.test.ts`, `agent-move-check.test.ts`,
  `ceo-actions.test.ts` and the four move suites; they must pass without edits.

## Follow-ups (outside this change)

- GWP-75 (bulk move), GWP-76 (CEO action): call `rehomeAgentIn` with their own actor and authorization. They get the
  claim release and the DevOps rules for free.
- GWP-77: the user guide video.
