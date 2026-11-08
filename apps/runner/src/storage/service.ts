import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { type FileHandle, open, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import {
  checkUploadHead,
  CommandPayloadSchemas,
  type DirectUnavailableReason,
  healthStateForError,
  type RunnerToServer,
  renderStoragePath,
  UPLOAD_HEAD_BYTES,
  type SealedEnvelope,
  type ServerToRunner,
  STORAGE_DELETE_TIMEOUT_MS,
  STORAGE_WINDOW,
  type StorageErrorCode,
  type StorageHealthReport,
  type StorageKind,
  type StorageReference,
  type StorageWriteError,
  storageError,
} from '@aom/shared';
import type { z } from 'zod';
import type { ReplayCache } from '../integrations/seen.ts';
import { EnvelopeError, type RunnerKeys } from '../secrets/keys.ts';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';
import { fromNodeError } from './errors.ts';
import { GDriveConnector } from './gdrive.ts';
import { SubmissionJournal } from './journal.ts';
import { checkLocalRoot, LocalConnector } from './local.ts';
import {
  beginDeviceFlow,
  type DevicePrompt,
  type OAuthEnv,
  type OAuthProvider,
  oauthProvider,
  pollDeviceFlow,
  refreshTokens,
  revokeToken,
  type Tokens,
} from './oauth.ts';
import { OneDriveConnector, setupOneDrive } from './onedrive.ts';
import { PdfError, type PdfRenderer } from './pdf.ts';
import { checkS3Endpoint, S3Connector } from './s3.ts';
import { type ClamdClient, clamdClient, quarantine, type ScanVerdict } from './scan.ts';
import { KeyedMutex, StorageStore } from './store.ts';
import {
  type DirectCapable,
  type DirectGrant,
  type FetchLike,
  isDirectCapable,
  type Spooled,
  type StorageConnector,
  StorageError,
  type StoredConnection,
} from './types.ts';
import { type VaultAccess, VaultConnector } from './vault.ts';

export interface StorageServiceDeps {
  secretsDir: string;
  /** Spool directory for received files (`<data dir>/tmp/storage`): this workstation's disk. */
  spoolDir: string;
  keyOf: (name: string) => Buffer;
  keys: Pick<RunnerKeys, 'open'>;
  seen: Pick<ReplayCache, 'claim'>;
  workstationId: string;
  send: (type: RunnerToServer['type'], payload: Record<string, unknown>) => void;
  vaults: VaultAccess;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  oauthEnv?: OAuthEnv;
  /** Folders a local connection may not use (the runner's own data directory). */
  forbiddenRoots?: string[];
  log?: (line: string) => void;
  /** Warning and error lines (the scan verdicts); they fall back to `log`. */
  logWarn?: (line: string) => void;
  logError?: (line: string) => void;
  /** The malware scan of public form uploads. Absent or `enabled: false`: nothing contacts clamd. */
  uploadScan?: { enabled: boolean; clamd: string; timeoutMs: number; quarantineDir: string };
  /** Test seam: replaces the clamd client. */
  scanner?: ClamdClient;
  /** Where the per-submission journal is kept (`<data dir>/state/storage-submissions.json`). Absent: in memory only. */
  journalFile?: string;
  /** Renders the PDF copy of a form's answers. Absent: the copy is reported as unavailable. */
  pdf?: PdfRenderer;
  /** Bound for the probe of "Test connection". */
  probeTimeoutMs?: number;
  /** Origin of the public pages (for the S3 CORS check). Absent: the check is skipped. */
  pageOrigin?: string;
}

interface Transfer {
  id: string;
  connectionId: string;
  kind: StorageKind;
  file: string;
  handle?: FileHandle;
  hash: ReturnType<typeof createHash>;
  bytes: number;
  chunks: number;
  size: number;
  contentType: string;
  target: { folder: string[]; name: string };
  deadline: number;
  controller: AbortController;
  chain: Promise<void>;
  startedAt: number;
  finished: boolean;
  written?: { path: string; providerId?: string };
  submission?: { orgId: string; formId: string; submissionId: string };
  scan?: { field: string; fileName: string };
  derive?: { pdf: true };
  derivedWritten?: { path: string; providerId?: string };
  /** A direct-upload verification stands in for a transfer: its answer goes out as `storage.grant.verified`. */
  reply?: (r: { reference: StorageReference } | { error: StorageWriteError }) => void;
}

interface GrantState {
  id: string;
  connectionId: string;
  kind: StorageKind;
  g: DirectGrant;
  size: number;
  sha256: string;
  contentType: string;
  ext: string;
  accepted: string[];
  target: { folder: string[]; name: string };
  submission: { orgId: string; formId: string; submissionId: string };
  scan: { field: string; fileName: string };
  startedAt: number;
  used: boolean;
  closed: boolean;
  timer?: NodeJS.Timeout;
}

const GRANT_SWEEP_MS = 10 * 60_000;
const GRANT_KEEP_MS = 31 * 60_000;
const ORIGIN_TTL_MS = 10 * 60_000;

type Derived = NonNullable<Extract<RunnerToServer, { type: 'storage.write.result' }>['derived']>;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** True while the entry still holds the refresh token a refresh started from. */
const isCurrent = (c: StoredConnection | undefined, refreshToken: string): c is StoredConnection =>
  c?.auth?.type === 'oauth' && c.auth.refreshToken === refreshToken;

const abortAfter = (ms: number, parent: AbortSignal) =>
  AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, ms))]);

/** The workstation side of storage connections: credentials, sign-in, probe, remove and the write path. */
export class StorageService {
  private readonly store: StorageStore;
  private readonly mutex = new KeyedMutex();
  private readonly transfers = new Map<string, Transfer>();
  private readonly grants = new Map<string, GrantState>();
  private readonly origins = new Map<
    string,
    { at: number; origin: string | null; reason: DirectUnavailableReason | null }
  >();
  private sweepTimer?: NodeJS.Timeout;
  private readonly flows = new Map<
    string,
    { sessionId: string; connectionId: string; ctl: AbortController }
  >();
  private readonly health = new Map<string, StorageHealthReport>();
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly journal: SubmissionJournal;
  private scannerInstance?: ClamdClient;

