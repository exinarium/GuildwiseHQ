import { randomUUID } from 'node:crypto';
import { DEFAULT_MODEL_PRICES, type ModelPrice } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectBudgets } from '../src/ceo/detectors.ts';
import { evaluateAllBudgets, evaluateProjectBudget } from '../src/commands/budgets.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedInterest } from './helpers/feeds.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, until, type World } from './helpers/world.ts';

/**
 * Cost tracking and per-project budgets (docs/design/restructure.md roadmap): usage capture and pricing, the roll-ups,
 * the 80% notice, the 100% pause (dispatcher, scheduler), raise / override, the monthly reset in the organization's
 * time zone, permissions and the CSV export.
 */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  await w.hire('Ben', 'builder', 'junior', { model: 'claude-sonnet-4-5', capacity: 4 });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const hh = () => shiftHelpers(w);
// Sessions are real-time facts: moving the clock keeps them alive by moving their last-seen time with it.
const setNow = (at: Date) => {
  ctx().clock.setOffset(at.getTime() - Date.now());
  return q(`UPDATE auth_sessions SET last_seen_at=$1, expires_at='2099-01-01'`, [at]);
};
const inOrg = async (u: { cookie: string }) => ({
  cookie: u.cookie,
  headers: { 'x-aom-org': await orgId() },
});
const resetClock = () => ctx().clock.setOffset(0);
/** A user with a role in the world's organization; Members and Admins also join the project. */
async function roleUser(role: 'admin' | 'member') {
  const u = await w.t.userSession(uniqueEmail(role));
  await w.t.addOrgMember(await orgId(), u.id, role);
  if (role === 'member') {
    await ok(
      w.t.req('POST', `/api/projects/${w.projectId}/members`, {
        cookie: w.owner.cookie,
        body: { email: u.email },
      }),
      201,
    );
  }
  return u;
}
const online = () => markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
let seen = 0;

/** Runs one shift of a fresh card through the fake runner and ends it with the given usage. Returns ids. */
async function shiftWith(
  usage: Record<string, unknown>,
  card: Record<string, unknown> = {},
  outcome = 'stopped',
) {
  await online();
  await tidy();
  await w.card({ title: `cost ${++seen}`, ...card });
  const start = await hh().dispatchTo(r, 'Ben', r.received.length);
  await hh().startShift(r, start);
  r.ended(start.shiftId, outcome, {
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, ...usage },
  });
  await until(
    async () => (await q('SELECT 1 FROM shift_costs WHERE shift_id=$1', [start.shiftId]))[0],
    5000,
    'shift cost row',
  );
  const c = (await q('SELECT id, ref FROM cards WHERE ref=$1', [start.brief.card.ref]))[0] as {
    id: string;
    ref: string;
  };
  return { card: c, shiftId: start.shiftId as string };
}

/** Ends whatever is still open so every test starts with an empty queue and no claims. */
async function tidy() {
  await q(
    `UPDATE cards SET status='cancelled', claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL
      WHERE status NOT IN ('done','cancelled')`,
  );
  await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
}

/** A cost row written straight into the projection (thresholds and pauses need exact amounts, not shifts). */
async function addSpend(
  projectId: string,
  usdMicros: number,
  endedAt: Date = ctx().clock.now(),
  agentId?: string,
) {
  const agent = agentId ?? (await q(`SELECT id FROM agents WHERE name='Ben'`))[0]?.id;
  await q(
    `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, cost_usd_micros, ended_at)
     VALUES ($1, $2, $3, $4, 'card', 'sonnet', $5, $6)`,
    [randomUUID(), w.owner.id === undefined ? null : await orgId(), agent, projectId, usdMicros, endedAt],
  );
}
const orgId = async (): Promise<string> =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
const clearSpend = () => q('DELETE FROM shift_costs WHERE shift_id NOT IN (SELECT id FROM shifts)');

