# GWP-62: Remove or retire a workstation with agent handover

> **Revised 2026-11-04** after GWP-58, GWP-59, GWP-60 and GWP-61 landed on `main` (`09abc0df`). See
> "Assumptions: review against the landed code" at the end. In short: the bulk move cannot run inside a caller's
> transaction (assumption 3), so retire runs the shared per-agent move steps itself, inside its own transaction. GWP-61's
> list of workstations that hold agents (`GET /api/agents/workstations`) replaces the planned `/api/workstations/stranded`
> endpoint. Everything else stands.

## Question

An Owner or Admin must be able to retire a workstation, and its agents must be handed over when they do. There are two
ways to hand them over: move them all to a chosen workstation Y (the bulk move from GWP-61), or mark them all
`needs_rehome` so they can be re-homed one by one. After that, the workstation is no target for moves or shifts and no
agent is left on it. The questions for this design:

- Should a retired workstation be deleted, or get a retired status?
- How does retiring fit with unpairing (`unlinkWorkstationIn`), with member removal (which sets `needs_rehome`) and with
  the GWP-58 change that retires DevOps engineers on unpair?
- Who may retire, since workstations belong to a person while agents belong to an organization?

The code was first read on `release/1.5.0` at `924755ca`, and checked again on `main` at `09abc0df` with GWP-58/59/60/61
merged.

## Findings

### 1. A workstation already has a "removed" state: `unlinked`

- `apps/server/migrations/0003_workstations.sql`: `status text NOT NULL CHECK (status IN ('active','unlinked'))`, plus
  `unlinked_at`. The DTO has `status: z.enum(['active','unlinked'])` (`packages/shared/src/api/workstations.ts`).
- Unpair is `unlinkWorkstation` → `unlinkWorkstationIn` (`apps/server/src/commands/workstations.ts`). In one append it
  writes `WorkstationUnlinked`, releases the claims held on the workstation (`ClaimReleased`, reason
  `workstation_unlinked`), ends its open shifts (`ShiftEnded{outcome:'lost'}`), fails its DevOps requests, **retires its
  DevOps engineers** (GWP-58, `devopsRetireEvents`, reason `workstation_unpaired`), marks the deploy places it served,
  and after that fails the pending runner commands and drops token rotations. The gateway closes the socket with 4403.
- Unpair **does nothing to the other agents**. They stay `active` with `workstation_id` = the dead workstation (GWP-58
  only flags them with `AgentDto.workstationRemoved`). This is how the 17 agents ended up on "My workstation".

### 2. Every place that picks a workstation already filters on `status='active'`

| Reader | Where | Filter |
|---|---|---|
| Single move, bulk move, CEO move action (GWP-59/60/61) | `checkAgentMove` in `commands/sharing.ts` → `orgWorkstationSql` (`queries/move-targets.ts`) | `w.status='active'` + active member of the org; refuses `same_workstation` |
| Move-target lists (dialogs) | `listMoveTargets` (`queries/move-targets.ts`), `GET /api/agents/:id/move-targets`, `GET /api/workstations/:id/move-targets` | `orgWorkstationSql` (`status='active'`) |
| CEO move (CEO page) | `ceo/home.ts` `moveCeo` | `status='active'` |
| CEO workstation picks | `ceo/actions.ts`, `ceo/snapshot.ts` | `status='active'` |
| Shift scheduling | `dispatcher/dispatcher.ts` `freeAgents` | `ws.status='active' AND ws.connected` |
| DevOps shifts | `dispatcher/devops.ts` | `w.status='active' AND w.connected` |
| BA tasks | `dispatcher/ba-agent-sql.ts` | `ws.status='active'` |
| Web workstation list | `GET /api/workstations` (`routes/workstations.ts`) | `status='active'` |
| Runner connection | token revoked on unlink | cannot connect |

A workstation in `unlinked` is therefore already excluded from every target list and from scheduling. AC 3 comes free
with any design that ends in `status='unlinked'`.

