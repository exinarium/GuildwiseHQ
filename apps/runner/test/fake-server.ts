import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isAckedFromRunner,
  makeEnvelope,
  RUNNER_SUBPROTOCOL,
  type RunnerPairRequest,
  RunnerPairRequestSchema,
  type RunnerToServer,
  type RunnerToServerOf,
  RunnerToServerSchema,
  type RunnerToServerType,
  type ServerToRunnerType,
  WS_CLOSE,
} from '@aom/shared';
import { type WebSocket, WebSocketServer } from 'ws';

export interface FakeServerOptions {
  token?: string;
  heartbeatSec?: number;
  maxConcurrentShifts?: number;
  /** Ack runner messages that require an ack (default true). */
  autoAck?: boolean;
  /** Verdict for each `shift.report` (default: accept). */
  reportResult?: (
    msg: RunnerToServerOf<'shift.report'>,
  ) => { accepted: boolean; error?: string; message?: string; matches?: unknown[] } | 'ignore';
  rpc?: (msg: RunnerToServerOf<'rpc.request'>) => { ok: boolean; result?: unknown; error?: string };
  pairCode?: string;
  /** Answer to each `worktrees.query`: the paths still in use. Unset: the query is not answered. */
  worktreesLive?: (paths: string[]) => string[];
}

/**
 * In-process fake of the server side of the runner protocol (docs/PLAN.md rule 5): HTTP pairing endpoint plus the
 * runner WebSocket. Records every runner frame (validated against the shared schema), answers `hello` with `welcome`
 * and acks, and lets tests push server messages.
 */
export class FakeServer {
  readonly received: RunnerToServer[] = [];
  readonly invalid: unknown[] = [];
  readonly pairRequests: RunnerPairRequest[] = [];
  connections = 0;
  helloCount = 0;
  autoAck: boolean;
  private socket: WebSocket | null = null;
  private http!: Server;
  private wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (p) => (p.has(RUNNER_SUBPROTOCOL) ? RUNNER_SUBPROTOCOL : false),
  });
  port = 0;
  readonly token: string;
  /** Tokens the socket accepts: the paired one plus any issued by `token.rotate`. */
  readonly tokens = new Set<string>();
  private rotations = 0;

  constructor(readonly opts: FakeServerOptions = {}) {
    this.token = opts.token ?? 'aomr_testtoken';
    this.autoAck = opts.autoAck ?? true;
    this.tokens.add(this.token);
  }

  static async start(opts: FakeServerOptions = {}): Promise<FakeServer> {
    const s = new FakeServer(opts);
    await s.listen();
    return s;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async listen(): Promise<void> {
    this.http = createServer((req, res) => void this.onHttp(req, res));
    this.http.on('upgrade', (req, sock, head) => {
      if (req.url !== '/api/runner/ws') return sock.destroy();
      this.wss.handleUpgrade(req, sock, head, (ws) => this.onSocket(ws, req));
    });
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', r));
    this.port = (this.http.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.socket?.terminate();
    for (const c of this.wss.clients) c.terminate();
    this.http.closeAllConnections?.();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  private async onHttp(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/api/runner/pair') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const parsed = RunnerPairRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!parsed.success || parsed.data.code !== (this.opts.pairCode ?? 'ABCD-EFGH')) {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid code"}');
        return;
      }
      this.pairRequests.push(parsed.data);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ workstationId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b1', runnerToken: this.token }),
        );
      return;
    }
    res.writeHead(404).end();
  }

  private onSocket(ws: WebSocket, req: IncomingMessage): void {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !this.tokens.has(bearer)) {
      ws.close(WS_CLOSE.unauthorized, 'unauthorized');
      return;
    }
    this.connections++;
    if (this.socket && this.socket.readyState === 1) this.socket.close(WS_CLOSE.superseded, 'superseded');
    this.socket = ws;
    ws.on('message', (data) => this.onFrame(ws, data.toString()));
  }

  private onFrame(ws: WebSocket, text: string): void {
    const parsed = RunnerToServerSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      this.invalid.push({ text, error: parsed.error.message });
      return;
    }
    const msg = parsed.data;
    this.received.push(msg);
    if (msg.type === 'token.rotate') {
      const token = `aomr_rotated${++this.rotations}`;
      this.tokens.add(token);
      this.sendRaw(ws, 'token.rotated', { token });
      return;
    }
    if (msg.type === 'hello') {
      this.helloCount++;
      this.sendRaw(ws, 'welcome', {
        workstationId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b1',
        serverTime: new Date().toISOString(),
        heartbeatSec: this.opts.heartbeatSec ?? 15,
        limits: { maxConcurrentShifts: this.opts.maxConcurrentShifts ?? 4 },
      });
      return;
    }
    if (this.autoAck && isAckedFromRunner(msg.type)) this.sendRaw(ws, 'ack', { ackOf: msg.id });
    if (msg.type === 'shift.report') {
      const verdict = this.opts.reportResult?.(msg) ?? { accepted: true };
      if (verdict !== 'ignore')
        this.sendRaw(ws, 'shift.report.result', { reportId: msg.reportId, ...verdict });
    }
    if (msg.type === 'worktrees.query' && this.opts.worktreesLive)
      this.sendRaw(ws, 'worktrees.live', { queryId: msg.queryId, live: this.opts.worktreesLive(msg.paths) });
    if (msg.type === 'rpc.request') {
      const r = this.opts.rpc?.(msg) ?? { ok: false, error: 'not implemented in fake' };
      this.sendRaw(ws, 'rpc.response', { rpcId: msg.rpcId, ...r });
    }
  }

  private sendRaw(ws: WebSocket, type: ServerToRunnerType, payload: Record<string, unknown>): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(makeEnvelope(type, payload)));
  }

  /** Pushes a server -> runner message to the current connection. */
  send(type: ServerToRunnerType, payload: Record<string, unknown>): void {
    if (!this.socket) throw new Error('runner not connected');
    this.sendRaw(this.socket, type, payload);
  }

  /** Closes the runner's socket from the server side (simulates a network drop). */
  drop(code = 1006): void {
    this.socket?.close(code === 1006 ? 1001 : code);
  }

  of<T extends RunnerToServerType>(type: T): RunnerToServerOf<T>[] {
    return this.received.filter((m): m is RunnerToServerOf<T> => m.type === type);
  }

  async waitFor<T extends RunnerToServerType>(
    type: T,
    pred: (m: RunnerToServerOf<T>) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<RunnerToServerOf<T>> {
    const start = Date.now();
    for (;;) {
      const hit = this.of(type).find(pred);
      if (hit) return hit;
      if (Date.now() - start > Math.max(timeoutMs, 30_000)) {
        throw new Error(
          `timed out waiting for ${type}; received: ${this.received.map((m) => m.type).join(', ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
