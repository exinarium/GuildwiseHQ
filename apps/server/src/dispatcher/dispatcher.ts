import pg from 'pg';
import type { Ctx } from '../context.ts';
import { type Row, rows } from '../db/sql.ts';
import { DISPATCH_LOCK_ID } from '../db/tx.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { buildShiftStart } from '../runner-gateway/brief.ts';
import { baTaskPass } from './ba-tasks.ts';
import { testingPass } from './bottleneck.ts';
import { agentView, candidateCards, isCandidate, ONLINE_WINDOW_MS } from './candidates.ts';
import { type ClaimResult, claim } from './claim.ts';
import { devopsPass } from './devops.ts';
import { phasePass } from './phases.ts';
import { questionPass } from './questions.ts';

/** Events that make a dispatch pass worthwhile (docs/ARCHITECTURE.md section 9.1). */
const TRIGGER_TYPES = new Set([
  'CardSpecified',
  'CardCreated',
  'ClaimReleased',
  'ShiftEnded',
  'ReviewRequested',
  'ChangesRequested',
  'ReviewApproved',
  'TestPassed',
  'StageCompleted',
  'ChildCardResolved',
  'QuestionRaised',
  'QuestionEscalated',
  'QuestionAnswered',
  'DeskItemResolved',
  'AgentHired',
  'AgentChanged',
  'AgentRehomed',
  'WorkstationConnected',
  'WorkstationRuntimesChanged',
  'ScheduleFired',
  'RebaseConflict',
  'CardMovedByManager',
  'CardFinalized',
  'DevOpsRequested',
  'DevOpsRequestRequeued',
  'DevOpsApprovalResolved',
  'DevOpsRequestCompleted',
  'FinalizeFailed',
  'TestEnvironmentReady',
  'CardCancelled',
  'CardPhaseChanged',
  'CardMergeVerified',
  'PhaseConfirmed',
  'PhaseReopened',
  'PhaseFollowupsApproved',
  'PhaseFollowupBriefed',
  'PhaseFollowupFinished',
  'BaTaskQueued',
  'BaTaskCompleted',
  'BaTaskRequeued',
  'FullSuitePassed',
  'FullSuiteFailed',
]);

const REJECT_COOLDOWN_MS = 30_000;
const LATE_SCHEDULED_MS = 30_000;
const MAX_CONSECUTIVE_PASSES = 20;

export class Dispatcher {
  private lockClient: pg.Client | null = null;
  private hasLock = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  /** Event/timer-driven passes (production). Off, a pass runs only when `run()` is called: tests drive it by hand. */
  private auto = false;
  /** agentId -> epoch ms until which the agent is skipped (after a runner rejection). */
  readonly cooldown = new Map<string, number>();

  constructor(private readonly ctx: Ctx) {}

  /** Turns on the debounced passes `trigger()` asks for (the background mode of `start()`, or a test that wants them). */
  enableAuto(): void {
    this.auto = true;
  }

  start(): void {
    this.auto = true;
    this.unsubscribe = this.ctx.store.subscribe((e: StoredEvent) => {
      if (TRIGGER_TYPES.has(e.event.type)) this.trigger();
    });
    this.timer = setInterval(() => this.trigger(), 10_000);
    this.timer.unref();
  }

