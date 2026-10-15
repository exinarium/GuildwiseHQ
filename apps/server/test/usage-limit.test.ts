import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, until, type World } from './helpers/world.ts';

/**
 * Backlog #73: the model subscription's usage limit. The runner reports the Claude runtime `limited` until a time; the
 * dispatcher skips the workstation until then, the shift it was running is put back without penalty (no back-off, not a
 * failed shift for the loop breaker), the project says "Paused until ...", and one desk notice (and one e-mail) is
 * raised and closed by the system when work can resume.
 */
let w: World;
let r: FakeRunner;
const mail = new CaptureMailer();
const CLAUDE = { id: 'claude-code', version: '2.1.299', available: true, capabilities: ['shell'] };

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  (w.t.app.ctx as { mailer: unknown }).mailer = mail;
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const h = () => shiftHelpers(w);
const items = (status = 'open') =>
  q(
    `SELECT id, org_id, title, body, status, kind FROM desk_items WHERE subkind='claude_usage_limit' AND status=$1`,
    [status],
  );
const hours = (n: number) => new Date(w.t.clock.now().getTime() + n * 3_600_000).toISOString();
const reportClaude = async (claude: Record<string, unknown>) => {
  r.send('runtimes.report', { runtimes: [MOCK_RUNTIME[0], { ...CLAUDE, ...claude }] });
  await r.barrier();
};
const projectDto = async () =>
  (await w.t.req('GET', '/api/projects', { cookie: w.owner.cookie })).body.projects.find(
    (p: any) => p.id === w.projectId,
  );
const LIMITED = (until: string) => ({
  available: false,
  usage: 'limited',
  limitedUntil: until,
  limitedLabel: '18:00 (Africa/Johannesburg)',
});

describe('a hit usage limit', () => {
  it('puts the shift back without penalty, pauses the project and raises one notice and one e-mail', async () => {
    await freshState();
    await q(`TRUNCATE desk_items, card_blockers CASCADE`);
    await reportClaude({});
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    const card = await w.card({ title: 'Hits the limit' });
    const start = await h().dispatchTo(r, 'Ada', r.received.length);
    await h().startShift(r, start);

    const resets = hours(5);
    await reportClaude(LIMITED(resets));
    r.send('shift.rejected', {
      shiftId: start.shiftId,
      reason: 'usage_limited',
      detail: '18:00 (Africa/Johannesburg)',
      limitedUntil: resets,
    });
    await until(
      async () => (await q('SELECT claim_id FROM cards WHERE id=$1', [card.id]))[0]?.claim_id === null,
      3000,
      'claim released',
    );

    // no penalty: queued, no back-off, no failure count; the shift is "rejected", which the loop breaker and digests ignore
    const c = (await q('SELECT status, retry_after, retry_failures FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(c.status).toBe('queued');
    expect(c.retry_after).toBeNull();
    expect(Number(c.retry_failures ?? 0)).toBe(0);
    expect((await q('SELECT outcome FROM shifts WHERE id=$1', [start.shiftId]))[0]?.outcome).toBe('rejected');
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='loop_backoff'`)).toHaveLength(0);

    // the card note
    const msg = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [card.id]);
    expect(msg.map((m) => m.body).join('\n')).toContain(
      'Paused: the model usage limit resets at 18:00 (Africa/Johannesburg)',
    );

    // nothing is dispatched while it lasts
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    expect(await w.t.app.ctx.services.dispatcher.run()).toEqual([]);

    // the project says so, with the workstation
    const p = await projectDto();
    expect(p.usageLimit).toMatchObject({ until: resets, label: '18:00 (Africa/Johannesburg)' });
    expect(p.usageLimit.workstationName).toBeTruthy();

    // one notice for the owner (info for the CEO), one e-mail, the workstation page shows it
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe('alert');
    expect(open[0]?.title).toMatch(/Claude usage limit reached on /);
    expect(open[0]?.body).toContain('work resumes at 18:00 (Africa/Johannesburg)');
    expect(mail.sent).toHaveLength(1);
    const ws = (await w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie })).body.workstations[0];
    expect(ws.runtimes.find((x: any) => x.id === 'claude-code')).toMatchObject({
      usage: 'limited',
      limitedUntil: resets,
    });

    // the same report again changes nothing
    await reportClaude(LIMITED(resets));
    expect(await items()).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('the dispatcher skips the runtime until the time passes, even when it still looks available', async () => {
    // a runner (or an older report) that says "available" but limited for 2 more hours
    await reportClaude({ available: true, usage: 'limited', limitedUntil: hours(2) });
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    expect(await w.t.app.ctx.services.dispatcher.run()).toEqual([]);

    // the time has passed: dispatching resumes without waiting for a report
    w.t.clock.advance(3 * 3_600_000);
    await q('UPDATE workstations SET last_seen_at=$1', [w.t.clock.now()]); // still online
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    const made = await w.t.app.ctx.services.dispatcher.run();
    expect(made.length).toBeGreaterThan(0);
    expect((await projectDto()).usageLimit ?? null).toBeNull();
  });

  it('recovery closes the notice and the project is no longer paused', async () => {
    await reportClaude({ available: true, usage: 'ok' });
    await until(async () => (await items()).length === 0, 3000, 'notice closed');
    const [closed] = await q(
      `SELECT status, answer_option FROM desk_items WHERE subkind='claude_usage_limit' ORDER BY created_at DESC`,
    );
    expect(closed).toMatchObject({ status: 'answered', answer_option: 'acknowledged' });
    expect((await projectDto()).usageLimit ?? null).toBeNull();
  });

  it('wakes the CEO as information, not as an incident', async () => {
    const wakes = await q(`SELECT reason, urgency FROM ceo_wakes WHERE reason LIKE '%claude_usage_limit%'`);
    for (const x of wakes) {
      expect(x.reason).toBe('info:claude_usage_limit');
      expect(x.urgency).toBe('normal');
    }
  });
});
