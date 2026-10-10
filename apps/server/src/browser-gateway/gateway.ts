import {
  type BrowserToServer,
  BrowserToServerSchema,
  isOrgManager,
  type OrgRole,
  type ProgressItem,
  RESYNC_THRESHOLD,
  type ServerToBrowser,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { orgRoleOf, resolveOrgId } from '../auth/org-context.ts';
import { checkWsOrigin } from '../auth/origin-check.ts';
import { lookupSession, SESSION_COOKIE } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { accessOf, loadProjects, replayVisible, type SocketViewer, toVisibleEvent } from './visibility.ts';

interface BConn {
  socket: WebSocket;
  /** Who is looking and in which organization (the socket's `?org=`, else the session's default). */
  viewer: SocketViewer;
  userId: string;
  sessionId: string;
  projects: Set<string>;
  watchers: Set<string>;
  /** False until `hello` was processed (live events are buffered meanwhile). */
  ready: boolean;
  buffer: StoredEvent[];
  sentUpTo: bigint;
}

/** Events after which a socket's project set or organization role may have changed. */
const ACCESS_EVENTS = new Set([
  'ProjectCreated',
  'ProjectShared',
  'ProjectShareAccepted',
  'ProjectShareDeclined',
  'ProjectMemberAdded',
  'ProjectMemberRemoved',
  'ProjectDeleted',
  'OrgMemberAdded',
  'OrgMemberRoleChanged',
  'OrgMemberRemoved',
  'OrgOwnershipTransferred',
  'OrgStatusChanged',
]);

/** `/api/ws`: per-user event fan-out with replay, shift log watching, presence. */
export class BrowserGateway {
  private conns = new Set<BConn>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ctx: Ctx) {}

  register(app: FastifyInstance): void {
    app.get('/api/ws', { websocket: true }, (socket, req) => {
      const org = (req.query as { org?: string } | undefined)?.org;
      this.onConnection(socket, req.headers.origin, req.cookies[SESSION_COOKIE], org);
    });
    this.unsubscribe = this.ctx.store.subscribe((e) => this.onEvent(e));
  }

  private send(c: BConn, msg: ServerToBrowser): void {
    if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg));
  }

  private onConnection(
    socket: WebSocket,
    origin: string | undefined,
    sid: string | undefined,
    org: string | undefined,
  ): void {
    const { ctx } = this;
    // Listeners are attached synchronously (the client may send `hello` right after the upgrade);
    // messages wait for authentication and are processed in order.
    let chain: Promise<BConn | null> = this.authenticate(socket, origin, sid, org);
    socket.on('message', (data) => {
      chain = chain.then(async (conn) => {
        if (!conn) return null;
        let json: unknown;
        try {
          json = JSON.parse(data.toString());
        } catch {
          return conn;
        }
        const parsed = BrowserToServerSchema.safeParse(json);
        if (!parsed.success) return conn;
        try {
          await this.handle(conn, parsed.data);
        } catch (err) {
          ctx.log.error({ err }, 'browser message failed');
        }
        return conn;
      });
    });
    const drop = () => {
      void chain.then((conn) => {
        if (conn) this.conns.delete(conn);
      });
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private async authenticate(
    socket: WebSocket,
    origin: string | undefined,
    sid: string | undefined,
    org: string | undefined,
  ): Promise<BConn | null> {
    const { ctx } = this;
    if (!checkWsOrigin(ctx.config, origin)) {
      socket.close(4403, 'bad origin');
      return null;
    }
    const session = await lookupSession(ctx, sid);
    if (!session) {
      socket.close(4401, 'unauthenticated');
      return null;
    }
    // Platform accounts see the `admin` audience only; two-factor setup pending: nothing.
    if (session.twoFactor.setupRequired || session.mustChangePassword) {
      socket.close(4403, 'two-factor setup required');
      return null;
    }
    let orgId: string | null = null;
    try {
      orgId =
        session.user.kind === 'super_admin'
          ? null
          : await resolveOrgId(ctx, session, org && /^[0-9a-f-]{36}$/i.test(org) ? org.toLowerCase() : null);
    } catch {
      socket.close(4403, 'org_forbidden');
      return null;
    }
    const projects = await loadProjects(ctx.pool, session.user.id);
    const conn: BConn = {
      socket,
      viewer: {
        userId: session.user.id,
        kind: session.user.kind,
        orgId,
        orgRole: orgId ? await orgRoleOf(ctx.pool, session.user.id, orgId) : null,
        visibleProjectIds: projects,
      },
      userId: session.user.id,
      sessionId: session.sessionId,
      projects,
      watchers: new Set(),
      ready: false,
      buffer: [],
      sentUpTo: 0n,
    };
    this.conns.add(conn);
    return conn;
  }

  private async handle(c: BConn, msg: BrowserToServer): Promise<void> {
    switch (msg.type) {
      case 'ping':
        return this.send(c, { type: 'pong' });
      case 'hello': {
        const maxSeq = await this.ctx.store.maxSeq();
        const upTo = maxSeq;
        if (msg.lastSeq !== undefined) {
          const missed = await replayVisible(
            this.ctx.pool,
            c.viewer,
            BigInt(msg.lastSeq),
            RESYNC_THRESHOLD + 1,
          );
          if (missed.length > RESYNC_THRESHOLD) this.send(c, { type: 'resync' });
          else
            for (const e of missed) {
              if (e.seq > maxSeq) break;
              const level = accessOf(c.viewer, e);
              if (level) this.send(c, { type: 'event', event: toVisibleEvent(e, level) });
            }
        }
        c.sentUpTo = upTo;
        this.send(c, { type: 'ready', seq: Number(upTo) });
        c.ready = true;
        const queued = c.buffer.splice(0);
        for (const e of queued) if (e.seq > c.sentUpTo) this.deliver(c, e);
        return;
      }
      case 'shift.watch': {
        if (await this.canWatch(c, msg.shiftId)) c.watchers.add(msg.shiftId);
        return;
      }
      case 'shift.unwatch':
        c.watchers.delete(msg.shiftId);
        return;
      case 'chat.send':
        return this.ctx.services.chat.send(c.userId, msg);
      case 'chat.cancel':
        return this.ctx.services.chat.cancel(c.userId, msg.threadId);
    }
  }

  private async canWatch(c: BConn, shiftId: string): Promise<boolean> {
    const s = await one(this.ctx.pool, 'SELECT org_id, card_id FROM shifts WHERE id=$1', [shiftId]);
    if (!s) return false;
    if (s.card_id) {
      const card = await one(this.ctx.pool, 'SELECT project_id FROM cards WHERE id=$1', [s.card_id]);
      return !!card && !!(await projectRole(this.ctx.pool, c.userId, card.project_id));
    }
    // A chat, DevOps or BA shift: the organization's Owner and Admins, or the user whose workstation runs it.
    const mine = await one(
      this.ctx.pool,
      'SELECT 1 FROM shifts s JOIN workstations w ON w.id = s.workstation_id WHERE s.id=$1 AND w.user_id=$2',
      [shiftId, c.userId],
    );
    return !!mine || isOrgManager({ orgRole: await orgRoleOf(this.ctx.pool, c.userId, s.org_id) });
  }

  private deliver(c: BConn, e: StoredEvent): void {
    const level = accessOf(c.viewer, e);
    if (!level) return;
    this.send(c, { type: 'event', event: toVisibleEvent(e, level) });
    c.sentUpTo = e.seq;
  }

  private async onEvent(e: StoredEvent): Promise<void> {
    const t = e.event.type;
    const payload = e.event.payload as Record<string, any>;
    if (t === 'UserDeactivated') this.closeUser(payload.userId);
    for (const c of this.conns) {
      if (ACCESS_EVENTS.has(t)) await this.refreshAccess(c, e);
      if (!c.ready) {
        c.buffer.push(e);
        continue;
      }
      if (e.seq > c.sentUpTo) this.deliver(c, e);
      if (
        (t === 'WorkstationConnected' || t === 'WorkstationDisconnected') &&
        (e.scope.userId === c.userId || (!e.scope.userId && e.scope.orgId === c.userId))
      ) {
        this.send(c, {
          type: 'presence',
          workstationId: payload.workstationId,
          connected: t === 'WorkstationConnected',
        });
      }
    }
  }

  /**
   * After an event that can change what a socket may see (membership, role, status of its organization): recompute
   * its projects and role, and tell the browser to resync when they changed (the client resets its caches).
   */
  private async refreshAccess(c: BConn, e: StoredEvent): Promise<void> {
    const { ctx } = this;
    const before = `${c.viewer.orgRole}|${[...(c.viewer.visibleProjectIds as Set<string>)].sort().join(',')}|${c.viewer.orgId}`;
    c.projects = await loadProjects(ctx.pool, c.userId);
    const orgId = c.viewer.orgId;
    const role: OrgRole | null = orgId ? await orgRoleOf(ctx.pool, c.userId, orgId) : null;
    c.viewer = { ...c.viewer, visibleProjectIds: c.projects, orgRole: role };
    const after = `${role}|${[...c.projects].sort().join(',')}|${orgId}`;
    const status = e.event.type === 'OrgStatusChanged' && e.scope.orgId === orgId;
    if ((before !== after || status) && c.ready) this.send(c, { type: 'resync' });
  }

  /** Forwards runner progress to the sockets watching the shift. */
  shiftProgress(shiftId: string, cardId: string | null, items: ProgressItem[]): void {
    for (const c of this.conns) {
      if (c.watchers.has(shiftId)) this.send(c, { type: 'shift.progress', shiftId, cardId, items });
    }
  }

  /** Sends a message to every open socket of the user (chat streaming). */
  sendToUser(userId: string, msg: ServerToBrowser): void {
    for (const c of this.conns) if (c.userId === userId) this.send(c, msg);
  }

  closeUser(userId: string): void {
    for (const c of [...this.conns]) {
      if (c.userId !== userId) continue;
      this.conns.delete(c);
      try {
        c.socket.close(4401, 'deactivated');
      } catch {
        // ignore
      }
    }
  }

  closeSession(sessionId: string): void {
    for (const c of [...this.conns]) {
      if (c.sessionId !== sessionId) continue;
      this.conns.delete(c);
      try {
        c.socket.close(4401, 'logged out');
      } catch {
        // ignore
      }
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    for (const c of this.conns) {
      try {
        c.socket.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
    this.conns.clear();
  }
}
