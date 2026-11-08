import { randomUUID } from 'node:crypto';
import {
  DIRECT_UPLOAD_KINDS,
  type DirectUnavailableReason,
  type StorageKind,
  type StorageReference,
  type StorageWriteError,
  storageError,
} from '@aom/shared';

export interface DirectGrantInfo {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  chunkBytes: number | null;
  expiresAt: number;
}

export interface DirectOpenRequest {
  orgId: string;
  formId: string;
  submissionId: string;
  index: number;
  connectionId: string;
  folder: string;
  name: string;
  vars: Record<string, string>;
  ext: string;
  contentType: string;
  size: number;
  sha256: string;
  accepted: string[];
  pageOrigin: string;
  ttlMs: number;
  scan: { field: string; fileName: string };
}

export interface DirectUploadsDeps {
  /** The workstation holding the active connection of this org, or undefined. */
  lookup(
    orgId: string,
    connectionId: string,
  ): Promise<{ kind: StorageKind; workstationId: string } | undefined>;
  isOnline(workstationId: string): boolean;
  send(workstationId: string, type: string, payload: Record<string, unknown>): boolean;
  /** One log line: ids, sizes, outcome. Never a URL. */
  log(entry: { connectionId: string; op: string; outcome: string; latencyMs: number }): void;
  answerTimeoutMs?: number;
  /** How long the check of a staged object may take (the runner allows 10 minutes; it reads and scans the whole file). */
  verifyTimeoutMs?: number;
  now?: () => number;
}

/**
 * How long the check of a staged object may take before the server gives up on it. Just over the runner's own 10
 * minute bound (it reads and scans the whole file). The public routes use the same value to decide when a part that is
 * still being checked counts as stale.
 */
export const DIRECT_VERIFY_TIMEOUT_MS = 11 * 60_000;

type Waiter<T> = { workstationId: string; resolve: (v: T) => void };
type OpenAnswer = { ok: true; grant: DirectGrantInfo } | { ok: false; error: StorageWriteError };
type Verified = { ok: true; reference: StorageReference } | { ok: false; error: StorageWriteError };

/** Origins must be https and pass a per kind host check; anything else makes the destination refuse public files. */
export function validUploadOrigin(kind: StorageKind, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.origin !== origin || u.username || u.password) return false;
  const h = u.hostname;
  if (h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return false;
  switch (kind) {
    case 'google_drive':
      return origin === 'https://www.googleapis.com';
    case 'onedrive':
      return (
        h.endsWith('.sharepoint.com') ||
        h === 'api.onedrive.com' ||
        h.endsWith('.microsoftpersonalcontent.com')
      );
    case 's3':
      return true;
    default:
      return false;
  }
}

/**
 * The server's side of direct uploads (GWP-147): which upload host each cloud connection reported, and the grants that
 * are open. Everything lives in memory; a grant URL passes through `open` once and is never stored or logged.
 */
export class DirectUploads {
  private readonly origins = new Map<
    string,
    { workstationId: string; origin: string | null; reason: DirectUnavailableReason | null }
  >();
  private readonly grants = new Map<string, { workstationId: string; connectionId: string }>();
  private readonly openWait = new Map<string, Waiter<OpenAnswer>>();
  private readonly offsetWait = new Map<string, Waiter<number | null>>();
  private readonly verifyWait = new Map<string, Waiter<Verified>>();
  private readonly now: () => number;

