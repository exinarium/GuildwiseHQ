# GWP-61: Move all agents from one workstation to another

## Question

The owner's old workstation "My workstation" no longer exists. 17 agents are still assigned to it, so none of their shifts can run. Owners and Admins need one action that moves every agent of workstation X to workstation Y. The action uses the single-agent move from GWP-59 for each agent, skips agents that are in a running shift, and reports which agents moved, which were skipped and which failed.

## Revision after GWP-59 landed (main, commit 5748dade)

This design was written before GWP-59 landed. Each assumption was checked against the landed code:

| # | Assumption | Landed code | Result |
|---|---|---|---|
| A1 | needs_rehome restriction lifted; running shift refused with a distinct code | `rehomeAgentIn` (`apps/server/src/commands/sharing.ts:385`) accepts active and needs_rehome agents and throws `conflict('agent_busy')` (409) for a shift with `status <> 'ended'` **and** for a claimed card. A needs_rehome agent skips the shift check, but needs_rehome agents always have `workstation_id = NULL` (projections `sharing.ts:104`, `orgs.ts:117`, `users.ts:171`), so they never sit on a source workstation. | **Holds.** Map `agent_busy` to `skipped / running_shift` and keep the core's message. |
| A2 | The core can run in a caller-supplied transaction and be validated without appending | `rehomeAgentIn(ctx, tx, by, a, req)` runs in the caller's transaction, but it **appends at the end**. There is no validate-only step. | **Revised.** The builder splits the core (see "Split of the single move"). |
| A3 | Target rule "active workstation of the same organisation", exposed as a helper | The rule is the SQL fragment `orgWorkstationSql(ws, org)` in `apps/server/src/queries/move-targets.ts:6`. It requires an active workstation, an active owner user, an org member or the org's simulated workstation, and `wsServesOrgSql`. The core refuses with 404 `workstation_not_found`, or 409 `workstation_unpaired` when the target belongs to an active member but was unpaired. | **Revised (small).** The bulk command's up-front target check reuses `orgWorkstationSql` and the same two codes, so an unpaired target gives 409, not 404. |
| A4 | A web list of org workstations with online/offline state | GWP-59 added `GET /api/agents/:id/move-targets` (`listMoveTargets`, `MoveTargetsResponseSchema`, `useMoveTargets(agentId)` in `apps/web/src/api/queries/members.ts`). This list is keyed to **one agent**, not to a source workstation. | **Revised.** Add `GET /api/workstations/:id/move-targets`, which reuses `listMoveTargets` with the source as the excluded workstation. Do not fall back to `useWorkstations()`. |
| A5 | `AgentRehomed` stays the move event, possibly with `fromWorkstationId` | `AgentRehomed` now carries `fromWorkstationId` (`packages/shared/src/events/agent.ts:131`), and the core fills it in. | **Holds.** |
| A6 | DevOps engineers and the CEO are not moved through the generic move | The core throws `conflict('builtin_agent')` for every `is_builtin` agent. | **Holds.** The bulk move still pre-skips them so it can report `workstation_devops` or `ceo` as the reason. |

The landed code also shows these points:
- **Workstation limit.** The core now counts the net change. Moving onto a workstation the org does not use yet adds 1, and the move that empties the agent's old workstation subtracts 1. In a bulk move the first agent always counts +1, because the source still holds the other agents. An org already at its workstation limit could therefore never bulk-move from a dead workstation to an unused live one, even though the net count stays the same. See the `skipLimitCheck` option below.
- **Agent DTO.** It now has `workstationName` and `workstationState` (`connected | offline | unpaired`), so the Agents page already shows where a stuck agent is. No change is needed for this card.
- **Test file names.** GWP-59's tests are `apps/server/test/agent-move.test.ts` and `apps/web/src/test/agent-move.test.tsx`. This card's new files (`move-all-agents.*`) do not clash with them, and neither existing file changes.

## Findings (original base: release/1.5.0, commit 924755ca; updated where GWP-59 changed them)

