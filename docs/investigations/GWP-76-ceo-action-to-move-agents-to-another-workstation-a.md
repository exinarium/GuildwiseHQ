# GWP-76: CEO action to move agents to another workstation (`aom ceo act`)

Status: design, 2026-11-03; revised 2026-11-04 after GWP-61, GWP-74 and GWP-75 landed on `main` (commit `40b0d67d`).
Repository: GuildwiseHQ (core). Target: `release/1.5.0`.

Revision of 2026-11-04 (section 8 has the per-assumption check):

- Assumption 1: `moveAllAgents` landed with the expected signature, but its response has no `skipped` / `failed`. It
  has one `blocked[{agentId, name, reason, code, message}]` list, and `moved[]` items carry `releasedClaims`.
  `bulkOutcome` (4.4c) is remapped.
- Assumption 4: GWP-75 replaced GWP-61's skip reasons and `SKIP_TEXT`. Every agent now goes through `checkAgentMove`,
  and the reason is `MoveBlockReason` = `running_shift | one_devops | workstation_limit | sandbox_gate |
  runtime_missing | ceo | other`. The dialog shows a short label (`REASON_LABEL` in `MoveAllAgentsDialog.tsx`) and
  then the single move's own message. Section 4.3 now moves `REASON_LABEL` to shared instead of `SKIP_TEXT`, and there
  is no `moveSkipText`.
- Assumptions 2, 3, 5, 6 and 7 hold. The rest of the design is unchanged.

## 1. Question

The CEO needs the Owner's move through `aom ceo act`:

- move one agent to a named workstation;
- move every agent off a named offline or removed workstation.

Both actions must use the server move commands, so every check stays the same: target among the org owner's active
workstations, sandbox gate, workstation limit, one DevOps engineer per workstation, running-shift refusal, claim
release, and `AgentRehomed`. The CEO is the actor, and every call needs a reason. The runner CLI prints the outcome,
per agent for the bulk move. The CEO's instructions name both actions and give it the facts it needs to decide.

## 2. Findings (code on `main`, commit `40b0d67d`)

### 2.1 The single CEO move already exists (GWP-60)

GWP-60 added the CEO action `move-workstation` (`apps/server/src/ceo/actions7.ts`):

- `packages/shared/src/ceo/ipc.ts`: `'move-workstation'` is in `CEO_ACTIONS`.
- `packages/shared/src/ceo/policy.ts`: class `agent.move_workstation`, label "Move an agent to another workstation",
  default mode `recommend`. It is in `STAFFING_CLASSES` and `UNTRUSTED_RECOMMEND`. Its params schema is
  `MoveWorkstationParamsSchema = { agentId, targetWorkstationId }.strict()`.
- `prepare` looks up the agent (`agentByName`) and the target among **the Owner's own workstations** by name or id
  (`user_id = owner OR simulation_org_id = org`). Another member's workstation gets "belongs to another member". Unknown
  and other-org workstations get "workstation not found in this organization". Then
  `checkAgentMove(..., { releaseHeldClaims: true })` (`apps/server/src/commands/sharing.ts:404`) runs every rule of the
  move, reads only, and its `HttpError` message becomes the refusal.
- `execute` calls `rehomeAgent(env.ctx, env.owner, a.id, req)`. That checks again inside its own `withAppendTx` and
  releases held claims (`rehomeAgentIn`). `withActingAgent` stores the `AgentRehomed` (and any `ClaimReleased` /
  `BaTaskRequeued`) with actor `agent:<ceoId>` and causation = the action id.
- `auditRefusals: true`: every refusal from `prepare` or `execute` writes a `CeoActionTaken` with mode `refused` and
  the CEO as actor (`engine.ts`).
- The CEO never passes `acknowledgeUnsandboxed` (`agent.widen_permissions` is `HARD_NEVER`).
- Tests: `apps/server/test/ceo-move-workstation.test.ts` and `packages/shared/test/ceo-policy-move-workstation.test.ts`.
- The prompt line is in `CEO_CLI_HELP` (`packages/shared/src/prompt/ceo.ts:14`). It still says "refused while the
  agent is in a running shift or on a card", which is no longer true (claims are released).

Most of requirements 1 to 3 for the **single** move are already built. A second single-move action would duplicate it.

### 2.2 The bulk server command (GWP-61/75, landed)

`apps/server/src/commands/sharing.ts:680`:

```ts
moveAllAgents(ctx, who: { userId, orgId, role: OrgRole | null }, sourceId,
              req: MoveAllAgentsRequest /* {targetWorkstationId, acknowledgeUnsandboxed?} */,
              opts: { dryRun?: boolean } = {}): Promise<MoveAllAgentsResponse>
```

- Response (`packages/shared/src/api/agents.ts:176`): `{ dryRun, scope: 'all'|'own', source{id, name, status:
  'active'|'unlinked', connected}, target{id, name}, moved[{agentId, name, releasedClaims[]}], blocked[{agentId, name,
  reason: MoveBlockReason, code, message}], needsUnsandboxedAck }`.
- `source === target` throws `same_workstation` (400) before anything. The source is checked by
  `loadSourceWorkstation` (any status, so a removed workstation is a valid source; also a member's workstation that
  holds the org's agents). The target must be in the org (`orgWorkstationSql`); a member's unpaired target gets
  `workstation_unpaired`; else `workstation_not_found`.
- An Owner/Admin (`isOrgManager(role)`) moves every non-retired agent of the source, including built-ins. The CEO is
  never moved: `checkAgentMove` throws `builtin_agent` and it is listed as blocked with reason `ceo`.
- Pass 1 runs `checkAgentMove(..., {releaseHeldClaims: true, skipLimitCheck: true})` per agent. If every
  limit-counting agent passes, the source empties and the limit is not asked. Otherwise pass 2 checks the limit too.
  Each refusal becomes a `blocked` item: `reason = moveBlockReason(code)`, `code`, `message` = the single move's
  `HttpError` message.
- Real run: one `withAppendTx` per agent through `loadMovableAgent` + `rehomeAgentIn` (claim release, `AgentRehomed`).
  A failure of one agent lands in `blocked` and does not roll back the others. `dryRun` writes nothing and is the UI
  preview (`GET /api/workstations/:id/move-agents/preview`).
- `moveAllAgents` does **not** require the source to be offline or removed.
- The route triggers `ctx.services.dispatcher.trigger()` when `moved.length > 0`.
- The dialog (`apps/web/src/components/agents/MoveAllAgentsDialog.tsx`) shows per blocked agent
  `name · REASON_LABEL[reason]` and then `message`. `REASON_LABEL` is a local map.

### 2.3 What GWP-74 changed underneath (landed)

- `checkAgentMove`: running shift → `agent_busy` ("is in a running shift: wait until it ends or stop it, then move
  …"). With `releaseHeldClaims` a held claim is not refused; `rehomeAgentIn` releases it (`ClaimReleased`, reason
  `agent_moved`) and requeues running BA tasks in the same append.
- DevOps: `devops_stays` (the DevOps engineer of a still-paired workstation stays) and `one_devops_per_workstation`
  (names `agents_one_devops`). Built-in agents never count toward the limit (`delta = 0`).
- `loadMovableAgent` lets Owner/Admin move any agent and the hiring manager its own non-built-in agents.
  `rehomeAgent(ctx, user, agentId, req)` keeps its signature.

The CEO actions call these commands, so they get all of this without any code of their own.

### 2.4 Workstation states

- Removed = `workstations.status = 'unlinked'`. `WorkstationUnlinked` sets this and `connected = false`. The row stays,
  so a removed workstation can still be named as a source. Its agents keep `workstation_id` pointing at it.
- Offline = `status = 'active' AND NOT connected`.

### 2.5 What the CEO sees today (`apps/server/src/ceo/snapshot.ts`)

- Agents (line 155): `ws=<name>` plus ` (offline)` when the workstation is not online. A removed workstation shows as
  "(offline)", so the CEO cannot tell offline from removed.
- Workstations (line 166): only `status = 'active'` workstations that hold org agents. Removed workstations that still
  hold agents are missing, and so are their ids. The available targets (the Owner's active workstations) are not
  listed anywhere.

### 2.6 Reason, CLI, prompt

- Reason: `CeoActRpc` requires `reason` (min 3) and `confidence` (`ipc.ts`). The gateway refuses a call without them:
  "invalid request: reason ...". The CLI `ceoReasoned` throws `UsageError` before any RPC. AC 5 already holds for
  every action. This card only adds tests.
- CLI: `aom ceo act <action>` turns every flag that is not a control flag into a camelCase param (`ceoParams`).
  `--agent`, `--to` and `--from` already reach the server as `agent`, `to` and `from`. `ceoPrint` prints
  `status: message`, and a multi-line message prints as it is. Exit code 1 means `refused`.
- The prompt has `CEO_CLI_HELP`, used by `renderCeoInstructions` (shift) and `renderCeoChatSection` (chat).

## 3. Options compared

### 3.1 The single move

| Option | Verdict |
| --- | --- |
| New action id `move-agent` next to `move-workstation` | Rejected: two actions do the same thing, two prompt lines, and they will drift |
| **Keep `move-workstation` (GWP-60). Accept `--agent` / `--to` as aliases of `--agent-id` / `--target-workstation-id`** | **Chosen.** It meets requirement 4's parameter names, the other agent actions already use `--agent`, and existing calls and stored recommendations keep working |

### 3.2 The bulk move: wrap or loop

| Option | Verdict |
| --- | --- |
| The CEO action loops over the agents and calls `rehomeAgent` per agent | Rejected: it would copy GWP-75's two-pass limit logic and block reasons, and those would drift from the UI |
| **Call `moveAllAgents` (dry run in `prepare`, real run in `execute`)** | **Chosen.** The preview and the result are exactly what the UI shows. No check is duplicated |

### 3.3 Policy class of the bulk move

| Option | Verdict |
| --- | --- |
| New class `agent.move_workstation_all` | Needs a label in every `Record<ActionClass, …>` (web policy editor, guildwise-cloud) and its own default. Not asked for |
| **Same class `agent.move_workstation`** | **Chosen.** Same kind of change. Default `recommend`, untrusted wakes only recommend, and the Owner sets one switch for both. One bulk call is one CEO action in the hourly limit |

### 3.4 Source restriction

The target stays **the Owner's own active workstations**, as in GWP-60 and this card's AC 4. The source may be any
workstation that holds the org's agents (owner or member). With the default policy the Owner approves the move anyway.
The source must be **offline or removed**, as the card says. `moveAllAgents` does not check this (2.2), so the CEO
action refuses an online, active source itself with "move its agents one by one with move-workstation". This is the
only CEO-specific rule of the bulk action besides the Owner-only target.

## 4. Design

### 4.1 Shared: `packages/shared/src/ceo/policy.ts`

```ts
/** `--agent`/`--to` (the other agent actions' names) are aliases of `--agent-id`/`--target-workstation-id`. */
const moveAliases = (v: unknown): unknown => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const { agent, to, ...rest } = v as Record<string, unknown>;
  return {
    ...rest,
    ...(rest.agentId === undefined && agent !== undefined ? { agentId: agent } : agent !== undefined ? { agent } : {}),
    ...(rest.targetWorkstationId === undefined && to !== undefined ? { targetWorkstationId: to } : to !== undefined ? { to } : {}),
  };
};
export const MoveWorkstationParamsSchema = z.preprocess(
  moveAliases,
  z.object({
    agentId: z.string().trim().min(1).max(120),
    targetWorkstationId: z.string().trim().min(1).max(120),
  }).strict(),   // both spellings at once: the alias stays and strict() refuses it
);
export type MoveWorkstationParams = z.infer<typeof MoveWorkstationParamsSchema>;

/** `aom ceo act move-agents-off --from <name|id> --to <name|id>`. */
export const MoveAgentsOffParamsSchema = z.object({
  from: z.string().trim().min(1).max(120),   // the offline or removed workstation
  to: z.string().trim().min(1).max(120),     // one of the Owner's active workstations
}).strict();
export type MoveAgentsOffParams = z.infer<typeof MoveAgentsOffParamsSchema>;
```

Check that `ActionDef<P>.schema: z.ZodType<P>` accepts the `z.preprocess` (zod 4: input `unknown`, output `P`). If the
typecheck objects, map the aliases in the action's `prepare` instead and keep the plain object, with `agent`/`to` as
optional keys and a refinement that one of each pair is given.

### 4.2 Shared: `packages/shared/src/ceo/ipc.ts`

Add `'move-agents-off'` right after `'move-workstation'`, with a doc comment:
`/** \`aom ceo act move-agents-off\`: move every movable agent off an offline or removed workstation (the owner's bulk move). */`

### 4.3 Shared: one wording for the block reasons (revised)

The landed UI shows `REASON_LABEL[reason]` and then the single move's `message` (2.2). Move the label map out of
`MoveAllAgentsDialog.tsx` into `packages/shared/src/api/agents.ts`, next to `MoveBlockReasonSchema`, with the same
texts:

```ts
/** The short label the UI shows for why a bulk move leaves an agent where it is (the message follows it). */
export const MOVE_BLOCK_LABEL: Record<MoveBlockReason, string> = {
  running_shift: 'In a running shift',
  one_devops: 'One DevOps engineer per workstation',
  workstation_limit: 'Workstation limit reached',
  sandbox_gate: 'Sandbox',
  runtime_missing: 'Runtime missing on the target',
  ceo: 'The CEO moves on the CEO page',
  other: 'Cannot move',
};
```

The dialog imports `MOVE_BLOCK_LABEL` instead of its local `REASON_LABEL`, with no visible change. The CEO prints the
same label and the same message, so its reasons are the UI's (AC 3). There is no `moveSkipText`: `blocked[].message`
is already the single move's text.

### 4.4 Server: `apps/server/src/ceo/actions7.ts`

**a) Extract the Owner-target lookup** from `moveWorkstation.prepare`, with no behaviour change, so both actions use it:

```ts
/** One of the Owner's workstations by name or id (the active one first), or the refusal text. */
async function ownerTarget(env: ActionEnv, ref: string): Promise<{ ws: Row } | { refuse: string }> {
  // the two queries moved verbatim from moveWorkstation.prepare (Owner's own; else "belongs to another member";
  // else "workstation not found in this organization")
}
```

The Owner's unpaired workstation is still found here and then refused by `checkAgentMove` / `moveAllAgents`
(`workstation_unpaired` / `workstation_not_found`). The CEO never gets past the Owner's **active** workstations (AC 4).

**b) `moveWorkstation`**: only the params change. Its schema is the aliased one (4.1). Its body keeps using
`p.agentId` / `p.targetWorkstationId` and calls `ownerTarget`. It already passes `releaseHeldClaims: true`.

