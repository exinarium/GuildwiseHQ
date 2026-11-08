# GWP-110: accepting an organization invitation fails (500) for a user with two or more paired workstations

## 1. Question

`POST /api/invitations/:token/accept-existing` returns 500 (`agents_name_per_org` unique violation,
`(org_id, lower(name)) = (<org B>, atlas)`) when the invited existing user has two or more active workstations.
What is the cause, which DevOps model applies (one per workstation or one per organization), how are names made
unique without a race, and what happens when a hire still fails during the accept?

## 2. Findings

### 2.1 Root cause (confirmed in code)

`apps/server/src/commands/devops.ts`:

- `devopsName(db, orgId)` (line 69) reads `SELECT lower(name) FROM agents WHERE org_id=$1` and returns the first
  name from `DEVOPS_NAMES` (`Atlas`, `Forge`, `Anvil`, ...) that is not used, with numbered variants (`Atlas 2`)
  once the list runs out.
- `devopsHireEvent(tx, userId, orgId, workstationId)` (line 90) builds one `AgentHired{isDevops:true}` event and
  calls `devopsName` for its name. It does **not** append.
- `hireDevopsForOrgIn(ctx, tx, userId, orgId)` (line 161) loops over the user's active workstations that serve the
  org, collects one event per workstation, and appends them all in **one** `ctx.store.append(events, { tx })` after
  the loop.

Because nothing is appended inside the loop, the `agents` table does not change between iterations, so every call to
`devopsName` sees the same set of used names and returns the same name (`Atlas` in an empty org). The projector for
`AgentHired` runs inside `append` (`pg-event-store.ts:113`), so the second insert of the batch hits
`agents_name_per_org` and the whole transaction rolls back. The route has no mapping for a raw pg error, so the client
gets `500 internal_error`.

With one workstation there is only one event, so the bug never shows. With 0 workstations nothing is hired.

### 2.2 Who calls what

| Caller | Transaction | Batch shape | Exposed? |
| --- | --- | --- | --- |
| `acceptInvitationExisting` (`invitations.ts:540`) -> `hireDevopsForOrgIn` | `withAppendTx`, same tx as the accept | one org, N workstations | **Yes** (the reported 500) |
| `registerDevopsMembershipHook` (`devops.ts:910`, registered in `app.ts`) -> `hireDevopsForOrgIn` | own `withAppendTx`, after the `OrgMemberAdded` commit | one org, N workstations | **Yes**, but the error is caught and only logged (`devops membership hook failed`), so the member silently gets **no** DevOps engineer in that org |
| `pairRunner` (`workstations.ts:110`) -> `devopsHireEvents` -> `devopsHireEvent` | `withAppendTx` | one workstation, N **different** orgs | No: each event is for a different org, so names never collide inside the batch |

`acceptInvitation` (new account) does not hire DevOps engineers: a new account has no workstations.

### 2.3 Concurrency

`withAppendTx` takes the global append lock `pg_advisory_xact_lock(7311)` as its **first** statement, and
`PgEventStore.append` takes it again (re-entrant) before every insert. All three callers above run inside
`withAppendTx`. So:

- No two transactions that append events can interleave: the second waits for the first to commit or roll back.
- Under READ COMMITTED each statement takes a new snapshot, so the name query that runs after the lock is taken
  sees every agent committed by the previous lock holder.

The only gap is **inside one transaction**: names chosen for earlier events of the same batch are not yet in the
table. That is exactly the bug. A batch-local set of names already taken closes it, and the global lock covers the
cross-transaction case. There is no check-then-insert race once both are in place.

### 2.4 Existing data

- Duplicate names cannot exist: `agents_name_per_org` has been in place since `0006_agents.sql` and every failed
  batch rolled back whole.
- Partial states (a membership with only some of the agents) cannot exist either: both exposed paths roll back the
  whole hire batch.
- A **gap** can exist: a member added through a non-accept path (CLI, migration, the test helper `addOrgMember`)
  while they had 2+ workstations has **no** DevOps engineer in that org, because the hook failed and only logged.
  This is not duplicate-prone state, so the card's "no migration" constraint holds. A one-off repair of that gap
  is out of scope; it has been suggested on the backlog instead (see section 7).

### 2.5 Docs and owner decisions