describe('usage capture and pricing', () => {
  it('prices a shift from its reported tokens and model, per the default table (Sonnet vs Opus)', async () => {
    const a = await shiftWith({ inputTokens: 2_000_000, outputTokens: 100_000, model: 'claude-opus-4-5' });
    const row = (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [a.shiftId]))[0];
    // Opus: 2M x $5 + 100k x $25 = $12.50
    expect(Number(row?.cost_usd_micros)).toBe(12_500_000);
    expect(row).toMatchObject({ model: 'claude-opus-4-5', kind: 'card', card_id: a.card.id });
    expect(row?.project_id).toBe(w.projectId);
    // Without a reported model the agent's configured one prices it: Sonnet 4.5 is $3, so 1M x $3 + 1M cache read x $0.30
    const b = await shiftWith({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 });
    const rb = (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [b.shiftId]))[0];
    expect(Number(rb?.cost_usd_micros)).toBe(3_300_000);
    expect(rb?.model).toBe('claude-sonnet-4-5');
    // The shift row itself keeps the tokens (the existing projection)
    const s = (await q('SELECT tokens_input, tokens_cache_read FROM shifts WHERE id=$1', [b.shiftId]))[0];
    expect([Number(s?.tokens_input), Number(s?.tokens_cache_read)]).toEqual([1_000_000, 1_000_000]);
  });

  it('keeps the runtime-reported cost beside the computed one, and a stamped cost wins over the table', async () => {
    const c = await shiftWith({ inputTokens: 1000, outputTokens: 1000, costUsd: 0.0123 });
    const row = (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [c.shiftId]))[0];
    expect(Number(row?.reported_usd_micros)).toBe(12_300);
    // Sonnet 4.5: $3 / $15 per million tokens
    expect(Number(row?.cost_usd_micros)).toBe(1000 * 3 + 1000 * 15);
  });

  it('counts chats: to the card project when card-linked, else to the org overhead bucket', async () => {
    const org = await orgId();
    const store = ctx().store;
    const agent = (await q(`SELECT id, workstation_id FROM agents WHERE name='Ben'`))[0];
    const mk = async (chatId: string, projectId: string | undefined, cardId?: string) => {
      await store.append([
        {
          streamId: `shift-${chatId}`,
          event: {
            type: 'ShiftStarted',
            payload: {
              shiftId: chatId,
              agentId: agent?.id,
              workstationId: agent?.workstation_id,
              ...(cardId ? { cardId } : {}),
              kind: 'chat',
              runtime: 'mock',
              model: 'sonnet',
              overflow: false,
              ...(projectId ? { projectId } : {}),
            },
          },
          actor: { kind: 'system', id: null },
          scope: { orgId: org, projectId: null, audience: 'org' },
        },
        {
          streamId: `shift-${chatId}`,
          event: {
            type: 'ShiftEnded',
            payload: {
              shiftId: chatId,
              agentId: agent?.id,
              outcome: 'reported',
              durationMs: 10,
              usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              guardViolations: [],
            },
          },
          actor: { kind: 'system', id: null },
          scope: { orgId: org, projectId: null, audience: 'org' },
        },
      ]);
    };
    const withProject = randomUUID();
    const overhead = randomUUID();
    await mk(withProject, w.projectId);
    await mk(overhead, undefined);
    const a = (
      await q('SELECT project_id, cost_usd_micros, kind FROM shift_costs WHERE shift_id=$1', [withProject])
    )[0];
    const b = (
      await q('SELECT project_id, cost_usd_micros, kind FROM shift_costs WHERE shift_id=$1', [overhead])
    )[0];
    expect(a).toMatchObject({ project_id: w.projectId, kind: 'chat' });
    expect(b?.project_id).toBeNull();
    expect(Number(b?.cost_usd_micros)).toBe(2_000_000);
    const rep = await ok<any>(owner('GET', '/api/costs'));
    expect(rep.overhead.costMicros).toBeGreaterThanOrEqual(2_000_000);
  });
});

describe('roll-ups', () => {
  it('rolls up per agent, card, project, model and day (the Costs page) and per card on the card page', async () => {
    const x = await shiftWith({ inputTokens: 1_000_000, outputTokens: 1_000_000, model: 'claude-haiku-4-5' });
    const rep = await ok<any>(owner('GET', '/api/costs'));
    expect(rep.currency).toBe('USD');
    const toy = rep.byProject.find((p: any) => p.projectId === w.projectId);
    expect(toy.key).toBe('TOY');
    expect(toy.costMicros).toBeGreaterThanOrEqual(6_000_000);
    expect(rep.byAgent.find((a: any) => a.name === 'Ben').shifts).toBeGreaterThanOrEqual(4);
    expect(rep.byModel.map((m: any) => m.family)).toEqual(
      expect.arrayContaining(['Opus', 'Sonnet', 'Haiku']),
    );
    expect(rep.byDay.length).toBeGreaterThanOrEqual(1);
    expect(rep.totals.costMicros).toBe(rep.byDay.reduce((s: number, d: any) => s + d.costMicros, 0));
    const detail = await ok<any>(owner('GET', `/api/cards/${x.card.ref}`));
    expect(detail.spend.totalMicros).toBe(6_000_000); // Haiku $1 + $5
    // the HR board shows the agent's spend, month and total
    const hr = await ok<any>(owner('GET', '/api/hr/board'));
    const ben = hr.agents.find((a: any) => a.agent.name === 'Ben');
    expect(ben.spend.totalMicros).toBeGreaterThan(0);
    expect(ben.spend.monthMicros).toBeGreaterThan(0);
  });

  it('rolls a phase up through its cards and its BA tasks, and an interest through its backing project', async () => {
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Costly' }),
      201,
    );
    const y = await shiftWith({ inputTokens: 1_000_000, outputTokens: 0 });
    // the card joins the phase afterwards: the roll-up follows the card
    await ok(owner('PUT', `/api/cards/${y.card.id}/phase`, { phaseId: phase.id }));
    const p = await ok<any>(owner('GET', `/api/phases/${phase.id}`));
    expect(p.spend.totalMicros).toBe(3_000_000); // 1M Sonnet 4.5 input tokens at $3
    // a BA task cost
    await q(
      `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, phase_id, kind, model, cost_usd_micros, ended_at)
       VALUES ($1,$2,(SELECT id FROM agents WHERE name='Ben'),$3,$4,'ba_task','sonnet',500000,now())`,
      [randomUUID(), await orgId(), w.projectId, phase.id],
    );
    expect((await ok<any>(owner('GET', `/api/phases/${phase.id}`))).spend.totalMicros).toBe(3_500_000);
    // an interest
    const i = await createFeedInterest(w, { name: 'Costs interest' });
    await addSpend(i.projectId, 2_000_000);
    const dto = (await ok<any>(owner('GET', `/api/interests/${i.id}`))).interest;
    expect(dto.spend.totalMicros).toBe(2_000_000);
    expect(dto.budget.state).toBe('none');
    const rep = await ok<any>(owner('GET', '/api/costs'));
    expect(rep.byProject.find((x: any) => x.interestId === i.id).name).toBe('Costs interest');
  });
});