**c) New `moveAgentsOff`** (revised: `bulkOutcome` maps the landed `blocked` list):

```ts
type BulkOutcome = {
  moved: Array<{ agentId: string; name: string; releasedClaims: string[] }>;
  blocked: Array<{ agentId: string; name: string; reason: MoveBlockReason; code: string; message: string }>;
};

/** The landed response already has the shape; keep only what the CEO and the audit need. */
const bulkOutcome = (r: MoveAllAgentsResponse): BulkOutcome => ({ moved: r.moved, blocked: r.blocked });

/** One line per agent: what the CEO reads, what the CLI prints, what the audit keeps. */
function bulkLines(o: BulkOutcome, verb: 'moved' | 'will move'): string {
  const claims = o.moved.flatMap((m) => m.releasedClaims);
  return [
    ...(o.moved.length ? [`${verb}: ${o.moved.map((m) => m.name).join(', ')}`] : []),
    ...(claims.length ? [`claims released: ${claims.join(', ')}`] : []),
    ...o.blocked.map((b) => `blocked: ${b.name}: ${MOVE_BLOCK_LABEL[b.reason]}: ${b.message}`),
  ].join('\n');
}

const OWNER_ROLE: OrgRole = 'owner';   // env.owner is the org Owner (ownerPrincipal)

const moveAgentsOff: ActionDef<MoveAgentsOffParams> = {
  cls: 'agent.move_workstation',
  schema: MoveAgentsOffParamsSchema,
  auditRefusals: true,
  describe: (_p, pr) => {
    const d = pr.data as { src: Row; to: string; preview: BulkOutcome } | undefined;
    if (!d) return `Move the agents of ${pr.subjectLabel} to another workstation`;
    const stay = d.preview.blocked.map((b) => `${b.name}: ${MOVE_BLOCK_LABEL[b.reason]}`).join(', ');
    return `Move ${d.preview.moved.length} agent(s) (${d.preview.moved.map((m) => m.name).join(', ')}) from ${d.src.name} (${stateOf(d.src)}) to ${d.to}${stay ? `; staying: ${stay}` : ''}`;
  },
  async prepare(env, p) {
    const db = env.ctx.pool;
    const found = await sourceWorkstation(db, env.orgId, p.from);           // see below
    if ('refuse' in found) return refuse(found.refuse);
    const src = found.ws;
    const base = { subjectKind: 'workstation', subjectId: src.id as string, subjectLabel: src.name as string };
    if (src.status === 'active' && src.connected)
      return { ...base, refuse: `${src.name} is online: move its agents one by one with move-workstation` };
    const t = await ownerTarget(env, p.to);
    if ('refuse' in t) return { ...base, refuse: t.refuse };
    const who = { userId: env.owner.id, orgId: env.orgId, role: OWNER_ROLE };
    let preview: MoveAllAgentsResponse;
    try {
      // GWP-75's own preview: every per-agent check the UI shows, nothing appended
      preview = await moveAllAgents(env.ctx, who, src.id, { targetWorkstationId: t.ws.id }, { dryRun: true });
    } catch (err) {
      if (err instanceof HttpError) return { ...base, refuse: err.message };
      throw err;
    }
    const o = bulkOutcome(preview);
    if (o.moved.length === 0)
      return { ...base, refuse: `no agent can move from ${src.name} to ${t.ws.name}:\n${bulkLines(o, 'will move')}` };
    return { ...base, data: { src, target: t.ws, to: t.ws.name, preview: o } };
  },
  async execute(env, _p, pr) {
    const { src, target } = pr.data as { src: Row; target: Row };
    const who = { userId: env.owner.id, orgId: env.orgId, role: OWNER_ROLE };
    const r = await moveAllAgents(env.ctx, who, src.id, { targetWorkstationId: target.id });
    const o = bulkOutcome(r);
    if (o.moved.length === 0)   // everything became blocked since prepare: a refusal, audited, nothing changed
      throw conflict('nothing_moved', `no agent moved from ${src.name} to ${target.name}:\n${bulkLines(o, 'moved')}`);
    env.ctx.services.dispatcher.trigger();   // as the owner/admin route does after a bulk move
    const total = o.moved.length + o.blocked.length;
    return {
      message: `Moved ${o.moved.length} of ${total} agent(s) from ${src.name} to ${target.name}${target.connected ? '' : ` (${target.name} is offline: they work once it connects)`}.\n${bulkLines(o, 'moved')}`,
      result: { sourceWorkstationId: src.id, targetWorkstationId: target.id, ...o },
    };
  },
};

export const ACTIONS7: Partial<Record<CeoActionName, ActionDef>> = {
  'move-workstation': moveWorkstation,
  'move-agents-off': moveAgentsOff,
};
```

