import { z } from 'zod';
import {
  EXECUTABLE_EXTENSIONS,
  executableMagic,
  magicMatches,
  safeAttachmentName,
} from '../attachments/index.ts';
import type { FormDefinition } from './schema.ts';
import {
  type FormAnswerValue,
  type FormFieldErrorCode,
  type FormFileAnswer,
  validateFormAnswers,
} from './validate.ts';

/** A published form's id in the public URL: 128 random bits, base64url. */
export const PUBLIC_FORM_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** `v1.<linkId>.<exp base36>.<HMAC>`: no personal data. */
export const CLIENT_LINK_TOKEN_RE = /^v1\.[A-Za-z0-9_-]{22}\.[0-9a-z]{1,8}\.[A-Za-z0-9_-]{43}$/;
export const PUBLIC_FORM_PATH_PREFIX = '/f/';
export const publicFormPath = (publicId: string): string => `${PUBLIC_FORM_PATH_PREFIX}${publicId}`;

export const PUBLIC_FORM_ERROR_CODES = [
  'form_not_available',
  'link_invalid',
  'link_expired',
  'link_revoked',
  'link_used',
  'session_invalid',
  'session_used',
  'form_changed',
  'submission_refused',
  'invalid_answers',
  'file_too_large',
  'file_type_refused',
  'too_many_files',
  'parts_missing',
  'submission_expired',
  'storage_failed',
  'runner_offline',
  'runner_online',
  'destination_missing',
  'rate_limited',
  'submission_not_found',
  'submission_busy',
] as const;
export type PublicFormErrorCode = (typeof PUBLIC_FORM_ERROR_CODES)[number];

/** Stands in for the logo id on the public page: the page loads the logo from the public logo route. */
const NO_LOGO_ID = '00000000-0000-4000-8000-000000000000';

/**
 * What the public may see: the definition with every storage destination (connection, folder, name template) blanked and
 * the logo reduced to its alt text. The result still parses as a `FormDefinition`, so the same renderer shows it.
 */
export function publicFormView(def: FormDefinition): FormDefinition {
  const blank = { connectionId: null, folder: '', name: '' };
  return {
    schemaVersion: def.schemaVersion,
    settings: {
      title: def.settings.title,
      description: def.settings.description,
      logo: def.settings.logo ? { imageId: NO_LOGO_ID, alt: def.settings.logo.alt } : null,
      answersDestination: blank,
      confirmationText: def.settings.confirmationText,
    },
    fields: def.fields.map((f) => (f.type === 'file' ? { ...f, destination: blank } : { ...f })),
  };
}

// ------------------------------------------------------------------------------------------- uploads

export type UploadGroup = 'image' | 'document' | 'sheet' | 'text' | 'archive';

/** The file types a form may accept. The content type is ours, never the browser's. No SVG, no macro-enabled formats. */
export const FORM_UPLOAD_TYPES: Record<string, { contentType: string; group: UploadGroup }> = {
  pdf: { contentType: 'application/pdf', group: 'document' },
  png: { contentType: 'image/png', group: 'image' },
  jpg: { contentType: 'image/jpeg', group: 'image' },
  jpeg: { contentType: 'image/jpeg', group: 'image' },
  gif: { contentType: 'image/gif', group: 'image' },
  webp: { contentType: 'image/webp', group: 'image' },
  heic: { contentType: 'image/heic', group: 'image' },
  heif: { contentType: 'image/heif', group: 'image' },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    group: 'document',
  },
  xlsx: {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    group: 'sheet',
  },
  pptx: {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    group: 'document',
  },
  odt: { contentType: 'application/vnd.oasis.opendocument.text', group: 'document' },
  ods: { contentType: 'application/vnd.oasis.opendocument.spreadsheet', group: 'sheet' },
  txt: { contentType: 'text/plain; charset=utf-8', group: 'text' },
  csv: { contentType: 'text/csv; charset=utf-8', group: 'text' },
  zip: { contentType: 'application/zip', group: 'archive' },
};

/**
 * Extensions a file field accepts. The field's `allowedTypes` are `.ext` or MIME patterns (`image/png`, `image/*`):
 * `.ext` counts when we know the type, a MIME entry expands to every known extension whose content type matches.
 * Anything else (`.exe`, `.docm`, `image/svg+xml`) is dropped.
 */
