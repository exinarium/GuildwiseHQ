import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Runner } from '../src/runner.ts';
import { loadServerLimit } from '../src/shifts/server-limit.ts';
import { busyDetail, capacityOf } from '../src/shifts/supervisor.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeConfig, tmp, waitUntil } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

// Backlog #76: the shift limit the owner sets on the Workstations page. The runner applies it live, keeps it across
// restarts, and falls back to config.json's maxConcurrentShifts when the owner chose nothing or the server is older.

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const limitFile = (dir: string) => join(dir, 'server-limits.json');
const sendLimit = async (shiftLimit: unknown, max: number) => {
  const commandId = `cmd-${Math.random().toString(36).slice(2)}`;
  h!.server.send('command', {
    commandId,
    command: 'shifts.limit',
    payload: { shiftLimit, maxConcurrentShifts: max },
  });
  return h!.server.waitFor('command.result', (m) => m.commandId === commandId);
};

describe('regression #76: shift limit of the runner', () => {
  it('announces that it can apply the owner setting', async () => {
    h = await startHarness();
    expect(h.server.of('hello')[0]?.capabilities).toContain('shift-limit:1');
  });

  it('an older server that sends no setting: the configured value under what the server allows', async () => {
    h = await startHarness({ maxConcurrentShifts: 16 }); // config default is 4
    expect(h.runner.shiftLimit()).toBe(4);
    expect(existsSync(limitFile(h.dataDir))).toBe(false);
  });

  it('the owner setting replaces the configured value, even above it, and is saved', async () => {
    h = await startHarness({ maxConcurrentShifts: 12, shiftLimit: 12 });
    expect(h.runner.shiftLimit()).toBe(12);
    expect(loadServerLimit(limitFile(h.dataDir))).toMatchObject({ shiftLimit: 12, maxConcurrentShifts: 12 });
  });

  it('unlimited is the count the server sends (no cap of its own)', async () => {
    h = await startHarness({ maxConcurrentShifts: 100_000, shiftLimit: 'unlimited' });
    expect(h.runner.shiftLimit()).toBe(100_000);
    expect(JSON.parse(readFileSync(limitFile(h.dataDir), 'utf8')).shiftLimit).toBe('unlimited');
  });

  it('no choice (null) clears a saved one and goes back to the configured value', async () => {
    h = await startHarness({ maxConcurrentShifts: 12, shiftLimit: 12 });
    expect(existsSync(limitFile(h.dataDir))).toBe(true);
    const res = await sendLimit(null, 9);
    expect(res.ok).toBe(true);
    expect(h.runner.shiftLimit()).toBe(4); // min(9, config 4)
    expect(existsSync(limitFile(h.dataDir))).toBe(false);
  });

  it('a command applies live without a restart and survives one', async () => {
    h = await startHarness();
    expect(h.runner.shiftLimit()).toBe(4);
    const res = await sendLimit(20, 20);
    expect(res).toMatchObject({ ok: true, result: { maxConcurrentShifts: 20 } });
    expect(h.runner.shiftLimit()).toBe(20);
    // a restarted runner starts with the saved value, before the server has said anything
    const again = new Runner({ config: makeConfig(h.server.url, { repoRoots: [] }), dataDir: h.dataDir });
    expect(again.shiftLimit()).toBe(20);
  });

  it('a bad command is refused and changes nothing', async () => {
    h = await startHarness();
    const res = await sendLimit('lots', 5);
    expect(res.ok).toBe(false);
    expect(h.runner.shiftLimit()).toBe(4);
  });

  it('the supervisor enforces the live value: busy at the limit, accepted once it is raised', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = new ScriptedAdapter(async () => {
      await gate;
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await sendLimit(1, 1);
    const first = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, ref: 'TOY-1', title: 'one' });
    h.server.send('shift.start', first);
    await h.server.waitFor('shift.started');
    const second = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, ref: 'TOY-2', title: 'two' });
    h.server.send('shift.start', second);
    expect((await h.server.waitFor('shift.rejected', (m) => m.shiftId === second.shiftId)).reason).toBe(
      'busy',
    );

    await sendLimit(2, 2);
    const third = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, ref: 'TOY-3', title: 'three' });
    h.server.send('shift.start', third);
    await h.server.waitFor('shift.started', (m) => m.shiftId === third.shiftId);
    release();
    await waitUntil(
      () => h!.server.of('shift.ended').some((m) => m.shiftId === third.shiftId),
      30_000,
      'third shift ended',
    );
  });
});

