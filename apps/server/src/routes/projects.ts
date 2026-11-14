import {
  AccountScopeSchema,
  AddRepoRequestSchema,
  ConvertPreviewQuerySchema,
  ConvertProjectRequestSchema,
  CreateProjectRequestSchema,
  DeleteProjectRequestSchema,
  FullSuiteRequestSchema,
  IdParamsSchema,
  MarkFindingRequestSchema,
  PatchProjectRequestSchema,
  PatchRepoRequestSchema,
  PauseProjectRequestSchema,
  ProjectsQuerySchema,
  RankProjectsRequestSchema,
  RepoParamsSchema,
  SetArchitectSettingsRequestSchema,
  SetClaudeAccountRequestSchema,
  SetConcurrencyCapRequestSchema,
  SetE2eAreasRequestSchema,
  SetFullSuiteRequestSchema,
  SetManualQaRequestSchema,
  SetMergePolicyRequestSchema,
  SetOwnerApprovalRequestSchema,
  SetProjectMcpServersRequestSchema,
  SetProjectPolicyRequestSchema,
  SetProviderAccountRequestSchema,
  SetReferenceReposRequestSchema,
  SetRegressionLoopRequestSchema,
  SetReviewSettingsRequestSchema,
  SetStopLossRequestSchema,
  SetTestServicesRequestSchema,
  SetWorkingBranchRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg, requireOrgRole, requireUser } from '../auth/guards.ts';
import { loadVisibleProject, projectRole } from '../authz/scope.ts';
import { setArchitectSettings } from '../commands/architect.ts';
import { setRepoComponentRules, setRepoReleaseName } from '../commands/component-rules.ts';
import { cancelConversion, convertPreview, convertProject } from '../commands/convert.ts';
import { setRepoForge, setRepoMainBranch, setRepoProjectPath } from '../commands/forges.ts';
import { setRepoWorkingBranch } from '../commands/hygiene.ts';
import { requestFullSuite, setE2eAreas, setOwnerApprovalPolicy } from '../commands/lean-project.ts';
import { mcpServerCandidates, setProjectMcpServers } from '../commands/mcp-servers.ts';
import { setRepoPrOnly } from '../commands/pr-only.ts';
import {
  findingMarksForReplay,
  listPostedFindings,
  markFinding,
  reviewerPrecisionForProject,
} from '../commands/pr-review-marks.ts';
import { heldBackFindings, listPrReviews } from '../commands/pr-review-runs.ts';
import { pauseProject, resumeProject } from '../commands/project-pause.ts';
import {
  addRepo,
  archiveProject,
  createProject,
  deleteProject,
  projectImpact,
  rankProjects,
  recheckEnvironment,
  removeRepo,
  restoreProject,
  retryRepoClone,
  setClaudeAccount,
  setConcurrencyCap,
  setFullSuite,
  setManualQa,
  setMergePolicy,
  setProjectPolicy,
  setProviderAccount,
  setReferenceRepos,
  setRegressionLoop,
  setReviewSettings,
  setStopLoss,
  setTestServices,
  updateProject,
} from '../commands/projects.ts';
import { requestReleasePr } from '../commands/release-pr.ts';
import { setRepoAccessMethod } from '../commands/repo-access.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { gone, notFound } from '../errors.ts';
import { getProjectClaudeAccounts } from '../queries/claude-accounts.ts';
import { getProjectDetail, listProjects } from '../queries/misc.ts';
import { getProjectProviderAccounts } from '../queries/provider-accounts.ts';
import { requestReleaseProposal } from '../release/manual.ts';
import { typed } from './util.ts';

const ProviderAccountParamsSchema = z.object({ id: z.uuid(), scope: AccountScopeSchema });

