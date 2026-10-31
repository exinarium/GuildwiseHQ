import { z } from 'zod';
import {
  DOCUMENT_MAX_TAGS,
  DOCUMENT_TAG_MAX,
  DocumentKindSchema,
  DocumentStatusSchema,
} from '../documents/index.ts';
import { defineEvent, Id } from './define.ts';

/** Documents (stream `document-<docId>`; project scope when the document has a project, else org scope). */
export const documentEvents = [
  defineEvent(
    'DocumentCreated',
    z.object({
      docId: Id,
      orgId: Id,
      projectId: Id.optional(),
      kind: DocumentKindSchema,
      title: z.string().min(1).max(200),
      slug: z.string().min(1).max(60),
      createdBy: Id.nullable(),
      sourceThreadIds: z.array(Id).max(20).default([]),
      tags: z.array(z.string().max(DOCUMENT_TAG_MAX)).max(DOCUMENT_MAX_TAGS).optional(),
      /** An uploaded file (its bytes are operational, not in the event). */
      file: z
        .object({
          name: z.string().min(1).max(200),
          contentType: z.string().min(1).max(200),
          size: z.number().int().min(1),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .optional(),
    }),
  ),
  /** The whole set of tags (not a diff). */
  defineEvent(
    'DocumentTagsChanged',
    z.object({
      docId: Id,
      tags: z.array(z.string().max(DOCUMENT_TAG_MAX)).max(DOCUMENT_MAX_TAGS),
      by: Id.nullable(),
    }),
  ),
  /** A new version. `version` is assigned by the server (current + 1); the content is the whole document. */
  defineEvent(
    'DocumentVersionSaved',
    z.object({
      docId: Id,
      versionId: Id,
      version: z.number().int().min(1),
      content: z.string(),
      title: z.string().min(1).max(200).optional(),
      note: z.string().max(500).optional(),
      savedBy: z.object({
        kind: z.enum(['user', 'agent', 'persona', 'system']),
        id: z.string().max(80).nullable(),
      }),
      sourceThreadIds: z.array(Id).max(20).optional(),
    }),
  ),
  /** `version` is the version the change applies to (the approved one for `approved`). */
  defineEvent(
    'DocumentStatusChanged',
    z.object({
      docId: Id,
      from: DocumentStatusSchema,
      to: DocumentStatusSchema,
      version: z.number().int().min(1),
      by: Id.nullable(),
      note: z.string().max(500).optional(),
    }),
  ),
  /**
   * The vault copy of an approved version was handed to a workstation as a durable `vault.write` command (the command
   * queue retries delivery). Not appended while no vault or workstation exists: the document then stays `pending`.
   */
  defineEvent(
    'DocumentPublishQueued',
    z.object({
      docId: Id,
      version: z.number().int().min(1),
      vaultId: Id,
      vaultPath: z.string().min(1).max(500),
      workstationId: Id,
      commandId: z.string().min(1).max(100),
    }),
  ),
] as const;
