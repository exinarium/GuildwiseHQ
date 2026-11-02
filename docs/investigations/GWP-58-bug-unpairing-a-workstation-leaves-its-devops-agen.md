# GWP-58: unpairing a workstation leaves its DevOps agents behind

## Question

When a workstation is unpaired, the built-in DevOps engineers bound to it (one per organization of the workstation's
user) stay `status='active'` on a workstation that no longer exists. Nobody can fire them (`fireAgent` refuses
`is_devops`), so they stay on the board ("Atlas" and "Forge" on "My workstation (offline)", 2026-11-02) until someone
fixes the database by hand. What has to change so that unpairing retires them with their history kept, flags the other
agents on that workstation, keeps the runner from using them again, and cleans up the agents that are already orphaned?

## Findings

Note: the shell sandbox failed for every command in this design session (`apply-seccomp ... Permission denied`), so
nothing could be grepped. Every file below was read by path. The places marked **verify** have to be confirmed with a
search before building.

### 1. One place does every unpair: `unlinkWorkstationIn`

`apps/server/src/commands/workstations.ts`

- `unlinkWorkstation` (owner or admin) → `unlinkWorkstationIn(ctx, tx, actorUserId, id, wsOwnerId, by)`.
- Routes: `POST /api/workstations/:id/unlink` (owner, web app) and `POST /api/admin/workstations/:id/unlink` (platform
  admin, admin board) in `apps/server/src/routes/workstations.ts`. Both call `unlinkWorkstation`.
- The function's own comment says it is "also used when an administrator deactivates a user". **Verify** with a grep
  for `unlinkWorkstationIn(` that no other caller exists.
- The CEO has no "remove a workstation" action. `ACTION_CLASSES` in `packages/shared/src/ceo/policy.ts` has
  `agent.retire` but nothing for workstations. In AC 2, "the CEO/board retire action used on a workstation" therefore
  means the admin board's unlink (same function). The CEO's `agent.retire` is the generic retire path that has to keep
  refusing DevOps engineers.

`unlinkWorkstationIn` builds one `events` array and calls `ctx.store.append(events, { tx })` once, inside the caller's
`withAppendTx`. Today the array holds:

1. `WorkstationUnlinked`
2. `ClaimReleased` (reason `workstation_unlinked`) plus a card message for every card with `claim_workstation_id = ws`
3. `ShiftEnded{outcome:'lost'}` for every shift on the workstation with `status <> 'ended'`
4. `DevOpsRequestCompleted{status:'failed'}` plus a thread message (and the desk item resolved) for every DevOps request
   on the workstation that is `queued`, `running` or `needs_approval`
5. `computerRemovedEvents` (deploy places on this computer)

After the append it fails pending/sent `runner_commands` and deletes token rotations. Nothing touches `agents`. That is
the bug.

Because it is one append in one transaction, putting the `AgentRetired` events in the same `events` array gives
requirement 2 (atomic) for free: if anything throws, the whole unpair rolls back.

**Existing bug found on the way:** step 4 selects `id, thread_id, approval` from `devops_requests` but builds
`orgScope(r.org_id)`. `org_id` is never selected, so the scope is `undefined`. Unpairing a workstation that has a
queued DevOps request either fails or writes events with no organization. This is exactly the "queued work of a DevOps
agent at unpair time" in AC 6, so it is fixed here: add `org_id` to that SELECT.

### 2. How agents retire today

- Event: `AgentRetired { agentId, by: Id, releasedCardIds: Id[] }` (`packages/shared/src/events/agent.ts`). Projector
  (`apps/server/src/projections/agents.ts`): `status='retired', retired_at=createdAt`. It is a soft retire. The row,
  shifts, card comments, handoffs and the event stream all stay. Names of retired agents are never reused
  (`devopsName`, `suggestNames`).
- `fireAgent` (`commands/agents.ts`) is the generic retire path. It refuses `is_devops` (`devops_cannot_be_fired`) and
  the CEO, releases the agent's claims (`ClaimReleased` reason `agent_retired`, with `lastHandoffId`), appends
  `AgentRetired` and queues `agent.wipe` on the workstation. This is the "rule for releasing work of a retired agent"
  that requirement 4 says to reuse.
- Retired agents already drop out of everything that matters. `devopsAgentOn`, `alignDevopsRuntime`,
  `devopsHireEvent`, the hire limit check and `hireDevopsForOrgIn` all filter `status='active'`, and `listAgents`
  sorts retired agents last. **Verify** by grepping `is_devops` and `status = 'active'` in `apps/server/src`
  (dispatcher candidates, vault sync identity, hygiene automations) that no query picks a DevOps agent without the
  active filter.