`docs/ARCHITECTURE.md` section 16.2 and the doc comment on `devopsHireEvent` state "one DevOps engineer per
organization and workstation" (owner decisions 15 and 15a). The DB enforces it with
`agents_one_devops ON agents (org_id, workstation_id) WHERE is_devops AND status='active'`. DevOps shifts are
dispatched to the DevOps agent **of the workstation** the request targets (environment setup, hygiene, vault sync
identity), so each workstation needs its own engineer in every org it serves.

## 3. Options

### 3.1 Model (requirement 3)

| | (a) One DevOps engineer per workstation per org (current) | (b) One DevOps engineer per org |
| --- | --- | --- |
| Matches docs/owner decisions | Yes (16.2, decisions 15/15a) | No, changes a documented owner decision |
| Schema | `agents_one_devops` already keyed on (org, workstation) | Needs a new index or a change in meaning |
| Runtime | Dispatcher, vault sync, hygiene, setup all target a workstation's engineer | A member's second workstation in org B would have no engineer: DevOps requests for it could not run |
| Change size | Unique names only | Rework of dispatch and several queries |

### 3.2 Unique names

| Option | Verdict |
| --- | --- |
| A. Batch-local `taken` set passed through `devopsHireEvent` into `devopsName`, under the global append lock | **Chosen.** Smallest change, names chosen before append in the same tx (card constraint), race-safe by 2.3 |
| B. Append each hire inside the loop (one `append` per workstation) | Works, but splits one logical hire into several batches (several notifies, interceptors run per batch) and leaves the naming bug in place for any future batch caller |
| C. Catch 23505 and retry with the next name | Rejected by the card ("do not rely on catching the constraint error"); a failed statement also aborts the pg transaction |
| D. Suffix with the workstation name (`Atlas (Laptop)`) | Changes the naming scheme, may still collide, and the card forbids changing home-org naming |

### 3.3 Failure during the accept (requirement 4)

| Option | Verdict |
| --- | --- |
| R. Full rollback, typed error (`409 devops_hire_failed`), invitation stays pending | **Chosen.** `acceptInvitationExisting` is already one transaction, so this needs only an error mapping. No half state is possible |
| J. Join, hire under a SAVEPOINT, report the failure and let the hook retry | More moving parts (savepoint around `append`, a new desk item to "report" the failure, since the hook only logs). After the fix the deterministic cause is gone, so the remaining failures are rare and a retry by the user is cheap |

## 4. Recommendation (decisions recorded for the card)

1. **Model (a): one DevOps engineer per workstation that serves the org**, on every path that calls
   `hireDevopsForOrgIn` (accept-existing and the membership hook) and on pairing. After U joins org B, U brings
   exactly as many active DevOps agents into B as U has active workstations that serve B (`wsServesOrgSql`).
   No doc change to the model.
2. **Names**: first unused name from the existing `DEVOPS_NAMES` list, case-insensitive, counting every agent in
   the org (active and retired, DevOps or not) **plus** the names already picked earlier in the same batch. In an org
   whose owner already has `Atlas`, U's two workstations get `Forge` and `Anvil`. Home-org naming is unchanged.
