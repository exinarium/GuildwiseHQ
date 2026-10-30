import {
  ChangeDocumentStatusRequestSchema,
  CreateDocumentRequestSchema,
  DocumentTagCountDtoSchema,
  ListDocumentsQuerySchema,
  MAX_ATTACHMENT_BYTES,
  parseDocumentTagList,
  SaveDocumentVersionRequestSchema,
  SetDocumentTagsRequestSchema,
  UploadDocumentQuerySchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  changeDocumentStatus,
  createDocument,
  getDocument,
  getDocumentVersion,
  listDocuments,
  listDocumentTags,
  readDocumentFile,
  readDocumentFileForRunner,
  saveDocumentVersion,
  setDocumentTags,
  uploadDocument,
} from '../commands/documents.ts';
import type { Ctx } from '../context.ts';
import { badRequest } from '../errors.ts';
import { runnerOf, serveAttachment } from './card-attachments.ts';
import { typed } from './util.ts';

const BODY_LIMIT = MAX_ATTACHMENT_BYTES + 64 * 1024;

const DocParams = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) });

/** Briefs, PRDs, minutes and session logs: drafted on the server, published to the vault when approved. */
export function documentRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post('/api/documents', { schema: { body: CreateDocumentRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      reply.code(201);
      return { document: await createDocument(ctx, whoOf(a), req.body) };
    });

    app.get('/api/documents', { schema: { querystring: ListDocumentsQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { documents: await listDocuments(ctx, whoOf(a), req.query) };
    });

    app.get('/api/documents/:id', { schema: { params: DocParams } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { document: await getDocument(ctx, whoOf(a), req.params.id) };
    });

    app.get('/api/documents/:id/versions/:version', { schema: { params: VersionParams } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { version: await getDocumentVersion(ctx, whoOf(a), req.params.id, req.params.version) };
    });

    app.post(
      '/api/documents/:id/versions',
      { schema: { params: DocParams, body: SaveDocumentVersionRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        reply.code(201);
        return { document: await saveDocumentVersion(ctx, whoOf(a), req.params.id, req.body) };
      },
    );

    app.post(
      '/api/documents/:id/status',
      { schema: { params: DocParams, body: ChangeDocumentStatusRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { document: await changeDocumentStatus(ctx, whoOf(a), req.params.id, req.body) };
      },
    );

    app.get('/api/documents/tags', async (req) => {
      const a = await requireOrg(ctx, req);
      return { tags: (await listDocumentTags(ctx, whoOf(a))).map((t) => DocumentTagCountDtoSchema.parse(t)) };
    });

    app.put(
      '/api/documents/:id/tags',
      { schema: { params: DocParams, body: SetDocumentTagsRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { document: await setDocumentTags(ctx, whoOf(a), req.params.id, req.body) };
      },
    );

    // Files travel as the raw request body (any content type): the routes of this plugin only.
    await fastify.register(async (inner) => {
      inner.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) =>
        done(null, body),
      );
      const raw = typed(inner);

      raw.post(
        '/api/documents/upload',
        { schema: { querystring: UploadDocumentQuerySchema }, bodyLimit: BODY_LIMIT },
        async (req, reply) => {
          const a = await requireOrg(ctx, req);
          if (!Buffer.isBuffer(req.body))
            throw badRequest('file_required', 'send the file as the request body');
          const { name, projectId, kind, title, tags } = req.query;
          const document = await uploadDocument(ctx, whoOf(a), {
            name,
            bytes: req.body,
            projectId,
            kind,
            title,
            tags: parseDocumentTagList(tags),
          });
          reply.code(201);
          return { document };
        },
      );

      raw.get(
        '/api/documents/:id/file',
        { schema: { params: DocParams, querystring: z.object({ download: z.string().optional() }) } },
        async (req, reply) => {
          const a = await requireOrg(ctx, req);
          const file = await readDocumentFile(ctx, whoOf(a), req.params.id);
          return serveAttachment(reply, file, req.query.download !== undefined);
        },
      );

      // The runner (Bearer runner token) fetches the bytes of a file it was told to write to a vault.
      raw.get('/api/runner/document-files/:id', { schema: { params: DocParams } }, async (req, reply) => {
        const { workstationId } = await runnerOf(ctx, req);
        const data = await readDocumentFileForRunner(ctx, workstationId, req.params.id);
        return reply.header('content-type', 'application/octet-stream').send(data);
      });
    });
  };
}
