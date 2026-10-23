import { type BillingTickResult, billingTick } from '../billing/engine.ts';
import { blogWriterTick } from '../blog/writer/index.ts';
import { cloudTick } from '../cloud/tick.ts';
import { autoPublishDue } from '../commands/blog.ts';
import { blogDigestTick } from '../commands/blog-digest.ts';
import { evaluateAllBudgets } from '../commands/budgets.ts';
import { publishPendingDocuments } from '../commands/documents.ts';
import { fireDueHygiene } from '../commands/hygiene.ts';
import { sweepIntegrations } from '../commands/integrations.ts';
import { deliverDueInterests, fireDueInterests } from '../commands/interest-runs.ts';
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
import { pruneMail } from '../mail/inbound/prune.ts';
import { licensingTick } from '../orgs/licensing.ts';

const TICK_MS = 15_000;
const LICENSING_MS = 5 * 60_000;

/**
 * Fires due schedules every 15 s and on boot (docs/ARCHITECTURE.md section 10). Schedules always fire on time: the
 * scheduler never waits for agents; the dispatcher gives the emitted card priority and, when no agent is free, an
 * overflow shift. Tests call `run()` after moving the test clock.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private licensingTimer: NodeJS.Timeout | null = null;
  private billingTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private kicked: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The writer's run in flight: it takes minutes and must never hold up the schedules, so it is not on the chain. */
  private writer: Promise<unknown> | null = null;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.run().catch(() => {});
      if (this.ctx.config.hygieneSchedule) void this.runHygiene().catch(() => {});
    }, TICK_MS);
    this.timer.unref();
    this.licensingTimer = setInterval(() => void this.runLicensing().catch(() => {}), LICENSING_MS);
    this.licensingTimer.unref();
    if (this.ctx.config.billingJobs) {
      this.billingTimer = setInterval(() => void this.runBilling().catch(() => {}), LICENSING_MS);
      this.billingTimer.unref();
      void this.runBilling().catch((err) => this.ctx.log.error({ err }, 'billing tick failed'));
    }
    this.unsubscribe = this.ctx.store.subscribe(() => this.kickTriggers());
    void this.runLicensing().catch((err) => this.ctx.log.error({ err }, 'licensing tick failed'));
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

  /** Trial and licence ends suspend organizations; warnings go to their desks (every 5 minutes). */
  runLicensing(): Promise<{ suspended: number; warned: number }> {
    if (this.stopped) return Promise.resolve({ suspended: 0, warned: 0 });
    const next = this.chain.then(async () => {
      // The text of old inbound mail goes after its retention period (mail/inbound/prune.ts).
      await pruneMail(this.ctx).catch((err) => this.ctx.log.error({ err }, 'mail retention failed'));
      return licensingTick(this.ctx);
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** Renewals, retries, pauses, expiry notices and trial reminders (idempotent; AOM_BILLING_JOBS switches the timer off). */
  runBilling(): Promise<BillingTickResult> {
    const none: BillingTickResult = {
      invoices: 0,
      charged: 0,
      failed: 0,
      paused: 0,
      ended: 0,
      notices: 0,
      signupsRemoved: 0,
    };
    if (this.stopped) return Promise.resolve(none);
    const next = this.chain.then(() => billingTick(this.ctx));
    this.chain = next.catch(() => {});
    return next;
  }

  /** One pass, serialized in-process. Returns the cards it created. */
  run(): Promise<Array<{ scheduleId: string; cardId?: string }>> {
    if (this.stopped) return Promise.resolve([]);
    const next = this.chain.then(async () => {
      const fired = await fireDueSchedules(this.ctx);
      // Budgets: a new month re-arms the thresholds, and a pause of last month's closes its desk item.
      await evaluateAllBudgets(this.ctx).catch((err) => this.ctx.log.error({ err }, 'budget check failed'));
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
    this.runWriter();
  }

  /** Starts the server-side blog writer when a slot is due; one at a time, outside the chain. Resolves when it is done (tests). */
  runWriter(): Promise<unknown> {
    if (this.stopped) return Promise.resolve();
    if (!this.writer) {
      this.writer = blogWriterTick(this.ctx, this.ctx.blogWriter)
        .catch((err) => this.ctx.log.error({ err }, 'blog writer failed'))
        .finally(() => {
          this.writer = null;
        });
    }
    return this.writer;
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
    if (this.billingTimer) clearInterval(this.billingTimer);
    if (this.kicked) clearTimeout(this.kicked);
    this.unsubscribe?.();
    await this.chain.catch(() => {});
    await this.writer?.catch(() => {});
  }
}