  constructor(private readonly deps: StorageServiceDeps) {
    this.store = new StorageStore(deps.secretsDir, deps.keyOf);
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.journal = new SubmissionJournal(
      deps.journalFile ?? join(deps.spoolDir, '..', 'storage-submissions.json'),
      this.now,
    );
    // A spool left by a crash is deleted: nothing of a client's file stays behind.
    try {
      rmSync(deps.spoolDir, { recursive: true, force: true });
      mkdirSync(deps.spoolDir, { recursive: true, mode: 0o700 });
    } catch {
      // the spool is created again on the first write
    }
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private logWarn(line: string): void {
    (this.deps.logWarn ?? this.deps.log)?.(line);
  }

  private logError(line: string): void {
    (this.deps.logError ?? this.deps.log)?.(line);
  }

  private scanOn(): boolean {
    return this.deps.uploadScan?.enabled === true;
  }

  /** The clamd client; built on first use, so nothing exists while the setting is off. */
  private get scanner(): ClamdClient {
    if (!this.scannerInstance)
      this.scannerInstance =
        this.deps.scanner ?? clamdClient((this.deps.uploadScan as { clamd: string }).clamd);
    return this.scannerInstance;
  }

  // ------------------------------------------------------------------------------------------------ reports

  private report(
    id: string,
    state: StorageHealthReport['state'],
    error?: StorageWriteError,
    note?: string,
  ): StorageHealthReport {
    const h: StorageHealthReport = {
      connectionId: id,
      state,
      ...(error ? { errorCode: error.code, message: error.message } : note ? { message: note } : {}),
      checkedAt: new Date(this.now()).toISOString(),
    };
    this.health.set(id, h);
    this.deps.send('storage.report', { connections: [h] });
    return h;
  }

  /** One report with every connection held here (after `welcome` and after a sync). */
  reportAll(): void {
    const list: StorageHealthReport[] = this.store.list().map(([id, c]) => ({
      connectionId: id,
      state: c.needsReauth ? 'needs_reauth' : (this.health.get(id)?.state ?? 'connected'),
      ...(c.needsReauth
        ? { errorCode: 'auth_expired' as const, message: 'The sign-in expired: reconnect this storage.' }
        : {}),
      checkedAt: new Date(this.now()).toISOString(),
    }));
    if (list.length) this.deps.send('storage.report', { connections: list.slice(0, 100) });
  }

  // ------------------------------------------------------------------------------------------------ connectors

  private tokenFn(id: string) {
    return (force: boolean) =>
      this.mutex.run(id, async () => {
        const conn = this.store.get(id);
        if (!conn || conn.auth?.type !== 'oauth')
          throw new StorageError('not_found', 'This storage is not set up on this workstation.');
        if (conn.needsReauth)
          throw new StorageError('auth_expired', 'The sign-in expired: reconnect this storage.');
        const a = conn.auth;
        if (!force && a.expiresAt - 60_000 > this.now()) return a.accessToken;
        const p = oauthProvider(conn.kind as 'onedrive' | 'google_drive', this.deps.oauthEnv ?? {});
        if (!p)
          throw new StorageError('invalid', 'This runner has no sign-in app configured for this storage.');
        let t: Tokens;
        try {
          t = await refreshTokens(p, a.refreshToken, this.fetchFn, this.now());
        } catch (err) {
          // The entry may have been removed or replaced while the refresh was running: write nothing back.
          const cur = this.store.get(id);
          if (!isCurrent(cur, a.refreshToken)) return this.superseded(cur);
          if (err instanceof StorageError && err.code === 'auth_expired') {
            this.store.put(id, { ...cur, needsReauth: true });
            this.report(id, 'needs_reauth', storageError('auth_expired', err.message));
          }
          throw err;
        }
        // No await between this read and the put, so a removal cannot slip in between.
        const cur = this.store.get(id);
        if (!isCurrent(cur, a.refreshToken)) {
          // Removed: a rotated refresh token nobody will ever hold is revoked, best effort and not awaited
          // (revokeToken never rejects; OneDrive has no revoke endpoint, so nothing happens there).
          if (!cur && t.refreshToken !== a.refreshToken) void revokeToken(p, t.refreshToken, this.fetchFn);
          return this.superseded(cur);
        }
        this.store.put(id, { ...cur, auth: { type: 'oauth', ...t, account: t.account ?? a.account } });
        return t.accessToken;
      });
  }

  /** The entry a refresh started from is gone or was replaced by a new sign-in. */
  private superseded(cur: StoredConnection | undefined): string {
    if (cur?.auth?.type === 'oauth' && !cur.needsReauth) return cur.auth.accessToken;
    if (cur?.needsReauth)
      throw new StorageError('auth_expired', 'The sign-in expired: reconnect this storage.');
    throw new StorageError('not_found', 'This storage is not set up on this workstation.');
  }

  private connector(id: string, conn: StoredConnection): StorageConnector {
    const c = conn.config;
    switch (c.kind) {
      case 'onedrive':
        return new OneDriveConnector(c, this.tokenFn(id), this.fetchFn);
      case 'google_drive':
        return new GDriveConnector(c, this.tokenFn(id), this.fetchFn, (folderId) => {
          const cur = this.store.get(id);
          if (cur?.config.kind === 'google_drive')
            this.store.put(id, { ...cur, config: { ...cur.config, baseFolderId: folderId } });
        });
      case 's3': {
        if (conn.auth?.type !== 'keys')
          throw new StorageError('auth_expired', 'The access keys are missing: enter them again.');
        return new S3Connector(c, conn.auth, this.fetchFn);
      }
      case 'local':
        return new LocalConnector(c.root, this.deps.forbiddenRoots);
      case 'vault':
        return new VaultConnector(this.deps.vaults, c.vaultId, c.folder);
    }
  }

  private typed(err: unknown): StorageWriteError {
    const e = err instanceof StorageError ? err : fromNodeError(err);
    return storageError(e.code, e.message);
  }

  // ------------------------------------------------------------------------------------------------ commands

  async handle(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      switch (command) {
        case 'storage.connect':
          return await this.connect(CommandPayloadSchemas['storage.connect'].parse(payload));
        case 'storage.auth.begin':
          return await this.authBegin(CommandPayloadSchemas['storage.auth.begin'].parse(payload));
        case 'storage.auth.cancel': {
          const { sessionId } = CommandPayloadSchemas['storage.auth.cancel'].parse(payload);
          for (const f of this.flows.values()) if (f.sessionId === sessionId) f.ctl.abort();
          return {};
        }
        case 'storage.test':
          return await this.test(CommandPayloadSchemas['storage.test'].parse(payload).connectionId);
        case 'storage.remove':
          return await this.remove(CommandPayloadSchemas['storage.remove'].parse(payload).connectionId);
        case 'storage.sync':
          return await this.sync(CommandPayloadSchemas['storage.sync'].parse(payload).connectionIds);
        case 'storage.discard': {
          const { submissionId } = CommandPayloadSchemas['storage.discard'].parse(payload);
          return { discarded: await this.rollbackSubmission(submissionId) };
        }
        default:
          return { error: storageError('invalid', 'This command is not supported by this runner version.') };
      }
    } catch (err) {
      return { error: this.typed(err) };
    }
  }

