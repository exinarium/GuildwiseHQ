# GWP-139: Repair missing DevOps engineers for members added with 2+ workstations

## 1. Question

Before GWP-110, the `OrgMemberAdded` membership hook (`registerDevopsMembershipHook`) failed with
`agents_name_per_org` when the new member had two or more active workstations. It only logged a warning, so members
added through a non-accept path (CLI, migration) in that state have no DevOps engineer in that organization on some or
all of their serving workstations. Is the fix already on release/1.6.0, does a repair already exist, and if not, how
should a one-off, idempotent repair be built?

## 2. Check of release/1.6.0 (step 0)

| Check | Result |
| --- | --- |
| GWP-110 merged on release/1.6.0 | Yes. `6b3f7bc2` (GWP-110: unique DevOps engineer names when a member joins with several workstations) is an ancestor of `origin/release/1.6.0`. The card branch is based on the same commit as `origin/release/1.6.0` (`663f52d5`); `devops.ts`, `simulation/fit.ts` and `data-migrations/` are identical on both. |
| 2+ workstation hook failure fixed | Yes. `hireDevopsForOrgIn` (`apps/server/src/commands/devops.ts:168`) passes one `taken` set through the loop over the member's workstations, and `devopsName` (`devops.ts:69`) takes the append lock and skips names already used in the org or taken earlier in the same loop. The test `the membership hook hires with unique names for a member with 2 workstations` (`apps/server/test/org-members.test.ts:451`) covers the hook path. `registerDevopsMembershipHook` (`devops.ts:918`) still only logs a warning on failure, which is right for an event subscriber; nothing to change there. |
| Repair or backfill already exists | No. The only DevOps data migration is `orphaned-devops-2026-11` (`data-migrations/orphaned-devops.ts`), which retires engineers on unpaired workstations. Nothing hires missing engineers for existing members. |

Conclusion: the cause is fixed, the repair is not built. The card is not closed; build the migration below.

Production count of affected pairs: not available from this workstation. The read-only detection query is in
section 4.2; it is requested from DevOps and must be recorded on the card before deploy (AC 8). The migration ships
either way (requirement 5); with an empty set it logs zero and changes nothing.

## 3. Findings that shape the design

1. `hireDevopsForOrgIn(ctx, tx, userId, orgId)` only uses `ctx.store`. A data migration has a `DataMigrationEnv`
   (`pool`, `store`, `clock`, `log`), not a `Ctx`. The existing workaround in `blog-launch.ts:66` is
   `as unknown as Ctx`; the cleaner precedent is `Pick<Ctx, ...>` (`commands/agents.ts:174`, `ceo/provision.ts:43`,
   `commands/mail-inboxes.ts:79`).
2. `hireDevopsForOrgIn` returns `void`, so a caller cannot tell how many engineers it hired. Its two callers (the
   membership hook, `invitations.ts:541`) ignore the result.
3. `hireDevopsForOrgIn` does not check membership status, organization status or whether the org is a simulation; it
   selects the user's active workstations that serve the org (`wsServesOrgSql`) and calls `devopsHireEvent` per
   workstation. `devopsHireEvent` returns `null` when the org has no `devops` role (`loadRole`) or when an active
   DevOps engineer already exists for that org and workstation. So the hire path itself is already idempotent per
   workstation.
4. Data migrations run in `start.ts` before `createApp` and before `registerBuiltins`. On a brand-new database the
   `devops` role may not be registered yet when the migration runs, so `devopsHireEvent` returns `null`. On an
   existing database the role exists.
5. `runDataMigrations` (`data-migrations/index.ts:153`) does not catch: a migration that throws stops server boot.
6. `PgEventStore.intercept` lets a test make a specific append fail (used by the GWP-110 test
   `a failing hire rolls the accept back...`). The migration test can pass `t.app.ctx.store` as `env.store`, so no
   dependency injection is needed to simulate a failing pair.
7. Business-mode orgs keep their built-in DevOps engineer (ledger d7096210, rule 2: auto-creation unchanged in every
   org), so they are in scope for the repair like any other org.

## 4. Design

### 4.1 Files

