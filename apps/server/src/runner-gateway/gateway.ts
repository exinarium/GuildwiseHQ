import {
  type EventOf,
  RUNNER_TOKEN_PREFIX,
  RunnerToServerSchema,
  type ServerToRunnerOf,
  streamId,
  UNLIMITED_SHIFTS,
  UNPAIRED_CLOSE_REASON,
  WS_CLOSE,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { confirmBranchOnEvent } from '../commands/branch-confirm.ts';
import { SYSTEM_ACTOR, userScope } from '../commands/common.ts';
import { writeResearchIndex } from '../commands/convert.ts';
import { refreshVaultConfig, vaultAudience } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { sha256Hex } from '../crypto.ts';
import { one, rows } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from './commands-queue.ts';
import { RunnerHandlers } from './handlers.ts';
import type { RunnerConn } from './registry.ts';
import { promoteRotatedToken } from './rotation.ts';
import { platformShiftCap } from './shift-limit.ts';

const PING_MS = 15_000;

type StopReason = ServerToRunnerOf<'shift.stop'>['reason'];

/** `/api/runner/ws`: authentication, supersession, framing and the event-driven reactions toward runners. */
export class RunnerGateway {
  readonly handlers: RunnerHandlers;
  private closing = false;
  private unsubscribe: (() => void) | null = null;
  private pings = new Set<NodeJS.Timeout>();

  constructor(private readonly ctx: Ctx) {
    this.handlers = new RunnerHandlers(ctx);
  }

  register(app: FastifyInstance): void {
    app.get('/api/runner/ws', { websocket: true }, (socket, req) =>
      this.onConnection(socket, req.headers.authorization),
    );
    this.unsubscribe = this.ctx.store.subscribe((e) => this.onEvent(e));
  }

  /** Sends `shift.stop` for a shift if its runner is connected. */
  stopShift(workstationId: string, shiftId: string, reason: StopReason): boolean {
    return this.ctx.services.runners.send(
      workstationId,
      'shift.stop',
      { shiftId, reason },
      this.ctx.clock.now(),
    );
  }

  /** Sends `shift.kill_tools` ("stop the running command") if the shift's runner is connected. */
  killTools(workstationId: string, shiftId: string): boolean {
    return this.ctx.services.runners.send(
      workstationId,
      'shift.kill_tools',
      { shiftId },
      this.ctx.clock.now(),
    );
  }

  deliverPending(workstationId: string) {
    return this.handlers.deliverPending(workstationId);
  }

  private onConnection(socket: WebSocket, authorization: string | undefined): void {
    const { ctx } = this;
    let conn: RunnerConn | null = null;
    // Messages are processed strictly in order, after authentication.
    let chain: Promise<unknown> = this.authenticate(socket, authorization).then((c) => {
      conn = c;
      return c;
    });
    let ping: NodeJS.Timeout | undefined;

    socket.on('message', (data) => {
      chain = chain.then(async () => {
        const c = conn as RunnerConn | null;
        if (!c) return;
        let json: unknown;
        try {
          json = JSON.parse(data.toString());
        } catch {
          return;
        }
        const parsed = RunnerToServerSchema.safeParse(json);
        if (!parsed.success) {
          ctx.log.warn({ issues: parsed.error.issues.slice(0, 3) }, 'invalid runner message');
          return;
        }
        try {
          await this.handlers.handle(c, parsed.data);
        } catch (err) {
          ctx.log.error({ err, type: parsed.data.type }, 'runner message handler failed');
        }
      });
    });

    socket.on('close', () => {
      if (ping) {
        clearInterval(ping);
        this.pings.delete(ping);
      }
      chain = chain.then(async () => {
        const c = conn as RunnerConn | null;
        if (!c || this.closing) return;
        if (!ctx.services.runners.remove(c)) return; // superseded
        await ctx.services.chat.workstationLost(c.workstationId);
        try {
          await ctx.store.append([
            {
              streamId: streamId.workstation(c.workstationId),
              event: { type: 'WorkstationDisconnected', payload: { workstationId: c.workstationId } },
              actor: SYSTEM_ACTOR,
              scope: userScope(c.userId),
            },
          ]);
        } catch (err) {
          ctx.log.error({ err }, 'failed to record disconnect');
        }
      });
    });
    socket.on('error', (err) => ctx.log.debug({ err }, 'runner socket error'));

    ping = setInterval(() => {
      if (socket.readyState === 1) socket.ping();
    }, PING_MS);
    ping.unref();
    this.pings.add(ping);
  }

  private async authenticate(
    socket: WebSocket,
    authorization: string | undefined,
  ): Promise<RunnerConn | null> {
    const { ctx } = this;
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token || !token.startsWith(RUNNER_TOKEN_PREFIX)) {
      socket.close(WS_CLOSE.unauthorized, 'unauthorized');
      return null;
    }
    const ws =
      (await one(ctx.pool, 'SELECT id, user_id, status FROM workstations WHERE token_hash=$1', [
        sha256Hex(token),
      ])) ?? (await promoteRotatedToken(ctx, token));
    if (!ws) {
      socket.close(WS_CLOSE.unauthorized, 'unauthorized');
      return null;
    }
    if (ws.status !== 'active') {
      socket.close(WS_CLOSE.forbidden, UNPAIRED_CLOSE_REASON);
      return null;
    }
    // A deactivated account keeps no runner access (also covers workstations that predate the cut-off on deactivation).
    const owner = await one(ctx.pool, 'SELECT status FROM users WHERE id=$1', [ws.user_id]);
    if (owner?.status !== 'active') {
      socket.close(WS_CLOSE.forbidden, 'account deactivated');
      return null;
    }
    const conn: RunnerConn = {
      socket,
      workstationId: ws.id,
      userId: ws.user_id,
      connectedAt: ctx.clock.now(),
      helloAt: null,
      reconciled: false,
      helloShiftIds: [],
      lastRepos: [],
      missing: new Map(),
      stopSentAt: new Map(),
      maxShifts: platformShiftCap(ctx) ?? UNLIMITED_SHIFTS,
    };
    const old = ctx.services.runners.set(conn);
    if (old) {
      try {
        old.socket.close(WS_CLOSE.superseded, 'superseded');
      } catch {
        // already closed
      }
    }
    if (socket.readyState !== 1) ctx.services.runners.remove(conn);
    return conn;
  }

  // ----------------------------------------------------------------- event-driven reactions

  private async onEvent(e: StoredEvent): Promise<void> {
    const { ctx } = this;
    switch (e.event.type) {
      case 'TicketMapped':
      case 'PhaseCreated':
      case 'PhaseConfirmed':
        await confirmBranchOnEvent(ctx, e);
        return;
      case 'ProjectConverted':
        await confirmBranchOnEvent(ctx, e);
        await writeResearchIndex(ctx, e).catch((err) =>
          ctx.log.warn({ err }, 'could not write the research index to PROJECT.md'),
        );
        return;
      case 'WorkstationUnlinked': {
        const p = (e.event as EventOf<'WorkstationUnlinked'>).payload;
        ctx.services.runners.close(p.workstationId, WS_CLOSE.forbidden, UNPAIRED_CLOSE_REASON);
        return;
      }
      case 'ClaimReleased': {
        const p = (e.event as EventOf<'ClaimReleased'>).payload;
        let reason: StopReason | null = null;
        if (p.reason === 'agent_retired' || p.reason === 'member_removed') reason = 'agent_retired';
        else if (p.reason === 'manual') {
          const card = await one(ctx.pool, 'SELECT status FROM cards WHERE id=$1', [p.cardId]);
          reason = card?.status === 'cancelled' ? 'card_cancelled' : 'manager';
        }
        if (!reason) return;
        const open = await rows(
          ctx.pool,
          `SELECT id, workstation_id FROM shifts WHERE card_id=$1 AND agent_id=$2 AND status <> 'ended'`,
          [p.cardId, p.agentId],
        );
        for (const s of open) this.stopShift(s.workstation_id, s.id, reason);
        return;
      }
      case 'AgentRetired': {
        const p = (e.event as EventOf<'AgentRetired'>).payload;
        const a = await one(ctx.pool, 'SELECT workstation_id FROM agents WHERE id=$1', [p.agentId]);
        if (a?.workstation_id) await this.deliverPending(a.workstation_id);
        return;
      }
      case 'AgentReset': {
        // A reset DevOps engineer drops whatever it is doing; the request goes back to the queue.
        const p = (e.event as EventOf<'AgentReset'>).payload;
        const open = await rows(
          ctx.pool,
          `SELECT id, workstation_id FROM shifts WHERE agent_id=$1 AND status <> 'ended'`,
          [p.agentId],
        );
        for (const s of open) this.stopShift(s.workstation_id, s.id, 'agent_retired');
        const a = await one(ctx.pool, 'SELECT workstation_id FROM agents WHERE id=$1', [p.agentId]);
        if (a?.workstation_id) await this.deliverPending(a.workstation_id);
        return;
      }
      case 'VaultRegistered':
      case 'VaultUpdated': {
        const v = await one(ctx.pool, 'SELECT org_id, project_id FROM vaults WHERE id=$1', [
          (e.event.payload as { vaultId: string }).vaultId,
        ]);
        if (v) await refreshVaultConfig(ctx, await vaultAudience(ctx.pool, v as never));
        return;
      }
      case 'ProjectShareAccepted':
      case 'ProjectMemberRemoved': {
        const userId = (e.event.payload as { userId: string }).userId;
        await refreshVaultConfig(ctx, [userId]);
        // Repo matching follows membership: a runner that is already connected re-matches what it reported
        // (joining makes the project's repos visible to it, leaving removes them).
        for (const conn of ctx.services.runners.all()) {
          if (conn.userId !== userId) continue;
          await this.handlers.matchRepos(conn);
          await enqueueRunnerCommand(ctx.pool, conn.workstationId, 'repos.rescan', {});
          await this.deliverPending(conn.workstationId);
        }
        return;
      }
      case 'ProjectRepoAdded':
      case 'ProjectRepoRemoved': {
        const projectId = (e.event.payload as { projectId: string }).projectId;
        const members = await rows<{ user_id: string }>(
          ctx.pool,
          `SELECT user_id FROM project_members WHERE project_id=$1 AND status='active'`,
          [projectId],
        );
        for (const conn of ctx.services.runners.all()) {
          if (!members.some((m) => m.user_id === conn.userId)) continue;
          await this.handlers.matchRepos(conn);
          await enqueueRunnerCommand(ctx.pool, conn.workstationId, 'repos.rescan', {});
          await this.deliverPending(conn.workstationId);
        }
        return;
      }
      default:
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.unsubscribe?.();
    for (const p of this.pings) clearInterval(p);
    for (const c of this.ctx.services.runners.all()) {
      try {
        c.socket.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
  }
}
