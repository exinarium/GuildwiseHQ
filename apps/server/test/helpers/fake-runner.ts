import { randomUUID } from 'node:crypto';
import {
  LOCAL_VAULT_CAPABILITY,
  makeEnvelope,
  RUNNER_SUBPROTOCOL,
  type RunnerToServer,
  type ServerToRunner,
  ServerToRunnerSchema,
} from '@aom/shared';
import WebSocket from 'ws';

export type Frame = ServerToRunner;

export interface HelloOptions {
  repos?: Array<{ remoteUrl: string; localPath: string; headBranch: string | null }>;
  runtimes?: Array<{ id: string; version: string; available: boolean; capabilities: string[] }>;
  activeShifts?: Array<{ shiftId: string; cardId?: string; agentId: string; startedAt: string }>;
  repoCatalog?: Array<{ name: string; localKey: string; remoteUrlNormalized: string | null }>;
  outboxPending?: number;
  maxConcurrentShifts?: number;
  sudoKey?: { keyId: string; publicKey: string };
  capabilities?: string[];
  /** A 0.1.31 runner: does not announce `local-vault:1` (the default announces it, like 0.1.32). */
  legacyVaults?: boolean;
  maxRunEnvironments?: number;
  integrationsVersion?: number;
}

/**
 * What a runner with a clone answers to `repo.commit.probe`. Default: the tip is `DEFAULT_TIP` and every commit asked for
 * exists (padded to a full sha). `strict`: only `known` commits exist; `ambiguous` ones answer `ambiguous`; `offlineFor`
 * is not used (close the runner instead).
 */
export interface ProbeScript {
  tip: string | null;
  known: Record<string, { subject?: string; author?: string; committedAt?: string }>;
  strict: boolean;
  ambiguous: string[];
  /** Every probe asked, in order (sha is null for the tip). */
  asked: Array<{ sha: string | null; branch: string | null }>;
  /** Answer nothing at all (a runner that hangs). */
  silent: boolean;
}
export const DEFAULT_TIP = '0123456789abcdef0123456789abcdef01234567';

