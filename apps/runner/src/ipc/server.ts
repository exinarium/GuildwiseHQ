import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_REPORT_PATH,
  IPC_RPC_PATH,
  type IpcReportRequest,
  IpcReportRequestSchema,
  type IpcReportResponse,
  type IpcRpcRequest,
  IpcRpcRequestSchema,
  type IpcRpcResponse,
} from '@aom/shared';

export interface ShiftIpcHandler {
  report(req: IpcReportRequest): Promise<IpcReportResponse | { status: number; error: string }>;
  rpc(req: IpcRpcRequest): Promise<IpcRpcResponse>;
}

/**
 * Local HTTP server for the `aom` CLI: `POST /v1/report` and `/v1/rpc` with `Authorization: Bearer <shift token>`.
 * A token is valid only while its shift is registered (`registerShift` .. `revoke`).
 */
export class IpcServer {
  private server: Server | null = null;
  private socketServer: Server | null = null;
  private socketDir: string | null = null;
  /** Unix socket twin of the TCP endpoint (`AOM_IPC_SOCKET`): the sandboxed `aom` CLI has no loopback route. */
  socketPath = '';
  private readonly shifts = new Map<string, ShiftIpcHandler>();
  url = '';

  private makeServer(): Server {
    return createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        },
        (err: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
        },
      );
    });
  }

  /**
   * Also listens on a Unix socket in a private (0700) temp directory outside the runner's data dir, which the agent
   * sandbox may connect to. Not available on Windows (the TCP endpoint is used there).
   */
  async startSocket(): Promise<string> {
    if (process.platform === 'win32') return '';
    this.socketDir = mkdtempSync(join(tmpdir(), 'aom-ipc-'));
    chmodSync(this.socketDir, 0o700);
    const path = join(this.socketDir, 'ipc.sock');
    this.socketServer = this.makeServer();
    await new Promise<void>((resolve, reject) => {
      this.socketServer?.once('error', reject);
      this.socketServer?.listen(path, resolve);
    });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
    this.socketPath = path;
    return path;
  }

  async start(host = '127.0.0.1'): Promise<string> {
    this.server = this.makeServer();
    await new Promise<void>((resolve) => this.server?.listen(0, host, resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('IPC server has no address');
    this.url = `http://${host}:${addr.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.shifts.clear();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    const u = this.socketServer;
    this.socketServer = null;
    if (u) await new Promise<void>((resolve) => u.close(() => resolve()));
    if (this.socketDir) rmSync(this.socketDir, { recursive: true, force: true });
    this.socketDir = null;
    this.socketPath = '';
  }

  /** Returns a fresh 32 byte token valid until `revoke(token)`. */
  registerShift(handler: ShiftIpcHandler): string {
    const token = randomBytes(32).toString('base64url');
    this.shifts.set(token, handler);
    return token;
  }

  revoke(token: string): void {
    this.shifts.delete(token);
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const handler = token ? this.shifts.get(token) : undefined;
    if (!handler) return { status: 401, body: { error: 'invalid or expired shift token' } };
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };

    let json: unknown;
    try {
      json = JSON.parse(await readBody(req));
    } catch {
      return { status: 400, body: { error: 'body must be JSON' } };
    }

    if (req.url === IPC_REPORT_PATH) {
      const parsed = IpcReportRequestSchema.safeParse(json);
      if (!parsed.success) return { status: 400, body: { error: parsed.error.message } };
      const result = await handler.report(parsed.data);
      if ('status' in result) return { status: result.status, body: { error: result.error } };
      return {
        status: result.accepted ? 200 : result.error?.includes('already reported') ? 409 : 422,
        body: result,
      };
    }
    if (req.url === IPC_RPC_PATH) {
      const parsed = IpcRpcRequestSchema.safeParse(json);
      if (!parsed.success) return { status: 400, body: { error: parsed.error.message } };
      return { status: 200, body: await handler.rpc(parsed.data) };
    }
    return { status: 404, body: { error: 'not found' } };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