### 3. `needs_rehome` today

- Agent status: `CHECK (status IN ('active','retired','needs_rehome'))` (`0006_agents.sql`). "Paused" is `paused_at`.
- Every path that sets `needs_rehome` also sets `workstation_id=NULL` and leaves `is_devops` agents alone:
  `ProjectMemberRemoved` (`projections/sharing.ts`), the org member-removal event (`projections/orgs.ts`) and
  `UserDeactivated` (`projections/users.ts`). Member removal also queues `agent.wipe` on the old workstation.
- After GWP-59, `rehomeAgent` accepts active and `needs_rehome` agents, and `AgentRehomed` sets `status='active'`.
  The web shows Re-home / Move to workstation for them.

So once an agent has `status='needs_rehome', workstation_id=NULL`, AC 2 ("shows the Re-home action") and AC 5 ("no
agent is left assigned") both hold.

### 4. Workstations belong to a person, agents to an organization

- `workstations.user_id`. `canManageWorkstation`/`canUnlinkWorkstation` allow the machine's own user only
  (`packages/shared/src/authz/index.ts`).
- One workstation can serve several organizations of its user. Each organization has its own DevOps engineer on it,
  and agents of several organizations can sit on it.
- Org guard: `requireOrg(ctx, req, { min: 'admin' })` returns 403 `org_role_required` for Members and Guests.

### 5. Audit log

The audit export (`governance/audit-export.ts`) takes events with `org_id = <org>` and a user actor. Events with
`orgScope(orgId)` + `userActor(id)` are therefore the audit log. `WorkstationUnlinked` uses `userScope`, so it does
**not** show in an organization's audit. The retirement needs its own org-scoped event.

### 6. Cards homed on the workstation get stuck

`dispatcher/candidates.ts`: a card with `home_workstation_id = X` can only be claimed by an agent on X. Unlink clears
the home only for cards that were *claimed* there (`projections/cards.ts`). Open, unclaimed cards whose worktree was
on X keep `home_workstation_id = X` and never run again. Member removal handles the same problem with `CardRehomed`.
Retiring has to do the same.

### 7. Running shift

`shifts.status IN ('starting','running','ended')`. "Running" = `status <> 'ended'`, as in `checkAgentMove`, `moveCeo`
and `unlinkWorkstationIn`. Shifts on a dead runner are ended by the reaper, so a refusal does not last forever.

### 8. What GWP-59/61 landed for moves (checked 2026-11-04)

- `checkAgentMove(ctx, tx, by, a, req, { skipLimitCheck })` (reads only, throws `HttpError`): refuses retired and
  built-in agents (`builtin_agent`: CEO and DevOps), an agent in a running shift or on a claimed card (`agent_busy`),
  a target that is not an active workstation of an active org member (`workstation_unpaired` / `workstation_not_found`),
  the same workstation (`same_workstation`), the sandbox gate (`sandbox_unavailable`, `unsandboxed_ack_required`), and
  the workstation limit unless `skipLimitCheck`.
- `prepareAgentMove(ctx, tx, by, a, req, opts)` runs the checks and returns the `AgentRehomed` append (with
  `fromWorkstationId`), without appending. `rehomeAgentIn` appends it.
- `moveAllAgents(ctx, who, sourceId, req, { dryRun })`: reads with `ctx.pool`, skips DevOps (`workstation_devops`) and
  the CEO/built-ins (`ceo`), checks the target's runtime per agent (`runtime_missing`), then **one `withAppendTx` per
  agent** through `prepareAgentMove` with `skipLimitCheck` when the source is emptied. Partial success; nothing rolls
  back. Routes: `POST /api/workstations/:id/move-agents`, `GET …/move-agents/preview`, `GET …/move-targets`.
- `agentHomes(db, orgId, viewerId)` (`queries/move-targets.ts`), route `GET /api/agents/workstations` (admin):
  workstations of **any status** holding the organization's non-retired agents, with `status`, `ownerName`, `mine`,
  `agentCount` and `runningCount` (built-ins not counted). Web: `useAgentHomes` + `MoveAllAgentsDialog` on the Agents
  page.
- GWP-60: the CEO action `move-workstation` (`ceo/actions7.ts`) validates with `checkAgentMove` and executes with
  `rehomeAgent`.

## Options for the retired state

| | A. Delete the workstation row | B. New status `retired` | C. Retire = handover + the existing `unlinked` status (recommended) |
|---|---|---|---|
| History kept (constraint) | No. `shifts.workstation_id NOT NULL REFERENCES workstations`, plus cards, runner_commands, deploy_targets, run_environments… | Yes | Yes |
| Excluded from targets/scheduling | Yes | Only after a migration (CHECK constraint, zod enum) and a review of every `status === 'unlinked'` check | Already true everywhere (finding 2) |
| Fits unpair / GWP-58 | Conflicts | A third state next to `unlinked`, overlapping with it | Retire *is* unpair plus handover, so GWP-58's DevOps retirement runs in the same append |
| Works for the real case ("My workstation", may already be unlinked) | n/a | Needs `unlinked → retired` | Yes: retiring an `unlinked` workstation does only the handover |
| Schema change | Large | Migration + enum | None |

**Decision: C.** A retired workstation is a workstation with `status='unlinked'` and no non-retired agent left on it. The
retirement itself is recorded by a new org-scoped event `WorkstationRetired` (audit). No new workstation status, no
migration, no delete. Agents, their history and their project assignments are never deleted.

## Design

### Permission model

- Route guard `requireOrg(ctx, req, { min: 'admin' })`: Members and Guests get 403 (AC 6). The organization is the
  tab's organization (`x-aom-org` header).
- The workstation must be known to that organization: reuse GWP-61's `loadSourceWorkstation(db, orgId, id)` (the user
  is an active member, or the organization has a non-retired agent on it, or it is the org's simulated one). Otherwise
  404 `workstation_not_found`.
- **Still `active`** (retire also unpairs it): only the machine's own user may do this (`canUnlinkWorkstation`). An
  Admin retiring another person's paired machine gets 403 `workstation_not_yours` with the message "Only <name> can
  unpair their own computer. Use 'Move all agents' to take this organization's agents off it."
- **Already `unlinked`**: the Owner or an Admin of the organization may hand over that organization's agents, whoever
  the machine belonged to (the machine is not touched, only the organization's agents).

### Handover rules (per agent on X, `status <> 'retired'`)

| Agent | `handover: 'move'` (to Y) | `handover: 'needs_rehome'` |
|---|---|---|
| Normal agent of the acting organization (any status, paused or not) | `prepareAgentMove` → `AgentRehomed` (from X, to Y) inside the retire transaction | new `AgentNeedsRehome` → `needs_rehome`, `workstation_id=NULL` |
| Built-in DevOps engineer (`is_devops`) | not moved (Y has its own). Retired with GWP-58's `devopsRetireEvents` (reason `workstation_unpaired`) | same |
| CEO (`role_key='ceo'`) | if the caller is the org Owner and Y is the Owner's (or the org's simulated one): `AgentRehomed` to Y with the `moveCeo` rules (sandbox gate, runtime `'ceo'`). Otherwise `AgentRehomed{workstationId:null}` (existing "no home" state; the Owner chooses a home on the CEO page) | `AgentRehomed{workstationId:null}` |
| Agent of **another** organization (only when retiring an *active* workstation, i.e. unpairing it) | `AgentNeedsRehome` (Y may not serve that organization, and the caller is not its manager) | same |

The manager (`manager_user_id`) stays as it is.

### Shared (`packages/shared`)

1. `src/api/workstations.ts`:
   ```ts
   export const RETIRE_HANDOVERS = ['move', 'needs_rehome'] as const;
   export const RetireWorkstationRequestSchema = z
     .object({
       handover: z.enum(RETIRE_HANDOVERS).optional(),   // required when the workstation has agents to hand over
       targetWorkstationId: z.uuid().optional(),        // required for 'move'
       acknowledgeUnsandboxed: z.boolean().optional(),  // passed to the move's sandbox gate
     })
     .refine((r) => r.handover !== 'move' || !!r.targetWorkstationId, { path: ['targetWorkstationId'] });
   const AgentRef = z.object({ id: z.uuid(), name: z.string(), roleKey: z.string() });
   export const RetirePreviewSchema = z.object({
     workstation: z.object({ id: z.uuid(), name: z.string(), status: z.enum(['active','unlinked']), connected: z.boolean(), mine: z.boolean() }),
     agents: z.array(AgentRef.extend({ status: z.string(), otherOrg: z.boolean() })), // to hand over (no DevOps)
     devops: z.array(AgentRef),        // retired with the workstation
     working: z.array(AgentRef.extend({ shiftId: z.uuid(), cardRef: z.string().nullable() })), // blockers
     homedCards: z.array(z.object({ ref: z.string(), title: z.string() })), // restart from the base branch
     canUnpair: z.boolean(),
   });
   export const RetireWorkstationResponseSchema = z.object({
     workstationId: z.uuid(), unlinked: z.boolean(),
     handover: z.enum(['move', 'needs_rehome', 'none']),
     moved: z.array(AgentRef), needsRehome: z.array(AgentRef), retiredDevops: z.array(AgentRef),
     rehomedCardIds: z.array(z.uuid()),
   });
   ```
   The `working` list in the 409 refusal uses the same `AgentRef` shape (`details: { agents: [...] }`). The
   `handover_incomplete` refusal carries `details: { failed: [{ id, name, code, message }] }`.
   (No `StrandedWorkstationSchema`: the list comes from GWP-61's `AgentHome`, see Web.)
2. `src/events/workstation.ts`: a new event (audit of the retirement; one per affected organization):
   ```ts
   defineEvent('WorkstationRetired', z.object({
     workstationId: Id, orgId: Id, by: Id,
     handover: z.enum(['move', 'needs_rehome', 'none']),
     targetWorkstationId: Id.nullable(),
     movedAgentIds: z.array(Id), needsRehomeAgentIds: z.array(Id),
     unlinked: z.boolean(),           // true when this retirement also unpaired the machine
   })),
   ```
3. `src/events/agent.ts`: a new event (audit of each needs_rehome handover):
   ```ts
   defineEvent('AgentNeedsRehome', z.object({
     agentId: Id, by: Id, fromWorkstationId: Id,
     reason: z.enum(['workstation_retired']),
   })),
   ```
   Moves are audited by GWP-59's `AgentRehomed`, which already carries `fromWorkstationId`.
4. No new workstation status. Add a short comment on the DTO: "`unlinked` = unpaired or retired".

### Server

**New file `apps/server/src/commands/workstation-retire.ts`**

```ts
export async function retirePreview(ctx: Ctx, who: Who, workstationId: string): Promise<RetirePreview>
export async function retireWorkstation(ctx: Ctx, who: Who, workstationId: string, req: RetireWorkstationRequest): Promise<RetireWorkstationResponse>
```

`retireWorkstation`, in one `withAppendTx`:

1. `SELECT * FROM workstations WHERE id=$1 FOR UPDATE`. Check visibility (`loadSourceWorkstation`) and the permission
   model above (404 / 403).
2. Load the agents: `SELECT … FROM agents WHERE workstation_id=$1 AND status <> 'retired' ORDER BY hired_at, id FOR UPDATE`.
   Split them into: the acting organization's normal agents, the CEO, `is_devops`, and other organizations' agents (other
   organizations only matter when the workstation is still `active`). If the workstation is `unlinked`, ignore other
   organizations' agents.
3. **Running-shift refusal (AC 4):**
   ```sql
   SELECT a.id, a.name, a.role_key, s.id AS shift_id, c.ref
     FROM shifts s JOIN agents a ON a.id = s.agent_id LEFT JOIN cards c ON c.id = s.card_id
    WHERE s.status <> 'ended' AND (s.workstation_id = $1 OR a.id = ANY($2::uuid[]))
    ORDER BY a.name
   ```
   (`$2` = the ids from step 2.) If there are rows, throw
   `conflict('agents_working', 'Retiring is not possible while these agents are working: Ada (GWP-12), Bo. Try again when their shifts end.', { agents })`.
   Nothing is written. (Agents on a claimed card but without an open shift are not blockers: the unlink in step 10
   releases claims on X; for an already-unlinked X there are none left on it.)
4. If there are agents to hand over and `req.handover` is missing: 400 `handover_required`. If there are none, retire
   directly and record `handover: 'none'` (AC "empty workstation").
5. **move** (revised, see assumption 3): `moveAllAgents` cannot be called here (it opens one transaction per agent and
   keeps partial success). Instead, for each normal agent of the acting organization, inside **this** transaction:
   - the target-runtime check of the bulk move: extract it from `moveAllAgents` into an exported helper in
     `commands/sharing.ts` (for example `assertTargetRuntime(target, agent)`, throwing the same `runtime_missing`
     conflict), and call it from both places. No behaviour change for `moveAllAgents`;
   - `prepareAgentMove(ctx, tx, by, a, { workstationId: Y, runtime: a.runtime, model: a.model, acknowledgeUnsandboxed }, { skipLimitCheck: true })`.
     `skipLimitCheck: true` is right because retire empties X completely (step 3 already refused any busy agent), which
     is the same net-zero rule GWP-61 uses (`emptiesSource`).

   Collect every `HttpError` per agent instead of stopping at the first one (the checks are reads only, so a caught
   `HttpError` does not abort the Postgres transaction; any other error is rethrown). If any agent failed, throw
   `conflict('handover_incomplete', 'These agents cannot move to <Y>: …', { failed })` and nothing is written. If
   `unsandboxed_ack_required` is among them, the dialog shows the acknowledgement checkbox (as `MoveAllAgentsDialog`
   does) and sends `acknowledgeUnsandboxed`. Otherwise collect the `p.append` inputs for step 10. Y itself is validated
   by `checkAgentMove` (active org workstation, not X); call it once up front with the first agent, or let the first
   `prepareAgentMove` refuse. Then handle the CEO as in the table (CEO rules inline, as `moveCeo` does; `moveCeo` has
   its own transaction, so either inline its checks or split a `moveCeoIn(tx)` from it without behaviour change).
6. **needs_rehome**: one `AgentNeedsRehome` per agent (stream `streamId.agent(id)`, `userActor(caller)`,
   `orgScope(agent.org_id)`), plus the CEO's `AgentRehomed{workstationId:null, fromWorkstationId: X}`.
7. Other organizations' agents (active workstation only): `AgentNeedsRehome` in their own organization's scope.
8. Cards homed on X (finding 6): for every open card (`status NOT IN ('done','cancelled')`) with
   `home_workstation_id = X` and `claim_id IS NULL`, append `CardRehomed{cardId, by}` plus the system card message
   used by `rehomeCard` ("…the stage restarts from the base branch on any workstation."). Claimed cards are released
   by the unlink in step 10, which already clears their home.
9. `WorkstationRetired` once for the acting organization and once for each other organization whose agents were
   handed over (stream `streamId.workstation(X)`, `userActor(caller)`, `orgScope(orgId)`).
10. Append the events of steps 5-9. Then, if X is still `active`: `unlinkWorkstationIn(ctx, tx, caller, X, ws.user_id, 'owner')`
    in the same transaction. It retires the DevOps engineers (GWP-58). If X is already `unlinked`, retire any DevOps
    engineer still `active` on X with `devopsRetireEvents(tx, { agents, reason: 'workstation_unpaired', actor, by })`
    (exported from `commands/devops-retire.ts`).
11. Do **not** queue `agent.wipe`: the unlink fails every pending runner command and the token is revoked.
12. After the commit: `ctx.services.dispatcher.trigger()`.
13. Return the `RetireWorkstationResponse`.

`retirePreview`: the same reads as steps 1-3 and 8, without writing. `canUnpair` = still `active` and the caller is
the machine's user. (Optional: with `?targetWorkstationId=`, run the step-5 checks as a dry run to show the `failed`
list before Confirm, like `move-agents/preview`.)

**Projections**

- `projections/agents.ts`: `AgentNeedsRehome` → `UPDATE agents SET status='needs_rehome', workstation_id=NULL WHERE id=$1 AND status <> 'retired'`
  (the same shape and guard as the member-removal projections).
- `WorkstationRetired`: no table change. Check whether the projector registry needs an explicit no-op entry.

**Routes (`apps/server/src/routes/workstations.ts`)**

- `GET  /api/workstations/:id/retire-preview` → `retirePreview` (`requireOrg` min admin)
- `POST /api/workstations/:id/retire` (body `RetireWorkstationRequestSchema`) → `retireWorkstation` (`requireOrg` min admin)
- (Revised) No `/api/workstations/stranded`: GWP-61's `GET /api/agents/workstations` (`agentHomes`, admin only) already
  lists every workstation of any status that holds the organization's agents.

**Member removal consistency (constraint)**

- Both paths end in `status='needs_rehome', workstation_id=NULL`, skip `is_devops` and guard `status <> 'retired'`.
- Member removal keeps its own event (`ProjectMemberRemoved`) and its `agent.wipe`. Do not change it.
- `checkAgentMove` keeps `orgWorkstationSql` (`status='active'`): a retired workstation is never a target.

**Unpair stays as it is.** `POST /api/workstations/:id/unlink` and the internal callers keep today's behaviour (with
GWP-58). Agents they strand show GWP-58's "workstation removed" flag and appear in the agent-homes list, where an admin
retires the workstation (or moves all agents) to hand them over.

