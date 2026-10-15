import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { runnerPaths } from '../src/paths.ts';
import {
  agentTmpDir,
  cleanAgentTmp,
  ensureSandbox,
  holdAgentTmp,
  sweepAgentTmps,
  wipeAgent,
} from '../src/sandbox/sandbox.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const B = '019e3f6a-7b1c-7a2d-8c3e-0123456789b2';

const fill = (dir: string): void => {
  mkdirSync(join(dir, 'claude-1000', 'review'), { recursive: true });
  writeFileSync(join(dir, 'claude-1000', 'review', 'big.bin'), 'x'.repeat(1000));
  mkdirSync(join(dir, 'cc-socks'), { recursive: true });
  mkdirSync(join(dir, 'card-attachments'), { recursive: true });
  mkdirSync(join(dir, 'node-compile-cache'), { recursive: true });
  writeFileSync(join(dir, 'node-compile-cache', 'keep'), 'k');
  writeFileSync(join(dir, 'risk.md'), 'r');
};

describe('agent temp cleanup (backlog #81)', () => {
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

  it('removes the per-shift content, keeps the compile cache and another agent dir', async () => {
    const { a, b } = await setup();
    fill(a.tmp);
    fill(b.tmp);
    expect(await cleanAgentTmp(a.tmp)).toBeGreaterThan(0);
    expect(readdirSync(a.tmp)).toEqual(['node-compile-cache']);
    expect(existsSync(join(b.tmp, 'claude-1000', 'review', 'big.bin'))).toBe(true);
    expect(existsSync(a.tmp)).toBe(true);
  });

  it('does nothing while a shift or chat holds the dir', async () => {
    const { a } = await setup();
    fill(a.tmp);
    const release = holdAgentTmp(a);
    const release2 = holdAgentTmp(a);
    expect(await cleanAgentTmp(a.tmp)).toBe(0);
    release();
    expect(await cleanAgentTmp(a.tmp)).toBe(0);
    release2();
    release2(); // idempotent
    expect(await cleanAgentTmp(a.tmp)).toBeGreaterThan(0);
  });

  it('never follows a symlink out of the temp dir', async () => {
    const { a } = await setup();
    const outside = tmp('outside-');
    writeFileSync(join(outside, 'precious.txt'), 'p');
    symlinkSync(outside, join(a.tmp, 'link'));
    mkdirSync(join(a.tmp, 'd'));
    symlinkSync(outside, join(a.tmp, 'd', 'link2'));
    await cleanAgentTmp(a.tmp);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    expect(existsSync(join(a.tmp, 'link'))).toBe(false);
    expect(existsSync(join(a.tmp, 'd'))).toBe(false);
  });

  it('refuses a temp dir that is itself a symlink or has an unexpected name', async () => {
    const outside = tmp('outside-');
    writeFileSync(join(outside, 'precious.txt'), 'p');
    const holder = tmp('holder-');
    symlinkSync(outside, join(holder, 'aom-link'));
    expect(await cleanAgentTmp(join(holder, 'aom-link'))).toBe(0);
    expect(await cleanAgentTmp(outside)).toBe(0); // not named aom-* or tmp
    expect(await cleanAgentTmp('/tmp')).toBe(0);
    expect(await cleanAgentTmp('/')).toBe(0);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });

  it('startup sweep cleans the runner agents, skips resumed ones, leaves another runner dirs', async () => {
    const { paths, a, b } = await setup();
    const otherPaths = runnerPaths(tmp());
    const other = await ensureSandbox(otherPaths, A, 'A'); // another runner's agent with the same id
    wipe.push(() => wipeAgent(otherPaths, A));
    fill(a.tmp);
    fill(b.tmp);
    fill(other.tmp);
    const r = await sweepAgentTmps(paths, [B]);
    expect(r.agents).toBe(1);
    expect(readdirSync(a.tmp)).toEqual(['node-compile-cache']);
    expect(existsSync(join(b.tmp, 'risk.md'))).toBe(true);
    expect(existsSync(join(other.tmp, 'risk.md'))).toBe(true);
  });

  it('sweeping a runner with no agents dir is a no-op', async () => {
    expect(await sweepAgentTmps(runnerPaths(tmp()))).toEqual({ agents: 0, removed: 0 });
  });

  it('the agent TMPDIR is a short /tmp path (unix socket limit); scratch stays on disk', async () => {
    const { paths, a } = await setup();
    expect(a.tmp).toBe(agentTmpDir(paths, A));
    if (process.platform !== 'win32') expect(a.tmp).toMatch(/^\/tmp\/aom-[0-9a-f]{10}$/);
    expect(a.scratch.startsWith(paths.root)).toBe(true);
  });
});

describe('supervisor: the temp dir is emptied when the shift ends', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it.each([
    ['clean exit', 0],
    ['crash', 1],
  ])('after a %s', async (_n, code) => {
    let tmpDir = '';
    const adapter: RuntimeAdapter = {
      id: 'mock',
      capabilities: async () => ({ runtime: 'mock', version: 'x', available: true, capabilities: [] }),
      writeInstructions: async () => {},
      start: async (input): Promise<RuntimeSession> => {
        tmpDir = input.sandbox.tmp;
        fill(tmpDir);
        return {
          events: () =>
            (async function* () {
              yield { kind: 'exit', code } as RuntimeEvent;
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
    expect(tmpDir).not.toBe('');
    expect(readdirSync(tmpDir)).toEqual(['node-compile-cache']);
    await wipeAgent(runnerPaths(h.dataDir), (msg as { agent: { agentId: string } }).agent.agentId);
  });
});