`sourceWorkstation(db, orgId, ref)`: the workstations (any status, any owner) that hold this org's non-retired agents,
matched by id or name (case-insensitive):

```sql
SELECT w.id, w.name, w.status, w.connected
  FROM workstations w
 WHERE (w.id::text = $2 OR lower(w.name) = lower($2))
   AND EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.org_id = $1 AND a.status <> 'retired')
 ORDER BY (w.id::text = $2) DESC, w.status, w.id
 LIMIT 5
```

- No row: refuse `workstation ${ref} holds no agents of this organization`. Unknown and other-org workstations read
  the same, so nothing leaks.
- More than one row and no id match: refuse `${n} workstations are named ${ref}: give its id (${id} removed, ${id}
  offline, …)`. A re-paired laptop often keeps its old name, so a removed "My workstation" and an active "My
  workstation" can both exist. Guessing could move the agents off the wrong machine.
- `stateOf(w) = w.status !== 'active' ? 'removed' : w.connected ? 'online' : 'offline'`.

Notes:

- No check is copied. Permission, target in org, unpaired target, same workstation, sandbox gate, runtime, limit
  (including the empty-source exemption), DevOps rules, running shift and claim release all come from `moveAllAgents`
  → `checkAgentMove` / `rehomeAgentIn`.
