# GWP-60: CEO action to move an agent to another workstation

Status: design, 2026-11-03, revised the same day after GWP-59 landed (see section 9). Repository: GuildwiseHQ (core).
Depends on GWP-59 (landed on the working branch).

## 1. Question

The CEO cannot move an agent between workstations. `agent.allow_list` only changes the agent's projects. We need a CEO
policy action with the parameters `agentId` and `targetWorkstationId`. It must do the same move as the owner/admin
rehome from GWP-59, with the same validation, the same approval rules as the CEO's other agent actions, and an audit
entry that names the CEO as actor.

## 2. Findings (code as read on the working branch)

### 2.1 Policy (`packages/shared/src/ceo/policy.ts`)

- `ACTION_CLASSES` is the closed list of classes. `ActionClass` is a `z.enum` of it.
- `CLASS_LABEL: Record<ActionClass, string>`. Every class needs a label, or the typecheck fails.
- `DEFAULT_CEO_POLICY.classes` gives every class a mode. A class that is missing falls back to `recommend` in
  `evaluateBase` (`policy.classes[cls]?.mode ?? 'recommend'`).
- Stored policies of existing organisations pick up new classes with their **default** mode:
  `withNewClasses()` in `apps/server/src/ceo/state.ts` merges `DEFAULT_CEO_POLICY.classes` into the loaded policy. So
  no migration is needed.
- `STAFFING_CLASSES` holds `agent.allow_list` and the other staffing classes. `UNTRUSTED_RECOMMEND` (private to the
  file) turns `decide` into `recommend` when the wake was triggered by outside text. `agent.allow_list` is in both.
- `HARD_NEVER` holds `agent.widen_permissions`. This matters for the sandbox acknowledgement (see 2.4).

### 2.2 The CEO action executor (the "gateway")

| File | Role |
| --- | --- |
| `packages/shared/src/ceo/ipc.ts` | `CEO_ACTIONS` (CLI action names, `CeoActionName`), `CeoActRpc` (`op: 'act'`, `action`, `params`, `reason`, `confidence`, `evidence`, `key`, `dryRun`) |
| `apps/server/src/ceo/registry.ts` | `ACTIONS`: CLI name -> `ActionDef`, merged from `actions.ts` ... `actions6.ts` |
| `apps/server/src/ceo/types.ts` | `ActionDef { cls, schema, describe, prepare (reads only), execute }`, `Prepared`, `Executed` |
| `apps/server/src/ceo/engine.ts` | `runAction`: idempotency key, `schema.safeParse`, `prepare`, paused-project check, evidence, limits, `evaluatePolicy`, then dry run / deny / recommend / execute. Execute runs inside `withActingAgent`, then appends `CeoActionTaken` |
| `apps/server/src/ceo/actions2.ts` | The `allow` action (`agent.allow_list`, `setAgentAllowedProjects`), plus `model`, `seniority`, `bench`, `retire`, `hire`, `scale` |
| `apps/server/src/ceo/gateway.ts` | RPC entry; builds `ownerPrincipal` and `makeEnv`, calls `runAction` |
| `apps/server/src/eventstore/acting.ts` | `withActingAgent`: every event appended with a `user` actor inside the action is stored with the CEO agent as actor and the action id as causation |
| `apps/runner/src/aom/aom-cli.ts` | `aom ceo act <action> --<flag> <value>`: `ceoParams` turns every non-control flag into a camelCase param (`--target-workstation-id` -> `targetWorkstationId`). The runner needs **no change** |

How the existing agent actions behave:

- The CEO borrows the **org Owner's** rights: `env.owner = ownerPrincipal(ctx, orgId)` (`organizations.owner_user_id`).
  Commands are called with `env.owner`, for example `setAgentAllowedProjects(env.ctx, env.owner, a.id, ids)`.
- `prepare` looks the agent up with `agentByName(pool, orgId, nameOrId)` (`apps/server/src/ceo/actions.ts:85`). This
  finds agents of the CEO's organisation only, by name or id, any status.
