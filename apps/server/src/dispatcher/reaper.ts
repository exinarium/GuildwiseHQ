import { getStage, streamId } from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { endBaTaskShift } from '../commands/ba-tasks.ts';
import { SYSTEM_ACTOR, userScope } from '../commands/common.ts';
import { endDevopsShift } from '../commands/devops.ts';
import { endQuestionShift } from '../commands/escalation.ts';
import { releaseClaimEvents } from '../commands/shifts.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';

const ACCEPT_TIMEOUT_MS = 30_000;
const STALE_HEARTBEAT_MS = 45_000;
const OVERRUN_SLACK_MS = 10 * 60_000;

/**
 * Periodic housekeeping (docs/ARCHITECTURE.md section 8.3): shifts the runner never accepted (30 s), expired
 * leases (1 h), stale presence (45 s) and shifts that overran their maximum duration.
 */
export class Reaper {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: Ctx) {}

  start(intervalMs = 10_000): void {
    this.timer = setInterval(() => {
      this.run().catch((err) => this.ctx.log.error({ err }, 'reaper failed'));
    }, intervalMs);
    this.timer.unref();
  }

  run(): Promise<void> {
    const next = this.running.then(async () => {
      await this.markStalePresence();
      await this.releaseUnaccepted();
      await this.releaseExpiredLeases();
      await this.stopOverrunShifts();
    });
    this.running = next.catch(() => {});
    return next;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running.catch(() => {});
  }

  private async markStalePresence(): Promise<void> {
    const { ctx } = this;
    const stale = await rows(
      ctx.pool,
      `SELECT id, user_id FROM workstations WHERE connected AND status='active' AND (last_seen_at IS NULL OR last_seen_at < $1)`,
      [new Date(ctx.clock.now().getTime() - STALE_HEARTBEAT_MS)],
    );
    for (const w of stale) {
      ctx.services.runners.close(w.id, 4408, 'heartbeat timeout');
      await ctx.store.append([
        {
          streamId: streamId.workstation(w.id),
          event: { type: 'WorkstationDisconnected', payload: { workstationId: w.id } },
          actor: SYSTEM_ACTOR,
          scope: userScope(w.user_id),
        },
      ]);
    }
  }

  /** `shift.accepted` not received within 30 s of the claim: ClaimReleased(runner_rejected). */
  private async releaseUnaccepted(): Promise<void> {
    const { ctx } = this;
    const cutoff = new Date(ctx.clock.now().getTime() - ACCEPT_TIMEOUT_MS);
    const pending = await rows(
      ctx.pool,
      `SELECT id FROM shifts WHERE status='starting' AND accepted_at IS NULL AND started_at < $1`,
      [cutoff],
    );
    for (const s of pending) {
      await withAppendTx(ctx.pool, async (tx) => {
        const shift = (
          await tx.query(`SELECT * FROM shifts WHERE id=$1 AND status='starting' AND accepted_at IS NULL`, [
            s.id,
          ])
        ).rows[0];
        if (!shift) return;
        if (shift.kind === 'devops') {
          ctx.services.dispatcher.cooldown.set(shift.agent_id, ctx.clock.now().getTime() + 30_000);
          await ctx.store.append(
            await endDevopsShift(tx, shift, 'rejected', {
              finalText: 'The runner did not accept the DevOps shift within 30 seconds.',
            }),
            { tx },
          );
          return;
        }
        if (shift.kind === 'question') {
          ctx.services.dispatcher.cooldown.set(shift.agent_id, ctx.clock.now().getTime() + 30_000);
          await ctx.store.append(endQuestionShift(shift, 'rejected'), { tx });
          return;
        }
        if (shift.kind === 'ba_task') {
          ctx.services.dispatcher.cooldown.set(shift.agent_id, ctx.clock.now().getTime() + 30_000);
          await ctx.store.append(await endBaTaskShift(tx, shift, 'rejected'), { tx });
          return;
        }
        const card = shift.card_id
          ? (await tx.query('SELECT * FROM cards WHERE id=$1 FOR UPDATE', [shift.card_id])).rows[0]
          : undefined;
        if (card && card.claim_shift_id === shift.id) {
          const agent = shift.agent_id;
          ctx.services.dispatcher.cooldown.set(agent, ctx.clock.now().getTime() + 30_000);
          await ctx.store.append(
            await releaseClaimEvents(
              tx,
              card,
              'runner_rejected',
              'The runner did not accept the shift within 30 seconds; the card is back in the queue.',
              'rejected',
            ),
            { tx },
          );
        }
      });
    }
  }

  private async releaseExpiredLeases(): Promise<void> {
    const { ctx } = this;
    const expired = await rows(
      ctx.pool,
      'SELECT id FROM cards WHERE claim_id IS NOT NULL AND lease_expires_at < $1',
      [ctx.clock.now()],
    );
    for (const c of expired) {
      await withAppendTx(ctx.pool, async (tx) => {
        const card = (
          await tx.query(
            'SELECT * FROM cards WHERE id=$1 AND claim_id IS NOT NULL AND lease_expires_at < $2 FOR UPDATE SKIP LOCKED',
            [c.id, ctx.clock.now()],
          )
        ).rows[0];
        if (!card) return;
        await ctx.store.append(
          await releaseClaimEvents(
            tx,
            card,
            'lease_expired',
            'Released after the workstation was offline for 1h; the last handoff is attached.',
            'lost',
          ),
          { tx },
        );
      });
    }
  }

  /** Server-side maximum: claimed_at + stage.maxShiftMinutes + 10 min -> `shift.stop{timeout}`. */
  private async stopOverrunShifts(): Promise<void> {
    const { ctx } = this;
    const claimed = await rows(
      ctx.pool,
      `SELECT id, workflow_version_id, stage, claimed_at, claim_shift_id, claim_workstation_id FROM cards WHERE claim_id IS NOT NULL`,
    );
    const now = ctx.clock.now().getTime();
    for (const c of claimed) {
      const wf = await loadWorkflowById(ctx.pool, c.workflow_version_id);
      const stage = wf ? getStage(wf.definition, c.stage) : undefined;
      const max = (stage?.maxShiftMinutes ?? 60) * 60_000 + OVERRUN_SLACK_MS;
      if (c.claimed_at && now > new Date(c.claimed_at).getTime() + max) {
        ctx.services.gateway.stopShift(c.claim_workstation_id, c.claim_shift_id, 'timeout');
      }
    }
  }
}
