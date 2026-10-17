import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAuthMonitor } from '../src/adapters/claude-auth.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { holdWorktree } from '../src/adapters/sandbox-placeholders.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { sandboxFor } from '../src/sandbox/sandbox.ts';
import { transcriptFile } from '../src/sessions/registry.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const AGENT = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const outcome = (outcomeId: string, note = 'n', data: Record<string, unknown> = {}) => ({
  report: { kind: 'outcome', outcomeId, note, data },
});

async function start(
  script: ConstructorParameters<typeof ScriptedAdapter>[0],
  runnerOpts: Parameters<typeof startHarness>[1] = {},
) {
  const adapter = new ScriptedAdapter(script);
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]), ...runnerOpts });
  return { adapter, h };
}

/** Sends a shift.start and returns its id without waiting for the end. */
function send(extra: Parameters<typeof makeShiftStart>[0] extends infer O ? Partial<O> : never = {}) {
  const msg = makeShiftStart({
    agentId: AGENT,
    stage: 'build',
    ...extra,
    remoteNormalized: (h as Harness).repo.remoteNormalized,
  });
  (h as Harness).server.send('shift.start', msg);
  return msg.shiftId as string;
}

describe('runtime_session_id is recorded (it was empty for all 4,752 shifts)', () => {
  it('sends the session id and the context size as a late update, after shift.started', async () => {
    await start(async (_i, ctl) => {
      ctl.setContextTokens(41_000);
      ctl.emit({ kind: 'session', runtimeSessionId: 'sess-abc' });
      await sleep(100);
    });
    const { shiftId, ended } = await h!.runShift({ stage: 'build' });
    const frames = h!.server.received.filter(
      (m) => (m.type === 'shift.started' || m.type === 'shift.session') && m.shiftId === shiftId,
    );
    expect(frames.map((f) => f.type)).toEqual(['shift.started', 'shift.session']);
    expect(frames[1]).toMatchObject({ runtimeSessionId: 'sess-abc', contextTokens: 41_000 });
    // the context size at the end of the shift rides on shift.ended
    expect(ended.contextTokens).toBe(41_000);
  });

  it('reports a growing context while the shift runs', async () => {
    await start(
      async (_i, ctl) => {
        ctl.setContextTokens(10_000);
        ctl.emit({ kind: 'session', runtimeSessionId: 'sess-grow' });
        await sleep(150);
        ctl.setContextTokens(90_000);
        await sleep(400);
      },
      { supervisorOverrides: { contextReportMs: 100 } },
    );
    const { shiftId } = await h!.runShift({ stage: 'build' });
    const sizes = h!.server
      .of('shift.session')
      .filter((m) => m.shiftId === shiftId)
      .map((m) => m.contextTokens);
    expect(sizes).toContain(10_000);
    expect(sizes).toContain(90_000);
  });
});

