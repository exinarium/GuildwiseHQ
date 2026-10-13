import {
  type BudgetDto,
  detectForgeKind,
  isOrgOperational,
  type ProjectDetailResponse,
  type ProjectDto,
  type RoleCatalogueEntrySchema,
  type WorkstationDto,
} from '@aom/shared';
import type { z } from 'zod';
import { orgRoleOf, orgSuspended } from '../auth/org-context.ts';
import { pendingConversionOf } from '../commands/convert.ts';
import { hygieneDtos } from '../commands/hygiene.ts';
import { mcpServerCandidates } from '../commands/mcp-servers.ts';
import type { Ctx } from '../context.ts';
import { budgetDto, canEditBudget, monthSpendByProject, orgCostCtx, seesAmounts } from '../costs/index.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { conflict, notFound } from '../errors.ts';
import { referenceRepoCandidates, referenceRepoDtos } from '../runner-gateway/read-repos.ts';
import {
  referenceWorkstationRepoDtos,
  type StoredWorkstationRepo,
  workstationRepoCandidates,
} from '../runner-gateway/workstation-repos.ts';

/** The department of a project's workflow (its type): the owner's own workflow first, else the built-in. */
export const PROJECT_DEPARTMENT_SQL = `(SELECT w.department FROM workflow_versions w
    WHERE w.key = p.workflow_key AND w.status = 'active' AND (w.org_id = p.org_id OR w.org_id IS NULL)
    ORDER BY (w.org_id IS NULL), w.version DESC LIMIT 1) AS department`;

/** Display name of whoever last changed the large-merge setting. */
const MERGE_CHANGED_BY_SQL = `(SELECT u.display_name FROM users u WHERE u.id = p.merge_large_changed_by) AS merge_large_changed_by_name`;

const HAS_VAULT_SQL = `EXISTS (SELECT 1 FROM vaults v WHERE v.project_id = p.id
  OR (v.org_id = p.org_id AND v.kind = 'org' AND v.project_id IS NULL)) AS has_vault`;

/** Published research notes of the project (the Research tab shows when there are some). */
const PUBLISHED_NOTES_SQL = `(SELECT count(*)::int FROM research_publications rp WHERE rp.project_id = p.id) AS published_notes`;

export function toProjectDto(p: Row, myRole: 'owner' | 'manager'): ProjectDto {
  return {
    id: p.id,
    orgId: p.org_id,
    orgName: p.org_name ?? '',
    key: p.key,
    name: p.name,
    workflowKey: p.workflow_key,
    department: p.department ?? null,
    rank: p.rank ?? null,
    branchPrefix: p.branch_prefix,
    workingBranch: p.working_branch,
    defaultCompletion: p.default_completion ?? 'merge',
    removeFinishedBranches: p.remove_finished_branches ?? true,
    prBranchPrefix: p.pr_branch_prefix ?? '',
    subCategories: p.sub_categories,
    vaultFolder: p.vault_folder,
    hasVault: p.has_vault ?? false,
    architecturalGlobs: p.architectural_globs,
    e2eGlobs: p.e2e_globs,
    status: p.status,
    mergeLargeWithoutApproval: p.merge_large_without_approval ?? false,
    mergeLargeChanged: p.merge_large_changed_at
      ? { byName: p.merge_large_changed_by_name ?? 'unknown', at: iso(p.merge_large_changed_at) as string }
      : null,
    maxConcurrentShifts: p.max_concurrent_shifts ?? null,
    fullSuiteAfterFinalize: p.full_suite_after_finalize ?? true,
    designStep: p.design_step ?? false,
    mergeMainFirst: p.merge_main_first ?? true,
    investigationPath: p.investigation_path ?? 'docs/investigations',
    investigationLocation: p.investigation_location ?? 'repo',
    createdAt: iso(p.created_at) as string,
    startedAs: p.started_as ?? p.workflow_key,
    convertedAt: iso(p.converted_at),
    publishedNotes: p.published_notes ?? 0,
    myRole,
  };
}

export async function listProjects(
  ctx: Ctx,
  userId: string,
  department?: string,
  status: 'active' | 'archived' | 'all' = 'active',
): Promise<ProjectDto[]> {
  const r = (
    await rows(
      ctx.pool,
      `SELECT p.*, pm.role AS my_role, o.name AS org_name, ${PROJECT_DEPARTMENT_SQL}, ${MERGE_CHANGED_BY_SQL}, ${PUBLISHED_NOTES_SQL}, ${HAS_VAULT_SQL}
         FROM projects p JOIN project_members pm
         ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
         LEFT JOIN organizations o ON o.id = p.org_id
        WHERE ($2 = 'all' OR p.status = $2) AND p.kind = 'project'
          AND (o.id IS NULL OR o.status IN ('trial','active') OR o.owner_user_id = $1)
        ORDER BY p.org_id, p.rank NULLS LAST, p.created_at`,
      [userId, status],
    )
  ).filter((p) => !department || p.department === department);
  const budgets = await budgetsFor(ctx, userId, r);
  return r.map((p) => ({ ...toProjectDto(p, p.my_role), budget: budgets.get(p.id) as BudgetDto }));
}