- Workstations are resolved by name or id, and only among the Owner's own (`user_id = owner OR simulation_org_id = org`,
  see `hire` and `scale`).
- The CEO actor in the audit trail comes for free: events written with `userActor(env.owner.id)` inside
  `withActingAgent` are stored as `agent:<ceoId>` with causation = the action id. `CeoActionTaken` itself has
  `agentActor(env.agentId)`.
- **Gap:** refusals are not audited today. `prepared.refuse` returns `{status:'refused'}` (`engine.ts:389`) and writes
  nothing. An `HttpError` thrown inside `execute` is caught (`engine.ts:482`) and returned as `refused`, and nothing is
  written either. Only a policy `deny` appends a `CeoActionTaken` with mode `refused`. The card requires refusals in
  the audit log too (section 4.4).

### 2.3 The move as GWP-59 landed it (`apps/server/src/commands/sharing.ts`, lines 349-486)

- `loadMovableAgent(tx, user, agentId)` (line 355): 404 for an unknown agent, 403 unless the caller's `orgRoleOf` is
  `owner` or `admin` (`isOrgManager`). The org Owner has an `org_members` row with role `owner`, so `env.owner` passes.
  The `GET /api/agents/:id/move-targets` route uses it too.
- `rehomeAgent(ctx, user, agentId, req)` (line 369): `withAppendTx` + `loadMovableAgent` + `rehomeAgentIn(..., {userId:
  user.id, actor: userActor(user.id)}, a, req)`. Returns `void`.