### 3. Pairing and re-pairing

`pairRunner` always creates a new `workstationId` (`randomUUID()`) and hires DevOps engineers through
`devopsHireEvents`. `devopsHireEvent` only skips an org that already has an active DevOps agent on that same
workstation id. Re-pairing the same machine therefore gets fresh agents with new names (Atlas is taken, so the next one
is Anvil), and the retired ones are never touched. Requirement 8 and AC 11 hold already; they only need a test.

### 4. "Offline" and "removed" are different columns

`workstations.status` is `'active' | 'unlinked'` (`projections/workstations.ts`). Offline means `connected=false` with
`status='active'`. The migration selects on `status <> 'active'` (or a missing workstation row) and never on
`connected`.

### 5. Data-migration precedent

`data-migrations/deploy-removed-computers.ts` shows the pattern: check the `data_migrations` row, take an advisory lock,
check again, build the events with the same function the live path uses, append, log, and insert the
`data_migrations` row. `reporter-retired.ts` shows one `withAppendTx` per unit of work. The new migration is
registered last in `DATA_MIGRATIONS` (`data-migrations/index.ts`), after `deploy-removed-computers-2026-11`.

### 6. Runner side

- `RunnerClient.onClose` turns close code 4403 with `UNPAIRED_CLOSE_REASON` into `fatal` with `UNPAIRED_MESSAGE`.
- `RunnerHost.onEnded` (`apps/runner/src/host.ts`) stops that pairing's `Runner` (its supervisor ends the running
  shifts) and calls `setDisabled(root, id, 'unpaired')`. `sync()` never starts a disabled pairing, and the revoked token
  cannot connect anyway. So "no further shifts" and "no re-register" already hold for the unpaired workstation.