describe('budgets: thresholds, pause, raise, override, reset', () => {
  const setBudget = (monthly: number | null, cookie = w.owner.cookie, project = w.projectId) =>
    w.t.req('PUT', `/api/projects/${project}/budget`, { cookie, body: { monthly } });
  const project = async () => (await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).project as any;
  const items = async (subkind: string) =>
    q(`SELECT id, status, title, kind FROM desk_items WHERE subkind=$1 AND org_id=$2 ORDER BY created_at`, [
      subkind,
      await orgId(),
    ]);
  const fresh = async () => {
    resetClock();
    await tidy();
    await clearSpend();
    // earlier shifts of this file keep their rows (a rebuild must reproduce them) but leave the month under test
    await q(`UPDATE shift_costs SET ended_at = '2020-01-01' WHERE shift_id IN (SELECT id FROM shifts)`);
    await q(`DELETE FROM desk_items WHERE subkind IN ('budget_warning','budget_paused')`);
    await q(
      `UPDATE projects SET budget_micros=NULL, budget_override_month=NULL, budget_warned_month=NULL,
              budget_paused_month=NULL, budget_desk_item_id=NULL WHERE id=$1`,
      [w.projectId],
    );
    await q(`UPDATE users SET timezone=NULL WHERE id=$1`, [w.owner.id]);
  };

  it('shows the real month spend on a project without a budget (#56)', async () => {
    await fresh();
    await addSpend(w.projectId, 2_500_000);
    const p = await project();
    expect(p.budget).toMatchObject({ state: 'none', monthlyMicros: null, spentMicros: 2_500_000 });
    const list = await ok<any>(owner('GET', '/api/projects'));
    expect(list.projects.find((x: any) => x.id === w.projectId).budget.spentMicros).toBe(2_500_000);
  });

  it('an Owner sets the monthly budget; a plain Member cannot, and the amounts show on the project', async () => {
    await fresh();
    const member = await roleUser('member');
    // the Member is a member of the project but only a Member of the org: no budget editing
    expect((await setBudget(10, member.cookie)).status).toBe(403);
    expect(
      (await w.t.req('POST', `/api/projects/${w.projectId}/budget/override`, { cookie: member.cookie }))
        .status,
    ).toBe(403);
    await ok(setBudget(10));
    const p = await project();
    expect(p.budget).toMatchObject({
      state: 'ok',
      monthlyMicros: 10_000_000,
      spentMicros: 0,
      currency: 'USD',
      canEdit: true,
    });
    const asMember = (
      await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: member.cookie }))
    ).project;
    expect(asMember.budget.canEdit).toBe(false);
    expect((await w.t.req('GET', '/api/costs', await inOrg(member))).status).toBe(403);
    expect((await w.t.req('GET', '/api/costs/export.csv', await inOrg(member))).status).toBe(403);
    expect((await setBudget(-1)).status).toBe(400);
  });

  it('at 80% posts one notice to the Owner and Admins and raises a budget signal for the BA; once per month', async () => {
    await fresh();
    await ok(setBudget(10));
    await addSpend(w.projectId, 8_000_000);
    await evaluateProjectBudget(ctx(), w.projectId);
    await evaluateProjectBudget(ctx(), w.projectId);
    const notices = await items('budget_warning');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ status: 'open', kind: 'alert' });
    expect(notices[0]?.title).toMatch(/TOY has used 80% of its monthly budget/);
    expect((await project()).budget.state).toBe('warning');
    // the Owner sees it on the desk
    const desk = await ok<any>(owner('GET', '/api/desk'));
    expect(desk.items.some((d: any) => d.subkind === 'budget_warning')).toBe(true);
    // the BA reporter's detector: a normal-urgency budget signal
    const sig = (await detectBudgets(ctx().pool, ctx().clock.now())).filter(
      (d) => d.projectId === w.projectId,
    );
    expect(sig).toHaveLength(1);
    expect(sig[0]).toMatchObject({ kind: 'budget', urgency: 'normal' });
    // not paused: a card is still dispatched
    await online();
    const c = await w.card({ title: 'still runs at 80%' });
    const start = await hh().dispatchTo(r, 'Ben', r.received.length);
    expect(start.brief.card.ref).toBe(c.ref);
    r.ended(start.shiftId, 'stopped');
    await r.barrier();
  });

  it('at 100% pauses the project: the dispatcher claims nothing there, running work is not touched, a desk item offers raise and override', async () => {
    await fresh();
    await ok(setBudget(10));
    await online();
    const c = await w.card({ title: 'runs before the pause' });
    const start = await hh().dispatchTo(r, 'Ben', r.received.length);
    await hh().startShift(r, start);
    expect(start.brief.card.ref).toBe(c.ref);
    // the money runs out while the shift is running
    await addSpend(w.projectId, 10_000_000);
    await evaluateProjectBudget(ctx(), w.projectId);
    const paused = await items('budget_paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]?.title).toMatch(/TOY is paused/);
    const item = (await ok<any>(owner('GET', '/api/desk'))).items.find(
      (d: any) => d.subkind === 'budget_paused',
    );
    expect(item.options.map((o: any) => o.label)).toEqual(['Raise budget', 'Override for this month']);
    expect(item.budgetProject).toEqual({ projectId: w.projectId, projectKey: 'TOY' });
    expect((await project()).budget.state).toBe('paused');
    // the running shift finishes normally
    expect((await q(`SELECT status FROM shifts WHERE id=$1`, [start.shiftId]))[0]?.status).toBe('running');
    r.ended(start.shiftId, 'stopped');
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [start.shiftId]))[0],
    );
    // nothing new starts: the queued card stays queued across passes
    await online();
    await w.card({ title: 'waits for the budget' });
    const from = r.received.length;
    for (let i = 0; i < 2; i++) expect(await ctx().services.dispatcher.runPass()).toEqual([]);
    expect(r.received.slice(from).some((f: any) => f.type === 'shift.start')).toBe(false);
    // the BA signal is urgent now
    const sig = (await detectBudgets(ctx().pool, ctx().clock.now())).filter(
      (d) => d.projectId === w.projectId,
    );
    expect(sig[0]).toMatchObject({ kind: 'budget', urgency: 'urgent' });
    // a second evaluation does not post a second item
    await evaluateAllBudgets(ctx());
    expect(await items('budget_paused')).toHaveLength(1);
  });

  it('raising the budget lifts the pause at once and closes the desk item', async () => {
    // continues from the paused state above
    await ok(setBudget(20));
    expect((await project()).budget.state).toBe('ok');
    expect((await items('budget_paused'))[0]?.status).not.toBe('open');
    await online();
    const made = await ctx().services.dispatcher.runPass();
    expect(made.length).toBe(1);
    await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
  });

  it('"Override for this month" lets a used-up budget dispatch again; nobody but Owner or Admin can', async () => {
    await fresh();
    await q(`UPDATE cards SET status='cancelled' WHERE status NOT IN ('done','cancelled')`);
    await q(`UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL`);
    await ok(setBudget(10));
    await addSpend(w.projectId, 12_000_000);
    await evaluateProjectBudget(ctx(), w.projectId);
    expect((await project()).budget.state).toBe('paused');
    await online();
    await w.card({ title: 'after override' });
    expect(await ctx().services.dispatcher.runPass()).toEqual([]);
    const member = await roleUser('member');
    expect(
      (await w.t.req('POST', `/api/projects/${w.projectId}/budget/override`, { cookie: member.cookie }))
        .status,
    ).toBe(403);
    await ok(w.t.req('POST', `/api/projects/${w.projectId}/budget/override`, { cookie: w.owner.cookie }));
    expect((await project()).budget.state).toBe('overridden');
    expect((await items('budget_paused'))[0]?.status).not.toBe('open');
    await online();
    expect((await ctx().services.dispatcher.runPass()).length).toBe(1);
    await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
    // overriding a project with no budget is refused
    await ok(setBudget(null));
    expect(
      (await w.t.req('POST', `/api/projects/${w.projectId}/budget/override`, { cookie: w.owner.cookie }))
        .status,
    ).toBe(409);
  });

  it('lowering a budget below what is spent pauses at once', async () => {
    await fresh();
    await addSpend(w.projectId, 6_000_000);
    await ok(setBudget(5));
    expect((await project()).budget.state).toBe('paused');
    expect(await items('budget_paused')).toHaveLength(1);
  });

  it('the budget resets on the 1st in the organization time zone, not at UTC midnight', async () => {
    await fresh();
    await q(`UPDATE cards SET status='cancelled' WHERE status NOT IN ('done','cancelled')`);
    await ok(owner('PUT', '/api/auth/timezone', { timezone: 'America/New_York' }));
    await ok(setBudget(10));
    // $12 spent at 23:30 on October 31st in New York (03:30 UTC on November 1st)
    await addSpend(w.projectId, 12_000_000, new Date('2026-11-01T03:30:00Z'));
    await setNow(new Date('2026-11-01T03:45:00Z'));
    await online();
    await evaluateProjectBudget(ctx(), w.projectId);
    expect((await project()).budget).toMatchObject({ state: 'paused', month: '2026-10' });
    expect((await project()).budget.resetsAt).toBe('2026-11-01T04:00:00.000Z');
    await w.card({ title: 'month end' });
    expect(await ctx().services.dispatcher.runPass()).toEqual([]);
    // 00:15 on November 1st in New York: a new month, a fresh budget, and the old pause notice closes
    await setNow(new Date('2026-11-01T04:15:00Z'));
    await online();
    expect((await project()).budget).toMatchObject({ state: 'ok', month: '2026-11', spentMicros: 0 });
    await evaluateAllBudgets(ctx());
    expect((await items('budget_paused'))[0]?.status).not.toBe('open');
    expect((await ctx().services.dispatcher.runPass()).length).toBe(1);
    await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
    // the same instants in a UTC organization are still the same (November) month, so it is still paused
    await ok(owner('PUT', '/api/auth/timezone', { timezone: 'UTC' }));
    expect((await project()).budget).toMatchObject({ state: 'paused', month: '2026-11' });
    resetClock();
  });

  it('a spend in the new month warns again in that month (the month key is part of the threshold)', async () => {
    await fresh();
    await ok(setBudget(10));
    await setNow(new Date('2026-12-05T12:00:00Z'));
    await addSpend(w.projectId, 9_000_000, new Date('2026-12-04T12:00:00Z'));
    await evaluateProjectBudget(ctx(), w.projectId);
    expect(await items('budget_warning')).toHaveLength(1);
    await setNow(new Date('2027-01-05T12:00:00Z'));
    await addSpend(w.projectId, 9_000_000, new Date('2027-01-04T12:00:00Z'));
    await evaluateProjectBudget(ctx(), w.projectId);
    expect(await items('budget_warning')).toHaveLength(2);
    resetClock();
  });

  it('the scheduler starts no interest run for a project that is over budget, and a manual run is refused', async () => {
    await fresh();
    const i = await createFeedInterest(w, { name: 'Pausable', scan: { cron: '0 7 * * *' } });
    await ok(
      w.t.req('PUT', `/api/interests/${i.id}/budget`, { cookie: w.owner.cookie, body: { monthly: 1 } }),
    );
    await addSpend(i.projectId, 2_000_000);
    const dto = (await ok<any>(owner('GET', `/api/interests/${i.id}`))).interest;
    expect(dto.budget).toMatchObject({ state: 'paused', canEdit: true });
    // the desk notice is about the interest, not about its hidden project
    await evaluateProjectBudget(ctx(), i.projectId);
    const notice = (await ok<any>(owner('GET', '/api/desk'))).items.find(
      (d: any) => d.subkind === 'budget_paused' && d.budgetProject?.projectId === i.projectId,
    );
    expect(notice.title).toBe('Pausable is paused: its monthly budget is used up');
    expect(notice.budgetProject.interestId).toBe(i.id);
    const due = new Date(
      new Date(
        (await q('SELECT next_scan_at FROM interests WHERE id=$1', [i.id]))[0]?.next_scan_at,
      ).getTime() + 1000,
    );
    await setNow(due);
    await ctx().services.scheduler.run();
    expect((await q(`SELECT count(*)::int AS n FROM cards WHERE project_id=$1`, [i.projectId]))[0]?.n).toBe(
      0,
    );
    expect((await q('SELECT last_error FROM interests WHERE id=$1', [i.id]))[0]?.last_error).toBe(
      'budget_paused',
    );
    const manual = await owner('POST', `/api/interests/${i.id}/run`, {});
    expect(manual.status).toBe(409);
    expect(manual.body.error.code).toBe('budget_paused');
    // override from the interest settings: the run is allowed again
    await ok(w.t.req('POST', `/api/interests/${i.id}/budget/override`, { cookie: w.owner.cookie }));
    expect((await owner('POST', `/api/interests/${i.id}/run`, {})).status).toBe(201);
    resetClock();
  });

  it('the project dispatch gate is shared by the claim: a card cannot be claimed once paused', async () => {
    await fresh();
    await q(`UPDATE cards SET status='cancelled' WHERE status NOT IN ('done','cancelled')`);
    await ok(setBudget(1));
    await addSpend(w.projectId, 2_000_000);
    await online();
    await w.card({ title: 'blocked by the gate' });
    expect(await ctx().services.dispatcher.runPass()).toEqual([]);
  });
});