3. **Failure on accept: full rollback with a typed error.** Any non-`HttpError` thrown by the hire inside
   `acceptInvitationExisting` is logged and re-thrown as `HttpError(409, 'devops_hire_failed', ...)`. The
   transaction rolls back, so the invitation stays `pending`, no membership row exists, and no agent exists. An
   `HttpError` from inside (for example the org-status interceptor's read-only refusal) is re-thrown as it is.
4. **Membership hook**: keeps its idempotent "log and carry on" behaviour (it runs after the membership has
   committed, so there is nothing to roll back to). With the fix, the multi-workstation case no longer fails. Add
   `orgId`/`userId` to the warning so a failure can be found in the log.

## 5. Design

### 5.1 `apps/server/src/commands/devops.ts`

```ts
import { APPEND_LOCK_ID, type Tx, withAppendTx } from '../db/tx.ts';

/**
 * First unused DevOps name in the org (retired agents keep their names; numbered variants when the list runs out).
 * `taken` holds the lower-cased names already chosen earlier in the same append batch (not yet in `agents`); the
 * chosen name is added to it. Runs under the global append lock, so no other transaction can insert an agent
 * between this read and the append.
 */
async function devopsName(tx: Tx, orgId: string, taken: Set<string> = new Set()): Promise<string> {
  // Re-entrant: callers in withAppendTx already hold it; this keeps a future plain-withTx caller race-free.
  await tx.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_ID]);
  const used = new Set(
    (await rows<{ n: string }>(tx, 'SELECT lower(name) AS n FROM agents WHERE org_id=$1', [orgId])).map((r) => r.n),
  );
  for (const n of taken) used.add(n);
  for (let round = 1; ; round++) {
    for (const base of DEVOPS_NAMES) {
      const name = round === 1 ? base : `${base} ${round}`;
      if (!used.has(name.toLowerCase())) {
        taken.add(name.toLowerCase());
        return name;
      }
    }
  }
}

export async function devopsHireEvent(
  tx: Tx,
  userId: string,
  orgId: string,
  workstationId: string,
  /** Names already chosen in this batch for `orgId` (pass the same set for every hire into one org). */
  taken?: Set<string>,
): Promise<AppendInput | null> {
  // ... unchanged, except:
  //   name: await devopsName(tx, orgId, taken),
}

export async function hireDevopsForOrgIn(ctx: Ctx, tx: Tx, userId: string, orgId: string): Promise<void> {
  const stations = /* unchanged query */;
  const taken = new Set<string>();
  const events: AppendInput[] = [];
  for (const w of stations) {
    const ev = await devopsHireEvent(tx, userId, orgId, w.id, taken);
    if (ev) events.push(ev);
  }
  if (events.length) await ctx.store.append(events, { tx });
}
```

- Compute the name only after the "already has an active engineer" and "role missing" early returns (as today), so
  a skipped workstation does not reserve a name.
- `devopsHireEvents` (pairing) stays as it is: one event per **different** org, no `taken` set needed, names and
  order identical to today (requirement 5). It does pick up the extra re-entrant lock call, which is harmless.
- `devopsName`'s parameter type narrows from `Queryable` to `Tx` (it only has `tx` callers; check with
  `grep devopsName`).
- `registerDevopsMembershipHook`: change only the log line to
  `ctx.log.warn({ err, orgId: p.orgId, userId: p.userId }, 'devops membership hook failed')` (move `p` outside the
  try or read it from `e`).

### 5.2 `apps/server/src/commands/invitations.ts` (`acceptInvitationExisting`)

```ts
import { HttpError } from '../errors.ts';

    // Their workstations get this organization's DevOps engineer. A failure here rolls the whole accept back
    // (the invitation stays pending, no membership), with a typed error instead of a 500.
    try {
      await hireDevopsForOrgIn(ctx, tx, session.user.id, orgId);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      ctx.log.error({ err, orgId, userId: session.user.id }, 'devops hire failed during invitation accept');
      throw new HttpError(
        409,
        'devops_hire_failed',
        'could not add the DevOps engineers for your workstations to this organization; nothing was changed and the invitation is still open, try again',
      );
    }
```

The throw leaves the `withAppendTx` callback, so `withTx` runs `ROLLBACK` (the pg transaction is already aborted
after a failed statement; rolling back is the only valid next step). `notifySignup` is after the transaction and is
not reached.

### 5.3 Routes, web, shared

- `apps/server/src/routes/invitations.ts`: no change. The global error handler already turns an `HttpError` into
  `{ error: { code, message } }` with its status (existing tests assert `body.error.code` for 409s on this route).
- `apps/web` (`AcceptInvite.tsx` uses `ErrorBox` with the server message): no change.
- `packages/shared`: no change.
- `docs/ARCHITECTURE.md` section 16.2: add one sentence after the first bullet: "Names are the first unused entry of
  the DevOps name list in that organization (case-insensitive, including names chosen earlier in the same append),
  so a member joining with several workstations gets one distinctly named engineer per workstation." Optional but
  recommended.

### 5.4 Data model

No migration, no schema change. `agents_name_per_org` and `agents_one_devops` stay as they are.

## 6. Risks

- **Re-entrant lock in `devopsName`**: `pg_advisory_xact_lock` is re-entrant within a session; holding it twice is
  released at commit like once. No deadlock risk because every path already takes the same lock first.
- **Name reserved for a skipped hire**: avoided by computing the name after the early returns.
- **Interceptors** (`routing`, `org-status`, `cost-stamp`) run on the hire batch; the org-status interceptor can
  throw an `HttpError` for a suspended org. That one is re-thrown unchanged (still typed, still a rollback).
- **Catching too much**: the try/catch wraps only the `hireDevopsForOrgIn` call, so other errors in the accept keep
  their current behaviour.
- **Simulation orgs**: `wsServesOrgSql` is unchanged, so a real workstation still never gets an engineer in a
  simulation org and a simulated one only in its own.

