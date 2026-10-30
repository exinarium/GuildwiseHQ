import { z } from 'zod';

/**
 * Documents (docs/design/discovery-boardroom-registry.md): briefs, PRDs, minutes and session logs held on the server
 * while they are drafted, published to the organization or project vault as markdown once approved.
 */
export const DOCUMENT_KINDS = ['brief', 'prd', 'minutes', 'session_log', 'file'] as const;
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

export const DOCUMENT_MAX_TAGS = 20;
export const DOCUMENT_TAG_MAX = 40;

/**
 * A tag as stored and compared: Unicode-normalized, trimmed, lowercase, inner whitespace as `-`, only letters, digits
 * and `-_.` kept, at most 40 characters. Empty when nothing is left.
 */
export function normalizeDocumentTag(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .slice(0, DOCUMENT_TAG_MAX);
}

/** Normalizes a list of tags: empty ones dropped, duplicates removed (first order kept). */
export function normalizeDocumentTags(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const t = normalizeDocumentTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A comma-separated list (a query string value) as normalized tags. */
export const parseDocumentTagList = (csv: string | undefined): string[] =>
  csv ? normalizeDocumentTags(csv.split(',')) : [];

/** Uploads of these types become authored (text) documents; every other allowed type is kept as a file. */
export const DOCUMENT_TEXT_UPLOAD_EXTENSIONS: readonly string[] = ['md', 'markdown', 'txt'];

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

/** The vault path of the original file of an uploaded document: `<folder>/docs/files/<slug>.<ext>`. */
export function documentFileVaultPath(slug: string, ext: string, projectFolder?: string | null): string {
  return projectFolder
    ? `${projectFolder.replace(/\/+$/, '')}/docs/files/${slug}.${ext}`
    : `org/docs/files/${slug}.${ext}`;
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
  /** Written only when there are any. */
  tags?: readonly string[] | undefined;
  /** An uploaded file document: where its original sits (relative to the sidecar) and its name. */
  file?: { path: string; name: string } | undefined;
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
    ...(d.tags?.length ? [`tags: [${d.tags.map((t) => JSON.stringify(t)).join(', ')}]`] : []),
    ...(d.file ? [`file: ${JSON.stringify(d.file.path)}`, `file_name: ${JSON.stringify(d.file.name)}`] : []),
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
  tags: z.array(z.string().max(80)).max(DOCUMENT_MAX_TAGS).optional(),
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

export const SetDocumentTagsRequestSchema = z.object({
  tags: z.array(z.string().max(80)).max(DOCUMENT_MAX_TAGS),
});
export type SetDocumentTagsRequest = z.infer<typeof SetDocumentTagsRequestSchema>;

/** `POST /api/documents/upload`: the file is the raw request body, the rest is in the query string. */
export const UploadDocumentQuerySchema = z.object({
  name: z.string().min(1).max(500),
  /** Absent: an organization document. */
  projectId: z.uuid().optional(),
  kind: DocumentKindSchema.default('file'),
  title: z.string().trim().min(1).max(200).optional(),
  /** Comma-separated. */
  tags: z.string().max(1000).optional(),
});
export type UploadDocumentQuery = z.infer<typeof UploadDocumentQuerySchema>;

export const ListDocumentsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  kind: DocumentKindSchema.optional(),
  status: DocumentStatusSchema.optional(),
  /** `true`: only organization documents (no project). */
  orgOnly: z.enum(['true', 'false']).optional(),
  threadId: z.uuid().optional(),
  /** Text search: every word must be in the title, the file name or the current text. */
  q: z.string().trim().max(200).optional(),
  /** Comma-separated tags: the document must carry all of them. */
  tags: z.string().max(1000).optional(),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

/** The original file of an uploaded document (the `file` kind, or any non-text upload). */
export const DocumentFileDtoSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  image: z.boolean(),
});
export type DocumentFileDto = z.infer<typeof DocumentFileDtoSchema>;

export const DocumentTagCountDtoSchema = z.object({ tag: z.string(), count: z.number().int() });
export type DocumentTagCountDto = z.infer<typeof DocumentTagCountDtoSchema>;

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
  /** Present only when the document has tags (an untagged document's response is what it always was). */
  tags: z.array(z.string()).optional(),
  /** Present only for an uploaded file. */
  file: DocumentFileDtoSchema.optional(),
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
