import {
  AddRepoRequestSchema,
  CreateProjectRequestSchema,
  IdParamsSchema,
  PatchProjectRequestSchema,
  ProjectsQuerySchema,
  RepoParamsSchema,
  SetMergePolicyRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { addRepo, createProject, removeRepo, setMergePolicy, updateProject } from '../commands/projects.ts';
import type { Ctx } from '../context.ts';
import { getProjectDetail, listProjects } from '../queries/misc.ts';
import { typed } from './util.ts';

export function projectRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects', { schema: { querystring: ProjectsQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { projects: await listProjects(ctx, s.user.id, req.query.department) };
    });

    app.post('/api/projects', { schema: { body: CreateProjectRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await createProject(ctx, s.user, req.body);
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

    app.delete('/api/projects/:id/repos/:repoId', { schema: { params: RepoParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await removeRepo(ctx, s.user, req.params.id, req.params.repoId);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });
  };
}
