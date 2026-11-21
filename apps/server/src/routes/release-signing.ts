import {
  IdParamsSchema,
  ReleaseSignatureUploadRequestSchema,
  ReleaseSigningManifestQuerySchema,
  ReleaseSigningPrepareRequestSchema,
  ReleaseSigningSignRequestSchema,
  ReleaseSigningStatusQuerySchema,
  SetDeployTargetSigningRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { requireStepUp } from '../auth/step-up.ts';
import type { Ctx } from '../context.ts';
import {
  prepareReleaseArtefact,
  releaseManifest,
  releaseSigningStatus,
  requestWorkstationSignature,
  setTargetSigning,
  uploadReleaseSignature,
} from '../release/signing.ts';
import { typed } from './util.ts';

/**
 * Release signing per deploy target (R30): the key a target trusts (project Owner, step-up), where each target of an
 * environment stands for a release, packaging the runner for a target, and the two signing routes (the workstation holding
 * the key under a local approval, or an offline signature uploaded here). No route ever takes or returns a secret key.
 */
export function releaseSigningRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.put(
      '/api/deploy-targets/:id/signing',
      { schema: { params: IdParamsSchema, body: SetDeployTargetSigningRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        requireStepUp(ctx, s);
        return { signing: await setTargetSigning(ctx, s.user, req.params.id, req.body) };
      },
    );

    app.get(
      '/api/projects/:id/release-signing',
      { schema: { params: IdParamsSchema, querystring: ReleaseSigningStatusQuerySchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return releaseSigningStatus(ctx, s.user, req.params.id, req.query.env, req.query.commit ?? null);
      },
    );

    app.post(
      '/api/projects/:id/release-signing/prepare',
      { schema: { params: IdParamsSchema, body: ReleaseSigningPrepareRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return prepareReleaseArtefact(ctx, s.user, req.params.id, req.body);
      },
    );

    app.post(
      '/api/projects/:id/release-signing/sign',
      { schema: { params: IdParamsSchema, body: ReleaseSigningSignRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return requestWorkstationSignature(ctx, s.user, req.params.id, req.body);
      },
    );

    app.get(
      '/api/projects/:id/release-signing/manifest',
      { schema: { params: IdParamsSchema, querystring: ReleaseSigningManifestQuerySchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const m = await releaseManifest(ctx, s.user, req.params.id, req.query.releaseId, req.query.targetId);
        return reply
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-disposition', 'attachment; filename="manifest.json"')
          .header('x-artefact-sha256', m.sha256)
          .send(m.manifest);
      },
    );

    app.post(
      '/api/projects/:id/release-signing/signature',
      { schema: { params: IdParamsSchema, body: ReleaseSignatureUploadRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return uploadReleaseSignature(ctx, s.user, req.params.id, req.body);
      },
    );
  };
}