  trigger(): void {
    if (!this.auto || this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.run().catch((err) => this.ctx.log.error({ err }, 'dispatch failed'));
    }, 250);
    this.debounce.unref();
  }

  /** Passes are serialized in-process. Repeats while claims keep being made (up to 20). */
  run(): Promise<ClaimResult[]> {
    const next = this.chain.then(async () => {
      const all: ClaimResult[] = [];
      for (let i = 0; i < MAX_CONSECUTIVE_PASSES; i++) {
        const made = await this.pass();
        all.push(...made);
        if (made.length === 0) break;
      }
      return all;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** A single pass (tests use this for deterministic ordering assertions). */
  runPass(): Promise<ClaimResult[]> {
    const next = this.chain.then(() => this.pass());
    this.chain = next.catch(() => {});
    return next;
  }

  private async ensureLock(): Promise<boolean> {
    if (this.hasLock) return true;
    this.lockClient ??= new pg.Client({ connectionString: this.ctx.config.databaseUrl });
    if (!(this.lockClient as unknown as { _connected?: boolean })._connected) {
      await this.lockClient.connect();
      (this.lockClient as unknown as { _connected?: boolean })._connected = true;
    }
    const r = await this.lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      DISPATCH_LOCK_ID,
    ]);
    this.hasLock = r.rows[0]?.ok === true;
    return this.hasLock;
  }

  private async freeAgents(): Promise<Array<{ row: Row; caps: string[]; active: number }>> {
    const now = this.ctx.clock.now();
    const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);
    const list = await rows(
      this.ctx.pool,
      `SELECT a.*, ws.runtimes,
              (SELECT count(*)::int FROM cards c WHERE c.claimed_by_agent_id = a.id AND c.claim_id IS NOT NULL) AS active
         FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
                 JOIN users wu ON wu.id = ws.user_id AND wu.status = 'active'
        WHERE a.status='active' AND NOT a.is_devops AND ws.status='active' AND ws.connected AND ws.last_seen_at > $1
        ORDER BY a.last_shift_ended_at NULLS FIRST, a.hired_at, a.id`,
      [onlineSince],
    );
    // Rework/bug cards are routed to their original builder first: free original builders pick before the others.
    const originals = new Set(
      (
        await rows<{ id: string }>(
          this.ctx.pool,
          `SELECT DISTINCT original_builder_agent_id AS id FROM cards
            WHERE status='queued' AND claim_id IS NULL AND is_rework_or_bug AND original_builder_agent_id IS NOT NULL`,
        )
      ).map((r) => r.id),
    );
    list.sort((x, y) => Number(originals.has(y.id)) - Number(originals.has(x.id)));
    const out = [];
    for (const a of list) {
      const rt = (a.runtimes as Array<{ id: string; available: boolean; capabilities: string[] }>).find(
        (r) => r.id === a.runtime,
      );
      if (!rt?.available) continue;
      out.push({ row: a, caps: rt.capabilities, active: Number(a.active) });
    }
    return out;
  }

  private skip(a: Row, nowMs: number): boolean {
    const until = this.cooldown.get(a.id);
    if (until && until > nowMs) return true;
    // A reconnecting runner is not dispatched to until its reconciliation finished.
    const conn = this.ctx.services.runners.get(a.workstation_id);
    return !!conn && !conn.reconciled;
  }

  private async pass(): Promise<ClaimResult[]> {
    if (this.stopped || !(await this.ensureLock())) return [];
    const nowMs = this.ctx.clock.now().getTime();
    // Phases first: the requests, cards and tasks it creates are dispatched in this same pass.
    await phasePass(this.ctx);
    const made: ClaimResult[] = [];
    const agents = await this.freeAgents();
    for (const { row, caps, active } of agents) {
      if (active >= row.capacity || this.skip(row, nowMs)) continue;
      const view = agentView(row, caps);
      const cands = await candidateCards(this.ctx.pool, view, new Date(nowMs));
      for (const c of cands) {
        const r = await claim(this.ctx, { cardId: c.id, agentId: row.id, expectedStage: c.stage });
        if (r) {
          made.push(r);
          break;
        }
      }
    }
    made.push(...(await this.overflowPass(agents, nowMs)));
    await devopsPass(this.ctx, (agentId) => (this.cooldown.get(agentId) ?? 0) > nowMs);
    await questionPass(this.ctx, (agentId) => (this.cooldown.get(agentId) ?? 0) > nowMs);
    await baTaskPass(this.ctx, (agentId) => (this.cooldown.get(agentId) ?? 0) > nowMs);
    await testingPass(this.ctx);
    for (const r of made) await this.sendShiftStart(r);
    return made;
  }

  /** Spec rule 1: a late scheduled card with no free agent gets one extra shift at a time per organization. */
  private async overflowPass(
    agents: Array<{ row: Row; caps: string[]; active: number }>,
    nowMs: number,
  ): Promise<ClaimResult[]> {
    const late = await rows(
      this.ctx.pool,
      `SELECT id, org_id, stage FROM cards WHERE status='queued' AND scheduled AND claim_id IS NULL AND queued_at < $1
        ORDER BY queued_at, created_at, number`,
      [new Date(nowMs - LATE_SCHEDULED_MS)],
    );
    const made: ClaimResult[] = [];
    for (const card of late) {
      const busy = await rows(
        this.ctx.pool,
        'SELECT 1 FROM cards WHERE org_id=$1 AND claim_overflow AND claim_id IS NOT NULL LIMIT 1',
        [card.org_id],
      );
      if (busy.length || made.some((m) => m.cardId === card.id)) continue;
      const atCapacity = agents
        .filter((a) => a.row.org_id === card.org_id && a.active >= a.row.capacity && !this.skip(a.row, nowMs))
        .sort((x, y) => x.active - y.active);
      for (const a of atCapacity) {
        if (!(await isCandidate(this.ctx.pool, agentView(a.row, a.caps), card.id, new Date(nowMs)))) continue;
        const r = await claim(this.ctx, {
          cardId: card.id,
          agentId: a.row.id,
          expectedStage: card.stage,
          overflow: true,
        });
        if (r) {
          made.push(r);
          break;
        }
      }
    }
    return made;
  }

  async sendShiftStart(c: ClaimResult): Promise<boolean> {
    const payload = await buildShiftStart(this.ctx, c);
    if (!payload) return false;
    const sent = this.ctx.services.runners.send(
      c.workstationId,
      'shift.start',
      payload,
      this.ctx.clock.now(),
    );
    if (!sent)
      this.ctx.log.warn(
        { shiftId: c.shiftId, workstationId: c.workstationId },
        'runner offline: shift.start not sent',
      );
    return sent;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.unsubscribe?.();
    await this.chain.catch(() => {});
    if (this.lockClient) {
      try {
        await this.lockClient.end();
      } catch {
        // ignore
      }
    }
  }
}
