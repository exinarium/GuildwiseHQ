import { z } from 'zod';

/**
 * Card attachments and Jira attachments for agents (docs/RUNNER.md "Attachments", docs/USER-GUIDE.md).
 *
 * A card attachment is a file the manager (or the BA) put on a card. The bytes live in Postgres (operational table, not
 * the event log); events carry metadata only. Agents never fetch files from the internet: the runner downloads Jira
 * attachments with its own credentials and copies a card's attachments into a read-only folder next to the shift.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_CARD_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_CARD_ATTACHMENTS = 50;
/** Jira download: per file and per call (all files of one `aom source attachments --all`). */
export const MAX_JIRA_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;
export const MAX_JIRA_CALL_BYTES = 60 * 1024 * 1024;
export const MAX_NAME_LENGTH = 200;

export interface AttachmentKind {
  /** Served content type (never the browser's guess). */
  contentType: string;
  /** Previewed by the browser in an `<img>` (images and SVG); everything else is a download. */
  image: boolean;
  /** Text (no NUL bytes allowed). */
  text: boolean;
}

const IMAGE = (contentType: string): AttachmentKind => ({ contentType, image: true, text: false });
const BINARY = (contentType: string): AttachmentKind => ({ contentType, image: false, text: false });
const TEXT = (contentType: string): AttachmentKind => ({ contentType, image: false, text: true });

/** Allowed extensions. Anything else (and every executable) is refused. */
export const ATTACHMENT_KINDS: Record<string, AttachmentKind> = {
  png: IMAGE('image/png'),
  jpg: IMAGE('image/jpeg'),
  jpeg: IMAGE('image/jpeg'),
  gif: IMAGE('image/gif'),
  webp: IMAGE('image/webp'),
  bmp: IMAGE('image/bmp'),
  ico: IMAGE('image/x-icon'),
  svg: { contentType: 'image/svg+xml', image: true, text: true },
  pdf: BINARY('application/pdf'),
  zip: BINARY('application/zip'),
  docx: BINARY('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  xlsx: BINARY('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  pptx: BINARY('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  txt: TEXT('text/plain; charset=utf-8'),
  md: TEXT('text/plain; charset=utf-8'),
  markdown: TEXT('text/plain; charset=utf-8'),
  csv: TEXT('text/plain; charset=utf-8'),
  tsv: TEXT('text/plain; charset=utf-8'),
  json: TEXT('text/plain; charset=utf-8'),
  xml: TEXT('text/plain; charset=utf-8'),
  yaml: TEXT('text/plain; charset=utf-8'),
  yml: TEXT('text/plain; charset=utf-8'),
  log: TEXT('text/plain; charset=utf-8'),
  diff: TEXT('text/plain; charset=utf-8'),
  patch: TEXT('text/plain; charset=utf-8'),
  har: TEXT('text/plain; charset=utf-8'),
  html: TEXT('text/plain; charset=utf-8'),
  htm: TEXT('text/plain; charset=utf-8'),
};

/** Named so the refusal can say why. */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe',
  'dll',
  'bat',
  'cmd',
  'com',
  'msi',
  'scr',
  'vbs',
  'vbe',
  'wsf',
  'ps1',
  'sh',
  'bash',
  'apk',
  'app',
  'jar',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'lnk',
  'js',
  'mjs',
  'cjs',
]);

const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);

/** Executable file formats by their first bytes (whatever the file is called). */
function executableMagic(b: Uint8Array): string | null {
  if (startsWith(b, [0x4d, 0x5a])) return 'a Windows executable';
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'an ELF executable';
  if (
    startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(b, [0xca, 0xfe, 0xba, 0xbe])
  )
    return 'a program binary';
  if (startsWith(b, [0x23, 0x21])) return 'a script (#!)';
  return null;
}

/** Does the content look like what its extension says? (Magic numbers for binary types, no NUL for text.) */
function magicMatches(ext: string, b: Uint8Array): boolean {
  switch (ext) {
    case 'png':
      return startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
    case 'jpg':
    case 'jpeg':
      return startsWith(b, [0xff, 0xd8, 0xff]);
    case 'gif':
      return startsWith(b, [0x47, 0x49, 0x46, 0x38]);
    case 'webp':
      return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
    case 'bmp':
      return startsWith(b, [0x42, 0x4d]);
    case 'ico':
      return startsWith(b, [0, 0, 1, 0]);
    case 'pdf':
      // Some producers put a few bytes before the header.
      return Buffer.from(b.subarray(0, 1024)).includes('%PDF-');
    case 'zip':
    case 'docx':
    case 'xlsx':
    case 'pptx':
      return startsWith(b, [0x50, 0x4b]);
    default:
      return true;
  }
}