- `acknowledgeUnsandboxed` is never sent. An agent that needs it is listed as blocked with reason `sandbox_gate` and
  the gate's message. When `needsUnsandboxedAck` is true, add one line: "the owner can accept running without a
  sandbox in the UI (Agents, Move all agents)".
- The CEO itself sits on the Owner's workstation, not usually on a dead one, but if it is there it is listed as
  blocked with reason `ceo` ("the CEO moves on the CEO page"). `moveCeo` stays out of scope.
- Actor: `execute` runs inside `withActingAgent`, so every `AgentRehomed`, `ClaimReleased` and `BaTaskRequeued` that
  `moveAllAgents` appends with `userActor(owner)` is stored as `agent:<ceoId>` with the action id as causation. The
  engine then appends one `CeoActionTaken` (`decided`) whose `result` holds `moved` and `blocked`. That is the audit
  entry (AC 1, AC 2, requirement 3). The builder confirms in S5 that `withActingAgent` rewrites the actor for appends
  made in `moveAllAgents`' own `withAppendTx` (as it does for `rehomeAgent` in GWP-60).
- Partial success is `executed`. Each agent has its own transaction, so moved agents stay moved. Nothing moved means
  `refused` (audited). Nothing changes on a refusal (AC 3).
- `prepare`'s dry run only reads. Undo: none, like `move-workstation`.

