import { describe, expect, it } from 'vitest';
import { descendants, killToolProcesses, type ProcReader, toolProcesses } from '../src/adapters/proc-tree.ts';
import { spawnSession } from '../src/adapters/process-session.ts';

const table: Record<number, { ppid: number; comm: string }> = {
  10: { ppid: 1, comm: 'claude' },
  11: { ppid: 10, comm: 'bwrap' },
  12: { ppid: 11, comm: 'bash' },
  13: { ppid: 12, comm: 'dotnet' },
  14: { ppid: 13, comm: 'testhost' },
  15: { ppid: 10, comm: 'socat' },
  16: { ppid: 10, comm: 'node' },
  20: { ppid: 1, comm: 'bash' },
};
const fake: ProcReader = {
  pids: () => Object.keys(table).map(Number),
  stat: (p) => table[p],
};

describe('proc tree', () => {
  it('walks descendants', () => {
    expect(descendants(11, fake).sort()).toEqual([12, 13, 14]);
  });
  it('selects only shell children of the agent and everything below, not socat or MCP servers', () => {
    expect(toolProcesses(10, fake).sort()).toEqual([11, 12, 13, 14]);
  });
  it('signals them with SIGTERM, then SIGKILL for survivors', async () => {
    const sent: Array<[number, string]> = [];
    const n = await killToolProcesses(10, {
      proc: fake,
      graceMs: 1,
      kill: (p, s) => {
        sent.push([p, s]);
        return true;
      },
    });
    expect(n).toBe(4);
    expect(sent.filter(([, s]) => s === 'SIGTERM')).toHaveLength(4);
    expect(sent.filter(([, s]) => s === 'SIGKILL')).toHaveLength(4); // the fake table never loses them
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const usage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

describe.skipIf(process.platform === 'win32')('process session', () => {
  it('stop SIGKILLs the whole process group when the child ignores SIGTERM', async () => {
    const s = spawnSession({
      bin: '/bin/sh',
      args: ['-c', "trap '' TERM; sleep 300 & echo $!; wait"],
      cwd: '/',
      env: { PATH: process.env.PATH ?? '' },
      parseLine: (l) => [{ kind: 'progress', text: l }],
      usage,
      killAfterMs: 300,
    });
    let grandchild = 0;
    for await (const e of s.events()) {
      if (e.kind === 'progress' && !grandchild) {
        grandchild = Number(e.text);
        void s.stop('test');
      }
    }
    expect(grandchild).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('killTools stops a running shell command and leaves the agent running', async () => {
    const s = spawnSession({
      bin: '/bin/sh',
      args: ['-c', "bash -c 'sleep 300; true'; echo tool-died:$?; sleep 1"],
      cwd: '/',
      env: { PATH: process.env.PATH ?? '' },
      parseLine: (l) => [{ kind: 'progress', text: l }],
      usage,
    });
    await new Promise((r) => setTimeout(r, 500));
    const n = await (s.killTools?.() ?? Promise.resolve(0));
    expect(n).toBeGreaterThan(0);
    const texts: string[] = [];
    for await (const e of s.events()) if (e.kind === 'progress') texts.push(e.text);
    expect(texts.join()).toMatch(/tool-died:(143|137)/);
  });
});