export type AttachmentCheck = { ok: true; kind: AttachmentKind; ext: string } | { ok: false; reason: string };

/** A file name safe to store and to put in a path: no directories, no control characters, bounded. */
export function safeAttachmentName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = [...base]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || '<>:"|?*'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return 'attachment';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

export const attachmentExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Type, size and content check shared by the server (every upload) and the runner (before it uploads). */
export function checkAttachment(name: string, bytes: Uint8Array): AttachmentCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: 'the file is empty' };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return { ok: false, reason: `the file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` };
  const ext = attachmentExtension(name);
  if (EXECUTABLE_EXTENSIONS.has(ext))
    return { ok: false, reason: `.${ext} files (programs and scripts) cannot be attached` };
  const kind = ATTACHMENT_KINDS[ext];
  if (!kind)
    return {
      ok: false,
      reason: `${ext ? `.${ext}` : 'a file without an extension'} is not an allowed attachment type (allowed: ${Object.keys(ATTACHMENT_KINDS).join(', ')})`,
    };
  const exe = executableMagic(bytes);
  if (exe) return { ok: false, reason: `the content is ${exe}, not a ${ext} file` };
  if (!magicMatches(ext, bytes)) return { ok: false, reason: `the content is not a valid .${ext} file` };
  if (kind.text) {
    if (bytes.subarray(0, 8192).includes(0))
      return { ok: false, reason: `the content is binary, not a text .${ext} file` };
    if (ext === 'svg') {
      const head = Buffer.from(bytes.subarray(0, 4096)).toString('utf8').toLowerCase();
      if (!head.includes('<svg')) return { ok: false, reason: 'the content is not an SVG image' };
    }
  }
  return { ok: true, kind, ext };
}

export const CardAttachmentDtoSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  /** Shown as a preview (images and SVG). */
  image: z.boolean(),
  addedByName: z.string().nullable(),
  addedByAgent: z.boolean(),
  /** Where it came from, e.g. `jira DCPL-4276`; null: uploaded by hand. */
  source: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type CardAttachmentDto = z.infer<typeof CardAttachmentDtoSchema>;

export const CardAttachmentsResponseSchema = z.object({
  attachments: z.array(CardAttachmentDtoSchema),
  limits: z.object({
    maxFileBytes: z.number(),
    maxCardBytes: z.number(),
    maxFiles: z.number(),
  }),
});
export type CardAttachmentsResponse = z.infer<typeof CardAttachmentsResponseSchema>;

/** What a shift's brief carries about an attachment (no bytes). */
export const BriefAttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type BriefAttachment = z.infer<typeof BriefAttachmentSchema>;

/** `card.attach.begin` (the runner asks to attach a file to a card). */
export const AttachBeginParamsSchema = z.object({
  ref: z.string().optional(),
  name: z.string().min(1).max(500),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Where the file came from (e.g. `jira DCPL-4276`). */
  source: z.string().max(200).optional(),
});
export type AttachBeginParams = z.infer<typeof AttachBeginParamsSchema>;

/** Jira issue keys: ABC-123. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/;

/** The folder name inside the agent's scratch dir that holds downloaded Jira attachments. */
export const JIRA_ATTACHMENTS_DIR = 'attachments';
/** The folder name inside the agent's temp dir that holds a card's attachments (read-only copies). */
export const CARD_ATTACHMENTS_DIR = 'card-attachments';

/** Human text for a byte count: `1.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The part of the instructions that lists a card's attachments (the runner copied them to `dir`). */
export function renderCardAttachments(
  dir: string,
  files: Array<{ name: string; size: number; path: string }>,
): string {
  if (files.length === 0) return '';
  return [
    '# Attachments of this card',
    `The manager or the BA attached these files to the card. They are read-only copies in ${dir} (outside the worktree; never commit them). Images can be looked at with the Read tool; SVG and text files read as text.`,
    ...files.map((f) => `- ${f.path} (${f.name}, ${formatBytes(f.size)})`),
    'If a file is missing or changed, `aom card attachments` copies them again.',
  ].join('\n');
}