### 4.5 Server: `apps/server/src/ceo/snapshot.ts`, the facts the CEO decides on

1. **Agents** query: select `ws.status AS ws_status` too. The suffix becomes ` (removed)` when `ws_status <> 'active'`,
   else ` (offline)` when not online, as today.
2. **Workstations** section: drop `w.status='active'` from the filter (keep the `EXISTS` on org agents). Add
   `w.status` and the count of the org's non-retired, non-built-in agents on it. Render:
   - active: as today, plus ` agents=<n>`;
   - removed: `${name} id=${id} REMOVED agents=<n>`.
   After the list, one line with the targets, which are the Owner's active workstations:
   ```sql
   SELECT w.id, w.name, w.connected FROM workstations w
    WHERE (w.user_id = $owner OR w.simulation_org_id = $1) AND ${orgWorkstationSql('w', '$1::uuid')}
    ORDER BY lower(w.name)
   ```
   `Move targets (the owner's active workstations): Laptop id=… online, Office id=… offline` (or `none`). Get the owner
   id from `organizations.owner_user_id` (the org query at the top of the snapshot already reads the organization).
3. When at least one listed workstation holding agents is offline or removed, add one hint line:
   `Agents on an offline or removed workstation do not work: move them with move-agents-off (or move-workstation per agent).`

The CEO already has `aom ceo show workstation <ref>` and `aom ceo diag workstation` (`diagnostics.ts`,
`resolveWorkstation`). They stay unchanged.

### 4.6 Prompt: `packages/shared/src/prompt/ceo.ts`, `CEO_CLI_HELP`

Replace the `move-workstation` part of line 14 with:

```
move-workstation --agent <name|id> --to <workstation name|id> (one of the owner's active workstations; recommended to the owner by default; refused while the agent is in a running shift; its claimed cards go back to the queue); move-agents-off --from <offline or removed workstation> --to <workstation> (moves every agent that can move, lists the ones that stay and why; the snapshot's Workstations section shows which are offline or REMOVED and the move targets);
```

`renderCeoInstructions` and `renderCeoChatSection` both include `CEO_CLI_HELP`, so the shift and the chat both learn
the actions (AC 6). `renderCeoPrompt` (the wake body) needs no change, because the snapshot (4.5) carries the facts.

### 4.7 Runner: `apps/runner/src/aom/aom-cli.ts`

- `ceoVerb` / `ceoParams`: **no code change.** `--agent`, `--to` and `--from` already become `agent`, `to` and `from`.
  `--agent-id` / `--target-workstation-id` keep working.
- `CEO_USAGE`: add one line:
  `aom ceo act move-workstation --agent <name|id> --to <workstation> | act move-agents-off --from <workstation> --to <workstation>   (+ --reason "..." --confidence ...)`.
- Output: `ceoPrint` prints `executed: Moved 2 of 3 agent(s) from … to ….` followed by the `moved:` / `blocked:` lines.
  A refusal prints `refused: <reason>` and exits 1. `--json` prints the full result with `result.moved` and
  `result.blocked`.

### 4.8 Data model

No migration and no new event. `AgentRehomed`, `ClaimReleased` and `CeoActionTaken` are unchanged, and
`CeoActionTaken.class` stays `agent.move_workstation`. Subject kind `workstation` for the bulk action.

### 4.9 What the CEO gets back (bulk)

