# GWP-59: Move any agent to another workstation (server and Owner/Admin UI)

## Question

An agent can be moved today only through **Re-home**, which is offered only for agents in status `needs_rehome`.
Agents that are `active` on a workstation that is offline or unpaired (the 17 agents on the old "My workstation")
cannot be moved, so no shift can run for them. How should `POST /api/agents/:id/rehome` and the Agents page change so
that an organization Owner or Admin can move any agent to another workstation of the organization, safely and with an
audit trail?

Where the code lives: `apps/server/src/commands/sharing.ts`, `apps/web/src/pages/Agents.tsx` and
`packages/shared/src/ceo/policy.ts` are all in this repository (GuildwiseHQ). The hosted repository (guildwise-cloud)
has no rehome route, page or override; it only supplies the plan-limits extension (`ctx.ext.planLimits`), whose
`assertWithin(tx, orgId, kind, delta)` signature already fits this design. **guildwise-cloud needs no change.**

## Findings

### Server today (`apps/server/src/commands/sharing.ts`, `rehomeAgent`, lines 350-408)

| Line | Behaviour | Problem for this change |
| --- | --- | --- |
| 358-361 | 404 unless the caller is an org Owner/Admin or the agent's manager | A plain org Member who is not the manager gets 404; the requirement is 403 |
| 362-363 | `canManageAgentInOrg`: Owner, Admin **or the hiring manager** | The requirement is Owner/Admin only |
| 364-365 | 409 `not_homeless` unless `status = 'needs_rehome'` | The restriction to remove |
| 366-371 | Target must be `user_id = caller` and `status = 'active'` | Another member's workstation is never found; unpaired, unknown and other-org targets all give the same 404 |
| 372-379 | `sandboxGate` without the agent's role | The runtime/role fit check (`assertRuntimeFitsRole`) that hire runs is skipped |
| 380-386 | Workstation limit: +1 when the target hosts no active non-built-in agent | Does not count the workstation the move frees, so a move at the limit is refused even when the total does not change |
| 387-405 | Appends `AgentRehomed {agentId, workstationId, runtime, model, unsandboxedAck?}` | No old workstation in the event |
| (none) | No check for a running shift or a held claim | Requirement: refuse during a running shift |

Other facts that shape the design:

- **Projection** (`apps/server/src/projections/agents.ts:115`): `AgentRehomed` sets `workstation_id`, `runtime`,
  `model` and `status='active'`. That already clears `needs_rehome` and leaves an `active` agent active.
  `paused_at`, `allowed_project_ids`, `focus_project_ids` and `manager_user_id` are untouched, so project assignments
  and pause state survive the move. No projection change is needed.
- **Agent statuses** (`migrations/0006_agents.sql`): `active`, `needs_rehome`, `retired`. `is_builtin` marks the built-in
  CEO and the per-workstation DevOps engineers (`2220_ceo_builtin.sql`).
- **DevOps engineers** are one per (org, workstation) (unique index `agents_one_devops`). Moving one onto a workstation
  that has its own would violate that index (a 500); moving one off its workstation leaves that workstation without
  one. They must not be movable.
- **The CEO** already has its own move (`POST /api/ceo/workstation`, `moveCeo` in `apps/server/src/ceo/home.ts`,
  Owner only, own workstation, refuses while a CEO shift is open). It stays the CEO's path.
- **Running shifts**: `shifts.status IN ('starting','running','ended')`. `moveCeo` already uses
  `SELECT 1 FROM shifts WHERE agent_id=$1 AND status <> 'ended'`. Claims (`dispatcher/claim.ts`) and rehome both run
  inside `withAppendTx` (global append lock), so a check inside the rehome transaction cannot race a new claim.
- **Shifts on a dead workstation end on their own**: unpairing (`unlinkWorkstationIn`) ends every open shift on it
  (`ShiftEnded{outcome:'lost'}`) and releases its claims; on a workstation that is only offline, the reaper releases a
  card claim after 1 h (`releaseExpiredLeases`). So refusing a busy agent never blocks a move for good.