| File | Change |
| --- | --- |
| `apps/server/src/data-migrations/missing-devops.ts` | New. `MISSING_DEVOPS_MIGRATION = 'missing-devops-2026-11'`, `LOCK_ID = 7354` (next free after 7353), `MissingDevopsReport`, `findMissingDevopsPairs(db)`, `migrateMissingDevops(env)`. |
| `apps/server/src/data-migrations/index.ts` | Import, re-export (`migrateMissingDevops`, `MISSING_DEVOPS_MIGRATION`, `type MissingDevopsReport`), and append `{ name: 'missing-devops-2026-11', run: (env) => migrateMissingDevops(env) }` as the last entry, after `orphaned-devops-2026-11` (retire orphans first, then hire missing; the two never touch the same workstation). |
| `apps/server/src/commands/devops.ts` | Two signature-only changes to `hireDevopsForOrgIn`: the first parameter becomes `ctx: Pick<Ctx, 'store'>`, and it returns `Promise<number>` (the number of `AgentHired` events appended, `events.length`). No behaviour change; both existing callers still compile and ignore the result. This is the same hire path, not a second one. |
| `apps/server/test/missing-devops-migration.test.ts` | New, see section 6. |

No SQL schema migration. No change to `registerDevopsMembershipHook`, invitations, memberships or workstations.

### 4.2 Detection (read-only, requirement 1)

One query returns every affected (member, org) pair and how many of their serving workstations lack an engineer. It
applies the same filters the pairing path uses (`devopsHireEvents`: active membership, org status `trial`/`active`)
plus the workstation rule of `hireDevopsForOrgIn` (active, `wsServesOrgSql`) and the existence check of
`devopsHireEvent` (active `is_devops` agent for that org and workstation).

```ts
export async function findMissingDevopsPairs(db: Queryable) {
  return rows<{ org_id: string; user_id: string; missing: number }>(
    db,
    `SELECT om.org_id, om.user_id, count(*)::int AS missing
       FROM org_members om
       JOIN organizations o ON o.id = om.org_id
       JOIN workstations w ON w.user_id = om.user_id AND w.status = 'active'
                          AND ${wsServesOrgSql('w', 'om.org_id')}
      WHERE om.status = 'active' AND o.status IN ('trial','active')
        AND NOT EXISTS (SELECT 1 FROM agents a
                         WHERE a.org_id = om.org_id AND a.workstation_id = w.id
                           AND a.is_devops AND a.status = 'active')
      GROUP BY om.org_id, om.user_id
      ORDER BY om.org_id, om.user_id`,
  );
}
```

For the production check, DevOps runs the same SQL with `wsServesOrgSql` expanded (read-only):

```sql
SELECT x.org_id, count(*) AS pairs, sum(x.missing) AS workstations_missing
FROM (
  SELECT om.org_id, om.user_id, count(*) AS missing
    FROM org_members om
    JOIN organizations o ON o.id = om.org_id
    JOIN workstations w ON w.user_id = om.user_id AND w.status = 'active'
     AND COALESCE(w.simulation_org_id = om.org_id,
                  NOT EXISTS (SELECT 1 FROM organizations so WHERE so.id = om.org_id AND so.simulation))
   WHERE om.status = 'active' AND o.status IN ('trial','active')
     AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.org_id = om.org_id AND a.workstation_id = w.id
                       AND a.is_devops AND a.status = 'active')
   GROUP BY om.org_id, om.user_id
) x
GROUP BY x.org_id ORDER BY x.org_id;
```

The total is the sum of `pairs` over all rows.

