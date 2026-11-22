import { EventEmitter } from 'node:events';
import {
  HEARTBEAT_SEC,
  isAckedFromRunner,
  isAckedFromServer,
  makeEnvelope,
  RUNNER_SUBPROTOCOL,
  type RunnerToServerType,
  type ServerToRunner,
  ServerToRunnerSchema,
  UNPAIRED_CLOSE_REASON,
  WS_CLOSE,
} from '@aom/shared';
import WebSocket from 'ws';
import { type Logger, nullLogger } from '../log.ts';
import type { Outbox } from './outbox.ts';

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  /** Connection must have been up this long before the attempt counter resets. */
  resetAfterMs: number;
}
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, capMs: 30_000, resetAfterMs: 60_000 };

/**
 * Capped exponential backoff with "equal" jitter: uniform in [c/2, c] where c = min(cap, base * 2^attempt). Half of the
 * interval is fixed, so the logged intervals visibly grow (UAT 1.10.0 finding 4), and the other half spreads runners
 * that reconnect after the same server restart.
 */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(opts.capMs, opts.baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

export function toWsUrl(serverUrl: string): string {
  const u = new URL('/api/runner/ws', serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
  return u.toString();
}

/** Opening handshake (TCP + TLS + HTTP upgrade) must finish within this, else the attempt fails and is retried. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;
/** After `open`, the server must send `welcome` within this, else the socket is terminated and retried. */
export const WELCOME_TIMEOUT_MS = 30_000;
/** A ready connection is dead when nothing was received for this many heartbeat intervals. */
export const LIVENESS_HEARTBEATS = 3;
/**
 * A hard stall: no connection attempt started or ended for this long while offline (an attempt that hangs past every
 * timeout, a retry timer that never fired). The client then emits `stalled` and the runner exits non-zero, so its
 * service manager starts a fresh process (UAT 1.10.0 finding 4: "reconnecting in 308 ms", then 18 hours of nothing).
 */
export const STALL_MS = 5 * 60_000;

export interface ClientOptions {
  url: string;
  token: string;
  outbox: Outbox;
  /** Payload of `hello` (minus `outboxPending`, filled by the client). */
  buildHello: () => Promise<Record<string, unknown>>;
  buildHeartbeat: () => Record<string, unknown>;
  log?: Logger;
  backoff?: BackoffOptions;
  random?: () => number;
  /** Overrides for tests; defaults are the constants above. */
  handshakeTimeoutMs?: number;
  welcomeTimeoutMs?: number;
  /** Silence after which a ready connection is declared dead (default 3 x heartbeat interval). */
  livenessMs?: number;
  /** Hard-stall limit (default STALL_MS). */
  stallMs?: number;
}

/** What the client knows about its connection, for status.json, doctor and the logs. */
export interface ConnectionState {
  connected: boolean;
  /** When the connection was last lost (or the first attempt started); absent while connected. */
  offlineSince?: string;
  /** Failed attempts since the connection was lost. */
  failedAttempts: number;
  lastAttemptAt?: string;
  /** Why the last attempt failed (an HTTP status, a socket error, a close code). */
  lastError?: string;
  nextAttemptAt?: string;
}

export interface ClientEvents {
  message: [ServerToRunner];
  welcome: [Extract<ServerToRunner, { type: 'welcome' }>];
  connected: [];
  disconnected: [number];
  /** Close codes 4401/4403/4409: retrying would not help. */
  fatal: [number, string];
  /** A failed attempt; the state carries the reason and the next try. */
  retry: [ConnectionState];
  /** No attempt progressed within `stallMs`: the process should exit and be restarted. */
  stalled: [string];
}

/**
 * Runner side of the WebSocket protocol: hello/welcome, durable outbox for acked messages, heartbeats and
 * reconnect with jittered backoff (docs/ARCHITECTURE.md section 11.2).
 */
/** What the runner says when the server tells it the workstation was unpaired. */
export const UNPAIRED_MESSAGE =
  'this workstation was unpaired in the web app: its runner token no longer works. Run `guildwise-runner pair` with a new code to use this machine again.';

export class RunnerClient extends EventEmitter<ClientEvents> {
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = true;
  private attempt = 0;
  private connectedAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private welcomeTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private lastRx = 0;
  /** Last time an attempt started, opened, got its welcome or ended (the hard-stall watchdog). */
  private lastProgress = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private failed = 0;
  private offlineSince = 0;
  private lastAttemptAt = 0;
  private lastError = '';
  /** Why the current attempt failed, set by its error/response handlers. */
  private attemptError = '';
  private nextAttemptAt = 0;
  private readonly log: Logger;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;

  constructor(private readonly opts: ClientOptions) {
    super();
    this.log = opts.log ?? nullLogger;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.random = opts.random ?? Math.random;
  }

  /** True between `welcome` and the socket closing. */
  get isReady(): boolean {
    return this.ready;
  }

  /** The connection as the client sees it (for status.json and doctor). */
  state(): ConnectionState {
    const iso = (t: number) => (t ? new Date(t).toISOString() : undefined);
    return {
      connected: this.ready,
      ...(this.ready ? {} : { offlineSince: iso(this.offlineSince) }),
      failedAttempts: this.failed,
      ...(this.lastAttemptAt ? { lastAttemptAt: iso(this.lastAttemptAt) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(!this.ready && this.nextAttemptAt > Date.now() ? { nextAttemptAt: iso(this.nextAttemptAt) } : {}),
    };
  }

  start(): void {
    this.stopped = false;
    this.offlineSince = Date.now();
    this.lastProgress = Date.now();
    const stallMs = this.opts.stallMs ?? STALL_MS;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(
      () => {
        if (this.stopped || this.ready || Date.now() - this.lastProgress < stallMs) return;
        const why = `no connection attempt progressed for ${Math.round(stallMs / 1000)} s (last error: ${this.lastError || 'none'})`;
        this.log.error(`connection stalled: ${why}; exiting so the service manager restarts the runner`);
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        try {
          this.ws?.terminate();
        } catch {
          // going away anyway
        }
        this.emit('stalled', why);
      },
      Math.max(20, Math.min(10_000, Math.floor(stallMs / 4))),
    );
    this.watchdog.unref?.();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.clearHeartbeat();
    this.clearWelcomeTimer();
    this.ready = false;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        ws.once('close', () => {
          clearTimeout(t);
          resolve();
        });
        try {
          ws.close(1000);
        } catch {
          resolve();
        }
      });
      ws.terminate();
    }
  }

  /**
   * Sends a message. Acked types are persisted to the outbox first and delivered now when connected, otherwise on the
   * next connect. Best-effort types are dropped while offline. Returns the envelope id.
   */
  send(type: RunnerToServerType, payload: Record<string, unknown>): string {
    const frame = makeEnvelope(type, payload);
    if (isAckedFromRunner(type)) {
      if (!this.opts.outbox.add(frame))
        this.log.warn(`could not persist ${type} to the outbox; sending it best-effort`);
      if (this.ready) this.raw(frame);
    } else if (this.ready) {
      this.raw(frame);
    }
    return frame.id;
  }

  private raw(frame: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private connect(): void {
    if (this.stopped) return;
    this.lastProgress = Date.now();
    this.lastAttemptAt = Date.now();
    this.nextAttemptAt = 0;
    this.attemptError = '';
    const ws = new WebSocket(this.opts.url, RUNNER_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;
    ws.on('open', () => {
      this.lastProgress = Date.now();
      this.connectedAt = Date.now();
      this.lastRx = Date.now();
      this.clearWelcomeTimer();
      this.welcomeTimer = setTimeout(() => {
        if (ws !== this.ws || this.ready) return;
        this.log.warn('no welcome from the server in time; dropping the connection');
        ws.terminate();
      }, this.opts.welcomeTimeoutMs ?? WELCOME_TIMEOUT_MS);
      this.welcomeTimer.unref?.();
      void this.sendHello(ws);
    });
    ws.on('message', (data) => {
      if (ws === this.ws) this.lastRx = Date.now();
      this.onFrame(ws, data.toString());
    });
    ws.on('pong', () => {
      if (ws === this.ws) this.lastRx = Date.now();
    });
    ws.on('ping', () => {
      if (ws === this.ws) this.lastRx = Date.now();
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.stopped = true;
        this.emit('fatal', res.statusCode, `server rejected the runner token (HTTP ${res.statusCode})`);
      } else {
        // UAT 1.10.0 finding 4: with this listener attached, ws leaves the handshake to us. A 502/503 from a reverse
        // proxy while the server restarts must end the attempt, or the runner waits forever without a close.
        this.attemptError = `the server answered HTTP ${res.statusCode} instead of opening the connection`;
      }
      res.resume();
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    });
    ws.on('error', (err) => {
      if (ws === this.ws && !this.attemptError.startsWith('the server answered HTTP'))
        this.attemptError = err.message;
      this.log.warn(`websocket error: ${err.message}`);
    });
    ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
  }

  private async sendHello(ws: WebSocket): Promise<void> {
    try {
      const hello = await this.opts.buildHello();
      if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(makeEnvelope('hello', { ...hello, outboxPending: this.opts.outbox.count() })));
    } catch (err) {
      this.log.error('failed to build hello', err);
      ws.close();
    }
  }

  private onFrame(ws: WebSocket, text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.log.warn('dropping non-JSON frame');
      return;
    }
    const parsed = ServerToRunnerSchema.safeParse(json);
    if (!parsed.success) {
      this.log.warn(`dropping invalid server frame: ${parsed.error.message.slice(0, 200)}`);
      return;
    }
    const msg = parsed.data;
    if (msg.type === 'ack') {
      this.opts.outbox.ack(msg.ackOf);
      return;
    }
    if (isAckedFromServer(msg.type)) {
      this.raw(makeEnvelope('ack', { ackOf: msg.id }));
    }
    if (msg.type === 'welcome') {
      this.onWelcome(ws, msg);
      return;
    }
    this.emit('message', msg);
  }

  private onWelcome(ws: WebSocket, msg: Extract<ServerToRunner, { type: 'welcome' }>): void {
    if (ws !== this.ws) return;
    // Resend the outbox in creation order, then announce the flush.
    for (const entry of this.opts.outbox.list()) this.raw(entry.frame);
    this.raw(makeEnvelope('outbox.flushed', {}));
    this.ready = true;
    this.lastProgress = Date.now();
    if (this.failed > 0 || this.offlineSince)
      this.log.info(
        `connected${this.failed ? ` after ${this.failed} failed attempt${this.failed === 1 ? '' : 's'}` : ''}${this.offlineSince ? `, offline for ${Math.round((Date.now() - this.offlineSince) / 1000)} s` : ''}`,
      );
    this.failed = 0;
    this.offlineSince = 0;
    this.lastError = '';
    this.clearWelcomeTimer();
    this.clearHeartbeat();
    const sec = msg.heartbeatSec || HEARTBEAT_SEC;
    this.lastRx = Date.now();
    this.hbTimer = setInterval(() => {
      this.send('heartbeat', this.opts.buildHeartbeat());
      try {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      } catch {
        // socket going away; close handling retries
      }
    }, sec * 1000);
    this.hbTimer.unref?.();
    // Half-open detection: any frame, ack or pong counts as proof of life.
    const livenessMs = this.opts.livenessMs ?? LIVENESS_HEARTBEATS * sec * 1000;
    this.livenessTimer = setInterval(
      () => {
        if (ws !== this.ws || Date.now() - this.lastRx < livenessMs) return;
        this.log.warn(`nothing received from the server for ${livenessMs} ms; dropping the connection`);
        ws.terminate();
      },
      Math.max(10, Math.min(sec * 1000, Math.floor(livenessMs / 3))),
    );
    this.livenessTimer.unref?.();
    this.emit('welcome', msg);
    this.emit('connected');
  }

  private clearHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  private clearWelcomeTimer(): void {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
  }

  private onClose(ws: WebSocket, code: number, reason = ''): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.lastProgress = Date.now();
    const wasReady = this.ready;
    this.ready = false;
    this.clearHeartbeat();
    this.clearWelcomeTimer();
    if (wasReady) this.emit('disconnected', code);
    if (this.stopped) return;
    if (code === WS_CLOSE.unauthorized || code === WS_CLOSE.forbidden || code === WS_CLOSE.superseded) {
      this.stopped = true;
      const why =
        code === WS_CLOSE.superseded
          ? 'another runner connected for this workstation'
          : code === WS_CLOSE.forbidden && reason === UNPAIRED_CLOSE_REASON
            ? UNPAIRED_MESSAGE
            : 'the server rejected the runner token (unpaired workstation? run `guildwise-runner pair` again)';
      this.emit('fatal', code, why);
      return;
    }
    if (this.connectedAt && Date.now() - this.connectedAt >= this.backoff.resetAfterMs) this.attempt = 0;
    this.connectedAt = 0;
    const delay = backoffDelay(this.attempt++, this.backoff, this.random);
    if (wasReady) {
      this.offlineSince = Date.now();
      this.failed = 0;
      this.lastError = '';
      this.log.info(`disconnected (code ${code}); reconnecting in ${delay} ms`);
    } else {
      this.failed++;
      this.lastError = this.attemptError || `closed with code ${code}`;
      const offline = this.offlineSince ? Math.round((Date.now() - this.offlineSince) / 1000) : 0;
      this.log.warn(
        `connection attempt ${this.failed} failed (${this.lastError}); offline for ${offline} s; retrying in ${delay} ms`,
      );
    }
    this.nextAttemptAt = Date.now() + delay;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    if (!wasReady) this.emit('retry', this.state());
  }
}