- `rehomeAgentIn(ctx, tx, by, a, req)` (line 385) is the move core. It validates **inline**, in this order, and throws
  `HttpError` before anything is appended:
  1. `status = 'retired'` -> 409 `agent_retired`.
  2. `is_builtin` -> 409 `builtin_agent` (the CEO: "moves on the CEO page"; DevOps: "stays with its workstation").
  3. Running shift: `shifts` row with `status <> 'ended'`, **skipped for `needs_rehome` agents** (an orphaned shift must
     not block a re-home) -> 409 `agent_busy`.
  4. A claimed card (`cards.claimed_by_agent_id = agent AND claim_id IS NOT NULL`) -> 409 `agent_busy`.
  5. Target: `orgWorkstationSql` (`apps/server/src/queries/move-targets.ts:6`: active workstation of an active member of
     the org, or the org's simulated one). An unpaired workstation of a member -> 409 `workstation_unpaired`; unknown
     or other-org -> 404 `workstation_not_found` "workstation not found in this organization".
  6. Same workstation -> 409 `same_workstation`.
  7. `sandboxGate(...)` (`apps/server/src/commands/agents.ts:227`, reads only): direct runtime, runtime/role fit,
     `sandbox_unavailable`, `unsandboxed_ack_required` unless acknowledged.
  8. Workstation count delta, then `assertWithinLimit(..., 'workstations')` (reads only).
  9. Appends `AgentRehomed {agentId, workstationId, fromWorkstationId, runtime, model, unsandboxedAck?}` with `by.actor`.
- **There is no separate read-only pre-check.** All checks 1-8 are reads, but they sit inside `rehomeAgentIn`, mixed
  with the append. This card extracts them (section 4.3a).
- The route (`apps/server/src/routes/sharing.ts:84-92`) only calls `rehomeAgent` and returns the DTO. It does **not**
  trigger the dispatcher, so the CEO adapter does not either.

### 2.4 Traps

1. **Sandbox acknowledgement.** `acknowledgeUnsandboxed: true` would let an agent run without an OS sandbox. That
   widens permissions (`agent.widen_permissions` is in `HARD_NEVER`). The CEO always passes `false`. If the target
   needs the acknowledgement, the move is refused with sandboxGate's message (the Owner accepts it in the UI).
2. **Duplicated validation.** Retired, built-in (CEO/DevOps), running-shift, claimed-card, target and same-workstation
   checks all live in GWP-59's core. The CEO adapter must not repeat any of them: it gets them from the extracted
   pre-check (4.3a).
3. **Refusal audit and idempotency.** If a refusal were audited with the call's normal idempotency key, the CEO's
   retry after the cause clears (for example the shift ended) would come back as `duplicate`. Refusal audits must use
   their own key.
4. **Workstations of other members.** GWP-59 lets an Owner/Admin move an agent to any workstation of the
   organisation. A CEO move onto another member's machine would run work on that member's computer and account
   without their say. Today's CEO `hire` and `scale` only use the Owner's own workstations. Matching that keeps the
   action from being more permissive than the others. This is the only CEO-specific rule in the adapter.

### 2.5 guildwise-cloud

guildwise-cloud uses this core as a submodule (`@aom/shared` via workspace). The action, the policy and the executor
are all in the core. guildwise-cloud needs **no change**, unless one of its files has a `Record<ActionClass, ...>`
(the typecheck would say so). In that case it is one added label, made in the same release.

## 3. Options compared

### 3.1 Mode of `agent.move_workstation`

| Option | For | Against |
| --- | --- | --- |
| `decide` (like `agent.allow_list`) | Owner chat "move Ada to my new laptop" just happens | A wake (for example "workstation offline") could make the CEO move agents between machines on its own. A sleeping laptop is not a dead one. Cards homed on the old workstation may be stranded |
| **`recommend` (chosen)** | Owner turn: an inline Approve / No card in the chat (one click). Wake: a desk recommendation. Stricter than the other agent actions, never looser. The Owner can switch it to `decide` in Settings > CEO > Policy | One click per agent. Bulk moves belong to GWP-61 (UI) anyway |
| `never` | Safest | Does not meet the card |

The class also goes into `STAFFING_CLASSES` (it changes where an agent works) and `UNTRUSTED_RECOMMEND`. If the Owner
sets it to `decide`, a wake triggered by outside text still only recommends, exactly like `agent.allow_list`.

### 3.2 Where validation lives

| Option | Verdict |
| --- | --- |
| Copy the checks into the CEO adapter | Rejected: the card forbids duplicating validation, and the copies would drift |
| Only `execute` validates (call `rehomeAgent` and let its `HttpError` become `refused`) | Rejected: a running-shift or same-workstation case would still produce a recommendation the Owner approves, which then fails. Dry runs would not show the reason |
| **Extract GWP-59's checks into one read-only `checkAgentMove`; `rehomeAgentIn` and the CEO `prepare` both call it** | Chosen. `prepare` gives early, clear reasons (dry run and recommendation show them). `execute` calls `rehomeAgent`, which checks again inside its transaction (a shift may start in between) |

### 3.3 Auditing refusals

| Option | Verdict |
| --- | --- |
| Audit every refusal of every action | Rejected: it changes the behaviour of about 40 actions, and with the shared key their retries would become `duplicate` |
| **Opt-in flag on `ActionDef` (`auditRefusals: true`), with a refusal-specific idempotency key** | Chosen: small, existing actions are unchanged |

## 4. Design

### 4.1 Shared: `packages/shared/src/ceo/policy.ts`

```ts
export const ACTION_CLASSES = [
  ...,
  'agent.allow_list',
  'agent.move_workstation',          // new, right after allow_list
  'agent.hire',
  ...
] as const;

export const STAFFING_CLASSES = [..., 'agent.allow_list', 'agent.move_workstation'];

CLASS_LABEL['agent.move_workstation'] = 'Move an agent to another workstation';

DEFAULT_CEO_POLICY.classes['agent.move_workstation'] = recommend;

const UNTRUSTED_RECOMMEND = [..., 'agent.allow_list', 'agent.move_workstation', ...];

/** `aom ceo act move-workstation --agent-id <name|id> --target-workstation-id <name|id>`. */
export const MoveWorkstationParamsSchema = z
  .object({
    agentId: z.string().trim().min(1).max(120),            // agent name or id, as with the other agent actions
    targetWorkstationId: z.string().trim().min(1).max(120), // workstation name or id (the snapshot shows both)
  })
  .strict(); // a mistyped flag (--workstation) is refused with a clear message instead of being ignored
export type MoveWorkstationParams = z.infer<typeof MoveWorkstationParamsSchema>;
```

`agent.allow_list` itself is unchanged: same position, label, mode and set membership.

### 4.2 Shared: `packages/shared/src/ceo/ipc.ts`

Add `'move-workstation'` to `CEO_ACTIONS`, with a doc comment (like `move`).

### 4.3a Server: extract GWP-59's checks (`apps/server/src/commands/sharing.ts`), no behaviour change

Split `rehomeAgentIn` into a read-only check and the append. Same checks, same order, same codes and messages.

```ts
export interface AgentMovePlan {
  w: Row;                               // the target workstation row (id, name, status, user_id, in_org)
  unsandboxedAck: UnsandboxedAck | undefined;
}

/**
 * Every rule of a move, reads only: throws the HttpError the move would throw and returns what the append needs.
 * `rehomeAgentIn` runs it inside its append transaction; the CEO's `move-workstation` runs it to refuse early.
 */
export async function checkAgentMove(
  ctx: Ctx,
  db: Queryable,
  by: { userId: string },
  a: Row,
  req: RehomeAgentRequest,
): Promise<AgentMovePlan> {
  // steps 1-8 of section 2.3, moved verbatim from rehomeAgentIn (retired, builtin, running shift unless needs_rehome,
  // claimed card, target in org / unpaired, same workstation, sandboxGate, workstation limit)
}

export async function rehomeAgentIn(ctx, tx, by, a, req) {
  const { w, unsandboxedAck } = await checkAgentMove(ctx, tx, by, a, req);
  await ctx.store.append([... AgentRehomed exactly as today ...], { tx });
  return { fromWorkstationId: a.workstation_id ?? null, toWorkstationId: w.id };
}
```

- `sandboxGate` is typed `tx: Tx`; it only calls `one(...)`. Widen its parameter to `Queryable` (`Tx = PoolClient &
  Queryable`, so every existing caller still type-checks), or keep `checkAgentMove` typed `Tx` and run the CEO
  `prepare` call inside a read-only `withTx`. Widening is simpler.
- `planLimits.assertWithin` already takes `Queryable`.
- The existing GWP-59 tests are the regression net for "no behaviour change": run them unchanged.

### 4.3b Server: the action adapter

New file `apps/server/src/ceo/actions7.ts` (keeps `actions2.ts` untouched), registered in `registry.ts` as
`...ACTIONS7`.

```ts
const moveWorkstation: ActionDef<MoveWorkstationParams> = {
  cls: 'agent.move_workstation',
  schema: MoveWorkstationParamsSchema,
  auditRefusals: true,                                     // 4.4
  describe: (_p, pr) => `Move ${pr.subjectLabel} from ${pr.data?.from ?? 'no workstation'} to ${pr.data?.to}`,
  async prepare(env, p) {
    const db = env.ctx.pool;
    const a = await agentByName(db, env.orgId, p.agentId);
    if (!a) return refuse(`agent ${p.agentId} not found in this organization`);
    const base = { subjectKind: 'agent', subjectId: a.id, subjectLabel: `${a.name} (${a.role_key})`, targetAgentId: a.id };
    // The CEO's only own rule: the Owner's workstations (as hire and scale), by name or id, any status (so an
    // unpaired one gets GWP-59's "was unpaired" message), the active one first when names collide.
    const ws = await one(db,
      `SELECT id, name, connected FROM workstations
        WHERE (id::text=$2 OR lower(name)=lower($2)) AND (user_id=$3 OR simulation_org_id=$1)
        ORDER BY (status='active') DESC LIMIT 1`,
      [env.orgId, p.targetWorkstationId, env.owner.id]);
    if (!ws) {
      const member = await one(db,
        `SELECT w.name FROM workstations w
          WHERE (w.id::text=$2 OR lower(w.name)=lower($2)) AND ${orgWorkstationSql('w', '$1::uuid')} LIMIT 1`,
        [env.orgId, p.targetWorkstationId]);
      return { ...base, refuse: member
        ? `${member.name} belongs to another member: the owner moves agents there in the UI (Agents, Move to workstation)`
        : 'workstation not found in this organization' };  // unknown and other-org read the same: no leak
    }
    const req = { workstationId: ws.id, runtime: a.runtime, model: a.model, acknowledgeUnsandboxed: false };
    try {
      await checkAgentMove(env.ctx, db, { userId: env.owner.id }, a, req);   // GWP-59's rules, not a copy
    } catch (err) {
      if (err instanceof HttpError) return { ...base, refuse: err.message };
      throw err;
    }
    const from = a.workstation_id ? await one(db, 'SELECT name FROM workstations WHERE id=$1', [a.workstation_id]) : undefined;
    return { ...base, data: { agent: a, ws, req, from: from?.name ?? null, to: ws.name } };
  },
  async execute(env, _p, pr) {
    const { agent: a, ws, req } = pr.data as { agent: Row; ws: Row; req: RehomeAgentRequest };
    // GWP-59's move, as the Owner principal (passes loadMovableAgent as role owner). Inside withActingAgent the
    // AgentRehomed event carries the CEO as actor and the action id as causation. It re-checks in its transaction.
    await rehomeAgent(env.ctx, env.owner, a.id, req);
    return {
      message: `${a.name} moved to ${ws.name}${ws.connected ? '' : ` (${ws.name} is offline: it works once it connects)`}.`,
      result: { agentId: a.id, fromWorkstationId: a.workstation_id ?? null, toWorkstationId: ws.id },
    };
  },
};
export const ACTIONS7: Partial<Record<CeoActionName, ActionDef>> = { 'move-workstation': moveWorkstation };
```

Notes:

- The adapter has **no** retired, DevOps, CEO, shift, claim, same-workstation or org check of its own: they all come
  from `checkAgentMove`. Its only own rule is "the Owner's workstations" (2.4 trap 4).
- `needs_rehome` agents can be moved too (GWP-59 accepts them and skips the shift check for them).
- No dispatcher trigger: the owner/admin route does not trigger one either ("moved exactly as the owner/admin move").
- Every `HttpError` `rehomeAgent` throws in `execute` (a shift or claim started meanwhile, target gone, limit) is
  returned to the CEO as `refused` with the error message by the existing `runAction` catch. 4.4 adds the audit entry.
- No inverse (undo) for now. The usual "from" workstation is dead, so an undo there is meaningless. The Owner can move
  the agent back from the Agents page.

### 4.4 Server: opt-in refusal audit (`types.ts`, `engine.ts`)

```ts
// types.ts, ActionDef
/** Refusals (prepare's or the command's) are written to the audit log too, with their own idempotency key. */
auditRefusals?: boolean;
```

In `runAction`:

- After `prepare` (`engine.ts:389`): if `prepared.refuse && def.auditRefusals && !rpc.dryRun`, append
  `auditEvent(env, origin, def, call, prepared, 'refused', {verdict:'deny', reason: prepared.refuse}, refusalKey)`.
  Then return the same `refused` result as today, with `mode: 'refused'` and the `actionId`.
- In the `catch` (`engine.ts:482`, `err instanceof HttpError`): the same, when `def` is set, `def.auditRefusals` is
  true and the call got as far as `prepared` (hoist `prepared`, `call` and `eff` out of the `try` as `let`).
- `refusalKey = \`${key}:refused:${env.actionId}\``. It is unique, so a retry after the cause clears runs normally and
  is not reported as `duplicate`. The `ceo_actions` projection then has one `refused` row per refused attempt, with
  the CEO as actor (`agentActor(env.agentId)`). These rows do not count toward `maxActionsPerHour`, which counts
  `mode='decided'` only.
- Leave `cause` out of the verdict. `PolicyVerdict['cause']` has no value for "command refused", and the payload's
  `cause` is optional.
- A dry run never writes. Keep the `rpc.dryRun` return (`engine.ts:423`) ahead of any refusal audit that comes from
  `execute`.

Actions without the flag behave exactly as before.

### 4.5 The CEO's instructions

The CEO learns its actions from its role prompt or action reference. Search `packages/shared` and the catalogue for
the text that documents `pause-agent` or `act allow`, and add one line next to it:

`move-workstation --agent-id <name|id> --target-workstation-id <name|id>`: move an agent to one of the Owner's
workstations (recommended to the owner by default; refused while the agent is in a running shift or on a card).

### 4.6 Data model

No migration. `CeoActionTaken.class` is a free string. `AgentRehomed` stays as GWP-59 defines it. The CEO only changes
its actor (through `withActingAgent`).

### 4.7 What the CEO gets back

| Situation | CEO receives |
| --- | --- |
| Default policy (`recommend`), owner turn | `recommended`, inline Approve / No card. On Approve the engine re-runs with `force` and the agent is moved |
| Default policy, wake | `recommended`, desk item "CEO recommends: Move Ada (builder) from My workstation to Laptop" |
| Mode `decide`, trusted, confidence ok | `executed`: "Ada moved to Laptop." |
| Mode `decide`, untrusted wake | `recommended` (cause `untrusted`) |
| Unknown or other-org workstation | `refused`: "workstation not found in this organization" |
| Another member's workstation | `refused`: "... belongs to another member: the owner moves agents there in the UI" |
| Owner's unpaired workstation | `refused`: GWP-59's "X was unpaired: pick a paired workstation" |
| Current workstation | `refused`: GWP-59's "Ada already works on Laptop" |
| Running shift | `refused`: GWP-59's "Ada is in a running shift: wait until it ends or stop it, then move Ada." |
| Claimed card | `refused`: GWP-59's "Ada is working on GWP-12: release the card or wait until the shift ends." |
| Retired / CEO / DevOps agent | `refused`: GWP-59's `agent_retired` / `builtin_agent` messages |
| No OS sandbox on target | `refused`: sandboxGate's `unsandboxed_ack_required` message |

## 5. Acceptance criteria -> design

| AC | Where it is met | Test |
| --- | --- | --- |
| 1. Policy has the new action with `agentId`, `targetWorkstationId` | 4.1 (`ACTION_CLASSES`, label, mode, `MoveWorkstationParamsSchema`), 4.2 | shared test: class, label, default mode, schema valid/invalid |
| 2. Moves exactly like the owner/admin move; audit shows CEO as actor | 4.3b `execute` calls GWP-59's `rehomeAgent`; `withActingAgent` rewrites the actor; `CeoActionTaken` decided | server test: agent's `workstation_id` changes, `AgentRehomed` actor = `agent:<ceoId>`, causation = action id |
| 3. Invalid targets and running shift refused, CEO gets the reason | 4.3a `checkAgentMove` in `prepare` + the core re-check in `execute`; 4.4 audits it | server test per case: `status:'refused'`, message names the reason, a `CeoActionTaken` mode `refused` with the CEO as actor, agent not moved; a retry after the shift ends is not `duplicate` |
| 4. Same approval/permission rules, not more permissive | Same `runAction` path; mode `recommend`; in `UNTRUSTED_RECOMMEND` and `STAFFING_CLASSES`; Owner's workstations only; never acknowledges unsandboxed; `loadMovableAgent` still applies | shared test: `evaluatePolicy` default -> recommend, owner origin -> inline, decide + untrusted -> recommend, never -> deny; server test: default policy -> recommended, nothing moved |
| 5. `agent.allow_list` unchanged | 4.1 leaves it as it is | shared test: its mode, label and set membership; server test: `allow` still only writes `AgentAllowedSet`, the workstation is unchanged |

## 6. Tests (all in new files)

- `packages/shared/test/ceo-policy-move-workstation.test.ts`: class, label, default mode `recommend`,
  `isStaffingClass`, `CeoActionName` contains `move-workstation`; `evaluatePolicy` cases from AC 4;
  `MoveWorkstationParamsSchema`: valid (names, uuids, trims), invalid (missing either, empty, over 120 characters,
  unknown key); `agent.allow_list` regression (mode, label, staffing, untrusted -> recommend).
- `apps/server/test/ceo-move-workstation.test.ts`: copy the world setup from an existing CEO action test (an `allow`
  or `pause-agent` test). Set the policy to `decide` for the execute cases, or call with `force`. Cover: moved and
  actor check; `recommended` under the default policy; refusals (unknown workstation, another org's workstation,
  current workstation, another member's workstation, running shift, claimed card, DevOps agent, CEO agent, unsandboxed
  target); refusals audited; retry not `duplicate`; dry run writes nothing; `allow` regression.
- `apps/server/test/agent-move-check.test.ts`: `checkAgentMove` throws the same codes as the move for each rule and
  writes nothing (no new events).
- Engine regression (same server file or `apps/server/test/ceo-engine-refusal-audit.test.ts`): an action without
  `auditRefusals` still writes no `CeoActionTaken` on a `prepare` refusal.
- Run GWP-59's existing move tests unchanged: they guard the extraction (4.3a).

If an existing test fails because it counts `ACTION_CLASSES`/`CEO_ACTIONS` or snapshots the default policy, update it
and add its full path to the card's Affected areas with a one-line reason (the runner's out_of_scope_test_change
check matches literal paths).