The pair set is wider than "members with 2+ workstations": any active pair with a missing engineer is repaired (the
card's goal and requirement 1). A pair whose hook failed for another reason is closed by the same run.

### 4.3 Repair (requirements 2-4)

Shape, following `orphaned-devops.ts` (run-once row, own advisory lock, one `withAppendTx` per unit, row written only
when the run is complete):

```ts
export interface MissingDevopsReport {
  pairs: number;      // affected (member, org) pairs found
  hired: number;      // DevOps engineers hired (AgentHired events)
  failed: number;     // pairs whose hire threw
  skipped: number;    // pairs where the hire path hired nobody (no devops role yet)
  byOrg: Record<string, { pairs: number; hired: number; failed: number; skipped: number }>;
}

export async function migrateMissingDevops(env: DataMigrationEnv): Promise<MissingDevopsReport | null> {
  const { pool, store, clock, log } = env;
  try {
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [MISSING_DEVOPS_MIGRATION])) return null;
    const lock = await pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
      if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [MISSING_DEVOPS_MIGRATION])) return null;
      const pairs = await findMissingDevopsPairs(pool);
      // log per-org counts and the total before hiring (requirement 1)
      for (const p of pairs) {
        try {
          const n = await withAppendTx(pool, (tx) => hireDevopsForOrgIn({ store }, tx, p.user_id, p.org_id));
          if (n > 0) hired += n; else skipped++;   // also per org
        } catch (err) {
          failed++;                                  // also per org
          log(`${MISSING_DEVOPS_MIGRATION}: hire failed for member ${p.user_id} in org ${p.org_id}: ${message(err)}`);
        }
      }
      log(`${MISSING_DEVOPS_MIGRATION}: ${pairs.length} pair(s) found, ${hired} engineer(s) hired, ${failed} failed, ${skipped} skipped`);
      if (failed === 0 && skipped === 0) INSERT INTO data_migrations ... ON CONFLICT (name) DO NOTHING (summary = report)
      return report;
    } finally { unlock; release }
  } catch (err) {
    log(`${MISSING_DEVOPS_MIGRATION}: aborted: ${message(err)}`);   // never blocks boot (finding 5)
    return null;
  }
}
```

Decisions:

- **Hire through `hireDevopsForOrgIn` only.** One `withAppendTx` per pair, so a failure rolls back that pair alone and
  the next pair goes on. The names (`devopsName` with the append lock and a fresh `taken` set), role, model, actor
  (`SYSTEM_ACTOR`), `hiredByUserId` (the member) and scope are exactly those of a normal hire. No agent rows are
  written directly.
- **Per-pair logic is idempotent on its own.** The detection query skips workstations that already have an engineer,
  and `devopsHireEvent` checks again inside the transaction under the append lock. A second run with the
  `data_migrations` row removed finds zero pairs and appends nothing.
- **Run once.** The `data_migrations` row is written only when nothing failed or was skipped (the `orphaned-devops`
  rule). A failing pair, or an org with no `devops` role yet (fresh database, finding 4), is retried on the next boot;
  every pair already repaired is a no-op then, so no duplicate events. When everything succeeded (including an empty
  set: 0 found, row written), later boots return `null` at once.
- **Never block boot.** Per-pair errors are caught and logged with member, org and reason. The whole body is also
  wrapped: a detection or lock error is logged and the migration returns `null` without writing the row, so the
  server still starts and the next boot retries.
- **Additive only.** Selection is on missing engineers; nothing fires, renames or reassigns an existing engineer, and
  memberships and workstations are only read.
- **Logging.** `env.log` (console at boot), matching the other data migrations: one line per org with its pair count
  before hiring, one line per failure, one summary line (`N pair(s) found, H engineer(s) hired, F failed, S skipped`).
  With an empty set the summary line reads `0 pair(s) found, 0 engineer(s) hired, 0 failed, 0 skipped`.

## 5. Options considered

| Option | Verdict |
| --- | --- |
| A. Data migration that reuses `hireDevopsForOrgIn` per pair (above) | **Chosen.** Required by the card; same events, names and projections as a normal hire; idempotent twice over. |
| B. Re-emit `OrgMemberAdded` or call the membership hook for each pair | Rejected: writes a misleading membership event and depends on the subscriber being registered (it is not, at data-migration time). |
| C. Hire per workstation with `devopsHireEvent` directly | Rejected: a second hire path; the card says reuse `hireDevopsForOrgIn`. |
| D. Pass `env` as `as unknown as Ctx` (blog-launch precedent) instead of narrowing the parameter type | Works, but hides what the function really needs. `Pick<Ctx, 'store'>` is type-only and has precedents. |
| E. Count hires by diffing `agents` before and after instead of returning a number | Works, but adds queries and races; returning `events.length` is simpler and harmless to existing callers. |

## 6. Tests (`apps/server/test/missing-devops-migration.test.ts`)

DB-backed vitest, same setup as `workstation-unpair-devops.test.ts` (`createWorld({ listen: false })`, `env()` built
from `w.t.app.ctx` with a `log` that collects lines, `pairWorkstation`, `t.createOrg`, `t.addOrgMember`). Each test
deletes the `data_migrations` row first. The test database is shared, so assert on the orgs the test created
(`report.byOrg[org]`, agents of that org) and never on global totals.

**Seeding the pre-GWP-110 state:** pair the member's workstations, install a `store.intercept` that throws for
`AgentHired` with `isDevops` and `orgId === org` while a flag is on, call `t.addOrgMember(org, user, 'member')` (the
hook catches and warns, exactly the old failure), then turn the flag off. Interceptors cannot be removed, so guard every
interceptor with its own flag/org.

| # | Test | AC |
| --- | --- | --- |
| 1 | Member with 2 active workstations serving the org and no engineer: after the migration each workstation has exactly one active DevOps engineer for the org; the `AgentHired` events have `isDevops: true`, `hiredByUserId` = member, actor system, names unique in the org (case-insensitive) and from the DevOps name list; `report.byOrg[org]` = `{ pairs: 1, hired: 2, failed: 0, skipped: 0 }`. | AC 2 |
| 2 | Run again: returns `null` (row written). Delete the row and run again: zero pairs for the org, no new `AgentHired` events for the org (count events before and after). | AC 3 |
| 3 | Leave-alone: a member who already has an engineer on every serving workstation; a removed member (`status <> 'active'`); a member whose only other workstation is `unlinked`; a member whose workstation is simulated for another org (`simulation_org_id` set to a simulation org). Agents and events for those are unchanged; none of them appears in `byOrg`. | AC 4 |
| 4 | One member in two orgs, engineer missing only in org B: B gets one hire, org A's agents and events are unchanged. | AC 5 |
| 5 | Two affected pairs; intercept fails the hire for pair 1 only: the migration resolves (does not throw), the log has a line naming member 1, org 1 and the error; pair 2 is repaired; `failed: 1`; the row is not written. Turn the failure off and run again: pair 1 is repaired, the row is written. | AC 6 |
| 6 | Summary log line contains pairs found, hired and failed. Empty case: with no affected pair in the test's orgs, `byOrg` has no entry for them and no event is appended for them. Because the shared test database may hold other tests' pairs, export a small pure `formatMissingDevopsSummary(report)` from the migration file (the summary line uses it) and check that an empty report formats as `0 pair(s) found, 0 engineer(s) hired, 0 failed, 0 skipped`. | AC 7 |
| 7 | Regression: `org-members.test.ts` (membership hook and invitation tests), `workstation-unpair-devops.test.ts` and `tsc` stay green after the `hireDevopsForOrgIn` signature change. | Test plan 7 |

These suites need Postgres (and `org-members.test.ts` uses Mailpit). If the builder's sandbox has no database, the
builder runs `tsc` and names the suites in the handoff for the testers / DevOps to run (standing order GWP-99).

## 7. Acceptance criteria mapping

| AC | Where it is met |
| --- | --- |
| 1. Architect's check on the card | Section 2, also posted as a comment on the card. Not everything is done, so the card is built. |
| 2. Every serving workstation gets exactly one engineer via `hireDevopsForOrgIn` | Section 4.3 (only hire path), test 1. |
| 3. Second run / restart hires nobody | Run-once row plus per-pair idempotence (4.3), test 2. |
| 4. Leave-alone cases | Detection filters (4.2), test 3. |
| 5. Two orgs, only the missing one changes | Pairs are per (member, org); `hireDevopsForOrgIn` is scoped to one org; test 4. |
| 6. One failing pair logged, others repaired, boot continues | Per-pair try/catch and transaction, outer catch (4.3), test 5. |
| 7. Summary log, zero on empty set | 4.3 logging, test 6. |
| 8. Production count recorded on the card | Ops step: DevOps runs the query in 4.2 against production before deploy and the count goes on the card. Requested from DevOps during design; not obtainable from this workstation. |

## 8. Risks

- **Fresh database:** the `devops` role may not exist when data migrations run, so the migration skips and retries on
  later boots until the role exists (then hires nothing new because registration-time pairing already hired). Harmless,
  one log line per boot until done.
- **Permanently failing pair:** the migration retries it on every boot and logs the failure each time. Intended: it
  keeps the problem visible. If that ever becomes noise, a later change can write the row with the failures in the
  summary.
- **Large orgs:** one short append transaction per pair under the global append lock, before the HTTP listener starts.
  The expected set is small (possibly empty); no batching needed.
- **Signature change of `hireDevopsForOrgIn`:** type-only plus a return value; both callers are checked by `tsc` and by
  the existing hook/invitation tests.