- **Single move (landed).** It has two parts:
  - `rehomeAgent` calls `loadMovableAgent`, which returns 404 for an unknown agent and 403 unless the caller is an org Owner or Admin. It then calls `rehomeAgentIn` in one `withAppendTx`.
  - `rehomeAgentIn` runs these checks in order: retired → 409 `agent_retired`, built-in → 409 `builtin_agent`, open shift or claimed card → 409 `agent_busy`, target rule → 404 `workstation_not_found` or 409 `workstation_unpaired`, same workstation → 409 `same_workstation`. Then it runs `sandboxGate`, then `assertWithinLimit('workstations')` when the net delta is above 0, and finally appends `AgentRehomed {agentId, workstationId, fromWorkstationId, runtime, model, unsandboxedAck?}`.
- **Route.** `POST /api/agents/:id/rehome` and `GET /api/agents/:id/move-targets` are in `apps/server/src/routes/sharing.ts`. The body schema is `RehomeAgentRequestSchema` (`runtime` and `model` are required).
- **Projection.** `apps/server/src/projections/agents.ts` sets `workstation_id, runtime, model, status='active'`. Pause is a separate column (`paused_at`), so a paused agent stays paused after a move. Retired agents are refused by the core and are not selected by the bulk move.
- **Audit trail.** The event store is the audit log: one event per agent stream, with actor and scope. `AgentRehomed` is in the dispatcher's wake list, so a moved agent is picked up again without extra code.
- **Workstations belong to users, not to organisations.** `status` is either `active` or `unlinked`. A deleted or unpaired computer is `unlinked`, and its row stays, so its name is still readable.
- **Built-in agents.** Each workstation has one built-in DevOps engineer per org, enforced by `agents_one_devops`. The CEO moves on the CEO page (`moveCeo`), and GWP-60 covers the CEO action.
- **Web.** `GET /api/workstations` returns only the caller's own active workstations. The bulk action needs its own list of "workstations that hold this org's agents", including unlinked and offline ones.
- **Org guard.** `requireOrg(ctx, req, { min: 'admin' })` returns 403 `org_role_required` to Members and Guests. The org comes from the `x-aom-org` header.
- **Tests.** Server tests are DB-backed in `apps/server/test/*.test.ts` (`createWorld`, `connectRunner`, `addMember`, `as(cookie)`). `agent-move.test.ts` is GWP-59's and is a good template. Web tests are in `apps/web/src/test/*.test.tsx` and use Testing Library with mocked fetch.

## Options

| | A. Loop in the web client over `POST /agents/:id/rehome` | **B. Server command that loops over the single-move core (recommended)** | C. One transaction for all agents |
|---|---|---|---|
| Partial success | yes, but lost if the tab closes | yes, one transaction per agent | no: one failure rolls everything back, which the card does not allow |
| Unlinked source not visible to the client | needs a new list anyway | handled on the server | handled |
| Skip reasons, one response | assembled on the client | one response `{moved, skipped, failed}` | – |
| Reuse by GWP-62 (retire workstation with handover) | not possible | `moveAllAgents()` is callable from GWP-62 | – |
| Permission check | per agent only | once (org admin) plus per agent | – |

**Recommendation: B.** A new command `moveAllAgents` runs one `withAppendTx` per agent. It calls the GWP-59 core for each agent and does not use an outer transaction.

## Design

### Shared types: `packages/shared/src/api/agents.ts` (next to `MoveTargetsResponseSchema`)

```ts
/** `POST /api/workstations/:id/move-agents` (and `GET .../move-agents/preview?targetWorkstationId=`). */
export const MoveAllAgentsRequestSchema = z.object({
  targetWorkstationId: z.uuid(),
  /** Required when the target runs an agent's runtime without an OS sandbox (same rule as the single move). */
  acknowledgeUnsandboxed: z.boolean().optional(),
});
export type MoveAllAgentsRequest = z.infer<typeof MoveAllAgentsRequestSchema>;
export const MoveAllAgentsPreviewQuerySchema = z.object({ targetWorkstationId: z.uuid() });

export const MoveSkipReasonSchema = z.enum(['running_shift', 'workstation_devops', 'ceo']);
const MovedAgent = z.object({ agentId: z.uuid(), name: z.string() });
export const MoveAllAgentsResponseSchema = z.object({
  dryRun: z.boolean(),
  source: z.object({ id: z.uuid(), name: z.string(), status: z.enum(['active', 'unlinked']) }),
  target: z.object({ id: z.uuid(), name: z.string() }),
  /** Moved (dryRun: would move). */
  moved: z.array(MovedAgent),
  /** `message`: the core's text for agent_busy (running shift or claimed card); absent for the built-in skips. */
  skipped: z.array(MovedAgent.extend({ reason: MoveSkipReasonSchema, message: z.string().optional() })),
  /** Refused by the single move (code from the HttpError, e.g. runtime_missing, sandbox_unavailable, limit_reached). */
  failed: z.array(MovedAgent.extend({ code: z.string(), error: z.string() })),
  /** True when at least one agent would run unsandboxed on the target and no acknowledgement was sent. */
  needsUnsandboxedAck: z.boolean(),
});
export type MoveAllAgentsResponse = z.infer<typeof MoveAllAgentsResponseSchema>;

/** `GET /api/agents/workstations`: workstations (any status) holding this org's agents (owner/admin). */
export const AgentHomeSchema = z.object({
  id: z.uuid(), name: z.string(), status: z.enum(['active', 'unlinked']), connected: z.boolean(),
  ownerName: z.string(), mine: z.boolean(),
  /** Non-retired agents of the org on it, the built-in DevOps engineer and CEO excluded. */
  agentCount: z.number().int(), runningCount: z.number().int(),
});
export const AgentHomesResponseSchema = z.object({ workstations: z.array(AgentHomeSchema) });
```