- **Workstations are user-owned and cross-org** (`docs/design/organizations.md`, decision D12). "A workstation of the
  organization" therefore means: an `active` workstation whose user is an active user **and** an active `org_members`
  row of the agent's organization (any role), or the organization's simulated workstation
  (`simulation_org_id = org`), filtered by `wsServesOrgSql` (`apps/server/src/simulation/fit.ts`) like the claim query.
  Guests are not org members, so a guest's workstation is never a target (this keeps
  `member-removal.test.ts` line 235 at 404 and the e2e `sharing.spec.ts` flow unchanged).
- **An agent on someone else's workstation only works projects that person is on** and only repos cloned there
  (`dispatcher/candidates.ts`: `project_members` of the workstation user, `workstation_repos`). The dialog must say so.
- **Cards pinned to the old workstation** (`cards.home_workstation_id`) can only be claimed by an agent on that
  workstation (`candidates.ts`, `home`). Moving agents does not unpin them; the per-card **Re-home** on the card page
  (`POST /api/cards/:id/rehome`) does. Unpinning cards in bulk belongs with retiring a workstation (GWP-62).
- **Audit log** = the `events` table, exported by `GET /api/org/audit/export` (`governance/audit-export.ts`) for
  Owner/Admins: every event with a user actor, its actor, stream, type and (redacted) payload. An `AgentRehomed` event
  that carries the old workstation therefore *is* the audit entry; no separate log is needed.
- **Agents page today** (`apps/web/src/pages/Agents.tsx`): `canManage` (line 113) = Owner, Admin or manager.
  Re-home button (line 488) only for `needs_rehome`. `RehomeDialog` (line 531) lists `useWorkstations()` = the
  caller's own workstations only, defaults the runtime to the first available one, and says "your workstations". The
  card face shows the workstation name only when it is one of the caller's own (`stationName`, line 116), so an agent
  moved to a member's workstation would show no workstation.
- **Authorization matrix** in `docs/design/organizations.md` section 4.2 ("Change, fire, rehome": Members on own hires)
  is now narrower for rehome: Owner and Admins only. In practice no Member loses anything: removal paths set
  `manager_user_id` to the Owner before an agent becomes `needs_rehome`.

## Options

### Target rule

