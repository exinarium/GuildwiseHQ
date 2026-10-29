import { cloudTick } from '../cloud/tick.ts';
import { autoPublishDue } from '../commands/blog.ts';
import { blogDigestTick } from '../commands/blog-digest.ts';
import { evaluateAllBudgets } from '../commands/budgets.ts';
import { publishPendingDocuments } from '../commands/documents.ts';
import { followUpSweep } from '../commands/follow-up.ts';
import { fireDueHygiene } from '../commands/hygiene.ts';
import { sweepIntegrations } from '../commands/integrations.ts';
import { deliverDueInterests, fireDueInterests } from '../commands/interest-runs.ts';
import { evaluateAllProviderCaps } from '../commands/org-provider-keys.ts';
import { auditMailTick } from '../commands/platform-notify.ts';
import { expireRuns } from '../commands/runs.ts';
import { deliverDue } from '../commands/schedule-delivery.ts';
import { sweepEventTriggers } from '../commands/schedule-triggers.ts';
import { fireDueSchedules } from '../commands/schedules.ts';
import { socialTick } from '../commands/social.ts';
import { sweepSubworkflows } from '../commands/subworkflows.ts';
import { weeklyBriefingTick } from '../commands/weekly-briefing.ts';
import type { Ctx } from '../context.ts';
import { reachabilityTick } from '../delivery/reachability.ts';
import { governanceTick } from '../governance/offboarding.ts';
import { pruneMail } from '../mail/inbound/prune.ts';
import { prunePersonaChats } from '../sessions/persona-chat.ts';
import { videoWatch } from '../video/sweep.ts';

const TICK_MS = 15_000;
const MAINTENANCE_MS = 5 * 60_000;