  constructor(private readonly deps: DirectUploadsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** How long `finish` waits for the check; a part checked for longer than this is stale. */
  get verifyTimeoutMs(): number {
    return this.deps.verifyTimeoutMs ?? DIRECT_VERIFY_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------------------------ what the runners report
  onReport(
    workstationId: string,
    kinds: (connectionId: string) => StorageKind | undefined,
    list: Array<{
      connectionId: string;
      uploadOrigin: string | null;
      reason: DirectUnavailableReason | null;
    }>,
  ): void {
    for (const c of list) {
      const kind = kinds(c.connectionId);
      let origin = c.uploadOrigin;
      let reason = c.reason;
      if (origin && (!kind || !DIRECT_UPLOAD_KINDS.includes(kind) || !validUploadOrigin(kind, origin))) {
        origin = null;
        reason = 'probe_failed';
      }
      this.origins.set(c.connectionId, {
        workstationId,
        origin,
        reason: origin ? null : (reason ?? 'probe_failed'),
      });
    }
  }

  /** The reported upload origin of a connection, if its runner is still the one that reported it. */
  originOf(connectionId: string): string | null {
    const o = this.origins.get(connectionId);
    return o && this.deps.isOnline(o.workstationId) ? o.origin : null;
  }

  availabilityOf(
    connectionId: string,
    kind: StorageKind,
  ): { state: 'ready' | 'unavailable' | 'unknown'; reason: DirectUnavailableReason | null } | null {
    if (!DIRECT_UPLOAD_KINDS.includes(kind)) return null;
    const o = this.origins.get(connectionId);
    if (!o || !this.deps.isOnline(o.workstationId)) return { state: 'unknown', reason: null };
    return o.origin ? { state: 'ready', reason: null } : { state: 'unavailable', reason: o.reason };
  }

  // ------------------------------------------------------------------------------------ requests to a runner
  private wait<T>(
    map: Map<string, Waiter<T>>,
    id: string,
    workstationId: string,
    fallback: T,
    timeoutMs: number = this.deps.answerTimeoutMs ?? 20_000,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const t = setTimeout(() => {
        map.delete(id);
        resolve(fallback);
      }, timeoutMs);
      t.unref?.();
      map.set(id, {
        workstationId,
        resolve: (v) => {
          clearTimeout(t);
          map.delete(id);
          resolve(v);
        },
      });
    });
  }

  async open(
    req: DirectOpenRequest,
  ): Promise<
    { ok: true; grantId: string; grant: DirectGrantInfo } | { ok: false; error: StorageWriteError }
  > {
    const start = this.now();
    const conn = await this.deps.lookup(req.orgId, req.connectionId);
    const fail = (e: StorageWriteError) => {
      this.deps.log({
        connectionId: req.connectionId,
        op: 'grant',
        outcome: e.code,
        latencyMs: this.now() - start,
      });
      return { ok: false as const, error: e };
    };
    if (!conn) return fail(storageError('not_found', 'This storage connection does not exist.'));
    if (!this.deps.isOnline(conn.workstationId))
      return fail(storageError('runner_offline', "The firm's workstation is offline."));
    const expected = this.originOf(req.connectionId);
    if (!expected) return fail(storageError('invalid', 'This storage cannot take direct uploads.'));
    const grantId = randomUUID();
    const answer = this.wait<OpenAnswer>(this.openWait, grantId, conn.workstationId, {
      ok: false,
      error: storageError('timeout', 'The workstation did not answer in time.'),
    });
    const sent = this.deps.send(conn.workstationId, 'storage.grant.open', {
      grantId,
      connectionId: req.connectionId,
      folder: req.folder,
      name: req.name,
      vars: req.vars,
      ext: req.ext,
      contentType: req.contentType,
      size: req.size,
      sha256: req.sha256,
      accepted: req.accepted,
      pageOrigin: req.pageOrigin,
      ttlMs: req.ttlMs,
      submission: { orgId: req.orgId, formId: req.formId, submissionId: req.submissionId },
      scan: req.scan,
    });
    if (!sent) {
      this.openWait.get(grantId)?.resolve({ ok: false, error: storageError('runner_offline', 'offline') });
      return fail(storageError('runner_offline', "The firm's workstation is offline."));
    }
    const r = await answer;
    if (!r.ok) return fail(r.error);
    let host: string;
    try {
      host = new URL(r.grant.url).origin;
    } catch {
      host = '';
    }
    if (host !== expected) {
      // The runner answered with another host than it reported: the page CSP would block it, and it is not trusted.
      this.deps.send(conn.workstationId, 'storage.grant.cancel', { grantId, reason: 'blocked' });
      return fail(storageError('invalid', 'The upload address is not the expected one.'));
    }
    this.grants.set(grantId, { workstationId: conn.workstationId, connectionId: req.connectionId });
    this.deps.log({
      connectionId: req.connectionId,
      op: 'grant',
      outcome: 'ok',
      latencyMs: this.now() - start,
    });
    return { ok: true, grantId, grant: r.grant };
  }

  async offset(grantId: string): Promise<number | null> {
    const g = this.grants.get(grantId);
    if (!g || !this.deps.isOnline(g.workstationId)) return null;
    const answer = this.wait(this.offsetWait, grantId, g.workstationId, null as number | null);
    if (!this.deps.send(g.workstationId, 'storage.grant.status', { grantId })) {
      this.offsetWait.get(grantId)?.resolve(null);
      return null;
    }
    return answer;
  }

