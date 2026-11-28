import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repeatsApprovedCommands } from '../src/commands/devops.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * gate-fixes-3 (d), AC4: the Desk list carries the data of the "Allow once / Always allow" buttons (the Desk showed only
 * Approve), and a repeat of an already approved command never becomes a new Desk item (the loop of UAT deploy 6).
 */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const post = <T = any>(url: string, body: unknown = {}, status = 200) =>
  ok<T>(w.t.req('POST', url, { cookie: w.owner.cookie, body }), status);
const statusOf = async (id: string) =>
  (await q('SELECT status FROM devops_requests WHERE id=$1', [id]))[0]?.status as string;

async function runningShift(match: (f: any) => boolean, from: number) {
  await dispatcher().run();
  const start = await r.waitFor('shift.start', (f) => f.kind === 'devops' && match(f), 5000, from);
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
  );
  return start;
}

async function report(shiftId: string, data: Record<string, unknown>) {
  const { reportId } = r.report(shiftId, {
    kind: 'outcome',
    outcomeId: 'devops_approval',
    note: 'needs approval',
    data,
  });
  return r.waitFor('shift.report.result', (f) => f.reportId === reportId);
}

const CMD = 'mkdir -p /home/u/.local/share/guildwise/toolchains/devops/jq/1.7';

describe('gate-fixes-3 (d): the Desk list carries the Allow once / Always allow data', () => {
  it('requestId, exactCommand, allowOnce, allowAlways and alwaysPath reach GET /api/desk', async () => {
    const created = await post(
      '/api/devops/requests',
      { workstationId: w.workstationId, summary: 'install jq' },
      201,
    );
    const id = created.request.id as string;
    const start = await runningShift((f) => f.devops?.requestId === id, r.received.length);
    const res = await report(start.shiftId, {
      action: 'write the tool folder',
      reason: 'install jq',
      commands: [CMD],
      blockedBy: 'allowedPaths',
      alwaysPath: '/home/u/.local/share/guildwise/toolchains/devops/jq',
    });
    expect(res.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    await until(async () => (await statusOf(id)) === 'needs_approval');
    const ap = (await q('SELECT approval FROM devops_requests WHERE id=$1', [id]))[0]!.approval;
    const desk = await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
    const list = (desk.items ?? desk) as Array<{ id: string; data?: Record<string, unknown> }>;
    expect(list.find((i) => i.id === ap.deskItemId)?.data).toMatchObject({
      devopsSwitch: 'allowedPaths',
      requestId: id,
      exactCommand: CMD,
      allowOnce: true,
      allowAlways: true,
      alwaysPath: '/home/u/.local/share/guildwise/toolchains/devops/jq',
    });

    // AC4: Allow once; the next shift asks again for exactly that command (an older runner drops `blockedBy`)
    await post(`/api/devops/requests/${id}/resolve`, { resolution: 'approved', scope: 'once' });
    const resumed = await runningShift(
      (f) => f.devops?.requestId === id && !!f.devops?.approval,
      r.received.length,
    );
    expect(resumed.devops?.approval?.commands).toEqual([CMD]);
    const items = async () =>
      (await q(`SELECT count(*)::int AS n FROM events WHERE type='DeskItemCreated'`))[0]?.n as number;
    const before = await items();
    const repeat = await report(resumed.shiftId, {
      action: 'Allow writing to the toolchains folder',
      reason: 'install jq',
      commands: [`  ${CMD} `],
    });
    expect(repeat.accepted).toBe(false);
    expect(String(repeat.error ?? repeat.message)).toContain('already approved');
    expect(await items()).toBe(before);
    expect(await statusOf(id)).not.toBe('needs_approval');
    // a new command next to it is a real ask (N1)
    const mixed = await report(resumed.shiftId, {
      action: 'write the tool folder and a link',
      reason: 'install jq',
      commands: [CMD, 'ln -s /x /home/u/.local/bin/jq'],
    });
    expect(mixed.accepted).toBe(true);
    r.ended(resumed.shiftId, 'reported');
  });
});

describe('gate-fixes-3 (AC4): repeatsApprovedCommands', () => {
  it('only when every command is approved in a resolved approval', () => {
    const ap = { resolution: 'approved', commands: ['a  b', 'c'] };
    expect(repeatsApprovedCommands(ap, ['a b'])).toBe(true);
    expect(repeatsApprovedCommands(ap, ['a b', 'c'])).toBe(true);
    expect(repeatsApprovedCommands(ap, ['a b', 'd'])).toBe(false);
    expect(repeatsApprovedCommands(ap, [])).toBe(false);
    expect(repeatsApprovedCommands({ ...ap, resolution: null }, ['a b'])).toBe(false);
    expect(repeatsApprovedCommands(null, ['a b'])).toBe(false);
  });
});

describe('gate-fixes-3 REVIEW S-1: a command over the limit is never shown cut next to Allow once', () => {
  it('exactCommand is left out of the Desk list when longer than 8000 characters', async () => {
    const created = await post(
      '/api/devops/requests',
      { workstationId: w.workstationId, summary: 'write a long config' },
      201,
    );
    const id = created.request.id as string;
    const start = await runningShift((f) => f.devops?.requestId === id, r.received.length);
    const long = `echo ${'x'.repeat(8100)} > /srv/app/conf`;
    const res = await report(start.shiftId, {
      action: 'write the config',
      reason: 'needed',
      commands: [long],
      blockedBy: 'allowedPaths',
    });
    expect(res.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    await until(async () => (await statusOf(id)) === 'needs_approval');
    const ap = (await q('SELECT approval FROM devops_requests WHERE id=$1', [id]))[0]!.approval;
    const desk = await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
    const list = (desk.items ?? desk) as Array<{ id: string; data?: Record<string, unknown> }>;
    const data = list.find((i) => i.id === ap.deskItemId)?.data ?? {};
    expect(data).toMatchObject({ devopsSwitch: 'allowedPaths', requestId: id });
    expect(data.exactCommand).toBeUndefined();
  });
});