/** The budget block (state, amounts for org members, the reset time) of each project row, one query per organization. */
export async function budgetsFor(ctx: Ctx, userId: string, projects: Row[]): Promise<Map<string, BudgetDto>> {
  const out = new Map<string, BudgetDto>();
  const now = ctx.clock.now();
  for (const orgId of new Set(projects.map((p) => p.org_id as string))) {
    const role = await orgRoleOf(ctx.pool, userId, orgId);
    const c = await orgCostCtx(ctx.pool, orgId);
    const mine = projects.filter((p) => p.org_id === orgId);
    const spend = mine.some((p) => p.budget_micros !== null && p.budget_micros !== undefined)
      ? await monthSpendByProject(
          ctx.pool,
          c,
          now,
          mine.map((p) => p.id),
        )
      : new Map<string, number>();
    for (const p of mine)
      out.set(
        p.id,
        budgetDto(p, spend.get(p.id) ?? 0, c, now, {
          canEdit: canEditBudget(role),
          showAmounts: seesAmounts(role),
        }),
      );
  }
  return out;
}

/** The last "pull request from the working branch to the main branch" asked for a repository, as the settings show it. */
function releasePrOf(r: Record<string, any> | undefined) {
  if (!r) return null;
  return {
    state: r.state as 'pending' | 'opened' | 'nothing' | 'failed',
    url: (r.url as string | null) ?? null,
    message: (r.message as string | null) ?? null,
    at: iso(r.updated_at) as string,
  };
}

