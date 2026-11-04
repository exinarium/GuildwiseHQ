# GWP-75: Move all agents off an offline or removed workstation (bulk action)

## Question

When a workstation is offline or has been removed, its agents stay assigned to it and stall. The Owner and Admins
need one action that previews and then moves all of them to one target workstation. A hiring manager may move only
the agents they hired. Every agent goes through the single-agent move (GWP-74) in its own transaction. The result says
honestly which agents moved and which did not, and why.

## Assumption review (2026-11-04, against the landed code on main)

GWP-59, GWP-60, GWP-61, GWP-62 and GWP-74 have all landed. Each assumption was checked against
`apps/server/src/commands/sharing.ts`, `apps/server/src/commands/workstation-retire.ts`, `apps/server/src/ceo/actions7.ts`,
`apps/server/src/routes/sharing.ts`, `packages/shared/src/api/agents.ts`, `apps/web/src/api/queries/agent-move.ts` and
`apps/web/src/components/agents/MoveAllAgentsDialog.tsx`.

| # | Assumption | Verdict | What the code has | Design change |
|---|---|---|---|---|
| A1 | One split of the single move: a read-only `checkAgentMove` plus `rehomeAgentIn` (check, release claims, append, audit) | **Partly wrong** | `checkAgentMove(ctx, q, by, a, req, opts)` (sharing.ts:403) exists and reads only. `prepareAgentMove` (sharing.ts:507) **survives**: it is `checkAgentMove` plus building the `AgentRehomed` append, and `workstation-retire.ts:220` (GWP-62) uses it. `rehomeAgentIn` (sharing.ts:549) calls `prepareAgentMove(..., {releaseHeldClaims: true})`, releases claims (`ClaimReleased reason agent_moved`), requeues running BA tasks and appends. It writes **no audit entry**. | Keep `prepareAgentMove`, because the retire flow needs it (this reverses brief decision 1, "drop prepareAgentMove"). The bulk itself uses only `checkAgentMove` (preview) and `rehomeAgentIn` (run). No audit entry is added, and AC3 does not need one. |
| A2 | `rehomeAgentIn` releases claims, and `agent_busy` then means a running shift only | **Holds, with one condition** | `checkAgentMove` still refuses a held claim with `agent_busy` **unless** `opts.releaseHeldClaims` is set (commit 631790da: the callers that release nothing keep the refusal). `rehomeAgentIn` sets it. | The bulk preview **must** pass `releaseHeldClaims: true` to `checkAgentMove`, or a claimed agent would show as blocked in the preview and then move in the run. With that flag, `agent_busy` means a running shift only. |
| A3 | Its own code for the one-DevOps refusal (assumed `devops_already_there`), or `builtin_agent` kept | **Wrong (codes)** | `builtin_agent` now covers the **CEO only**. A DevOps engineer gets `devops_stays` (409) when its current workstation is still paired (`status='active'`, so an *offline* source), and `one_devops_per_workstation` (409) when the target already has one. That is always the case for a *removed* source, because every active workstation has its own engineer. The `one_devops_per_workstation` message already names the target's engineer and `agents_one_devops`. | The mapping changes: `devops_stays` and `one_devops_per_workstation` map to `one_devops`, and `builtin_agent` maps to `ceo`. The bulk's own lookup of the target's DevOps name is dropped, because the server message has it. |
| A4 | `loadMovableAgent` allows Owner, Admin and the hiring manager, and refuses everyone else with 403 | **Holds** | sharing.ts:360. The hiring manager (an org member with `manager_user_id = me`) may move **non-built-in** agents only, and only an Owner or Admin moves a DevOps engineer. A non-member gets 404. | The non-manager scope query adds `AND NOT is_builtin`. Built-ins carry a `manager_user_id` too (the CEO's is the Owner, and a DevOps engineer's is its workstation's user), so without this filter a Member's scope could list an engineer that `loadMovableAgent` then refuses. |
| A5 | The single move accepts `opts.sourceLeaves` (GWP-61's `skipLimitCheck`, renamed), so the limit check stays in the command | **Wrong** | The option is still named **`skipLimitCheck`**, on `checkAgentMove` and `prepareAgentMove`. `rehomeAgentIn` takes **no opts**. | Add `opts: { skipLimitCheck?: boolean } = {}` to `rehomeAgentIn` and forward it to `prepareAgentMove` with `releaseHeldClaims: true`. Keep the name `skipLimitCheck`; `sourceLeaves` is only the bulk's local variable. Test it in `agent-move.test.ts`. `rehomeAgent` and the CEO action do not pass it, so the single move keeps the limit check. |
| A6 | GWP-61's routes, shared types, homes list and dialog land as on its branch | **Holds** | The routes `GET /api/agents/workstations`, `POST /api/workstations/:id/move-agents`, `GET .../move-agents/preview` and `GET /api/workstations/:id/move-targets` are all `{min:'admin'}`. The shared types are `MoveAllAgentsRequest/PreviewQuery/Response` (`moved/skipped/failed`), `MoveSkipReasonSchema` and `AgentHome`. The web has `useAgentHomes(enabled)`, `useBulkMoveTargets`, `useMoveAllPreview` and `useMoveAllAgents`, plus `MoveAllAgentsDialog.tsx` used from `Agents.tsx`. | None. |

Other points found during the review. None of them changes the design's intent.
- `assertTargetRuntime(target, a)` (sharing.ts:623) is exported and called by `moveAllAgents` **and** `workstation-retire.ts:219`.
  Decision 2 (move the runtime check into `checkAgentMove`) stays. Inside `checkAgentMove` it checks **`req.runtime`**
  against the target's `runtimes`, after `sandboxGate`. Keep the export so the retire flow is unchanged (a second
  check there does no harm).
- The retire flow (GWP-62) does **not** call `moveAllAgents`. It has its own loop in one transaction. It is out of scope
  and must stay green (`workstation-retire.test.ts`).
- `org-chart.ts` / `queries/ceo.ts` still have no `removed` flag on the agent's workstation. That is as the design
  expected, so the design adds it.

## Findings (landed code)

- `apps/server/src/commands/sharing.ts`
  - `loadMovableAgent` (~360): see A4.
  - `rehomeAgent` (~380) runs one `withAppendTx`, then `loadMovableAgent`, then `rehomeAgentIn`.
  - `checkAgentMove` (~403) checks and refuses in this order:
    1. `agent_retired`
    2. `builtin_agent` (the CEO)
    3. `agent_busy` (a running shift; also a held claim unless `releaseHeldClaims` is set)
    4. `workstation_unpaired` (409) or `workstation_not_found` (404) for the target
    5. `same_workstation`
    6. `devops_stays` and `one_devops_per_workstation`
    7. `sandboxGate` (`runtime_not_for_agents`, `runtime_not_for_role`, `sandbox_unavailable`, `unsandboxed_ack_required`)
    8. the workstation limit (`limit_reached`) when the net delta is above 0 and `skipLimitCheck` is not set
  - `prepareAgentMove` (~507) and `rehomeAgentIn` (~549): see A1.
  - `loadSourceWorkstation` (~602): the source may have any status.
  - `moveAllAgents` (~638) is GWP-61's command and is **changed in place by this card**. Today it:
    - is Owner/Admin only;
    - pre-skips DevOps and the CEO;
    - runs its own shift and claim query;
    - calls `assertTargetRuntime` and `prepareAgentMove` without releasing claims;
    - returns `moved/skipped/failed`.
- **Workstation status.** "Removed" means `status='unlinked'`; the row stays. "Offline" means `status='active' AND
  connected=false`. `AgentDto.workstationState` exposes `connected | offline | unpaired`. Unpairing releases the
  workstation's claims and ends its shifts as `lost`. It does not retire the built-in DevOps engineer.
- **One-DevOps rule.** The unique index `agents_one_devops` covers `(org_id, workstation_id) WHERE is_devops AND
  status='active'`. Every active workstation has its own built-in engineer. So a source's DevOps engineer never moves
  in a bulk move: it gets `devops_stays` from an offline source and `one_devops_per_workstation` from a removed one.
- **Workstation limit.** It is counted per organization, as the number of distinct workstations that hold active
  non-built-in agents. For one target it is all or nothing (the first agent onto an unused target counts +1 while the
  source still holds the others), unless the source empties (`skipLimitCheck`).
- **Lists.** `GET /api/workstations` returns only the caller's active workstations. Removed sources appear in GWP-61's
  homes list (`agentHomes`, any status).

## Options

| | A. A second bulk command | **B. Change GWP-61's bulk move in place on top of GWP-74 (recommended)** |
|---|---|---|
| Effort | High: two commands for one thing | Small to medium: scope, reasons, surfaces |
| Drift | Two endpoints, two dialogs | One command, one dialog |

**Recommendation: B.**

## Design

### 1. Server: `apps/server/src/commands/sharing.ts`

**Single move (small changes, needed by the bulk):**
- `rehomeAgentIn(ctx, tx, by, a, req, opts: { skipLimitCheck?: boolean } = {})` forwards
  `{ releaseHeldClaims: true, skipLimitCheck: opts.skipLimitCheck }` to `prepareAgentMove`. Nothing else changes.
- `checkAgentMove`: after `sandboxGate`, refuse `conflict('runtime_missing', ...)` when the target has reported
  runtimes and none matches `req.runtime` (with `available !== false`). Load `w.runtimes` in the target query. Keep
  `assertTargetRuntime` exported, because the retire flow uses it.
- `prepareAgentMove` stays.

**`moveAllAgents` (changed in place):**

```ts
export async function moveAllAgents(
  ctx: Ctx,
  who: { userId: string; orgId: string; role: OrgRole },
  sourceId: string,
  req: MoveAllAgentsRequest,
  opts: { dryRun?: boolean } = {},
): Promise<MoveAllAgentsResponse>
```

1. **Scope.** `all = isOrgManager({ orgRole: who.role })`. A non-manager sees only the agents with
   `manager_user_id = who.userId AND NOT is_builtin`. A non-manager with an empty scope gets
   `403 forbidden('only the organization Owner and Admins, or the hiring manager of these agents, can move them')`.
   An Owner or Admin with an empty scope gets 200 with empty lists. `loadMovableAgent` needs a `user` object; the
   routes pass `a.session.user` through `whoOf`, or `who` gains `user`.
2. **Source.** Keep `loadSourceWorkstation` (any status). Add `connected` to the response.
3. **Target.** Keep the existing check: 409 `workstation_unpaired` for a removed target, 404 when it is not in the
   org, and 400 `same_workstation`.
4. **Candidates.** `SELECT * FROM agents WHERE org_id=$1 AND workstation_id=$2 AND status <> 'retired' [AND
   manager_user_id=$3 AND NOT is_builtin] ORDER BY lower(name), id`. For a manager, built-ins are included, so the
   preview lists every agent on the source.
5. **Remove the repeated checks:**
   - the DevOps and CEO pre-skip;
   - the `busy` shift and claim query;
   - the `assertTargetRuntime` call;
   - the direct `prepareAgentMove` call.
6. **Pass 1 (read-only).** Run `checkAgentMove(ctx, ctx.pool, by, a, req1, { releaseHeldClaims: true,
   skipLimitCheck: true })` for each candidate, with `req1 = { workstationId: target.id, runtime: a.runtime, model:
   a.model, acknowledgeUnsandboxed? }`. Then
   `sourceLeaves = (count of active non-built-in agents of the org on the source) === (count that passed pass 1)`.
   Only non-built-in agents count, because built-ins do not count toward the limit.
7. **Pass 2.** If `!sourceLeaves`, run `checkAgentMove` again for the agents that passed, with
   `{ releaseHeldClaims: true }` (the limit counts). For `dryRun`, return here: a pass becomes `moved` (would move) and
   an error becomes `blocked`.
8. **Run.** Agents blocked in pass 2 are not tried. For each remaining agent, open one `withAppendTx`:
   1. `loadMovableAgent(tx, user, id)`.
   2. If the agent has moved or is retired, add it to `blocked` with `{ reason: 'other', code: 'moved_meanwhile' }`.
   3. Otherwise call `rehomeAgentIn(ctx, tx, by, a, req1, { skipLimitCheck: sourceLeaves })`. It returns
      `releasedCardIds`; map those ids to refs for `releasedClaims`.

   Error handling: an `HttpError` goes to `blocked` with its mapped reason. Any other error goes to `blocked` as
   `other` / `internal`. Rethrow only when it is the first agent and nothing has been written. Nothing is rolled back
   across agents.
9. Return `{ dryRun, scope, source, target, moved, blocked, needsUnsandboxedAck }`.

**Code → reason mapping** (one helper, `moveBlockReason(code)`):

| HttpError code | reason |
|---|---|
| `agent_busy` (a running shift: claims are released) | `running_shift` |
| `devops_stays`, `one_devops_per_workstation` | `one_devops` |
| `builtin_agent` (only the CEO now) | `ceo` |
| `limit_reached` | `workstation_limit` |
| `sandbox_unavailable`, `unsandboxed_ack_required` (which sets `needsUnsandboxedAck`), `runtime_not_for_role`, `runtime_not_for_agents` | `sandbox_gate` |
| `runtime_missing` | `runtime_missing` |
| anything else (`agent_retired`, `moved_meanwhile`, `internal`, …) | `other` |

`blocked[]` always carries `code` and `message`, where `message` is the server's text. The web adds a short reason label.
For `one_devops` the label is "One DevOps engineer per workstation", and the message names the engineer already there,
or explains that a still-paired workstation keeps its engineer. In a preview, `moved[].releasedClaims` comes from
`SELECT ref FROM cards WHERE claimed_by_agent_id=$1 AND claim_id IS NOT NULL`.

### 2. Routes: `apps/server/src/routes/sharing.ts`

- `GET /api/agents/workstations`: `requireOrg(ctx, req)` (any role). `agentHomes(db, orgId, viewerId, { own })`: for a
  non-manager it counts only `manager_user_id = viewer AND NOT is_builtin` agents and drops the homes with 0. A
  non-manager with no homes gets `{ workstations: [] }`, not 403.
- `GET /api/workstations/:id/move-targets`: any role. It returns 403 when the caller is not a manager and has no
  agents in scope on `:id`.
- `GET .../move-agents/preview` (stays GET) and `POST .../move-agents`: any role. The command scopes the agents and
  decides the 403.

### 3. Shared: `packages/shared/src/api/agents.ts`

```ts
export const MoveBlockReasonSchema = z.enum([
  'running_shift', 'one_devops', 'workstation_limit', 'sandbox_gate', 'runtime_missing', 'ceo', 'other',
]);
export const MoveAllAgentsResponseSchema = z.object({
  dryRun: z.boolean(),
  scope: z.enum(['all', 'own']),
  source: z.object({ id: z.uuid(), name: z.string(), status: z.enum(['active', 'unlinked']), connected: z.boolean() }),
  target: z.object({ id: z.uuid(), name: z.string() }),
  moved: z.array(MovedAgentSchema.extend({ releasedClaims: z.array(z.string()) })),
  blocked: z.array(MovedAgentSchema.extend({ reason: MoveBlockReasonSchema, code: z.string(), message: z.string() })),
  needsUnsandboxedAck: z.boolean(),
});
```

This replaces `skipped`, `failed` and `MoveSkipReasonSchema`, which are used only by the bulk command and its web
dialog. Search for every user before deleting them. In `org-chart.ts`, the agent's `workstation` gains
`removed: z.boolean().optional()`, filled in `queries/ceo.ts` (~202, ~303) from `w.status <> 'active'`.

### 4. Web

- `agent-move.ts`: enable `useAgentHomes` for every org user (the server scopes it). After a move, also invalidate
  `['org-chart']`.
- `MoveAllAgentsDialog.tsx`:
  - The `source` prop gets `{ id, name, status, connected }` and the dialog gains `onMoveOne?`.
  - **Preview step:**
    - a native select of targets;
    - "Will move (n)", where an agent that holds claims shows "releases GWP-12";
    - "Blocked (n)", with the reason label and the message;
    - the unsandboxed acknowledgement when `needsUnsandboxedAck` is set;
    - for `scope:'own'`, the note "Only the agents you hired are listed";
    - the confirm button "Move n agents", disabled at n = 0.
  - **Result step:**
    - "Moved (n)";
    - "Not moved (n)", where each agent shows its reason and a "Move…" button (`onMoveOne`);
    - "Move the rest to another workstation", which goes back to the preview with the target cleared.
  - **Touch:** native select only, `min-h-11` buttons, full width below `sm`, lists in `max-h-[50vh] overflow-auto`,
    and an `ErrorBox` for server errors.
- **Surfaces.** The action shows only for an offline (`active && !connected`) or removed (`unlinked`) source with agents
  the viewer may move:
  1. `Workstations.tsx` `WorkstationCard`, for an offline card that is in the homes list with `agentCount > 0` (Owner
     or Admin);
  2. the `Agents.tsx` homes rows: offline and unpaired rows get "Move all agents from this workstation" and a warning
     badge, and live rows keep GWP-61's "Move all agents";
  3. the `AgentCard` warning row, when `workstationState` is `offline` or `unpaired` and the viewer is a manager or
     `managerUserId === me`;
  4. the org chart `AgentDialog` Workstation row, when `!online || removed` and the viewer may move the agent; it also
     shows "(removed)".
- **msw.** Add a new `apps/web/src/mocks/handlers-agent-move.ts`, registered with the other handler files, with handlers
  for homes, the move-targets, the preview (mixed: one will move, plus `one_devops`, `workstation_limit` and
  `running_shift`) and the move.

### 5. Data model

No migration. The move uses the existing `AgentRehomed`, `ClaimReleased` and `BaTaskRequeued` events.

## Acceptance criteria → design → test

Server tests go in `apps/server/test/move-all-agents.test.ts`, with the single-move cases in `agent-move.test.ts`.
Web tests go in `apps/web/src/test/move-all-agents.test.tsx` and `agent-move.test.tsx`.

| AC | Design | Test |
|---|---|---|
| 1. Offline or removed workstation with agents: Owner and Admins see the action | Surfaces 1–4 | web: shown for an offline home and an unpaired home; absent for an online agent card and an online org chart agent; a Member with no hired agents sees none |
| 2. The preview lists every agent with will move or blocked and a reason, and changes nothing | §1 steps 4, 6, 7 | server "mixed preview": A (movable, holds a claim, so it appears in `moved` with `releasedClaims`), B (running shift), the DevOps engineer, and the CEO when present. `moved ∪ blocked` = every non-retired agent; afterwards the event count, `workstation_id` and the claim are unchanged. web: the preview renders both lists with the reasons |
| 3. Unblocked agents are on the target, have no claims from before the move, and have exactly one AgentRehomed | §1 step 8 through `rehomeAgentIn` | server: A is on the target, `cards.claimed_by_agent_id = A` returns none, there is a `ClaimReleased` (`agent_moved`) for A, A has 1 `AgentRehomed`, and blocked agents have 0 |
| 4. The source's DevOps engineer is blocked by one-DevOps and the others still move | mapping: `devops_stays` / `one_devops_per_workstation` → `one_devops` | server (a): removed source, so the engineer is `blocked` with `reason:'one_devops'` and `code:'one_devops_per_workstation'`, the message names the target's engineer, and the others moved. (b): offline source, so `code:'devops_stays'` with `reason:'one_devops'`. Both check that each workstation still has exactly one active DevOps engineer |
| 5. Target at its limit: the agents that do not fit are blocked by the limit, and the ones moved before stay moved | pass 2, `skipLimitCheck: sourceLeaves` | server (a): stub `ctx.ext.planLimits.assertWithin` to throw `limit_reached`, keep the source from emptying (one agent in a running shift) and use an unused target, so every movable agent is blocked `workstation_limit` and nothing moves. (b): A, B and C, where B fails during the run with `runtime_missing`; A and C stay moved with one `AgentRehomed` each. (c): GWP-61's "at the limit, emptying a dead source succeeds" stays green |
| 6. An agent with a running shift is blocked and not moved | `running_shift` | server: open a shift; the agent is blocked `running_shift`, and its `workstation_id` and events are unchanged |
| 7. A removed workstation's agents can be moved, and the removed workstation is never a target | `loadSourceWorkstation`; `orgWorkstationSql` | server: unlink the source with `POST /api/workstations/:id/unlink` and move its agents; both move-targets endpoints never list it; POST with it as the target gives 409 `workstation_unpaired`. web: the mock target select has no removed workstation |
| 8. A hiring manager sees only their own agents; others get 403 | §1 step 1, §2 | server: a Member hires 2 agents and the Owner hires 1. The Member's preview has `scope:'own'` with only their 2 (no built-ins), and after POST the Owner's agent stays. A Member with nothing there and a Guest get 403 on preview, POST and move-targets. An Admin moves all of them. web: the `scope:'own'` note shows |
| Constraint: per-agent transactions | §1 step 8 | AC5 (b) |
| Constraint: no automatic move | the dialog needs a target pick and a confirm | web: nothing is posted before the confirm click |
| Regression | `rehomeAgentIn` opts; the runtime check in `checkAgentMove` | `agent-move.test.ts`: the single move is refused `runtime_missing`, and `rehomeAgentIn` with `skipLimitCheck` passes at the limit while `rehomeAgent` without it refuses. `agent-move-active.test.ts`, `agent-move-check.test.ts`, `ceo-move-workstation.test.ts`, `workstation-retire.test.ts` and `member-removal.test.ts` stay green |

E2E (left for the tester): remove a workstation that has agents, bulk-move them, then check that the agents show the
new workstation and can take a shift.

## Risks

- **Limit race.** With `skipLimitCheck`, the run assumes the source empties. An agent that becomes busy between the
  preview and its own move leaves the org one workstation over its limit. This is rare, shows in the result, and is
  accepted.
- **Stale shifts** on an offline workstation keep an agent blocked until the lease ends them.
- **Offline is not removed.** An offline workstation may come back. Moving its agents is always an explicit choice.
- **Removing `skipped`/`failed`.** Every user of the old response must be updated (dialog, tests, msw). The retire
  flow has its own response and is not affected.

## Out of scope

The user guide and video (GWP-77), the CEO bulk action (GWP-76), and the retire flow (GWP-62,
`workstation-retire.ts`, unchanged).
