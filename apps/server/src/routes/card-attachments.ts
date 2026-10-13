import {
  CardAttachmentDtoSchema,
  CardAttachmentsResponseSchema,
  MAX_ATTACHMENT_BYTES,
  RUNNER_TOKEN_PREFIX,
} from '@aom/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import {
  attachmentListing,
  completeUpload,
  readAttachment,
  readAttachmentForShift,
  removeAttachment,
  uploadAttachment,
} from '../commands/card-attachments.ts';
import type { Ctx } from '../context.ts';
import { sha256Hex } from '../crypto.ts';
import { one } from '../db/sql.ts';
import { badRequest, forbidden, unauthorized } from '../errors.ts';
import { promoteRotatedToken } from '../runner-gateway/rotation.ts';
import { typed } from './util.ts';

const BODY_LIMIT = MAX_ATTACHMENT_BYTES + 64 * 1024;
const AttachmentParams = z.object({ id: z.string().min(1), attachmentId: z.uuid() });
const CardParam = z.object({ id: z.string().min(1) });

/**
 * What a browser may do with a served attachment. The file is untrusted: it is never executed in the app's origin
 * (`sandbox` in the CSP: no scripts, an opaque origin), never sniffed (`nosniff`), and only images are shown inline;
 * SVG is an image here (an `<img>` never runs its script) and a direct visit is sandboxed by the CSP.
 */
export function serveAttachment(
  reply: FastifyReply,
  file: { name: string; contentType: string; data: Buffer },
  download: boolean,
): FastifyReply {
  const inline = !download && /^image\//.test(file.contentType);
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return reply
    .header('content-type', file.contentType)
    .header(
      'content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    )
    .header(
      'content-security-policy',
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    )
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, max-age=300')
    .header('cross-origin-resource-policy', 'same-origin')
    .send(file.data);
}

/** The workstation a runner request belongs to (`Authorization: Bearer aomr_...`, the token of the WebSocket). */
async function runnerOf(ctx: Ctx, req: FastifyRequest): Promise<{ workstationId: string }> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token || !token.startsWith(RUNNER_TOKEN_PREFIX)) throw unauthorized();
  const ws =
    (await one(ctx.pool, 'SELECT id, user_id, status FROM workstations WHERE token_hash=$1', [
      sha256Hex(token),
    ])) ?? (await promoteRotatedToken(ctx, token));
  if (!ws) throw unauthorized();
  if (ws.status !== 'active') throw forbidden('this workstation was unpaired');
  return { workstationId: ws.id };
}

export function cardAttachmentRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    // Files arrive as the raw body (any content type): this plugin's routes only.
    fastify.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) =>
      done(null, body),
    );
    const app = typed(fastify);

    app.get('/api/cards/:id/attachments', { schema: { params: CardParam } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { card } = await loadVisibleCard(ctx.pool, s.user.id, req.params.id);
      return CardAttachmentsResponseSchema.parse(await attachmentListing(ctx.pool, card.id));
    });

    app.post(
      '/api/cards/:id/attachments',
      {
        schema: { params: CardParam, querystring: z.object({ name: z.string().min(1).max(500) }) },
        bodyLimit: BODY_LIMIT,
      },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        if (!Buffer.isBuffer(req.body))
          throw badRequest('file_required', 'send the file as the request body');
        const dto = await uploadAttachment(ctx, s.user, req.params.id, req.query.name, req.body);
        reply.code(201);
        return CardAttachmentDtoSchema.parse(dto);
      },
    );

    app.get(
      '/api/cards/:id/attachments/:attachmentId',
      { schema: { params: AttachmentParams, querystring: z.object({ download: z.string().optional() }) } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const file = await readAttachment(ctx, s.user.id, req.params.id, req.params.attachmentId);
        return serveAttachment(reply, file, req.query.download !== undefined);
      },
    );

    app.delete(
      '/api/cards/:id/attachments/:attachmentId',
      { schema: { params: AttachmentParams } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await removeAttachment(ctx, s.user, req.params.id, req.params.attachmentId);
        return reply.code(204).send();
      },
    );

    // ---- the runner (Bearer runner token; the shift or the upload ticket says what it may reach)
    app.put(
      '/api/runner/uploads/:uploadId',
      { schema: { params: z.object({ uploadId: z.uuid() }) }, bodyLimit: BODY_LIMIT },
      async (req) => {
        const { workstationId } = await runnerOf(ctx, req);
        if (!Buffer.isBuffer(req.body))
          throw badRequest('file_required', 'send the file as the request body');
        return CardAttachmentDtoSchema.parse(
          await completeUpload(ctx, workstationId, req.params.uploadId, req.body),
        );
      },
    );

    app.get(
      '/api/runner/attachments/:attachmentId',
      {
        schema: { params: z.object({ attachmentId: z.uuid() }), querystring: z.object({ shift: z.uuid() }) },
      },
      async (req, reply) => {
        const { workstationId } = await runnerOf(ctx, req);
        const file = await readAttachmentForShift(
          ctx,
          workstationId,
          req.query.shift,
          req.params.attachmentId,
        );
        return reply.header('content-type', 'application/octet-stream').send(file.data);
      },
    );
  };
}