| Situation | Result |
| --- | --- |
| Default policy, owner turn | `recommended`, with an inline Approve / No card whose title lists who moves and who stays. Approve re-runs with `force`: prepare runs again, then execute |
| Default policy, wake | `recommended`, as a desk item |
| `decide`, some movable | `executed`: "Moved 3 of 5 agent(s) from My workstation to Laptop." plus per-agent lines |
| Nobody movable | `refused`: "no agent can move from X to Y:" plus per-agent lines (audited) |
| Source online | `refused`: "X is online: move its agents one by one with move-workstation" |
| Source unknown / other org | `refused`: "workstation X holds no agents of this organization" |
| Name matches two workstations | `refused`: "2 workstations are named X: give its id (…)" |
| Target is another member's workstation | `refused`: "… belongs to another member …" (GWP-60's text) |
| Target unknown / other org | `refused`: "workstation not found in this organization" |
| Target is the Owner's unpaired workstation | `refused`: the command's `workstation_unpaired` / `workstation_not_found` text |
| Target = source | `refused`: "pick another workstation than the one the agents are on" (the command's `same_workstation`) |
| Missing `--reason` | CLI usage error. Over RPC: "invalid request: reason …" |

## 5. Acceptance criteria → design → test

| AC | Design | Test |
| --- | --- | --- |
| 1. Single move with valid agent and target moves it; `AgentRehomed` with the CEO as actor | `move-workstation` (GWP-60) + aliases (4.1) | S1 (with `agent`/`to`), plus GWP-60's existing test |
| 2. Bulk moves every non-blocked agent of an offline/removed workstation and prints the blocked ones with why | `moveAgentsOff` → `moveAllAgents`; `bulkLines`; CLI prints the message | S5, S6; R2 |
| 3. Sandbox gate, limit, one-DevOps rule, running shift: refused with the UI's reason, nothing changes | All from `checkAgentMove` / `moveAllAgents`; label from the shared `MOVE_BLOCK_LABEL`, message from `blocked[].message` / the `HttpError` | S2 (single: sandbox, limit, DevOps, shift); S7 (bulk: each as a blocked line; all blocked = refused, nothing changed) |
| 4. Target must be one of the org owner's active workstations | `ownerTarget` (Owner's only) + the command's unpaired / not-in-org checks | S3 for both actions |
| 5. No reason → rejected | `CeoActRpc` schema; CLI `ceoReasoned` | S4; R3 |
| 6. Actions in the CEO's action list and instructions | `CEO_ACTIONS`; `CEO_CLI_HELP` used by `renderCeoInstructions` and `renderCeoChatSection`; snapshot facts | P1, P2; S8 |

## 6. Tests (all in new files, unit suites only)