## 7. Out of scope (recorded)

- One-off repair for members who were added through the hook while they had 2+ workstations and so have no DevOps
  engineer in that org (section 2.4). Suggested on the backlog; not written here, per the card's migration rule.
- The GWP-62 E2E sharing scenario (a user with 2+ workstations accepts in the web UI) is enabled by this fix; it
  lives under `e2e/**`, which the tester owns.

## 8. Acceptance criteria mapping and tests

All server tests live in `apps/server/test/` and need the test Postgres (integration tests: the builder runs them if
the shift can reach the DB, otherwise names them for the testers). Suggested file: extend
`apps/server/test/org-members.test.ts` (it already has `describe('the DevOps engineer per organization and
workstation')` and the `pairWorkstation` helper), or a new `devops-multi-workstation.test.ts`.

Shared assertions helper for the tests:

```ts
const devopsOf = (orgId: string, wsIds: string[]) =>
  q(`SELECT name FROM agents WHERE org_id=$1 AND is_devops AND status='active' AND workstation_id = ANY($2::uuid[])`,
    [orgId, wsIds]);
const namesUnique = async (orgId: string) =>
  (await q(`SELECT lower(name) n, count(*)::int c FROM agents WHERE org_id=$1 GROUP BY 1 HAVING count(*) > 1`, [orgId]))
    .length === 0;
```

| # | Acceptance criterion | Design element | Test |
| --- | --- | --- | --- |
| 1 | 2 workstations, accept-existing succeeds, U is a member of B | 5.1 `taken` set | U pairs 2 workstations, owner of B invites, accept-existing -> 201, `body.orgs` contains B, `org_members` row active |
| 2 | Same with 3 workstations | 5.1 | Same with 3 (parametrise 2 and 3 with `it.each`) |
| 3 | No two agents in B share a name (case-insensitive) | 5.1 | `namesUnique(B)` in tests 1, 2, 4, 7 |
| 4 | B already has `Atlas` (another member's workstation); U still joins with different names | 5.1 (DB names + `taken`) | Owner of B pairs a workstation first (B has `Atlas`); U with 1 and with 2 workstations joins; U's names exclude `atlas`, e.g. `['Forge','Anvil']`, `namesUnique(B)` |
| 5 | U's DevOps count in B matches the model | Decision 1, model (a) | `devopsOf(B, U's ws ids).length === number of U's active workstations` in tests 1, 2, 4 |
| 6 | 0 and 1 workstations still accept as before | unchanged path | U with 0 -> 201, no DevOps agent for U in B; U with 1 -> 201, one engineer (existing test at `org-members.test.ts:359` covers the 1 case; add the 0 case) |
| 7 | Hook path with 2+ workstations does not violate the constraint | 5.1 (hook shares `hireDevopsForOrgIn`) | U with 2 workstations; `t.addOrgMember(B, U.id)` (it flushes the notifier, so the hook has run); expect 2 active engineers for U in B and `namesUnique(B)`. Assert the agents exist, because the hook swallows errors |
| 8 | Hire failure during accept never gives an untyped 500 with the invitation consumed | 5.2 full rollback | Register an interceptor on `t.app.ctx.store.intercept` that throws `new Error('boom')` when a batch has an `AgentHired` with `isDevops` and `orgId === B` and a closure flag is on. Accept-existing -> 409, `error.code === 'devops_hire_failed'`; `invitations.status` still `pending`; no `org_members` row for U in B; no agent for U's workstations in B. Turn the flag off, accept again with the same token -> 201 (the invitation was not used up). Interceptors cannot be removed, so scope by org id and flag |
| 9 | Pairing in the home org still hires and names as before | `devopsHireEvents` unchanged | Fresh user pairs workstation 1 -> home-org engineer `Atlas`; pairs workstation 2 -> `Forge`; each workstation has exactly one engineer per org (extend the existing test at `org-members.test.ts:359` with the names) |

Regression search the builder must do: every caller of `devopsName`, `devopsHireEvent`, `devopsHireEvents` and
`hireDevopsForOrgIn` (listed in 2.2; `grep -rn` in `apps/server/src`), and the existing tests that touch DevOps
hiring (`org-members.test.ts`, `invitations.test.ts`, `agent-move*.test.ts`, `setup-checklist.test.ts`,
`devops-*.test.ts`). None of them should need changes.

E2E (tester): the GWP-62 sharing scenario with a user who has 2+ paired workstations completes and the user lands in
the new org.