  private async connect(
    p: z.infer<(typeof CommandPayloadSchemas)['storage.connect']>,
  ): Promise<Record<string, unknown>> {
    let plain: { fields: Record<string, string>; ref: string; exp: number };
    try {
      plain = this.deps.keys.open(
        p.envelope as SealedEnvelope,
        {
          workstationId: this.deps.workstationId,
          ref: p.requestId,
          kind: 'storage',
          instance: p.connectionId,
          op: 'connect',
        },
        this.now(),
      );
    } catch (err) {
      if (err instanceof EnvelopeError) return { error: storageError('invalid', err.message) };
      throw err;
    }
    if (!this.deps.seen.claim(plain.ref, plain.exp))
      return { error: storageError('invalid', 'These values were already used: enter them again.') };
    const f = plain.fields;
    for (const v of Object.values(f)) registerSecret(v);
    try {
      let conn: StoredConnection;
      const savedAt = new Date(this.now()).toISOString();
      if (p.kind === 's3') {
        checkS3Endpoint(f.endpoint ?? '');
        if (!f.bucket || !f.region || !f.accessKeyId || !f.secretAccessKey)
          throw new StorageError('invalid', 'The endpoint, region, bucket and keys are all needed.');
        conn = {
          kind: 's3',
          savedAt,
          config: {
            kind: 's3',
            endpoint: f.endpoint ?? '',
            region: f.region,
            bucket: f.bucket,
            prefix: (f.prefix ?? '').replace(/^\/+|\/+$/g, ''),
            pathStyle: f.pathStyle === 'true',
          },
          auth: {
            type: 'keys',
            accessKeyId: f.accessKeyId,
            secretAccessKey: f.secretAccessKey,
            ...(f.sessionToken ? { sessionToken: f.sessionToken } : {}),
          },
        };
      } else if (p.kind === 'local') {
        checkLocalRoot(f.root ?? '', this.deps.forbiddenRoots);
        conn = { kind: 'local', savedAt, config: { kind: 'local', root: f.root ?? '' } };
      } else if (p.kind === 'vault') {
        if (!f.vaultId) throw new StorageError('invalid', 'Choose a vault.');
        conn = {
          kind: 'vault',
          savedAt,
          config: { kind: 'vault', vaultId: f.vaultId, folder: (f.folder ?? '').replace(/^\/+|\/+$/g, '') },
        };
      } else
        throw new StorageError('invalid', 'This kind signs in with the sign-in code, not with typed values.');
      const probe = await this.probeOf(p.connectionId, conn);
      if (probe)
        return { health: this.report(p.connectionId, healthStateForError(probe.code), probe), error: probe };
      this.store.put(p.connectionId, conn);
      this.origins.delete(p.connectionId);
      const health = await this.reportWithScan(p.connectionId);
      void this.reportDirect().catch(() => undefined);
      return { health };
    } catch (err) {
      const e = this.typed(err);
      return { health: this.report(p.connectionId, healthStateForError(e.code), e), error: e };
    } finally {
      for (const v of Object.values(f)) unregisterSecret(v);
    }
  }

  /** Runs the probe with a bound; returns the typed error or undefined. */
  private async probeOf(id: string, conn: StoredConnection): Promise<StorageWriteError | undefined> {
    const ctl = new AbortController();
    const signal = abortAfter(this.deps.probeTimeoutMs ?? 30_000, ctl.signal);
    try {
      await this.connector(id, conn).probe(signal);
      return undefined;
    } catch (err) {
      return this.typed(
        signal.aborted && !(err instanceof StorageError)
          ? new StorageError('timeout', 'The storage did not answer in time.')
          : err,
      );
    }
  }

  /** Connected, plus the clamd line when the upload scan is on (and nothing about clamd when it is off). */
  private async reportWithScan(id: string): Promise<StorageHealthReport> {
    if (!this.scanOn()) return this.report(id, 'connected');
    if (await this.scanner.ping(3000))
      return this.report(id, 'connected', undefined, 'Malware scan: clamd reachable.');
    return this.report(
      id,
      'unavailable',
      storageError(
        'scan_unavailable',
        `Storage reachable, but the malware scan is not: clamd not reachable at ${this.deps.uploadScan?.clamd}.`,
      ),
    );
  }

  private async test(id: string): Promise<Record<string, unknown>> {
    const conn = this.store.get(id);
    if (!conn) {
      const e = storageError('not_found', 'This storage is not set up on this workstation.');
      return { health: this.report(id, 'not_on_workstation', e), error: e };
    }
    if (conn.needsReauth) {
      const e = storageError('auth_expired', 'The sign-in expired: reconnect this storage.');
      return { health: this.report(id, 'needs_reauth', e), error: e };
    }
    const err = await this.probeOf(id, conn);
    if (err) return { health: this.report(id, healthStateForError(err.code), err), error: err };
    this.origins.delete(id);
    const health = await this.reportWithScan(id);
    void this.reportDirect().catch(() => undefined);
    return { health };
  }

  private async remove(id: string): Promise<Record<string, unknown>> {
    for (const f of this.flows.values()) if (f.connectionId === id) f.ctl.abort();
    for (const t of [...this.transfers.values()])
      if (t.connectionId === id) void this.abortTransfer(t, 'shutdown');
    await Promise.all(
      [...this.grants.values()].filter((g) => g.connectionId === id).map((g) => this.cancelStaged(g)),
    );
    this.origins.delete(id);
    const conn = this.store.get(id);
    const removed = this.store.remove(id);
    this.health.delete(id);
    if (conn?.auth?.type === 'oauth' && conn.kind === 'google_drive') {
      const p = oauthProvider('google_drive', this.deps.oauthEnv ?? {});
      if (p) await revokeToken(p, conn.auth.refreshToken, this.fetchFn);
    }
    return { removed };
  }

  /** Deletes local entries the server no longer lists (a removal made while this workstation was offline). */
  private async sync(keep: string[]): Promise<Record<string, unknown>> {
    const removed: string[] = [];
    for (const [id] of this.store.list()) {
      if (keep.includes(id)) continue;
      await this.remove(id);
      removed.push(id);
    }
    this.reportAll();
    return { removed };
  }

  // ------------------------------------------------------------------------------------------------ sign-in

  private async authBegin(
    p: z.infer<(typeof CommandPayloadSchemas)['storage.auth.begin']>,
  ): Promise<Record<string, unknown>> {
    const provider = oauthProvider(p.kind, this.deps.oauthEnv ?? {});
    if (!provider)
      return {
        error: storageError(
          'invalid',
          `This runner has no ${p.kind === 'onedrive' ? 'Microsoft' : 'Google'} app configured; see RUNNER.md.`,
        ),
      };
    for (const f of this.flows.values()) if (f.connectionId === p.connectionId) f.ctl.abort();
    const prompt = await beginDeviceFlow(provider, this.fetchFn, this.now());
    const ctl = new AbortController();
    this.flows.set(p.connectionId, { sessionId: p.sessionId, connectionId: p.connectionId, ctl });
    void this.finishSignIn(provider, p, prompt, ctl);
    return {
      prompt: {
        userCode: prompt.userCode,
        verificationUri: prompt.verificationUri,
        expiresAt: new Date(prompt.expiresAt).toISOString(),
      },
    };
  }