/**
 * Fires due schedules every 15 s and on boot (docs/ARCHITECTURE.md section 10). Schedules always fire on time: the
 * scheduler never waits for agents; the dispatcher gives the emitted card priority and, when no agent is free, an
 * overflow shift. Tests call `run()` after moving the test clock.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private licensingTimer: NodeJS.Timeout | null = null;
  private tickerTimers: NodeJS.Timeout[] = [];
  /** Detached jobs in flight (one per job): they take minutes and must never hold up the schedules, so they are not on the chain. */
  private detached = new Map<string, Promise<unknown>>();
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private kicked: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.run().catch(() => {});
      if (this.ctx.config.hygieneSchedule) void this.runHygiene().catch(() => {});
    }, TICK_MS);
    this.timer.unref();
    this.licensingTimer = setInterval(() => void this.runMaintenance().catch(() => {}), MAINTENANCE_MS);
    this.licensingTimer.unref();
    // Background jobs of the extensions (billing renewals, trial expiry, ...), each on its own cadence.
    for (const t of this.tickers()) {
      if (t.enabled && !t.enabled(this.ctx)) continue;
      const timer = setInterval(() => void this.runTicker(t.name).catch(() => {}), t.everyMs);
      timer.unref();
      this.tickerTimers.push(timer);
      if (t.runOnBoot)
        void this.runTicker(t.name).catch((err) => this.ctx.log.error({ err }, `${t.name} tick failed`));
    }
    this.unsubscribe = this.ctx.store.subscribe(() => this.kickTriggers());
    void this.runMaintenance().catch((err) => this.ctx.log.error({ err }, 'maintenance tick failed'));
    void this.run().catch((err) => this.ctx.log.error({ err }, 'scheduler failed'));
    if (this.ctx.config.hygieneSchedule)
      void this.runHygiene().catch((err) => this.ctx.log.error({ err }, 'hygiene scheduler failed'));
  }

  /** The workstations' repository hygiene jobs that are due (their own cadence, default daily). Returns the request ids. */
  runHygiene(): Promise<string[]> {
    if (this.stopped) return Promise.resolve([]);
    const next = this.chain.then(() => fireDueHygiene(this.ctx));
    this.chain = next.catch(() => {});
    return next;
  }

  /** Cloud workstations: wake for queued cards, stop when idle (every 15 seconds with the main pass). */
  runCloud(): Promise<{ woke: string[]; stopped: string[] }> {
    if (this.stopped) return Promise.resolve({ woke: [], stopped: [] });
    const next = this.chain.then(() => cloudTick(this.ctx));
    this.chain = next.catch(() => ({ woke: [], stopped: [] }));
    return next;
  }

  /** The background jobs contributed by the registered extensions. */
  private tickers() {
    return this.ctx.ext.list.flatMap((e) => e.tickers ?? []);
  }

  /** Housekeeping every five minutes: old inbound mail text and idle persona chats go after their retention period. */
  runMaintenance(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const next = this.chain.then(async () => {
      // The text of old inbound mail goes after its retention period (mail/inbound/prune.ts).
      await pruneMail(this.ctx).catch((err) => this.ctx.log.error({ err }, 'mail retention failed'));
      // Persona chats nobody wrote in for 90 days (AOM_PERSONA_CHAT_RETENTION_DAYS) leave the lists (sessions/persona-chat.ts).
      await prunePersonaChats(this.ctx).catch((err) =>
        this.ctx.log.error({ err }, 'persona chat retention failed'),
      );
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** Runs one extension job (billing, licensing, ...) now, serialized with the other jobs. Resolves to its result (undefined if unknown). */
  runTicker(name: string): Promise<unknown> {
    const t = this.tickers().find((x) => x.name === name);
    if (this.stopped || !t) return Promise.resolve(undefined);
    if (t.detached) {
      // one run at a time; a call while it is running joins the run in flight
      const running = this.detached.get(t.name);
      if (running) return running;
      const p = t
        .run(this.ctx)
        .catch((err) => this.ctx.log.error({ err }, `${t.name} failed`))
        .finally(() => this.detached.delete(t.name));
      this.detached.set(t.name, p);
      return p;
    }
    const next = this.chain.then(() => t.run(this.ctx));
    this.chain = next.catch(() => {});
    return next;
  }

  /** Runs every extension job once (the test clock endpoint). */
  async runTickers(): Promise<void> {
    for (const t of this.tickers()) await this.runTicker(t.name);
  }

  /** One pass, serialized in-process. Returns the cards it created. */
  run(): Promise<Array<{ scheduleId: string; cardId?: string }>> {
    if (this.stopped) return Promise.resolve([]);
    const next = this.chain.then(async () => {
      const fired = await fireDueSchedules(this.ctx);
      // Budgets: a new month re-arms the thresholds, and a pause of last month's closes its desk item.
      await evaluateAllBudgets(this.ctx).catch((err) => this.ctx.log.error({ err }, 'budget check failed'));
      await evaluateAllProviderCaps(this.ctx).catch((err) =>
        this.ctx.log.error({ err }, 'provider cap check failed'),
      );
      await this.interests();
      await this.triggers();
      await auditMailTick(this.ctx).catch((err) => this.ctx.log.error({ err }, 'audit mail failed'));
      await cloudTick(this.ctx).catch((err) => this.ctx.log.error({ err }, 'cloud workstations failed'));
      await reachabilityTick(this.ctx).catch((err) =>
        this.ctx.log.error({ err }, 'reachability checks failed'),
      );
      await expireRuns(this.ctx).catch((err) => this.ctx.log.error({ err }, 'run environment expiry failed'));
      await this.blog();
      // Discovery and boardroom sessions: queued turns go out, approved documents reach the vault.
      await this.ctx.services.sessions
        .sweep()
        .catch((err) => this.ctx.log.error({ err }, 'session turns failed'));
      await this.ctx.services.discovery
        .sweep()
        .catch((err) => this.ctx.log.error({ err }, 'discovery follow-ups failed'));
      await this.ctx.services.board
        .sweep()
        .catch((err) => this.ctx.log.error({ err }, 'boardroom follow-ups failed'));
      await publishPendingDocuments(this.ctx).catch((err) =>
        this.ctx.log.error({ err }, 'document publishing failed'),
      );
      await weeklyBriefingTick(this.ctx).catch((err) =>
        this.ctx.log.error({ err }, 'weekly briefing failed'),
      );
      // Governance housekeeping: private items of removed members past their grace period, old notification links.
      await governanceTick(this.ctx).catch((err) => this.ctx.log.error({ err }, 'governance tick failed'));
      // Follow-up and chase: open desk items past the organization's window nudge their owner (once per window).
      await followUpSweep(this.ctx).catch((err) => this.ctx.log.error({ err }, 'follow-up sweep failed'));
      return fired;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** The blog: posts whose hold has passed publish, new posts are shared to the social networks, the weekly digest goes out. */
  private async blog(): Promise<void> {
    await autoPublishDue(this.ctx).catch((err) => this.ctx.log.error({ err }, 'blog auto-publish failed'));
    await socialTick(this.ctx).catch((err) => this.ctx.log.error({ err }, 'blog social sharing failed'));
    await blogDigestTick(this.ctx).catch((err) => this.ctx.log.error({ err }, 'blog digest failed'));
    // the video schedule: a post that will not be rendered in time slips, and the owner hears about it (DB only)
    await videoWatch(this.ctx).catch((err) => this.ctx.log.error({ err }, 'video watch failed'));
  }

  /** The interests' run schedules, then their delivery schedules (digests to the desk within the quiet cap). */
  private async interests(): Promise<void> {
    await fireDueInterests(this.ctx).catch((err) => this.ctx.log.error({ err }, 'interest runs failed'));
    await deliverDueInterests(this.ctx).catch((err) =>
      this.ctx.log.error({ err }, 'interest deliveries failed'),
    );
  }

  /** Sub-workflow starts and resolutions, event triggers and the deliveries (webhooks, e-mail) that are due; a failure of one never stops the other. */
  private async triggers(): Promise<void> {
    await sweepSubworkflows(this.ctx).catch((err) => this.ctx.log.error({ err }, 'sub-workflows failed'));
    await sweepEventTriggers(this.ctx).catch((err) => this.ctx.log.error({ err }, 'event triggers failed'));
    await sweepIntegrations(this.ctx).catch((err) => this.ctx.log.error({ err }, 'integration sweep failed'));
    await deliverDue(this.ctx).catch((err) => this.ctx.log.error({ err }, 'schedule deliveries failed'));
  }

  /** The notifier saw new events: look at them soon (a sweep is cheap and idempotent). */
  private kickTriggers(): void {
    if (this.stopped || this.kicked) return;
    this.kicked = setTimeout(() => {
      this.kicked = null;
      const next = this.chain.then(() => this.triggers());
      this.chain = next.catch(() => {});
    }, 750);
    this.kicked.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.licensingTimer) clearInterval(this.licensingTimer);
    for (const t of this.tickerTimers) clearInterval(t);
    if (this.kicked) clearTimeout(this.kicked);
    this.unsubscribe?.();
    await this.chain.catch(() => {});
    await Promise.allSettled([...this.detached.values()]);
  }
}
