import {
  AddRepoRequestSchema,
  CreateProjectRequestSchema,
  DeleteProjectRequestSchema,
  IdParamsSchema,
  PatchProjectRequestSchema,
  ProjectsQuerySchema,
  RepoParamsSchema,
  SetMergePolicyRequestSchema,
  SetWorkingBranchRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { setRepoWorkingBranch } from '../commands/hygiene.ts';
import {
  addRepo,
  archiveProject,
  createProject,
  deleteProject,
  projectImpact,
  removeRepo,
  restoreProject,
  setMergePolicy,
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

    app.delete('/api/projects/:id/repos/:repoId', { schema: { params: RepoParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await removeRepo(ctx, s.user, req.params.id, req.params.repoId);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });
  };
}