describe('resume of an earlier session', () => {
  const NOW = Date.now();
  const rec = (over: Record<string, unknown>) => ({
    sessionId: 'old-1',
    agentId: AGENT,
    cwd: '/somewhere/else/TOY-0',
    startedAt: new Date(NOW - 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
    contextTokens: 50_000,
    ...over,
  });
  const configDirOf = () => sandboxFor(runnerPaths(h!.dataDir), AGENT).configDir;
  const writeRegistry = (records: unknown[]) =>
    writeFileSync(join(h!.dataDir, 'sessions.json'), JSON.stringify({ sessions: records }));
  const putTranscript = (sessionId: string, cwd: string) => {
    const f = transcriptFile(configDirOf(), cwd, sessionId);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '{"type":"user"}\n');
  };
  const runResume = async (sessionId: string) => {
    const shiftId = send({ startExtra: { resumeSessionId: sessionId } });
    const ended = await h!.server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 30_000);
    return { shiftId, ended };
  };
  const script = async (_i: unknown, ctl: { emit: (e: never) => void }) => {
    ctl.emit({ kind: 'session', runtimeSessionId: 'new-session' } as never);
    await sleep(50);
  };

  it('resumes a small, recent session of the same agent and copies its transcript into the new worktree folder', async () => {
    const { adapter } = await start(script as never);
    writeRegistry([rec({})]);
    putTranscript('old-1', '/somewhere/else/TOY-0');
    const { shiftId } = await runResume('old-1');
    const input = adapter.inputs[0]!;
    expect(input.resumeSessionId).toBe('old-1');
    expect(existsSync(transcriptFile(configDirOf(), input.cwd, 'old-1'))).toBe(true);
    const upd = h!.server.of('shift.session').find((m) => m.shiftId === shiftId);
    expect(upd?.resume).toMatchObject({ state: 'resumed' });
  });

  it.each([
    ['too large (over 120K context tokens)', { contextTokens: 130_000 }, 'fresh_too_large'],
    ['too old (over 4 hours)', { startedAt: new Date(NOW - 5 * 60 * 60_000).toISOString() }, 'fresh_too_old'],
    ['another agent', { agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b2' }, 'fresh_other_agent'],
  ])('starts fresh and says why: %s', async (_name, over, state) => {
    const { adapter } = await start(script as never);
    writeRegistry([rec(over)]);
    putTranscript('old-1', '/somewhere/else/TOY-0');
    const { shiftId } = await runResume('old-1');
    expect(adapter.inputs[0]!.resumeSessionId).toBeUndefined();
    const upd = h!.server.of('shift.session').find((m) => m.shiftId === shiftId);
    expect(upd?.resume?.state).toBe(state);
    expect(upd?.resume?.detail).toBeTruthy();
  });

  it('starts fresh for a session this workstation never saw, or whose transcript is gone', async () => {
    const { adapter } = await start(script as never);
    writeRegistry([rec({ sessionId: 'gone-1' })]);
    const a = await runResume('unknown-9');
    const b = await runResume('gone-1');
    expect(adapter.inputs.every((i) => i.resumeSessionId === undefined)).toBe(true);
    const states = h!.server
      .of('shift.session')
      .filter((m) => m.shiftId === a.shiftId || m.shiftId === b.shiftId)
      .map((m) => m.resume?.state);
    expect(states).toEqual(['fresh_unknown_session', 'fresh_transcript_missing']);
  });

  it('a session the shift starts is remembered, so the next shift can resume it', async () => {
    const { adapter } = await start(script as never);
    const first = await h!.runShift({ stage: 'build', agentId: AGENT });
    expect(first.ended.outcome).toBe('no_report');
    putTranscript('new-session', adapter.inputs[0]!.cwd);
    const { shiftId } = await runResume('new-session');
    expect(adapter.inputs[1]!.resumeSessionId).toBe('new-session');
    expect(h!.server.of('shift.session').find((m) => m.shiftId === shiftId)?.resume?.state).toBe('resumed');
  });
});

describe('sandbox stubs', () => {
  it('are removed at the end of a shift when no other shift uses the worktree', async () => {
    let wt = '';
    await start(async (i) => {
      wt = i.cwd;
      writeFileSync(join(wt, '.gitmodules'), '');
    });
    await h!.runShift({ stage: 'build' });
    expect(existsSync(join(wt, '.gitmodules'))).toBe(false);
  });

  it('stay while another shift still works in the same worktree (and stay empty)', async () => {
    let wt = '';
    let release = () => {};
    await start(async (i) => {
      wt = i.cwd;
      writeFileSync(join(wt, '.gitmodules'), '');
      release = holdWorktree(wt, 'another-shift');
    });
    await h!.runShift({ stage: 'build' });
    expect(existsSync(join(wt, '.gitmodules'))).toBe(true);
    expect(sh(wt, 'git', ['status', '--porcelain', '--untracked-files=all'])).toContain('.gitmodules');
    expect(sh(wt, 'wc', ['-c', '.gitmodules']).trim().startsWith('0')).toBe(true);
    release();
  });
});

describe('disk check before a shift (#81)', () => {
  it('refuses with a disk_full reason when /tmp is full, and starts nothing', async () => {
    const { adapter } = await start(async () => {}, {
      supervisorOverrides: { diskFree: (p) => (p.includes('/tmp') || p === '/tmp' ? 1024 : 50 * 1024 ** 3) },
    });
    const shiftId = send();
    const rej = await h!.server.waitFor('shift.rejected', (m) => m.shiftId === shiftId, 15_000);
    expect(rej.reason).toBe('worktree_failed');
    expect(rej.detail).toMatch(/^disk_full: .*\/tmp has 0 MB free/);
    expect(adapter.inputs).toHaveLength(0);
    expect(h!.server.of('shift.accepted').filter((m) => m.shiftId === shiftId)).toHaveLength(0);
  });

  it('a DevOps shift is not held back by it (it is the one who frees the space)', async () => {
    const { diskProblem } = await import('../src/health/disk.ts');
    expect(diskProblem('/data', { free: () => 10, tmpDir: '/tmp' })).toMatch(/^disk_full:/);
    expect(diskProblem('/data', { free: () => 50 * 1024 ** 3, tmpDir: '/tmp' })).toBeNull();
    expect(
      diskProblem('/data', {
        free: () => {
          throw new Error('no statfs');
        },
      }),
    ).toBeNull();
  });
});

describe('worktree left on a conflict branch (P5-27)', () => {
  async function buildThenSwitch() {
    const { adapter } = await start(async () => {});
    await h!.runShift({ stage: 'build' });
    const wt = worktreeOf(h!);
    const cardBranch = sh(wt, 'git', ['branch', '--show-current']);
    sh(wt, 'git', ['checkout', '-b', 'conflict/TOY-1-a1']);
    return { adapter, wt, cardBranch };
  }

  it('is switched back to the card branch when it is clean and has nothing of its own', async () => {
    const { adapter, wt, cardBranch } = await buildThenSwitch();
    const { shiftId, ended } = await h!.runShift({ stage: 'review' });
    expect(ended.outcome).toBe('no_report');
    expect(adapter.inputs).toHaveLength(2);
    expect(sh(wt, 'git', ['branch', '--show-current'])).toBe(cardBranch);
    const notes = h!.server
      .of('shift.progress')
      .filter((m) => m.shiftId === shiftId)
      .flatMap((m) => m.items.map((i) => i.text));
    expect(notes.join('\n')).toMatch(/switched back to/);
  });

  it('is left alone and the shift refused when the worktree has uncommitted changes', async () => {
    const { adapter, wt } = await buildThenSwitch();
    writeFileSync(join(wt, 'resolution.txt'), 'half a conflict resolution\n');
    const shiftId = send({ stage: 'review' });
    const rej = await h!.server.waitFor('shift.rejected', (m) => m.shiftId === shiftId, 20_000);
    expect(rej.reason).toBe('worktree_failed');
    expect(rej.detail).toMatch(/conflict\/TOY-1-a1.*uncommitted changes/);
    expect(adapter.inputs).toHaveLength(1);
    expect(sh(wt, 'git', ['branch', '--show-current'])).toBe('conflict/TOY-1-a1');
    expect(existsSync(join(wt, 'resolution.txt'))).toBe(true);
  });

  it('is left alone and the shift refused when the conflict branch is ahead (a resolution that was not merged back)', async () => {
    const { wt } = await buildThenSwitch();
    writeFileSync(join(wt, 'resolved.txt'), 'resolved\n');
    sh(wt, 'git', ['add', '-A']);
    sh(wt, 'git', ['commit', '-m', 'resolve the conflict']);
    const shiftId = send({ stage: 'review' });
    const rej = await h!.server.waitFor('shift.rejected', (m) => m.shiftId === shiftId, 20_000);
    expect(rej.reason).toBe('worktree_failed');
    expect(rej.detail).toMatch(/1 commit\(s\) that .* does not/);
    expect(sh(wt, 'git', ['branch', '--show-current'])).toBe('conflict/TOY-1-a1');
  });
});

describe('grace before the process is killed once the claim is released', () => {
  it('lets Claude write its result line, so the real usage is recorded and the shift counts as reported', async () => {
    await start(
      async (_i, ctl) => {
        await ctl.post('/v1/report', outcome('handoff', 'done'));
        await sleep(500); // Claude is still finishing its last turn
        ctl.setUsage({ inputTokens: 900, outputTokens: 100 });
        return { finalText: 'done' };
      },
      { supervisorOverrides: { claimLostGraceMs: 5_000 } },
    );
    const shiftId = send();
    await h!.server.waitFor('shift.report', (m) => m.shiftId === shiftId, 20_000);
    h!.server.send('shift.stop', { shiftId, reason: 'claim_lost' });
    const ended = await h!.server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 20_000);
    expect(ended.outcome).toBe('reported');
    expect(ended.usage).toMatchObject({ inputTokens: 900, outputTokens: 100 });
  });

  it('still stops a process that does not finish within the grace', async () => {
    await start(
      async (_i, ctl) => {
        await ctl.post('/v1/report', outcome('handoff', 'done'));
        await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
      },
      { supervisorOverrides: { claimLostGraceMs: 300 } },
    );
    const shiftId = send();
    await h!.server.waitFor('shift.report', (m) => m.shiftId === shiftId, 20_000);
    const t0 = Date.now();
    h!.server.send('shift.stop', { shiftId, reason: 'claim_lost' });
    const ended = await h!.server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 20_000);
    expect(ended.outcome).toBe('reported');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('a claim lost before any report still stops at once and is not "reported"', async () => {
    await start(async (_i, ctl) => {
      await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
    });
    const shiftId = send();
    await h!.server.waitFor('shift.started', (m) => m.shiftId === shiftId, 20_000);
    h!.server.send('shift.stop', { shiftId, reason: 'claim_lost' });
    const ended = await h!.server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 20_000);
    expect(ended.outcome).toBe('stopped');
  });
});