/** In-process runner speaking the shared protocol; auto-acks server messages that need it. */
export class FakeRunner {
  readonly received: Frame[] = [];
  readonly raw: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private closeWaiters: Array<(c: { code: number; reason: string }) => void> = [];
  readonly probe: ProbeScript = {
    tip: DEFAULT_TIP,
    known: {},
    strict: false,
    ambiguous: [],
    asked: [],
    silent: false,
  };

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const json = JSON.parse(data.toString());
      this.raw.push(json);
      const parsed = ServerToRunnerSchema.safeParse(json);
      if (!parsed.success) return;
      const f = parsed.data;
      this.received.push(f);
      if (f.type === 'shift.stop') this.send('ack', { ackOf: f.id });
      if (f.type === 'repo.commit.probe') this.answerProbe(f);
      for (const w of [...this.waiters]) {
        if (w.pred(f)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          w.resolve(f);
        }
      }
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.closeWaiters) w(this.closed);
    });
    ws.on('error', () => {});
  }

  private answerProbe(f: Extract<Frame, { type: 'repo.commit.probe' }>): void {
    const p = this.probe;
    p.asked.push({ sha: f.sha ?? null, branch: f.branch });
    if (p.silent) return;
    const meta = (sha: string, extra: { subject?: string; author?: string; committedAt?: string } = {}) =>
      this.send('repo.commit.probe.result', {
        requestId: f.requestId,
        ok: true,
        sha,
        shortSha: sha.slice(0, 7),
        subject: extra.subject ?? `commit ${sha.slice(0, 7)}`,
        author: extra.author ?? 'Dev',
        committedAt: extra.committedAt ?? '2026-11-14T10:00:00.000Z',
      });
    const fail = (error: 'not_found' | 'ambiguous' | 'no_branch', message: string) =>
      this.send('repo.commit.probe.result', { requestId: f.requestId, ok: false, error, message });
    if (!f.sha) {
      if (p.tip) meta(p.tip, p.known[p.tip]);
      else fail('no_branch', 'no such branch');
      return;
    }
    if (p.ambiguous.some((a) => a.startsWith(f.sha as string))) return void fail('ambiguous', 'ambiguous');
    const hit = Object.keys(p.known).find((k) => k.startsWith(f.sha as string));
    if (hit) return void meta(hit, p.known[hit]);
    if (p.strict) return void fail('not_found', 'not found');
    meta(f.sha.padEnd(40, '0'));
  }

  static async connect(
    baseUrl: string,
    token: string | null,
    opts: { subprotocol?: boolean } = {},
  ): Promise<FakeRunner> {
    const url = `${baseUrl.replace(/^http/, 'ws')}/api/runner/ws`;
    const ws = new WebSocket(
      url,
      opts.subprotocol === false ? [] : [RUNNER_SUBPROTOCOL],
      token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
    const r = new FakeRunner(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('close', () => resolve());
    });
    return r;
  }

  send(
    type: RunnerToServer['type'],
    payload: Record<string, unknown> = {},
    id: string = randomUUID(),
  ): string {
    this.ws.send(JSON.stringify(makeEnvelope(type, payload, new Date(), id)));
    return id;
  }

  hello(o: HelloOptions = {}): string {
    return this.send('hello', {
      runnerVersion: '0.0.0-test',
      protocol: 1,
      platform: 'linux',
      hostname: 'fake-host',
      runtimes: o.runtimes ?? [
        { id: 'mock', version: '1', available: true, capabilities: ['shell', 'edit', 'web'] },
      ],
      repos: o.repos ?? [],
      ...(o.repoCatalog ? { repoCatalog: o.repoCatalog } : {}),
      vaults: [],
      activeShifts: o.activeShifts ?? [],
      outboxPending: o.outboxPending ?? 0,
      ...(o.maxConcurrentShifts ? { maxConcurrentShifts: o.maxConcurrentShifts } : {}),
      ...(o.sudoKey ? { sudoKey: o.sudoKey } : {}),
      ...(o.capabilities || !o.legacyVaults
        ? { capabilities: [...(o.capabilities ?? []), ...(o.legacyVaults ? [] : [LOCAL_VAULT_CAPABILITY])] }
        : {}),
      ...(o.maxRunEnvironments ? { maxRunEnvironments: o.maxRunEnvironments } : {}),
      ...(o.integrationsVersion ? { integrationsVersion: o.integrationsVersion } : {}),
    });
  }

  heartbeat(activeShifts: string[] = []): string {
    return this.send('heartbeat', { activeShifts, load: { runningShifts: activeShifts.length } });
  }

  accepted(shiftId: string) {
    return this.send('shift.accepted', { shiftId });
  }
  rejected(shiftId: string, reason: string, extra: Record<string, unknown> = {}) {
    return this.send('shift.rejected', { shiftId, reason, ...extra });
  }
  started(shiftId: string, worktree?: Record<string, unknown>) {
    return this.send('shift.started', { shiftId, ...(worktree ? { worktree } : {}) });
  }
  report(shiftId: string, report: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const reportId = randomUUID();
    const id = this.send('shift.report', { shiftId, reportId, report, ...extra });
    return { id, reportId };
  }
  ended(shiftId: string, outcome = 'reported', extra: Record<string, unknown> = {}) {
    return this.send('shift.ended', {
      shiftId,
      outcome,
      durationMs: 1000,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      guardViolations: [],
      ...extra,
    });
  }

  /**
   * Resolves once the server has finished handling every frame this runner sent before it. The gateway handles one
   * connection's frames in order and always answers an `rpc.request`, so the answer is a barrier: use it instead of
   * sleeping before asserting that something did NOT happen.
   */
  async barrier(): Promise<void> {
    const rpcId = randomUUID();
    const from = this.received.length;
    this.send('rpc.request', { rpcId, shiftId: randomUUID(), method: 'ledger.search', params: {} });
    await this.waitFor('rpc.response', (f) => f.rpcId === rpcId, 30_000, from);
  }

  /** Waits for the next matching frame (including ones already received but not yet consumed by a waiter). */
  waitFor<T extends Frame['type']>(
    type: T,
    pred: (f: Extract<Frame, { type: T }>) => boolean = () => true,
    timeoutMs = 5000,
    fromIndex = 0,
  ): Promise<Extract<Frame, { type: T }>> {
    const match = (f: Frame): f is Extract<Frame, { type: T }> => f.type === type && pred(f as never);
    const existing = this.received.slice(fromIndex).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      // The wait ends when the frame arrives: the bound is a failure guard, not an expectation of speed.
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for ${type} (from ${fromIndex}; received: ${this.received.map((f, i) => `${i}:${f.type}`).join(' ')})`,
            ),
          ),
        Math.max(timeoutMs, 30_000),
      );
      this.waiters.push({
        pred: match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f as never);
        },
      });
    });
  }

  of<T extends Frame['type']>(type: T): Array<Extract<Frame, { type: T }>> {
    return this.received.filter((f): f is Extract<Frame, { type: T }> => f.type === type);
  }

  waitClosed(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for close')),
        Math.max(timeoutMs, 30_000),
      );
      this.closeWaiters.push((c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}
