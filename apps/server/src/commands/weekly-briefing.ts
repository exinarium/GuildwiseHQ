import { DESK_SUBKIND, formatMoney, isOrgManager, type OrgRole, zonedDayStart } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { budgetDto, inCurrency, monthOf, monthSpendByProject, orgCostCtx } from '../costs/index.ts';
import { nextBestActions, valueReport } from '../costs/value.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { type BriefingData, type BriefingItem, briefingIsEmpty, briefingMail } from '../mail/briefing.ts';
import { DESK_VISIBLE } from '../queries/desk.ts';

/**
 * The Monday briefing (backlog #38): one mail per active member and organization, due Monday 08:00 in the
 * organization's time zone (its Owner's reporting zone, UTC when unset). Owners and Admins get the long version (value
 * figures, spend against budgets, per project, next best actions); members get the short one for their own projects.
 *
 * - Exactly once per person, organization and ISO week: a `briefing_deliveries` row is claimed before the mail goes out
 *   (`sent`) and reopened only when sending threw (up to three attempts, on later ticks). The tick runs often; a server
 *   that was down on Monday still sends for two days, never later.
 * - A person opts out under profile settings (`briefing_prefs`); the default is on.
 * - Nothing worth saying (no cards, nothing waiting, nothing blocked, no health issue) is recorded as `skipped`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_ATTEMPTS = 3;
const SEND_WINDOW_MS = 2 * DAY;
const LIST_MAX = 5;

const localYmd = (at: Date, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);

/** `2026-W42` for the date `ymd` (the Thursday of its week decides the year). */
export function isoWeekOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The most recent Monday 08:00 in the zone at or before `now`: the local date of that Monday and the instant. The hour
 * is added to local midnight, which is exact except in the (rare) week a clock change falls between 00:00 and 08:00.
 */
export function lastBriefingDue(now: Date, tz: string): { monday: string; due: Date } {
  const dueOf = (ymd: string) => new Date(zonedDayStart(ymd, tz).getTime() + 8 * HOUR);
  let ymd = localYmd(now, tz);
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  for (let i = 0; i < (dow + 6) % 7; i++) ymd = prevDay(ymd);
  if (dueOf(ymd) > now) for (let i = 0; i < 7; i++) ymd = prevDay(ymd);
  return { monday: ymd, due: dueOf(ymd) };
}
const prevDay = (ymd: string): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// ---- the person's choice

export async function briefingEnabled(ctx: Ctx, userId: string): Promise<boolean> {
  const p = await one(ctx.pool, 'SELECT enabled FROM briefing_prefs WHERE user_id=$1', [userId]);
  return p ? p.enabled : true;
}