describe('login expiry is caught before the shift starts', () => {
  it('puts the shift back with auth_expired and never runs the agent', async () => {
    const { adapter } = await start(async () => {});
    adapter.checkLogin = async () => 'expired';
    const shiftId = send();
    const rej = await h!.server.waitFor('shift.rejected', (m) => m.shiftId === shiftId, 15_000);
    expect(rej.reason).toBe('auth_expired');
    expect(adapter.inputs).toHaveLength(0);
  });

  it('a login that is fine (or cannot be told) lets the shift run', async () => {
    const { adapter } = await start(async () => {});
    adapter.checkLogin = async () => 'unknown';
    const { ended } = await h!.runShift({ stage: 'build' });
    expect(ended.outcome).toBe('no_report');
    expect(adapter.inputs).toHaveLength(1);
  });
});

describe('ClaudeCodeAdapter.checkLogin', () => {
  const creds = (expiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'A', refreshToken: 'R', expiresAt } });
  const setup = (expiresAt: number, probe: () => Promise<'ok' | 'expired' | 'unknown'>) => {
    const t = tmp();
    const home = join(t, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), creds(expiresAt));
    const auth = new ClaudeAuthMonitor();
    const paths = runnerPaths(join(t, 'data'));
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({}), paths, { auth, home, probe });
    return { adapter, auth };
  };
  const withSmoke = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.AOM_CLAUDE_SMOKE;
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.AOM_CLAUDE_SMOKE;
      else process.env.AOM_CLAUDE_SMOKE = prev;
    }
  };

  it('does not call Claude while the token is good for more than 10 minutes', () =>
    withSmoke(async () => {
      let probes = 0;
      const { adapter } = setup(Date.now() + 3_600_000, async () => {
        probes++;
        return 'ok';
      });
      expect(await adapter.checkLogin()).toBe('ok');
      expect(probes).toBe(0);
    }));

  it('probes once when the token is about to expire, and says expired when the probe does', () =>
    withSmoke(async () => {
      let probes = 0;
      const { adapter, auth } = setup(Date.now() + 60_000, async () => {
        probes++;
        return 'expired';
      });
      expect(await adapter.checkLogin()).toBe('expired');
      expect(probes).toBe(1);
      expect(auth.state).toBe('expired');
    }));

  it('a token that is already past is refreshed by the probe', () =>
    withSmoke(async () => {
      const { adapter, auth } = setup(Date.now() - 1000, async () => 'ok');
      expect(await adapter.checkLogin()).toBe('ok');
      expect(auth.state).toBe('ok');
    }));

  it('an unreachable network is "unknown" (not expired): the shift goes ahead', () =>
    withSmoke(async () => {
      const { adapter } = setup(Date.now() - 1000, async () => 'unknown');
      expect(await adapter.checkLogin()).toBe('unknown');
    }));

  it('an already expired runtime stays expired without another call', () =>
    withSmoke(async () => {
      let probes = 0;
      const { adapter, auth } = setup(Date.now() + 3_600_000, async () => {
        probes++;
        return 'ok';
      });
      auth.markExpired();
      expect(await adapter.checkLogin()).toBe('expired');
      expect(probes).toBe(0);
    }));
});

