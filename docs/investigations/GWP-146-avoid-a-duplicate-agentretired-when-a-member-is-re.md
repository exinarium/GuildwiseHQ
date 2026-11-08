# GWP-146: Avoid a duplicate AgentRetired when a member is removed from their last organization

## Question

When a member leaves their last organization, `removeOrgMemberIn` and the offboarding unlink both append an `AgentRetired`
for the same DevOps engineer. Is that still true on release/1.6.0? If so, how do we make sure only one event is appended
without changing anything else about the removal?

## Is it already fixed on release/1.6.0? No

- The worktree HEAD (`f6b71d8d`) is an ancestor of `origin/release/1.6.0` (`3077ba30`).
  `git diff HEAD origin/release/1.6.0` shows no changes in `commands/orgs.ts`, `governance/offboarding.ts`,
  `commands/workstations.ts`, `commands/devops-retire.ts` or `commands/platform.ts`. So the code described below is the
  code on release/1.6.0.
- I found the duplicate by reading the code. It was not reproduced with a test run, because the server tests need
  Postgres. The new test (below) fails on the current code and is the proof.
- The card is still needed. Nothing in it is done yet.

## Findings

All paths are in `apps/server/src`.

1. `commands/orgs.ts`, `removeOrgMemberIn`:
   - Lines 390-395 select `devops`, meaning `agents` with `a.org_id = org AND is_devops AND status='active' AND w.user_id = member`.
     This happens **before** offboarding.
   - Lines 396-402 push one `AgentRetired` (`{ agentId, by, releasedCardIds: [] }`, with no `reason`) per row into the local
     `events` batch.
   - Line 410 calls `runOffboardingIn`.
   - Line 424 appends the batch, which is after offboarding.
   - Lines 427-428 queue `agent.wipe` for each row of the same `devops` list.
2. `governance/offboarding.ts`, `runOffboardingIn`:
   - `last = otherOrgs === 0` (line 270).
   - When `last` is true, it calls `unlinkWorkstationIn` for every **active** workstation of the member (lines 403-406;
     `offboardingFacts` selects `workstations.status='active'`).
3. `commands/workstations.ts`, `unlinkWorkstationIn` (lines 312-333):
   - Selects `agents WHERE workstation_id=$1 AND is_devops AND status='active'`, in every org.
   - Builds `devopsRetireEvents(... reason: 'workstation_unpaired')`, which gives one `AgentRetired` with `reason` and
     `workstationId`, plus claim, shift and request clean-up.
   - Appends them **immediately** (`ctx.store.append(events, { tx })`).
4. `eventstore/pg-event-store.ts` (line 113) runs projectors inline in the same transaction. The `AgentRetired` projector
   (`projections/agents.ts` lines 111-114) sets `agents.status='retired'`. So by the time `runOffboardingIn` returns, the
   engineers on unlinked workstations are already `retired` in the read model. Nothing deduplicates on append: the
   interceptors are routing, org status and cost stamp.
5. Result: when the member is removed from their last org, every engineer on an active workstation gets two
   `AgentRetired` events:
   - first `workstation_unpaired` from the unlink;
   - then the reason-less one from `removeOrgMemberIn`.

   When it is not their last org, nothing is unlinked, so there is one event and no duplicate.

### Callers

- `removeOrgMember` (`DELETE /api/org/members/:userId`) and `leaveOrg` (`DELETE /api/org/members/me`) both call
  `removeOrgMemberIn` inside `withAppendTx`. Both hit the duplicate on a last-org removal.
- `patchPlatformUser` (`commands/platform.ts` lines 451-474, deactivate) calls `removeOrgMemberIn` for every non-owner
  membership. The last of these can be a `last` offboarding, so it hits the **same duplicate**, and the same fix covers it.
- The later direct `unlinkWorkstationIn` loop in `patchPlatformUser` cannot duplicate:
  - Its station query is `status='active'`, so workstations offboarding already unlinked are skipped.
  - `unlinkWorkstationIn` only retires `status='active'` engineers, so engineers `removeOrgMemberIn` already retired are
    skipped.

  This loop needs no change; a test confirms it.

### Engineers offboarding does not retire

`removeOrgMemberIn` must still retire these, and retire them once:

- Any removal that is not from the member's last org: offboarding unlinks nothing.
- An `active` engineer whose workstation is no longer `active`, for example a legacy orphan on an `unlinked` workstation.
  Offboarding only unlinks active workstations.

## Options