export async function getProjectDetail(
  ctx: Ctx,
  userId: string,
  projectId: string,
): Promise<ProjectDetailResponse> {
  const p = await one(
    ctx.pool,
    `SELECT p.*, pm.role AS my_role, o.name AS org_name, o.status AS org_status, o.owner_user_id AS org_owner,
            ${PROJECT_DEPARTMENT_SQL}, ${MERGE_CHANGED_BY_SQL}, ${PUBLISHED_NOTES_SQL}, ${HAS_VAULT_SQL} FROM projects p JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
       LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id = $2`,
    [userId, projectId],
  );
  if (!p) throw notFound('project not found');
  if (p.kind === 'interest')
    throw conflict('managed_by_interest', 'this is an interest: manage it on the Interests page');
  if (p.org_status && !isOrgOperational(p.org_status) && p.org_owner !== userId)
    throw orgSuspended({ name: p.org_name ?? 'The organization', status: p.org_status });
  const orgOwner = p.org_owner === userId;
  const repos = await rows(
    ctx.pool,
    'SELECT * FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name',
    [projectId],
  );
  const questions = await rows(
    ctx.pool,
    `SELECT id, data->>'repoId' AS repo_id FROM desk_items
      WHERE project_id=$1 AND subkind='working_branch' AND status='open' AND triage <> 'pending' ORDER BY created_at`,
    [projectId],
  );
  const prRequests = await rows(
    ctx.pool,
    `SELECT DISTINCT ON (repo_id) * FROM repo_pr_requests WHERE project_id=$1 ORDER BY repo_id, created_at DESC`,
    [projectId],
  );
  const clones = await rows(
    ctx.pool,
    `SELECT rc.*, w.name AS workstation_name FROM repo_clones rc JOIN workstations w ON w.id = rc.workstation_id
      WHERE rc.project_id=$1 AND w.status='active' ORDER BY w.name`,
    [projectId],
  );
  const envs = await rows(
    ctx.pool,
    `SELECT pe.*, w.name AS workstation_name FROM project_environments pe JOIN workstations w ON w.id = pe.workstation_id
      WHERE pe.project_id=$1 AND w.status='active' ORDER BY w.name`,
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
    project: {
      ...toProjectDto(p, p.my_role),
      pendingConversion: await pendingConversionOf(ctx.pool, p),
      budget: (await budgetsFor(ctx, userId, [p])).get(p.id) as BudgetDto,
    },
    repos: repos.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      remoteUrl: r.remote_url,
      remoteUrlNormalized: r.remote_url_normalized,
      workingBranch: r.working_branch,
      removedAt: iso(r.removed_at),
      projectPath: r.project_path ?? null,
      accessMethod: r.access_method ?? null,
      mainBranch: r.main_branch ?? null,
      workingBranchCreated: r.working_branch_created_at
        ? {
            at: iso(r.working_branch_created_at) as string,
            from: r.working_branch_created_from ?? '',
            pushed: r.working_branch_created_pushed ?? false,
          }
        : null,
      releasePr: releasePrOf(prRequests.find((q) => q.repo_id === r.id)),
      forge: r.forge_kind ?? detectForgeKind(r.remote_url),
      forgeOverride: r.forge_kind ?? null,
      knownBranches: r.known_branches ?? [],
      knownBranchesAt: iso(r.known_branches_at),
      workingBranchSetAt: iso(r.working_branch_set_at),
      branchQuestionId: questions.find((q) => q.repo_id === r.id)?.id ?? null,
      setup: clones
        .filter((c) => c.project_repo_id === r.id)
        .map((c) => ({
          workstationId: c.workstation_id,
          workstationName: c.workstation_name,
          state: c.state,
          detail: c.detail ?? null,
          localPath: c.local_path ?? null,
          updatedAt: iso(c.updated_at) as string,
        })),
    })),
    environments: envs.map((e) => ({
      workstationId: e.workstation_id,
      workstationName: e.workstation_name,
      state: e.state,
      summary: e.summary ?? null,
      report: e.report ?? null,
      updatedAt: iso(e.updated_at) as string,
    })),
    members: members.map((m) => ({
      userId: m.user_id,
      displayName: m.display_name,
      email: m.email,
      role: m.role,
      status: m.status,
    })),
    referenceRepos: await referenceRepoDtos(ctx.pool, projectId),
    referenceRepoCandidates:
      p.my_role === 'owner' ? await referenceRepoCandidates(ctx.pool, userId, p.org_id, projectId) : [],
    referenceWorkstationRepos: await referenceWorkstationRepoDtos(
      ctx.pool,
      (p.reference_workstation_repos ?? []) as StoredWorkstationRepo[],
    ),
    workstationRepoCandidates:
      p.my_role === 'owner' ? await workstationRepoCandidates(ctx.pool, userId, p.org_id) : [],
    mcpServers: (p.mcp_servers ?? []) as string[],
    canGrantMcpServers: orgOwner,
    mcpServerCandidates: orgOwner ? await mcpServerCandidates(ctx.pool, userId, p.org_id) : [],
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
  const hygiene = await hygieneDtos(ctx.pool, list as never);
  const keys = new Map<string, string>(
    (
      await rows(
        ctx.pool,
        'SELECT workstation_id, key_id FROM workstation_keys WHERE workstation_id = ANY($1::uuid[])',
        [list.map((w) => w.id)],
      )
    ).map((k) => [k.workstation_id as string, k.key_id as string]),
  );
  const rightsCmds = new Map<string, Row>(
    (
      await rows(
        ctx.pool,
        `SELECT DISTINCT ON (workstation_id) workstation_id, status, last_error, created_at FROM runner_commands
          WHERE type='rights.verify' AND workstation_id = ANY($1::uuid[])
          ORDER BY workstation_id, created_at DESC, id DESC`,
        [list.map((w) => w.id)],
      )
    ).map((c) => [c.workstation_id as string, c]),
  );
  const nowMs = ctx.clock.now().getTime();
  const rightsCheck = (w: Row) => {
    const c = rightsCmds.get(w.id);
    const requestedAt = c ? iso(c.created_at) : null;
    if (!keys.has(w.id))
      return {
        state: 'unsupported' as const,
        message: `This runner${w.runner_version ? ` (${w.runner_version})` : ''} is too old to check rights. Update the runner on the machine, then press Verify now.`,
        requestedAt,
      };
    if (!c || c.status === 'done') return { state: 'idle' as const, message: null, requestedAt };
    if (c.status === 'failed')
      return {
        state: 'failed' as const,
        message: c.last_error ?? 'The runner could not check the rights.',
        requestedAt,
      };
    if (nowMs - +c.created_at > RIGHTS_CHECK_TIMEOUT_MS)
      return {
        state: 'timed_out' as const,
        message:
          'The runner did not answer. It may be offline, busy, or too old to know this check; update it if the problem stays.',
        requestedAt,
      };
    return { state: 'checking' as const, message: null, requestedAt };
  };
  return list.map((w) => ({
    id: w.id,
    userId: w.user_id,
    name: w.name,
    platform: w.platform,
    hostname: w.hostname,
    runnerVersion: w.runner_version,
    runnerUpdate: w.runner_update ?? null,
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
    hygiene: hygiene.get(w.id),
    rights: w.devops_rights ? { ...w.devops_rights, stale: !!w.devops_rights_stale } : null,
    rightsCheck: rightsCheck(w),
    sudo: {
      keyId: keys.get(w.id) ?? null,
      passwordSet: !!w.devops_sudo_set_at,
      setAt: iso(w.devops_sudo_set_at),
      works: w.devops_sudo_works ?? null,
    },
    shifts: {
      running: running.find((r) => r.workstation_id === w.id)?.n ?? 0,
      limit: ctx.services.runners.isOnline(w.id) ? (ctx.services.runners.get(w.id)?.maxShifts ?? null) : null,
    },
    git: { connections: w.git_connections ?? [], checkedAt: iso(w.git_checked_at) },
    jira: { status: w.jira_status ?? null, checkedAt: iso(w.jira_checked_at) },
    orgFolders: {
      folders: w.org_folders ?? [],
      errors: w.org_folder_errors ?? {},
      candidates: w.org_folder_candidates ?? [],
      checkedAt: iso(w.org_folders_checked_at),
    },
    toolchains: { items: w.toolchains ?? [], checkedAt: iso(w.toolchains_checked_at) },
    ownerEmail: w.owner_email,
  }));
}

/** How long a rights check may wait for the runner before the page calls it unanswered. */
const RIGHTS_CHECK_TIMEOUT_MS = 60_000;

export type RoleEntry = z.infer<typeof RoleCatalogueEntrySchema>;
