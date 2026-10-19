import { streamId } from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { loadCeo } from '../ceo/state.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `ceo-working-branch-2026-10`: the CEO may answer working-branch questions itself (a new owner delegation that is ON by
 * default). Organizations created before have a stored policy without it: it is added once, as a new policy version by
 * the system on behalf of the owner. The owner can take it back in the Authority tab and it stays off then, because this
 * runs only once. Idempotent; recorded once in `data_migrations`.
 */
export const CEO_WORKING_BRANCH_MIGRATION = 'ceo-working-branch-2026-10';

export async function migrateCeoWorkingBranch(env: DataMigrationEnv): Promise<{ changed: string[] } | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [CEO_WORKING_BRANCH_MIGRATION]))
    return null;
  const report = { changed: [] as string[] };
  const orgs = await selectRows<{ org_id: string }>(pool, 'SELECT org_id FROM ceo_settings ORDER BY org_id');
  for (const o of orgs) {
    const ceo = await loadCeo(pool, o.org_id);
    const by = await orgOwnerId(pool, o.org_id);
    if (!ceo || !by || ceo.policy.delegated.includes('working_branch')) continue;
    const next = {
      ...ceo.policy,
      version: ceo.policyVersion + 1,
      delegated: [...ceo.policy.delegated, 'working_branch' as const],
    };
    await store.append([
      {
        streamId: streamId.ceo(o.org_id),
        event: {
          type: 'CeoPolicyChanged',
          payload: {
            orgId: o.org_id,
            version: next.version,
            previousVersion: ceo.policyVersion,
            policy: next,
            by,
            note: 'the CEO may answer working-branch questions (new default; take it back in the Authority tab)',
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(o.org_id),
      },
    ]);
    report.changed.push(o.org_id);
    log(`${CEO_WORKING_BRANCH_MIGRATION}: ${o.org_id} delegated working-branch answers`);
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [CEO_WORKING_BRANCH_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}