| | Option | Verdict |
|---|---|---|
| A | Keep the `devops` selection as it is. **After** `runOffboardingIn`, re-read which of those ids are still `status='active'` and push `AgentRetired` only for those. | **Recommended.** Small and local. The `agent.wipe` list is unchanged (req. 4). Order inside the batch is unchanged. |
| B | Move the whole `devops` query after `runOffboardingIn`. | Rejected. The same list drives the `agent.wipe` commands at lines 427-428, so engineers retired by offboarding would lose their wipe command. That is a behaviour change, against req. 4. Splitting it into two queries is A with more code. |
| C | Pass a skip set into `runOffboardingIn` / `unlinkWorkstationIn`, or let it return the retired ids. | Rejected. It changes the offboarding API and other callers for a one-line local check. |
| D | Rely on the projector being idempotent. | Forbidden by the constraints. The audit trail still shows two events. |

## Design (option A)

The only file to change is `apps/server/src/commands/orgs.ts`, inside `removeOrgMemberIn`.

1. Keep the `devops` query at lines 390-395 exactly as it is. It still feeds the wipe loop.
2. Delete the `for (const d of devops) events.push(AgentRetired…)` block at lines 396-402.
3. After `const run = await runOffboardingIn(…)` and **before** the `OrgMemberRemoved` push, add:

```ts
  // A last-organization offboarding unlinks the member's workstations, and the unlink already retired their DevOps engineers
  // (AgentRetired reason workstation_unpaired). Only the ones still active are retired here, so each gets exactly one event.
  const stillActive = devops.length
    ? new Set(
        (
          await rows<{ id: string }>(tx, `SELECT id FROM agents WHERE id = ANY($1::uuid[]) AND status='active'`, [
            devops.map((d) => d.id),
          ])
        ).map((r) => r.id),
      )
    : new Set<string>();
  for (const d of devops)
    if (stillActive.has(d.id))
      events.push({
        streamId: streamId.agent(d.id),
        event: { type: 'AgentRetired', payload: { agentId: d.id, by: actorId, releasedCardIds: [] } },
        actor: userActor(actorId),
        scope: orgScope(orgId),
      });
```

4. Leave everything else alone: the `ClaimReleased` events, `OrgMemberRemoved`, the single `ctx.store.append(events, { tx })`,
   both `agent.wipe` loops (they still iterate over the full `devops` list) and the returned `run`.
5. Update the JSDoc of `removeOrgMemberIn` (lines 341-346). It should say that the engineers are retired here unless the
   offboarding unlink already retired them.

### Properties

- **Final batch order is unchanged.** Before the fix it was `ClaimReleased…`, `AgentRetired…`, `OrgMemberRemoved`.
  After the fix it is the same, minus the duplicates. The offboarding events are still appended inside
  `runOffboardingIn` / `unlinkWorkstationIn`, as before.
- **Transaction.** Everything stays in the caller's `withAppendTx`. The re-read sees the offboarding projection because
  it runs in the same `tx`. A failed removal still rolls back as a whole.
- **Unchanged parts:**
  - the event shape (the reason-less `AgentRetired` stays exactly as it was for the engineers it still emits);
  - the projection;
  - the offboarding step order;
  - the database schema (no migration).
- **Concurrency.** The global append advisory lock is already held through `withAppendTx`, so nothing else can retire the
  engineer between the re-read and the append.

### Risks

- Low. The only behavioural difference is fewer `AgentRetired` events, and only for engineers that are already `retired`.
- Downstream consumers that count `AgentRetired` events (audit export, CEO signals) now see one per engineer, which is
  the intended result.
- Not in scope, but noticed: on a last-org removal, `unlinkWorkstationIn` marks the pending runner commands of the
  workstation `failed`, and then `removeOrgMemberIn` queues new `agent.wipe` commands on that same unlinked workstation.
  Those commands are never delivered. This is existing behaviour and req. 4 says to keep it, so the design leaves it as
  it is.

## Tests (for the builder)

Add a new file, `apps/server/test/org-removal-devops.test.ts`. Base it on `org-offboarding.test.ts`: `createTestApp`,
`pairWorkstation`, and the `acme({ memberHasOtherOrg })` setup, cut down to what is needed. You can also add cases to
`org-offboarding.test.ts`.

### Fixture notes

