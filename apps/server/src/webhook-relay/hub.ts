import {
  isBusinessOrg,
  isOrgOperational,
  RELAY_RESPONSE_HEADERS,
  type RelayKind,
  type RunnerToServerOf,
  uuidv7,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import type { RunnerConn } from '../runner-gateway/registry.ts';

/** What the hub hands back to the public route. Never holds anything but what the runner answered. */
export type HubResult =
  | { kind: 'answer'; status: number; headers: Record<string, string>; body: Buffer }
  | { kind: 'offline' }
  | { kind: 'timeout' };

export interface ForwardRequest {
  integrationId: string;
  kind: RelayKind;
  method: 'GET' | 'POST';
  query: string;
  headers: [string, string][];
  body: Buffer;
}

export interface ServeResult {
  accepted: string[];
  refused: {
    integrationId: string;
    reason: 'unknown' | 'revoked' | 'kind_mismatch' | 'not_allowed' | 'not_business';
  }[];
}

interface Pending {
  conn: RunnerConn;
  integrationId: string;
  resolve: (r: HubResult) => void;
  timer: NodeJS.Timeout;
}

const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(RELAY_RESPONSE_HEADERS);

/**
 * Routes provider requests to the runners that serve an integration and matches their answers. Everything here is in
 * memory and short lived: a request is held only until its answer, its timeout or the runner's disconnect. Nothing is
 * queued, retried or kept; no content is ever logged.
 */
export class RelayHub {
  /** integration id -> workstation id -> the connection that announced it. */
  private serving = new Map<string, Map<string, RunnerConn>>();
  private pending = new Map<string, Pending>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private rr = 0;

  constructor(private readonly ctx: Ctx) {}

  /** Number of requests waiting for a runner's answer (tests). */
  get inFlight(): number {
    return this.pending.size;
  }

  /** Online workstations that serve the integration right now. */
  isServed(integrationId: string): number {
    return this.liveServers(integrationId).length;
  }

  private liveServers(integrationId: string): RunnerConn[] {
    const m = this.serving.get(integrationId);
    if (!m) return [];
    const out: RunnerConn[] = [];
    for (const [ws, conn] of m) {
      if (this.ctx.services.runners.get(ws) === conn && this.ctx.services.runners.isOnline(ws))
        out.push(conn);
    }
    return out;
  }

  /** A runner announces what it serves: this replaces its previous set. */
  async serve(conn: RunnerConn, items: { integrationId: string; kind: RelayKind }[]): Promise<ServeResult> {
    const { ctx } = this;
    const accepted: string[] = [];
    const refused: ServeResult['refused'] = [];
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.integrationId)) continue;
      seen.add(it.integrationId);
      const r = await one(
        ctx.pool,
        `SELECT i.id, i.kind, i.status, i.org_id, o.mode, o.status AS org_status
           FROM relay_integrations i JOIN organizations o ON o.id = i.org_id WHERE i.id=$1`,
        [it.integrationId],
      );
      if (!r) refused.push({ integrationId: it.integrationId, reason: 'unknown' });
      else if (r.status !== 'active') refused.push({ integrationId: it.integrationId, reason: 'revoked' });
      else if (r.kind !== it.kind) refused.push({ integrationId: it.integrationId, reason: 'kind_mismatch' });
      else if (!isBusinessOrg(r) || !isOrgOperational(r.org_status))
        refused.push({ integrationId: it.integrationId, reason: 'not_business' });
      else {
        const m = await one(
          ctx.pool,
          `SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
          [r.org_id, conn.userId],
        );
        if (m?.role === 'owner' || m?.role === 'admin') accepted.push(it.integrationId);
        else refused.push({ integrationId: it.integrationId, reason: 'not_allowed' });
      }
    }
    const now = ctx.clock.now();
    // Drop what this workstation served before and no longer announces.
    const dropped: string[] = [];
    for (const [id, m] of this.serving) {
      if (m.get(conn.workstationId) && !accepted.includes(id)) {
        m.delete(conn.workstationId);
        dropped.push(id);
      }
    }
    for (const id of accepted) {
      const m = this.serving.get(id) ?? new Map<string, RunnerConn>();
      this.serving.set(id, m);
      m.set(conn.workstationId, conn);
    }
    for (const id of accepted)
      await exec(
        ctx.pool,
        `INSERT INTO relay_presence (integration_id, last_served_at, offline_since) VALUES ($1,$2,NULL)
         ON CONFLICT (integration_id) DO UPDATE SET last_served_at=$2, offline_since=NULL`,
        [id, now],
      );
    await this.markOffline(dropped);
    return { accepted, refused };
  }

  /** The offline mark for integrations nobody serves any more. */
  private async markOffline(ids: string[]): Promise<void> {
    const now = this.ctx.clock.now();
    for (const id of ids) {
      if (this.liveServers(id).length > 0) continue;
      if (this.serving.get(id)?.size === 0) this.serving.delete(id);
      // `last_served_at <= now`: a runner that announced it again meanwhile keeps its integration online.
      await exec(
        this.ctx.pool,
        'UPDATE relay_presence SET offline_since=$2 WHERE integration_id=$1 AND offline_since IS NULL AND last_served_at <= $2',
        [id, now],
      ).catch((err) => this.ctx.log.error({ err: err?.name }, 'relay presence update failed'));
    }
  }

  /**
   * The socket closed (not queued behind other frames): answers in flight on it end as offline at once, and the
   * integrations it served are marked offline if no other runner serves them.
   */
  async disconnected(conn: RunnerConn): Promise<void> {
    for (const [requestId, p] of this.pending) {
      if (p.conn !== conn) continue;
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.resolve({ kind: 'offline' });
    }
    const ids: string[] = [];
    for (const [id, m] of this.serving) {
      if (m.get(conn.workstationId) === conn) {
        m.delete(conn.workstationId);
        ids.push(id);
      }
    }
    await this.markOffline(ids);
  }

  /** An integration was revoked: no runner serves it. */
  forget(integrationId: string): void {
    this.serving.delete(integrationId);
    this.buckets.delete(integrationId);
    this.ctx.pool
      .query('DELETE FROM relay_presence WHERE integration_id=$1', [integrationId])
      .catch((err) => this.ctx.log.error({ err: err?.name }, 'relay presence cleanup failed'));
  }

  /** After a restart nothing is served until the runners announce again. */
  async markAllOffline(): Promise<void> {
    await exec(this.ctx.pool, 'UPDATE relay_presence SET offline_since=$1 WHERE offline_since IS NULL', [
      this.ctx.clock.now(),
    ]);
  }

  /** Sends the request to one serving runner and waits for its answer, at most `timeoutMs`. */
  forward(req: ForwardRequest, timeoutMs: number): Promise<HubResult> {
    const { ctx } = this;
    if (this.pending.size >= ctx.config.relay.maxInFlight) return Promise.resolve({ kind: 'offline' });
    const servers = this.liveServers(req.integrationId);
    if (servers.length === 0) return Promise.resolve({ kind: 'offline' });
    const start = this.rr++;
    return new Promise<HubResult>((resolve) => {
      for (let i = 0; i < servers.length; i++) {
        const conn = servers[(start + i) % servers.length] as RunnerConn;
        const requestId = uuidv7();
        const timer = setTimeout(() => {
          // Deleted first: a late answer then finds nothing.
          this.pending.delete(requestId);
          resolve({ kind: 'timeout' });
        }, timeoutMs);
        this.pending.set(requestId, { conn, integrationId: req.integrationId, resolve, timer });
        const sent = ctx.services.runners.send(
          conn.workstationId,
          'relay.request',
          {
            requestId,
            integrationId: req.integrationId,
            kind: req.kind,
            method: req.method,
            query: req.query,
            headers: req.headers,
            body: req.body.toString('base64'),
            deadlineMs: Math.max(1, timeoutMs - 250),
          },
          ctx.clock.now(),
        );
        if (sent) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
      }
      resolve({ kind: 'offline' });
    });
  }

  /** The runner's answer. Late, unknown or from another runner than the one asked: ignored. */
  onResponse(conn: RunnerConn, msg: RunnerToServerOf<'relay.response'>): void {
    const p = this.pending.get(msg.requestId);
    if (!p || p.conn !== conn) {
      this.ctx.log.debug({ requestId: msg.requestId }, 'relay answer ignored');
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(msg.requestId);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.headers ?? {})) {
      const name = k.toLowerCase();
      if (ALLOWED_RESPONSE_HEADERS.has(name) && !/[\r\n]/.test(v)) headers[name] = v;
    }
    p.resolve({
      kind: 'answer',
      status: msg.status,
      headers,
      body: msg.body ? Buffer.from(msg.body, 'base64') : Buffer.alloc(0),
    });
  }

  /** Token bucket per integration: `burst` at once, refilled at `perMinute`. */
  takeToken(integrationId: string, nowMs: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const { perMinute, burst } = this.ctx.config.relay;
    const perMs = perMinute / 60_000;
    const b = this.buckets.get(integrationId) ?? { tokens: burst, at: nowMs };
    b.tokens = Math.min(burst, b.tokens + (nowMs - b.at) * perMs);
    b.at = nowMs;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(integrationId, b);
      return { ok: true };
    }
    this.buckets.set(integrationId, b);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)) };
  }

  /** Metadata of one request: the only thing stored about it. */
  async record(m: {
    orgId: string | null;
    integrationId: string | null;
    kind: string | null;
    method: string;
    sizeBytes: number;
    status: number;
    latencyMs: number;
    outcome: string;
  }): Promise<void> {
    const { ctx } = this;
    try {
      await exec(
        ctx.pool,
        `INSERT INTO relay_requests (at, org_id, integration_id, kind, method, size_bytes, status, latency_ms, outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ctx.clock.now(),
          m.orgId,
          m.integrationId,
          m.kind,
          m.method,
          m.sizeBytes,
          m.status,
          m.latencyMs,
          m.outcome,
        ],
      );
    } catch (err) {
      ctx.log.error({ err: (err as Error)?.name }, 'relay metadata not recorded');
    }
    ctx.log.info(
      {
        relay: {
          integrationId: m.integrationId,
          kind: m.kind,
          method: m.method,
          sizeBytes: m.sizeBytes,
          status: m.status,
          latencyMs: m.latencyMs,
          outcome: m.outcome,
        },
      },
      'relay request',
    );
  }
}

export async function pruneRelayRequests(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - ctx.config.relay.retentionDays * 86_400_000);
  const r = await ctx.pool.query('DELETE FROM relay_requests WHERE at < $1', [cutoff]);
  return r.rowCount ?? 0;
}