The bulk target list reuses GWP-59's `MoveTargetsResponseSchema` unchanged. Export the new types from the package index, following the pattern the other agent API types use.

### Split of the single move (revised A2)

The landed `rehomeAgentIn` validates and appends in one function. Split it in `sharing.ts` without changing behaviour:

```ts
/** Every check of the move; returns what to append. Appends nothing. */
export async function prepareAgentMove(
  ctx: Ctx, tx: Tx, by: { userId: string; actor: Actor }, a: Row, req: RehomeAgentRequest,
  opts: { skipLimitCheck?: boolean } = {},
): Promise<{ append: AppendInput; fromWorkstationId: string | null; toWorkstationId: string; targetName: string }>
// body = today's rehomeAgentIn up to (not including) ctx.store.append;
// `if (delta > 0 && !opts.skipLimitCheck) await assertWithinLimit(...)`

export async function rehomeAgentIn(ctx, tx, by, a, req) {   // signature and result unchanged
  const p = await prepareAgentMove(ctx, tx, by, a, req);
  await ctx.store.append([p.append], { tx });
  return { fromWorkstationId: p.fromWorkstationId, toWorkstationId: p.toWorkstationId };
}
```

`rehomeAgent` and the GWP-59 route keep calling `rehomeAgentIn`. GWP-60 may call either function. `apps/server/test/agent-move.test.ts` must stay green and is **not** edited. Do **not** dry-run by appending and rolling back: `pg-event-store.ts` assigns seq numbers and the notifier tracks them.

`skipLimitCheck` is used only by the bulk move, and only when the bulk move empties the source of every non-built-in active agent of the org. Those agents leave the source, so the org's workstation count does not rise. Single moves never pass it.

### Server command: `apps/server/src/commands/sharing.ts` (new section after `rehomeAgentIn`)

```ts
export async function moveAllAgents(
  ctx: Ctx, who: { userId: string; orgId: string; role: OrgRole }, sourceId: string,
  req: MoveAllAgentsRequest, opts: { dryRun?: boolean } = {},
): Promise<MoveAllAgentsResponse>
```

1. If `!isOrgManager({ orgRole: who.role })`, throw `forbidden(...)` (403). This is a second guard behind the route's guard, so GWP-62 and GWP-60 cannot bypass it.
2. If `sourceId === req.targetWorkstationId`, throw `badRequest('same_workstation', 'pick another workstation')` (400).
3. **Source**: `SELECT id, name, status, user_id FROM workstations WHERE id=$1`, with **no status filter** (offline and unlinked are allowed). If the row is missing or *not known to the org*, throw `notFound('workstation not found', 'workstation_not_found')` (404). "Known to the org" means one of these holds:
   - a non-retired agent of the org is on it
   - its owner is an active `org_members` row of the org
   - `simulation_org_id = who.orgId`
4. **Target** (revised A3): one query, `SELECT w.id, w.name, w.status, w.user_id, ${orgWorkstationSql('w', '$2::uuid')} AS in_org FROM workstations w WHERE w.id=$1`. Refuse the same way as the core:
   - not in the org, but the owner is an active member and the workstation is not active → 409 `workstation_unpaired`
   - missing or `!in_org` → 404 `workstation_not_found`. This also covers a target in another organisation.

   A target that is offline but paired is allowed: agents move and run once it connects.
