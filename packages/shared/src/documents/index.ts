import { z } from 'zod';

/**
 * Documents (docs/design/discovery-boardroom-registry.md): briefs, PRDs, minutes and session logs held on the server
 * while they are drafted, published to the organization or project vault as markdown once approved.
 */
export const DOCUMENT_KINDS = ['brief', 'prd', 'minutes', 'session_log'] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const DOCUMENT_STATUSES = ['draft', 'in_review', 'approved', 'handed_off', 'archived'] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** Allowed status changes. Approved documents are read-only until reopened (`approved -> draft`). */
export const DOCUMENT_TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  draft: ['in_review', 'archived'],
  in_review: ['draft', 'approved', 'archived'],
  approved: ['draft', 'handed_off', 'archived'],
  handed_off: ['archived'],
  archived: ['draft'],
};

export const canTransitionDocument = (from: DocumentStatus, to: DocumentStatus): boolean =>
  DOCUMENT_TRANSITIONS[from].includes(to);

/** Versions can be saved only while the document is being drafted or reviewed. */
export const documentIsEditable = (s: DocumentStatus): boolean => s === 'draft' || s === 'in_review';

/** Where the vault copy is: not yet asked (`none`), waiting for a vault or a workstation (`pending`), command queued (`queued`). */
export const DOCUMENT_PUBLISH_STATES = ['none', 'pending', 'queued'] as const;
export const DocumentPublishStateSchema = z.enum(DOCUMENT_PUBLISH_STATES);
export type DocumentPublishState = z.infer<typeof DocumentPublishStateSchema>;

export const DOCUMENT_MAX_CHARS = 400_000;

/** A file-name slug: lowercase ASCII words joined by hyphens, at most 60 characters; `document` when nothing is left. */
export function documentSlug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'document';
}

/**
 * The vault path of a document: `<project folder>/docs/<slug>.md` (the folder is `projectVaultFolder`, `projects/<name>`),
 * or `org/docs/<slug>.md` for an organization document.
 */
export function documentVaultPath(slug: string, projectFolder?: string | null): string {
  return projectFolder ? `${projectFolder.replace(/\/+$/, '')}/docs/${slug}.md` : `org/docs/${slug}.md`;
}

/** The markdown file written to the vault: a short frontmatter block (for traceability) and the content. */
export function renderDocumentFile(d: {
  id: string;
  title: string;
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  content: string;
  approvedAt?: string;
  sourceThreadIds?: readonly string[];
}): string {
  const head = [
    '---',
    `title: ${JSON.stringify(d.title)}`,
    `kind: ${d.kind}`,
    `status: ${d.status}`,
    `version: ${d.version}`,
    `document_id: ${d.id}`,
    ...(d.approvedAt ? [`approved_at: ${d.approvedAt}`] : []),
    ...(d.sourceThreadIds?.length ? [`sessions: [${d.sourceThreadIds.join(', ')}]`] : []),
    '---',
    '',
  ].join('\n');
  return `${head}${d.content.replace(/\s+$/, '')}\n`;
}

// ------------------------------------------------------------------------------------------------- API

export const CreateDocumentRequestSchema = z.object({
  kind: DocumentKindSchema,
  title: z.string().min(1).max(200),
  /** Absent: an organization document. */
  projectId: z.uuid().optional(),
  content: z.string().max(DOCUMENT_MAX_CHARS).default(''),
  sourceThreadIds: z.array(z.uuid()).max(20).default([]),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

export const SaveDocumentVersionRequestSchema = z.object({
  content: z.string().max(DOCUMENT_MAX_CHARS),
  title: z.string().min(1).max(200).optional(),
  note: z.string().max(500).optional(),
  /** The version the editor started from. A different current version is a 409 `version_conflict`. */
  baseVersion: z.number().int().min(1).optional(),
  sourceThreadIds: z.array(z.uuid()).max(20).optional(),
});
export type SaveDocumentVersionRequest = z.infer<typeof SaveDocumentVersionRequestSchema>;

export const ChangeDocumentStatusRequestSchema = z.object({
  status: DocumentStatusSchema,
  note: z.string().max(500).optional(),
});
export type ChangeDocumentStatusRequest = z.infer<typeof ChangeDocumentStatusRequestSchema>;

export const ListDocumentsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  kind: DocumentKindSchema.optional(),
  status: DocumentStatusSchema.optional(),
  /** `true`: only organization documents (no project). */
  orgOnly: z.enum(['true', 'false']).optional(),
  threadId: z.uuid().optional(),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

export const DocumentDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  projectId: z.uuid().nullable(),
  kind: DocumentKindSchema,
  title: z.string(),
  slug: z.string(),
  status: DocumentStatusSchema,
  currentVersion: z.number().int(),
  approvedVersion: z.number().int().nullable(),
  sourceThreadIds: z.array(z.uuid()),
  publishState: DocumentPublishStateSchema,
  publishedVersion: z.number().int().nullable(),
  vaultPath: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentDto = z.infer<typeof DocumentDtoSchema>;

export const DocumentVersionDtoSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  version: z.number().int(),
  content: z.string(),
  note: z.string().nullable(),
  savedBy: z.object({ kind: z.enum(['user', 'agent', 'persona', 'system']), id: z.string().nullable() }),
  createdAt: z.iso.datetime(),
});
export type DocumentVersionDto = z.infer<typeof DocumentVersionDtoSchema>;

export const DocumentWithContentDtoSchema = DocumentDtoSchema.extend({
  /** The current version's content. */
  content: z.string(),
  versions: z.array(DocumentVersionDtoSchema.omit({ content: true })),
});
export type DocumentWithContentDto = z.infer<typeof DocumentWithContentDtoSchema>;
