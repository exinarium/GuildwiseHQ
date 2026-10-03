import {
  type AuthUser,
  type BrowserToServer,
  BrowserToServerSchema,
  type ProgressItem,
  RESYNC_THRESHOLD,
  type ServerToBrowser,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { checkWsOrigin } from '../auth/origin-check.ts';
import { lookupSession, SESSION_COOKIE } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { canSee, loadProjects, replayVisible, toVisibleEvent } from './visibility.ts';

interface BConn {
  socket: WebSocket;
  user: AuthUser;
  userId: string;
  sessionId: string;
  projects: Set<string>;
  watchers: Set<string>;
  /** False until `hello` was processed (live events are buffered meanwhile). */
  ready: boolean;
  buffer: StoredEvent[];
  sentUpTo: bigint;
}

const PROJECT_EVENTS = new Set([
  'ProjectCreated',
  'ProjectShared',
  'ProjectShareAccepted',
  'ProjectShareDeclined',
  'ProjectMemberRemoved',
]);

/** `/api/ws`: per-user event fan-out with replay, shift log watching, presence. */
export class BrowserGateway {
  private conns = new Set<BConn>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ctx: Ctx) {}

  register(app: FastifyInstance): void {
    app.get('/api/ws', { websocket: true }, (socket, req) => {
      this.onConnection(socket, req.headers.origin, req.cookies[SESSION_COOKIE]);
    });
    this.unsubscribe = this.ctx.store.subscribe((e) => this.onEvent(e));
  }

  private send(c: BConn, msg: ServerToBrowser): void {
    if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg));
  }

  private onConnection(socket: WebSocket, origin: string | undefined, sid: string | undefined): void {
    const { ctx } = this;
    // Listeners are attached synchronously (the client may send `hello` right after the upgrade);
    // messages wait for authentication and are processed in order.
    let chain: Promise<BConn | null> = this.authenticate(socket, origin, sid);
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
    const conn: BConn = {
      socket,
      user: { id: session.user.id, role: session.user.role },
      userId: session.user.id,
      sessionId: session.sessionId,
      projects: await loadProjects(ctx.pool, session.user.id),
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
            c.user,
            c.projects,
            BigInt(msg.lastSeq),
            RESYNC_THRESHOLD + 1,
          );
          if (missed.length > RESYNC_THRESHOLD) this.send(c, { type: 'resync' });
          else
            for (const e of missed) {
              if (e.seq > maxSeq) break;
              this.send(c, { type: 'event', event: toVisibleEvent(e) });
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
      case 'chat.cancel':
        return this.send(c, {
          type: 'chat.error',
          threadId: msg.threadId,
          reason: 'chat is not available yet',
        });
    }
  }

  private async canWatch(c: BConn, shiftId: string): Promise<boolean> {
    const s = await one(this.ctx.pool, 'SELECT org_id, card_id FROM shifts WHERE id=$1', [shiftId]);
    if (!s) return false;
    if (s.card_id) {
      const card = await one(this.ctx.pool, 'SELECT project_id FROM cards WHERE id=$1', [s.card_id]);
      return !!card && !!(await projectRole(this.ctx.pool, c.userId, card.project_id));
    }
    return s.org_id === c.userId;
  }

  private deliver(c: BConn, e: StoredEvent): void {
    if (!canSee(c.user, e, c.projects)) return;
    this.send(c, { type: 'event', event: toVisibleEvent(e) });
    c.sentUpTo = e.seq;
  }

  private async onEvent(e: StoredEvent): Promise<void> {
    const t = e.event.type;
    const payload = e.event.payload as Record<string, any>;
    if (t === 'UserDeactivated') this.closeUser(payload.userId);
    for (const c of this.conns) {
      if (PROJECT_EVENTS.has(t)) c.projects = await loadProjects(this.ctx.pool, c.userId);
      if (t === 'UserRoleChanged' && payload.userId === c.userId)
        c.user = { id: c.userId, role: payload.role };
      if (!c.ready) {
        c.buffer.push(e);
        continue;
      }
      if (e.seq > c.sentUpTo) this.deliver(c, e);
      if ((t === 'WorkstationConnected' || t === 'WorkstationDisconnected') && e.scope.orgId === c.userId) {
        this.send(c, {
          type: 'presence',
          workstationId: payload.workstationId,
          connected: t === 'WorkstationConnected',
        });
      }
    }
  }

  /** Forwards runner progress to the sockets watching the shift. */
  shiftProgress(shiftId: string, cardId: string | null, items: ProgressItem[]): void {
    for (const c of this.conns) {
      if (c.watchers.has(shiftId)) this.send(c, { type: 'shift.progress', shiftId, cardId, items });
    }
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