  private async finishSignIn(
    provider: OAuthProvider,
    p: z.infer<(typeof CommandPayloadSchemas)['storage.auth.begin']>,
    prompt: DevicePrompt,
    ctl: AbortController,
  ): Promise<void> {
    const id = p.connectionId;
    const tell = (state: 'done' | 'failed' | 'expired' | 'cancelled', error?: StorageWriteError) =>
      this.deps.send('storage.auth', {
        sessionId: p.sessionId,
        connectionId: id,
        state,
        ...(error ? { error } : {}),
      });
    try {
      this.deps.send('storage.auth', {
        sessionId: p.sessionId,
        connectionId: id,
        state: 'awaiting_user',
        prompt: {
          userCode: prompt.userCode,
          verificationUri: prompt.verificationUri,
          expiresAt: new Date(prompt.expiresAt).toISOString(),
        },
      });
      const t = await pollDeviceFlow(provider, prompt, this.fetchFn, {
        signal: ctl.signal,
        now: this.now,
        sleep: this.deps.sleep ?? defaultSleep,
      });
      registerSecret(t.accessToken);
      registerSecret(t.refreshToken);
      const existing = this.store.get(id);
      const setupSignal = abortAfter(60_000, ctl.signal);
      const tokenOnce = async () => t.accessToken;
      let config: StoredConnection['config'];
      if (existing && existing.kind === p.kind && !p.options.siteUrl && !p.options.baseFolder)
        config = existing.config;
      else if (p.kind === 'onedrive') {
        const baseFolder = p.options.baseFolder || 'Guildwise uploads';
        const s = await setupOneDrive(
          this.fetchFn,
          tokenOnce,
          { ...(p.options.siteUrl ? { siteUrl: p.options.siteUrl } : {}), baseFolder },
          setupSignal,
        );
        config = {
          kind: 'onedrive',
          ...(p.options.siteUrl ? { siteUrl: p.options.siteUrl } : {}),
          baseFolder,
          ...s,
        };
      } else {
        const baseFolder = p.options.baseFolder || 'Guildwise uploads';
        const g = new GDriveConnector({ baseFolder }, tokenOnce, this.fetchFn);
        config = { kind: 'google_drive', baseFolder, baseFolderId: await g.setup(setupSignal) };
      }
      this.store.put(id, {
        kind: p.kind,
        savedAt: new Date(this.now()).toISOString(),
        config,
        auth: { type: 'oauth', ...t },
      });
      this.report(id, 'connected');
      tell('done');
    } catch (err) {
      if (ctl.signal.aborted) {
        tell('cancelled');
      } else {
        const e = this.typed(err);
        const isExpiry = err instanceof StorageError && err.code === 'timeout';
        this.report(id, this.store.get(id) ? 'needs_reauth' : healthStateForError(e.code), e);
        tell(isExpiry ? 'expired' : 'failed', e);
      }
    } finally {
      if (this.flows.get(id)?.ctl === ctl) this.flows.delete(id);
    }
  }

  // ------------------------------------------------------------------------------------------------ writes

  /** Handles one `storage.write.*` message from the server. */
  onMessage(msg: ServerToRunner): void {
    switch (msg.type) {
      case 'storage.write.open':
        void this.open(msg);
        break;
      case 'storage.write.chunk': {
        const t = this.transfers.get(msg.transferId);
        if (!t) break;
        t.chain = t.chain.then(() => this.chunk(t, msg.seq, msg.data));
        break;
      }
      case 'storage.write.end': {
        const t = this.transfers.get(msg.transferId);
        if (!t) break;
        t.chain = t.chain.then(() => this.end(t, msg));
        break;
      }
      case 'storage.write.abort': {
        const t = this.transfers.get(msg.transferId);
        if (t) void this.abortTransfer(t, msg.reason);
        break;
      }
      case 'storage.delete':
        void this.deleteStored(msg);
        break;
      case 'storage.grant.open':
        void this.grantOpen(msg);
        break;
      case 'storage.grant.status':
        void this.grantStatus(msg.grantId);
        break;
      case 'storage.grant.finish':
        void this.grantFinish(msg);
        break;
      case 'storage.grant.cancel':
        void this.grantCancel(msg.grantId);
        break;
      default:
        break;
    }
  }

  /**
   * `storage.delete`: removes one file the server wrote earlier, confined to the destination by the connector.
   * "The file is not there" is `result: 'not_found'` (success); an `error` with code `not_found` means the storage
   * itself is missing. Logs a path hash, never the path.
   */
  private async deleteStored(m: Extract<ServerToRunner, { type: 'storage.delete' }>): Promise<void> {
    const start = this.now();
    const conn = this.store.get(m.connectionId);
    const answer = (r: { result: 'deleted' | 'not_found' } | { error: StorageWriteError }): void => {
      this.deps.send('storage.delete.result', { requestId: m.requestId, ok: 'result' in r, ...r });
      const hash = createHash('sha256').update(m.path).digest('hex').slice(0, 12);
      this.log(
        `storage.delete conn=${m.connectionId} kind=${conn?.kind ?? '-'} submission=${m.submissionId ?? '-'} ` +
          `path#=${hash} ${'result' in r ? r.result : r.error.code} ${this.now() - start}ms`,
      );
    };
    if (!conn)
      return answer({ error: storageError('not_found', 'This storage is not set up on this workstation.') });
    if (conn.needsReauth)
      return answer({ error: storageError('auth_expired', 'The sign-in expired: reconnect this storage.') });
    try {
      const r = await this.connector(m.connectionId, conn).deleteFile(
        { path: m.path, ...(m.providerId ? { providerId: m.providerId } : {}) },
        abortAfter(STORAGE_DELETE_TIMEOUT_MS - 2_000, new AbortController().signal),
      );
      if (m.submissionId) this.dropJournalEntry(m.submissionId, m.connectionId, m.path);
      answer({ result: r });
    } catch (err) {
      answer({ error: this.typed(err) });
    }
  }

  private result(
    id: string,
    r: { reference: StorageReference; derived?: Derived } | { error: StorageWriteError },
  ): void {
    this.deps.send('storage.write.result', {
      transferId: id,
      ok: 'reference' in r,
      ...r,
    });
  }

  private answer(t: Transfer, r: { reference: StorageReference } | { error: StorageWriteError }): void {
    if (t.reply) t.reply(r);
    else this.result(t.id, r);
  }