export function acceptedUploadExtensions(allowedTypes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of allowedTypes) {
    const t = raw.toLowerCase();
    if (t.startsWith('.')) {
      const ext = t.slice(1);
      if (FORM_UPLOAD_TYPES[ext] && !EXECUTABLE_EXTENSIONS.has(ext)) out.add(ext);
      continue;
    }
    const [major, sub] = t.split('/');
    if (!major || !sub) continue;
    for (const [ext, info] of Object.entries(FORM_UPLOAD_TYPES)) {
      const ct = info.contentType.split(';')[0] as string;
      if (sub === '*' ? ct.startsWith(`${major}/`) : ct === t) out.add(ext);
    }
  }
  return [...out];
}

export type UploadHeadRefusal = 'type_not_allowed' | 'executable' | 'content_mismatch' | 'empty';

/** Bytes of a file read before the check (the whole file when smaller). */
export const UPLOAD_HEAD_BYTES = 4100;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'heif']);

/** Checks the first bytes of a file against its extension and the extensions the field accepts. */
export function checkUploadHead(
  ext: string,
  head: Uint8Array,
  accepted: readonly string[],
): { ok: true; contentType: string } | { ok: false; code: UploadHeadRefusal } {
  const e = ext.toLowerCase();
  if (head.byteLength === 0) return { ok: false, code: 'empty' };
  if (EXECUTABLE_EXTENSIONS.has(e) || executableMagic(head)) return { ok: false, code: 'executable' };
  const info = FORM_UPLOAD_TYPES[e];
  if (!info || !accepted.includes(e)) return { ok: false, code: 'type_not_allowed' };
  let good: boolean;
  switch (e) {
    case 'heic':
    case 'heif':
      good = head.byteLength >= 12 && latin1(head, 4, 8) === 'ftyp' && HEIC_BRANDS.has(latin1(head, 8, 12));
      break;
    case 'odt':
    case 'ods':
      good = magicMatches('zip', head);
      break;
    case 'txt':
    case 'csv':
      good = !head.subarray(0, UPLOAD_HEAD_BYTES).includes(0) && validUtf8Start(head);
      break;
    default:
      good = magicMatches(e, head);
  }
  return good ? { ok: true, contentType: info.contentType } : { ok: false, code: 'content_mismatch' };
}

const latin1 = (b: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...b.subarray(from, to));

/** The head is cut at a byte count, so a multi-byte character at the end may be incomplete: only the start is judged. */
function validUtf8Start(head: Uint8Array): boolean {
  const cut = head.subarray(0, UPLOAD_HEAD_BYTES);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(cut);
  const bad = [...text.slice(0, -1)].filter((c) => c === '�').length;
  return bad === 0;
}

