import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { type FileHandle, open, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  CommandPayloadSchemas,
  healthStateForError,
  type RunnerToServer,
  renderStoragePath,
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
import { checkS3Endpoint, S3Connector } from './s3.ts';
import { type ClamdClient, clamdClient, quarantine, type ScanVerdict } from './scan.ts';
import { KeyedMutex, StorageStore } from './store.ts';
import {
  type FetchLike,
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
  /** Bound for the probe of "Test connection". */
  probeTimeoutMs?: number;
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
}

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
      return { health: await this.reportWithScan(p.connectionId) };
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
    return { health: await this.reportWithScan(id) };
  }

  private async remove(id: string): Promise<Record<string, unknown>> {
    for (const f of this.flows.values()) if (f.connectionId === id) f.ctl.abort();
    for (const t of [...this.transfers.values()])
      if (t.connectionId === id) void this.abortTransfer(t, 'shutdown');
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
    if (!conn) return answer({ error: storageError('not_found', 'This storage is not set up on this workstation.') });
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

  private result(id: string, r: { reference: StorageReference } | { error: StorageWriteError }): void {
    this.deps.send('storage.write.result', {
      transferId: id,
      ok: 'reference' in r,
      ...r,
    });
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
      this.result(t.id, { reference });
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
    if (!t.written) return;
    await this.deleteRef(t.connectionId, conn, t.written);
    if (t.submission) this.dropJournalEntry(t.submission.submissionId, t.connectionId, t.written.path);
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
      this.result(t.id, { error: storageError('malware_detected', 'The file failed the security check.') });
    } else {
      this.logError(
        `storage.scan failed conn=${t.connectionId} submission=${sub.submissionId} transfer=${t.id} reason=${v.reason}`,
      );
      this.result(t.id, { error: storageError('scan_unavailable', 'The file could not be scanned.') });
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

  /** Transfers in progress (for tests and shutdown). */
  activeTransfers(): number {
    return this.transfers.size;
  }

  close(): void {
    for (const f of this.flows.values()) f.ctl.abort();
    for (const t of [...this.transfers.values()]) void this.abortTransfer(t, 'shutdown');
  }
}

export type { StorageErrorCode };