  private async open(m: Extract<ServerToRunner, { type: 'storage.write.open' }>): Promise<void> {
    const conn = this.store.get(m.connectionId);
    const fail = (e: StorageWriteError) => {
      this.log(`storage.write conn=${m.connectionId} kind=${conn?.kind ?? '-'} size=${m.size} ${e.code} 0ms`);
      this.result(m.transferId, { error: e });
    };
    if (!conn) return fail(storageError('not_found', 'This storage is not set up on this workstation.'));
    if (conn.needsReauth)
      return fail(storageError('auth_expired', 'The sign-in expired: reconnect this storage.'));
    const rendered = renderStoragePath({ folder: m.folder, name: m.name }, m.vars, m.ext);
    if (!rendered.ok) return fail(storageError('invalid', rendered.error));
    try {
      if (conn.auth?.type === 'oauth') await this.tokenFn(m.connectionId)(false);
      mkdirSync(this.deps.spoolDir, { recursive: true, mode: 0o700 });
      const file = join(this.deps.spoolDir, `${m.transferId}.part`);
      const handle = await open(file, 'wx', 0o600);
      const ctl = new AbortController();
      const t: Transfer = {
        id: m.transferId,
        connectionId: m.connectionId,
        kind: conn.kind,
        file,
        handle,
        hash: createHash('sha256'),
        bytes: 0,
        chunks: 0,
        size: m.size,
        contentType: m.contentType,
        target: { folder: rendered.folder, name: rendered.name },
        deadline: this.now() + m.deadlineMs,
        controller: ctl,
        chain: Promise.resolve(),
        startedAt: this.now(),
        finished: false,
        ...(m.submission ? { submission: m.submission } : {}),
        ...(m.scan ? { scan: m.scan } : {}),
        ...(m.derive ? { derive: m.derive } : {}),
      };
      this.transfers.set(t.id, t);
      this.deps.send('storage.write.credit', { transferId: t.id, upTo: STORAGE_WINDOW });
    } catch (err) {
      fail(this.typed(err));
    }
  }

  private async chunk(t: Transfer, seq: number, data: string): Promise<void> {
    if (t.finished) return;
    if (seq !== t.chunks)
      return void (await this.fail(t, storageError('invalid', 'The upload arrived out of order.')));
    const buf = Buffer.from(data, 'base64');
    t.bytes += buf.length;
    if (t.bytes > t.size)
      return void (await this.fail(t, storageError('too_large', 'More data arrived than announced.')));
    try {
      await t.handle?.write(buf);
    } catch (err) {
      return void (await this.fail(t, this.typed(err)));
    }
    t.hash.update(buf);
    t.chunks++;
    if (t.chunks % 4 === 0)
      this.deps.send('storage.write.credit', { transferId: t.id, upTo: t.chunks + STORAGE_WINDOW });
  }

  private async end(t: Transfer, m: { chunks: number; size: number; sha256: string }): Promise<void> {
    if (t.finished) return;
    const sha = t.hash.digest('hex');
    if (m.chunks !== t.chunks || m.size !== t.bytes || t.bytes !== t.size || m.sha256 !== sha)
      return void (await this.fail(t, storageError('invalid', 'The file did not arrive intact: try again.')));
    await t.handle?.close();
    t.handle = undefined;
    const conn = this.store.get(t.connectionId);
    if (!conn)
      return void (await this.fail(
        t,
        storageError('not_found', 'This storage is not set up on this workstation.'),
      ));
    const spooled: Spooled = { file: t.file, size: t.bytes, sha256: sha, contentType: t.contentType };
    const signal = abortAfter(t.deadline - this.now(), t.controller.signal);
    if (t.scan && t.submission && this.scanOn()) {
      const cfg = this.deps.uploadScan as NonNullable<StorageServiceDeps['uploadScan']>;
      const unusable = this.quarantineInsideDestination(cfg.quarantineDir);
      const timeout = Math.min(cfg.timeoutMs, t.deadline - this.now());
      const v: ScanVerdict = unusable
        ? { kind: 'failed', reason: unusable }
        : await this.scanner.scanFile(t.file, abortAfter(timeout, t.controller.signal));
      if (t.finished) return void (await this.cleanup(t));
      if (v.kind === 'infected')
        return void (await this.reject(t, 'malware_detected', v, sha, cfg.quarantineDir));
      if (v.kind === 'failed')
        return void (await this.reject(t, 'scan_unavailable', v, sha, cfg.quarantineDir));
    }
    try {
      const written = await this.connector(t.connectionId, conn).put(t.target, spooled, signal);
      t.written = written;
      if (t.submission && !t.finished)
        this.journal.add({
          submissionId: t.submission.submissionId,
          connectionId: t.connectionId,
          path: written.path,
          ...(written.providerId ? { providerId: written.providerId } : {}),
        });
      if (t.finished) {
        // Aborted while the put was running: the caller was told it failed, so the file goes again.
        await this.deleteWritten(t, conn);
        return;
      }
      const derived = t.derive?.pdf && t.submission ? await this.derivePdf(t, conn, written) : undefined;
      if (t.finished) {
        // Aborted while the PDF was being made: the html and the pdf both go.
        await this.deleteWritten(t, conn);
        return;
      }
      t.finished = true;
      const reference: StorageReference = {
        v: 1,
        connectionId: t.connectionId,
        kind: t.kind,
        path: written.path,
        ...(written.providerId ? { providerId: written.providerId } : {}),
        size: t.bytes,
        sha256: sha,
        contentType: t.contentType,
        writtenAt: new Date(this.now()).toISOString(),
      };
      this.log(
        `storage.write conn=${t.connectionId} kind=${t.kind} size=${t.bytes} ok ${this.now() - t.startedAt}ms`,
      );
      this.result(t.id, { reference, ...(derived ? { derived } : {}) });
      await this.cleanup(t);
    } catch (err) {
      if (t.finished) return void (await this.cleanup(t));
      const e =
        signal.aborted && !(err instanceof StorageError)
          ? storageError('timeout', 'The storage did not answer in time.')
          : this.typed(err);
      await this.fail(t, e);
    }
  }

  private async deleteWritten(t: Transfer, conn: StoredConnection): Promise<void> {
    for (const w of [t.written, t.derivedWritten]) {
      if (!w) continue;
      await this.deleteRef(t.connectionId, conn, w);
      if (t.submission) this.dropJournalEntry(t.submission.submissionId, t.connectionId, w.path);
    }
  }

