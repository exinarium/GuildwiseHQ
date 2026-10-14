import { randomUUID } from 'node:crypto';
import {
  BUDGET,
  budgetStatus,
  DEFAULT_HOURS_PER_CARD,
  formatMoney,
  isOrgManager,
  streamId,
  toMicros,
  type UpdateCostSettingsRequest,
  type UpdateValueSettingsRequest,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { inCurrency, monthOf, orgCostCtx } from '../costs/index.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from './common.ts';

/** Desk subkinds of the budget notices (an org-level alert for the Owner and Admins). */
export const BUDGET_DESK = { warning: 'budget_warning', paused: 'budget_paused' } as const;

async function lockProject(tx: Tx, user: AuthSession['user'], projectId: string): Promise<Row> {
  const p = await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
  // Not a member of the organization (a guest, a stranger): the project does not exist for them.
  const role = p ? await orgRoleOf(tx, user.id, p.org_id) : null;
  if (!p || role === null) throw notFound('project not found');
  if (!isOrgManager({ orgRole: role }))
    throw forbidden('only the organization Owner and Admins can change a project budget');
  return p;
}

/** Closes the open budget notice of a project (the budget was raised, overridden or a new month began). */
function resolveNotice(p: Row, note: string): AppendInput[] {
  if (!p.budget_desk_item_id) return [];
  return [
    {
      streamId: streamId.desk(p.budget_desk_item_id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: p.budget_desk_item_id,
          resolution: 'acknowledged',
          note,
          by: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(p.org_id),
    },
  ];
}

async function noticeOpen(tx: Tx, id: string | null): Promise<boolean> {
  if (!id) return false;
  return !!(await one(tx, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [id]));
}

/**
 * Sets (or removes, with null) a project's monthly budget, in whole currency units. Owner and Admin only. The month's
 * spend decides in the same append whether the new amount lifts a pause or re-arms the 80% warning; a budget set
 * below what is already spent takes effect (and notifies) at once.
 */
export async function setProjectBudget(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  monthly: number | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await lockProject(tx, user, projectId);
    const micros = monthly === null ? null : toMicros(monthly);
    if ((p.budget_micros === null ? null : Number(p.budget_micros)) === micros) return;
    const c = await orgCostCtx(tx, p.org_id);
    const m = monthOf(c, ctx.clock.now());
    const spent = (await monthSpend(tx, p.org_id, p.id, c, m)) ?? 0;
    const events: AppendInput[] = [];
    const lifts = micros === null || spent < micros;
    const clearPaused = lifts && p.budget_paused_month === m.key;
    const clearWarned = micros === null || spent < (micros * BUDGET.warnPercent) / 100;
    if (clearPaused && (await noticeOpen(tx, p.budget_desk_item_id)))
      events.push(...resolveNotice(p, 'The budget was changed.'));
    events.push({
      streamId: streamId.project(p.id),
      event: {
        type: 'ProjectBudgetSet',
        payload: {
          projectId: p.id,
          monthlyMicros: micros,
          by: user.id,
          clearWarned: clearWarned && p.budget_warned_month === m.key,
          clearPaused,
        },
      },
      actor: userActor(user.id),
      scope: orgScope(p.org_id),
    });
    await ctx.store.append(events, { tx });
  });
  // Lowering a budget below what is spent notifies (and pauses) now, not at the next tick.
  await evaluateProjectBudget(ctx, projectId);
  ctx.services.dispatcher.trigger();
}

/** "Override for this month": the project dispatches again although its budget is used up; the 1st starts fresh. */
export async function overrideProjectBudget(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await lockProject(tx, user, projectId);
    if (p.budget_micros === null) throw conflict('no_budget', 'this project has no budget to override');
    const c = await orgCostCtx(tx, p.org_id);
    const m = monthOf(c, ctx.clock.now());
    if (p.budget_override_month === m.key) return;
    const events: AppendInput[] = [];
    if (await noticeOpen(tx, p.budget_desk_item_id))
      events.push(...resolveNotice(p, 'Overridden for this month.'));
    events.push({
      streamId: streamId.project(p.id),
      event: { type: 'ProjectBudgetOverridden', payload: { projectId: p.id, month: m.key, by: user.id } },
      actor: userActor(user.id),
      scope: orgScope(p.org_id),
    });
    await ctx.store.append(events, { tx });
  });
  ctx.services.dispatcher.trigger();
}

export async function setCostSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  req: UpdateCostSettingsRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const role = await orgRoleOf(tx, user.id, orgId);
    if (!isOrgManager({ orgRole: role }))
      throw forbidden('only the organization Owner and Admins can change the currency');
    const cur = await one(tx, 'SELECT currency, usd_rate FROM organizations WHERE id=$1', [orgId]);
    if (cur && cur.currency === req.currency && Number(cur.usd_rate) === req.usdRate) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgCostSettingsChanged',
            payload: { orgId, currency: req.currency, usdRate: req.usdRate, by: user.id },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}

