import type { AgentDto } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, type Row, rows } from '../db/sql.ts';

export function toAgentDto(a: Row, active: Array<{ cardId: string; ref: string; title: string }>): AgentDto {
  return {
    id: a.id,
    orgId: a.org_id,
    hiredForProjectId: a.hired_for_project_id ?? null,
    allowedProjectIds: a.allowed_project_ids ?? null,
    focusProjectIds: a.focus_project_ids ?? [],
    hiredByUserId: a.hired_by_user_id,
    managerUserId: a.manager_user_id,
    workstationId: a.workstation_id,
    name: a.name,
    roleKey: a.role_key,
    roleVersion: a.role_version,
    seniority: a.seniority,
    runtime: a.runtime,
    model: a.model,
    effort: a.effort,
    skills: a.skills,
    permissions: a.permissions,
    capacity: a.capacity,
    isDevops: a.is_devops,
    status: a.status,
    hiredAt: iso(a.hired_at) as string,
    retiredAt: iso(a.retired_at),
    department: a.department ?? null,
    lastShiftEndedAt: iso(a.last_shift_ended_at),
    avatarSeed: a.avatar_seed ?? a.id,
    avatarStyle: a.avatar_style ?? 'notionists',
    sandbox: a.sandbox ?? null,
    sandboxReason: a.sandbox_reason ?? null,
    activeCards: active,
  };
}

/** Does the agent's workstation user hold an active membership of project `proj` (a SQL expression)? */
const WS_USER_ON = (proj: string) => `EXISTS (SELECT 1 FROM project_members wpm WHERE wpm.project_id = ${proj}
        AND wpm.status = 'active' AND wpm.user_id = ws.user_id)`;

/**
 * Agents visible to the user (docs/design/restructure.md section 4.4): the agents of the request organization (when
 * they are a member of it), plus the agents of any organization that are allowed on a project the user is on and
 * whose workstation owner is on it too (a guest sees the agents that may work the shared project).
 * With `projectId`: only the agents eligible for that project.
 */
export async function listAgents(
  ctx: Ctx,
  userId: string,
  orgId: string | null,
  projectId?: string,
  department?: string,
): Promise<AgentDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT a.*, (SELECT r.department FROM role_definitions r
                   WHERE r.key = a.role_key AND (r.org_id = a.org_id OR r.org_id IS NULL)
                   ORDER BY (r.version = a.role_version) DESC, (r.org_id IS NULL), r.version DESC LIMIT 1) AS department,
            rt.info->>'sandbox' AS sandbox, rt.info->>'sandboxReason' AS sandbox_reason
       FROM agents a
       LEFT JOIN workstations ws ON ws.id = a.workstation_id
       LEFT JOIN LATERAL (SELECT e AS info FROM jsonb_array_elements(ws.runtimes) e WHERE e->>'id' = a.runtime LIMIT 1) rt ON true
      WHERE ((a.org_id = $3::uuid AND EXISTS (SELECT 1 FROM org_members om
                   WHERE om.org_id = a.org_id AND om.user_id = $1 AND om.status = 'active'))
             OR (NOT a.is_devops AND EXISTS (SELECT 1 FROM project_members pm JOIN projects pp ON pp.id = pm.project_id
                         WHERE pp.org_id = a.org_id AND pp.kind = 'project' AND pm.user_id = $1 AND pm.status = 'active'
                           AND (a.allowed_project_ids IS NULL OR pm.project_id = ANY (a.allowed_project_ids))
                           AND ${WS_USER_ON('pm.project_id')})))
        AND ($2::uuid IS NULL
             OR (a.org_id = (SELECT org_id FROM projects WHERE id = $2)
                 AND (a.allowed_project_ids IS NULL OR $2::uuid = ANY (a.allowed_project_ids))
                 AND ${WS_USER_ON('$2::uuid')}))
      ORDER BY a.status = 'retired', a.hired_at, a.id`,
    [userId, projectId ?? null, orgId],
  );
  if (projectId) {
    // Agents of a project the user cannot see are not listed.
    const visible = await rows(
      ctx.pool,
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
      [projectId, userId],
    );
    if (!visible.length) return [];
  }
  const claims = await rows(
    ctx.pool,
    `SELECT id, ref, title, claimed_by_agent_id FROM cards WHERE claimed_by_agent_id = ANY($1::uuid[]) AND claim_id IS NOT NULL`,
    [list.map((a) => a.id)],
  );
  return list
    .filter((a) => !department || a.department === department)
    .map((a) =>
      toAgentDto(
        a,
        claims
          .filter((c) => c.claimed_by_agent_id === a.id)
          .map((c) => ({ cardId: c.id, ref: c.ref, title: c.title })),
      ),
    );
}

/** One agent as the user sees it (object routes: the agent's own organization decides, not the tab's). */
export async function getAgentDto(ctx: Ctx, userId: string, agentId: string): Promise<AgentDto | undefined> {
  const o = await rows<{ org_id: string }>(ctx.pool, 'SELECT org_id FROM agents WHERE id=$1', [agentId]);
  return (await listAgents(ctx, userId, o[0]?.org_id ?? null)).find((x) => x.id === agentId);
}