  /** Starts the check of the staged object. The answer comes through `verified`. */
  finish(
    grantId: string,
    body: { size: number; sha256: string; providerId?: string | undefined; etag?: string | undefined },
  ): Promise<Verified> {
    const g = this.grants.get(grantId);
    const start = this.now();
    const gone: Verified = {
      ok: false,
      error: storageError('runner_offline', "The firm's workstation is offline."),
    };
    if (!g)
      return Promise.resolve({
        ok: false,
        error: storageError('invalid', 'This upload is not open any more.'),
      });
    const timedOut: Verified = {
      ok: false,
      error: storageError('timeout', 'The storage did not answer in time.'),
    };
    const answer = this.wait(this.verifyWait, grantId, g.workstationId, timedOut, this.verifyTimeoutMs);
    const sent = this.deps.send(g.workstationId, 'storage.grant.finish', {
      grantId,
      size: body.size,
      sha256: body.sha256,
      ...(body.providerId ? { providerId: body.providerId } : {}),
      ...(body.etag ? { etag: body.etag } : {}),
    });
    if (!sent) {
      this.verifyWait.get(grantId)?.resolve(gone);
      this.grants.delete(grantId);
      return Promise.resolve(gone);
    }
    return answer.then((v) => {
      this.grants.delete(grantId);
      // Nothing came back in time: tell the runner to drop the staged object, so a late promotion is not left behind.
      if (v === timedOut)
        this.deps.send(g.workstationId, 'storage.grant.cancel', { grantId, reason: 'expired' });
      this.deps.log({
        connectionId: g.connectionId,
        op: 'verify',
        outcome: v.ok ? 'ok' : v.error.code,
        latencyMs: this.now() - start,
      });
      return v;
    });
  }

  cancel(grantId: string, reason: 'client_gone' | 'expired' | 'retry' | 'blocked' | 'shutdown'): void {
    const g = this.grants.get(grantId);
    if (!g) return;
    this.grants.delete(grantId);
    this.deps.send(g.workstationId, 'storage.grant.cancel', { grantId, reason });
  }

  // ------------------------------------------------------------------------------------ frames from the runner
  onResult(
    workstationId: string,
    m: {
      grantId: string;
      ok: boolean;
      grant?: DirectGrantInfo | undefined;
      error?: StorageWriteError | undefined;
    },
  ): void {
    const w = this.openWait.get(m.grantId);
    if (!w || w.workstationId !== workstationId) return;
    if (m.ok && m.grant) w.resolve({ ok: true, grant: m.grant });
    else
      w.resolve({
        ok: false,
        error: m.error ?? storageError('unavailable', 'The storage did not issue an upload address.'),
      });
  }

  onOffset(workstationId: string, grantId: string, offset: number | null): void {
    const w = this.offsetWait.get(grantId);
    if (w && w.workstationId === workstationId) w.resolve(offset);
  }

  onVerified(
    workstationId: string,
    m: {
      grantId: string;
      ok: boolean;
      reference?: StorageReference | undefined;
      error?: StorageWriteError | undefined;
    },
  ): void {
    const w = this.verifyWait.get(m.grantId);
    if (!w || w.workstationId !== workstationId) return;
    if (m.ok && m.reference) w.resolve({ ok: true, reference: m.reference });
    else
      w.resolve({
        ok: false,
        error: m.error ?? storageError('unavailable', 'The storage did not accept the file.'),
      });
  }

  /** The runner socket closed: what it reported is no longer true, and its waiting calls end as offline. */
  onDisconnect(workstationId: string): void {
    for (const [id, o] of this.origins) if (o.workstationId === workstationId) this.origins.delete(id);
    for (const [id, g] of this.grants) if (g.workstationId === workstationId) this.grants.delete(id);
    const off = storageError('runner_offline', "The firm's workstation is offline.");
    for (const [, w] of [...this.openWait])
      if (w.workstationId === workstationId) w.resolve({ ok: false, error: off });
    for (const [, w] of [...this.offsetWait]) if (w.workstationId === workstationId) w.resolve(null);
    for (const [, w] of [...this.verifyWait])
      if (w.workstationId === workstationId) w.resolve({ ok: false, error: off });
  }
}