## 7. Risks

- **The extraction changes order or messages.** Move the code verbatim; GWP-59's tests catch drift.
- **Cards homed on the old workstation.** Moving an agent does not move its card worktrees. This is GWP-59's concern
  (same for the UI). The CEO path adds nothing.
- **Typecheck elsewhere.** Any other `Record<ActionClass, ...>` (web policy editor, guildwise-cloud) needs a label.
  Run `pnpm -r typecheck`.
- **Policy UI.** The policy editor lists classes from `ACTION_CLASSES`/`CLASS_LABEL`, so the new class appears there.
  Check that it shows in the staffing group.

## 8. Assumptions about GWP-59, checked against the landed code

1. **Holds.** `rehomeAgent(ctx, user, agentId, req)` is exported and takes the Owner principal. `rehomeAgentIn` accepts
   `active` and `needs_rehome`, checks the target (`orgWorkstationSql`: active, same org), the current workstation and
   the running shift, and throws `HttpError` with readable messages.
2. **Did not hold.** There is no read-only pre-check: the checks are inline in `rehomeAgentIn`. This card extracts them
   into `checkAgentMove` (4.3a) with no behaviour change, and `rehomeAgentIn` calls it.
3. **Holds.** `rehomeAgent` appends `AgentRehomed` with `userActor(user.id)`, so `withActingAgent` records the CEO.
4. **Holds.** `loadMovableAgent` requires `orgRoleOf` owner/admin; the Owner has an `org_members` row with role `owner`.
5. **Holds**, with GWP-59's refinement: a `shifts` row with `status <> 'ended'`, not checked for `needs_rehome` agents.
   GWP-59 also refuses an agent with a claimed card. The adapter has no SQL of its own for either.

## 9. Revision note (2026-11-03)

Changed after GWP-59 landed: assumption 2 did not hold, so 4.3a adds the extraction of `checkAgentMove`. Because
GWP-59's core already refuses retired and built-in (CEO, DevOps) agents, the adapter's own copies of those checks are
removed (they would have duplicated validation). The dispatcher trigger is removed (the owner/admin route has none).
The CEO table (4.7) uses GWP-59's actual messages and adds the claimed-card and unpaired cases.
