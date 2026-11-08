import { z } from 'zod';

/**
 * Storage connections (docs/investigations/GWP-63): a firm's own storage that form uploads and answers are written to.
 * The server knows a connection id, kind, label, workstation and health. Tokens, keys, endpoints and paths stay on the
 * workstation (`secrets/storage.json`, sealed); file content is relayed and never stored on the server.
 */
export const STORAGE_KINDS = ['onedrive', 'google_drive', 's3', 'local', 'vault'] as const;
export const StorageKindSchema = z.enum(STORAGE_KINDS);
export type StorageKind = z.infer<typeof StorageKindSchema>;
/** Kinds that sign in with OAuth on the workstation (device flow). */
export const STORAGE_OAUTH_KINDS: readonly StorageKind[] = ['onedrive', 'google_drive'];

export const STORAGE_ERROR_CODES = [
  'auth_expired',
  'unavailable',
  'quota',
  'permission',
  'not_found',
  'invalid',
  'too_large',
  'conflict',
  'runner_offline',
  'timeout',
  'malware_detected',
  'scan_unavailable',
] as const;
export const StorageErrorCodeSchema = z.enum(STORAGE_ERROR_CODES);
export type StorageErrorCode = z.infer<typeof StorageErrorCodeSchema>;

/** Whether asking the client to try again can help. */
export const STORAGE_RETRYABLE: Record<StorageErrorCode, boolean> = {
  unavailable: true,
  timeout: true,
  runner_offline: true,
  conflict: true,
  auth_expired: false,
  quota: false,
  permission: false,
  not_found: false,
  invalid: false,
  too_large: false,
  malware_detected: false,
  scan_unavailable: true,
};

/** Announced in `hello.capabilities` by a runner that holds storage connections. */
export const STORAGE_CAPABILITY = 'storage:1';
/** Raw bytes per chunk frame. */
/** Announced in `hello.capabilities` by a runner that handles `storage.delete`. */
export const STORAGE_DELETE_CAPABILITY = 'storage-delete:1';
export const STORAGE_DELETE_TIMEOUT_MS = 30_000;
export type StorageDeleteOutcome = 'deleted' | 'not_found';
export const STORAGE_CHUNK_BYTES = 256 * 1024;
/** Chunks in flight per transfer (2 MiB). */
export const STORAGE_WINDOW = 8;
export const STORAGE_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const STORAGE_HARD_MAX_FILE_BYTES = 100 * 1024 * 1024;

export const StorageWriteErrorSchema = z.object({
  code: StorageErrorCodeSchema,
  message: z.string().max(300),
  retryable: z.boolean(),
});
export type StorageWriteError = z.infer<typeof StorageWriteErrorSchema>;

export function storageError(code: StorageErrorCode, message: string): StorageWriteError {
  return { code, message: message.slice(0, 300), retryable: STORAGE_RETRYABLE[code] };
}