- `t.addOrgMember` appends `OrgMemberAdded`. The Acme DevOps engineer for the member's active workstation is then hired
  **asynchronously**, by the membership hook (`registerDevopsMembershipHook`, `commands/devops.ts`).
  - Wait with `until(...)` for `agents WHERE org_id=<acme> AND workstation_id=<ws> AND is_devops AND status='active'`.
  - Or hire synchronously with `hireDevopsForOrgIn(ctx, tx, member.id, org)` inside `withAppendTx`.
- A second workstation paired **after** joining Acme gets its Acme engineer at pairing time, through `devopsHireEvents`.
- `memberHasOtherOrg: false` sets the member's personal org membership to `removed`, so Acme becomes their last org.
- Helper: count `SELECT payload FROM events WHERE type='AgentRetired' AND payload->>'agentId'=$1`.

### Cases

| # | Case | Assertions |
|---|---|---|
| 1 | `removeOrgMember`, last org, one engineer on a linked workstation (`DELETE /api/org/members/:id` as admin) | 1 `AgentRetired` for the engineer, with `payload.reason === 'workstation_unpaired'` (the offboarding one stays). `agents.status='retired'`. **Fails today with 2.** |
| 2 | Same, with two workstations, so two Acme engineers | 1 event each, both retired. |
| 3 | `leaveOrg`, last org (`DELETE /api/org/members/me` as the member, with the `x-aom-org` header) | 1 event per engineer. |
| 4 | `patchPlatformUser` deactivate. The member's personal org must not block it: as in `deactivation.test.ts`, first `POST /api/platform/orgs/<member.id>/suspend`. With `memberHasOtherOrg:false`, Acme is the `last` removal. Then `PATCH /api/platform/users/:id {status:'deactivated'}` as `superAdminSession()`. | 1 event per engineer, all retired. The workstation is `unlinked`. This confirms the direct unlink loop adds nothing. |
| 5a | Not the last org (`memberHasOtherOrg: true`), `removeOrgMember` | The Acme engineer is retired by exactly 1 event, with **no** `reason` (emitted by `removeOrgMemberIn`). The engineer of the member's other org on the same workstation is still `active`. The workstation stays `active`. |
| 5b | Last org, plus a legacy orphan. A second workstation's row is set to `status='unlinked'` by SQL while its Acme engineer stays `active`. | The orphan is retired by exactly 1 event (no `reason`). Engineers on the active workstation are retired by 1 event (`workstation_unpaired`). |
| 6 | Member without DevOps engineers (retire them first, or use a member with no workstation) | No `AgentRetired` for the removal. `OrgMemberRemoved` and `MemberOffboarded` are present. |
| 7 | Regression, inside 1 | The member's `project_members` row is `removed`. The workstation is `unlinked`. `runner_commands` has an `agent.wipe` row for each engineer (`payload->>'agentId'`). The offboarding report has `steps` with `workstations` = `done`. |

After every case, check that no DevOps engineer of the member in Acme is left `status='active'` (AC 4).

### Running the tests

These tests need Postgres, the same as every server test that uses `createTestApp`.

- Run the new file with `pnpm --filter @aom/server exec vitest run test/org-removal-devops.test.ts`, plus
  `org-offboarding.test.ts`, `deactivation.test.ts` and `workstation-unpair-devops.test.ts` as regressions.
- Also run typecheck and lint.
- If the shift cannot reach the database, hand the DB-backed suites to the testers or DevOps (standing order for GWP-99)
  and name them in the handoff.
- Show that the test fails without the fix: run case 1 once with the change reverted locally, and confirm that it
  reports 2 events.

## How each acceptance criterion is met

| AC | Covered by |
|---|---|
| One `AgentRetired` per engineer when removed from the last org | Option A filter. Tests 1 and 2. |
| Same for `leaveOrg` and `patchPlatformUser` | Same function, so the same fix. Tests 3 and 4. The direct unlink loop in `patchPlatformUser` was analysed and needs no change. |
| An engineer offboarding did not retire is still retired, once | The `stillActive` re-read keeps it. Tests 5a and 5b. |
| No engineer left active | Re-read plus the unlink. Checked after every case. |
| No engineers means no `AgentRetired` | `devops` is empty, so there is no query and no event. Test 6. |
| Other removal effects unchanged | Only the `AgentRetired` push moves and is filtered. The wipe list and the other events are untouched. Test 7 and the existing `org-offboarding` and `deactivation` suites. |
| A test fails on the current behaviour | Test 1 (expects 1, gets 2 today). |
| Already fixed on release/1.6.0? | No. See "Is it already fixed on release/1.6.0? No" above. The card goes to build. |