- What is left behind in the pairing directory: `agents/<agentId>/` (the agent's private home and sandbox),
  `active-shifts/` (persisted `shift.start` messages that a restart resumes) and `outbox/` (acked frames that are resent
  on the next `welcome`).
- Re-pair (`addPairing`, same server and label) reuses the same pairing directory, keeps its data and writes the new
  `workstationId` and token. The host sees the new signature and restarts the pairing. On the first `welcome` with the
  new token, the old outbox is resent. That outbox can hold `shift.*` reports of the old workstation's DevOps shifts, so
  the old agents' work is reported again to the new workstation. This is the real "re-register on reconnect" gap.
  `active-shifts` can likewise resume an old DevOps shift under the new pairing.
- The server cannot send `agent.wipe` after unpairing: `unlinkWorkstationIn` fails every pending runner command and the
  socket closes with 4403. The local cleanup therefore has to happen on the runner.

### 7. Board and agent list

`listAgents` (`apps/server/src/queries/agents.ts`) already `LEFT JOIN workstations ws`. `toAgentDto` has no field for
"the workstation is gone". The flag can be derived in the query from `ws.status`, so it needs no new event and stays
replay-safe.

## Options

| | A. Retire inside `unlinkWorkstationIn` (same append) | B. Event subscriber on `WorkstationUnlinked` | C. Let `fireAgent` take DevOps agents when the workstation is gone |
|---|---|---|---|
| Atomic (req 2) | Yes: one append in one tx | No: a second transaction after the commit | Only if each caller wraps both calls in one tx |
| Every unpair path | Yes: the one function every path calls | Yes | No: every path has to call it |
| GWP-27 rule kept | Yes: `fireAgent` is not touched | Yes | Weakened: the generic path learns an exception |
| Migration reuse | Same event builder | Separate code | Same function, but it needs a user session |

**Recommendation: A.** One event builder, used by `unlinkWorkstationIn` and by the migration. `fireAgent` (and the
CEO's `agent.retire`) keep refusing DevOps engineers exactly as the GWP-27 decision (ledger d7096210) requires. GWP-58
overrides that decision only for a workstation that is unpaired or already gone, which is the reading the planner
proposed.

## Design

### Shared (`packages/shared`)

1. `events/agent.ts`, `AgentRetired`: add two optional fields (old events stay valid and the projector is unchanged):
   ```ts
   defineEvent('AgentRetired', z.object({
     agentId: Id, by: Id, releasedCardIds: z.array(Id),
     /** Why: absent = fired by a manager. */
     reason: z.enum(['fired', 'workstation_unpaired', 'orphaned_migration']).optional(),
     /** The workstation that was removed, for a retirement caused by it. */
     workstationId: Id.optional(),
   })),
   ```
   The event is the audit record (req 3). Its envelope `actor` is the person who unpaired, the payload names the agent,
   the workstation and the reason, and `by` is the same user id. UI label for `orphaned_migration`: "orphaned –
   migration". **Verify** whether an admin audit table or view exists (grep `audit` in `apps/server/src`). If one does,
   also show these events there. If not, the agent's event stream (`streamId.agent(id)`) is the audit trail.
2. `api` agent DTO (`AgentDto`): add `workstationRemoved?: boolean`. It is true for an active agent whose
   `workstation_id` is set and whose workstation is not `status='active'`.
3. Add a constant such as `AGENT_RETIRED_REASON_LABEL` for the web.

### Server

**New: `apps/server/src/commands/devops-retire.ts`**

```ts
/** AgentRetired for every active DevOps engineer of the workstation(s), plus release of the work they still hold.
 *  `skip` holds the card/shift/request ids the caller already released in the same batch (no duplicates). */
export async function devopsRetireEvents(db: Queryable, opts: {
  agents: Row[];                         // rows of agents: id, org_id, name, workstation_id
  reason: 'workstation_unpaired' | 'orphaned_migration';
  actor: Actor;                          // userActor(unlinker) or SYSTEM_ACTOR
  by: string;                            // unlinker's user id; in the migration the workstation's user_id
  skip?: { cardIds: Set<string>; shiftIds: Set<string>; requestIds: Set<string> };
}): Promise<AppendInput[]>
```

For each agent, in this order:

- Cards with `claimed_by_agent_id = agent AND claim_id IS NOT NULL` that are not in `skip.cardIds`:
  `ClaimReleased{reason:'agent_retired', lastHandoffId}` plus the card message, the same shape as `fireAgent`. Move the
  card-release loop out of `fireAgent` into a shared helper (`releaseClaimsOfAgentEvents(tx, agent, actor, text)`) so
  both use it (req 4, reuse).
- Shifts with `agent_id = agent AND status <> 'ended'` that are not in `skip.shiftIds`: `ShiftEnded{outcome:'lost'}`,
  the same payload as `unlinkWorkstationIn`.
- `devops_requests` with `devops_agent_id = agent AND status IN ('queued','running','needs_approval')` that are not in
  `skip.requestIds`: fail them as `unlinkWorkstationIn` does. Move that loop into a helper
  (`failDevopsRequestEvents(tx, requests, why)`) and select `org_id`.
- `AgentRetired{agentId, by, releasedCardIds, reason, workstationId}` with `actor` and `orgScope(agent.org_id)`.

The selection of the agents is the caller's job, so the GWP-27 rule lives in one visible place: only callers that know
the workstation is gone use this builder.

**Change: `unlinkWorkstationIn`**

- Collect the ids already released: `claimed[].id` → `cardIds`, `open[].id` → `shiftIds`, `requests[].id` →
  `requestIds`.
- Fix the `devops_requests` SELECT (add `org_id`).
- Before `ctx.store.append`, add:
  ```ts
  const devops = await rows(tx, `SELECT id, org_id, name, workstation_id FROM agents
      WHERE workstation_id=$1 AND is_devops AND status='active' ORDER BY hired_at, id FOR UPDATE`, [id]);
  events.push(...await devopsRetireEvents(tx, { agents: devops, reason: 'workstation_unpaired',
      actor: userActor(actorUserId), by: actorUserId, skip }));
  ```
  The events go into the same array and the same single append, so the retirement is atomic with the unpair (req 2).
- Do not queue `agent.wipe` (the runner commands of this workstation are failed a few lines later and the token is
  revoked). The runner cleans up locally (see below).
- Non-DevOps agents are not touched (req 5). The CEO is not DevOps and is not retired either.
- After the commit, `unlinkWorkstation` calls `ctx.services.dispatcher.trigger()`: released cards may go to other
  workstations. **Verify** whether the route already triggers it.

**Unchanged: `fireAgent`, `resetAgent`, `setAgentPaused`** keep refusing DevOps engineers. **Verify** that the CEO's
`agent.retire` action handler (grep `'agent.retire'` in `apps/server/src/ceo`) refuses `is_devops`/`is_builtin`
agents (through `fireAgent` or its own check), and add a test.

**Agent list flag: `queries/agents.ts`**

- `listAgents`: add `ws.status AS workstation_status` to the SELECT.
- `toAgentDto`: `workstationRemoved: a.status === 'active' && !!a.workstation_id && a.workstation_status !== 'active'`.
  **Verify** the other callers of `toAgentDto` (agent detail, HR board, CEO tools) and add the column where they build
  the row. Without it the flag is false, which is safe.
- It is derived from projections only, so it needs no event and no migration, and a later re-home (GWP-57,
  `AgentRehomed`) clears it automatically.

**New data migration: `apps/server/src/data-migrations/orphaned-devops.ts`**

- `ORPHANED_DEVOPS_MIGRATION = 'orphaned-devops-2026-11'`, its own `LOCK_ID` (7353 if it is still free: **verify** that
  no other migration uses that number).
- The same frame as `deploy-removed-computers.ts`: the `data_migrations` check, the advisory lock and the check again.
- Selection:
  ```sql
  SELECT a.id, a.org_id, a.name, a.workstation_id, w.user_id AS ws_user_id
    FROM agents a LEFT JOIN workstations w ON w.id = a.workstation_id
   WHERE a.is_devops AND a.status = 'active' AND a.workstation_id IS NOT NULL
     AND (w.id IS NULL OR w.status <> 'active')
   ORDER BY a.workstation_id, a.hired_at, a.id
  ```
  It never looks at `connected`, so a paired but offline workstation is never touched (AC 10).
- Per workstation, one `withAppendTx`: `devopsRetireEvents(tx, { agents, reason: 'orphaned_migration', actor:
  SYSTEM_ACTOR, by: ws_user_id ?? <the org owner's user id> })`, then append.
- Report `{ retired, cardsReleased, shiftsEnded, requestsFailed }`, log it and insert the `data_migrations` row.
- Idempotent twice over: the run is recorded once, and even if the row is deleted, a second run finds no active
  orphans and appends nothing (AC 9).
- Register it last in `DATA_MIGRATIONS` and export it from `index.ts` like the others.
- Per the standing order, the database fix is this migration, not a script. The card should note that the
  2026-11-02 Atlas/Forge rows were already removed by hand, so the migration may find nothing on that database.

### Runner (`apps/runner`)

1. Mark DevOps agent directories. When the runner prepares the agent directory for a DevOps shift (**verify** where
   `paths.agentDir(` is used for the shift, and which brief field says it is a DevOps shift: `kind:'devops'` or
   `isDevops`), write an empty marker file `agents/<agentId>/.devops`.
2. Clean up on unpair. In `RunnerHost.onEnded`, when `runner.unpaired` is true, after `setDisabled(..., 'unpaired')`,
   call a new `clearUnpairedState(dir)` (a new file such as `apps/runner/src/unpaired.ts`):
   - remove `active-shifts/` entries (no resume of an old shift),
   - remove `outbox/` entries (nothing of the old workstation is resent),
   - remove `agents/<id>/` for every directory with the `.devops` marker. Use the same wipe code as the
     `agent.wipe` command handler (**verify**: grep `'agent.wipe'` in `apps/runner/src`) so the sandbox is cleaned the
     same way.
   - Leave non-DevOps agent directories alone. Those agents are still active on the server and GWP-57 may re-home them
     onto this machine's new pairing.
3. Clean up on re-pair. In `addPairing`, when `existing` is found and `existing.workstationId !== input.workstationId`,
   run the same `clearUnpairedState(entryDir(root, existing))` before writing the new config. This also covers a runner
   that was not running at the moment of the unpair, which never saw the 4403.
4. Bump `RUNNER_VERSION` (`apps/runner/src/version.ts`).

### Web (`apps/web`)

- Agents/HR list and agent detail: for `agent.workstationRemoved`, show a visible badge or line "Workstation removed –
  needs a new workstation" next to the workstation name. It must be plain text in the card or row, not a hover-only
  tooltip, so it works on touch screens and narrow phones (standing order "design: all devices"). It needs no input
  field. Do not add a move button (that is GWP-57).
- The retired DevOps agents show under the retired agents as today. Where a retirement reason is shown (agent
  history), use the labels "workstation unpaired" and "orphaned – migration".

### Docs

- `docs/ARCHITECTURE.md` section 16.2 (DevOps engineer per workstation): one paragraph saying that unpairing retires the
  workstation's DevOps engineers in the same append (reason `workstation_unpaired`), that other agents are flagged, and
  that `fireAgent` still refuses DevOps engineers.
- `CHANGELOG.md`: a "Fixed" entry.

## Risks

- **Duplicate releases in one batch.** The workstation-level loops and the agent-level loops could release the same
  card, shift or request twice. The `skip` sets prevent that. Test it with a DevOps agent that holds a running request
  at unpair time.
- **Other readers of `AgentRetired`.** **Verify** (grep `'AgentRetired'`) for subscribers (CEO signals, HR,
  notifications) that assume `by` is a manager who fired the agent. They must treat a present `reason` other than
  `fired` as "retired with its workstation".
- **The deactivate-user path** runs `unlinkWorkstationIn` for each workstation. With several workstations, the DevOps
  agents of each are retired. That is intended.
- **The CEO bound to the workstation** is not retired (not DevOps). The flag shows on it. **Verify** whether
  `ceo/provision.ts` already re-binds the CEO on unpair. If it does, the flag clears itself.
- **Runner wipe safety:** only remove directories under `agents/` that hold the marker. Never follow symlinks
  (`rmSync(recursive)` on the resolved path, after checking it is inside `paths.agents`).

## Acceptance criteria → design → test

| AC | Design | Test (to write) |
|---|---|---|
| 1. Owner unpairs; two DevOps agents retired, not active on the board | `unlinkWorkstationIn` + `devopsRetireEvents` | server: user in two orgs (two DevOps agents), `POST /api/workstations/:id/unlink`, both `status='retired'`, `listAgents` returns no active DevOps agent for the workstation |
| 2. Admin board / "CEO-board" path the same way | same function behind `/api/admin/workstations/:id/unlink` and user deactivation | server: the same assertions through the admin route and through deactivating the user |
| 3. History still viewable | soft retire only (projector unchanged) | server: after unpair, the agent row, its ended shifts, card messages and `events` of `streamId.agent(id)` still exist |
| 4. Audit event per agent | `AgentRetired{reason, workstationId, by}` with `actor` = the unpairing user | server: one `AgentRetired` per agent with `reason:'workstation_unpaired'`, `workstationId`, `by` and the actor id of the unlinker |
| 5. Atomic | the same events array, one append in one tx | server: `vi.spyOn(ctx.store, 'append')` throws for a batch that holds `AgentRetired`; the unlink fails, the workstation is still `active`, the agents are still `active` and no events were added |
| 6. Running or queued work released | the existing workstation loops + agent loops with `skip`; `org_id` fix | server: a DevOps agent with a running shift, a queued and a `needs_approval` request, and a claimed card; after unpair the shift is `ended`, the requests are `failed`, no card has `claimed_by_agent_id` = retired agent, and nothing was released twice |
| 7. Non-DevOps agent flagged, not retired | derived `workstationRemoved` in `listAgents`/`toAgentDto`; web badge | server: a builder on the workstation stays `active` with `workstationRemoved:true`; web: the badge renders (component test) |
| 8. Runner: no shifts and no re-register | existing disable/stop + `clearUnpairedState` on unpair and re-pair | runner: close with 4403 unpaired leaves the pairing `disabled`, empties `active-shifts`/`outbox`, removes marked DevOps dirs and keeps the others; `addPairing` with a new workstation id clears the same; the first `welcome` after re-pair sends no old frames |
| 9. Migration retires orphans, second run no change | `orphaned-devops-2026-11` | server: seed active DevOps agents on an `unlinked` workstation; run: retired with `reason:'orphaned_migration'`; run again (and again after deleting the `data_migrations` row): no new events |
| 10. Migration ignores paired but offline | selection on `status`, not `connected` | server: a DevOps agent on `status='active', connected=false` stays active |
| 11. Re-pair: new DevOps agents, old stay retired | already true (`pairRunner` creates a new workstation id) | server: unpair, then pair again with the same name: new active DevOps agents with new names, old ones still `retired` |
| GWP-27 rule | `fireAgent` unchanged | server: `fireAgent` on a DevOps agent of a paired workstation is still 409 `devops_cannot_be_fired`; the CEO `agent.retire` on it is refused |

Tests: server vitest (own database `aom_test_gwp58`), with new tests in `test/workstation-unpair-devops.test.ts` and
`test/data-migration-orphaned-devops.test.ts`; runner vitest (`test/unpaired-state.test.ts`, plus extending the host and
pairings tests); web vitest for the badge. The e2e item in the test plan (pair, unpair in the UI, check the board) is
for the testers.
