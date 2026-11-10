import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { runnerPaths } from '../src/paths.ts';
import {
  agentTmpDir,
  agentTmpRoot,
  cleanAgentTmp,
  ensureSandbox,
  holdAgentTmp,
  removeOrphanAgentTmps,
  sweepAgentTmps,
  TMP_OWNER_FILE,
  wipeAgent,
} from '../src/sandbox/sandbox.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const B = '019e3f6a-7b1c-7a2d-8c3e-0123456789b2';

/** The entries of an agent temp dir, without its owner file. */
const kept = (dir: string): string[] => readdirSync(dir).filter((n) => n !== TMP_OWNER_FILE);

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
    expect(kept(a.tmp)).toEqual(['node-compile-cache']);
    expect(existsSync(join(a.tmp, TMP_OWNER_FILE))).toBe(true);
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
    expect(kept(a.tmp)).toEqual(['node-compile-cache']);
    expect(existsSync(join(b.tmp, 'risk.md'))).toBe(true);
    expect(existsSync(join(other.tmp, 'risk.md'))).toBe(true);
  });

  it('sweeping a runner with no agents dir is a no-op', async () => {
    expect(await sweepAgentTmps(runnerPaths(tmp()))).toEqual({ agents: 0, removed: 0 });
  });

  it('the agent TMPDIR is a short /tmp path (unix socket limit); scratch stays on disk', async () => {
    const { paths, a } = await setup();
    expect(a.tmp).toBe(agentTmpDir(paths, A));
    // under the agent temp root (`/tmp` in production, pinned by agent-tmp-root.test.ts; the test run's own root here)
    if (process.platform !== 'win32') {
      expect(dirname(a.tmp)).toBe(agentTmpRoot());
      expect(basename(a.tmp)).toMatch(/^aom-[0-9a-f]{10}$/);
    }
    expect(a.scratch.startsWith(paths.root)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('temp dirs of agents that no longer exist', () => {
  // the sweep lists the whole agent temp root: each test gets a root of its own
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.AOM_AGENT_TMP_ROOT;
    process.env.AOM_AGENT_TMP_ROOT = tmp('aom-orphans-');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AOM_AGENT_TMP_ROOT;
    else process.env.AOM_AGENT_TMP_ROOT = saved;
  });

  it('ensureSandbox writes the owner file through a rename, never through what the agent left there', async () => {
    const paths = runnerPaths(tmp());
    const a = await ensureSandbox(paths, A, 'A');
    const owner = join(a.tmp, TMP_OWNER_FILE);
    expect(JSON.parse(readFileSync(owner, 'utf8'))).toEqual({ agents: paths.agents, agentId: A });
    const outside = join(tmp('outside-'), 'precious.txt');
    writeFileSync(outside, 'p');
    rmSync(owner);
    symlinkSync(outside, owner);
    await ensureSandbox(paths, A, 'A');
    expect(readFileSync(outside, 'utf8')).toBe('p');
    expect(lstatSync(owner).isFile()).toBe(true);
    expect(readdirSync(a.tmp).filter((n) => n.startsWith(TMP_OWNER_FILE))).toEqual([TMP_OWNER_FILE]);
  });

  it("runner start removes the temp dirs of this runner's agents that no longer exist, and nothing else", async () => {
    const root = agentTmpRoot();
    const paths = runnerPaths(tmp());
    const gone = async (p: typeof paths, id: string) => {
      const sb = await ensureSandbox(p, id, id);
      fill(sb.tmp);
      rmSync(p.agentDir(id), { recursive: true, force: true });
      return sb.tmp;
    };
    const live = (await ensureSandbox(paths, A, 'A')).tmp;
    const removed = await gone(paths, B);
    // another runner's agent that no longer exists
    const otherRunner = await gone(runnerPaths(tmp()), '019e3f6a-7b1c-7a2d-8c3e-0123456789c3');
    // a forged owner file naming this runner and a gone agent, in a dir that is not that agent's
    const forged = join(root, 'aom-ffffffffff');
    mkdirSync(forged);
    writeFileSync(
      join(forged, TMP_OWNER_FILE),
      JSON.stringify({ agents: paths.agents, agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4' }),
    );
    // a dir without an owner file (made before this release, or not by a runner)
    const unowned = join(root, 'aom-0123456789');
    mkdirSync(unowned);
    writeFileSync(join(unowned, 'x'), 'x');
    // gone, but a shift or chat of this process still holds it
    const heldId = '019e3f6a-7b1c-7a2d-8c3e-0123456789e5';
    const held = await gone(paths, heldId);
    const release = holdAgentTmp({ tmp: held });
    // gone, but its shift is about to be resumed
    const skipId = '019e3f6a-7b1c-7a2d-8c3e-0123456789f6';
    const skipped = await gone(paths, skipId);
    // gone, but the owner file is a FIFO (an agent cannot make the sweep block)
    const fifo = await gone(paths, '019e3f6a-7b1c-7a2d-8c3e-0123456789a7');
    rmSync(join(fifo, TMP_OWNER_FILE));
    execFileSync('mkfifo', [join(fifo, TMP_OWNER_FILE)]);
    // gone, but its name is a symlink to the real dir
    const linked = await gone(paths, '019e3f6a-7b1c-7a2d-8c3e-0123456789b8');
    const moved = join(tmp('moved-'), 'real');
    renameSync(linked, moved);
    symlinkSync(moved, linked);

    try {
      expect(await removeOrphanAgentTmps(paths, [skipId])).toBe(1);
    } finally {
      release();
    }
    expect(existsSync(removed)).toBe(false);
    for (const d of [live, otherRunner, forged, unowned, held, skipped, fifo, linked])
      expect(existsSync(d), d).toBe(true);
    expect(existsSync(join(moved, 'risk.md'))).toBe(true);
    // released, the held one goes at the next start; the resumed one once it is no longer skipped
    expect(await removeOrphanAgentTmps(paths)).toBe(2);
    expect(existsSync(held)).toBe(false);
    expect(existsSync(skipped)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('is a no-op when the temp root does not exist', async () => {
    process.env.AOM_AGENT_TMP_ROOT = join(tmp(), 'missing');
    expect(await removeOrphanAgentTmps(runnerPaths(tmp()))).toBe(0);
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
    expect(kept(tmpDir)).toEqual(['node-compile-cache']);
    await wipeAgent(runnerPaths(h.dataDir), (msg as { agent: { agentId: string } }).agent.agentId);
  });
});