describe('guests', () => {
  it('see that a shared project is paused but never its amounts, and cannot change anything', async () => {
    const { addMember } = await import('./helpers/members.ts');
    await q(
      `UPDATE projects SET budget_micros=5000000, budget_paused_month=NULL, budget_override_month=NULL WHERE id=$1`,
      [w.projectId],
    );
    await q(`DELETE FROM shift_costs WHERE project_id=$1 AND shift_id NOT IN (SELECT id FROM shifts)`, [
      w.projectId,
    ]);
    await addSpend(w.projectId, 6_000_000);
    const guest = await addMember(w, 'guest');
    const p = (await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: guest.cookie })))
      .project;
    expect(p.budget).toMatchObject({
      state: 'paused',
      monthlyMicros: null,
      spentMicros: null,
      percent: null,
      canEdit: false,
    });
    const list = (await ok<any>(w.t.req('GET', '/api/projects', { cookie: guest.cookie }))).projects.find(
      (x: any) => x.id === w.projectId,
    );
    expect(list.budget.spentMicros).toBeNull();
    expect(
      (
        await w.t.req('PUT', `/api/projects/${w.projectId}/budget`, {
          cookie: guest.cookie,
          body: { monthly: 100 },
        })
      ).status,
    ).toBe(404);
    const card = await q(`SELECT ref FROM cards LIMIT 1`);
    if (card[0]) {
      const detail = await ok<any>(w.t.req('GET', `/api/cards/${card[0].ref}`, { cookie: guest.cookie }));
      expect(detail.spend).toBeUndefined();
    }
    await q(`UPDATE projects SET budget_micros=NULL WHERE id=$1`, [w.projectId]);
    await q(`DELETE FROM shift_costs WHERE project_id=$1 AND shift_id NOT IN (SELECT id FROM shifts)`, [
      w.projectId,
    ]);
  });
});

