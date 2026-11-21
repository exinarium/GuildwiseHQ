import { type PlatformTeamSettings, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import type { Config } from '../config.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';

/** `platform_settings` key of the designation: `{ orgId, projectId }`. */
export const PLATFORM_TEAM_KEY = 'platform.team';

export interface PlatformTeam {
  orgId: string;
  projectId: string;
}

/**
 * The designation (R17-1) comes from server config: `AOM_PLATFORM_TEAM_ORG_ID` and `AOM_PLATFORM_TEAM_PROJECT_ID`.
 * `syncPlatformTeamDesignation` copies it into the `platform.team` row (marked `source: 'env'`) at boot and on every
 * scheduler pass, so the SQL readers (the dispatcher's pause check) and the audit log follow the config. No route
 * writes the designation any more.
 *
 * Self-hosted upgrade (R29): with both env keys unset, a row written by the old `PUT /api/platform/team` (no
 * `source`) keeps working read-only, with a boot warning to move it to env.
 */
export type PlatformTeamSource = 'env' | 'legacy';

interface StoredTeam {
  orgId?: string;
  projectId?: string;
  source?: PlatformTeamSource;
}

async function storedTeam(db: Queryable): Promise<StoredTeam | null> {
  const r = await one(db, 'SELECT value FROM platform_settings WHERE key=$1', [PLATFORM_TEAM_KEY]);
  return (r?.value as StoredTeam | null | undefined) ?? null;
}

/** The designated platform organisation and project, or null when none is designated. */
export async function getPlatformTeam(db: Queryable): Promise<PlatformTeam | null> {
  const v = await storedTeam(db);
  return v?.orgId && v.projectId ? { orgId: v.orgId, projectId: v.projectId } : null;
}

export async function isPlatformProject(db: Queryable, projectId: string): Promise<boolean> {
  return (await getPlatformTeam(db))?.projectId === projectId;
}

/** The env designation when both keys are set, else null. */
export function configuredPlatformTeam(config: Config): PlatformTeam | null {
  const { orgId, projectId } = config.platformTeam;
  return orgId && projectId ? { orgId, projectId } : null;
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
    source: team ? ((row?.value as StoredTeam | undefined)?.source === 'env' ? 'env' : 'legacy') : null,
  };
}

/** Boot warnings about the designation: a half-set env pair, or a legacy row that should move to env (R29). */
export async function platformTeamWarnings(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  const { orgId, projectId } = ctx.config.platformTeam;
  if (!!orgId !== !!projectId)
    out.push(
      'Only one of AOM_PLATFORM_TEAM_ORG_ID and AOM_PLATFORM_TEAM_PROJECT_ID is set: set both to designate the platform team.',
    );
  const want = configuredPlatformTeam(ctx.config);
  if (want) {
    const problem = await envDesignationProblem(ctx.pool, want);
    if (problem)
      out.push(
        `The platform team in AOM_PLATFORM_TEAM_ORG_ID/AOM_PLATFORM_TEAM_PROJECT_ID is not applied: ${problem}. Until it is, ${(await getPlatformTeam(ctx.pool)) ? 'the earlier designation stays in force' : 'no platform team is designated'}.`,
      );
  }
  if (!configuredPlatformTeam(ctx.config)) {
    const v = await storedTeam(ctx.pool);
    if (v?.orgId && v.projectId && v.source !== 'env')
      out.push(
        `The platform team designation (organization ${v.orgId}, project ${v.projectId}) comes from the database and is read-only: set AOM_PLATFORM_TEAM_ORG_ID and AOM_PLATFORM_TEAM_PROJECT_ID to keep it.`,
      );
  }
  return out;
}