5. **Agents**: `SELECT * FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status <> 'retired' ORDER BY lower(name), id`. Every row here is `active`, because needs_rehome agents have no workstation. Agents of *other* orgs on the same computer are never touched.
6. **Plan the built-in skips first**:
   - `is_devops` → `skipped`, reason `workstation_devops`
   - `role_key='ceo'` → `skipped`, reason `ceo`

   Set `emptiesSource = (no non-built-in agent will be skipped for a running shift)`. To work that out, pre-check the shift and claim conditions once with the same two queries the core uses: an open shift, or `cards.claimed_by_agent_id = a.id AND claim_id IS NOT NULL`.
7. **Each other agent**, in **its own** `withAppendTx`:
   - Reload the agent row inside the transaction (`SELECT * FROM agents WHERE id=$1`). Skip it if it is gone, retired or no longer on the source.
   - Call `prepareAgentMove(ctx, tx, { userId: who.userId, actor: userActor(who.userId) }, a, { workstationId: target.id, runtime: a.runtime, model: a.model, acknowledgeUnsandboxed: req.acknowledgeUnsandboxed }, { skipLimitCheck: emptiesSource })`. Each agent keeps its runtime and model.
   - Add the runtime check (step 8).
   - If this is not a dry run, `ctx.store.append([p.append], { tx })`.
   - On success, add the agent to `moved`.
   - If it throws an `HttpError`:
     - `agent_busy` → `skipped {reason:'running_shift', message}`. This covers a shift or claim that started after the plan.
     - `unsandboxed_ack_required` → `failed`, and set `needsUnsandboxedAck = true`
     - `builtin_agent` → cannot happen after step 6; treat it as `failed`
     - any other code → `failed {code, error: message}`
   - Rethrow an error that is not an `HttpError` only if nothing has moved yet. Otherwise record it as `failed {code:'internal'}` and carry on. Already-moved agents are committed and are not rolled back (Constraint).
8. **Runtime check**: if the target reports a non-empty `runtimes` list and the agent's runtime is not in it as `available`, the agent goes to `failed`. Use code `runtime_missing` and the message `"<target> has no <runtime> runtime: move this agent on its own and pick a runtime"`. Put the check in `moveAllAgents` (before `prepareAgentMove`) and not in the core, so the single move keeps its behaviour.
9. **Dry run** (preview): same steps without the append. Each agent's transaction then ends with nothing written. It still runs `sandboxGate`, the runtime check and the limit check, so the preview count is the real count.

**Workstation limit.** With `emptiesSource`, a full org can still move everything off a dead workstation. Without it (some agent stays behind because it is busy), the first agent onto an unused target triggers `assertWithinLimit`. If that fails, every agent fails with the same code, and the dialog shows that message once.

**Audit**: one `AgentRehomed` event per moved agent, on that agent's stream, with `actor = userActor(who.userId)`, `scope = orgScope(orgId)` and `fromWorkstationId = source`. All three come from the core. No new event type.

### Routes: `apps/server/src/routes/sharing.ts`, next to the move routes

```ts
app.post('/api/workstations/:id/move-agents',
  { schema: { params: IdParamsSchema, body: MoveAllAgentsRequestSchema } },
  async (req) => { const a = await requireOrg(ctx, req, { min: 'admin' }); return moveAllAgents(ctx, whoOf(a), req.params.id, req.body); });
app.get('/api/workstations/:id/move-agents/preview',
  { schema: { params: IdParamsSchema, querystring: MoveAllAgentsPreviewQuerySchema } },
  async (req) => { const a = await requireOrg(ctx, req, { min: 'admin' }); return moveAllAgents(ctx, whoOf(a), req.params.id, req.query, { dryRun: true }); });
/** Revised A4: the targets for a bulk move from :id (same rule and DTO as the single move). */
app.get('/api/workstations/:id/move-targets', { schema: { params: IdParamsSchema } },
  async (req) => { const a = await requireOrg(ctx, req, { min: 'admin' });
    return MoveTargetsResponseSchema.parse(await listMoveTargets(ctx.pool, { org_id: a.orgId, workstation_id: req.params.id }, a.userId)); });
app.get('/api/agents/workstations', async (req) => { const a = await requireOrg(ctx, req, { min: 'admin' }); return { workstations: await agentHomes(ctx, whoOf(a)) }; });
```