  /**
   * Makes the PDF copy of the answers HTML that was just written and puts it next to it. Whatever happens,
   * the html write stays a success: the outcome goes back in `derived`. One log line, with no content.
   */
  private async derivePdf(
    t: Transfer,
    conn: StoredConnection,
    written: { path: string; providerId?: string },
  ): Promise<Derived> {
    const sub = t.submission as NonNullable<Transfer['submission']>;
    const started = this.now();
    const pdfFile = join(this.deps.spoolDir, `${t.id}.pdf`);
    let code: 'pdf_unavailable' | 'pdf_failed' | 'pdf_timeout' | 'pdf_write_failed' | undefined;
    let reference: StorageReference | undefined;
    try {
      const budget = Math.min(20_000, t.deadline - this.now() - 3_000);
      if (budget < 2_000) throw new PdfError('pdf_timeout');
      if (!this.deps.pdf) throw new PdfError('pdf_unavailable');
      const html = await readFile(t.file, 'utf8');
      const signal = abortAfter(budget, t.controller.signal);
      const bytes = await this.deps.pdf.render(html, signal);
      await writeFile(pdfFile, bytes, { mode: 0o600 });
      const sha = createHash('sha256').update(bytes).digest('hex');
      const name = `${basename(written.path).replace(/\.html?$/i, '')}.pdf`;
      try {
        const put = await this.connector(t.connectionId, conn).put(
          { folder: t.target.folder, name },
          { file: pdfFile, size: bytes.length, sha256: sha, contentType: 'application/pdf' },
          abortAfter(Math.max(2_000, t.deadline - this.now()), t.controller.signal),
        );
        t.derivedWritten = put;
        this.journal.add({
          submissionId: sub.submissionId,
          connectionId: t.connectionId,
          path: put.path,
          ...(put.providerId ? { providerId: put.providerId } : {}),
        });
        reference = {
          v: 1,
          connectionId: t.connectionId,
          kind: t.kind,
          path: put.path,
          ...(put.providerId ? { providerId: put.providerId } : {}),
          size: bytes.length,
          sha256: sha,
          contentType: 'application/pdf',
          writtenAt: new Date(this.now()).toISOString(),
        };
      } catch {
        code = 'pdf_write_failed';
      }
    } catch (err) {
      code = err instanceof PdfError ? err.code : 'pdf_failed';
    } finally {
      await rm(pdfFile, { force: true });
    }
    const line = `storage.pdf conn=${t.connectionId} submission=${sub.submissionId} transfer=${t.id} ${
      reference ? 'ok' : code
    } size=${reference?.size ?? 0} ${this.now() - started}ms`;
    if (reference) {
      this.log(line);
      return { pdf: { ok: true, reference } };
    }
    this.logWarn(line);
    return { pdf: { ok: false, code: code ?? 'pdf_failed' } };
  }

  private dropJournalEntry(submissionId: string, connectionId: string, path: string): void {
    const e = this.journal.list(submissionId).find((x) => x.connectionId === connectionId && x.path === path);
    if (e) this.journal.drop(submissionId, e);
  }

  /** Best-effort delete of one written file (ids for OneDrive and Google Drive, paths for the rest). */
  private async deleteRef(
    connectionId: string,
    conn: StoredConnection,
    w: { path: string; providerId?: string },
  ): Promise<boolean> {
    try {
      await this.connector(connectionId, conn).delete(
        w.providerId && conn.kind !== 's3' && conn.kind !== 'local' && conn.kind !== 'vault'
          ? `id:${w.providerId}`
          : w.path,
        AbortSignal.timeout(10_000),
      );
      return true;
    } catch {
      // best effort
      return false;
    }
  }

  /** Deletes everything this workstation wrote for one submission. Idempotent. Returns how many files went. */
  private async rollbackSubmission(submissionId: string): Promise<number> {
    let n = 0;
    for (const e of this.journal.list(submissionId)) {
      const conn = this.store.get(e.connectionId);
      if (!conn) {
        this.logWarn(
          `storage.scan rollback conn=${e.connectionId} submission=${submissionId}: connection not found`,
        );
        continue;
      }
      const ok = await this.deleteRef(e.connectionId, conn, {
        path: e.path,
        ...(e.providerId ? { providerId: e.providerId } : {}),
      });
      if (ok) n++;
      else
        this.logWarn(
          `storage.scan rollback conn=${e.connectionId} submission=${submissionId}: delete failed`,
        );
    }
    this.journal.drop(submissionId);
    return n;
  }

  /** A reason when the quarantine folder lies inside a local storage destination, else undefined. */
  private quarantineInsideDestination(dir: string): string | undefined {
    const q = resolve(dir) + sep;
    for (const [, c] of this.store.list()) {
      if (c.config.kind !== 'local') continue;
      const root = resolve(c.config.root) + sep;
      if (q.startsWith(root) || root.startsWith(q))
        return 'quarantine folder is inside a storage destination';
    }
    return undefined;
  }

