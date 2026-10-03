import {
  HEARTBEAT_SEC,
  normalizeRemoteUrl,
  type RunnerToServer,
  type RunnerToServerOf,
  type ServerToRunner,
  streamId,
} from '@aom/shared';
import type { ChatTerminal } from '../chat/relay.ts';
import { cardMessage, orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { alignDevopsRuntime, createDevOpsRequestIn, endDevopsShift } from '../commands/devops.ts';
import { applyFinalizeResult } from '../commands/finalize.ts';
import {
  applyShiftEnded,
  applyShiftRejected,
  applyShiftReport,
  applyShiftStarted,
  markShiftAccepted,
  type ReportResult,
  releaseClaimEvents,
} from '../commands/shifts.ts';
import { applyVaultConflict, markVaultStatus, queueVaultConfigure } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { buildBrief } from './brief.ts';
import { completeCommand, markCommandSent, pendingCommands } from './commands-queue.ts';
import { ledgerSearchRpc } from './ledger-rpc.ts';
import type { RunnerConn } from './registry.ts';
import { issueRotatedToken } from './rotation.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONCURRENT_SHIFTS = 4;
const LOST_AFTER_MISSED_HEARTBEATS = 2;
const STOP_RESEND_MS = 30_000;

type Payload<T extends ServerToRunner['type']> = Omit<
  Extract<ServerToRunner, { type: T }>,
  'v' | 'id' | 'type' | 'ts'
>;

export class RunnerHandlers {
  constructor(private readonly ctx: Ctx) {}

  private send<T extends ServerToRunner['type']>(conn: RunnerConn, type: T, payload: Payload<T>) {
    return this.ctx.services.runners.send(conn.workstationId, type, payload, this.ctx.clock.now());
  }

  private ack(conn: RunnerConn, msg: RunnerToServer): void {
    this.send(conn, 'ack', { ackOf: msg.id });
  }

  /** Runs `fn` in an append transaction; the message id is recorded in runner_inbox in the same transaction. */
  private async withInbox<T>(
    conn: RunnerConn,
    messageId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<{ duplicate: boolean; result: T | undefined }> {
    return withAppendTx(this.ctx.pool, async (tx) => {
      const useInbox = UUID_RE.test(messageId);
      if (useInbox) {
        const ins = await one(
          tx,
          'INSERT INTO runner_inbox (message_id, workstation_id) VALUES ($1,$2) ON CONFLICT (message_id) DO NOTHING RETURNING message_id',
          [messageId, conn.workstationId],
        );
        if (!ins) {
          const prior = await one(tx, 'SELECT result FROM runner_inbox WHERE message_id=$1', [messageId]);
          return { duplicate: true, result: (prior?.result ?? undefined) as T | undefined };
        }
      }
      const result = await fn(tx);
      if (useInbox && result !== undefined) {
        await exec(tx, 'UPDATE runner_inbox SET result=$2 WHERE message_id=$1', [
          messageId,
          JSON.stringify(result),
        ]);
      }
      return { duplicate: false, result };
    });
  }

  async handle(conn: RunnerConn, msg: RunnerToServer): Promise<void> {
    const ws = { id: conn.workstationId, userId: conn.userId };
    switch (msg.type) {
      case 'hello':
        return this.hello(conn, msg);
      case 'outbox.flushed':
        return this.reconcile(conn);
      case 'heartbeat':
        return this.heartbeat(conn, msg);
      case 'repos.report':
        conn.lastRepos = msg.repos;
        await this.matchRepos(conn);
        return;
      case 'shift.accepted':
        await markShiftAccepted(this.ctx, ws, msg.shiftId);
        return this.ack(conn, msg);
      case 'shift.rejected': {
        const s = await one(this.ctx.pool, 'SELECT agent_id FROM shifts WHERE id=$1', [msg.shiftId]);
        if (s) this.ctx.services.dispatcher.cooldown.set(s.agent_id, this.ctx.clock.now().getTime() + 30_000);
        await this.withInbox(conn, msg.id, (tx) => applyShiftRejected(this.ctx, tx, ws, msg));
        return this.ack(conn, msg);
      }
      case 'shift.started':
        await this.withInbox(conn, msg.id, (tx) => applyShiftStarted(this.ctx, tx, ws, msg));
        return this.ack(conn, msg);
      case 'shift.progress':
        return this.progress(conn, msg);
      case 'shift.report': {
        const { duplicate, result } = await this.withInbox<ReportResult>(conn, msg.id, (tx) =>
          applyShiftReport(this.ctx, tx, ws, msg),
        );
        this.ack(conn, msg);
        // A report may queue runner commands (worktree removal of a finished suite card).
        await this.deliverPending(conn.workstationId);
        const r = result ?? { accepted: duplicate };
        this.send(conn, 'shift.report.result', {
          reportId: msg.reportId,
          accepted: r.accepted,
          error: r.error,
          message: r.message,
          matches: r.matches,
        });
        return;
      }
      case 'shift.ended':
        await this.withInbox(conn, msg.id, (tx) => applyShiftEnded(this.ctx, tx, ws, msg));
        return this.ack(conn, msg);
      case 'rpc.request':
        return this.rpc(conn, msg);
      case 'command.result': {
        const cmd = await one(this.ctx.pool, 'SELECT type, payload FROM runner_commands WHERE id=$1', [
          msg.commandId,
        ]);
        if (cmd?.type === 'finalize.execute') {
          // Terminal: the outcome (finalized, conflict or failure) is recorded on the card, never retried blindly.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyFinalizeResult(
            this.ctx,
            conn.workstationId,
            cmd.payload.cardId,
            msg.ok,
            msg.result,
            msg.error,
          );
        } else {
          await completeCommand(this.ctx.pool, msg.commandId, msg.ok, msg.error, this.ctx.clock.now());
        }
        return this.ack(conn, msg);
      }
      case 'chat.delta':
        return this.ctx.services.chat.onDelta(conn.workstationId, msg);
      case 'chat.done':
      case 'chat.error': {
        const chat = this.ctx.services.chat;
        const { duplicate, result } = await this.withInbox<ChatTerminal | null>(conn, msg.id, async (tx) =>
          msg.type === 'chat.done'
            ? ((await chat.applyDone(conn.workstationId, msg, tx)) ?? null)
            : ((await chat.applyError(conn.workstationId, msg, tx)) ?? null),
        );
        if (!duplicate) chat.notify(result ?? undefined);
        return this.ack(conn, msg);
      }
      case 'token.rotate':
        this.send(conn, 'token.rotated', { token: await issueRotatedToken(this.ctx, conn.workstationId) });
        return;
      case 'vault.status':
        await markVaultStatus(this.ctx, conn.workstationId, msg);
        return;
      case 'vault.conflict':
        await this.withInbox(conn, msg.id, (tx) => applyVaultConflict(this.ctx, tx, ws, msg));
        return this.ack(conn, msg);
      default:
        return; // ack: nothing to do
    }
  }

  // ------------------------------------------------------------------------------------ hello

  private async hello(conn: RunnerConn, msg: RunnerToServerOf<'hello'>) {
    const { ctx } = this;
    const now = ctx.clock.now();
    conn.helloAt = now;
    conn.lastRepos = msg.repos;
    conn.helloShiftIds = msg.activeShifts.map((s) => s.shiftId);
    await exec(
      ctx.pool,
      `UPDATE workstations SET runtimes=$2, runner_version=$3, hostname=$4, platform=$5, last_seen_at=$6 WHERE id=$1`,
      [conn.workstationId, JSON.stringify(msg.runtimes), msg.runnerVersion, msg.hostname, msg.platform, now],
    );
    await this.matchRepos(conn);
    await this.recordVaults(conn, msg.vaults);
    await alignDevopsRuntime(ctx, conn.workstationId, msg.runtimes);
    await ctx.store.append([
      {
        streamId: streamId.workstation(conn.workstationId),
        event: {
          type: 'WorkstationConnected',
          payload: { workstationId: conn.workstationId, runnerVersion: msg.runnerVersion },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(conn.userId),
      },
    ]);
    this.send(conn, 'welcome', {
      workstationId: conn.workstationId,
      serverTime: now.toISOString(),
      heartbeatSec: HEARTBEAT_SEC,
      limits: { maxConcurrentShifts: MAX_CONCURRENT_SHIFTS },
    });
    // With nothing in the runner's outbox there is nothing to wait for; otherwise reconcile on outbox.flushed.
    if (msg.outboxPending === 0) await this.reconcile(conn);
  }

  /** Reconciliation after (re)connect, once the runner has resent its outbox (docs/ARCHITECTURE.md section 11.2). */
  async reconcile(conn: RunnerConn) {
    const { ctx } = this;
    if (conn.reconciled) return;
    conn.reconciled = true;
    const helloAt = conn.helloAt ?? ctx.clock.now();
    const known = new Set(conn.helloShiftIds);
    const lost = await rows(
      ctx.pool,
      `SELECT c.id FROM cards c WHERE c.claim_workstation_id=$1 AND c.claim_id IS NOT NULL AND c.claimed_at <= $2`,
      [conn.workstationId, helloAt],
    );
    for (const c of lost) {
      await withAppendTx(ctx.pool, async (tx) => {
        const card = (await tx.query('SELECT * FROM cards WHERE id=$1 FOR UPDATE', [c.id])).rows[0];
        if (
          !card?.claim_id ||
          card.claim_workstation_id !== conn.workstationId ||
          known.has(card.claim_shift_id)
        )
          return;
        await ctx.store.append(
          await releaseClaimEvents(
            tx,
            card,
            'runner_lost_shift',
            'The runner reconnected without this shift; the card is back in the queue.',
            'lost',
          ),
          { tx },
        );
      });
    }
    // Shifts the runner still runs but the server no longer holds.
    for (const shiftId of known) await this.stopIfClaimLost(conn, shiftId);
    await this.reconcileDevops(conn, known, helloAt);
    await queueVaultConfigure(ctx, ctx.pool, conn.workstationId);
    await this.deliverPending(conn.workstationId);
    ctx.services.dispatcher.trigger();
  }

  /** Vault clones the runner reports in `hello` (their local paths) for the vaults it may sync. */
  private async recordVaults(
    conn: RunnerConn,
    vaults: Array<{ vaultId: string; localPath: string; clean: boolean }>,
  ): Promise<void> {
    for (const v of vaults) {
      if (!UUID_RE.test(v.vaultId)) continue;
      await exec(
        this.ctx.pool,
        `INSERT INTO workstation_vaults (workstation_id, vault_id, local_path)
         SELECT $1, v.id, $3 FROM vaults v WHERE v.id = $2
         ON CONFLICT (workstation_id, vault_id) DO UPDATE SET local_path = EXCLUDED.local_path`,
        [conn.workstationId, v.vaultId, v.localPath],
      );
    }
  }

  /** DevOps shifts the server holds as running but the reconnected runner does not: requeue their requests. */
  private async reconcileDevops(conn: RunnerConn, known: Set<string>, helloAt: Date): Promise<void> {
    const { ctx } = this;
    const open = await rows(
      ctx.pool,
      `SELECT id FROM shifts WHERE workstation_id=$1 AND kind='devops' AND status <> 'ended' AND started_at <= $2`,
      [conn.workstationId, helloAt],
    );
    for (const s of open) {
      if (known.has(s.id)) continue;
      await withAppendTx(ctx.pool, async (tx) => {
        const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [s.id]);
        if (shift) await ctx.store.append(await endDevopsShift(tx, shift, 'lost'), { tx });
      });
    }
  }

  private async stopIfClaimLost(conn: RunnerConn, shiftId: string): Promise<void> {
    const holder =
      (await one(this.ctx.pool, 'SELECT 1 FROM cards WHERE claim_shift_id=$1 AND claim_id IS NOT NULL', [
        shiftId,
      ])) ??
      // A DevOps shift has no card: it is held while its request is running.
      (await one(this.ctx.pool, `SELECT 1 FROM devops_requests WHERE shift_id=$1 AND status='running'`, [
        shiftId,
      ]));
    if (holder) return;
    const last = conn.stopSentAt.get(shiftId) ?? 0;
    const now = this.ctx.clock.now().getTime();
    if (now - last < STOP_RESEND_MS) return;
    conn.stopSentAt.set(shiftId, now);
    this.send(conn, 'shift.stop', { shiftId, reason: 'claim_lost' });
  }

  async deliverPending(workstationId: string): Promise<void> {
    const conn = this.ctx.services.runners.get(workstationId);
    if (!conn || conn.socket.readyState !== 1) return;
    for (const c of await pendingCommands(this.ctx.pool, workstationId)) {
      await markCommandSent(this.ctx.pool, c.id, this.ctx.clock.now());
      this.send(conn, 'command', { commandId: c.id, command: c.type, payload: c.payload });
    }
  }

  // --------------------------------------------------------------------------------- heartbeat

  private async heartbeat(conn: RunnerConn, msg: RunnerToServerOf<'heartbeat'>) {
    const { ctx } = this;
    const now = ctx.clock.now();
    const reported = new Set(msg.activeShifts);
    await exec(ctx.pool, 'UPDATE workstations SET last_seen_at=$2 WHERE id=$1', [conn.workstationId, now]);
    if (msg.activeShifts.length) {
      await exec(
        ctx.pool,
        `UPDATE cards SET lease_expires_at=$3 WHERE claim_workstation_id=$1 AND claim_shift_id = ANY($2::uuid[]) AND claim_id IS NOT NULL`,
        [
          conn.workstationId,
          msg.activeShifts.filter((s) => UUID_RE.test(s)),
          new Date(now.getTime() + 3600_000),
        ],
      );
    }
    // Server holds a running shift the runner does not report for 2 consecutive heartbeats: lost.
    const mine = await rows(
      ctx.pool,
      `SELECT s.id AS shift_id, c.id AS card_id FROM shifts s JOIN cards c ON c.claim_shift_id = s.id AND c.claim_id IS NOT NULL
        WHERE s.workstation_id=$1 AND s.status='running'`,
      [conn.workstationId],
    );
    for (const m of mine) {
      if (reported.has(m.shift_id)) {
        conn.missing.delete(m.shift_id);
        continue;
      }
      const n = (conn.missing.get(m.shift_id) ?? 0) + 1;
      conn.missing.set(m.shift_id, n);
      if (n < LOST_AFTER_MISSED_HEARTBEATS) continue;
      conn.missing.delete(m.shift_id);
      await withAppendTx(ctx.pool, async (tx) => {
        const card = (await tx.query('SELECT * FROM cards WHERE id=$1 FOR UPDATE', [m.card_id])).rows[0];
        if (!card || card.claim_shift_id !== m.shift_id) return;
        await ctx.store.append(
          await releaseClaimEvents(
            tx,
            card,
            'runner_lost_shift',
            'The runner stopped reporting this shift; the card is back in the queue.',
            'lost',
          ),
          { tx },
        );
      });
    }
    // Runner reports shifts the server released: tell it to stop.
    for (const id of reported) if (UUID_RE.test(id)) await this.stopIfClaimLost(conn, id);
  }

  // ----------------------------------------------------------------------------------- progress

  private async progress(conn: RunnerConn, msg: RunnerToServerOf<'shift.progress'>) {
    const { ctx } = this;
    const s = await one(
      ctx.pool,
      'SELECT id, card_id, progress_tail FROM shifts WHERE id=$1 AND workstation_id=$2',
      [msg.shiftId, conn.workstationId],
    );
    if (!s) return;
    const tail = [...(s.progress_tail as unknown[]), ...msg.items].slice(-50);
    await exec(ctx.pool, 'UPDATE shifts SET progress_tail=$2 WHERE id=$1', [s.id, JSON.stringify(tail)]);
    ctx.services.browser.shiftProgress(s.id, s.card_id, msg.items);
  }

  // ----------------------------------------------------------------------------------- repos

  /** Matches reported repos to project repos of projects the workstation's user is an active member of. */
  async matchRepos(conn: RunnerConn) {
    const { ctx } = this;
    const now = ctx.clock.now();
    await withAppendTx(ctx.pool, async (tx) => {
      await exec(tx, 'DELETE FROM workstation_repos WHERE workstation_id=$1', [conn.workstationId]);
      for (const r of conn.lastRepos) {
        const n = normalizeRemoteUrl(r.remoteUrl);
        const matches = await rows(
          tx,
          `SELECT pr.id FROM project_repos pr
             JOIN project_members pm ON pm.project_id = pr.project_id AND pm.user_id = $2 AND pm.status = 'active'
            WHERE pr.remote_url_normalized = $1 AND pr.removed_at IS NULL`,
          [n, conn.userId],
        );
        for (const m of matches) {
          await exec(
            tx,
            `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at) VALUES ($1,$2,$3,$4)
             ON CONFLICT (workstation_id, project_repo_id) DO UPDATE SET local_path=EXCLUDED.local_path, reported_at=EXCLUDED.reported_at`,
            [conn.workstationId, m.id, r.localPath, now],
          );
        }
      }
    });
    ctx.services.dispatcher.trigger();
  }

  /** `aom devops "<text>"` from a running shift: a request for this workstation's DevOps engineer (non-terminal). */
  private async devopsRequest(
    conn: RunnerConn,
    shift: Record<string, any>,
    params: Record<string, unknown>,
  ): Promise<[boolean, unknown?, string?]> {
    const text = String(params.text ?? params.summary ?? '').trim();
    if (!text) return [false, undefined, 'a request text is required'];
    if (shift.kind === 'devops') return [false, undefined, 'the DevOps engineer cannot ask itself'];
    const agent = await one(this.ctx.pool, 'SELECT id, name FROM agents WHERE id=$1', [shift.agent_id]);
    const r = await withAppendTx(this.ctx.pool, (tx) =>
      createDevOpsRequestIn(this.ctx, tx, {
        workstationId: conn.workstationId,
        summary: text,
        requestedBy: { kind: 'agent', id: shift.agent_id, name: agent?.name },
        cardId: shift.card_id ?? undefined,
      }),
    );
    this.ctx.services.dispatcher.trigger();
    return [
      true,
      {
        requestId: r.requestId,
        threadId: r.threadId,
        message: 'Request sent to the DevOps engineer. Continue your work; do not wait for it.',
      },
    ];
  }

  // ---------------------------------------------------------------------------------------- rpc

  private async rpc(conn: RunnerConn, msg: RunnerToServerOf<'rpc.request'>): Promise<void> {
    const { ctx } = this;
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      this.send(conn, 'rpc.response', { rpcId: msg.rpcId, ok, result, error });
    };
    try {
      const shift = await one(ctx.pool, 'SELECT * FROM shifts WHERE id=$1 AND workstation_id=$2', [
        msg.shiftId,
        conn.workstationId,
      ]);
      if (!shift) return reply(false, undefined, 'unknown shift');
      if (msg.method === 'ledger.search') return reply(true, await ledgerSearchRpc(ctx, shift, msg.params));
      if (msg.method === 'devops.request')
        return reply(...(await this.devopsRequest(conn, shift, msg.params)));
      if (!shift.card_id) return reply(false, undefined, 'this conversation has no card');
      switch (msg.method) {
        case 'card.get': {
          const brief = await buildBrief(ctx, shift);
          return reply(!!brief, brief ?? undefined, brief ? undefined : 'card unavailable');
        }
        case 'thread.read': {
          const brief = await buildBrief(ctx, shift);
          return reply(true, { messages: brief?.thread ?? [] });
        }
        case 'thread.post': {
          const body = String(msg.params.body ?? msg.params.note ?? '').trim();
          if (!body) return reply(false, undefined, 'body is required');
          const card = await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [shift.card_id]);
          // Chat conversations comment on the card in context without holding its claim.
          if (!card || (shift.kind !== 'chat' && card.claim_shift_id !== shift.id))
            return reply(false, undefined, 'this shift no longer holds the claim');
          const m = cardMessage(card, { kind: 'agent', agentId: shift.agent_id }, 'comment', body);
          await ctx.store.append([m]);
          return reply(true, { messageId: (m.event.payload as { messageId: string }).messageId });
        }
        default:
          return reply(false, undefined, `${msg.method} is not available yet`);
      }
    } catch (err) {
      ctx.log.error({ err }, 'rpc failed');
      reply(false, undefined, 'internal error');
    }
  }
}