describe('the floor report spend section and the CSV export', () => {
  it('the digest carries spend and budgets (the BA and the template render them)', async () => {
    const { buildFloorDigest } = await import('../src/ceo/digest.ts');
    await q(`UPDATE projects SET budget_micros=$2 WHERE id=$1`, [w.projectId, 10_000_000]);
    await addSpend(w.projectId, 3_000_000);
    const d = await buildFloorDigest(ctx().pool, await orgId(), ctx().clock.now(), '2026-10-07');
    expect(d.spend.currency).toBe('USD');
    expect(d.spend.monthMicros).toBeGreaterThan(0);
    const toy = d.spend.projects.find((p) => p.key === 'TOY');
    expect(toy?.budgetMicros).toBe(10_000_000);
    expect(toy?.monthMicros).toBeGreaterThanOrEqual(3_000_000);
    expect(['ok', 'warning', 'paused', 'overridden']).toContain(toy?.state);
  });

  it('exports CSV for the range for Owner and Admin, neutralising formula-like names', async () => {
    await q(`UPDATE agents SET name='=SUM(A1)' WHERE name='Ben'`);
    let res: Awaited<ReturnType<typeof w.t.req>>;
    try {
      res = await w.t.req('GET', '/api/costs/export.csv?from=2000-01-01', { cookie: w.owner.cookie });
    } finally {
      await q(`UPDATE agents SET name='Ben' WHERE name='=SUM(A1)'`);
    }
    expect(res.status).toBe(200);
    const text = typeof res.body === 'string' ? res.body : String(res.body);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('date,project,agent,model,shifts,input,output,cache_read,cache_write,cost');
    expect(lines.length).toBeGreaterThan(2);
    expect(text).toContain("'=SUM(A1)");
    expect(text).not.toMatch(/,=SUM/);
    const first = lines[1]?.split(',') ?? [];
    expect(first[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(first.at(-1))).toBeGreaterThanOrEqual(0);
  });

  it('honours the date range and the project filter', async () => {
    const r1 = await ok<any>(owner('GET', '/api/costs?from=2001-01-01&to=2001-01-31'));
    expect(r1.totals.costMicros).toBe(0);
    expect(r1.byProject).toEqual([]);
    const r2 = await ok<any>(owner('GET', `/api/costs?projectId=${w.projectId}`));
    expect(r2.byProject.every((p: any) => p.projectId === w.projectId)).toBe(true);
    expect((await owner('GET', '/api/costs?from=nope')).status).toBe(400);
  });
});

describe('the currency', () => {
  it('shows budgets and costs in the organization currency at its rate; Admin and Owner set it', async () => {
    await clearSpend();
    await q(`UPDATE projects SET budget_micros=NULL, budget_paused_month=NULL WHERE id=$1`, [w.projectId]);
    const s = await ok<any>(owner('PUT', '/api/costs/settings', { currency: 'EUR', usdRate: 0.5 }));
    expect(s).toMatchObject({ currency: 'EUR', usdRate: 0.5, canEdit: true });
    await addSpend(w.projectId, 10_000_000);
    const rep = await ok<any>(owner('GET', '/api/costs'));
    expect(rep.currency).toBe('EUR');
    expect(rep.totals.costMicros).toBe(5_000_000);
    expect((await owner('PUT', '/api/costs/settings', { currency: 'euro', usdRate: 1 })).status).toBe(400);
    await ok(owner('PUT', '/api/costs/settings', { currency: 'USD', usdRate: 1 }));
    const m = await roleUser('member');
    expect(
      (
        await w.t.req('PUT', '/api/costs/settings', {
          ...(await inOrg(m)),
          body: { currency: 'EUR', usdRate: 1 },
        })
      ).status,
    ).toBe(403);
    // any member may read the currency (to format the amounts they see)
    expect((await ok<any>(w.t.req('GET', '/api/costs/settings', await inOrg(m)))).canEdit).toBe(false);
    // an Admin may set it and read the Costs page
    const admin = await roleUser('admin');
    await ok(
      w.t.req('PUT', '/api/costs/settings', {
        ...(await inOrg(admin)),
        body: { currency: 'USD', usdRate: 1 },
      }),
    );
    await ok(w.t.req('GET', '/api/costs', await inOrg(admin)));
  });
});

describe('the migration backfill prices history like the projector', () => {
  it('Opus, Sonnet, Haiku and unknown models, every token kind, to the micro-dollar', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { defaultMigrationsDir } = await import('../src/db/migrate.ts');
    const { costUsdMicros } = await import('@aom/shared');
    // Migration 1318 is a one-off with the family prices of its day (every Sonnet $2 / $10, Fable cache read $1). The live
    // table has since been corrected per version, so the comparison uses a frozen copy of the table as it was then.
    const family = (match: string, input: number, output: number, cacheRead: number, cacheWrite: number) => ({
      match,
      label: match,
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheWrite1h: cacheWrite,
    });
    const TABLE_AT_1318 = [
      family('fable', 10, 50, 1, 12.5),
      family('opus', 5, 25, 0.5, 6.25),
      family('sonnet', 2, 10, 0.2, 2.5),
      family('haiku', 1, 5, 0.1, 1.25),
      family('', 2, 10, 0.2, 2.5),
    ];
    const sql1317 = await readFile(join(defaultMigrationsDir(), '1317_costs_budgets.sql'), 'utf8');
    const sql1318 = await readFile(join(defaultMigrationsDir(), '1318_reprice_shift_costs.sql'), 'utf8');
    // 1317 inserts the missing rows (at the prices of its day); 1318 reprices every table-priced row.
    const insertRows = sql1317.slice(sql1317.indexOf('INSERT INTO shift_costs'));
    const backfill = `${insertRows}\n${sql1318.slice(sql1318.indexOf('UPDATE shift_costs'))}`;
    const base = await shiftWith({ inputTokens: 1, outputTokens: 1 });
    const shift = (await q('SELECT * FROM shifts WHERE id=$1', [base.shiftId]))[0] as Record<string, any>;
    const original = (await q('SELECT to_jsonb(t) AS j FROM shift_costs t WHERE shift_id=$1', [shift.id]))[0]
      ?.j;
    const cases = [
      'claude-fable-5-1',
      'claude-opus-4-5',
      'CLAUDE-SONNET-4-5',
      'claude-haiku-4-5',
      'mock',
      'gpt-x',
    ];
    const tokens = [
      { i: 123_457, o: 98_765, cr: 5, cw: 7 },
      { i: 5, o: 3, cr: 5, cw: 5 },
      { i: 0, o: 0, cr: 0, cw: 0 },
    ];
    for (const model of cases)
      for (const t of tokens) {
        await q('DELETE FROM shift_costs WHERE shift_id=$1', [shift.id]);
        await q(
          `UPDATE shifts SET model=$2, tokens_input=$3, tokens_output=$4, tokens_cache_read=$5, tokens_cache_write=$6 WHERE id=$1`,
          [shift.id, model, t.i, t.o, t.cr, t.cw],
        );
        await q(backfill);
        const row = (await q('SELECT cost_usd_micros FROM shift_costs WHERE shift_id=$1', [shift.id]))[0];
        expect(Number(row?.cost_usd_micros), `${model} ${JSON.stringify(t)}`).toBe(
          costUsdMicros(
            model,
            { inputTokens: t.i, outputTokens: t.o, cacheReadTokens: t.cr, cacheWriteTokens: t.cw },
            TABLE_AT_1318,
          ),
        );
      }
    // running it again changes nothing (idempotent)
    const n = (await q('SELECT count(*)::int AS n FROM shift_costs'))[0]?.n;
    await q(backfill);
    expect((await q('SELECT count(*)::int AS n FROM shift_costs'))[0]?.n).toBe(n);
    // restore the shift row so the rebuild test below compares real data
    await q(
      `UPDATE shifts SET model=$2, tokens_input=1, tokens_output=1, tokens_cache_read=0, tokens_cache_write=0 WHERE id=$1`,
      [shift.id, shift.model],
    );
    // (the row the projector wrote goes back as it was: the backfill would price it at the 1318 prices)
    await q('DELETE FROM shift_costs WHERE shift_id=$1', [shift.id]);
    await q('INSERT INTO shift_costs SELECT * FROM jsonb_populate_record(NULL::shift_costs, $1::jsonb)', [
      JSON.stringify(original),
    ]);
  });
});