  /** The scan said no: take the whole submission back first, then keep the file (infected only) and answer. */
  private async reject(
    t: Transfer,
    code: 'malware_detected' | 'scan_unavailable',
    v: Exclude<ScanVerdict, { kind: 'clean' }>,
    sha: string,
    quarantineDir: string,
  ): Promise<void> {
    t.finished = true;
    const sub = t.submission as NonNullable<Transfer['submission']>;
    const scan = t.scan as NonNullable<Transfer['scan']>;
    await this.rollbackSubmission(sub.submissionId);
    if (v.kind === 'infected') {
      const now = new Date(this.now());
      let kept = 'none';
      try {
        const q = await quarantine(
          t.file,
          quarantineDir,
          {
            originalName: scan.fileName,
            size: t.bytes,
            sha256: sha,
            signature: v.signature,
            formId: sub.formId,
            submissionId: sub.submissionId,
            transferId: t.id,
            orgId: sub.orgId,
            field: scan.field,
          },
          now,
        );
        kept = `${q.base}.bin`;
        if (q.warning) this.logWarn(`storage.scan ${q.warning}`);
      } catch (err) {
        this.logError(
          `storage.scan quarantine failed submission=${sub.submissionId} transfer=${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.logWarn(
        `storage.scan infected conn=${t.connectionId} form=${sub.formId} submission=${sub.submissionId} transfer=${t.id} org=${sub.orgId} field=${scan.field} name=${scan.fileName} size=${t.bytes} sha256=${sha} signature=${v.signature} quarantined=${kept}`,
      );
      this.answer(t, { error: storageError('malware_detected', 'The file failed the security check.') });
    } else {
      this.logError(
        `storage.scan failed conn=${t.connectionId} submission=${sub.submissionId} transfer=${t.id} reason=${v.reason}`,
      );
      this.answer(t, { error: storageError('scan_unavailable', 'The file could not be scanned.') });
    }
    this.log(
      `storage.write conn=${t.connectionId} kind=${t.kind} size=${t.size} ${code} ${this.now() - t.startedAt}ms`,
    );
    await this.cleanup(t);
  }

  private async fail(t: Transfer, e: StorageWriteError): Promise<void> {
    if (t.finished) return;
    t.finished = true;
    this.log(
      `storage.write conn=${t.connectionId} kind=${t.kind} size=${t.size} ${e.code} ${this.now() - t.startedAt}ms`,
    );
    this.result(t.id, { error: e });
    await this.cleanup(t);
  }

  private async abortTransfer(t: Transfer, _reason: string): Promise<void> {
    const wasFinished = t.finished;
    t.finished = true;
    t.controller.abort();
    if (!wasFinished)
      this.log(
        `storage.write conn=${t.connectionId} kind=${t.kind} size=${t.size} aborted ${this.now() - t.startedAt}ms`,
      );
    await this.cleanup(t);
  }

  private async cleanup(t: Transfer): Promise<void> {
    if (t.written && !t.finished) return;
    this.transfers.delete(t.id);
    try {
      await t.handle?.close();
    } catch {
      // closed already
    }
    await rm(t.file, { force: true });
  }


  // ------------------------------------------------------------------------------------------------ direct uploads

  private grantLog(gs: Pick<GrantState, 'connectionId' | 'kind' | 'size' | 'startedAt'>, outcome: string): void {
    // Never the URL, the staging name, the file name or a header.
    this.log(
      `storage.grant conn=${gs.connectionId} kind=${gs.kind} size=${gs.size} ${outcome} ${this.now() - gs.startedAt}ms`,
    );
  }

  private capable(id: string): (StorageConnector & DirectCapable) | undefined {
    const conn = this.store.get(id);
    if (!conn || conn.needsReauth) return undefined;
    try {
      const c = this.connector(id, conn);
      return isDirectCapable(c) ? c : undefined;
    } catch {
      return undefined;
    }
  }

  /** The upload host of a connection (cached for ten minutes) and the reason when it cannot take direct uploads. */
  private async directOrigin(
    id: string,
    force = false,
  ): Promise<{ origin: string | null; reason: DirectUnavailableReason | null }> {
    const conn = this.store.get(id);
    if (!conn || (conn.kind !== 'onedrive' && conn.kind !== 'google_drive' && conn.kind !== 's3'))
      return { origin: null, reason: 'unsupported_kind' };
    if (conn.needsReauth) return { origin: null, reason: 'needs_reauth' };
    const hit = this.origins.get(id);
    if (!force && hit && this.now() - hit.at < ORIGIN_TTL_MS) return hit;
    let r: { origin: string | null; reason: DirectUnavailableReason | null };
    try {
      const c = this.capable(id);
      r = c
        ? await c.uploadOrigin(AbortSignal.timeout(15_000), this.deps.pageOrigin)
        : { origin: null, reason: 'probe_failed' };
    } catch {
      r = { origin: null, reason: 'probe_failed' };
    }
    this.origins.set(id, { at: this.now(), ...r });
    return r;
  }

  /** Tells the server which upload host each connection can use (kept in its memory only). */
  async reportDirect(): Promise<void> {
    const list: Array<{ connectionId: string; uploadOrigin: string | null; reason: DirectUnavailableReason | null }> = [];
    for (const [id] of this.store.list()) {
      const r = await this.directOrigin(id);
      list.push({ connectionId: id, uploadOrigin: r.origin, reason: r.origin ? null : (r.reason ?? 'probe_failed') });
    }
    if (list.length) this.deps.send('storage.direct.report', { connections: list.slice(0, 100) });
  }

  private grantResult(grantId: string, r: Record<string, unknown>): void {
    this.deps.send('storage.grant.result', { grantId, ...r });
  }

  private async grantOpen(m: Extract<ServerToRunner, { type: 'storage.grant.open' }>): Promise<void> {
    const conn = this.store.get(m.connectionId);
    const meta = { connectionId: m.connectionId, kind: (conn?.kind ?? 'local') as StorageKind, size: m.size, startedAt: this.now() };
    const fail = (e: StorageWriteError) => {
      this.grantLog(meta, e.code);
      this.grantResult(m.grantId, { ok: false, error: e });
    };
    if (!conn) return fail(storageError('not_found', 'This storage is not set up on this workstation.'));
    if (conn.needsReauth) return fail(storageError('auth_expired', 'The sign-in expired: reconnect this storage.'));
    const rendered = renderStoragePath({ folder: m.folder, name: m.name }, m.vars, m.ext);
    if (!rendered.ok) return fail(storageError('invalid', rendered.error));
    try {
      const c = this.capable(m.connectionId);
      if (!c) return fail(storageError('invalid', 'This storage cannot take direct uploads.'));
      const o = await this.directOrigin(m.connectionId);
      if (!o.origin) return fail(storageError('invalid', 'This storage cannot take direct uploads.'));
      const ttl = Math.min(m.ttlMs, 30 * 60_000);
      const ext = (m.ext ?? '').toLowerCase();
      const stagingName = ext ? `${m.grantId}.${ext}` : m.grantId;
      const g = await c.grant(
        stagingName,
        { size: m.size, contentType: m.contentType, sha256: m.sha256 },
        ttl,
        m.pageOrigin,
        AbortSignal.timeout(30_000),
      );
      registerSecret(g.url);
      if (g.cancelUrl) registerSecret(g.cancelUrl);
      const gs: GrantState = {
        id: m.grantId,
        connectionId: m.connectionId,
        kind: conn.kind,
        g,
        size: m.size,
        sha256: m.sha256,
        contentType: m.contentType,
        ext,
        accepted: m.accepted,
        target: { folder: rendered.folder, name: rendered.name },
        submission: m.submission,
        scan: m.scan,
        startedAt: this.now(),
        used: false,
        closed: false,
      };
      gs.timer = setTimeout(() => void this.cancelStaged(gs), ttl);
      gs.timer.unref?.();
      this.grants.set(gs.id, gs);
      this.ensureSweepTimer();
      this.grantLog(gs, 'granted');
      this.grantResult(m.grantId, {
        ok: true,
        grant: {
          provider: g.provider,
          method: 'PUT',
          url: g.url,
          headers: g.headers,
          chunkBytes: g.chunkBytes,
          expiresAt: g.expiresAt,
        },
      });
    } catch (err) {
      fail(this.typed(err));
    }
  }

  private async grantStatus(grantId: string): Promise<void> {
    const gs = this.grants.get(grantId);
    const c = gs && !gs.closed ? this.capable(gs.connectionId) : undefined;
    let offset: number | null = null;
    if (gs && c && !gs.used) {
      try {
        offset = await c.offset(gs.g, AbortSignal.timeout(15_000), gs.size);
      } catch {
        offset = null;
      }
    }
    this.deps.send('storage.grant.offset', { grantId, offset });
  }

  private async grantCancel(grantId: string): Promise<void> {
    const gs = this.grants.get(grantId);
    if (gs) await this.cancelStaged(gs);
  }

  /** Ends a grant and deletes what the provider holds for it (best effort). */
  private async cancelStaged(gs: GrantState): Promise<void> {
    if (gs.closed) return;
    gs.closed = true;
    if (gs.timer) clearTimeout(gs.timer);
    this.grants.delete(gs.id);
    unregisterSecret(gs.g.url);
    if (gs.g.cancelUrl) unregisterSecret(gs.g.cancelUrl);
    const c = this.capable(gs.connectionId);
    if (c) await c.cancel(gs.g, AbortSignal.timeout(15_000)).catch(() => undefined);
  }

  private async drain(
    stream: ReadableStream<Uint8Array>,
    o: { spool?: string; limit: number; head: number; hash: boolean },
  ): Promise<{ sha256: string; bytes: number; head: Buffer }> {
    const hash = createHash('sha256');
    const fh = o.spool ? await open(o.spool, 'w', 0o600) : undefined;
    let bytes = 0;
    const head: Buffer[] = [];
    let headLen = 0;
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > o.limit) throw new StorageError('invalid', 'The file did not arrive intact: try again.');
        if (o.hash) hash.update(buf);
        if (headLen < o.head) {
          head.push(buf.subarray(0, o.head - headLen));
          headLen += Math.min(buf.length, o.head - headLen);
        }
        await fh?.write(buf);
      }
    } finally {
      await fh?.close();
    }
    return { sha256: o.hash ? hash.digest('hex') : '', bytes, head: Buffer.concat(head) };
  }

  /** The browser says the upload is done: check the staged object, then move it into place. */
  private async grantFinish(m: Extract<ServerToRunner, { type: 'storage.grant.finish' }>): Promise<void> {
    const gs = this.grants.get(m.grantId);
    const verified = (r: { reference: StorageReference } | { error: StorageWriteError }) =>
      this.deps.send('storage.grant.verified', { grantId: m.grantId, ok: 'reference' in r, ...r });
    if (!gs || gs.used || gs.closed)
      return verified({ error: storageError('invalid', 'This upload is not open any more.') });
    gs.used = true;
    if (gs.timer) clearTimeout(gs.timer);
    const spool = join(this.deps.spoolDir, `${gs.id}.part`);
    const t: Transfer = {
      id: gs.id,
      connectionId: gs.connectionId,
      kind: gs.kind,
      file: spool,
      hash: createHash('sha256'),
      bytes: gs.size,
      chunks: 0,
      size: gs.size,
      contentType: gs.contentType,
      target: gs.target,
      deadline: this.now() + 10 * 60_000,
      controller: new AbortController(),
      chain: Promise.resolve(),
      startedAt: gs.startedAt,
      finished: false,
      submission: gs.submission,
      scan: gs.scan,
      reply: verified,
    };
    const refuse = async (e: StorageWriteError) => {
      await this.cancelStaged(gs);
      this.grantLog(gs, e.code);
      await rm(spool, { force: true });
      verified({ error: e });
    };
    try {
      if (m.size !== gs.size || m.sha256 !== gs.sha256)
        return await refuse(storageError('invalid', 'The file did not arrive intact: try again.'));
      const c = this.capable(gs.connectionId);
      const conn = this.store.get(gs.connectionId);
      if (!c || !conn) return await refuse(storageError('not_found', 'This storage is not set up on this workstation.'));
      const signal = AbortSignal.timeout(10 * 60_000);
      const info = await c.stat(gs.g, signal);
      if (!info) return await refuse(storageError('invalid', 'The file did not arrive: try again.'));
      if (info.size !== gs.size)
        return await refuse(storageError('invalid', 'The file did not arrive intact: try again.'));
      const needFull = this.scanOn() || !info.sha256;
      let head: Buffer;
      if (needFull) {
        mkdirSync(this.deps.spoolDir, { recursive: true, mode: 0o700 });
        const r = await this.drain(await c.read(gs.g, null, signal), {
          spool,
          limit: gs.size,
          head: UPLOAD_HEAD_BYTES,
          hash: true,
        });
        if (r.bytes !== gs.size || r.sha256 !== gs.sha256)
          return await refuse(storageError('invalid', 'The file did not arrive intact: try again.'));
        head = r.head;
      } else {
        if (info.sha256 !== gs.sha256)
          return await refuse(storageError('invalid', 'The file did not arrive intact: try again.'));
        const r = await this.drain(await c.read(gs.g, { start: 0, end: UPLOAD_HEAD_BYTES - 1 }, signal), {
          limit: UPLOAD_HEAD_BYTES,
          head: UPLOAD_HEAD_BYTES,
          hash: false,
        });
        head = r.head;
      }
      const sniff = checkUploadHead(gs.ext, head, gs.accepted);
      if (!sniff.ok)
        return await refuse(storageError('type_refused', 'The content of the file is not an accepted type.'));
      if (needFull && this.scanOn()) {
        const cfg = this.deps.uploadScan as NonNullable<StorageServiceDeps['uploadScan']>;
        const unusable = this.quarantineInsideDestination(cfg.quarantineDir);
        const v: ScanVerdict = unusable
          ? { kind: 'failed', reason: unusable }
          : await this.scanner.scanFile(spool, abortAfter(cfg.timeoutMs, t.controller.signal));
        if (v.kind !== 'clean') {
          await this.cancelStaged(gs);
          await this.reject(
            t,
            v.kind === 'infected' ? 'malware_detected' : 'scan_unavailable',
            v,
            gs.sha256,
            cfg.quarantineDir,
          );
          return;
        }
      }
      const written = await c.promote(gs.g, info, gs.target, signal);
      this.journal.add({
        submissionId: gs.submission.submissionId,
        connectionId: gs.connectionId,
        path: written.path,
        ...(written.providerId ? { providerId: written.providerId } : {}),
      });
      gs.closed = true;
      this.grants.delete(gs.id);
      unregisterSecret(gs.g.url);
      if (gs.g.cancelUrl) unregisterSecret(gs.g.cancelUrl);
      this.grantLog(gs, 'ok');
      await rm(spool, { force: true });
      verified({
        reference: {
          v: 1,
          connectionId: gs.connectionId,
          kind: gs.kind,
          path: written.path,
          ...(written.providerId ? { providerId: written.providerId } : {}),
          size: gs.size,
          sha256: gs.sha256,
          contentType: gs.contentType,
          writtenAt: new Date(this.now()).toISOString(),
        },
      });
    } catch (err) {
      await refuse(this.typed(err));
    }
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepStaging(), GRANT_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** Deletes staged entries nobody can finish: no open grant, and older than the longest grant. */
  async sweepStaging(): Promise<number> {
    let n = 0;
    for (const [id] of this.store.list()) {
      const c = this.capable(id);
      if (!c) continue;
      try {
        n += await c.sweep((name, modifiedAt) => {
          const gid = name.split('.')[0] ?? '';
          return this.grants.has(gid) || this.now() - modifiedAt < GRANT_KEEP_MS;
        }, AbortSignal.timeout(60_000));
      } catch {
        // best effort; the next sweep tries again
      }
    }
    return n;
  }

  /** Transfers in progress (for tests and shutdown). */
  activeTransfers(): number {
    return this.transfers.size;
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const gs of [...this.grants.values()]) void this.cancelStaged(gs);
    for (const f of this.flows.values()) f.ctl.abort();
    for (const t of [...this.transfers.values()]) void this.abortTransfer(t, 'shutdown');
  }
}

export type { StorageErrorCode };