export function projectRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects', { schema: { querystring: ProjectsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { projects: await listProjects(ctx, s.user.id, req.query.department, req.query.status) };
    });

    app.post('/api/projects', { schema: { body: CreateProjectRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      const s = a.session;
      const id = await createProject(ctx, s.user, { id: a.orgId, role: a.role }, req.body);
      reply.code(201);
      return getProjectDetail(ctx, s.user.id, id);
    });

    /** Orders the organization's active projects, most important first (Owner and Admins). */
    app.put('/api/projects/ranking', { schema: { body: RankProjectsRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      await rankProjects(ctx, a.session.user, { id: a.orgId, role: a.role }, req.body.projectIds);
      return { projects: await listProjects(ctx, a.session.user.id) };
    });

    app.get('/api/projects/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    /** The recorded pull requests of a PR-only project with their review state (read-only). */
    app.get('/api/projects/:id/pull-requests', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await loadVisibleProject(ctx.pool, s.user.id, req.params.id);
      return { pullRequests: await listPrReviews(ctx.pool, req.params.id) };
    });

    /** The findings the cap held back on a pull request's latest review, on request (not posted to the pull request). */
    app.get('/api/pr-reviews/:id/held-back', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const pr = await one(ctx.pool, 'SELECT project_id FROM pr_reviews WHERE id=$1', [req.params.id]);
      if (!pr) throw notFound('pull request not found');
      await loadVisibleProject(ctx.pool, s.user.id, pr.project_id as string);
      const out = await heldBackFindings(ctx.pool, req.params.id);
      if (!out) throw notFound('pull request not found');
      return out;
    });

    /** The posted findings of a pull request. The reviewer is left out of a finding until it is marked. */
    app.get('/api/pr-reviews/:id/findings', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const pr = await one(ctx.pool, 'SELECT project_id FROM pr_reviews WHERE id=$1', [req.params.id]);
      if (!pr) throw notFound('pull request not found');
      await loadVisibleProject(ctx.pool, s.user.id, pr.project_id as string);
      const role = await projectRole(ctx.pool, s.user.id, pr.project_id as string);
      return { findings: await listPostedFindings(ctx.pool, req.params.id, { canMark: role === 'owner' }) };
    });

    /** The owner marks a posted finding useful or noise (changeable). */
    app.put(
      '/api/pr-review-findings/:id/mark',
      { schema: { params: IdParamsSchema, body: MarkFindingRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return markFinding(ctx, s.user, req.params.id, req.body);
      },
    );

    /** Useful findings out of posted findings per reviewer. */
    app.get('/api/projects/:id/reviewer-precision', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await loadVisibleProject(ctx.pool, s.user.id, req.params.id);
      return { reviewers: await reviewerPrecisionForProject(ctx.pool, req.params.id) };
    });

    /** Marked findings with reviewer, PR and mark: the input to the 20-PR replay. */
    app.get(
      '/api/projects/:id/pr-review-marks',
      {
        schema: {
          params: IdParamsSchema,
          querystring: z.object({
            since: z.iso.datetime({ offset: true }).optional(),
            reviewer: z.string().max(40).optional(),
          }),
        },
      },
      async (req) => {
        const s = await requireUser(ctx, req);
        await loadVisibleProject(ctx.pool, s.user.id, req.params.id);
        const q = req.query as { since?: string; reviewer?: string };
        return { marks: await findingMarksForReplay(ctx.pool, req.params.id, q) };
      },
    );

    app.patch(
      '/api/projects/:id',
      { schema: { params: IdParamsSchema, body: PatchProjectRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await updateProject(ctx, s.user, req.params.id, req.body);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** What converting to a workflow would do: the open cards that need a decision, the repositories needed. */
    app.get(
      '/api/projects/:id/convert-preview',
      { schema: { params: IdParamsSchema, querystring: ConvertPreviewQuerySchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return convertPreview(ctx, s.user, req.params.id, req.query.toWorkflowKey);
      },
    );

    /** Converts the project to another workflow (Owner and Admins); see `commands/convert.ts`. */
    app.post(
      '/api/projects/:id/convert',
      { schema: { params: IdParamsSchema, body: ConvertProjectRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const result = await convertProject(ctx, s.user, req.params.id, req.body);
        return { ...result, ...(await getProjectDetail(ctx, s.user.id, req.params.id)) };
      },
    );

    /** Cancels a conversion that waits for its new repositories. */
    app.delete('/api/projects/:id/convert', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await cancelConversion(ctx, s.user, req.params.id);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    app.get('/api/projects/:id/impact', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return projectImpact(ctx, s.user, req.params.id);
    });

    app.post('/api/projects/:id/archive', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await archiveProject(ctx, s.user, req.params.id);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    app.post('/api/projects/:id/restore', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await restoreProject(ctx, s.user, req.params.id);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    /** Manual pause (organization Owner and Admins): nothing new starts until one resumes it; idempotent. */
    app.post(
      '/api/projects/:id/pause',
      { schema: { params: IdParamsSchema, body: PauseProjectRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await pauseProject(ctx, s.user, req.params.id, req.body.reason);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post('/api/projects/:id/resume', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await resumeProject(ctx, s.user, req.params.id);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    app.post(
      '/api/projects/:id/delete',
      { schema: { params: IdParamsSchema, body: DeleteProjectRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await deleteProject(ctx, s.user, req.params.id, req.body.confirmKey);
        return { ok: true };
      },
    );

    app.put(
      '/api/projects/:id/merge-policy',
      { schema: { params: IdParamsSchema, body: SetMergePolicyRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setMergePolicy(ctx, s.user, req.params.id, req.body.mergeLargeWithoutApproval);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** Lean Team v3 project policy: decisions stay at project scope; test without a test environment. */
    app.put(
      '/api/projects/:id/policy',
      { schema: { params: IdParamsSchema, body: SetProjectPolicyRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setProjectPolicy(ctx, a.session.user, { id: a.orgId, role: a.role }, req.params.id, req.body);
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    /** lean team: when the owner approves a card after the review; the mapping of changed paths to E2E specs. */
    app.put(
      '/api/projects/:id/owner-approval',
      { schema: { params: IdParamsSchema, body: SetOwnerApprovalRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setOwnerApprovalPolicy(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.body.policy,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    app.put(
      '/api/projects/:id/e2e-areas',
      { schema: { params: IdParamsSchema, body: SetE2eAreasRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setE2eAreas(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.body.mapping,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    /**
     * Removed: the lean team flow is `code` version 6, which every project on `code` starts its new cards on (the newest
     * version, like code v3 to v5), so there is nothing to opt in to. 410 so an old client sees why.
     */
    app.post('/api/projects/:id/upgrade-workflow', { schema: { params: IdParamsSchema } }, async (req) => {
      await requireOrg(ctx, req);
      throw gone(
        'workflow_upgrade_removed',
        'new cards of a code project run the newest code workflow automatically',
      );
    });

    /** The manual full E2E suite run (the automatic run after every merge is off in the lean team flow). */
    app.post(
      '/api/projects/:id/full-suite',
      { schema: { params: IdParamsSchema, body: FullSuiteRequestSchema.optional() } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestFullSuite(ctx, s.user, req.params.id, { repoId: req.body?.repoId });
        ctx.services.dispatcher.trigger();
        reply.code(201);
        return r;
      },
    );

    app.put(
      '/api/projects/:id/full-suite',
      { schema: { params: IdParamsSchema, body: SetFullSuiteRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setFullSuite(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.body.enabled,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    app.put(
      '/api/projects/:id/regression-loop',
      { schema: { params: IdParamsSchema, body: SetRegressionLoopRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setRegressionLoop(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.body.enabled,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    /** The Claude account the project's tickets run on (docs/design/claude-accounts.md). */
    app.put(
      '/api/projects/:id/claude-account',
      { schema: { params: IdParamsSchema, body: SetClaudeAccountRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setClaudeAccount(ctx, a.session.user, { id: a.orgId, role: a.role }, req.params.id, req.body);
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    /** The account for another provider or runtime (S-A): Codex, the Gemini CLI, or a provider key; `claude-code` maps to the route above. */
    app.put(
      '/api/projects/:id/provider-accounts/:scope',
      { schema: { params: ProviderAccountParamsSchema, body: SetProviderAccountRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setProviderAccount(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.params.scope,
          req.body,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    app.get(
      '/api/projects/:id/provider-accounts/:scope',
      { schema: { params: ProviderAccountParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return getProjectProviderAccounts(ctx, s.user.id, req.params.id, req.params.scope);
      },
    );

    app.get('/api/projects/:id/claude-accounts', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getProjectClaudeAccounts(ctx, s.user.id, req.params.id);
    });

    /** Manual QA after Finalize (default on): the person who started a card tests it before it is done. */
    app.put(
      '/api/projects/:id/manual-qa',
      { schema: { params: IdParamsSchema, body: SetManualQaRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setManualQa(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.body.enabled,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    /** Local test services (loopback host and port) that build, review and test shifts may reach. */
    app.put(
      '/api/projects/:id/test-services',
      { schema: { params: IdParamsSchema, body: SetTestServicesRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setTestServices(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.body.services,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    /** Investigate & design before build, merging the latest main first, the architect's report location. */
    app.put(
      '/api/projects/:id/architect-settings',
      { schema: { params: IdParamsSchema, body: SetArchitectSettingsRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await setArchitectSettings(
          ctx,
          a.session.user,
          { id: a.orgId, role: a.role },
          req.params.id,
          req.body,
        );
        return getProjectDetail(ctx, a.session.user.id, req.params.id);
      },
    );

    /** The plugin MCP servers the caller's own workstations report (names for the role builder's picker). */
    app.get('/api/mcp-servers', async (req) => {
      const a = await requireOrgRole(ctx, req, 'member');
      return { servers: await mcpServerCandidates(ctx.pool, a.session.user.id, a.orgId) };
    });

    /** Plugin MCP servers the project's agents may use (the organization's Owner only). */
    app.put(
      '/api/projects/:id/mcp-servers',
      { schema: { params: IdParamsSchema, body: SetProjectMcpServersRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setProjectMcpServers(ctx, s.user, req.params.id, req.body.servers);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** Reference repositories: other repositories this project's agents may read, read-only (project owner). */
    app.put(
      '/api/projects/:id/reference-repos',
      { schema: { params: IdParamsSchema, body: SetReferenceReposRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setReferenceRepos(ctx, s.user, req.params.id, req.body.repoIds, req.body.workstationRepos);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.put(
      '/api/projects/:id/stop-loss',
      { schema: { params: IdParamsSchema, body: SetStopLossRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setStopLoss(ctx, s.user, req.params.id, req.body.settings);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** Review settings (size budget, unit, path-to-risk map): project owner only, whole value, null = not set. */
    app.put(
      '/api/projects/:id/review-settings',
      { schema: { params: IdParamsSchema, body: SetReviewSettingsRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setReviewSettings(ctx, s.user, req.params.id, req.body);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.put(
      '/api/projects/:id/concurrency-cap',
      { schema: { params: IdParamsSchema, body: SetConcurrencyCapRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setConcurrencyCap(ctx, s.user, req.params.id, req.body.cap);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/projects/:id/repos',
      { schema: { params: IdParamsSchema, body: AddRepoRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await addRepo(ctx, s.user, req.params.id, req.body);
        reply.code(201);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** The manager confirms (or changes) the repository's working branch. */
    app.put(
      '/api/projects/:id/repos/:repoId/working-branch',
      { schema: { params: RepoParamsSchema, body: SetWorkingBranchRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setRepoWorkingBranch(ctx, s.user, req.params.id, req.params.repoId, req.body.branch);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /**
     * Opens a pull request from the repository's working branch to its main branch (the runner does it through the
     * forge). The answer shows up as `releasePr` on the repository in the project detail.
     */
    app.post(
      '/api/projects/:id/repos/:repoId/release-pr',
      { schema: { params: RepoParamsSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const out = await requestReleasePr(ctx, s.user, req.params.id, req.params.repoId);
        reply.code(202);
        return out;
      },
    );

    /**
     * "Prepare release" (and "Refresh" on the Ship release item): a workstation reads the repository (read-only) and the
     * proposal is prepared or refreshed. Owner only. 202 with the request, or 409 with the reason nothing was asked.
     */
    app.post(
      '/api/projects/:id/repos/:repoId/release-proposal',
      { schema: { params: RepoParamsSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const out = await requestReleaseProposal(ctx, s.user, req.params.id, req.params.repoId);
        reply.code(202);
        return out;
      },
    );

    /**
     * A repository's settings: git provider (the manual choice, or `null` to detect it again), project path, access
     * method, main branch, component rules, release name and PR-only review (owner only).
     */
    app.patch(
      '/api/projects/:id/repos/:repoId',
      { schema: { params: RepoParamsSchema, body: PatchRepoRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        if (req.body.forge !== undefined)
          await setRepoForge(ctx, s.user, req.params.id, req.params.repoId, req.body.forge);
        if (req.body.accessMethod !== undefined)
          await setRepoAccessMethod(ctx, s.user, req.params.id, req.params.repoId, req.body.accessMethod);
        if (req.body.projectPath !== undefined)
          await setRepoProjectPath(ctx, s.user, req.params.id, req.params.repoId, req.body.projectPath);
        if (req.body.mainBranch !== undefined)
          await setRepoMainBranch(ctx, s.user, req.params.id, req.params.repoId, req.body.mainBranch);
        if (req.body.componentRules !== undefined)
          await setRepoComponentRules(ctx, s.user, req.params.id, req.params.repoId, req.body.componentRules);
        if (req.body.releaseName !== undefined)
          await setRepoReleaseName(ctx, s.user, req.params.id, req.params.repoId, req.body.releaseName);
        if (req.body.prOnly !== undefined)
          await setRepoPrOnly(ctx, s.user, req.params.id, req.params.repoId, req.body.prOnly);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** Try again to put the repository on the project's workstations (clone it, or create it). */
    app.post(
      '/api/projects/:id/repos/:repoId/setup',
      { schema: { params: RepoParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await retryRepoClone(ctx, s.user, req.params.id, req.params.repoId);
        return getProjectDetail(ctx, s.user.id, req.params.id);
      },
    );

    /** Check the development environment (toolchain) of the project on its workstations again. */
    app.post('/api/projects/:id/environment/check', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await recheckEnvironment(ctx, s.user, req.params.id);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });

    app.delete('/api/projects/:id/repos/:repoId', { schema: { params: RepoParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await removeRepo(ctx, s.user, req.params.id, req.params.repoId);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });
  };
}