describe('prompt cache, shell timeout and kind of shift reach the agent', () => {
  it('card shifts get the long shell timeout input; QA steps, questions-like short kinds get the 5 minute cache', async () => {
    const { adapter } = await start(async () => {});
    await h!.runShift({ stage: 'build' });
    await h!.runShift({
      stage: 'test',
      ref: 'TOY-2',
      briefExtra: {
        shift: { ...(makeShiftStart({ remoteNormalized: 'x' }).brief as any).shift, stage: 'qa_steps' },
      },
    });
    expect(adapter.inputs[0]).toMatchObject({ kind: 'card' });
    expect(adapter.inputs[0]!.promptCacheTtl).toBeUndefined();
    expect(adapter.inputs[1]!.promptCacheTtl).toBe('5m');
  });

  it('the instructions file ends with who the agent is', async () => {
    const { adapter } = await start(async () => {});
    await h!.runShift({ stage: 'build', agentName: 'Ada' });
    const md = adapter.instructions[0]!;
    expect(md.trimEnd()).toMatch(/# Who you are\n\nYou are Ada, a senior Builder[^#]*$/);
    expect(md.indexOf('# Role instructions')).toBeLessThan(md.indexOf('# Who you are'));
    expect(md.indexOf('# Boundaries')).toBeLessThan(md.indexOf('# How to report'));
    // the runner-side environment help is stable text: it comes before the stage-specific outcomes
    expect(md.indexOf('# Environment help')).toBeLessThan(md.indexOf('# How to report'));
  });
});

describe('piped aom', () => {
  it('no instruction or prompt the runner renders tells the agent to pipe aom', async () => {
    const prompts: string[] = [];
    const { adapter } = await start(async (i) => {
      prompts.push(i.prompt);
    });
    await h!.runShift({ stage: 'build' });
    await h!.runShift({ stage: 'review' });
    const text = [...prompts, ...adapter.instructions].join('\n');
    expect(text).toMatch(/no pipes, redirects/);
    // an example that pipes aom (`aom ... | head`) appears only as the thing NOT to do
    const lines = text.split('\n').filter((l) => /`aom [^`\n]*\|[^`\n]*`/.test(l));
    for (const l of lines) expect(l).toMatch(/not|never|no pipes/i);
  });
});

describe('crashed shifts report what they spent', () => {
  it('sends the usage of a shift whose process crashed', async () => {
    await start(async (_i, ctl) => {
      ctl.setUsage({ inputTokens: 5000, outputTokens: 300, cacheReadTokens: 40_000 });
      return { exitCode: 1, finalText: 'boom' };
    });
    const { ended } = await h!.runShift({ stage: 'build' });
    expect(ended.outcome).toBe('crashed');
    expect(ended.usage).toMatchObject({ inputTokens: 5000, outputTokens: 300, cacheReadTokens: 40_000 });
  });
});
