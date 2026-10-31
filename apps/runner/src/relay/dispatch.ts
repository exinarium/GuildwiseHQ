import {
  RELAY_RESPONSE_HEADERS,
  RELAY_RESPONSE_MAX_BYTES,
  type RelayKind,
  type ServerToRunnerOf,
} from '@aom/shared';
import type { Logger } from '../log.ts';

/** An integration this workstation serves (config `relay.integrations`). */
export interface LocalRelayIntegration {
  id: string;
  kind: RelayKind;
  label?: string | undefined;
}

/** One provider request as the server relayed it: the body is the exact bytes the provider sent. */
export interface RelayEvent {
  requestId: string;
  integrationId: string;
  kind: RelayKind;
  method: 'GET' | 'POST';
  /** The raw query string, without the `?`. */
  query: string;
  /** Lower-case names, in the order received, duplicates kept. */
  headers: [string, string][];
  body: Buffer;
  receivedAt: Date;
  /** Epoch ms after which the server has already answered 504. */
  deadline: number;
}

export interface RelayReply {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export interface RelayHandlerContext {
  integration: LocalRelayIntegration;
  log: Logger;
}

export type RelayHandler = (e: RelayEvent, ctx: RelayHandlerContext) => Promise<RelayReply>;

/** The payload of the `relay.response` frame. */
export interface RelayResponsePayload {
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

const ALLOWED: ReadonlySet<string> = new Set(RELAY_RESPONSE_HEADERS);

/**
 * Hands each relayed request to the handler registered for its kind and turns the outcome into the answer for the
 * provider. A failure is a non-2xx, so the provider retries: 501 without a handler, 500 when a handler fails, 503 for
 * an integration this workstation does not hold. Content (body, headers, query) is never logged.
 */
export class RelayDispatcher {
  private readonly handlers = new Map<RelayKind, RelayHandler>();

  constructor(
    private readonly opts: {
      integrations: () => LocalRelayIntegration[];
      log: Logger;
      now?: () => number;
    },
  ) {}

  register(kind: RelayKind, handler: RelayHandler): void {
    this.handlers.set(kind, handler);
  }

  /** What this runner announces in `relay.serve`. */
  served(): { integrationId: string; kind: RelayKind }[] {
    return this.opts.integrations().map((i) => ({ integrationId: i.id, kind: i.kind }));
  }

  /**
   * Never throws. Resolves with the answer, or with `null` when the handler did not finish before the deadline: the
   * server has answered 504 by then, so a late answer is dropped.
   */
  async dispatch(msg: ServerToRunnerOf<'relay.request'>): Promise<RelayResponsePayload | null> {
    const now = this.opts.now ?? Date.now;
    const answer = (status: number, extra: Partial<RelayResponsePayload> = {}): RelayResponsePayload => ({
      requestId: msg.requestId,
      status,
      ...extra,
    });
    const integration = this.opts.integrations().find((i) => i.id === msg.integrationId);
    if (!integration || integration.kind !== msg.kind) return answer(503);
    const handler = this.handlers.get(msg.kind);
    if (!handler) return answer(501);
    const receivedAt = new Date(now());
    const deadline = receivedAt.getTime() + msg.deadlineMs;
    const event: RelayEvent = {
      requestId: msg.requestId,
      integrationId: msg.integrationId,
      kind: msg.kind,
      method: msg.method,
      query: msg.query,
      headers: msg.headers,
      body: Buffer.from(msg.body, 'base64'),
      receivedAt,
      deadline,
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), Math.max(0, deadline - now()));
      });
      const reply = await Promise.race([handler(event, { integration, log: this.opts.log }), late]);
      if (reply === 'late') return null;
      return this.toPayload(msg.requestId, reply);
    } catch (err) {
      this.opts.log.warn(
        `relay handler failed ${msg.integrationId} ${msg.requestId}: ${err instanceof Error ? err.name : 'Error'}`,
      );
      return answer(500);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private toPayload(requestId: string, reply: RelayReply): RelayResponsePayload {
    const bad: RelayResponsePayload = { requestId, status: 500 };
    if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599) return bad;
    const body =
      reply.body === undefined
        ? undefined
        : Buffer.isBuffer(reply.body)
          ? reply.body
          : Buffer.from(reply.body);
    if (body && body.length > RELAY_RESPONSE_MAX_BYTES) return bad;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(reply.headers ?? {})) {
      const name = k.toLowerCase();
      if (ALLOWED.has(name) && v.length <= 1000) headers[name] = v;
    }
    return {
      requestId,
      status: reply.status,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body && body.length ? { body: body.toString('base64') } : {}),
    };
  }
}
