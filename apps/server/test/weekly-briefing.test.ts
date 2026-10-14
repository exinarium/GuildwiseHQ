import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoWeekOf, lastBriefingDue, weeklyBriefingTick } from '../src/commands/weekly-briefing.ts';
import { uniqueEmail } from './helpers/app.ts';
import { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** The Monday briefing (backlog #38): who gets which version, when, exactly once, and the person's opt-out. */
let w: World;
const mail = new CaptureMailer();
let member: { id: string; email: string; cookie: string };
let optedOut: { id: string; email: string; cookie: string };
let orgId: string;
const ctx = () => w.t.app.ctx;
/** The DB is shared with other test files, whose organizations also get a briefing from a tick: look at ours only. */
const mine = () => mail.sent.filter((m) => [w.owner.email, member.email, optedOut.email].includes(m.to));
const deliveries = async (week: string) =>
  (await q(`SELECT user_id, state FROM briefing_deliveries WHERE org_id=$1 AND week=$2`, [
    orgId,
    week,
  ])) as Array<{
    user_id: string;
    state: string;
  }>;
const setNow = (iso: string) => ctx().clock.setOffset(new Date(iso).getTime() - Date.now());

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  ctx().mailer = mail;
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  // the organization's time zone is its Owner's
  await q('UPDATE users SET timezone=$2 WHERE id=$1', [w.owner.id, 'Africa/Johannesburg']);
  const add = async (label: string) => {
    const u = await w.t.userSession(uniqueEmail(label));
    await w.t.addOrgMember(orgId, u.id, 'member');
    await ok(
      w.t.req('POST', `/api/projects/${w.projectId}/members`, {
        cookie: w.owner.cookie,
        body: { email: u.email },
      }),
      201,
    );
    return u;
  };
  member = await add('briefing-member');
  optedOut = await add('briefing-out');
  await ok(w.t.req('PUT', '/api/me/weekly-briefing', { cookie: optedOut.cookie, body: { enabled: false } }));

  // last week's work: two done cards, one blocked card; a desk approval; a Claude login notice for the owner; spend + budget
  for (const at of ['2026-10-07T10:00:00Z', '2026-10-08T10:00:00Z']) {
    const c = await w.card({ title: `Shipped ${at.slice(8, 10)}` });
    await q(`UPDATE cards SET status='done', finalized_at=$2 WHERE id=$1`, [c.id, at]);
  }
  const b = await w.card({ title: 'Waiting on the API key' });
  await q(`UPDATE cards SET status='blocked', blocked_since='2026-10-06T10:00:00Z' WHERE id=$1`, [b.id]);
  await q(
    `INSERT INTO desk_items (id, org_id, project_id, kind, title, created_at, updated_at)
     VALUES ($1,$2,$3,'approval','Approve the large merge','2026-10-09T10:00:00Z','2026-10-09T10:00:00Z')`,
    [randomUUID(), orgId, w.projectId],
  );
  await q(
    `INSERT INTO desk_items (id, org_id, kind, subkind, status, title, addressee_user_id, created_at, updated_at)
     VALUES ($1,$2,'alert','claude_auth_expired','open','Claude login expired on Desk',$3,'2026-10-09T10:00:00Z','2026-10-09T10:00:00Z')`,
    [randomUUID(), orgId, w.owner.id],
  );
  await ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/budget`, { cookie: w.owner.cookie, body: { monthly: 10 } }),
  );
  const agent = await w.hire('Vera', 'builder', 'junior', { model: 'claude-sonnet-4-5', capacity: 1 });
  await q(
    `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, cost_usd_micros, ended_at)
     VALUES ($1,$2,$3,$4,'card','sonnet',2000000,'2026-10-05T10:00:00Z')`,
    [randomUUID(), orgId, agent.agent?.id ?? agent.id, w.projectId],
  );
});
afterAll(async () => {
  ctx().clock.setOffset(0);
  await w.t.close();
  await closeAdminPool();
});

describe('schedule helpers', () => {
  it('finds Monday 08:00 in the zone and the ISO week', () => {
    const jhb = lastBriefingDue(new Date('2026-10-14T12:00:00Z'), 'Africa/Johannesburg');
    expect(jhb).toEqual({ monday: '2026-10-12', due: new Date('2026-10-12T06:00:00Z') });
    expect(lastBriefingDue(new Date('2026-10-12T05:59:00Z'), 'Africa/Johannesburg').monday).toBe(
      '2026-10-05',
    );
    // New York is on summer time (UTC-4) in October
    expect(lastBriefingDue(new Date('2026-10-12T12:30:00Z'), 'America/New_York').due).toEqual(
      new Date('2026-10-12T12:00:00Z'),
    );
    // Sunday evening in New York is still last week in Johannesburg's Monday
    expect(lastBriefingDue(new Date('2026-10-12T03:00:00Z'), 'America/New_York').monday).toBe('2026-10-05');
    expect(isoWeekOf('2026-10-12')).toBe('2026-W42');
    expect(isoWeekOf('2027-01-04')).toBe('2027-W01');
  });
});

describe('weekly briefing', () => {
  it('sends nothing before Monday 08:00 in the organization zone', async () => {
    setNow('2026-10-12T05:30:00Z'); // 07:30 in Johannesburg
    await weeklyBriefingTick(ctx());
    expect(mine()).toHaveLength(0);
    expect(await deliveries('2026-W42')).toHaveLength(0);
  });

  it('sends the long version to the manager and the short one to a member, never to someone who opted out', async () => {
    setNow('2026-10-12T06:10:00Z');
    await weeklyBriefingTick(ctx());
    expect(
      mine()
        .map((m) => m.to)
        .sort(),
    ).toEqual([w.owner.email, member.email].sort());
    expect(mail.to(optedOut.email)).toHaveLength(0);
    expect((await deliveries('2026-W42')).every((d) => d.state === 'sent')).toBe(true);

    const owner = mail.to(w.owner.email)[0];
    expect(owner?.subject).toMatch(/2 cards done, \d+ waiting on you, 1 blocked/);
    expect(owner?.text).toContain('DONE THIS WEEK: 2');
    expect(owner?.text).toContain('Approve the large merge');
    expect(owner?.text).toContain('Waiting on the API key');
    expect(owner?.text).toContain('Claude login expired on Desk');
    expect(owner?.text).toContain('VALUE SO FAR THIS MONTH');
    expect(owner?.text).toContain('Spend this month'.toUpperCase());
    expect(owner?.text).toMatch(/budget/i);
    expect(owner?.text).toContain('BY PROJECT');

    const m = mail.to(member.email)[0];
    expect(m?.text).toContain('DONE THIS WEEK: 2');
    expect(m?.text).not.toContain('SPEND THIS MONTH');
    expect(m?.text).not.toContain('VALUE SO FAR');
    expect(m?.text).not.toContain('Claude login expired');
  });

  it('is idempotent for the week, and mails again the next week', async () => {
    const before = mine().length;
    setNow('2026-10-12T20:00:00Z');
    await weeklyBriefingTick(ctx());
    await weeklyBriefingTick(ctx());
    expect(mine()).toHaveLength(before);
    // two days after Monday the window has closed
    setNow('2026-10-14T07:00:00Z');
    await weeklyBriefingTick(ctx());
    expect(mine()).toHaveLength(before);
    // next Monday
    setNow('2026-10-19T06:05:00Z');
    await weeklyBriefingTick(ctx());
    expect((await deliveries('2026-W43')).length).toBe(2);
    const rows = await q(`SELECT week FROM briefing_deliveries WHERE org_id=$1 GROUP BY week ORDER BY week`, [
      orgId,
    ]);
    expect(rows.map((x) => x.week)).toEqual(['2026-W42', '2026-W43']);
  });

  it('retries a failed send on the next tick, once, and records a quiet week as skipped', async () => {
    setNow('2026-10-26T06:05:00Z');
    mail.failFor.add(w.owner.email);
    await weeklyBriefingTick(ctx());
    expect((await deliveries('2026-W44')).filter((d) => d.state === 'failed')).toHaveLength(1);
    mail.failFor.clear();
    await weeklyBriefingTick(ctx());
    const states = await deliveries('2026-W44');
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.state !== 'failed')).toBe(true);
    const after = mine().length;
    await weeklyBriefingTick(ctx());
    expect(mine()).toHaveLength(after);
  });

  it('respects the switch in the environment', async () => {
    setNow('2026-11-02T06:05:00Z');
    ctx().config.weeklyBriefing = false;
    expect(await weeklyBriefingTick(ctx())).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(await deliveries('2026-W45')).toHaveLength(0);
    ctx().config.weeklyBriefing = true;
  });
});

describe('the preference', () => {
  it('defaults to on and can be switched off and on again by the person', async () => {
    setNow(new Date().toISOString());
    ctx().clock.setOffset(0);
    expect(
      (await ok<any>(w.t.req('GET', '/api/me/weekly-briefing', { cookie: member.cookie }))).enabled,
    ).toBe(true);
    expect(
      (
        await ok<any>(
          w.t.req('PUT', '/api/me/weekly-briefing', { cookie: member.cookie, body: { enabled: false } }),
        )
      ).enabled,
    ).toBe(false);
    expect(
      (await ok<any>(w.t.req('GET', '/api/me/weekly-briefing', { cookie: member.cookie }))).enabled,
    ).toBe(false);
    await ok(w.t.req('PUT', '/api/me/weekly-briefing', { cookie: member.cookie, body: { enabled: true } }));
    expect(
      (await ok<any>(w.t.req('GET', '/api/me/weekly-briefing', { cookie: member.cookie }))).enabled,
    ).toBe(true);
  });
});