| Option | For | Against |
| --- | --- | --- |
| A. Caller's own workstations only (like hire and `moveCeo`) | Smallest change; nobody else's machine or AI login is used | Contradicts the requirement ("the organisation's other workstations"); an Admin cannot move a stuck agent to the Owner's live machine |
| **B. Any active workstation of an active org member (plus the org's simulated one)** | What the requirement asks; one rule, reused by the list and the move | An Owner/Admin can place an agent on a Member's machine (that machine's runtime logins). Mitigated: Owner/Admin only, the dialog names the workstation's person, and the move is audited |

**Recommendation: B.**

### Where the running-shift check lives

| Option | For | Against |
| --- | --- | --- |
| **In the rehome command, inside its append transaction** | Serialized with claims by the global append lock; one place for the UI, GWP-60 (CEO action) and GWP-61 (bulk) | none |
| In the route or the web | | Racy; the CEO and bulk paths would skip it |

Also count a **held card claim** (`cards.claimed_by_agent_id = agent AND claim_id IS NOT NULL`) as busy: a claim is bound
to the old workstation (`claim_workstation_id`) and would be left behind.

### Audit entry

| Option | For | Against |
| --- | --- | --- |
| **Add `fromWorkstationId` (optional, nullable) to `AgentRehomed`** | The audit export already shows actor, agent stream and payload; old events stay valid (optional field); one event, no extra table | none |
| Separate audit event or table | | Two writes for one fact; the export already covers events |

### Listing targets for the dialog

| Option | For | Against |
| --- | --- | --- |
| **`GET /api/agents/:id/move-targets`** (new read endpoint) | The server applies exactly the move rule (same org, active, not the current one) for that agent; no tab-org ambiguity; GWP-60/61 can reuse the query | One more route (allowed: the card only rules out a new endpoint for the move itself) |
| `GET /api/org/workstations` | Generic | Depends on the tab's organization; the client must repeat the rule |
| Reuse `/api/projects/:id/workstations` | Exists | Per project, no runtimes, excludes codespaces; wrong scope |

## Recommendation and design

### 1. Shared (`packages/shared`)

- `src/events/agent.ts`, `AgentRehomed` payload: add
  `fromWorkstationId: Id.nullable().optional()` with a doc comment ("where the agent was before; absent on events
  written before it was recorded"). No projection change.
- `src/api/agents.ts`:
  - `RehomeAgentRequestSchema` unchanged (backwards compatible).
  - New `MoveTargetDtoSchema` / `MoveTargetsResponseSchema`:
    ```ts
    export const MoveTargetDtoSchema = z.object({
      id: z.uuid(),
      name: z.string(),
      ownerUserId: z.uuid(),
      ownerName: z.string(),
      mine: z.boolean(),
      connected: z.boolean(),
      runtimes: z.array(RuntimeInfoSchema),
    });
    export const MoveTargetsResponseSchema = z.object({
      current: z.object({ id: z.uuid(), name: z.string(), state: z.enum(['connected', 'offline', 'unpaired']) }).nullable(),
      workstations: z.array(MoveTargetDtoSchema),
    });
    ```
  - `AgentDtoSchema`: add `workstationName: z.string().nullable().optional()` and
    `workstationState: z.enum(['connected', 'offline', 'unpaired']).nullable().optional()` (optional so existing
    fixtures and mocks stay valid).

### 2. Server

**`apps/server/src/queries/move-targets.ts` (new)**: one SQL predicate used by both the list and the move.

```ts
/** An active workstation of an active member of org `$org` (any role), or the org's simulated one. */
export const orgWorkstationSql = (ws: string, org: string) => `(
  ${ws}.status = 'active'
  AND EXISTS (SELECT 1 FROM users wu WHERE wu.id = ${ws}.user_id AND wu.status = 'active')
  AND (${ws}.simulation_org_id = ${org}
       OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = ${org} AND om.user_id = ${ws}.user_id AND om.status = 'active'))
  AND ${wsServesOrgSql(ws, org)})`;

export async function listMoveTargets(db, agent: Row, viewerId: string): Promise<MoveTargetsResponse>
// SELECT w.id, w.name, w.user_id, w.connected, w.runtimes, u.display_name FROM workstations w JOIN users u ...
//  WHERE orgWorkstationSql('w', '$1::uuid') AND w.id IS DISTINCT FROM $2   -- $2 = agent.workstation_id
//  ORDER BY (w.user_id = $3) DESC, lower(u.display_name), lower(w.name), w.id
// current: the agent's workstation (name, connected, status -> 'connected' | 'offline' | 'unpaired'), or null.
```

The caller's own workstations come first, so the e2e step `selectOption({ index: 0 })` in `e2e/tests/sharing.spec.ts`
still picks the Owner's workstation.

**`apps/server/src/commands/sharing.ts`**: split `rehomeAgent` into an authorizing wrapper and a reusable core.

```ts
/** Owner or Admin moves an agent (active or needs_rehome) to another workstation of its organization. */
export async function rehomeAgent(ctx, user, agentId, req): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const a = await one(tx, 'SELECT * FROM agents WHERE id=$1', [agentId]);
    const role = a ? await orgRoleOf(tx, user.id, a.org_id) : null;
    if (!a || (!role && a.manager_user_id !== user.id)) throw notFound('agent not found');
    if (!isOrgManager({ orgRole: role }))
      throw forbidden('only the organization Owner and Admins can move an agent to another workstation');
    await rehomeAgentIn(ctx, tx, { userId: user.id, actor: userActor(user.id) }, a, req);
  });
}

/** The move itself, inside the caller's transaction (also for the CEO action and the bulk move). */
export async function rehomeAgentIn(ctx, tx, by: { userId: string; actor: Actor }, a: Row, req: RehomeAgentRequest)
  : Promise<{ fromWorkstationId: string | null; toWorkstationId: string }>
```

`rehomeAgentIn`, in this order (each refusal throws, nothing is appended, so the agent stays where it was):

1. `a.status === 'retired'` -> 409 `agent_retired` "{name} was fired; a fired agent cannot be moved".
2. `a.is_builtin` -> 409 `builtin_agent`: CEO -> "the CEO moves on the CEO page"; DevOps -> "{name} is the DevOps engineer
   of its workstation and stays with it: every workstation gets its own".
3. Busy: `SELECT id, workstation_id FROM shifts WHERE agent_id=$1 AND status <> 'ended' LIMIT 1` -> 409 `agent_busy`
   "{name} is in a running shift: stop it or wait until it ends, then move {name}. If that workstation is gone for
   good, unpair it to end its shifts." Same code for a held claim
   (`SELECT ref FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL LIMIT 1`): "{name} is working on
   {ref}: release the card or wait until the shift ends."
4. Target: `SELECT w.*, ${orgWorkstationSql('w', '$2::uuid')} AS in_org FROM workstations w WHERE w.id=$1`:
   - no row, or `in_org` false and the workstation is not unpaired -> 404 `workstation_not_found` "workstation not found
     in this organization" (unknown and other-org look the same, so other organizations' workstations are not
     revealed; this keeps `member-removal.test.ts` line 235 at 404);
   - row exists, its user is an active org member, but `status = 'unlinked'` -> 409 `workstation_unpaired` "{ws} was
     unpaired: pick a paired workstation";
   - `w.id === a.workstation_id` -> 409 `same_workstation` "{name} already works on {ws}" (keeps
     `member-removal.test.ts` line 249 at 409).
5. `sandboxGate(ctx, tx, by.userId, w.id, req.runtime, req.acknowledgeUnsandboxed, { roleKey: a.role_key,
   isDevops: a.is_devops, permissions: a.permissions, model: req.model })` (now with the role, like hire).
6. Workstation limit with the real delta: `+1` if the target hosts no active non-built-in agent of the org; `-1` if
   the agent is `active`, not built-in, and is the only active non-built-in agent on its current workstation. Call
   `assertWithinLimit(ctx, tx, a.org_id, 'workstations')` only when the sum is `> 0`.
7. Append `AgentRehomed { agentId, workstationId: w.id, runtime, model, fromWorkstationId: a.workstation_id ?? null,
   unsandboxedAck? }` with `actor: by.actor`, `scope: orgScope(a.org_id)`.

No `agent.wipe` is enqueued (unchanged: the dialog says the old sandbox stays behind; the old workstation may still
belong to a working member). Cards pinned to the old workstation are not touched.

**`apps/server/src/routes/sharing.ts`**: `POST /api/agents/:id/rehome` is unchanged. Add
`GET /api/agents/:id/move-targets` (params `IdParamsSchema`): load the agent, apply the same 404/403 as `rehomeAgent`
(share a small `loadMovableAgent(tx, user, agentId)` helper), return `MoveTargetsResponseSchema.parse(...)`.

**`apps/server/src/queries/agents.ts`, `listAgents`**: the query already `LEFT JOIN`s `workstations ws`; select
`ws.name AS workstation_name, ws.status AS workstation_status, ws.connected AS workstation_connected` and map in
`toAgentDto`: `workstationName: a.workstation_name ?? null`, `workstationState: !a.workstation_id ? null :
a.workstation_status === 'unlinked' ? 'unpaired' : a.workstation_connected ? 'connected' : 'offline'`.

Optional, for consistency: `moveCeo` (`ceo/home.ts`) may add `fromWorkstationId` to its `AgentRehomed`. Not required by
this change; `ceo/provision.ts` stays as it is.

### 3. Web

**`apps/web/src/api/queries/members.ts`**: `useMoveTargets(agentId: string | undefined)` ->
`get('/agents/:id/move-targets')`, `enabled: !!agentId` (lazy: it only runs while the dialog is open, so pages and tests
that render the Agents page do not make a new request). `useRehomeAgent` unchanged; on success also invalidate
`['move-targets']`.

**`apps/web/src/pages/Agents.tsx`**:

- `canMove(a) = (orgRole(a) === 'owner' || orgRole(a) === 'admin') && !a.isDevops && a.roleKey !== 'ceo' &&
  a.status !== 'retired'`.
- Action row (line 486 block): replace the `needs_rehome` button condition with `canMove(a)`:
  - `needs_rehome` -> primary **Re-home**, `aria-label={`Re-home ${a.name}`}` (unchanged, e2e relies on it);
  - otherwise -> ghost **Move**, `aria-label={`Move ${a.name} to another workstation`}`.
  A Member who manages the agent keeps the other buttons but sees neither Move nor Re-home. Members without manage
  rights see the existing read-only line (no action).
- Face line (line 396): `station` = `a.workstationName ?? stationName(a.workstationId)`; when `workstationState` is
  `offline` or `unpaired`, add a small `Badge` ("offline" / "unpaired") next to it, so stuck agents are visible.
- Replace `RehomeDialog` with `MoveAgentDialog({ agent, mode, onClose })` where `mode = agent.status === 'needs_rehome' ?
  'rehome' : 'move'`:
  - Title: "Re-home {name}" / "Move {name} to another workstation". Form `aria-label`: "Re-home agent" / "Move agent".
    Submit label: "Re-home" / "Move" (the e2e step clicks `Re-home` with `exact: true`).
  - Line above the fields: "Now on: {current.name} (connected | offline | unpaired)" or "Now on: no workstation".
  - Workstation `Select` from `useMoveTargets(agent.id)`: option text `{name} · {mine ? 'you' : ownerName}
    ({connected ? 'connected' : 'offline'})`. Empty list: "No other workstation in this organization. Pair one on the
    Workstations page." with a link to `/workstations`, submit disabled.
  - Runtime: default to `agent.runtime` when the target lists it as available, else the first available one; Model
    defaults to `agent.model`.
  - Hint when the selected workstation is not `mine`: "{ownerName}'s workstation: the agent works only the projects
    {ownerName} is on, with the repositories cloned there."
  - Description: "The name, history, projects and track record carry over; the old sandbox stays behind."
  - Sandbox warning and acknowledgement: unchanged.
  - Errors stay inline in the dialog (`ErrorBox`), never only as a toast: `agent_busy`, `same_workstation`,
    `workstation_unpaired`, `workstation_not_found`, `limit_reached`, `unsandboxed_ack_required` show the server's
    message.
  - All devices, including touch: native `Select`s; no autofocus on the Model text field (the soft keyboard must not
    open just because the dialog opened; first focus on the Workstation select); buttons in the existing
    `flex-wrap` rows so they wrap on narrow screens; the dialog body scrolls when the keyboard is open.

### 4. Docs

- `docs/design/organizations.md` section 4.2: split the "Change, fire, rehome, permissions (narrow)" row so rehome /
  move is Owner and Admins (any org agent, onto any workstation of the organization), Members and Guests none.
- `docs/ARCHITECTURE.md` line 732: `AgentRehomed` payload gains `fromWorkstationId?`; note the new
  `GET /api/agents/:id/move-targets` next to the rehome route.
- `docs/USER-GUIDE.md` line 609: add **Move** ("Owners and Admins: move an agent to another workstation of the
  organization, for example when its computer is offline or was unpaired; refused while it is in a running shift").
- `CHANGELOG.md` entry in the unreleased section.

### 5. Risks

- **Another member's machine**: an Owner/Admin can place an agent on a Member's workstation, using that machine's
  runtime logins. Accepted by the requirement; mitigated by the Owner/Admin-only rule, the person's name in the dialog,
  and the audit entry. If the owner wants the person's consent first, that is a follow-up.
- **Authorization narrows**: the hiring manager (a Member) can no longer re-home. Removal paths already make the Owner
  the manager of `needs_rehome` agents, so no current flow breaks. The UI hides the button to match.
- **Stricter sandbox fit**: passing the role to `sandboxGate` can refuse a move a hire would also refuse. Correct, and
  the same rule as hire.
- **Pinned cards**: cards whose `home_workstation_id` is the old workstation wait for an agent there. Not changed here;
  the card page's Re-home handles one card, GWP-62 the workstation as a whole.
- **Stale busy state**: an open shift on an offline, not unpaired workstation keeps an agent busy until the 1 h lease
  release; the message tells the user to unpair a workstation that is gone for good.

### 6. Tests

New files only.

**`apps/server/test/agent-move.test.ts`** (uses `createWorld`, `t.addOrgMember`, `pairWorkstation`, `FakeRunner`;
an open shift can be set up through the normal claim flow or by inserting a `shifts` row with `status='running'`):

1. Active agent on an offline workstation (runner never connected / disconnected) is moved to another org workstation:
   200, DTO `workstationId` = target, `status: 'active'`, `allowedProjectIds` unchanged, `workstationName` = target.
2. Active agent on an **unpaired** workstation is moved (the "My workstation" case).
3. Owner moves an agent to an **Admin's or Member's** workstation (org member, not the caller): 200.
4. `needs_rehome` agent (via member removal) is moved: `status` becomes `active`.
5. Org Member (not manager) -> 403; org Member who is the hiring manager -> 403; non-member -> 404.
6. Target in another organization -> 404; unknown uuid -> 404; guest's workstation -> 404; unpaired workstation of an
   org member -> 409 `workstation_unpaired`; current workstation -> 409 `same_workstation`. Each response has a
   message.
7. Open shift (`starting` and `running`) -> 409 `agent_busy`; `agents.workstation_id` unchanged and no `AgentRehomed`
   appended. Held claim -> 409 `agent_busy`.
8. Built-in DevOps and CEO -> 409 `builtin_agent`; retired agent -> 409 `agent_retired`.
9. Audit: the `AgentRehomed` event has `actor` = the caller and payload `agentId`, `fromWorkstationId` (old, or null for
   `needs_rehome`) and `workstationId` (new); the event is in `GET /api/org/audit/export` for the Owner.
10. `GET /api/agents/:id/move-targets`: lists org members' active workstations with `connected`, excludes the current
    one, guests' and other orgs' workstations, own first; Member -> 403.

**`apps/web/src/test/agent-move.test.tsx`** (msw handlers declared in the test file):

1. Owner and Admin: every non-built-in agent row has "Move {name} to another workstation"; a `needs_rehome` row has
   "Re-home {name}".
2. Member (also when they are the hiring manager): neither button.
3. Dialog lists the targets from `/move-targets` with "(connected)" / "(offline)" and the owner's name, shows "Now on",
   and submits `POST /agents/:id/rehome` with the chosen workstation, the runtime and the model.
4. A 409 `agent_busy` answer is shown inside the dialog and the dialog stays open.
5. Re-home mode: form "Re-home agent", submit "Re-home".

Existing tests expected to stay green without edits: `apps/server/test/member-removal.test.ts` (lines 233, 235, 249
keep 404, 404, 409 as explained above), `apps/server/test/sharing.test.ts`, `e2e/tests/sharing.spec.ts`, and the web
tests that render the Agents page (`sandbox.test.tsx`, `pack-team.test.tsx`, `ceo-misc.test.tsx`,
`provider-runtimes.test.tsx`; the new query is lazy and the new DTO fields are optional). If one of them must change,
list its full path under the card's affected areas with the reason.

## Acceptance criteria mapping

| Acceptance criterion | Design | Test |
| --- | --- | --- |
| Owner/Admin moves an active agent on an offline or deleted workstation from the Agents page; it then shows the new workstation | Status restriction removed; org target rule; Move button + `MoveAgentDialog`; `workstationName` on the DTO | server 1, 2, 3; web 1, 3 |
| `POST /api/agents/:id/rehome` succeeds for `active` and `needs_rehome` | `rehomeAgentIn` has no status gate (only `retired` and built-ins are refused) | server 1, 4 |
| A non-Owner/Admin member gets 403 and does not see the action | `isOrgManager` check -> 403; `canMove` in the UI | server 5; web 2 |
| Other org, unknown, or current workstation -> 4xx with a clear message | Step 4: 404 `workstation_not_found`, 409 `workstation_unpaired`, 409 `same_workstation` | server 6 |
| Agent in a running shift is refused and stays | Step 3 inside the append transaction (serialized with claims) | server 7; web 4 |
| `needs_rehome` agent leaves `needs_rehome` | Projection sets `status='active'` (unchanged); same dialog in `rehome` mode | server 4; web 5 |
| Each move is in the audit log with actor, agent, old and new workstation | `AgentRehomed.fromWorkstationId` + user actor; audit export | server 9 |

## Follow-ups (outside this change)

- GWP-60 (CEO action) and GWP-61 (bulk move) call `rehomeAgentIn` with their own actor and authorization.
- GWP-62 (retire a workstation): unpin cards whose `home_workstation_id` is the retired workstation and hand its
  agents over through `rehomeAgentIn`.