/** A browser file name made safe: no directories, no control characters, a lower-case extension (may be empty). */
export function sanitiseUploadName(raw: string): { base: string; ext: string } {
  const name = safeAttachmentName(raw);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

// ------------------------------------------------------------------------------------------- answers

export interface UploadManifestEntry {
  field: string;
  index: number;
  name: string;
  size: number;
  sha256: string;
}

export type PublicAnswerErrorCode =
  | FormFieldErrorCode
  | 'unknown_field'
  | 'file_missing'
  | 'file_not_expected';
export type PublicAnswersResult =
  | { ok: true }
  | { ok: false; errors: Array<{ field: string; code: PublicAnswerErrorCode }> };

/**
 * The server's check of a public submission: the shared validator with OUR content type for files (never the browser's)
 * and strict keys. The result holds field ids and codes only, never a message or a value.
 */
export function checkPublicAnswers(
  def: FormDefinition,
  answers: Record<string, unknown>,
  files: readonly UploadManifestEntry[],
): PublicAnswersResult {
  const fileIds = new Set(def.fields.filter((f) => f.type === 'file').map((f) => f.id));
  const merged: Record<string, FormAnswerValue> = {};
  for (const [k, v] of Object.entries(answers)) if (!fileIds.has(k)) merged[k] = v as FormAnswerValue;

  const errors = new Map<string, PublicAnswerErrorCode>();
  const seen = new Set<string>();
  for (const f of files) {
    const field = def.fields.find((x) => x.id === f.field);
    if (!field || field.type !== 'file' || seen.has(f.field)) {
      errors.set(safeKey(f.field), 'file_not_expected');
      continue;
    }
    seen.add(f.field);
    const { base, ext } = sanitiseUploadName(f.name);
    const info = FORM_UPLOAD_TYPES[ext];
    if (!info || !acceptedUploadExtensions(field.allowedTypes).includes(ext)) {
      errors.set(field.id, 'file_type');
      continue;
    }
    const answer: FormFileAnswer = { name: `${base}.${ext}`, size: f.size, type: info.contentType };
    merged[field.id] = answer;
  }

  const r = validateFormAnswers(def, merged, { strict: true });
  for (const [id, e] of Object.entries(r.errors)) if (!errors.has(id)) errors.set(id, e.code);
  for (const k of r.unknown) errors.set(safeKey(k), 'unknown_field');
  if (errors.size === 0) return { ok: true };
  return { ok: false, errors: [...errors].map(([field, code]) => ({ field, code })) };
}

/** A field id echoed in an error: never more than an id looks like. */
const safeKey = (k: string): string => k.replace(/[^a-z0-9_]/gi, '_').slice(0, 40);

// ------------------------------------------------------------------------------------------- api

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const SubmissionFileSchema = z.object({
  field: z.string().min(1).max(60),
  index: z.number().int().min(0).max(0),
  name: z.string().min(1).max(300),
  size: z.number().int().min(1),
  sha256: Sha256,
});
export const SubmissionStartSchema = z.object({
  session: z.string().min(10).max(400),
  nonce: z.string().max(40).default(''),
  website: z.string().max(200).default(''),
  link: z.string().max(200).optional(),
  answers: z.record(z.string().max(60), z.unknown()),
  files: z.array(SubmissionFileSchema).max(100).default([]),
});
export type SubmissionStart = z.infer<typeof SubmissionStartSchema>;

export const CompleteSchema = z.object({ answers: z.record(z.string().max(60), z.unknown()) });
export type CompleteBody = z.infer<typeof CompleteSchema>;

export interface PublicFormDto {
  form: FormDefinition;
  version: number;
  /** The public logo route, or null. */
  logo: string | null;
  /** The firm's name is not stored on a form: the page uses the form title. */
  session: string;
  powBits: number;
  minFillMs: number;
  /** `offline`: the firm's runner cannot receive a form now; the page offers the secure link instead of the fields. */
  availability: 'open' | 'offline';
  link: null | { state: 'valid'; expiresAt: string; purpose: 'client' | 'offline' };
}

export interface SubmissionStartResultDto {
  submissionId: string;
  uploadToken: string;
  parts: Array<{ field: string; index: number; needed: boolean }>;
}

export interface SubmissionStatusDto {
  status: 'receiving' | 'storing' | 'failed' | 'complete' | 'expired';
  parts: Array<{ field: string; index: number; state: 'pending' | 'stored' | 'failed' }>;
}

export interface SubmissionCompleteDto {
  status: 'complete' | 'link_later';
  confirmation?: string;
  message?: string;
}

/** Body of an error answer of the public routes. */
export interface PublicFormErrorBody {
  error: {
    code: PublicFormErrorCode;
    message: string;
    retryable?: boolean;
    fields?: Array<{ field: string; code: string }>;
  };
}

// ------------------------------------------------------------------------------------------- authoring

export type FormPublicationStatus = 'unpublished' | 'published';
export type FormPublicationWarning =
  | 'destination_missing'
  | 'destination_offline'
  | 'unsupported_file_types'
  | 'connection_unhealthy';

export interface FormPublicationDto {
  status: FormPublicationStatus;
  /** The full public URL; null when the form was never published. */
  url: string | null;
  publicId: string | null;
  version: number | null;
  latestVersion: number;
  publishedAt: string | null;
  archived: boolean;
  warnings: Array<{ code: FormPublicationWarning; fields: string[] }>;
}

export type ClientLinkState = 'active' | 'expired' | 'revoked' | 'used';
export interface ClientLinkDto {
  id: string;
  reference: string;
  state: ClientLinkState;
  expiresAt: string;
  createdAt: string;
  /** null when the form is not published. */
  url: string | null;
}

export const CreateClientLinkSchema = z.object({
  reference: z.string().trim().min(1).max(120),
  expiresInDays: z.number().int().min(1).max(90).default(14),
  recordKind: z.string().max(60).optional(),
  recordId: z.string().max(120).optional(),
});
export type CreateClientLink = z.infer<typeof CreateClientLinkSchema>;

export interface FormSubmissionDto {
  id: string;
  status: 'receiving' | 'storing' | 'failed' | 'complete' | 'expired';
  formVersion: number;
  reference: string | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Where the answers and files landed (storage paths, no content). */
  stored: Array<{ label: string; path: string }>;
}
