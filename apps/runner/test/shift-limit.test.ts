import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Runner } from '../src/runner.ts';
import { loadServerLimit } from '../src/shifts/server-limit.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeConfig, waitUntil } from './helpers.ts';
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

describe('shift limit of the runner', () => {
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
