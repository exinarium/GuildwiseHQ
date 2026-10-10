import {
  CloudWorkstationListSchema,
  CloudWorkstationSchema,
  ConnectGithubRequestSchema,
  CreateCodespaceRequestSchema,
  CreateVpsRequestSchema,
  DevcontainerQuerySchema,
  devcontainerText,
  GithubConnectionSchema,
  IdParamsSchema,
  PatchCloudWorkstationRequestSchema,
  RunnerEnrollRequestSchema,
  RunnerPairResponseSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrgRole } from '../auth/guards.ts';
import { codespacesBootstrapScript } from '../cloud/bootstrap.ts';
import {
  codespaceMachines,
  connectGithub,
  createCodespace,
  createVps,
  disconnectGithub,
  enrollCodespace,
  getCloud,
  githubConnection,
  listCloud,
  patchCloud,
  removeCloud,
  stop,
  wake,
} from '../cloud/service.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/**
 * Cloud workstations (docs/RUNNER.md "Cloud workstations"). Organization Owners and Admins manage them; SSH
 * credentials in a request are used for the install and dropped, never stored or logged.
 */
export function cloudRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const admin = (req: Parameters<typeof requireOrgRole>[1]) => requireOrgRole(ctx, req, 'admin');

    app.get('/api/cloud-workstations', async (req) => {
      const a = await requireOrgRole(ctx, req, 'member');
      return CloudWorkstationListSchema.parse(await listCloud(ctx, a.orgId));
    });

    app.post(
      '/api/cloud-workstations/vps',
      {
        schema: { body: CreateVpsRequestSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const a = await admin(req);
        reply.code(201);
        return CloudWorkstationSchema.parse(await createVps(ctx, a.session.user, a.orgId, req.body));
      },
    );

    app.get('/api/cloud-workstations/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrgRole(ctx, req, 'member');
      return CloudWorkstationSchema.parse(await getCloud(ctx, a.orgId, req.params.id));
    });

    app.patch(
      '/api/cloud-workstations/:id',
      { schema: { params: IdParamsSchema, body: PatchCloudWorkstationRequestSchema } },
      async (req) => {
        const a = await admin(req);
        return CloudWorkstationSchema.parse(await patchCloud(ctx, a.orgId, req.params.id, req.body));
      },
    );

    app.post('/api/cloud-workstations/:id/wake', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await admin(req);
      return CloudWorkstationSchema.parse(await wake(ctx, a.orgId, req.params.id));
    });

    app.post('/api/cloud-workstations/:id/stop', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await admin(req);
      return CloudWorkstationSchema.parse(await stop(ctx, a.orgId, req.params.id));
    });

    app.delete('/api/cloud-workstations/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await admin(req);
      await removeCloud(ctx, a.orgId, req.params.id);
      return { ok: true };
    });

    // ---- GitHub Codespaces
    app.get('/api/cloud-workstations/github/connection', async (req) => {
      const a = await admin(req);
      return GithubConnectionSchema.parse(await githubConnection(ctx, a.session.user.id));
    });

    app.post(
      '/api/cloud-workstations/github/connect',
      {
        schema: { body: ConnectGithubRequestSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req) => {
        const a = await admin(req);
        const { login } = await connectGithub(ctx, a.session.user, req.body.token);
        return GithubConnectionSchema.parse({ connected: true, login });
      },
    );

    app.delete('/api/cloud-workstations/github/connection', async (req) => {
      const a = await admin(req);
      await disconnectGithub(ctx, a.session.user.id);
      return { ok: true };
    });

    app.get(
      '/api/cloud-workstations/github/machines',
      { schema: { querystring: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }) } },
      async (req) => {
        const a = await admin(req);
        return { machines: await codespaceMachines(ctx, a.session.user, req.query.repo) };
      },
    );

    app.post(
      '/api/cloud-workstations/codespaces',
      {
        schema: { body: CreateCodespaceRequestSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const a = await admin(req);
        reply.code(201);
        return CloudWorkstationSchema.parse(await createCodespace(ctx, a.session.user, a.orgId, req.body));
      },
    );

    /** The devcontainer.json for a Codespace (stacks come from `aom-runner devcontainer` or the user's pick). */
    app.get(
      '/api/cloud-workstations/devcontainer',
      { schema: { querystring: DevcontainerQuerySchema } },
      async (req) => {
        await admin(req);
        const stacks = req.query.stacks
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^[a-z0-9-]{1,30}$/.test(s))
          .map((id) => ({ id }));
        return {
          path: '.devcontainer/guildwise/devcontainer.json',
          content: devcontainerText({
            name: req.query.name,
            serverUrl: ctx.config.publicOrigin,
            stacks,
          }),
        };
      },
    );

    // ---- runner side (unauthenticated: the codespace's own proof is the credential)
    app.post(
      '/api/runner/enroll',
      {
        schema: { body: RunnerEnrollRequestSchema },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (req) => RunnerPairResponseSchema.parse(await enrollCodespace(ctx, req.body)),
    );

    app.get('/api/runner/codespaces-bootstrap.sh', async (_req, reply) =>
      reply
        .type('text/x-shellscript; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(codespacesBootstrapScript(ctx.config.publicOrigin)),
    );
  };
}
