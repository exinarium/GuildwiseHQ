import { type PlatformTeamSettings, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, notFound } from '../errors.ts';

/** `platform_settings` key of the designation: `{ orgId, projectId }`. */
export const PLATFORM_TEAM_KEY = 'platform.team';

export interface PlatformTeam {
  orgId: string;
  projectId: string;
}

/** The designated platform organisation and project, or null when the super admin has not designated one. */
export async function getPlatformTeam(db: Queryable): Promise<PlatformTeam | null> {
  const r = await one(db, 'SELECT value FROM platform_settings WHERE key=$1', [PLATFORM_TEAM_KEY]);
  const v = r?.value as { orgId?: string; projectId?: string } | null | undefined;
  return v?.orgId && v.projectId ? { orgId: v.orgId, projectId: v.projectId } : null;
}

export async function isPlatformProject(db: Queryable, projectId: string): Promise<boolean> {
  return (await getPlatformTeam(db))?.projectId === projectId;
}

export async function platformTeamSettings(ctx: Ctx): Promise<PlatformTeamSettings> {
  const row = await one(ctx.pool, 'SELECT value, updated_at FROM platform_settings WHERE key=$1', [
    PLATFORM_TEAM_KEY,
  ]);
  const team = await getPlatformTeam(ctx.pool);
  const org = team
    ? await one(ctx.pool, 'SELECT name FROM organizations WHERE id=$1', [team.orgId])
    : undefined;
  const project = team
    ? await one(ctx.pool, 'SELECT key, name FROM projects WHERE id=$1', [team.projectId])
    : undefined;
  return {
    orgId: team?.orgId ?? null,
    orgName: org?.name ?? null,
    projectId: team?.projectId ?? null,
    projectKey: project?.key ?? null,
    projectName: project?.name ?? null,
    updatedAt: team ? iso(row?.updated_at ?? null) : null,
  };
}

/**
 * The super admin designates one existing organisation and project as the platform team, or clears the designation
 * (`orgId` null). The project's decisions are scoped to the project from then on (`decisions_project_only`: HR and the
 * CEO cannot promote them to the organisation). Intake that was recorded while no team existed is filed afterwards
 * (the next platform pass).
 */
export async function setPlatformTeam(
  ctx: Ctx,
  admin: AuthSession,
  req: { orgId: string | null; projectId?: string | null | undefined },
): Promise<PlatformTeamSettings> {
  if (req.orgId === null) {
    const prev = await getPlatformTeam(ctx.pool);
    await withAppendTx(ctx.pool, async (tx) => {
      await exec(tx, 'DELETE FROM platform_settings WHERE key=$1', [PLATFORM_TEAM_KEY]);
      await ctx.store.append(
        [
          {
            streamId: streamId.platformTeam(),
            event: {
              type: 'PlatformTeamDesignated',
              payload: { orgId: null, projectId: null, by: admin.user.id },
            },
            actor: userActor(admin.user.id),
            scope: { orgId: prev?.orgId ?? null, projectId: null, audience: 'admin' },
          },
        ],
        { tx },
      );
    });
    return platformTeamSettings(ctx);
  }
  const orgId = req.orgId;
  const projectId = req.projectId;
  if (!projectId) throw badRequest('project_required', 'pick the project that runs the platform team');
  await withAppendTx(ctx.pool, async (tx) => {
    const org = await one(tx, 'SELECT id, status, simulation FROM organizations WHERE id=$1', [orgId]);
    if (!org) throw notFound('organization not found');
    if (!['trial', 'active'].includes(org.status))
      throw badRequest('org_not_active', 'the platform team organization must be active');
    const project = await one(
      tx,
      'SELECT id, org_id, status, decisions_project_only FROM projects WHERE id=$1',
      [projectId],
    );
    if (!project || project.org_id !== orgId)
      throw badRequest('project_not_in_org', 'that project does not belong to the organization');
    if (project.status !== 'active') throw badRequest('project_archived', 'the project is archived');
    await exec(
      tx,
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
      [PLATFORM_TEAM_KEY, JSON.stringify({ orgId, projectId }), admin.user.id, ctx.clock.now()],
    );
    const events = [
      {
        streamId: streamId.platformTeam(),
        event: { type: 'PlatformTeamDesignated' as const, payload: { orgId, projectId, by: admin.user.id } },
        actor: userActor(admin.user.id),
        scope: { orgId, projectId: null, audience: 'admin' as const },
      },
      // Platform team decisions are project-scoped; HR and the CEO cannot promote them org-wide.
      ...(project.decisions_project_only
        ? []
        : [
            {
              streamId: streamId.project(projectId),
              event: {
                type: 'ProjectPolicySet' as const,
                payload: { projectId, decisionsProjectOnly: true, by: admin.user.id },
              },
              actor: userActor(admin.user.id),
              scope: { orgId, projectId, audience: 'project' as const },
            },
          ]),
    ];
    await ctx.store.append(events, { tx });
  });
  ctx.services.dispatcher.trigger();
  return platformTeamSettings(ctx);
}

/** Guards for the platform-team routes: the super admin, or a member of the platform organisation. */
export interface PlatformAccess {
  session: AuthSession;
  team: PlatformTeam | null;
  superAdmin: boolean;
  /** Owner or Admin of the platform organisation: may pause, resume, pin and request grants. */
  manager: boolean;
  /** Member of the platform project (or a manager): may read. */
  member: boolean;
}

export async function platformAccessOf(ctx: Ctx, session: AuthSession): Promise<PlatformAccess> {
  const team = await getPlatformTeam(ctx.pool);
  const superAdmin = session.user.kind === 'super_admin';
  let manager = false;
  let member = false;
  if (team && !superAdmin) {
    const role = await one(
      ctx.pool,
      `SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [team.orgId, session.user.id],
    );
    manager = role?.role === 'owner' || role?.role === 'admin';
    member =
      manager ||
      !!(await one(
        ctx.pool,
        `SELECT 1 AS x FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
        [team.projectId, session.user.id],
      ));
  }
  return { session, team, superAdmin, manager, member };
}