/** Why an env designation cannot be applied (the sync then leaves the row as it is), or null. */
async function envDesignationProblem(db: Queryable, want: PlatformTeam): Promise<string | null> {
  const org = await one(db, 'SELECT status FROM organizations WHERE id=$1', [want.orgId]);
  if (!org) return 'the organization does not exist';
  if (!['trial', 'active'].includes(org.status)) return `the organization is ${org.status}`;
  const project = await one(db, 'SELECT org_id, status FROM projects WHERE id=$1', [want.projectId]);
  if (!project) return 'the project does not exist';
  if (project.org_id !== want.orgId) return 'the project belongs to another organization';
  if (project.status !== 'active') return 'the project is archived';
  return null;
}

/**
 * Makes the `platform.team` row follow server config. Env set: the row becomes the env pair (once the organisation is
 * active and the project belongs to it and is active; until then nothing is written and the next pass tries again),
 * and the platform project keeps its decisions at project level. Env unset: a row the env wrote is cleared; a legacy
 * row is left as it is (read-only fallback). Returns whether anything changed. Idempotent; system actor.
 */
export async function syncPlatformTeamDesignation(ctx: Ctx): Promise<boolean> {
  const want = configuredPlatformTeam(ctx.config);
  const changed = await withAppendTx(ctx.pool, async (tx) => {
    const v = await one(tx, 'SELECT value FROM platform_settings WHERE key=$1 FOR UPDATE', [
      PLATFORM_TEAM_KEY,
    ]);
    const have = (v?.value as StoredTeam | null | undefined) ?? null;
    if (!want) {
      if (have?.source !== 'env') return false;
      await exec(tx, 'DELETE FROM platform_settings WHERE key=$1', [PLATFORM_TEAM_KEY]);
      await ctx.store.append(
        [
          {
            streamId: streamId.platformTeam(),
            event: { type: 'PlatformTeamDesignated', payload: { orgId: null, projectId: null } },
            actor: SYSTEM_ACTOR,
            scope: { orgId: have.orgId ?? null, projectId: null, audience: 'admin' },
          },
        ],
        { tx },
      );
      return true;
    }
    if (have?.source === 'env' && have.orgId === want.orgId && have.projectId === want.projectId)
      return false;
    if (await envDesignationProblem(tx, want)) return false;
    const project = await one(tx, 'SELECT decisions_project_only FROM projects WHERE id=$1', [
      want.projectId,
    ]);
    await exec(
      tx,
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,NULL,$3)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=NULL, updated_at=EXCLUDED.updated_at`,
      [PLATFORM_TEAM_KEY, JSON.stringify({ ...want, source: 'env' }), ctx.clock.now()],
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.platformTeam(),
          event: { type: 'PlatformTeamDesignated', payload: { ...want } },
          actor: SYSTEM_ACTOR,
          scope: { orgId: want.orgId, projectId: null, audience: 'admin' },
        },
        // Platform team decisions are project-scoped; HR and the CEO cannot promote them org-wide.
        ...(project?.decisions_project_only
          ? []
          : [
              {
                streamId: streamId.project(want.projectId),
                event: {
                  type: 'ProjectPolicySet' as const,
                  payload: { projectId: want.projectId, decisionsProjectOnly: true },
                },
                actor: SYSTEM_ACTOR,
                scope: { orgId: want.orgId, projectId: want.projectId, audience: 'project' as const },
              },
            ]),
      ],
      { tx },
    );
    return true;
  });
  if (changed) ctx.services.dispatcher.trigger();
  return changed;
}

/** Whether a workstation belongs to an active member of the platform organisation (R17-1: pins and pauses stay there). */
export async function isPlatformWorkstation(
  db: Queryable,
  team: PlatformTeam,
  workstationId: string,
): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 AS x FROM workstations w JOIN org_members m ON m.user_id = w.user_id
      WHERE w.id=$1 AND w.status='active' AND m.org_id=$2 AND m.status='active'`,
    [workstationId, team.orgId],
  ));
}

/**
 * Guards for the platform-team routes: members of the platform organisation. The super admin has no access (R17): it
 * only reads the designation (`GET /api/platform/team`).
 */
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
