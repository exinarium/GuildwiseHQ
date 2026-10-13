import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  type BriefAttachment,
  CARD_ATTACHMENTS_DIR,
  checkAttachment,
  formatBytes,
  type IpcRpcResponse,
  JIRA_ATTACHMENTS_DIR,
  JIRA_KEY_RE,
  MAX_ATTACHMENT_BYTES,
  MAX_JIRA_ATTACHMENT_BYTES,
  MAX_JIRA_CALL_BYTES,
  parseExternalRef,
  safeAttachmentName,
} from '@aom/shared';
import { SourceReadError } from '../external/github.ts';
import type { JiraAdapter, JiraAttachmentInfo } from '../external/jira.ts';
import { confineAny } from '../fs-safe.ts';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The runner's own HTTP calls to the server (Bearer runner token): the bytes of an attachment an agent attaches (the
 * upload ticket comes from an rpc) and the bytes of a card's attachments for a shift. The token is read fresh because it
 * can rotate; it never reaches an agent.
 */
export class ServerHttp {
  constructor(private readonly opts: { base: () => string; token: () => string; fetch?: FetchFn }) {}

  private f(): FetchFn {
    return this.opts.fetch ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(120_000) }));
  }

  async upload(uploadId: string, bytes: Buffer): Promise<void> {
    const res = await this.f()(new URL(`/api/runner/uploads/${uploadId}`, this.opts.base()).toString(), {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.opts.token()}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(await httpError(res, 'the upload'));
  }

  async download(attachmentId: string, shiftId: string): Promise<Buffer> {
    const url = new URL(`/api/runner/attachments/${attachmentId}`, this.opts.base());
    url.searchParams.set('shift', shiftId);
    const res = await this.f()(url.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.opts.token()}` },
    });
    if (res.status < 200 || res.status >= 300) throw new Error(await httpError(res, 'the download'));
    return Buffer.from(await res.arrayBuffer());
  }
}

async function httpError(res: Response, what: string): Promise<string> {
  let detail = '';
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    detail = j.error?.message ?? '';
  } catch {
    // no JSON body
  }
  return `${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`;
}

// ----------------------------------------------------------------------------------------------- Jira attachments

/** The ticket keys an agent in this context may download attachments for. */
export function allowedJiraKeys(ctx: {
  intake?: { externalSystem?: string | null; externalKey?: string | null } | undefined;
  cardExternalRef?: string | undefined;
}): string[] {
  const keys = new Set<string>();
  const add = (text: string | null | undefined, onlyJira: boolean) => {
    if (!text) return;
    const ref = parseExternalRef(text);
    if (ref?.system === 'jira') keys.add(ref.key.toUpperCase());
    else if (!onlyJira && JIRA_KEY_RE.test(text.trim().toUpperCase())) keys.add(text.trim().toUpperCase());
  };
  if (ctx.intake && (!ctx.intake.externalSystem || ctx.intake.externalSystem === 'jira'))
    add(ctx.intake.externalKey, false);
  add(ctx.cardExternalRef, false);
  return [...keys];
}

export interface JiraAttachmentDeps {
  jira: () => JiraAdapter | undefined;
  /** The agent's scratch dir: files land in `<scratch>/attachments/<KEY>/`. */
  scratch: string;
  /** The keys this conversation may reach (its intake's ticket, the ticket of its card). */
  allowed: string[];
}

function resolveKey(deps: JiraAttachmentDeps, raw: unknown): string {
  const text = String(raw ?? '').trim();
  const ref = text ? parseExternalRef(text) : null;
  const key = (ref?.system === 'jira' ? ref.key : text).toUpperCase();
  if (!JIRA_KEY_RE.test(key)) throw new SourceReadError(`'${text}' is not a Jira ticket key (ABC-123)`);
  if (!deps.allowed.includes(key))
    throw new SourceReadError(
      deps.allowed.length
        ? `you may only read the attachments of ${deps.allowed.join(', ')} here (the ticket this conversation is about), not ${key}`
        : `this conversation is not about a Jira ticket, so there are no Jira attachments to download (asked for ${key})`,
    );
  return key;
}

function adapter(deps: JiraAttachmentDeps): JiraAdapter {
  const j = deps.jira();
  if (!j) throw new SourceReadError('this runner has no Jira adapter');
  return j;
}

/** `aom source attachments <KEY>`: the files attached to the ticket (names, sizes, who, when). */
export async function listJiraAttachments(deps: JiraAttachmentDeps, rawKey: unknown): Promise<string> {
  const key = resolveKey(deps, rawKey);
  const list = await adapter(deps).listAttachments(key);
  if (list.length === 0) return `${key} has no attachments.`;
  return [
    `${key} has ${list.length} attachment${list.length === 1 ? '' : 's'}:`,
    ...list.map(
      (a) =>
        `- ${a.filename} (id ${a.id}, ${a.mimeType}, ${formatBytes(a.size)}${a.author ? `, ${a.author}` : ''}${a.created ? `, ${a.created.slice(0, 10)}` : ''})`,
    ),
    `Download with \`aom source attachment ${key} <filename|id>\` (or --all).`,
  ].join('\n');
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * `aom source attachment <KEY> [<filename|id> | --all]`: the runner downloads with its own Jira credentials and writes the
 * files to `<scratch>/attachments/<KEY>/`; the answer lists the local paths (the agent opens them with Read). At most
 * 20 MB per file and 60 MB per call; what does not fit is reported, not downloaded.
 */
export async function downloadJiraAttachments(
  deps: JiraAttachmentDeps,
  rawKey: unknown,
  selector: string | undefined,
  all: boolean,
): Promise<string> {
  const key = resolveKey(deps, rawKey);
  const jira = adapter(deps);
  const list = await jira.listAttachments(key);
  if (list.length === 0) return `${key} has no attachments.`;
  let chosen: JiraAttachmentInfo[];
  if (all || !selector) chosen = list;
  else {
    chosen = list.filter((a) => a.id === selector || sameName(a.filename, selector));
    if (chosen.length === 0)
      throw new SourceReadError(
        `${key} has no attachment '${selector}' (it has: ${list.map((a) => a.filename).join(', ')})`,
      );
  }
  const dir = join(deps.scratch, JIRA_ATTACHMENTS_DIR, key);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const skipped: string[] = [];
  let budget = MAX_JIRA_CALL_BYTES;
  const used = new Set<string>();
  for (const a of chosen) {
    if (a.size > MAX_JIRA_ATTACHMENT_BYTES) {
      skipped.push(
        `${a.filename} (${formatBytes(a.size)} is over the ${formatBytes(MAX_JIRA_ATTACHMENT_BYTES)} limit per file)`,
      );
      continue;
    }
    if (a.size > budget) {
      skipped.push(
        `${a.filename} (${formatBytes(a.size)} does not fit in this call's ${formatBytes(MAX_JIRA_CALL_BYTES)}; ask for it alone)`,
      );
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await jira.downloadAttachment(a, MAX_JIRA_ATTACHMENT_BYTES);
    } catch (err) {
      skipped.push(`${a.filename} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    budget -= bytes.byteLength;
    let name = safeAttachmentName(a.filename);
    if (used.has(name.toLowerCase())) name = `${a.id}-${name}`;
    used.add(name.toLowerCase());
    const path = join(dir, name);
    writeFileSync(path, bytes, { mode: 0o644 });
    lines.push(`- ${path} (${a.mimeType}, ${formatBytes(bytes.byteLength)})`);
  }
  const out = [
    lines.length
      ? `Downloaded ${lines.length} file${lines.length === 1 ? '' : 's'} of ${key} to ${dir}:`
      : `Nothing was downloaded for ${key}.`,
    ...lines,
  ];
  if (lines.length)
    out.push(
      'Look at images and SVG/text files with the Read tool. To put a file on a card you drafted: `aom card attach <path> --card <REF>`.',
    );
  if (skipped.length) out.push('', 'Skipped:', ...skipped.map((s) => `- ${s}`));
  return out.join('\n');
}

// ----------------------------------------------------------------------------------------------- card attachments

export interface SyncedFile {
  name: string;
  size: number;
  path: string;
  /** The card the file belongs to (when the folder holds several cards' files). */
  ref?: string | undefined;
}

/**
 * Copies a card's attachments into `dest` (a read-only folder outside the worktree). The server decides which attachments
 * this shift may read; each file is checked against the sha256 of the brief. Files already there with the same content
 * are kept; files that are no longer attached are removed. Failures are returned, never thrown: a shift starts without
 * a file it could not get.
 */
export async function syncCardAttachments(opts: {
  dest: string;
  shiftId: string;
  http: ServerHttp;
  items: Array<{ ref?: string | undefined; attachment: BriefAttachment }>;
}): Promise<{ files: SyncedFile[]; errors: string[] }> {
  const { dest, items } = opts;
  const files: SyncedFile[] = [];
  const errors: string[] = [];
  const multi = new Set(items.map((i) => i.ref ?? '')).size > 1;
  rmSync(dest, { recursive: true, force: true });
  if (items.length === 0) return { files, errors };
  mkdirSync(dest, { recursive: true, mode: 0o755 });
  const used = new Set<string>();
  for (const { ref, attachment: a } of items) {
    const folder = multi && ref ? join(dest, safeAttachmentName(ref)) : dest;
    mkdirSync(folder, { recursive: true });
    let name = safeAttachmentName(a.name);
    const slot = `${folder}/${name}`.toLowerCase();
    if (used.has(slot)) name = `${a.id.slice(0, 8)}-${name}`;
    used.add(`${folder}/${name}`.toLowerCase());
    const path = join(folder, name);
    try {
      const bytes = await opts.http.download(a.id, opts.shiftId);
      if (createHash('sha256').update(bytes).digest('hex') !== a.sha256)
        throw new Error('the file does not match its checksum');
      writeFileSync(path, bytes, { mode: 0o444 });
      try {
        chmodSync(path, 0o444);
      } catch {
        // not supported on every platform
      }
      files.push({ name: a.name, size: a.size, path, ...(ref ? { ref } : {}) });
    } catch (err) {
      errors.push(`${a.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { files, errors };
}

/** Where a shift's or chat's card attachments are copied: the agent's private temp dir, outside the worktree. */
export const cardAttachmentsDir = (agentTmp: string): string => join(agentTmp, CARD_ATTACHMENTS_DIR);

/** `aom card attachments` for the agent: list + the local copies. */
export function describeSynced(synced: { files: SyncedFile[]; errors: string[] }): string {
  if (synced.files.length === 0 && synced.errors.length === 0) return 'No attachments on this card.';
  return [
    ...(synced.files.length ? [`${synced.files.length} file(s) copied (read-only):`] : []),
    ...synced.files.map((f) => `- ${f.path} (${f.ref ? `${f.ref}: ` : ''}${f.name}, ${formatBytes(f.size)})`),
    ...(synced.errors.length ? ['', 'Could not copy:', ...synced.errors.map((e) => `- ${e}`)] : []),
  ].join('\n');
}

// ----------------------------------------------------------------------------------------------- attaching (BA)

/**
 * `aom card attach <path> [--card REF]`: the runner reads the file (only from the agent's own scratch or temp dir),
 * checks it, asks the server for an upload ticket (the server decides whether the agent may attach to that card) and sends
 * the bytes. The agent never talks to the server itself.
 */
export async function attachFileFromAgent(opts: {
  path: string;
  ref?: string | undefined;
  /** Folders the agent may attach from (its scratch and temp dirs). */
  roots: string[];
  rpc: (method: string, params: Record<string, unknown>) => Promise<IpcRpcResponse>;
  http: ServerHttp;
}): Promise<string> {
  let abs: string;
  try {
    abs = confineAny(opts.roots, resolve(opts.path));
  } catch {
    throw new Error(
      `only files in your scratch or temp directory can be attached (for example the ones \`aom source attachment\` downloaded), not ${opts.path}`,
    );
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${opts.path} is not a file`);
  const size = statSync(abs).size;
  if (size > MAX_ATTACHMENT_BYTES)
    throw new Error(`${basename(abs)} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  const bytes = readFileSync(abs);
  const name = safeAttachmentName(basename(abs));
  const check = checkAttachment(name, bytes);
  if (!check.ok) throw new Error(`${name}: ${check.reason}`);
  const jira = new RegExp(`/${JIRA_ATTACHMENTS_DIR}/([A-Z][A-Z0-9_]+-\\d+)/[^/]+$`).exec(
    abs.replace(/\\/g, '/'),
  );
  const begin = await opts.rpc('card.attach.begin', {
    ...(opts.ref ? { ref: opts.ref } : {}),
    name,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(jira ? { source: `jira ${jira[1]}` } : {}),
  });
  if (!begin.ok) throw new Error(begin.error ?? 'the server refused the attachment');
  const t = begin.result as { uploadId: string; ref: string; name: string };
  await opts.http.upload(t.uploadId, bytes);
  return `Attached ${t.name} (${formatBytes(bytes.byteLength)}) to ${t.ref}.`;
}

/** Lists the entries of a directory (for tests and the status line); empty when it does not exist. */
export const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