Two notes on these routes:
- `listMoveTargets` already excludes `workstation_id` and returns `current` with the right state (`unpaired`, `offline` or `connected`), so it needs no change. If the route checks that the source is known to the org, reuse the step 3 helper.
- Register `GET /api/agents/workstations` **before** any `/api/agents/:id` GET with a uuid-validated param, or check that Fastify's static-route precedence handles it. It does by default, but the test should hit it.

`agentHomes` goes in `apps/server/src/queries/move-targets.ts` (next to `listMoveTargets`). It is one SQL statement:

```sql
SELECT w.id, w.name, w.status, w.connected, u.display_name AS owner_name, (w.user_id = $2) AS mine,
       count(DISTINCT a.id) FILTER (WHERE NOT a.is_builtin)::int AS agent_count,
       count(DISTINCT s.agent_id) FILTER (WHERE NOT a.is_builtin)::int AS running_count
  FROM agents a JOIN workstations w ON w.id = a.workstation_id JOIN users u ON u.id = w.user_id
  LEFT JOIN shifts s ON s.agent_id = a.id AND s.status <> 'ended'
 WHERE a.org_id = $1 AND a.status <> 'retired'
 GROUP BY w.id, u.display_name ORDER BY w.status, w.name
```

### Web

- **Query hooks**, in a new file `apps/web/src/api/queries/agent-move.ts` (no edit to `members.ts`):
  - `useAgentHomes(enabled)` → `['agent-homes']`
  - `useBulkMoveTargets(sourceId)` → `['move-targets', 'ws', sourceId]` → `GET /workstations/:id/move-targets`, enabled only when `sourceId` is set. It shares the `move-targets` prefix, so GWP-59's invalidation also refreshes it.
  - `useMoveAllPreview(sourceId, targetId)` → `['move-agents-preview', s, t]`, enabled only when both ids are set
  - `useMoveAllAgents()`, a mutation that invalidates `['agents']`, `['hr']`, `['agent-homes']`, `['move-targets']` and `['workstations']`
- **Component** `apps/web/src/components/agents/MoveAllAgentsDialog.tsx`:
  - It receives `source: AgentHome`. Targets come from `useBulkMoveTargets(source.id)`. Follow GWP-59's `MoveAgentDialog` (`Agents.tsx:559`) for the target labels: own workstations first, then "name · owner", then connected or offline.
  - Step 1 (choose):
    - a native `<Select label="Move to">`
    - the preview line "**N agents will move** to Y", with the skipped agents and reasons listed underneath
    - preview failures, such as a missing runtime, shown as "will not move"
    - if `needsUnsandboxedAck`, the `SandboxWarning` and the acknowledgement checkbox (as in `MoveAgentDialog`)
    - the submit button, labelled `Move N agents`; it is disabled while N = 0, the preview is loading, or the acknowledgement is required but not ticked
    - when there are no targets, the same empty-state text that `MoveAgentDialog` uses
  - Step 2 (result), with three lists: **Moved** (names), **Skipped** (name with a plain reason) and **Could not move** (name with the server message). Then a "Done" button.
  - Reason labels:

    | reason | label |
    |---|---|
    | `running_shift` | the server `message` if present, otherwise "in a running shift: move it once the shift ends" |
    | `workstation_devops` | "the workstation's own DevOps engineer stays with it" |
    | `ceo` | "the CEO moves on the CEO page" |

  - If every failure has the same code, show that message once above the list (for example the workstation limit).
- **Placement** on `Agents.tsx`, the only change to that file: for `orgManager` (`useCanManageOrg()`, already in the page) only, and only when `useAgentHomes` returns at least one workstation with `agentCount > 0`, render a compact "Workstations" section (Disclosure, open by default when any home is `unlinked` or offline with agents). Each row shows:
  - the name
  - a badge: Unpaired / Offline / Online
  - "N agents"
  - a `Move all agents` button with `aria-label="Move all agents from <name>"` that opens the dialog

  Members and Guests get neither the query nor the section.
- **All devices, including touch** (standing order):
  - native select, no text input, so no soft keyboard is needed
  - buttons at least 44 px tall and full width below `sm`
  - result lists scroll inside the dialog (`max-h-[50vh] overflow-auto`)
  - the dialog uses the existing `Dialog` component
