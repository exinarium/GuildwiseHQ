import type { AgentDto } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, type Row, rows } from '../db/sql.ts';

export function toAgentDto(a: Row, active: Array<{ cardId: string; ref: string; title: string }>): AgentDto {
  return {
    id: a.id,
    orgId: a.org_id,
    projectId: a.project_id,
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
    sandbox: a.sandbox ?? null,
    sandboxReason: a.sandbox_reason ?? null,
    activeCards: active,
  };
}

/** Agents visible to the user: their own org's agents plus project-scoped agents of projects they belong to. */
export async function listAgents(
  ctx: Ctx,
  userId: string,
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
      WHERE (a.org_id = $1 OR a.project_id IN (SELECT project_id FROM project_members WHERE user_id=$1 AND status='active'))
        AND ($2::uuid IS NULL
             OR a.project_id = $2
             OR (a.project_id IS NULL AND a.org_id = (SELECT org_id FROM projects WHERE id = $2)))
      ORDER BY a.status = 'retired', a.hired_at, a.id`,
    [userId, projectId ?? null],
  );
  if (projectId) {
    // Hide other orgs' org-wide agents when filtering by a project the user cannot see.
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
