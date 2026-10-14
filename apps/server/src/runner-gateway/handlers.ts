import {
  HEARTBEAT_SEC,
  type McpCall,
  normalizeRemoteUrl,
  type RunnerToServer,
  type RunnerToServerOf,
  type ServerToRunner,
  streamId,
} from '@aom/shared';
import type { ChatTerminal } from '../chat/relay.ts';
import { baTaskRpc, endBaTaskShift } from '../commands/ba-tasks.ts';
import { attachmentRpc } from '../commands/card-attachments.ts';
import { cardMessage, SYSTEM_ACTOR, userScope } from '../commands/common.ts';
import { designRpc } from '../commands/design-rpc.ts';
import { alignDevopsRuntime, createDevOpsRequestIn, endDevopsShift } from '../commands/devops.ts';
import { devopsCardRpc } from '../commands/devops-card.ts';
import { outboundDraftRpc } from '../commands/drafts.ts';
import { endQuestionShift } from '../commands/escalation.ts';
import { applyFinalizeResult } from '../commands/finalize.ts';
import { applyForgeReposResult, applyGitReport, applyJiraReport } from '../commands/forges.ts';
import { applyWorktreeSweepResult } from '../commands/hygiene.ts';
import { intakeRpc } from '../commands/intake.ts';
import { investigationRecordRpc } from '../commands/investigation.ts';
import { applyMcpServersReport, mcpCallsIn, mergeMcpCalls } from '../commands/mcp-servers.ts';
import { syncClaudeAuthNotice, syncMcpSignInNotices } from '../commands/workstation-notices.ts';
import { applyOrgFolderResult, applyOrgFoldersReport } from '../commands/org-folders.ts';
import { applyOutboundResult, finishOutboundCommand, queueApprovedFor } from '../commands/outbox.ts';
import { applyBranchCheckResult } from '../commands/phases.ts';
import { applyReleasePrResult } from '../commands/release-pr.ts';
import { applyRepoCreateResult, repoCreateRpc } from '../commands/repo-create.ts';
import { riskTierRpc } from '../commands/risk.ts';
import { applyIntegrationResult } from '../commands/schedule-triggers.ts';
import {
  applyShiftEnded,
  applyShiftRejected,
  applyShiftReport,
  applyShiftStarted,
  markShiftAccepted,
  type ReportResult,
  releaseClaimEvents,
} from '../commands/shifts.ts';
import { applyToolchainsReport } from '../commands/toolchains.ts';
import { transcriptStoreRpc } from '../commands/transcripts.ts';
import { applyVaultConflict, markVaultStatus, queueVaultConfigure } from '../commands/vaults.ts';
import {
  applyEnvEnsureResult,
  applyRepoCloneResult,
  applyRightsResult,
  applySudoSetResult,
  deliver,
  environmentRequestEvents,
} from '../commands/workstation-setup.ts';
import { liveWorktreePaths } from '../commands/worktree-sweep.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { buildBrief } from './brief.ts';
import { claimPendingCommands, completeCommand, requeueSentCommands } from './commands-queue.ts';
import { ledgerSearchRpc } from './ledger-rpc.ts';
import type { RunnerConn } from './registry.ts';
import { issueRotatedToken } from './rotation.ts';
import { recordRepoCatalog } from './workstation-repos.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** M7: what the BA does in its intake chat. */
const INTAKE_METHODS = new Set([
  'card.create',
  'card.update',
  'card.specify',
  'intake.map',
  'intake.unmapped',
  'phase.list',
  'phase.propose',
  'phase.assign',
  'phase.submit',
]);
/** What a DevOps shift may do with the card of its request. */
const DEVOPS_CARD_METHODS = new Set(['card.get', 'card.comment', 'card.update']);
/** M10: what the BA does in a design chat. */
const DESIGN_METHODS = new Set([
  'org.catalogue',
  'org.role.draft',
  'org.workflow.draft',
  'org.workflowVariant',
  'org.validate',
  'org.submit',
  'org.department',
]);
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
        await recordRepoCatalog(this.ctx.pool, conn.workstationId, msg.repoCatalog, this.ctx.clock.now());
        return;
      case 'runtimes.report':
        await this.runtimesReport(conn, msg.runtimes);
        return;
      case 'runner.update':
        await exec(this.ctx.pool, `UPDATE workstations SET runner_update=$2::jsonb WHERE id=$1`, [
          conn.workstationId,
          JSON.stringify({
            state: msg.state,
            latestVersion: msg.latestVersion,
            lastCheckedAt: msg.lastCheckedAt,
            detail: msg.detail,
            reportedAt: this.ctx.clock.now().toISOString(),
          }),
        ]);
        return;
      case 'git.report':
        await applyGitReport(this.ctx, conn.workstationId, msg.connections);
        return;
      case 'org.folders':
        await applyOrgFoldersReport(this.ctx, conn.workstationId, msg);
        return;
      case 'jira.report':
        await applyJiraReport(this.ctx, conn.workstationId, msg.status);
        return;
      case 'mcp.servers':
        await applyMcpServersReport(this.ctx, conn.workstationId, msg);
        await syncMcpSignInNotices(this.ctx, { id: conn.workstationId, userId: conn.userId }, msg).catch(() => {});
        return;
      case 'toolchains.report':
        await applyToolchainsReport(this.ctx, conn.workstationId, msg);
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
      case 'worktrees.query':
        this.send(conn, 'worktrees.live', {
          queryId: msg.queryId,
          live: await liveWorktreePaths(this.ctx.pool, conn.workstationId, msg.paths),
        });
        return;
      case 'command.result': {
        const cmd = await one(
          this.ctx.pool,
          'SELECT type, payload, workstation_id, status FROM runner_commands WHERE id=$1',
          [msg.commandId],
        );
        // A runner may only answer its own commands: a result for another workstation's command (or an unknown
        // one) is acknowledged and dropped, so it can neither complete nor fail somebody else's work.
        if (!cmd || cmd.workstation_id !== conn.workstationId) {
          this.ctx.log.warn(
            { commandId: msg.commandId },
            'command.result for a command this workstation does not own',
          );
          return this.ack(conn, msg);
        }
        // A command is answered once: a second answer (a redelivered command run again) must not apply again.
        if (cmd.status === 'done') return this.ack(conn, msg);
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
        } else if (cmd?.type === 'outbound.post') {
          // Terminal like finalize: posted, or a failure that lands on the desk (the manager retries from the card).
          await finishOutboundCommand(this.ctx, msg.commandId);
          await applyOutboundResult(
            this.ctx,
            conn.workstationId,
            cmd.payload.draftId,
            msg.ok,
            msg.result,
            msg.error,
          );
        } else if (cmd?.type === 'branch.check_merged') {
          // Terminal: "not merged yet" is an answer, not a failure; the phase pass asks again later.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyBranchCheckResult(
            this.ctx,
            cmd.payload.cardId,
            cmd.payload.workingBranch,
            msg.ok,
            msg.result,
          );
        } else if (cmd?.type === 'worktrees.sweep') {
          // Terminal: the sweep ran (or was skipped); what it found is recorded, never retried blindly.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyWorktreeSweepResult(this.ctx, conn.workstationId, cmd.payload, msg.ok, msg.result);
        } else if (cmd?.type === 'integration.run') {
          // Terminal: the poll's answer is applied once (a failed poll shows in the schedule's history, the next
          // cron fire asks again); never retried blindly.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyIntegrationResult(this.ctx, cmd.payload, msg.ok, msg.result, msg.error);
        } else if (cmd?.type === 'repo.create') {
          // Terminal like outbound.post: created and added to the project, or a failure on the desk (no blind retry).
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyRepoCreateResult(
            this.ctx,
            conn.workstationId,
            cmd.payload.requestId,
            msg.ok,
            msg.result,
            msg.error,
          );
        } else if (cmd?.type === 'repo.clone') {
          // Terminal: cloned, created, or a reason that shows in the Repositories tab (the manager retries there).
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyRepoCloneResult(
            this.ctx,
            conn.workstationId,
            cmd.payload,
            msg.ok,
            msg.result,
            msg.error,
          );
        } else if (cmd?.type === 'env.ensure') {
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyEnvEnsureResult(
            this.ctx,
            conn.workstationId,
            cmd.payload,
            msg.ok,
            msg.result,
            msg.error,
          );
        } else if (cmd?.type === 'forge.repos') {
          // Terminal: the picker polls the stored answer.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyForgeReposResult(this.ctx, cmd.payload, msg.ok, msg.result, msg.error);
        } else if (cmd?.type === 'repo.open_pr') {
          // Terminal: the answer (pull request URL, nothing to do, or why not) is stored for the project settings.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyReleasePrResult(this.ctx, cmd.payload, msg.ok, msg.result, msg.error);
        } else if (cmd?.type === 'rights.verify') {
          // Terminal. A failed or unreadable answer is kept on the command so the Workstations page can show it.
          const problem = await applyRightsResult(
            this.ctx,
            conn.workstationId,
            msg.ok,
            msg.result,
            msg.error,
          );
          if (problem)
            await exec(
              this.ctx.pool,
              `UPDATE runner_commands SET status='failed', last_error=$2, done_at=$3 WHERE id=$1`,
              [msg.commandId, problem.slice(0, 500), this.ctx.clock.now()],
            );
          else await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
        } else if (cmd?.type === 'org.folder') {
          // Terminal: a refusal is an answer; its reason shows on the Workstations page until the next success.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applyOrgFolderResult(
            this.ctx,
            conn.workstationId,
            cmd.payload,
            msg.ok,
            msg.result,
            msg.error,
          );
        } else if (cmd?.type === 'sudo.set') {
          // The ciphertext is forgotten here (applySudoSetResult empties the payload) whatever the answer was.
          await completeCommand(this.ctx.pool, msg.commandId, true, undefined, this.ctx.clock.now());
          await applySudoSetResult(
            this.ctx,
            conn.workstationId,
            msg.commandId,
            msg.ok,
            msg.result,
            String(cmd.payload.keyId ?? ''),
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

  /** A re-probe: store the runtimes and, when availability or sandbox state moved, tell the browsers (live refresh). */
  private async runtimesReport(conn: RunnerConn, runtimes: RunnerToServerOf<'hello'>['runtimes']) {
    const { ctx } = this;
    const before = await one(ctx.pool, 'SELECT runtimes FROM workstations WHERE id=$1', [conn.workstationId]);
    await exec(ctx.pool, 'UPDATE workstations SET runtimes=$2 WHERE id=$1', [
      conn.workstationId,
      JSON.stringify(runtimes),
    ]);
    await alignDevopsRuntime(ctx, conn.workstationId, runtimes);
    await syncClaudeAuthNotice(ctx, { id: conn.workstationId, userId: conn.userId }, runtimes).catch(() => {});
    const brief = (rs: Array<{ id: string; available: boolean; sandbox?: string; auth?: string }>) =>
      rs.map((r) => ({
        id: r.id,
        available: r.available,
        ...(r.sandbox ? { sandbox: r.sandbox } : {}),
        ...(r.auth ? { auth: r.auth } : {}),
      }));
    const now = brief(runtimes);
    if (JSON.stringify(brief(before?.runtimes ?? [])) === JSON.stringify(now)) return;
    await ctx.store.append([
      {
        streamId: streamId.workstation(conn.workstationId),
        event: {
          type: 'WorkstationRuntimesChanged',
          payload: { workstationId: conn.workstationId, runtimes: now },
        },
        actor: SYSTEM_ACTOR,
        scope: userScope(conn.userId),
      },
    ]);
  }

  // ------------------------------------------------------------------------------------ hello

  private async hello(conn: RunnerConn, msg: RunnerToServerOf<'hello'>) {
    const { ctx } = this;
    const now = ctx.clock.now();
    conn.helloAt = now;
    conn.maxShifts = Math.min(
      msg.maxConcurrentShifts ?? ctx.config.maxShiftsPerWorkstation,
      ctx.config.maxShiftsPerWorkstation,
    );
    conn.lastRepos = msg.repos;
    conn.helloShiftIds = msg.activeShifts.map((s) => s.shiftId);
    await exec(
      ctx.pool,
      // runner_update is cleared: a runner that can update itself reports it again right after `welcome`.
      `UPDATE workstations SET runtimes=$2, runner_version=$3, hostname=$4, platform=$5, last_seen_at=$6, runner_update=NULL WHERE id=$1`,
      [conn.workstationId, JSON.stringify(msg.runtimes), msg.runnerVersion, msg.hostname, msg.platform, now],
    );
    // The public key the sudo password is encrypted with (the private half stays on the runner).
    conn.setupCapable = !!msg.sudoKey;
    if (msg.sudoKey)
      await exec(
        ctx.pool,
        `INSERT INTO workstation_keys (workstation_id, key_id, public_key, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (workstation_id) DO UPDATE SET key_id=EXCLUDED.key_id, public_key=EXCLUDED.public_key, updated_at=EXCLUDED.updated_at`,
        [conn.workstationId, msg.sudoKey.keyId, msg.sudoKey.publicKey, now],
      );
    // Whatever the previous connection was sent may not have arrived: it is due again on this one.
    await requeueSentCommands(ctx.pool, conn.workstationId);
    await this.matchRepos(conn);
    await recordRepoCatalog(ctx.pool, conn.workstationId, msg.repoCatalog, now);
    await this.recordVaults(conn, msg.vaults);
    await alignDevopsRuntime(ctx, conn.workstationId, msg.runtimes);
    await syncClaudeAuthNotice(ctx, { id: conn.workstationId, userId: conn.userId }, msg.runtimes).catch(
      () => {},
    );
    await ctx.store.append([
      {
        streamId: streamId.workstation(conn.workstationId),
        event: {
          type: 'WorkstationConnected',
          payload: { workstationId: conn.workstationId, runnerVersion: msg.runnerVersion },
        },
        actor: SYSTEM_ACTOR,
        scope: userScope(conn.userId),
      },
    ]);
    this.send(conn, 'welcome', {
      workstationId: conn.workstationId,
      serverTime: now.toISOString(),
      heartbeatSec: HEARTBEAT_SEC,
      limits: { maxConcurrentShifts: conn.maxShifts },
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
    await this.reconcileQuestions(conn, known, helloAt);
    await this.reconcileBaTasks(conn, known, helloAt);
    await queueVaultConfigure(ctx, ctx.pool, conn.workstationId);
    await queueApprovedFor(ctx, conn.userId, conn.workstationId);
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

  /** Question shifts the server holds as running but the reconnected runner does not: they ended with the runner. */
  private async reconcileQuestions(conn: RunnerConn, known: Set<string>, helloAt: Date): Promise<void> {
    const { ctx } = this;
    const open = await rows(
      ctx.pool,
      `SELECT id FROM shifts WHERE workstation_id=$1 AND kind='question' AND status <> 'ended' AND started_at <= $2`,
      [conn.workstationId, helloAt],
    );
    for (const s of open) {
      if (known.has(s.id)) continue;
      await withAppendTx(ctx.pool, async (tx) => {
        const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [s.id]);
        if (shift) await ctx.store.append(endQuestionShift(shift, 'lost'), { tx });
      });
    }
  }

  /** BA task shifts the server holds as running but the reconnected runner does not: the task goes back to the queue. */
  private async reconcileBaTasks(conn: RunnerConn, known: Set<string>, helloAt: Date): Promise<void> {
    const { ctx } = this;
    const open = await rows(
      ctx.pool,
      `SELECT id FROM shifts WHERE workstation_id=$1 AND kind='ba_task' AND status <> 'ended' AND started_at <= $2`,
      [conn.workstationId, helloAt],
    );
    for (const s of open) {
      if (known.has(s.id)) continue;
      await withAppendTx(ctx.pool, async (tx) => {
        const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [s.id]);
        if (shift) await ctx.store.append(await endBaTaskShift(tx, shift, 'lost'), { tx });
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
      ])) ??
      // Question and BA task shifts are held while they have not ended.
      (await one(
        this.ctx.pool,
        `SELECT 1 FROM shifts WHERE id=$1 AND kind IN ('question','ba_task') AND status <> 'ended'`,
        [shiftId],
      ));
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
    for (const c of await claimPendingCommands(this.ctx.pool, workstationId, this.ctx.clock.now())) {
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
      'SELECT id, card_id, progress_tail, mcp_calls FROM shifts WHERE id=$1 AND workstation_id=$2',
      [msg.shiftId, conn.workstationId],
    );
    if (!s) return;
    const tail = [...(s.progress_tail as unknown[]), ...msg.items].slice(-50);
    // MCP tools the agent called (server and tool names), tallied for the card's log
    const mcp = mcpCallsIn(msg.items);
    if (mcp.length > 0)
      await exec(ctx.pool, 'UPDATE shifts SET progress_tail=$2, mcp_calls=$3::jsonb WHERE id=$1', [
        s.id,
        JSON.stringify(tail),
        JSON.stringify(mergeMcpCalls((s.mcp_calls ?? []) as McpCall[], mcp)),
      ]);
    else await exec(ctx.pool, 'UPDATE shifts SET progress_tail=$2 WHERE id=$1', [s.id, JSON.stringify(tail)]);
    ctx.services.browser.shiftProgress(s.id, s.card_id, msg.items);
  }

  // ----------------------------------------------------------------------------------- repos

  /** Matches reported repos to project repos of projects the workstation's user is an active member of. */
  async matchRepos(conn: RunnerConn) {
    const { ctx } = this;
    const now = ctx.clock.now();
    const before = new Set(
      (
        await rows(ctx.pool, 'SELECT project_repo_id FROM workstation_repos WHERE workstation_id=$1', [
          conn.workstationId,
        ])
      ).map((r) => r.project_repo_id as string),
    );
    const matched = new Set<string>();
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
          matched.add(m.id as string);
          await exec(
            tx,
            `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at) VALUES ($1,$2,$3,$4)
             ON CONFLICT (workstation_id, project_repo_id) DO UPDATE SET local_path=EXCLUDED.local_path, reported_at=EXCLUDED.reported_at`,
            [conn.workstationId, m.id, r.localPath, now],
          );
        }
      }
    });
    if (conn.setupCapable)
      await this.prepareNewProjects(
        conn,
        [...matched].filter((id) => !before.has(id)),
      );
    ctx.services.dispatcher.trigger();
  }

  /**
   * A project's repository appeared on this workstation (cloned by the DevOps engineer or by hand, or a new
   * workstation joined): make the toolchain ready before build work, unless it is being or was prepared already.
   */
  private async prepareNewProjects(conn: RunnerConn, repoIds: string[]): Promise<void> {
    if (repoIds.length === 0) return;
    const { ctx } = this;
    try {
      await withAppendTx(ctx.pool, async (tx) => {
        const projects = await rows(
          tx,
          `SELECT DISTINCT pr.project_id FROM project_repos pr JOIN projects p ON p.id = pr.project_id AND p.status='active'
            WHERE pr.id = ANY($1::uuid[]) AND NOT EXISTS (
              SELECT 1 FROM project_environments pe WHERE pe.project_id = pr.project_id AND pe.workstation_id = $2)`,
          [repoIds, conn.workstationId],
        );
        const events = [];
        for (const p of projects)
          events.push(
            ...(await environmentRequestEvents(ctx, tx, p.project_id, conn.workstationId, 'repo_found')),
          );
        if (events.length) await ctx.store.append(events, { tx });
      });
      deliver(ctx, [conn.workstationId]);
    } catch (err) {
      ctx.log.warn({ err }, 'could not queue the environment preparation');
    }
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
      if (msg.method === 'card.attachments' || msg.method === 'card.attach.begin')
        return reply(...(await attachmentRpc(ctx, shift, msg.method, msg.params)));
      // A BA task shift is read-only and has no card: only the phase verbs and reading are available.
      if (shift.kind === 'ba_task') return reply(...(await baTaskRpc(ctx, shift, msg.method, msg.params)));
      // A DevOps shift reaches only the card its request was filed for (`aom card show|comment|update`).
      if (shift.kind === 'devops' && DEVOPS_CARD_METHODS.has(msg.method))
        return reply(...(await devopsCardRpc(ctx, shift, msg.method, msg.params)));
      if (msg.method === 'devops.request')
        return reply(...(await this.devopsRequest(conn, shift, msg.params)));
      if (msg.method === 'outbound.draft') return reply(...(await outboundDraftRpc(ctx, shift, msg.params)));
      if (msg.method === 'card.risk') return reply(...(await riskTierRpc(ctx, shift, msg.params)));
      if (msg.method === 'investigation.record')
        return reply(...(await investigationRecordRpc(ctx, shift, msg.params)));
      if (msg.method === 'transcript.store')
        return reply(...(await transcriptStoreRpc(ctx, shift, msg.params)));
      if (msg.method === 'repo.create') return reply(...(await repoCreateRpc(ctx, shift, msg.params)));
      if (DESIGN_METHODS.has(msg.method))
        return reply(...(await designRpc(ctx, shift, msg.method, msg.params)));
      if (INTAKE_METHODS.has(msg.method))
        return reply(...(await intakeRpc(ctx, shift, msg.method, msg.params)));
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