describe('a rebuild reproduces the cost rows and the budget state', () => {
  it('replays the events into the same shift_costs, budgets and currency', async () => {
    await clearSpend();
    await shiftWith({ inputTokens: 123_456, outputTokens: 7_890, model: 'claude-opus-4-5' });
    await ok(
      w.t.req('PUT', `/api/projects/${w.projectId}/budget`, {
        cookie: w.owner.cookie,
        body: { monthly: 50 },
      }),
    );
    // a project of its own walks through warning, pause and override, so the month keys come from events alone
    const rbd = await ok<any>(owner('POST', '/api/projects', { key: 'RBD', name: 'Rebuild' }), 201);
    await ok(
      w.t.req('PUT', `/api/projects/${rbd.project.id}/budget`, {
        cookie: w.owner.cookie,
        body: { monthly: 5 },
      }),
    );
    await addSpend(rbd.project.id, 6_000_000);
    await evaluateProjectBudget(ctx(), rbd.project.id);
    await ok(w.t.req('POST', `/api/projects/${rbd.project.id}/budget/override`, { cookie: w.owner.cookie }));
    await ok(owner('PUT', '/api/costs/settings', { currency: 'GBP', usdRate: 0.8 }));
    const snap = async () => {
      const out: Record<string, string[]> = {};
      for (const [table, sql] of [
        [
          'shift_costs',
          `SELECT to_jsonb(t) - 'ended_at' AS j FROM shift_costs t WHERE shift_id IN (SELECT id FROM shifts)`,
        ],
        [
          'budget',
          `SELECT jsonb_build_object('k', key, 'b', budget_micros, 'w', budget_warned_month, 'p', budget_paused_month, 'o', budget_override_month, 'd', budget_desk_item_id) AS j FROM projects WHERE key='RBD'`,
        ],
        [
          'amount',
          `SELECT jsonb_build_object('b', budget_micros) AS j FROM projects WHERE id='${w.projectId}'`,
        ],
        [
          'org',
          `SELECT jsonb_build_object('c', currency, 'r', usd_rate::text) AS j FROM organizations WHERE id='${await orgId()}'`,
        ],
      ] as const)
        out[table] = (await q(sql)).map((x) => JSON.stringify(x.j)).sort();
      return out;
    };
    const before = await snap();
    expect(before.shift_costs?.length).toBeGreaterThan(0);
    expect(JSON.parse(before.budget?.[0] ?? '{}')).toMatchObject({
      b: 5_000_000,
      p: expect.stringMatching(/^\d{4}-\d{2}$/),
      o: expect.stringMatching(/^\d{4}-\d{2}$/),
      d: null,
    });
    expect(PROJECTION_TABLES).toContain('shift_costs');
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await snap()).toEqual(before);
    await ok(owner('PUT', '/api/costs/settings', { currency: 'USD', usdRate: 1 }));
  });
});