**Server, `apps/server/test/ceo-move-agents.test.ts`** (copy the world setup of `ceo-move-workstation.test.ts`: CEO
shift, second Owner workstation, a member's workstation, an outsider's workstation; `setMode('agent.move_workstation',
'decide')` for the execute cases; GWP-75's `move-all-agents` server test shows how to set up a removed source):

- S1: `move-workstation` with `{agent, to}` (names) moves the agent. Exactly one `AgentRehomed` with `actor_kind =
  'agent'`, the CEO's id, and `fromWorkstationId` / `workstationId` correct. One `CeoActionTaken` `decided`. Giving
  both `agent` and `agentId` is refused as invalid parameters. An agent holding a claim (no running shift) moves and
  the claim is released with the CEO as actor.
- S2: single-move refusals, each with the command's message, `workstation_id` unchanged and no new `AgentRehomed`:
  sandbox (target runtime `sandbox: 'unavailable'`); limit (stub `ctx.ext.planLimits.assertWithin` to throw for
  `workstations`, pattern in `pack-teams.test.ts`, target with no org agents); DevOps (the DevOps engineer of an
  unpaired workstation onto a workstation that has one → contains "one DevOps engineer per workstation"; of a paired
  one → `devops_stays` text); running shift (`running` shift row → "running shift").
- S3: target not allowed, for both actions: a member's workstation, another org's, an unknown name, and the Owner's
  **unpaired** workstation → `refused`, nothing moved.
- S4: an RPC `act` without `reason`, or with `reason: 'x'` → error "invalid request", nothing moved, no
  `CeoActionTaken`.
- S5: bulk, removed source. Pair a third Owner workstation "old-box", hire 3 agents onto it, put one in a `running`
  shift, then unlink "old-box". Run `move-agents-off --from old-box --to second` → `executed`. The two free agents now
  have `workstation_id = second`, each with exactly one `AgentRehomed` as the CEO, and the busy one stays. The message
  has a `moved:` line with both names and a `blocked: <name>: In a running shift: … running shift …` line.
  `result.blocked[0].reason = 'running_shift'`. If old-box has a DevOps engineer and `second` has one too, it is listed
  with `One DevOps engineer per workstation`.
- S6: bulk, offline source (`connected = false`, status active) → works the same way. Online source → refused "is
  online", nothing moved.
- S7: bulk where every agent is blocked (target sandbox unavailable) → `refused`, the message lists each agent with
  `Sandbox: <gate message>`, nothing moved, one `CeoActionTaken` `refused`. Default policy → `recommended`, nothing
  moved, and the desk item title names the agents. Dry run → `dry_run`, nothing written.
- S8: two workstations named the same (a removed and an active "dup-box") → `--from dup-box` refused with both ids, and
  `--from <id>` works. Snapshot: the agents line shows `(removed)`, the Workstations section has the `REMOVED agents=n`
  line and the `Move targets` line with the Owner's active workstation names, and no member workstation appears there.

**Shared, `packages/shared/test/ceo-move-agents.test.ts`**:

- `MoveWorkstationParamsSchema`: `{agent, to}` → `{agentId, targetWorkstationId}`. The canonical names still work.
  Both spellings at once are refused.
- `MoveAgentsOffParamsSchema`: valid, missing `from`/`to`, empty, too long, unknown key.
- `CEO_ACTIONS` contains `move-workstation` and `move-agents-off`.
- P1: `renderCeoInstructions(brief, ceo)` contains `move-workstation --agent` and `move-agents-off --from`.
- P2: `renderCeoChatSection('x')` contains both.
- `MOVE_BLOCK_LABEL` has a label for every value of `MoveBlockReasonSchema.options`.

**Runner, `apps/runner/test/aom-ceo-move-agents.test.ts`** (the fake-RPC harness of `aom-ceo.test.ts`):

- R1: `ceo act move-workstation --agent Ada --to Laptop --reason … --confidence 0.8` sends `params: {agent: 'Ada', to:
  'Laptop'}`. `ceo act move-agents-off --from old-box --to Laptop …` sends `{from, to}`.
- R2: the fake returns `executed` with a multi-line message → the output contains the `moved:` and `blocked:` lines,
  exit 0. `refused` → `refused: …` and exit 1. `--json` prints `result.moved` / `result.blocked`.
- R3: no `--reason` → exit 1 with the usage error, and no RPC sent.

**Regression (unchanged files that must stay green):** `ceo-move-workstation.test.ts`,
`ceo-policy-move-workstation.test.ts`, `aom-ceo.test.ts`, `ceo-gateway.test.ts` (snapshot), GWP-75's server and web
move-all tests (the dialog now imports `MOVE_BLOCK_LABEL`), and GWP-74's `agent-move*` tests. If an existing test
counts `CEO_ACTIONS` or asserts the old `move-workstation` help text, update it and name it in the handoff.

Leave e2e alone. The guide and the video belong to GWP-77.

## 7. Risks

- **Name collisions** between a removed and a re-paired workstation: handled by refusing and asking for the id
  (`sourceWorkstation`). The target lookup keeps GWP-60's "active first".
- **CEO moves agents on a sleeping laptop.** It only does this for an offline source, and only as a recommendation by
  default. Untrusted wakes only recommend, even under `decide`.
- **Hourly limit.** One bulk move counts as one CEO action. That is acceptable: it is one owner-visible decision, and
  the audit result lists every agent.
- **Typecheck**: the `z.preprocess` schema type (4.1 has the fallback). Run `pnpm -r typecheck`.

## 8. Assumptions about the dependencies, checked against `main` `40b0d67d`

1. **Partly wrong, revised.** `moveAllAgents(ctx, who{userId, orgId, role}, sourceId, {targetWorkstationId,
   acknowledgeUnsandboxed?}, {dryRun?})` is exported from `commands/sharing.ts`, one transaction per agent through
   `checkAgentMove` / `rehomeAgentIn`, `dryRun` is the UI preview. But the response has one `blocked[{reason, code,
   message}]` list instead of `skipped` / `failed`, and `moved[]` carries `releasedClaims`. `bulkOutcome` and
   `bulkLines` follow it (4.4c).
2. **Holds.** `loadSourceWorkstation` accepts any status; `moveAllAgents` uses it.
3. **Holds.** `moveAllAgents` does not require an offline or removed source, so the CEO's online check stays.
4. **Wrong, revised.** The skip reasons and `SKIP_TEXT` are gone. The landed enum is `MoveBlockReason`, worded in the
   dialog by `REASON_LABEL` plus the single move's message. 4.3 moves `REASON_LABEL` to shared as `MOVE_BLOCK_LABEL`;
   no `moveSkipText`.
5. **Holds.** Claim release (`rehomeAgentIn`), `devops_stays` / `one_devops_per_workstation` and the built-in limit
   exemption (`checkAgentMove`) live in the command, plus the bulk empty-source exemption in `moveAllAgents`.
6. **Holds.** `rehomeAgent(ctx, user, agentId, req)` is unchanged; the Owner (`isOrgManager`) may move any agent; the
   CEO is refused by `checkAgentMove` (`builtin_agent`). `moveWorkstation.prepare` already passes
   `releaseHeldClaims: true`.
7. **Holds.** Held claims without a running shift are released and BA tasks requeued, so the new prompt wording
   ("its claimed cards go back to the queue") is right and the current "or on a card" wording is stale.
