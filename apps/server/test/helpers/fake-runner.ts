import { randomUUID } from 'node:crypto';
import {
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
  outboxPending?: number;
  maxConcurrentShifts?: number;
}

/** In-process runner speaking the shared protocol; auto-acks server messages that need it. */
export class FakeRunner {
  readonly received: Frame[] = [];
  readonly raw: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private closeWaiters: Array<(c: { code: number; reason: string }) => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const json = JSON.parse(data.toString());
      this.raw.push(json);
      const parsed = ServerToRunnerSchema.safeParse(json);
      if (!parsed.success) return;
      const f = parsed.data;
      this.received.push(f);
      if (f.type === 'shift.stop') this.send('ack', { ackOf: f.id });
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
      vaults: [],
      activeShifts: o.activeShifts ?? [],
      outboxPending: o.outboxPending ?? 0,
      ...(o.maxConcurrentShifts ? { maxConcurrentShifts: o.maxConcurrentShifts } : {}),
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
