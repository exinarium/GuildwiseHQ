import {
  isOrgManager,
  isOrgOperational,
  RELAY_RESPONSE_HEADERS,
  type RelayKind,
  type RunnerToServerOf,
  uuidv7,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import type { RunnerConn } from '../runner-gateway/registry.ts';

/** How long a forward-time role answer is reused (limit: 60 s). */
export const RELAY_ROLE_TTL_MS = 30_000;

export type DropReason =
  | 'member_removed'
  | 'member_left'
  | 'role_changed'
  | 'user_disabled'
  | 'forward_check_failed';

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
  /** integration id -> its organization (set when a server is accepted; integrations never change org). */
  private orgOf = new Map<string, string>();
  /** `${orgId}:${userId}` -> whether the user may serve relay there, and when that was looked up. */
  private roleCache = new Map<string, { at: number; ok: Promise<boolean> }>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ctx: Ctx) {}

  /** Starts listening to membership events so a user who loses owner/admin stops serving at once. */
  start(): void {
    this.unsubscribe = this.ctx.store.subscribe((e) => this.onEvent(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The one rule for who may serve relay for an org: an active owner or admin. */
  private async mayServe(orgId: string, userId: string): Promise<boolean> {
    return isOrgManager({ orgRole: await orgRoleOf(this.ctx.pool, userId, orgId) });
  }

  private async onEvent(e: StoredEvent): Promise<void> {
    const p = e.event.payload as Record<string, any>;
    try {
      switch (e.event.type) {
        case 'OrgMemberRoleChanged':
          return await this.revalidate(p.orgId, p.userId, 'role_changed');
        case 'OrgOwnershipTransferred':
          return await this.revalidate(p.orgId, p.fromUserId, 'role_changed');
        case 'OrgMemberRemoved':
          return await this.revalidate(
            p.orgId,
            p.userId,
            p.reason === 'left'
              ? 'member_left'
              : p.reason === 'deactivated'
                ? 'user_disabled'
                : 'member_removed',
          );
        case 'UserDeactivated':
          for (const k of [...this.roleCache.keys()])
            if (k.endsWith(`:${p.userId}`)) this.roleCache.delete(k);
          return await this.dropServers(null, p.userId, 'user_disabled');
      }
    } catch (err) {
      this.ctx.log.error({ err: (err as Error)?.name }, 'relay membership event failed');
    }
  }

  private servesFor(orgId: string, userId: string): boolean {
    for (const [id, m] of this.serving) {
      if (this.orgOf.get(id) !== orgId) continue;
      for (const conn of m.values()) if (conn.userId === userId) return true;
    }
    return false;
  }

  /** After a membership event: forget the cached answer, re-read the role, drop the user's servers if it no longer qualifies. */
  private async revalidate(orgId: string, userId: string, reason: DropReason): Promise<void> {
    this.roleCache.delete(`${orgId}:${userId}`);
    if (!this.servesFor(orgId, userId)) return;
    const ok = await this.mayServe(orgId, userId).catch((err) => {
      this.ctx.log.warn({ err: err?.name, orgId, userId }, 'relay role re-check failed');
      return false; // fail closed: the runner can announce again
    });
    if (!ok) await this.dropServers(orgId, userId, reason);
  }

  /** Requests waiting on `conn` (optionally for one integration) end as offline now, as on a disconnect. */
  private settlePending(conn: RunnerConn, integrationId?: string): void {
    for (const [requestId, p] of this.pending) {
      if (p.conn !== conn || (integrationId && p.integrationId !== integrationId)) continue;
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.resolve({ kind: 'offline' });
    }
  }

  /**
   * Ends `userId`'s relay serving for `orgId` (every org when null): their entries leave the serving map, requests in
   * flight to them end as offline, and integrations nobody else serves are marked offline. The runner stays connected.
   */
  async dropServers(orgId: string | null, userId: string, reason: DropReason): Promise<void> {
    const ids: string[] = [];
    const perRunner = new Map<string, { orgId: string; workstationId: string; integrationIds: string[] }>();
    for (const [id, m] of this.serving) {
      const org = this.orgOf.get(id);
      if (!org || (orgId && org !== orgId)) continue;
      for (const [ws, conn] of m) {
        if (conn.userId !== userId) continue;
        m.delete(ws);
        this.settlePending(conn, id);
        ids.push(id);
        const key = `${org}:${ws}`;
        const e = perRunner.get(key) ?? { orgId: org, workstationId: ws, integrationIds: [] };
        e.integrationIds.push(id);
        perRunner.set(key, e);
      }
    }
    for (const e of perRunner.values())
      this.ctx.log.info({ relayDrop: { ...e, userId, reason } }, 'relay server dropped');
    await this.markOffline(ids);
  }

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
    const orgs = new Map<string, string>();
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
      else if (!isOrgOperational(r.org_status))
        refused.push({ integrationId: it.integrationId, reason: 'not_business' });
      else {
        if (await this.mayServe(r.org_id, conn.userId)) {
          accepted.push(it.integrationId);
          orgs.set(it.integrationId, r.org_id);
        } else refused.push({ integrationId: it.integrationId, reason: 'not_allowed' });
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
      this.orgOf.set(id, orgs.get(id) as string);
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
      if (this.serving.get(id)?.size === 0) {
        this.serving.delete(id);
        this.orgOf.delete(id);
      }
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
    this.settlePending(conn);
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
    this.orgOf.delete(integrationId);
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

  /** Candidates whose user is still owner/admin (30 s promise cache per org and user); the others are dropped. */
  private async qualifying(integrationId: string, candidates: RunnerConn[]): Promise<RunnerConn[]> {
    const orgId = this.orgOf.get(integrationId);
    if (!orgId) return [];
    const now = this.ctx.clock.now().getTime();
    const verdicts = new Map<string, Promise<boolean | 'error'>>();
    for (const c of candidates) {
      if (verdicts.has(c.userId)) continue;
      const key = `${orgId}:${c.userId}`;
      let hit = this.roleCache.get(key);
      if (!hit || now - hit.at >= RELAY_ROLE_TTL_MS) {
        const fresh = { at: now, ok: this.mayServe(orgId, c.userId) };
        hit = fresh;
        this.roleCache.set(key, fresh);
        fresh.ok.catch(() => {
          if (this.roleCache.get(key) === fresh) this.roleCache.delete(key);
        });
      }
      verdicts.set(
        c.userId,
        hit.ok.catch(() => 'error' as const),
      );
    }
    const out: RunnerConn[] = [];
    for (const c of candidates) {
      const v = await verdicts.get(c.userId);
      if (v === false) {
        await this.dropServers(orgId, c.userId, 'forward_check_failed');
        continue;
      }
      if (v === 'error') continue; // not verified: skip this request, do not drop
      if (this.serving.get(integrationId)?.get(c.workstationId) === c) out.push(c);
    }
    return out;
  }

  /** Sends the request to one serving runner and waits for its answer, at most `timeoutMs`. */
  async forward(req: ForwardRequest, timeoutMs: number): Promise<HubResult> {
    const { ctx } = this;
    if (this.pending.size >= ctx.config.relay.maxInFlight) return { kind: 'offline' };
    const candidates = this.liveServers(req.integrationId);
    if (candidates.length === 0) return { kind: 'offline' };
    const servers = await this.qualifying(req.integrationId, candidates);
    // Re-checked after the await: the limit and the map may have changed meanwhile.
    if (servers.length === 0 || this.pending.size >= ctx.config.relay.maxInFlight) return { kind: 'offline' };
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
