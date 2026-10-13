import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  isOrgManager,
  type OrgRole,
  type SetArchitectSettingsRequest,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, forbidden } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { NO_VAULT_MESSAGE, projectHasVault } from './vaults.ts';

/** Is an architect hired (an active agent with the `architect` role) in the organization? */
export async function architectHired(db: Queryable, orgId: string): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 FROM agents WHERE org_id=$1 AND role_key='architect' AND status='active' LIMIT 1`,
    [orgId],
  ));
}

/**
 * The project's architect settings (project Owner or an organization Owner/Admin): Investigate & design before build by
 * default, merging the latest main branch first, and where the architect's reports go. Switching the design step on
 * while no architect is hired raises a desk notice (one open notice per project): cards would wait in the design stage.
 */
export async function setArchitectSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  projectId: string,
  req: SetArchitectSettingsRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    const orgAdmin = isOrgManager({ orgRole: org.role }) && org.id === p.org_id;
    if (p.my_role !== 'owner' && !orgAdmin)
      throw forbidden('only the project Owner or an organization Owner or Admin can do this');
    if (req.investigationLocation === 'vault' && !(await projectHasVault(tx, projectId)))
      throw badRequest('no_vault', NO_VAULT_MESSAGE);
    const same =
      (p.design_step ?? false) === req.designStep &&
      (p.merge_main_first ?? true) === req.mergeMainFirst &&
      (p.investigation_path ?? 'docs/investigations') === req.investigationPath &&
      (p.investigation_location ?? 'repo') === req.investigationLocation;
    const scope = projectScope(p.org_id, projectId);
    const events: AppendInput[] = [];
    if (!same)
      events.push({
        streamId: streamId.project(projectId),
        event: {
          type: 'ProjectArchitectSettingsSet',
          payload: { projectId, ...req, by: user.id },
        },
        actor: userActor(user.id),
        scope,
      });
    if (req.designStep && !(await architectHired(tx, p.org_id))) {
      const open = await one(
        tx,
        `SELECT 1 FROM desk_items WHERE project_id=$1 AND subkind=$2 AND status='open' LIMIT 1`,
        [projectId, DESK_SUBKIND.noArchitect],
      );
      if (!open) {
        const deskItemId = randomUUID();
        events.push({
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'alert',
              subkind: DESK_SUBKIND.noArchitect,
              title: `${p.name}: Investigate & design is on, but no architect is hired`,
              body: 'Cards with Investigate & design wait in the design stage until an architect is hired. Hire a senior Architect on the HR board, or switch the step off in the project settings.',
              options: [],
              blocking: false,
              pinned: false,
              projectId,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        });
      }
    }
    if (events.length > 0) await ctx.store.append(events, { tx });
  });
}