- **Help**: `apps/web/src/help/articles/agents.md`: add one paragraph on **Move all agents** next to the single-move text. It covers who can use it, the skip reasons, and that the DevOps engineer and CEO stay.

### Data model

No migration. The bulk move only appends existing `AgentRehomed` events.

## Mapping acceptance criteria to design and tests

| AC | Design | Test (new files only) |
|---|---|---|
| 1. Owner/admin moves all agents of a workstation (also an unlinked one) in one action | `POST /api/workstations/:id/move-agents`; source not status-filtered; Agents page "Workstations" section | server `apps/server/test/move-all-agents.test.ts`: hire 3 agents on the source, unlink the source (`POST /api/workstations/:id/unlink`), move to the owner's second workstation, and all 3 have `workstation_id = target` |
| 2. Every agent not in a running shift ends on the target; running ones skipped and reported | steps 6–7, `agent_busy` → `running_shift` | server: active and paused agents are all moved and pause is kept; one agent with a `running` shift is in `skipped[reason=running_shift]` and still on the source; a retired agent is untouched |
| 3. Response and UI show moved and skipped with reason | `MoveAllAgentsResponse`; dialog step 2 | server: response shape; web `apps/web/src/test/move-all-agents.test.tsx`: preview count "2 agents will move", then submit, then the Moved and Skipped lists with reason text |
| 4. Source = target, cross-org target, unknown workstation refused | steps 2–4 | server: same id → 400 `same_workstation`; target owned by a user of another org → 404 `workstation_not_found`; random uuid (source or target) → 404; a member's unpaired target → 409 `workstation_unpaired` |
| 5. Non-owner/admin gets 403 and no action | `requireOrg({min:'admin'})` plus the guard in the command; section only for `orgManager` | server: member cookie → 403 on POST, preview, `move-targets` and homes; web: with a member role, no "Move all agents" button |
| 6. One audit entry per moved agent | one `AgentRehomed` per agent through the core | server: `SELECT stream_id, actor, payload FROM events WHERE type='AgentRehomed'` gives exactly one per moved agent with the owner as actor and `fromWorkstationId = source`, and none for skipped ones |
| Constraint: partial success | one transaction per agent | server: force one agent to fail (runtime missing on the target, or an unsandboxed runtime without acknowledgement); the others are moved and the failed one is in `failed` |
| Built-ins | step 6 | server: the source's DevOps engineer is in `skipped[workstation_devops]`, and there is still exactly one active DevOps engineer per workstation |
| Limit (revised) | `skipLimitCheck` when the source empties | server: an org at its workstation limit moves every agent from a dead workstation to an unused one, and the move succeeds |
| Split is behaviour-preserving | `prepareAgentMove` + `rehomeAgentIn` | existing `apps/server/test/agent-move.test.ts` and `member-removal.test.ts` stay green, unedited |

Server tests need the test Postgres (they are DB-backed like all of `apps/server/test`). If the builder's shift cannot reach it, the builder names them for the tester. Web tests run without services. **No existing test file needs to change.**

Manual check, on a local deploy: as the Owner, open Agents → Workstations → "My workstation" (Unpaired, 17 agents) → Move all agents → pick a live workstation. The preview should say 17. Confirm, check the result lists, then check that a queued card gets a shift for one of the moved agents.

## Risks

- **Stale shifts on a dead computer.** A shift row left in `starting` or `running` on a workstation that vanished without a lost-shift cleanup would keep that agent skipped (`agent_busy`), because the core only ignores open shifts for needs_rehome agents. If this shows up in the manual check, file a follow-up; this card does not force-end shifts.
- **Workstation limit.** This is handled by `skipLimitCheck` when the source empties. Otherwise all agents fail with the same message, and the preview shows it before the move.
- **Runtime mismatch.** The check is skipped when the target has never reported runtimes, because the list is empty.
- **Other organisations' agents on the same computer** are never touched (`org_id` filter).
- **GWP-60 / GWP-62.** Both may call `prepareAgentMove` / `rehomeAgentIn`. GWP-62 should call `moveAllAgents(ctx, who, source, {targetWorkstationId})` for its "hand over to a chosen workstation" path. Keep the function exported and free of HTTP types.
