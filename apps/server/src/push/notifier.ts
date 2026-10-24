import {
  maskText,
  PLATFORM_DESK_SUBKIND,
  type PushAction,
  type PushCategory,
  type PushPayload,
  parseBoardConfig,
  parseDiscoveryConfig,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import type { StoredEvent } from '../eventstore/types.ts';
import { boardTime, discoveryTime } from '../sessions/time.ts';
import { pushActionsFor } from './desk-actions.ts';
import { inQuietHours, loadPreferences } from './prefs.ts';
import { badgeCountFor, sendToUser, subscriptionsOf } from './sender.ts';
import { safeBody } from './text.ts';

/** Same thing, same state, within this long: sent once. */
export const DEDUPE_WINDOW_MS = 24 * 3600_000;

export interface PushNotice {
  category: PushCategory;
  /** What it is about (a desk item, a card, a workstation): the dedupe key and the lock-screen `tag`. */
  subject: string;
  /** Changes when the subject's state changes: a different state is sent again within the window. */
  state?: string;
  title: string;
  body: string;
  url: string;
  /** `blocking` goes through quiet hours. */
  priority: 'blocking' | 'normal';
  /** Whose preferences apply (null: the person's default). */
  orgId: string | null;
  /** The person whose action caused it: never notified. */
  actorUserId?: string | null | undefined;
  /** S-B1: notification buttons for one person (a one-tap confirm link each); called only when the notice is really sent. */
  actionsFor?: ((userId: string) => Promise<PushAction[]>) | undefined;
}

export { safeBody };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Sends `notice` to each of `userIds` that wants it: category switched on, outside quiet hours (blocking items ignore
 * them), not already sent for this subject in this state within 24 hours, never the actor, and only people with a device.
 * Returns the people it was sent to.
 */
export async function notifyUsers(ctx: Ctx, userIds: string[], notice: PushNotice): Promise<string[]> {
  const sentTo: string[] = [];
  for (const userId of new Set(userIds)) {
    if (notice.actorUserId && notice.actorUserId === userId) continue;
    try {
      if ((await subscriptionsOf(ctx, userId)).length === 0) continue;
      const prefs = await loadPreferences(ctx, userId, notice.orgId);
      if (!prefs.categories[notice.category]) continue;
      if (notice.priority !== 'blocking') {
        const u = await one<{ timezone: string | null }>(ctx.pool, 'SELECT timezone FROM users WHERE id=$1', [
          userId,
        ]);
        if (inQuietHours(prefs.quietHours, ctx.clock.now(), u?.timezone)) continue;
      }
      const now = ctx.clock.now();
      // Claim the (person, category, subject) in one statement: a second event of the same state inside the window
      // updates nothing and returns no row.
      const claimed = await one(
        ctx.pool,
        `INSERT INTO push_deliveries (user_id, category, subject, state, sent_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, category, subject) DO UPDATE SET state=EXCLUDED.state, sent_at=EXCLUDED.sent_at
           WHERE push_deliveries.state IS DISTINCT FROM EXCLUDED.state OR push_deliveries.sent_at <= $6
         RETURNING user_id`,
        [
          userId,
          notice.category,
          notice.subject,
          notice.state ?? '',
          now,
          new Date(now.getTime() - DEDUPE_WINDOW_MS),
        ],
      );
      if (!claimed) continue;
      const actions = notice.actionsFor ? await notice.actionsFor(userId).catch(() => []) : [];
      const payload: PushPayload = {
        title: clip(maskText(notice.title), 80),
        body: safeBody(notice.body),
        url: notice.url,
        tag: `${notice.category}:${notice.subject}`.slice(0, 120),
        badge: await badgeCountFor(ctx, userId),
        ...(actions.length ? { actions } : {}),
      };
      const r = await sendToUser(ctx, userId, payload, {
        urgency: notice.priority === 'blocking' ? 'high' : 'normal',
      });
      if (r.sent > 0) sentTo.push(userId);
    } catch (err) {
      ctx.log.warn({ err, userId }, 'push notification failed');
    }
  }
  return sentTo;
}

/** Forget what was sent for a subject (its state changed in a way the next notice must not be suppressed by). */
export async function resetSubject(ctx: Ctx, category: PushCategory, subject: string): Promise<void> {
  await exec(ctx.pool, 'DELETE FROM push_deliveries WHERE category=$1 AND subject=$2', [category, subject]);
}

const orgManagers = async (ctx: Ctx, orgId: string): Promise<string[]> =>
  (
    await rows<{ user_id: string }>(
      ctx.pool,
      `SELECT user_id FROM org_members WHERE org_id=$1 AND status='active' AND role IN ('owner','admin')`,
      [orgId],
    )
  ).map((r) => r.user_id);

const RUNNER_SUBKINDS = new Set([
  'claude_auth_expired',
  'claude_usage_limit',
  'claude_account_login',
  'provider_account_login',
  'provider_account_usage',
  'role_smoke_failed',
  // a deploy server the computer can no longer sign in to
  'deploy_unreachable',
]);
/** Desk items that have their own event, their own category or are only reports: not a "decision for me". */
const NOT_A_DECISION = new Set<string>([
  'approval_step',
  PLATFORM_DESK_SUBKIND.pause,
  PLATFORM_DESK_SUBKIND.deployReport,
  PLATFORM_DESK_SUBKIND.runnerPin,
  'digest',
  'ceo_notice',
  'ceo_decision',
  'ba_report',
  'floor_report',
]);

async function onDeskItem(ctx: Ctx, e: StoredEvent, deskItemId: string): Promise<void> {
  const d = await one(
    ctx.pool,
    `SELECT d.id, d.org_id, d.project_id, d.kind, d.subkind, d.blocking, d.title, d.body, d.addressee_user_id,
            d.subject_key, d.status, d.triage, d.data, d.routed_to, c.ref AS card_ref, c.owner_user_id AS card_owner
       FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id WHERE d.id=$1`,
    [deskItemId],
  );
  if (!d || d.status !== 'open' || d.triage === 'pending') return;
  const actorUserId = e.actor.kind === 'user' ? e.actor.id : null;
  const url = `/desk#desk-item-${d.id}`;
  const base = {
    url,
    orgId: d.org_id as string,
    actorUserId,
    title: d.title as string,
    body: d.body as string,
  };
  const sub: string | null = d.subkind;
  if (sub === PLATFORM_DESK_SUBKIND.bugFiled) {
    await notifyUsers(ctx, await orgManagers(ctx, d.org_id), {
      ...base,
      category: 'platform_bugs',
      subject: d.subject_key ?? d.id,
      state: 'open',
      priority: 'normal',
    });
    return;
  }
  if (sub === PLATFORM_DESK_SUBKIND.deployApproval || sub === PLATFORM_DESK_SUBKIND.downtimeApproval) {
    await notifyUsers(ctx, await orgManagers(ctx, d.org_id), {
      ...base,
      category: 'platform_deploys',
      subject: d.subject_key ?? d.id,
      state: 'open',
      priority: 'blocking',
    });
    return;
  }
  if (sub && RUNNER_SUBKINDS.has(sub)) {
    const who = d.addressee_user_id ? [d.addressee_user_id as string] : await orgManagers(ctx, d.org_id);
    const key = (d.data as { key?: string } | null)?.key;
    await notifyUsers(ctx, who, {
      ...base,
      category: 'runner_alerts',
      subject: `${sub}:${key ?? d.subject_key ?? d.id}`,
      state: 'open',
      priority: 'normal',
    });
    return;
  }
  if (sub && NOT_A_DECISION.has(sub)) return;
  // A question still with an agent (peer, BA, CEO) is not on the manager's desk yet: the person hears of it when it is
  // escalated to the desk (QuestionEscalated), not now. Approvals and other kinds are always the manager's.
  if (d.kind === 'question' && d.routed_to !== 'manager') return;
  // A decision for me: a blocking item, or a question or approval put to a person.
  const decision = d.blocking || d.kind === 'question' || d.kind === 'approval';
  if (!decision) return;
  let who: string[] = [];
  if (d.addressee_user_id) who = [d.addressee_user_id];
  else if (d.card_owner) who = [d.card_owner];
  else if (d.project_id) {
    who = (
      await rows<{ user_id: string }>(
        ctx.pool,
        `SELECT user_id FROM project_members WHERE project_id=$1 AND status='active' AND role='owner'`,
        [d.project_id],
      )
    ).map((r) => r.user_id);
  }
  if (who.length === 0) who = await orgManagers(ctx, d.org_id);
  // A question's text is its title and it can be long: the notification says who asks about what, the text is the body.
  const isQuestion = d.kind === 'question';
  await notifyUsers(ctx, who, {
    ...base,
    title: isQuestion
      ? d.card_ref
        ? `Question on ${d.card_ref}`
        : 'A question for you'
      : d.card_ref
        ? `${d.card_ref}: ${d.title}`
        : d.title,
    body: isQuestion ? d.title : d.body || d.title,
    category: 'desk_blocking',
    subject: d.id,
    state: 'open',
    priority: d.blocking ? 'blocking' : 'normal',
    // S-B1: Approve / Reject (or the quick options of a question) on the notification itself
    actionsFor: (userId) => pushActionsFor(ctx, userId, d.id),
  });
}

/**
 * Q54: the creator of a Discovery or Boardroom session is told at the time-limit warning (a third of the limit, at most 5
 * minutes before the end) and at time-up, on their devices. The sweeps write `timeWarned` / `timeUp` in the session's config;
 * this is the one place that turns those writes into a notification.
 */
async function onSessionTime(ctx: Ctx, e: StoredEvent): Promise<void> {
  const p = e.event.payload as { threadId?: string; config?: Record<string, unknown> };
  const cfg = p.config;
  if (!p.threadId || !cfg) return;
  const up = cfg.timeUp === true;
  const warn = !up && cfg.timeWarned === true;
  if (!up && !warn) return;
  const t = await one(
    ctx.pool,
    `SELECT id, kind, org_id, title, created_by, session_config FROM threads
      WHERE id=$1 AND kind IN ('discovery','boardroom') AND deleted_at IS NULL`,
    [p.threadId],
  );
  if (!t?.created_by) return;
  const sc = (t.session_config ?? {}) as Record<string, unknown>;
  if (sc.archived === true) return;
  const now = ctx.clock.now();
  const time =
    t.kind === 'boardroom'
      ? boardTime(parseBoardConfig(sc), now)
      : discoveryTime(parseDiscoveryConfig(sc), now);
  const left = Math.max(
    1,
    Math.ceil((time.limitMinutes ? time.limitMinutes * 60_000 - time.elapsedMs : 0) / 60_000),
  );
  const what = t.kind === 'boardroom' ? 'Boardroom' : 'Discovery';
  const name = (t.title as string | null)?.trim() || `${what} session`;
  await notifyUsers(ctx, [t.created_by as string], {
    category: 'session_time',
    subject: `session-time:${t.id}`,
    // the event id: an extended session warns (and runs out) again, and each is told once
    state: `${up ? 'up' : 'warn'}:${e.id}`,
    title: up ? `${what} time is up` : `${what}: about ${left} minute${left === 1 ? '' : 's'} left`,
    body: up
      ? `${name}: nothing new starts until you extend the session or wrap it up.`
      : `${name} is close to its time limit. Extend it or let it wrap up.`,
    url: `/${t.kind === 'boardroom' ? 'boardroom' : 'discovery'}/${t.id}`,
    // time is up waits for the person, so it goes through quiet hours; the warning does not
    priority: up ? 'blocking' : 'normal',
    orgId: t.org_id as string,
  });
}

export interface PushService {
  /** Resolves when everything queued so far has been handled (tests). */
  flush(): Promise<void>;
  stop(): void;
}

/** Hooks the event store: the person is told after the commit, off the command's path (a queue of its own). */
export function registerPushNotifier(ctx: Ctx): PushService {
  let queue: Promise<void> = Promise.resolve();
  const timers = new Set<NodeJS.Timeout>();
  const offlineGraceMs = ctx.config.push.offlineGraceSeconds * 1000;

  const offline = async (workstationId: string) => {
    const w = await one(ctx.pool, `SELECT user_id, name, connected, status FROM workstations WHERE id=$1`, [
      workstationId,
    ]);
    if (!w || w.connected || w.status !== 'active') return;
    await notifyUsers(ctx, [w.user_id], {
      category: 'runner_alerts',
      subject: `ws-offline:${workstationId}`,
      state: 'offline',
      title: 'Runner offline',
      body: `${w.name} is not connected. Agents cannot start work there.`,
      url: '/workstations',
      priority: 'normal',
      orgId: null,
    });
  };

  const handle = async (e: StoredEvent): Promise<void> => {
    const ev = e.event;
    const actorUserId = e.actor.kind === 'user' ? e.actor.id : null;
    // Event types of streams that are not merged yet are matched by name.
    switch (ev.type as string) {
      case 'DeskItemCreated':
      case 'QuestionRaised':
      case 'QuestionEscalated':
        return onDeskItem(ctx, e, (ev.payload as { deskItemId: string }).deskItemId);
      case 'ApprovalRequested': {
        const p = ev.payload as { cardId: string; approverUserId: string; sha?: string; deskItemId: string };
        const c = await one(ctx.pool, 'SELECT ref, title, org_id FROM cards WHERE id=$1', [p.cardId]);
        if (!c) return;
        await notifyUsers(ctx, [p.approverUserId], {
          category: 'owner_approvals',
          subject: `approval:${p.cardId}`,
          state: p.sha ?? p.deskItemId,
          title: `Approve ${c.ref}`,
          body: c.title,
          url: `/cards/${c.ref}`,
          priority: 'blocking',
          orgId: c.org_id,
          actorUserId,
        });
        return;
      }
      case 'ProjectBudgetThresholdReached': {
        const p = ev.payload as { projectId: string; month: string; level: string };
        if (p.level !== 'paused') return;
        const pr = await one(ctx.pool, 'SELECT org_id, key, name FROM projects WHERE id=$1', [p.projectId]);
        if (!pr) return;
        await notifyUsers(ctx, await orgManagers(ctx, pr.org_id), {
          category: 'budget_paused',
          subject: `budget:${p.projectId}:${p.month}`,
          state: 'paused',
          title: 'Budget used up',
          body: `${pr.name} reached its monthly budget and stopped picking up work.`,
          url: `/p/${pr.key}/board`,
          priority: 'normal',
          orgId: pr.org_id,
          actorUserId,
        });
        return;
      }
      case 'ProjectPaused':
      case 'ProjectResumed': {
        const p = ev.payload as { projectId: string; by?: string };
        const pr = await one(ctx.pool, 'SELECT org_id, key, name FROM projects WHERE id=$1', [p.projectId]);
        if (!pr) return;
        const paused = ev.type === ('ProjectPaused' as string);
        await notifyUsers(ctx, await orgManagers(ctx, pr.org_id), {
          category: 'project_pause',
          subject: `pause:${p.projectId}`,
          state: paused ? 'paused' : 'resumed',
          title: paused ? 'Project paused' : 'Project resumed',
          body: paused ? `${pr.name} was paused.` : `${pr.name} is running again.`,
          url: `/p/${pr.key}/board`,
          priority: 'normal',
          orgId: pr.org_id,
          actorUserId: p.by ?? actorUserId,
        });
        return;
      }
      case 'WorkstationDisconnected': {
        const id = (ev.payload as { workstationId: string }).workstationId;
        if (offlineGraceMs <= 0) return offline(id);
        const t = setTimeout(() => {
          timers.delete(t);
          queue = queue
            .then(() => offline(id))
            .catch((err) => ctx.log.warn({ err }, 'push offline check failed'));
        }, offlineGraceMs);
        t.unref();
        timers.add(t);
        return;
      }
      case 'WorkstationConnected':
        return resetSubject(
          ctx,
          'runner_alerts',
          `ws-offline:${(ev.payload as { workstationId: string }).workstationId}`,
        );
      case 'SessionThreadUpdated':
        return onSessionTime(ctx, e);
      case 'ThreadMessagePosted': {
        const p = ev.payload as {
          threadId: string;
          messageId: string;
          authorKind: string;
          kind: string;
          body: string;
          data?: { segments?: Array<{ type: string; text?: string }> };
        };
        if (p.authorKind !== 'agent' || p.kind !== 'chat') return;
        // the body holds the whole turn: the notification shows the final answer (the last text block)
        const finalText = p.data?.segments?.findLast((x) => x.type === 'text' && x.text?.trim())?.text;
        const t = await one(
          ctx.pool,
          `SELECT t.created_by, t.org_id, t.title, a.name AS agent FROM threads t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.id=$1 AND t.kind='chat'`,
          [p.threadId],
        );
        if (!t?.created_by) return;
        await notifyUsers(ctx, [t.created_by], {
          category: 'chat_replies',
          subject: `chat:${p.threadId}`,
          state: p.messageId,
          title: t.agent ? `${t.agent} replied` : 'New chat reply',
          body: finalText?.trim() || p.body,
          url: `/chat/${p.threadId}`,
          priority: 'normal',
          orgId: t.org_id,
          actorUserId,
        });
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = ctx.store.subscribe((e) => {
    queue = queue
      .then(() => handle(e))
      .catch((err) => ctx.log.warn({ err, type: e.event.type }, 'push notifier failed'));
  });
  return {
    flush: async () => {
      await ctx.notifier.flush();
      await queue;
    },
    stop: () => {
      unsubscribe();
      for (const t of timers) clearTimeout(t);
    },
  };
}