describe('a price-table change after the fact', () => {
  it('stamps the price on the shift event, so a rebuild keeps it when the table later changes', async () => {
    await clearSpend();
    const a = await shiftWith({ inputTokens: 1_000_000, outputTokens: 0 });
    const stamped = (
      await q(`SELECT payload FROM events WHERE type='ShiftEnded' AND stream_id LIKE $1`, [`%${a.shiftId}`])
    )[0]?.payload as { costMicros?: number } | undefined;
    expect(stamped?.costMicros).toBe(3_000_000); // Sonnet 4.5: $3 per million input tokens
    const price = (DEFAULT_MODEL_PRICES as ModelPrice[]).find((p) => p.match === 'sonnet-4') as ModelPrice;
    const was = price.input;
    try {
      price.input = 30; // a later correction of the table
      await rebuildProjections(ctx().pool, ctx().store);
      const row = (
        await q('SELECT cost_usd_micros, cost_stamped FROM shift_costs WHERE shift_id=$1', [a.shiftId])
      )[0];
      expect(Number(row?.cost_usd_micros)).toBe(3_000_000);
      expect(row?.cost_stamped).toBe(true);
      // a shift ended after the change is priced (and stamped) at the new table
      const b = await shiftWith({ inputTokens: 1_000_000, outputTokens: 0 });
      expect(
        Number(
          (await q('SELECT cost_usd_micros FROM shift_costs WHERE shift_id=$1', [b.shiftId]))[0]
            ?.cost_usd_micros,
        ),
      ).toBe(30_000_000);
    } finally {
      price.input = was;
    }
  });
});
