import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `suspicious-roles-2026-10` (owner decision Q72, security review finding 3): before a pack could add versions only to a role of
 * its own, a pack could add a version to another pack's role (or to a role made from a private pack). Nothing says which version
 * was foreign, so nothing is repaired. This flags every role that has versions from more than one pack, or any version from a
 * private pack, with ONE desk notice per role for the organization's Owner to review (`suspicious_role`). It changes no role, no
 * agent and nothing else. Idempotent: a role already flagged (same subject key) is not flagged twice, and the run is recorded once.
 */
export const SUSPICIOUS_ROLES_MIGRATION = 'suspicious-roles-2026-10';
export const SUSPICIOUS_ROLE_SUBKIND = 'suspicious_role';

export interface SuspiciousRolesReport {
  flagged: Array<{ orgId: string; roleKey: string; reason: string }>;
}

export async function migrateSuspiciousRoles(env: DataMigrationEnv): Promise<SuspiciousRolesReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [SUSPICIOUS_ROLES_MIGRATION]))
    return null;
  const found = await rows<{
    org_id: string;
    key: string;
    packs: number;
    pack_names: string[];
    has_private: boolean;
    versions: number;
  }>(
    pool,
    `SELECT org_id, key, count(*)::int AS versions,
            count(DISTINCT definition->'source'->>'packId')::int AS packs,
            array_remove(array_agg(DISTINCT definition->'source'->>'packName'), NULL) AS pack_names,
            bool_or(definition->'source'->>'visibility' = 'private') AS has_private
       FROM role_definitions
      WHERE org_id IS NOT NULL AND definition->'source'->>'packId' IS NOT NULL
      GROUP BY org_id, key
     HAVING count(DISTINCT definition->'source'->>'packId') > 1
         OR bool_or(definition->'source'->>'visibility' = 'private')
      ORDER BY org_id, key`,
  );
  const report: SuspiciousRolesReport = { flagged: [] };
  for (const f of found) {
    const reason =
      f.packs > 1
        ? `its versions came from ${f.packs} different packs (${f.pack_names.join(', ')})`
        : 'it was made from a private pack';
    const subjectKey = `suspicious_role:${f.org_id}:${f.key}`;
    const done = await withAppendTx(pool, async (tx) => {
      if (
        await one(tx, 'SELECT 1 FROM desk_items WHERE org_id=$1 AND subject_key=$2', [f.org_id, subjectKey])
      )
        return false;
      const deskItemId = randomUUID();
      await store.append(
        [
          {
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'DeskItemCreated',
              payload: {
                deskItemId,
                kind: 'alert',
                subkind: SUSPICIOUS_ROLE_SUBKIND,
                title: `Review the role "${f.key}": ${f.packs > 1 ? 'versions from different packs' : 'made from a private pack'}`,
                body: `The role "${f.key}" looks unusual: ${reason}. Before a security fix, a pack could add a version to a role that another pack made. Nothing was changed. Open Roles, look at the versions of "${f.key}" and who they came from, and retire any you do not recognize; agents of this role follow its newest version.`,
                options: [],
                blocking: false,
                pinned: false,
                affectedCardIds: [],
                askedBy: { kind: 'system' },
                data: { roleKey: f.key, packs: f.packs, packNames: f.pack_names, versions: f.versions },
                subjectKey,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(f.org_id),
          },
        ],
        { tx },
      );
      return true;
    });
    if (done) report.flagged.push({ orgId: f.org_id, roleKey: f.key, reason });
  }
  await pool.query(
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [SUSPICIOUS_ROLES_MIGRATION, clock.now(), JSON.stringify({ flagged: report.flagged.length })],
  );
  log(
    `${SUSPICIOUS_ROLES_MIGRATION}: ${report.flagged.length} role(s) flagged for review; nothing was changed`,
  );
  return report;
}