// GWP-95: the workstation setting on the server is the one source of truth; the runner reports what it enforces.
describe('GWP-95: the server setting decides, the runner reports what it enforces', () => {
  const gated = () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    return { adapter: new ScriptedAdapter(async () => void (await gate)), release: () => release() };
  };

  it('announces that it reports its limit (shift-limit:2)', async () => {
    h = await startHarness();
    expect(h.server.of('hello')[0]?.capabilities).toContain('shift-limit:2');
  });

  it('(a) config 4 + Unlimited: the platform cap applies and a 5th and 6th card shift start without a restart', async () => {
    const g = gated();
    h = await startHarness(
      { maxConcurrentShifts: 16, shiftLimit: 'unlimited' },
      { adapters: new Map([['mock', g.adapter]]) },
    );
    expect(h.runner.effectiveShiftLimit()).toEqual({ max: 16, source: 'platform_cap' });
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const s = makeShiftStart({
        remoteNormalized: h.repo.remoteNormalized,
        ref: `TOY-${i}`,
        title: `n${i}`,
      });
      ids.push(s.shiftId as string);
      h.server.send('shift.start', s);
    }
    await waitUntil(
      () => ids.every((id) => h!.server.of('shift.started').some((m) => m.shiftId === id)),
      30_000,
      'six shifts started',
    );
    expect(h.server.of('shift.rejected')).toHaveLength(0);
    expect(h.runner.shiftLoad()).toEqual({ runningShifts: 6, maxShifts: 16, limitSource: 'platform_cap' });
    g.release();
    await waitUntil(() => h!.server.of('shift.ended').length >= 6, 60_000, 'shifts ended');
  }, 90_000);

  it('(a) Unlimited without a platform cap is no limit at all', async () => {
    h = await startHarness({ maxConcurrentShifts: 100_000, shiftLimit: 'unlimited' });
    expect(h.runner.effectiveShiftLimit()).toEqual({ max: 100_000, source: 'workstation_setting' });
  });

  it('(b) config 4 + a server setting of 6: 6, from the workstation setting', async () => {
    h = await startHarness({ maxConcurrentShifts: 6, shiftLimit: 6 });
    expect(h.runner.effectiveShiftLimit()).toEqual({ max: 6, source: 'workstation_setting' });
  });

  it('"Runner\'s own value" (null) is config.json under the server value, source runner config', async () => {
    h = await startHarness({ maxConcurrentShifts: 16, shiftLimit: null });
    expect(h.runner.effectiveShiftLimit()).toEqual({ max: 4, source: 'runner_config' });
  });

  it('(c) before the server has answered: the saved server value, else config.json, as the local fallback', async () => {
    h = await startHarness({ maxConcurrentShifts: 9, shiftLimit: 9 });
    const saved = new Runner({ config: makeConfig(h.server.url, { repoRoots: [] }), dataDir: h.dataDir });
    expect(saved.effectiveShiftLimit()).toEqual({ max: 9, source: 'local_fallback' });
    const fresh = new Runner({
      config: makeConfig(h.server.url, { repoRoots: [] }),
      dataDir: tmp('aom-data-'),
    });
    expect(fresh.effectiveShiftLimit()).toEqual({ max: 4, source: 'local_fallback' });
  });

  it('(c) after a restart the welcome wins over the local value', async () => {
    h = await startHarness({ maxConcurrentShifts: 7, shiftLimit: 7 });
    await h.runner.stop();
    const again = new Runner({ config: makeConfig(h.server.url, { repoRoots: [] }), dataDir: h.dataDir });
    await again.start();
    try {
      await waitUntil(() => h!.server.helloCount > 1 && again.client.isReady, 10_000, 'reconnected');
      expect(again.effectiveShiftLimit()).toEqual({ max: 7, source: 'workstation_setting' });
    } finally {
      await again.stop();
    }
  });

  it('the source the server sends is used as is', async () => {
    h = await startHarness();
    const commandId = 'cmd-source';
    h.server.send('command', {
      commandId,
      command: 'shifts.limit',
      payload: { shiftLimit: 30, maxConcurrentShifts: 16, source: 'platform_cap' },
    });
    const res = await h.server.waitFor('command.result', (m) => m.commandId === commandId);
    expect(res).toMatchObject({ ok: true, result: { maxConcurrentShifts: 16, source: 'platform_cap' } });
    expect(h.runner.effectiveShiftLimit()).toEqual({ max: 16, source: 'platform_cap' });
  });

  it('(d)+(e) a lowered limit stops nothing; the next start is busy with the limit, its source and the holders', async () => {
    const g = gated();
    h = await startHarness({}, { adapters: new Map([['mock', g.adapter]]) });
    await sendLimit(3, 3);
    const a = makeShiftStart({
      remoteNormalized: h.repo.remoteNormalized,
      ref: 'TOY-1',
      title: 'a',
      agentName: 'Ada',
    });
    const b = makeShiftStart({
      remoteNormalized: h.repo.remoteNormalized,
      ref: 'TOY-2',
      title: 'b',
      agentName: 'Ken',
    });
    h.server.send('shift.start', a);
    h.server.send('shift.start', b);
    await waitUntil(() => h!.server.of('shift.started').length >= 2, 30_000, 'two started');
    await sendLimit(1, 1);
    const c = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, ref: 'TOY-3', title: 'c' });
    h.server.send('shift.start', c);
    const rej = await h.server.waitFor('shift.rejected', (m) => m.shiftId === c.shiftId);
    expect(rej.reason).toBe('busy');
    expect(rej.capacity).toMatchObject({ limit: 1, source: 'workstation_setting', running: 2 });
    expect(rej.capacity?.holders.map((x) => [x.cardRef, x.agentName]).sort()).toEqual([
      ['TOY-1', 'Ada'],
      ['TOY-2', 'Ken'],
    ]);
    expect(rej.detail).toContain('(limit 1), source: workstation setting');
    expect(rej.detail).toContain('TOY-1 (Ada)');
    // nothing that was running was stopped
    expect(h.server.of('shift.ended')).toHaveLength(0);
    expect(h.runner.supervisor.slotCount).toBe(2);
    g.release();
    await waitUntil(() => h!.server.of('shift.ended').length >= 2, 60_000, 'shifts ended');
  }, 90_000);

  it('(f) the CEO shift takes no slot; the heartbeat reports the slot count and the limit in force', async () => {
    h = await startHarness({ maxConcurrentShifts: 5, shiftLimit: 5 });
    const active = (h.runner.supervisor as unknown as { active: Map<string, { msg: { kind: string } }> })
      .active;
    active.set('x-card', { msg: { kind: 'card' } });
    active.set('x-ceo', { msg: { kind: 'ceo' } });
    try {
      expect(h.runner.supervisor.size).toBe(2);
      expect(h.runner.supervisor.slotCount).toBe(1);
      expect(h.runner.shiftLoad()).toEqual({
        runningShifts: 1,
        maxShifts: 5,
        limitSource: 'workstation_setting',
      });
    } finally {
      active.clear();
    }
  });
});

describe('GWP-95: busy rejection text', () => {
  it('names the limit, its source and the holders; no limit reads as none', () => {
    const capacity = capacityOf({ max: 4, source: 'pairing_budget' }, [
      {
        msg: {
          shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
          kind: 'card',
          brief: { card: { ref: 'GWP-94' } } as never,
          agent: { name: 'Ada' } as never,
        },
      },
      {
        msg: {
          shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
          kind: 'devops',
          brief: { card: { ref: 'DEVOPS' } } as never,
          agent: { name: 'Anvil' } as never,
        },
      },
    ]);
    expect(capacity.holders[1]).toEqual({
      shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
      kind: 'devops',
      agentName: 'Anvil',
    });
    expect(busyDetail(capacity)).toBe(
      '2 shifts already running (limit 4), source: shared with other pairings; held by GWP-94 (Ada), devops (Anvil)',
    );
    expect(busyDetail({ ...capacity, limit: 100_000, source: 'workstation_setting' })).toContain(
      '(limit none), source: workstation setting',
    );
  });
});
