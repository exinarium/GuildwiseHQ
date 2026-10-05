import type {
  ProjectDetailResponse,
  ProjectDto,
  RoleCatalogueEntrySchema,
  WorkstationDto,
} from '@aom/shared';
import type { z } from 'zod';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

/** The department of a project's workflow (its type): the owner's own workflow first, else the built-in. */
export const PROJECT_DEPARTMENT_SQL = `(SELECT w.department FROM workflow_versions w
    WHERE w.key = p.workflow_key AND w.status = 'active' AND (w.org_id = p.org_id OR w.org_id IS NULL)
    ORDER BY (w.org_id IS NULL), w.version DESC LIMIT 1) AS department`;

/** Display name of whoever last changed the large-merge setting. */
const MERGE_CHANGED_BY_SQL = `(SELECT u.display_name FROM users u WHERE u.id = p.merge_large_changed_by) AS merge_large_changed_by_name`;

export function toProjectDto(p: Row, myRole: 'owner' | 'manager'): ProjectDto {
  return {
    id: p.id,
    orgId: p.org_id,
    key: p.key,
    name: p.name,
    domain: p.domain,
    workflowKey: p.workflow_key,
    department: p.department ?? null,
    priorityTier: p.priority_tier,
    branchPrefix: p.branch_prefix,
    workingBranch: p.working_branch,
    subCategories: p.sub_categories,
    vaultFolder: p.vault_folder,
    architecturalGlobs: p.architectural_globs,
    e2eGlobs: p.e2e_globs,
    status: p.status,
    mergeLargeWithoutApproval: p.merge_large_without_approval ?? false,
    mergeLargeChanged: p.merge_large_changed_at
      ? { byName: p.merge_large_changed_by_name ?? 'unknown', at: iso(p.merge_large_changed_at) as string }
      : null,
    createdAt: iso(p.created_at) as string,
    myRole,
  };
}

export async function listProjects(ctx: Ctx, userId: string, department?: string): Promise<ProjectDto[]> {
  const r = (
    await rows(
      ctx.pool,
      `SELECT p.*, pm.role AS my_role, ${PROJECT_DEPARTMENT_SQL}, ${MERGE_CHANGED_BY_SQL} FROM projects p JOIN project_members pm
         ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active' ORDER BY p.created_at`,
      [userId],
    )
  ).filter((p) => !department || p.department === department);
  return r.map((p) => toProjectDto(p, p.my_role));
}

export async function getProjectDetail(
  ctx: Ctx,
  userId: string,
  projectId: string,
): Promise<ProjectDetailResponse> {
  const p = await one(
    ctx.pool,
    `SELECT p.*, pm.role AS my_role, ${PROJECT_DEPARTMENT_SQL}, ${MERGE_CHANGED_BY_SQL} FROM projects p JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active' WHERE p.id = $2`,
    [userId, projectId],
  );
  if (!p) throw notFound('project not found');
  const repos = await rows(
    ctx.pool,
    'SELECT * FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name',
    [projectId],
  );
  const members = await rows(
    ctx.pool,
    `SELECT pm.*, u.display_name, u.email FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id=$1 AND pm.status <> 'removed' ORDER BY pm.role DESC, u.display_name`,
    [projectId],
  );
  const history = await rows(
    ctx.pool,
    `SELECT e.payload, e.created_at, u.display_name AS by_name FROM events e
       LEFT JOIN users u ON u.id = (e.payload->>'changedBy')::uuid
      WHERE e.type = 'ProjectMergePolicyChanged' AND e.project_id = $1 ORDER BY e.seq DESC LIMIT 20`,
    [projectId],
  );
  return {
    project: toProjectDto(p, p.my_role),
    repos: repos.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      remoteUrl: r.remote_url,
      remoteUrlNormalized: r.remote_url_normalized,
      workingBranch: r.working_branch,
      removedAt: iso(r.removed_at),
    })),
    members: members.map((m) => ({
      userId: m.user_id,
      displayName: m.display_name,
      email: m.email,
      role: m.role,
      status: m.status,
    })),
    mergePolicyHistory: history.map((h) => ({
      enabled: h.payload.mergeLargeWithoutApproval === true,
      byName: h.by_name ?? 'unknown',
      at: iso(h.created_at) as string,
    })),
  };
}

export async function workstationDtos(
  ctx: Ctx,
  where: string,
  params: unknown[],
): Promise<Array<WorkstationDto & { ownerEmail: string }>> {
  const list = await rows(
    ctx.pool,
    `SELECT w.*, u.email AS owner_email,
            (SELECT a.id FROM agents a WHERE a.workstation_id = w.id AND a.is_devops AND a.status = 'active' LIMIT 1) AS devops_agent_id
       FROM workstations w JOIN users u ON u.id = w.user_id WHERE ${where} ORDER BY w.paired_at`,
    params,
  );
  const repos = await rows(
    ctx.pool,
    `SELECT workstation_id, project_repo_id, local_path, reported_at FROM workstation_repos WHERE workstation_id = ANY($1::uuid[])`,
    [list.map((w) => w.id)],
  );
  const running = await rows(
    ctx.pool,
    `SELECT workstation_id, count(*)::int AS n FROM shifts
      WHERE workstation_id = ANY($1::uuid[]) AND status <> 'ended' GROUP BY workstation_id`,
    [list.map((w) => w.id)],
  );
  return list.map((w) => ({
    id: w.id,
    userId: w.user_id,
    name: w.name,
    platform: w.platform,
    hostname: w.hostname,
    runnerVersion: w.runner_version,
    status: w.status,
    connected: w.connected && w.status === 'active',
    lastSeenAt: iso(w.last_seen_at),
    runtimes: w.runtimes,
    repos: repos
      .filter((r) => r.workstation_id === w.id)
      .map((r) => ({
        projectRepoId: r.project_repo_id,
        localPath: r.local_path,
        reportedAt: iso(r.reported_at) as string,
      })),
    pairedAt: iso(w.paired_at) as string,
    devopsAccess: w.devops_access,
    devopsAgentId: w.devops_agent_id ?? null,
    shifts: {
      running: running.find((r) => r.workstation_id === w.id)?.n ?? 0,
      limit: ctx.services.runners.isOnline(w.id) ? (ctx.services.runners.get(w.id)?.maxShifts ?? null) : null,
    },
    ownerEmail: w.owner_email,
  }));
}

export type RoleEntry = z.infer<typeof RoleCatalogueEntrySchema>;