### Web (`apps/web`)

- `src/api/queries/workstations.ts`: `useRetirePreview(id, enabled)` and `useRetireWorkstation()` (invalidates the
  workstations, agents and agent-homes queries; `useAgentHomes`'s key from `api/queries/agent-move.ts`).
- New `src/components/workstations/RetireWorkstationDialog.tsx` (a `Dialog`, not `ConfirmDialog`):
  - Header "Retire <name>?". It lists the agents to hand over (name, role), says that the DevOps engineers are retired
    with the workstation and which cards restart from the base branch.
  - If the workstation is active, it repeats the unpair bullets (token revoked, runner exits).
  - A radio group with two full-row labels: "Move its agents to another workstation" and "Mark its agents as needing a
    new home (re-home them one by one later)". The first has a native `<select>` fed by GWP-61's
    `GET /api/workstations/:id/move-targets` (already excludes unlinked workstations and X), showing "(online)/(offline)".
    If the list is empty, the move option is disabled with "Pair another workstation first".
  - With no agents it says "This workstation has no agents. It is retired directly." and shows no choice.
  - `preview.working` or a 409 `agents_working`: the list inside the dialog ("Retiring is not possible while these
    agents are working:" + names and card refs), Confirm disabled, a "Check again" button. A 409 `handover_incomplete`
    shows its `failed` list the same way; for `unsandboxed_ack_required` show the acknowledgement checkbox. Never
    toast-only.
  - On success a toast "<name> retired: N agents moved to Y" / "N agents need a new home", then close.
  - **All devices / touch:** no text field (the soft keyboard never opens). Radio rows and buttons at least 44 px high
    (`max-sm:min-h-11`). Footer buttons full width on small screens. The body scrolls inside the dialog on a phone. The
    lists are plain text, not hover-only.
- `src/pages/Workstations.tsx`:
  - `WorkstationCard`: a "Retire" button (`variant="danger-ghost"`, `aria-label="Retire <name>"`) next to Unpair, shown
    only when `useCanManageOrg()` is true and the workstation is the user's own. It opens the dialog.
  - A section "Removed workstations with agents" (`data-testid="stranded-workstations"`), shown only to Owners/Admins,
    fed by `useAgentHomes(true)` filtered to `status === 'unlinked' && agentCount > 0`. Each row: "<name> (<ownerName>),
    N agents" and a "Hand over agents" button that opens the same dialog.
  - Members and Guests see neither (AC 6). The server still returns 403.
- Agents page: no change (Re-home / Move to workstation already exists for `needs_rehome` agents).
- `src/mocks/handlers.ts`: handlers for the two new endpoints.
- Help: `src/help/articles/workstations-and-installer.md` gets a "Retire a workstation" paragraph. The Unpair dialog's
  "Its agents wait until you re-home them" becomes "Its agents stay on it until you retire it or move them".

### Docs

- `docs/ARCHITECTURE.md` (workstation/unpair section) and `docs/design/organizations.md` §7.4: retiring = handover +
  unlink; a retired workstation is `unlinked` with no agents and no longer counts toward the workstation limit.
- `CHANGELOG.md`: "Added" entry.

### Data fix for the 17 agents

No script is needed. After the deploy, the Owner retires "My workstation" from the Workstations page: from its card if
it is still paired, or from "Removed workstations with agents" if it is already unpaired, choosing Move or needs_rehome.
(GWP-61's "Move all agents" on the Agents page also works for the move case today.)

## Risks

- **Race with the dispatcher.** The workstation and agent rows are locked `FOR UPDATE`. If X is unpaired in the same
  transaction, `unlinkWorkstationIn` ends any open shift as `lost` anyway.
- **Multi-organization machines.** Unpairing affects every organization the machine served. Their agents go to
  `needs_rehome`, and each organization gets its own `WorkstationRetired`. Named in the preview (`otherOrg: true`).
- **Card re-home loses unpushed work on X.** Same behaviour as member removal.
- **Agent sandboxes stay on a live retired machine** (no `agent.wipe`). Possible follow-up.
- **Shared move code.** Extracting the runtime check from `moveAllAgents` touches `commands/sharing.ts`; the existing
  move-all tests must keep passing unchanged.

## Acceptance criteria → design → tests

New test files only: `apps/server/test/workstation-retire.test.ts` and
`apps/web/src/test/retire-workstation-dialog.test.tsx`. No existing test file needs changing.

| AC | Design | Test |
|---|---|---|
| 1. Owner/admin retires and chooses move-to-Y or needs_rehome | `POST /api/workstations/:id/retire` with `handover`; dialog radio + select | server: both modes succeed for Owner and for Admin. Web: both choices render, the select lists the move targets, the right body is posted |
| 2. Move: every agent on Y. needs_rehome: every agent `needs_rehome` and shows Re-home | `prepareAgentMove` in the retire tx / `AgentNeedsRehome` projection | server: 3 agents (one paused) → all `workstation_id=Y, status active` / all `needs_rehome, workstation_id NULL`; then `rehomeAgent` on one succeeds. A target missing one agent's runtime → 409 `handover_incomplete`, nothing changed |
| 3. Not a target in move dialog / bulk move / CEO action, no shift scheduled | `status='unlinked'` + `orgWorkstationSql` / `status='active'` filters | server: after retire, `rehomeAgent` to X → refused; `moveAllAgents` to X → refused; the CEO `move-workstation` prepare refuses X; `moveCeo` to X → 404; `listMoveTargets` and `GET /api/workstations` do not list X; `freeAgents` returns no agent on X |
| 4. Refused while an agent is in a running shift; the response names them | step 3, 409 `agents_working` + `details.agents` | server: a `running` shift for Ada → 409 naming Ada and the card ref; nothing changed. Web: a mocked 409 shows the names in the dialog, Confirm disabled |
| 5. No agent left on a retired workstation | handover table + DevOps retire + CEO home | server: after each mode, `count(*) FROM agents WHERE workstation_id=X AND status <> 'retired'` = 0, including DevOps, CEO and a second organization's agent |
| 6. Non-owner/admin 403 and no action shown | `requireOrg({min:'admin'})`; `useCanManageOrg` | server: Member gets 403 on preview and retire; Admin on another person's *active* machine gets 403 `workstation_not_yours`. Web: a Member sees no Retire button and no removed-workstations section |
| 7. Retirement and each handover audited | `WorkstationRetired`, `AgentRehomed` (from/to), `AgentNeedsRehome`, `AgentRetired` for DevOps | server: events with `org_id`, user actor, caller id and payload ids; the audit export returns them |
| Empty workstation retires directly | step 4, `handover: 'none'` | server: no agents → 200, `status='unlinked'`, `WorkstationRetired{handover:'none'}` |
| Already-unpaired workstation (the real case) | handover only, no unlink | server: an `unlinked` X with 2 agents appears in `agentHomes` with `status 'unlinked'`; Admin retire with needs_rehome works; afterwards X is gone from `agentHomes` |
| Cards homed on X | step 8 | server: an open unclaimed card homed on X has `home_workstation_id NULL` after retire |

Testers: the manual check on a local deploy (retire a test workstation with agents, once each way) and any e2e.

## Assumptions: review against the landed code (2026-11-04, `main` @ `09abc0df`)

| # | Assumption | Result | Evidence |
|---|---|---|---|
| 1 | GWP-59 has one shared target check (`status='active'`, target ≠ current) for single move, bulk move and CEO action | **Holds** | `checkAgentMove` (`commands/sharing.ts`) uses `orgWorkstationSql` (`w.status='active'`) and refuses `same_workstation`; used by `rehomeAgentIn` and `moveAllAgents` (via `prepareAgentMove`) and by the CEO action (`ceo/actions7.ts`) |
| 2 | `AgentRehomed` records the from-workstation | **Holds** | `prepareAgentMove` sets `fromWorkstationId`; `packages/shared/src/events/agent.ts` has `fromWorkstationId: Id.nullable().optional()` |
| 3 | GWP-61 bulk move runs inside the caller's transaction (`bulkMoveAgentsIn(ctx, tx, …)`) | **Does not hold** | `moveAllAgents` reads with `ctx.pool` and opens one `withAppendTx` per agent, keeping partial success. Revised: retire calls `prepareAgentMove` per agent inside its own transaction (step 5), sharing an extracted runtime check; `moveAllAgents` keeps its behaviour. GWP-61's `agentHomes` also replaces the planned `/stranded` endpoint |
| 4 | GWP-61 skips built-in agents | **Holds** | `moveAllAgents` skips `is_devops` (`workstation_devops`) and the CEO/built-ins (`ceo`); `checkAgentMove` refuses built-ins (`builtin_agent`). Retire passes only normal agents |
| 5 | The limit check treats X→Y as net zero | **Holds** | `checkAgentMove` counts the leaving workstation as one less when the agent was its last, and `moveAllAgents` passes `skipLimitCheck` when it empties the source. Retire passes `skipLimitCheck: true` (it always empties X) |
| 6 | GWP-60 validates with the same check | **Holds** | `ceo/actions7.ts` `prepare` calls `checkAgentMove`; `execute` calls `rehomeAgent` |
| 7 | GWP-58 adds `devopsRetireEvents` and retires DevOps inside `unlinkWorkstationIn` | **Holds** | `commands/devops-retire.ts` exports `devopsRetireEvents`; `unlinkWorkstationIn` calls it for `is_devops AND status='active'` agents on the workstation |
