import { randomUUID } from 'node:crypto';
import { BUILTIN_ROLES, BUILTIN_WORKFLOWS, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';

const SYSTEM = { kind: 'system', id: null } as const;
const SCOPE = { orgId: null, projectId: null, audience: 'system' } as const;

/**
 * Registers every built-in workflow and role version that is missing (org_id NULL). Idempotent and safe to run
 * from several processes: the check and the append happen under the global append lock.
 */
export async function registerBuiltins(ctx: Ctx): Promise<{ workflows: number; roles: number }> {
  let workflows = 0;
  let roles = 0;
  await withAppendTx(ctx.pool, async (tx) => {
    for (const def of BUILTIN_WORKFLOWS) {
      const exists = await one(
        tx,
        'SELECT 1 FROM workflow_versions WHERE org_id IS NULL AND key=$1 AND version=$2',
        [def.key, def.version],
      );
      if (exists) continue;
      await ctx.store.append(
        [
          {
            streamId: streamId.workflow(null, def.key),
            event: {
              type: 'WorkflowVersionRegistered',
              payload: {
                workflowVersionId: randomUUID(),
                orgId: null,
                key: def.key,
                version: def.version,
                name: def.name,
                department: def.department,
                definition: def,
                status: 'active',
              },
            },
            actor: SYSTEM,
            scope: SCOPE,
          },
        ],
        { tx },
      );
      workflows++;
    }
    for (const def of BUILTIN_ROLES) {
      const exists = await one(
        tx,
        'SELECT 1 FROM role_definitions WHERE org_id IS NULL AND key=$1 AND version=$2',
        [def.key, def.version],
      );
      if (exists) continue;
      await ctx.store.append(
        [
          {
            streamId: streamId.role(null, def.key),
            event: {
              type: 'RoleVersionRegistered',
              payload: {
                roleVersionId: randomUUID(),
                orgId: null,
                key: def.key,
                version: def.version,
                definition: def,
                status: 'active',
              },
            },
            actor: SYSTEM,
            scope: SCOPE,
          },
        ],
        { tx },
      );
      roles++;
    }
  });
  return { workflows, roles };
}
