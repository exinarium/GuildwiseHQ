import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { RunnerConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox, holdAgentTmp, wipeAgent } from '../src/sandbox/sandbox.ts';
import { DEFAULT_SCRATCH_POLICY, pruneScratch, sweepAgentScratch } from '../src/sandbox/scratch.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';
const B = '019e3f6a-7b1c-7a2d-8c3e-0123456789c2';
const DAY = 86_400_000;

/** A 'copy of a repository' entry: a folder with a node_modules file of `bytes`, last touched `ageDays` ago. */
function entry(scratch: string, name: string, bytes: number, ageDays: number): void {
  const dir = join(scratch, name, 'node_modules');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'big.bin');
  writeFileSync(f, 'x'.repeat(bytes));
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(f, t, t);
  utimesSync(dir, t, t);
  utimesSync(join(scratch, name), t, t);
}

describe('scratch retention', () => {
  const wipe: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const w of wipe.splice(0)) await w();
  });
  const setup = async () => {
    const paths = runnerPaths(tmp());
    const a = await ensureSandbox(paths, A, 'A');
    const b = await ensureSandbox(paths, B, 'B');
    wipe.push(
      () => wipeAgent(paths, A),
      () => wipeAgent(paths, B),
    );
    return { paths, a, b };
  };
  const policy = { ...DEFAULT_SCRATCH_POLICY, maxBytes: 0 };

  it('defaults: 3 days, 10 GB, enabled', () => {
    const c = RunnerConfigSchema.parse({ serverUrl: 'http://x', workstationId: 'w', runnerToken: 't' });
    expect(c.scratch).toMatchObject({ enabled: true, maxAgeDays: 3, maxBytes: 10 * 1024 ** 3, keep: [] });
    expect(DEFAULT_SCRATCH_POLICY).toMatchObject({ maxAgeDays: 3, maxBytes: 10 * 1024 ** 3 });
  });

  it('removes entries older than maxAgeDays and keeps recent ones', async () => {
    const { a } = await setup();
    entry(a.scratch, 'p517-r6', 4000, 5);
    entry(a.scratch, 'rv2', 4000, 1);
    writeFileSync(join(a.scratch, 'old-note.md'), 'n');
    utimesSync(
      join(a.scratch, 'old-note.md'),
      new Date(Date.now() - 9 * DAY),
      new Date(Date.now() - 9 * DAY),
    );
    const r = await pruneScratch(a.scratch, policy, () => false);
    expect(r.pruned.map((p) => p.name).sort()).toEqual(['old-note.md', 'p517-r6']);
    expect(r.pruned.every((p) => p.reason === 'age')).toBe(true);
    expect(existsSync(join(a.scratch, 'rv2'))).toBe(true);
  });

  it('uses the newest file inside an entry, not the folder date', async () => {
    const { a } = await setup();
    entry(a.scratch, 'busy-copy', 100, 10);
    writeFileSync(join(a.scratch, 'busy-copy', 'node_modules', 'fresh.txt'), 'new');
    expect((await pruneScratch(a.scratch, policy, () => false)).pruned).toEqual([]);
  });

  it('enforces the cap by evicting the oldest first', async () => {
    const { a } = await setup();
    entry(a.scratch, 'oldest', 40_000, 2);
    entry(a.scratch, 'middle', 40_000, 1);
    entry(a.scratch, 'newest', 40_000, 0);
    // room for roughly two of the three entries
    const r = await pruneScratch(a.scratch, { ...policy, maxBytes: 120_000 }, () => false);
    expect(r.pruned.map((p) => [p.name, p.reason])).toEqual([['oldest', 'cap']]);
    expect(existsSync(join(a.scratch, 'newest'))).toBe(true);
    const r2 = await pruneScratch(a.scratch, { ...policy, maxBytes: 50_000 }, () => false);
    expect(r2.pruned.map((p) => p.name)).toEqual(['middle']);
    expect(r2.bytesLeft).toBeLessThanOrEqual(50_000 + 8192);
  });

  it('never prunes the allow-list', async () => {
    const { a } = await setup();
    entry(a.scratch, 'NOTES', 100, 30);
    entry(a.scratch, 'copy', 100, 30);
    const r = await pruneScratch(a.scratch, { ...policy, keep: ['NOTES'] }, () => false);
    expect(r.pruned.map((p) => p.name)).toEqual(['copy']);
    expect(existsSync(join(a.scratch, 'NOTES'))).toBe(true);
  });

  it('never follows symlinks', async () => {
    const { a } = await setup();
    const outside = tmp('outside-');
    writeFileSync(join(outside, 'precious.txt'), 'p'.repeat(100_000));
    symlinkSync(outside, join(a.scratch, 'link-old'));
    mkdirSync(join(a.scratch, 'd'));
    symlinkSync(outside, join(a.scratch, 'd', 'inner'));
    const old = new Date(Date.now() - 30 * DAY);
    utimesSync(join(a.scratch, 'd'), old, old);
    // the link's own date is what counts; a link target's size does not count towards the cap
    const r = await pruneScratch(
      a.scratch,
      { ...policy, maxBytes: 20_000 },
      () => false,
      Date.now() + 10 * DAY,
    );
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    expect(r.pruned.some((p) => p.bytes >= 100_000)).toBe(false);
    expect(existsSync(join(a.scratch, 'link-old'))).toBe(false);
  });

  it('refuses a scratch folder that is a symlink or not named scratch', async () => {
    const { a } = await setup();
    const real = tmp('real-');
    entry(real, 'x', 10, 30);
    const link = join(tmp(), 'scratch');
    symlinkSync(real, link);
    expect((await pruneScratch(link, policy, () => false)).skipped).toBeDefined();
    expect((await pruneScratch(real, policy, () => false)).skipped).toBe('not a scratch folder');
    expect(existsSync(join(real, 'x'))).toBe(true);
    expect((await pruneScratch(a.scratch, { ...policy, enabled: false }, () => false)).skipped).toBe(
      'disabled',
    );
  });

  it('does nothing while the agent has a shift or chat running', async () => {
    const { paths, a, b } = await setup();
    entry(a.scratch, 'old', 100, 30);
    entry(b.scratch, 'old', 100, 30);
    const release = holdAgentTmp(a);
    const logs: string[] = [];
    const r = await sweepAgentScratch(paths, policy, { log: (m) => logs.push(m) });
    expect(r.pruned).toBe(1);
    expect(existsSync(join(a.scratch, 'old'))).toBe(true);
    expect(existsSync(join(b.scratch, 'old'))).toBe(false);
    expect(logs.join('\n')).toContain(B);
    release();
    expect((await sweepAgentScratch(paths, policy)).pruned).toBe(1);
    expect(existsSync(join(a.scratch, 'old'))).toBe(false);
  });

  it('skips agents whose shift is about to resume', async () => {
    const { paths, a } = await setup();
    entry(a.scratch, 'old', 100, 30);
    expect((await sweepAgentScratch(paths, policy, { skipAgentIds: [A] })).pruned).toBe(0);
    expect(existsSync(join(a.scratch, 'old'))).toBe(true);
  });
});

describe('supervisor: scratch is pruned when the shift ends', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('removes an old build copy but not a fresh file written during the shift', async () => {
    let scratch = '';
    const adapter: RuntimeAdapter = {
      id: 'mock',
      capabilities: async () => ({ runtime: 'mock', version: 'x', available: true, capabilities: [] }),
      writeInstructions: async () => {},
      start: async (input): Promise<RuntimeSession> => {
        scratch = input.sandbox.scratch;
        entry(scratch, 'p517-r6', 5000, 9);
        writeFileSync(join(scratch, 'risk.md'), 'r');
        return {
          events: () =>
            (async function* () {
              yield { kind: 'exit', code: 0 } as RuntimeEvent;
            })(),
          stop: async () => {},
          usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        };
      },
    };
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, stage: 'review' });
    h.server.send('shift.start', msg);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(scratch, 'p517-r6'))).toBe(false);
    expect(existsSync(join(scratch, 'risk.md'))).toBe(true);
    await wipeAgent(runnerPaths(h.dataDir), (msg as { agent: { agentId: string } }).agent.agentId);
  });
});