export async function setBriefingEnabled(ctx: Ctx, userId: string, enabled: boolean): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO briefing_prefs (user_id, enabled, updated_at) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at`,
    [userId, enabled, ctx.clock.now()],
  );
}

// ---- gathering

async function projectIdsOf(ctx: Ctx, orgId: string, userId: string, manager: boolean): Promise<string[]> {
  const r = manager
    ? await rows(ctx.pool, `SELECT id FROM projects WHERE org_id=$1 AND kind='project' AND status='active'`, [
        orgId,
      ])
    : await rows(
        ctx.pool,
        `SELECT p.id FROM projects p JOIN project_members pm ON pm.project_id = p.id
          WHERE p.org_id=$1 AND p.kind='project' AND p.status='active' AND pm.user_id=$2 AND pm.status='active'`,
        [orgId, userId],
      );
  return r.map((x) => x.id as string);
}

export async function gatherBriefing(
  ctx: Ctx,
  opts: { orgId: string; userId: string; role: OrgRole | null; monday: string; due: Date },
): Promise<BriefingData> {
  const { orgId, userId } = opts;
  const now = ctx.clock.now();
  const manager = isOrgManager({ orgRole: opts.role });
  const c = await orgCostCtx(ctx.pool, orgId);
  const org = await one(ctx.pool, 'SELECT name FROM organizations WHERE id=$1', [orgId]);
  const projectIds = await projectIdsOf(ctx, orgId, userId, manager);
  const from = new Date(opts.due.getTime() - 7 * DAY);
  const ref = (r: Row): BriefingItem => ({
    title: `${r.ref} ${r.title}`,
    path: `/cards/${r.ref}`,
  });

  const done = await rows(
    ctx.pool,
    `SELECT ref, title, project_id FROM cards
      WHERE project_id = ANY($1::uuid[]) AND status='done' AND card_type NOT IN ('regression','feed')
        AND finalized_at >= $2 AND finalized_at < $3 ORDER BY finalized_at DESC`,
    [projectIds, from, opts.due],
  );
  const blocked = await rows(
    ctx.pool,
    `SELECT ref, title, extract(epoch FROM ($2::timestamptz - COALESCE(blocked_since, updated_at))) / 86400.0 AS days
       FROM cards WHERE project_id = ANY($1::uuid[]) AND status='blocked'
      ORDER BY COALESCE(blocked_since, updated_at)`,
    [projectIds, now],
  );
  const waiting = await rows(
    ctx.pool,
    `SELECT d.title, d.kind, d.subkind, d.addressee_user_id FROM desk_items d
      WHERE d.org_id = $2 AND d.status='open' AND d.routed_to='manager' AND d.kind <> 'rating'
        AND COALESCE(d.subkind,'') NOT IN ('${DESK_SUBKIND.claudeAuthExpired}','${DESK_SUBKIND.mcpNeedsSignIn}')
        AND ${DESK_VISIBLE}
      ORDER BY d.created_at`,
    [userId, orgId],
  );
  const healthRows = await rows(
    ctx.pool,
    `SELECT title, body FROM desk_items
      WHERE org_id=$1 AND status='open' AND addressee_user_id=$2
        AND subkind IN ('${DESK_SUBKIND.claudeAuthExpired}','${DESK_SUBKIND.mcpNeedsSignIn}') ORDER BY created_at`,
    [orgId, userId],
  );

  const data: BriefingData = {
    orgName: org?.name ?? 'your organization',
    manager,
    week: isoWeekOf(opts.monday),
    mondayLabel: opts.monday,
    done: { count: done.length, items: done.slice(0, LIST_MAX).map(ref) },
    waiting: {
      count: waiting.length,
      qa: waiting.filter((w) => w.subkind === 'manual_qa' && w.addressee_user_id === userId).length,
      approvals: waiting.filter((w) => w.kind === 'approval').length,
      items: waiting.slice(0, LIST_MAX).map((w) => ({ title: w.title, path: '/desk' })),
    },
    blocked: {
      count: blocked.length,
      items: blocked
        .slice(0, LIST_MAX)
        .map((b) => ({ ...ref(b), detail: `blocked ${Math.max(0, Math.floor(Number(b.days)))} days` })),
    },
    health: healthRows.map((h) => ({ title: h.title })),
  };
  if (!manager) return data;

  const actions = await nextBestActions(ctx.pool, orgId, null, now);
  for (const a of actions)
    if (a.kind === 'failing_agent') data.health.push({ title: `${a.title} fails often`, detail: a.detail });
  data.nextActions = actions
    .filter((a) => a.kind !== 'failing_agent')
    .map((a) => ({ title: a.title, detail: a.detail }));

  const value = await valueReport(ctx.pool, orgId, {}, now, false);
  const v = value.current;
  const ret = v.returnX === null ? '' : `, ~${v.returnX}× return`;
  data.value = {
    headline: `${v.cards} ${v.cards === 1 ? 'card' : 'cards'}, ~${v.hours} hours of work, ${formatMoney(v.usageMicros, c.currency)} usage${ret}.`,
    trend: `Last month: ${value.previous.cards} cards, ~${value.previous.hours} hours, ${formatMoney(value.previous.usageMicros, c.currency)} usage.`,
  };

  // spend against budgets, and one line per project
  const m = monthOf(c, now);
  const spendRows = await rows(
    ctx.pool,
    `SELECT COALESCE(sum(cost_usd_micros),0) AS usd FROM shift_costs WHERE org_id=$1 AND ended_at >= $2 AND ended_at < $3`,
    [orgId, m.start, m.next],
  );
  const total = inCurrency(spendRows[0]?.usd, c);
  const spendByProject = await monthSpendByProject(ctx.pool, c, now);
  const projects = await rows(
    ctx.pool,
    `SELECT id, key, name, budget_micros, budget_override_month FROM projects
      WHERE org_id=$1 AND kind='project' AND status='active' ORDER BY key`,
    [orgId],
  );
  const doneBy = new Map<string, number>();
  for (const d of done) doneBy.set(d.project_id, (doneBy.get(d.project_id) ?? 0) + 1);
  const blockedByProject = new Map(
    (
      await rows(
        ctx.pool,
        `SELECT project_id, count(*)::int AS n FROM cards WHERE project_id = ANY($1::uuid[]) AND status='blocked' GROUP BY 1`,
        [projectIds],
      )
    ).map((r) => [r.project_id as string, Number(r.n)]),
  );
  const lines: Array<[string, string]> = [];
  const perProject: Array<[string, string]> = [];
  for (const p of projects) {
    const spend = spendByProject.get(p.id) ?? 0;
    if (p.budget_micros !== null) {
      const b = budgetDto(p, spend, c, now, { canEdit: false, showAmounts: true });
      lines.push([
        `${p.key} budget`,
        `${formatMoney(spend, c.currency)} of ${formatMoney(Number(p.budget_micros), c.currency)} (${Math.floor(b.percent ?? 0)}%${b.state === 'paused' ? ', paused' : b.state === 'warning' ? ', nearly used' : ''})`,
      ]);
    }
    const nd = doneBy.get(p.id) ?? 0;
    const nb = blockedByProject.get(p.id) ?? 0;
    if (nd > 0 || nb > 0 || spend > 0)
      perProject.push([
        `${p.key} ${p.name}`,
        `${nd} done, ${nb} blocked, ${formatMoney(spend, c.currency)} spent this month`,
      ]);
  }
  data.spend = total > 0 || lines.length > 0 ? { total: formatMoney(total, c.currency), lines } : undefined;
  data.projects = perProject;
  return data;
}

// ---- the tick

export interface BriefingResult {
  sent: number;
  skipped: number;
  failed: number;
}

export async function weeklyBriefingTick(ctx: Ctx): Promise<BriefingResult> {
  const out: BriefingResult = { sent: 0, skipped: 0, failed: 0 };
  if (!ctx.config.weeklyBriefing) return out;
  const now = ctx.clock.now();
  const orgs = await rows(
    ctx.pool,
    `SELECT id FROM organizations WHERE status IN ('trial','active') AND NOT simulation ORDER BY id`,
  );
  for (const o of orgs) {
    const c = await orgCostCtx(ctx.pool, o.id);
    const { monday, due } = lastBriefingDue(now, c.timezone);
    if (now.getTime() - due.getTime() > SEND_WINDOW_MS) continue;
    const week = isoWeekOf(monday);
    const people = await rows(
      ctx.pool,
      `SELECT u.id, u.email, u.display_name, m.role FROM org_members m JOIN users u ON u.id = m.user_id
        WHERE m.org_id=$1 AND m.status='active' AND u.kind='user' AND u.status='active' AND u.email <> ''
          AND COALESCE((SELECT enabled FROM briefing_prefs p WHERE p.user_id = u.id), true)
        ORDER BY u.id`,
      [o.id],
    );
    for (const p of people) {
      const claimed = await one(
        ctx.pool,
        `INSERT INTO briefing_deliveries (user_id, org_id, week, state, attempts, sent_at) VALUES ($1,$2,$3,'sent',1,$4)
         ON CONFLICT (user_id, org_id, week) DO UPDATE SET state='sent', attempts=briefing_deliveries.attempts+1, sent_at=$4
           WHERE briefing_deliveries.state='failed' AND briefing_deliveries.attempts < ${MAX_ATTEMPTS}
         RETURNING attempts`,
        [p.id, o.id, week, now],
      );
      if (!claimed) continue;
      try {
        const data = await gatherBriefing(ctx, { orgId: o.id, userId: p.id, role: p.role, monday, due });
        if (briefingIsEmpty(data)) {
          await exec(
            ctx.pool,
            `UPDATE briefing_deliveries SET state='skipped' WHERE user_id=$1 AND org_id=$2 AND week=$3`,
            [p.id, o.id, week],
          );
          out.skipped++;
          continue;
        }
        await ctx.mailer.send({
          ...briefingMail({
            to: p.email,
            name: p.display_name,
            origin: ctx.config.publicOrigin,
            data,
            unsubscribeUrl: `${ctx.config.publicOrigin}/settings`,
          }),
          orgId: o.id,
        });
        out.sent++;
      } catch (err) {
        ctx.log.error({ err, userId: p.id, orgId: o.id }, 'weekly briefing failed');
        await exec(
          ctx.pool,
          `UPDATE briefing_deliveries SET state='failed' WHERE user_id=$1 AND org_id=$2 AND week=$3`,
          [p.id, o.id, week],
        );
        out.failed++;
      }
    }
  }
  return out;
}