/** What the server may keep after a write: where the file went, never the file. */
export const StorageReferenceSchema = z.object({
  v: z.literal(1),
  connectionId: z.uuid(),
  kind: StorageKindSchema,
  /** Root-relative path, or the S3 object key (prefix included). */
  path: z.string().max(1024),
  providerId: z.string().max(300).optional(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().max(200),
  writtenAt: z.iso.datetime(),
});
export type StorageReference = z.infer<typeof StorageReferenceSchema>;

export const STORAGE_HEALTH_STATES = [
  'pending',
  'connected',
  'needs_reauth',
  'unavailable',
  'permission',
  'quota',
  'not_on_workstation',
] as const;
export const StorageHealthStateSchema = z.enum(STORAGE_HEALTH_STATES);
export type StorageHealthState = z.infer<typeof StorageHealthStateSchema>;

/** The health row the runner reports (no value, path or token in `message`). */
export const StorageHealthReportSchema = z.object({
  connectionId: z.uuid(),
  state: StorageHealthStateSchema,
  errorCode: StorageErrorCodeSchema.optional(),
  message: z.string().max(300).optional(),
  checkedAt: z.iso.datetime(),
});
export type StorageHealthReport = z.infer<typeof StorageHealthReportSchema>;

/** The health state an error leaves a connection in. */
export function healthStateForError(code: StorageErrorCode): StorageHealthState {
  switch (code) {
    case 'auth_expired':
      return 'needs_reauth';
    case 'permission':
      return 'permission';
    case 'quota':
      return 'quota';
    case 'not_found':
      return 'not_on_workstation';
    default:
      return 'unavailable';
  }
}

export const StorageRequestStateSchema = z.enum([
  'pending',
  'awaiting_user',
  'done',
  'failed',
  'cancelled',
  'expired',
]);
export type StorageRequestState = z.infer<typeof StorageRequestStateSchema>;

export const StorageDevicePromptSchema = z.object({
  userCode: z.string().max(40),
  verificationUri: z.string().max(500),
  expiresAt: z.iso.datetime(),
});
export type StorageDevicePrompt = z.infer<typeof StorageDevicePromptSchema>;

// -------------------------------------------------------------------------------------------- command payloads

export const StorageConnectPayloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectionId: z.uuid(),
  kind: StorageKindSchema,
  // Parsed by the integrations envelope schema where the command is handled; kept loose here to avoid a cycle.
  envelope: z.record(z.string(), z.unknown()),
});
export const StorageAuthBeginPayloadSchema = z.object({
  sessionId: z.string().min(1).max(64),
  connectionId: z.uuid(),
  kind: z.enum(['onedrive', 'google_drive']),
  options: z.object({ siteUrl: z.string().max(300).optional(), baseFolder: z.string().max(120).optional() }),
});
export const StorageAuthCancelPayloadSchema = z.object({ sessionId: z.string().min(1).max(64) });
export const StorageTestPayloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectionId: z.uuid(),
});
export const StorageRemovePayloadSchema = z.object({ connectionId: z.uuid() });
export const StorageSyncPayloadSchema = z.object({ connectionIds: z.array(z.uuid()).max(1000) });
/** Server to runner: remove everything this workstation wrote for one public form submission. */
export const StorageDiscardPayloadSchema = z.object({ submissionId: z.uuid() });

// ---------------------------------------------------------------------------------------------- path templates

/** Placeholders a folder or name template may use. */
export const STORAGE_TEMPLATE_KEYS = [
  'journey',
  'client',
  'form',
  'field',
  'submission',
  'date',
  'time',
  'original',
  'ext',
] as const;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_SEGMENT = 120;
const MAX_PATH = 400;

/** One conservative sanitiser for every store (Windows / SMB safe). */
export function sanitizeStorageSegment(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
  let s = raw.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '-');
  s = s.replace(/-{2,}/g, '-').replace(/\s{2,}/g, ' ');
  s = s.replace(/^[. ]+|[. ]+$/g, '');
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).replace(/[. ]+$/g, '');
  if (!s) return '_';
  if (RESERVED.test(s.split('.')[0] ?? '')) s = `${s}_`;
  return s;
}

type Fill = { ok: true; text: string } | { ok: false; error: string };

function fill(template: string, vars: Record<string, string>): Fill {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === '{' && template[i + 1] === '{') {
      out += '{';
      i++;
    } else if (c === '}' && template[i + 1] === '}') {
      out += '}';
      i++;
    } else if (c === '{') {
      const end = template.indexOf('}', i);
      if (end < 0) return { ok: false, error: 'a placeholder is not closed' };
      const key = template.slice(i + 1, end);
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) return { ok: false, error: `bad placeholder {${key}}` };
      if (!(STORAGE_TEMPLATE_KEYS as readonly string[]).includes(key))
        return { ok: false, error: `unknown placeholder {${key}}` };
      const v = vars[key];
      if (v === undefined) return { ok: false, error: `no value for {${key}}` };
      out += v;
      i = end;
    } else if (c === '}') {
      return { ok: false, error: 'a closing brace without an opening one' };
    } else out += c;
  }
  return { ok: true, text: out };
}

export type RenderedStoragePath = { ok: true; folder: string[]; name: string } | { ok: false; error: string };

