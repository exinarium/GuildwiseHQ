import {
  AddRepoRequestSchema,
  ConvertPreviewQuerySchema,
  ConvertProjectRequestSchema,
  CreateProjectRequestSchema,
  DeleteProjectRequestSchema,
  IdParamsSchema,
  PatchProjectRequestSchema,
  PatchRepoRequestSchema,
  ProjectsQuerySchema,
  RankProjectsRequestSchema,
  RepoParamsSchema,
  SetConcurrencyCapRequestSchema,
  SetFullSuiteRequestSchema,
  SetMergePolicyRequestSchema,
  SetReferenceReposRequestSchema,
  SetWorkingBranchRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { cancelConversion, convertPreview, convertProject } from '../commands/convert.ts';
import { setRepoForge, setRepoProjectPath } from '../commands/forges.ts';
import { setRepoWorkingBranch } from '../commands/hygiene.ts';
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
  setConcurrencyCap,
  setFullSuite,
  setMergePolicy,
  setReferenceRepos,
  updateProject,
} from '../commands/projects.ts';
import type { Ctx } from '../context.ts';
import { getProjectDetail, listProjects } from '../queries/misc.ts';
import { typed } from './util.ts';

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

    /** A repository's git provider (the manual choice, or `null` to detect it again) and/or the project path inside it. */
    app.patch(
      '/api/projects/:id/repos/:repoId',
      { schema: { params: RepoParamsSchema, body: PatchRepoRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        if (req.body.forge !== undefined)
          await setRepoForge(ctx, s.user, req.params.id, req.params.repoId, req.body.forge);
        if (req.body.projectPath !== undefined)
          await setRepoProjectPath(ctx, s.user, req.params.id, req.params.repoId, req.body.projectPath);
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
