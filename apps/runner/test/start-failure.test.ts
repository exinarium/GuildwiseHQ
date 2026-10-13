import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeCommand, ClaudeCodeAdapter, MAX_ARGV_PROMPT_BYTES } from '../src/adapters/claude-code.ts';
import { spawnSession } from '../src/adapters/process-session.ts';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import type { Logger } from '../src/log.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
if (!reviewer) throw new Error('roles');
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
// well over the 128 KiB a single argument may have on Linux (a card with a long history renders a prompt like it)
const HUGE = `# P4-3\n${'handoff note of an earlier round. '.repeat(6000)}\n`;

const drain = async (s: RuntimeSession): Promise<RuntimeEvent[]> => {
  const out: RuntimeEvent[] = [];
  for await (const e of s.events()) out.push(e);
  return out;
};

describe('a prompt too big for argv (reviewer shifts of a card with a long history crashed at start, E2BIG)', () => {
  it('without the fix the spawn fails with no exit code: reported as a start failure, not a crash', async () => {
    expect(HUGE.length).toBeGreaterThan(131072);
    const ev = await drain(
      spawnSession({
        bin: '/bin/true',
        args: ['-p', HUGE],
        cwd: tmp(),
        env: {},
        parseLine: () => [],
        usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      }),
    );
    const exit = ev.at(-1);
    expect(exit).toMatchObject({ kind: 'exit', code: null, startFailed: true });
    // the reason, not the command line (which would repeat the whole prompt)
    expect((exit as { error: string }).error).toMatch(/E2BIG/);
    expect((exit as { error: string }).error.length).toBeLessThan(300);
  });

  it('a process that ran and failed is not a start failure', async () => {
    const ev = await drain(
      spawnSession({
        bin: '/bin/sh',
        args: ['-c', 'exit 3'],
        cwd: tmp(),
        env: {},
        parseLine: () => [],
        usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      }),
    );
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 3 });
    expect(ev.at(-1)).not.toHaveProperty('startFailed');
  });

  it('buildClaudeCommand keeps a small prompt in argv and sends a big one on stdin', () => {
    const base = {
      shiftId: 's1',
      instructionsMarkdown: '',
      cwd: '/data/worktrees/P4/P4-3',
      sandbox: { home: '/d/a/home', configDir: '/d/a/claude', scratch: '/d/a/scratch', tmp: '/d/a/tmp' },
      agent: { model: 'sonnet', roleKey: 'reviewer', permissions: reviewer.permissions, isDevops: false },
      env: {},
      addDirs: ['/d/vault'],
      maxShiftMinutes: 5,
    };
    const cfg = ClaudeRuntimeConfigSchema.parse({});
    const small = buildClaudeCommand({ ...base, prompt: 'hello' } as never, cfg);
    expect(small.args.slice(0, 2)).toEqual(['-p', 'hello']);
    expect(small.stdin).toBeUndefined();
    const big = buildClaudeCommand({ ...base, prompt: HUGE } as never, cfg);
    expect(big.stdin).toBe(HUGE);
    expect(big.args.some((a) => a.length > MAX_ARGV_PROMPT_BYTES)).toBe(false);
    expect(big.args[0]).toBe('-p');
    expect(big.args[1]).toBe('--output-format');
  });

  it('the Claude adapter starts a reviewer shift with a huge prompt (fake claude reads it from stdin)', async () => {
    const t = tmp();
    const received = join(t, 'received.txt');
    const bin = join(t, 'fakeclaude');
    writeFileSync(bin, `#!/bin/sh\nwc -c > ${received}\necho '{"type":"system"}'\nexit 0\n`);
    chmodSync(bin, 0o755);
    const cwd = join(t, 'data', 'worktrees', 'P4-98eeafb0', 'P4-3');
    mkdirSync(cwd, { recursive: true });
    const paths = runnerPaths(join(t, 'data'));
    const sandbox = await ensureSandbox(paths, A, 'Rev');
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }), paths);
    const prev = process.env.AOM_CLAUDE_SMOKE;
    process.env.AOM_CLAUDE_SMOKE = '1'; // lets the adapter spawn the fake binary under vitest
    try {
      const session = await adapter.start({
        shiftId: 'zz',
        prompt: HUGE,
        instructionsMarkdown: '',
        cwd,
        sandbox,
        addDirs: [],
        env: {},
        maxShiftMinutes: 5,
        agent: {
          agentId: A,
          name: 'Rev',
          roleKey: 'reviewer',
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'sonnet',
          skills: [],
          permissions: reviewer.permissions,
          isDevops: false,
        },
      } as never);
      const exit = (await drain(session)).at(-1);
      expect(exit).toMatchObject({ kind: 'exit', code: 0 });
      expect(existsSync(received)).toBe(true);
      expect(Number(readFileSync(received, 'utf8').trim())).toBe(Buffer.byteLength(HUGE));
    } finally {
      if (prev === undefined) delete process.env.AOM_CLAUDE_SMOKE;
      else process.env.AOM_CLAUDE_SMOKE = prev;
    }
  });
});

describe('supervisor: a shift whose runtime cannot start', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  const adapterOf = (start: () => Promise<RuntimeSession>): RuntimeAdapter => ({
    id: 'mock',
    capabilities: async () => ({ runtime: 'mock', version: 'x', available: true, capabilities: [] }),
    writeInstructions: async () => {},
    start,
  });
  const capture = () => {
    const lines: { msg: string; extra?: unknown }[] = [];
    const log: Logger = {
      info() {},
      warn() {},
      error: (msg, extra) => lines.push({ msg, extra }),
    };
    return { lines, log };
  };

  it('start() throwing: logged with the stack, rejected with "Shift could not start", never a crashed outcome', async () => {
    const { lines, log } = capture();
    const adapter = adapterOf(async () => {
      throw new Error('EACCES: cannot write settings.json');
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]), log });
    const msg = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, stage: 'review' });
    h.server.send('shift.start', msg);
    const rej = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId);
    expect(rej.reason).toBe('internal');
    expect(rej.detail).toBe('Shift could not start: EACCES: cannot write settings.json');
    expect(h.server.of('shift.ended').filter((m) => m.shiftId === msg.shiftId)).toHaveLength(0);
    const logged = lines.find((l) => l.msg.includes('could not start'));
    expect(logged?.msg).toContain(msg.shiftId as string);
    expect((logged?.extra as Error | undefined)?.stack).toContain('EACCES');
  });

  it('the process failing to spawn (exit.startFailed) is handled the same way', async () => {
    const { lines, log } = capture();
    const adapter = adapterOf(async () => ({
      events: () =>
        (async function* () {
          yield { kind: 'exit', code: null, startFailed: true, error: 'spawn E2BIG' } as RuntimeEvent;
        })(),
      stop: async () => {},
      usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    }));
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]), log });
    const msg = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, stage: 'review' });
    h.server.send('shift.start', msg);
    const rej = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId);
    expect(rej).toMatchObject({ reason: 'internal', detail: 'Shift could not start: spawn E2BIG' });
    expect(h.server.of('shift.ended').filter((m) => m.shiftId === msg.shiftId)).toHaveLength(0);
    expect(lines.some((l) => l.msg.includes('could not start') && l.msg.includes('spawn E2BIG'))).toBe(true);
  });
});