/** The Owner or an Admin sets the human hours per card type and the value of an hour for the value report. */
export async function setValueSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  req: UpdateValueSettingsRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const role = await orgRoleOf(tx, user.id, orgId);
    if (!isOrgManager({ orgRole: role }))
      throw forbidden('only the organization Owner and Admins can change the value estimates');
    const hoursByType = Object.fromEntries(
      Object.entries(req.hoursByType).filter(([k]) => k in DEFAULT_HOURS_PER_CARD),
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: {
            type: 'OrgValueSettingsChanged',
            payload: { orgId, hoursByType, hourlyValue: req.hourlyValue, by: user.id },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}

async function monthSpend(
  tx: Tx | Ctx['pool'],
  orgId: string,
  projectId: string,
  c: { usdRate: number },
  m: { start: Date; next: Date },
): Promise<number> {
  const r = await one(
    tx,
    `SELECT COALESCE(sum(cost_usd_micros), 0) AS usd FROM shift_costs
      WHERE org_id=$1 AND project_id=$2 AND ended_at >= $3 AND ended_at < $4`,
    [orgId, projectId, m.start, m.next],
  );
  return inCurrency(r?.usd, c);
}

/**
 * Looks at one project's month and fires what is due, once per month and level: the 80% warning (a desk notice; the
 * BA reporter's budget signal follows from the detector) and the 100% pause (a desk item with "Raise budget" and
 * "Override for this month"). Called after a shift ends, after a budget change and on the scheduler tick.
 */
export async function evaluateProjectBudget(ctx: Ctx, projectId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await one(tx, `SELECT * FROM projects WHERE id=$1 AND status='active' FOR UPDATE`, [projectId]);
    if (!p || p.budget_micros === null) return;
    const now = ctx.clock.now();
    const c = await orgCostCtx(tx, p.org_id);
    const m = monthOf(c, now);
    const budget = Number(p.budget_micros);
    const spent = await monthSpend(tx, p.org_id, p.id, c, m);
    const overridden = p.budget_override_month === m.key;
    const { state } = budgetStatus(budget, spent, overridden);
    const events: AppendInput[] = [];
    // A pause of an earlier month: its notice is stale on the 1st.
    if (
      p.budget_paused_month &&
      p.budget_paused_month !== m.key &&
      (await noticeOpen(tx, p.budget_desk_item_id))
    )
      events.push(...resolveNotice(p, 'A new month began: the budget starts again.'));
    // An interest's backing project is shown under the interest's name (the project key is internal).
    const interest = await one(tx, 'SELECT id, name FROM interests WHERE project_id=$1', [p.id]);
    const short = (interest?.name as string | undefined) ?? p.key;
    const name = interest ? short : `${p.key} (${p.name})`;
    const money = (v: number) => formatMoney(v, c.currency);
    const resets = m.next.toISOString().slice(0, 10);
    if (state === 'paused' && p.budget_paused_month !== m.key) {
      const deskItemId = randomUUID();
      events.push(
        {
          streamId: streamId.project(p.id),
          event: {
            type: 'ProjectBudgetThresholdReached',
            payload: {
              projectId: p.id,
              month: m.key,
              level: 'paused',
              spendMicros: spent,
              budgetMicros: budget,
              deskItemId,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(p.org_id),
        },
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'alert',
              subkind: BUDGET_DESK.paused,
              title: `${short} is paused: its monthly budget is used up`,
              body: `${name} has spent ${money(spent)} of its ${money(budget)} budget this month. Running shifts finish; nothing new starts on it until the budget is raised, you override it for this month, or the budget resets on ${resets}.`,
              options: [
                { id: 'raise', label: 'Raise budget' },
                { id: 'override', label: 'Override for this month' },
              ],
              recommendation: 'raise',
              blocking: false,
              pinned: true,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              data: {
                projectId: p.id,
                projectKey: p.key,
                ...(interest ? { interestId: interest.id } : {}),
                month: m.key,
                spendMicros: spent,
                budgetMicros: budget,
              },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(p.org_id),
        },
      );
    } else if (state === 'warning' && p.budget_warned_month !== m.key) {
      const deskItemId = randomUUID();
      const pct = Math.floor((spent / budget) * 100);
      events.push(
        {
          streamId: streamId.project(p.id),
          event: {
            type: 'ProjectBudgetThresholdReached',
            payload: {
              projectId: p.id,
              month: m.key,
              level: 'warning',
              spendMicros: spent,
              budgetMicros: budget,
              deskItemId,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(p.org_id),
        },
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'alert',
              subkind: BUDGET_DESK.warning,
              title: `${short} has used ${pct}% of its monthly budget`,
              body: `${name} has spent ${money(spent)} of its ${money(budget)} budget this month. At 100% its dispatching pauses (running shifts finish). The budget resets on ${resets}.`,
              options: [],
              blocking: false,
              pinned: false,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              data: {
                projectId: p.id,
                projectKey: p.key,
                ...(interest ? { interestId: interest.id } : {}),
                month: m.key,
                spendMicros: spent,
                budgetMicros: budget,
              },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(p.org_id),
        },
      );
    }
    if (events.length) await ctx.store.append(events, { tx });
  });
}

/** The scheduler tick: every active project with a budget (cheap: indexed) gets its month looked at. */
export async function evaluateAllBudgets(ctx: Ctx): Promise<void> {
  const list = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM projects WHERE budget_micros IS NOT NULL AND status='active'`,
  );
  for (const { id } of list)
    await evaluateProjectBudget(ctx, id).catch((err) =>
      ctx.log.error({ err, projectId: id }, 'budget check failed'),
    );
}

/**
 * After a shift ends its project's month is looked at (the spend just changed). Delivery is the notifier's, so this is
 * not on the critical path of the shift report; the dispatcher's own pause check is stateless and never waits for it.
 */
export function registerBudgetHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e) => {
    if (e.event.type !== 'ShiftEnded') return;
    const r = await one(ctx.pool, 'SELECT project_id FROM shift_costs WHERE shift_id=$1', [
      e.event.payload.shiftId,
    ]);
    if (r?.project_id) await evaluateProjectBudget(ctx, r.project_id);
  });
}
