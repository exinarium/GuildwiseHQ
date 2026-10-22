import {
  ChangeDocumentStatusRequestSchema,
  CreateDocumentRequestSchema,
  ListDocumentsQuerySchema,
  SaveDocumentVersionRequestSchema,
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
  saveDocumentVersion,
} from '../commands/documents.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

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
  };
}