/**
 * Renders a folder and a name template (`{journey}/{client}` and `{field}-{date}`) into sanitised path segments.
 * Values are sanitised as part of their segment, so a value can never add a folder or climb out of the root.
 */
export function renderStoragePath(
  t: { folder: string; name: string },
  vars: Record<string, string>,
  ext?: string,
): RenderedStoragePath {
  const folder: string[] = [];
  for (const part of t.folder.split('/')) {
    if (part === '') continue;
    // Fill each placeholder value separately so a value holding `/` cannot create a segment.
    const f = fill(part, vars);
    if (!f.ok) return f;
    folder.push(sanitizeStorageSegment(f.text));
  }
  const n = fill(t.name, vars);
  if (!n.ok) return n;
  let name = sanitizeStorageSegment(n.text);
  const e = (ext ?? vars.ext ?? '')
    .replace(/^\./, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 12);
  if (e && !/\.[A-Za-z0-9]{1,12}$/.test(name)) name = `${name}.${e}`;
  if ([...folder, name].join('/').length > MAX_PATH) return { ok: false, error: 'the path is too long' };
  return { ok: true, folder, name };
}

/**
 * The segments of a stored path below its destination base, or null when the path could not have come from a write:
 * absolute, a drive letter, a backslash, NUL, empty, '.', '..', or a segment that sanitizeStorageSegment would change.
 * `base` is the S3 prefix or the vault folder: the path must start with `${base}/` and the base is stripped first.
 */
export function storedPathSegments(path: string, base = ''): string[] | null {
  if (!path || path.length > 1024) return null;
  let rest = path;
  const b = base.replace(/^\/+|\/+$/g, '');
  if (b) {
    if (!rest.startsWith(`${b}/`)) return null;
    rest = rest.slice(b.length + 1);
  }
  if (!rest || rest.length > MAX_PATH) return null;
  const segs = rest.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (sanitizeStorageSegment(seg) !== seg) return null;
  }
  return segs;
}

/** Validates the pieces of a template without values (placeholders known and braces balanced). */
export function checkStorageTemplate(template: string): { ok: true } | { ok: false; error: string } {
  const vars: Record<string, string> = {};
  for (const k of STORAGE_TEMPLATE_KEYS) vars[k] = 'x';
  const r = fill(template, vars);
  return r.ok ? { ok: true } : r;
}

export function storageClashName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}
export const STORAGE_MAX_CLASH = 20;

// ------------------------------------------------------------------------------------------------ API

export const StorageConnectionCreateSchema = z.object({
  kind: StorageKindSchema,
  label: z.string().trim().min(1).max(80),
  workstationId: z.uuid(),
});
export type StorageConnectionCreate = z.infer<typeof StorageConnectionCreateSchema>;
export const StorageConnectionRenameSchema = z.object({ label: z.string().trim().min(1).max(80) });
export const StorageConnectBodySchema = z.object({
  requestId: z.string().min(1).max(64),
  envelope: z.record(z.string(), z.unknown()),
});
export const StorageAuthBodySchema = z.object({
  siteUrl: z.string().trim().max(300).optional(),
  baseFolder: z.string().trim().max(120).optional(),
});
export const StorageTestBodySchema = z.object({ requestId: z.string().min(1).max(64) });

/** What the list shows. No endpoint, bucket, path, account or token: the server does not know them. */
export interface StorageConnectionDto {
  id: string;
  kind: StorageKind;
  label: string;
  workstation: { id: string; name: string; online: boolean };
  health: {
    state: StorageHealthState | 'runner_offline';
    errorCode: StorageErrorCode | null;
    message: string | null;
    checkedAt: string | null;
    lastOkAt: string | null;
  };
  createdAt: string;
  /** The signed-in user owns the workstation and may connect, test and reconnect from here. */
  canConnect: boolean;
}

export interface StorageRequestDto {
  id: string;
  op: 'connect' | 'auth' | 'test' | 'remove';
  state: StorageRequestState;
  prompt: StorageDevicePrompt | null;
  errorCode: StorageErrorCode | null;
  message: string | null;
}
