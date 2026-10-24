import { UNLIMITED_SHIFTS } from '@aom/shared';
import pg from 'pg';
import { ceoPass } from '../ceo/pass.ts';
import { sweepCeoReviews } from '../ceo/review.ts';
import { withCommitAs } from '../commands/commit-as.ts';
import { blockedRoles } from '../commands/runner-telemetry.ts';
import { testEnvironmentPass } from '../commands/test-environments.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { DISPATCH_LOCK_ID } from '../db/tx.ts';
import { deliveryPass } from '../delivery/triggers.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { platformPass } from '../platform-team/detectors.ts';
import { agentCapBlocked, type ProviderCapState } from '../provider-keys/caps.ts';
import { buildShiftStart } from '../runner-gateway/brief.ts';
import { playbookGrantKeys } from '../sessions/playbooks.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { accountFor, loadProjectAccounts, runtimeUsable, accountScope as scopeOf } from './accounts.ts';
import { baTaskPass } from './ba-tasks.ts';
import { testingPass } from './bottleneck.ts';
import { agentView, candidateCards, isCandidate, ONLINE_WINDOW_MS } from './candidates.ts';
import { type ClaimResult, claim } from './claim.ts';
import { devopsPass } from './devops.ts';
import { phasePass } from './phases.ts';
import { blockedQuestionPass, questionPass } from './questions.ts';

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
  'TestReworkRequested',
  'QuestionRaised',
  'QuestionEscalated',
  'QuestionAnswered',
  'DeskItemResolved',
  'AgentHired',
  'AgentResumed',
  'CeoEnabled',
  'CeoResumed',
  'AgentChanged',
  'AgentRehomed',
  'AgentPermissionsRebased',
  'WorkstationConnected',
  'WorkstationRuntimesChanged',
  'ScheduleFired',
  'OrgStatusChanged',
  'OrgMemberAdded',
  'RebaseConflict',
  'CardMovedByManager',
  'CardReopened',
  'CardFinalized',
  'QaOpened',
  'QaSentBack',
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
  'BaTaskItemsAdded',
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
  /** cardId -> the agent that should take the card again right after a "stop, keep the card with this agent". */
  readonly preferred = new Map<string, { agentId: string; until: number }>();

  constructor(private readonly ctx: Ctx) {}

  /** Turns on the debounced passes `trigger()` asks for (the background mode of `start()`, or a test that wants them). */
  enableAuto(): void {
    this.auto = true;
  }

  /** The card goes to this agent first when it is queued again (for two minutes). */
  prefer(cardId: string, agentId: string): void {
    this.preferred.set(cardId, { agentId, until: this.ctx.clock.now().getTime() + 120_000 });
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
        WHERE a.status='active' AND a.paused_at IS NULL AND a.role_key <> 'ceo' AND NOT a.is_devops AND ws.status='active' AND ws.connected AND ws.last_seen_at > $1
          AND ${wsServesOrgSql('ws', 'a.org_id')}
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
    // Roles whose smoke test failed on a workstation get no work there (runner 0.1.24, role.smoke).
    const blocked = await blockedRoles(this.ctx);
    // An agent whose model would spend the organization's key of a provider whose monthly cap is reached gets no work (provider_cap_reached);
    // the cards stay queued, the agents on a workstation's own key or a subscription go on.
    const capCache = new Map<string, ProviderCapState>();
    const out = [];
    for (const a of list) {
      if (blocked.has(`${a.workstation_id}|${a.role_key}`)) continue;
      if (await agentCapBlocked(this.ctx.pool, a as never, now, capCache)) continue;
      const rt = (
        a.runtimes as Array<{ id: string; available: boolean; capabilities: string[]; auth?: string }>
      ).find((r) => r.id === a.runtime);
      // An expired login (Claude Code `/login`) or a hit model usage limit (backlog #73) pauses an account; the
      // workstation is offered work while any account of the runtime is usable (which account a card runs on is
      // decided per card: docs/design/claude-accounts.md).
      if (!rt || !runtimeUsable(a.runtimes, a.runtime, now)) continue;
      out.push({ row: a, caps: rt.capabilities, active: Number(a.active) });
    }
    return out;
  }

  /** Agent shifts that are not finished, per workstation (chats are not counted: the runner runs them apart). */
  private async shiftLoad(): Promise<Map<string, number>> {
    const list = await rows<{ workstation_id: string; n: number }>(
      this.ctx.pool,
      `SELECT workstation_id, count(*)::int AS n FROM shifts WHERE status <> 'ended' AND kind <> 'chat' GROUP BY workstation_id`,
    );
    return new Map(list.map((r) => [r.workstation_id, r.n]));
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
    await this.safely('phase', () => phasePass(this.ctx), undefined);
    const made: ClaimResult[] = [];
    const agents = await this.freeAgents();
    // The Claude account each project names (docs/design/claude-accounts.md): chosen again for every claim.
    const settings = await loadProjectAccounts(this.ctx.pool);
    const at = new Date(nowMs);
    const accountOf = (row: Row, projectId: string) =>
      accountFor(settings.get(projectId), row.runtimes, row.runtime, at);
    const accountScope = (row: Row) => scopeOf(settings, row.runtimes, row.runtime, at);
    // Shifts each workstation runs now against the limit its owner set (backlog #76): a full workstation is not offered more.
    const load = await this.shiftLoad();
    const full = (workstationId: string): boolean => {
      const limit = this.ctx.services.runners.get(workstationId)?.maxShifts;
      return limit !== undefined && limit < UNLIMITED_SHIFTS && (load.get(workstationId) ?? 0) >= limit;
    };
    for (const [cardId, p] of [...this.preferred]) {
      if (p.until < nowMs) {
        this.preferred.delete(cardId);
        continue;
      }
      const a = agents.find((x) => x.row.id === p.agentId);
      const card = await one(this.ctx.pool, 'SELECT stage, status FROM cards WHERE id=$1', [cardId]);
      if (
        !a ||
        !card ||
        card.status !== 'queued' ||
        a.active >= a.row.capacity ||
        this.skip(a.row, nowMs) ||
        full(a.row.workstation_id)
      )
        continue;
      const pcard = await one(this.ctx.pool, 'SELECT project_id FROM cards WHERE id=$1', [cardId]);
      const acct = accountOf(a.row, pcard?.project_id);
      if (!acct) continue;
      const r = await claim(this.ctx, {
        cardId,
        agentId: a.row.id,
        expectedStage: card.stage,
        accountKey: acct.key,
      });
      this.preferred.delete(cardId);
      if (r) {
        made.push(r);
        a.active++;
        load.set(a.row.workstation_id, (load.get(a.row.workstation_id) ?? 0) + 1);
      }
    }
    for (const { row, caps, active } of agents) {
      if (active >= row.capacity || this.skip(row, nowMs) || full(row.workstation_id)) continue;
      const view = agentView(row, caps);
      const cands = await candidateCards(this.ctx.pool, view, new Date(nowMs), accountScope(row));
      for (const c of cands) {
        const acct = accountOf(row, c.project_id);
        if (!acct) continue;
        const r = await claim(this.ctx, {
          cardId: c.id,
          agentId: row.id,
          expectedStage: c.stage,
          accountKey: acct.key,
        });
        if (r) {
          made.push(r);
          load.set(row.workstation_id, (load.get(row.workstation_id) ?? 0) + 1);
          break;
        }
      }
    }
    // Every sub-pass below is isolated: a throw in one is logged and the others (and `sendShiftStart` for the claims
    // already made above) still run. Without this a throw released claims that never got their `shift.start`.
    made.push(
      ...(await this.safely('overflow', () => this.overflowPass(agents, nowMs, full, accountOf), [])),
    );
    // The DevOps, question and BA passes respect the workstation's shift limit like the card passes do (each shift they
    // start counts, so the next pass sees it).
    const cooling = (agentId: string) => (this.cooldown.get(agentId) ?? 0) > nowMs;
    const counted = <T extends { workstationId: string }>(started: T[]): void => {
      for (const s of started) load.set(s.workstationId, (load.get(s.workstationId) ?? 0) + 1);
    };
    counted(await this.safely('devops', () => devopsPass(this.ctx, cooling, full), []));
    await this.safely('blocked-questions', () => blockedQuestionPass(this.ctx), undefined);
    counted(await this.safely('question', () => questionPass(this.ctx, cooling, full), []));
    counted(await this.safely('ba-task', () => baTaskPass(this.ctx, cooling, full), []));
    await this.safely('ceo', () => ceoPass(this.ctx), undefined);
    // Delivery: merge triggers that are due become deploy requests; deploys nobody collected expire (never throws).
    await deliveryPass(this.ctx).catch((err) => this.ctx.log.error({ err }, 'delivery pass failed'));
    // A CEO decision review the CEO never answered continues without it after the timeout.
    await sweepCeoReviews(this.ctx).catch((err) => this.ctx.log.error({ err }, 'ceo review sweep failed'));
    await this.safely('testing', () => testingPass(this.ctx), undefined);
    // Platform team: bug intake from the detectors, pauses of fixed bugs end, grants expire, fix stop-loss.
    await this.safely('platform', () => platformPass(this.ctx), undefined);
    // Test environments for cards waiting at an environment stage (the tester can claim them once healthy).
    await this.safely('test-environment', () => testEnvironmentPass(this.ctx), undefined);
    for (const r of made) await this.sendShiftStart(r);
    return made;
  }

  /** Runs one sub-pass; a throw is logged (as `deliveryPass` already is) and `fallback` stands in for its result. */
  private async safely<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.ctx.log.error({ err, pass: name }, `${name} pass failed`);
      return fallback;
    }
  }

  /** Spec rule 1: a late scheduled card with no free agent gets one extra shift at a time per organization. */
  private async overflowPass(
    agents: Array<{ row: Row; caps: string[]; active: number }>,
    nowMs: number,
    full: (workstationId: string) => boolean = () => false,
    accountOf: (row: Row, projectId: string) => { key: string } | null = () => ({ key: 'main' }),
  ): Promise<ClaimResult[]> {
    const late = await rows(
      this.ctx.pool,
      `SELECT id, org_id, stage, project_id FROM cards WHERE status='queued' AND scheduled AND claim_id IS NULL AND queued_at < $1
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
        .filter(
          (a) =>
            a.row.org_id === card.org_id &&
            a.active >= a.row.capacity &&
            !this.skip(a.row, nowMs) &&
            !full(a.row.workstation_id),
        )
        .sort((x, y) => x.active - y.active);
      for (const a of atCapacity) {
        if (!(await isCandidate(this.ctx.pool, agentView(a.row, a.caps), card.id, new Date(nowMs)))) continue;
        const acct = accountOf(a.row, card.project_id);
        if (!acct) continue;
        const r = await claim(this.ctx, {
          cardId: card.id,
          agentId: a.row.id,
          expectedStage: card.stage,
          accountKey: acct.key,
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
    const built = await buildShiftStart(this.ctx, c);
    if (!built) return false;
    const withCommit = await withCommitAs(this.ctx, built);
    const playbookGrants = await playbookGrantKeys(this.ctx.pool, withCommit.agent.agentId);
    const payload = playbookGrants.length ? { ...withCommit, playbookGrants } : withCommit;
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
