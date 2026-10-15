import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, REPO_SSH, until, type World } from './helpers/world.ts';

// Backlog #76: the owner sets how many shifts a workstation runs at once (a number or unlimited) on the Workstations page.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const ctxConfig = () => w.t.app.ctx.config as { maxShiftsPerWorkstation: number };
const shifts = async () =>
  (await ok<any>(w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }))).workstations.find(
    (x: any) => x.id === w.workstationId,
  ).shifts;
const put = (limit: unknown, status = 200, cookie = w.owner.cookie) =>
  w.t
    .req('PUT', `/api/workstations/${w.workstationId}/shift-limit`, { cookie, body: { limit } })
    .then(async (r) => {
      expect(r.status).toBe(status);
      return r.body as any;
    });
const connect = async (o: { maxConcurrentShifts?: number; capabilities?: string[] } = {}) => {
  const r = await w.connectRunner({ hello: false });
  r.hello({
    repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main' }],
    runtimes: MOCK_RUNTIME,
    maxConcurrentShifts: o.maxConcurrentShifts ?? 4,
    ...(o.capabilities ? { capabilities: o.capabilities } : {}),
  });
  const welcome = await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
  return { r, welcome };
};
const hangUp = async (r: FakeRunner) => {
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner offline');
};

describe('the shift limit of a workstation', () => {
  it('is the runner value until the owner sets one', async () => {
    const { r, welcome } = await connect();
    expect(welcome.limits).toMatchObject({ maxConcurrentShifts: 4, shiftLimit: null });
    expect(await shifts()).toMatchObject({
      running: 0,
      limit: 4,
      setting: null,
      unlimited: false,
      platformCap: 16,
      runnerLimit: 4,
    });
    await hangUp(r);
  });

  it('a number is stored (event sourced), applies live, and reaches a runner that can apply it', async () => {
    const { r } = await connect({ capabilities: ['shift-limit:1'] });
    const from = r.received.length;
    const dto = await put(3);
    expect(dto.shifts).toMatchObject({ setting: 3, limit: 3, unlimited: false, supported: true });
    const cmd = await r.waitFor('command', (f) => f.command === 'shifts.limit', 5000, from);
    expect(cmd.payload).toEqual({ shiftLimit: 3, maxConcurrentShifts: 3 });
    expect(w.t.app.ctx.services.runners.get(w.workstationId)?.maxShifts).toBe(3);
    expect(
      (
        await q(`SELECT payload FROM events WHERE type='WorkstationShiftLimitSet' ORDER BY seq DESC LIMIT 1`)
      )[0]?.payload,
    ).toMatchObject({ workstationId: w.workstationId, limit: 3 });
    await hangUp(r);

    // the setting survives a reconnect and wins over what the runner reports from its config
    const again = await connect({ maxConcurrentShifts: 8, capabilities: ['shift-limit:1'] });
    expect(again.welcome.limits).toMatchObject({ maxConcurrentShifts: 3, shiftLimit: 3 });
    await hangUp(again.r);
    // offline the explicit setting is still shown
    expect(await shifts()).toMatchObject({ setting: 3, limit: 3 });
  });

  it('a runner that cannot apply it is not sent the command, and the page knows', async () => {
    const { r } = await connect(); // no shift-limit:1
    const from = r.received.length;
    const dto = await put(2);
    expect(dto.shifts).toMatchObject({ setting: 2, limit: 2, supported: false });
    await new Promise((res) => setTimeout(res, 150));
    expect(r.received.slice(from).some((f) => f.type === 'command' && f.command === 'shifts.limit')).toBe(
      false,
    );
    await hangUp(r);
  });

  it('the platform cap stays the ceiling: a higher number and unlimited are held to it', async () => {
    const { r, welcome } = await connect({ capabilities: ['shift-limit:1'] });
    expect(welcome.limits.maxConcurrentShifts).toBe(2);
    const high = await put(50);
    expect(high.shifts).toMatchObject({ setting: 50, limit: 16, platformCap: 16, unlimited: false });
    const unlimited = await put('unlimited');
    expect(unlimited.shifts).toMatchObject({
      setting: 'unlimited',
      limit: 16,
      platformCap: 16,
      unlimited: false,
    });
    await hangUp(r);
  });

  it('with no platform cap, unlimited is really unlimited', async () => {
    ctxConfig().maxShiftsPerWorkstation = 0;
    try {
      const { r, welcome } = await connect({ capabilities: ['shift-limit:1'] });
      expect(welcome.limits.shiftLimit).toBe('unlimited');
      expect(welcome.limits.maxConcurrentShifts).toBeGreaterThanOrEqual(100_000);
      expect(await shifts()).toMatchObject({
        setting: 'unlimited',
        limit: null,
        unlimited: true,
        platformCap: null,
      });
      await hangUp(r);
    } finally {
      ctxConfig().maxShiftsPerWorkstation = 16;
    }
  });

  it('null goes back to the runner value; bad values and strangers are refused', async () => {
    const { r } = await connect({ maxConcurrentShifts: 5, capabilities: ['shift-limit:1'] });
    const dto = await put(null);
    expect(dto.shifts).toMatchObject({ setting: null, limit: 5, runnerLimit: 5 });
    await put(0, 400);
    await put(1.5, 400);
    await put('lots', 400);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    await put(2, 404, stranger.cookie);
    await hangUp(r);
  });
});

describe('the dispatcher and the shift limit', () => {
  const starts = (r: FakeRunner, from = 0) => r.received.slice(from).filter((f) => f.type === 'shift.start');

  it('offers no more card shifts than the limit, and offers more once it is raised or unlimited', async () => {
    await q(
      'TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents CASCADE',
    );
    await q('UPDATE projects SET next_card_number = 1');
    for (const n of ['Una', 'Vic', 'Wes', 'Xan']) await w.hire(n, 'builder', 'junior');
    for (let i = 0; i < 4; i++) await w.card();
    const { r } = await connect({ capabilities: ['shift-limit:1'] });
    await put(1);
    await w.t.app.ctx.services.dispatcher.run();
    await until(async () => starts(r).length >= 1, 3000, 'first shift');
    await new Promise((res) => setTimeout(res, 200));
    expect(starts(r)).toHaveLength(1);

    // raising to 3 lets two more start (the first still runs)
    await put(3);
    await w.t.app.ctx.services.dispatcher.run();
    await until(async () => starts(r).length >= 3, 3000, 'three shifts');
    await new Promise((res) => setTimeout(res, 200));
    expect(starts(r)).toHaveLength(3);

    // unlimited (no platform cap): the fourth starts too
    ctxConfig().maxShiftsPerWorkstation = 0;
    try {
      await put('unlimited');
      await w.t.app.ctx.services.dispatcher.run();
      await until(async () => starts(r).length >= 4, 3000, 'four shifts');
    } finally {
      ctxConfig().maxShiftsPerWorkstation = 16;
    }
    await hangUp(r);
  });
});
