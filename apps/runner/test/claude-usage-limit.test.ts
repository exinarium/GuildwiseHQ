import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { ClaudeStreamParser } from '../src/adapters/claude-stream-parser.ts';
import {
  ClaudeUsageMonitor,
  detectUsageLimit,
  formatLimitTime,
  isUsageLimitText,
  parseResetTime,
  probeClaudeUsage,
} from '../src/adapters/claude-usage-limit.ts';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { Runner } from '../src/runner.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { FakeServer } from './fake-server.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeConfig, makeRepo, tmp, waitUntil } from './helpers.ts';

cleanupTmp();

const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const SESSION_LIMIT = "You've hit your session limit · resets 6pm (Africa/Johannesburg)";
const LIMIT_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: SESSION_LIMIT,
  usage: { input_tokens: 0, output_tokens: 0 },
});
// 2026-10-15 10:00 UTC = 12:00 in Johannesburg (UTC+2), 12:00 in a +2 runner zone
const NOW = new Date('2026-10-15T10:00:00Z');

describe('recognising a hit usage limit', () => {
  it('matches every message variant Claude Code gives', () => {
    for (const t of [
      SESSION_LIMIT,
      "API Error: You've hit your session limit · resets 6pm (Africa/Johannesburg)",
      "You've hit your weekly limit · resets Oct 20, 9am (UTC)",
      'You’ve hit your Opus limit · resets 3pm',
      '5-hour limit reached ∙ resets 3am',
      'Claude usage limit reached|resets 3pm',
      'Claude AI usage limit reached|1760000000',
      'Weekly limit reached ∙ resets Oct 20 at 9am',
      "You're out of extra usage · resets 3pm",
    ])
      expect(isUsageLimitText(t), t).toBe(true);
    for (const t of [
      '',
      'Build failed: 2 errors',
      'rate limit exceeded on the github api',
      'the limit of the function is 5',
      'Failed to authenticate: OAuth session expired',
    ])
      expect(isUsageLimitText(t), t).toBe(false);
  });

  it('the stream parser flags an error result or a flagged API error, but not text that merely talks about limits', () => {
    const talk = new ClaudeStreamParser();
    talk.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'text', text: 'Handle the case "usage limit reached" in the UI' }],
        },
      }),
    );
    talk.parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'usage limit reached handled',
      }),
    );
    expect(talk.usageLimitText).toBeUndefined();

    const result = new ClaudeStreamParser();
    result.parseLine(LIMIT_RESULT);
    expect(result.usageLimitText).toBe(SESSION_LIMIT);

    const api = new ClaudeStreamParser();
    api.parseLine(
      JSON.stringify({
        type: 'assistant',
        error: 'rate_limit',
        message: { id: 'm2', content: [{ type: 'text', text: '5-hour limit reached ∙ resets 3am' }] },
      }),
    );
    expect(api.usageLimitText).toBe('5-hour limit reached ∙ resets 3am');
  });
});

describe('reading the reset time', () => {
  it('uses the zone in the message: 6pm Johannesburg is 16:00 UTC, today when still ahead', () => {
    expect(parseResetTime(SESSION_LIMIT, NOW, 'UTC')?.toISOString()).toBe('2026-10-15T16:00:00.000Z');
  });

  it('rolls to tomorrow when the time has passed today', () => {
    // 4am Johannesburg = 02:00 UTC, already behind 10:00 UTC
    expect(parseResetTime('resets 4am (Africa/Johannesburg)', NOW, 'UTC')?.toISOString()).toBe(
      '2026-10-16T02:00:00.000Z',
    );
  });

  it("uses the runner's own zone when the message has none", () => {
    // 3am in New York (EDT, UTC-4) = 07:00 UTC, behind 10:00 UTC, so tomorrow
    expect(parseResetTime('5-hour limit reached ∙ resets 3am', NOW, 'America/New_York')?.toISOString()).toBe(
      '2026-10-16T07:00:00.000Z',
    );
    // the same text in a UTC runner
    expect(parseResetTime('resets 3am', NOW, 'UTC')?.toISOString()).toBe('2026-10-16T03:00:00.000Z');
    // 24-hour form
    expect(parseResetTime('resets 18:30', NOW, 'UTC')?.toISOString()).toBe('2026-10-15T18:30:00.000Z');
  });

  it('reads a date and minutes, and follows daylight saving', () => {
    expect(parseResetTime('resets Oct 20, 9:30am (UTC)', NOW, 'UTC')?.toISOString()).toBe(
      '2026-10-20T09:30:00.000Z',
    );
    // 20 Oct in New York is still EDT (UTC-4); 9 Nov is EST (UTC-5)
    expect(parseResetTime('resets Oct 20 at 9am (America/New_York)', NOW, 'UTC')?.toISOString()).toBe(
      '2026-10-20T13:00:00.000Z',
    );
    const early = new Date('2026-11-05T10:00:00Z');
    expect(parseResetTime('resets Nov 9 at 9am (America/New_York)', early, 'UTC')?.toISOString()).toBe(
      '2026-11-09T14:00:00.000Z',
    );
  });

  it('reads the epoch forms (seconds and milliseconds) and ignores one in the past', () => {
    const sec = Math.floor(NOW.getTime() / 1000) + 7200;
    expect(parseResetTime(`Claude AI usage limit reached|${sec}`, NOW)?.getTime()).toBe(sec * 1000);
    expect(parseResetTime(`Claude AI usage limit reached|${sec * 1000}`, NOW)?.getTime()).toBe(sec * 1000);
    expect(parseResetTime('Claude AI usage limit reached|1000000000', NOW)).toBeUndefined();
  });

  it('assumes one hour (and says it guessed) when the time cannot be read', () => {
    const hit = detectUsageLimit("You've hit your session limit", NOW, 'UTC');
    expect(hit).toEqual({ until: new Date(NOW.getTime() + 3_600_000), parsed: false });
    expect(detectUsageLimit('resets 99pm usage limit reached', NOW, 'UTC')?.parsed).toBe(false);
    expect(detectUsageLimit('all fine', NOW)).toBeUndefined();
  });

  it('shows the time as the owner reads it', () => {
    const until = new Date('2026-10-15T16:00:00Z');
    expect(formatLimitTime(until, NOW, 'Africa/Johannesburg')).toBe('18:00 (Africa/Johannesburg)');
    expect(formatLimitTime(new Date('2026-10-17T07:00:00Z'), NOW, 'Africa/Johannesburg')).toMatch(
      /^Sat 17 Oct 09:00 \(Africa\/Johannesburg\)$/,
    );
  });
});

describe('the usage monitor', () => {
  it('tells its listeners about changes, including a moved reset time, and clears on ok', () => {
    const m = new ClaudeUsageMonitor();
    const seen: string[] = [];
    m.onChange((s) => seen.push(`${s}:${m.limitedUntil ?? '-'}`));
    expect(m.markOk()).toBe(false);
    const t1 = new Date('2026-10-15T16:00:00Z');
    expect(m.markLimited(t1)).toBe(true);
    expect(m.markLimited(t1)).toBe(false);
    expect(m.markLimited(new Date('2026-10-15T17:00:00Z'))).toBe(true); // extended
    expect(m.markOk()).toBe(true);
    expect(m.limitedUntil).toBeUndefined();
    expect(seen).toEqual(['limited:2026-10-15T16:00:00.000Z', 'limited:2026-10-15T17:00:00.000Z', 'ok:-']);
  });
});

describe('the probe', () => {
  const run = (answers: Array<{ exitCode: number; stdout: string; stderr?: string }>) => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_b: string, args: string[]) => {
        calls.push(args);
        return { stderr: '', ...(answers.shift() ?? { exitCode: 1, stdout: '' }) };
      },
    };
  };
  it('makes one minimal call on the cheapest model and reads a clean answer as ok', async () => {
    const f = run([{ exitCode: 0, stdout: '{"is_error":false,"result":"ok"}' }]);
    expect(await probeClaudeUsage({ bin: 'claude', run: f.run, now: () => NOW })).toEqual({ state: 'ok' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toEqual(expect.arrayContaining(['-p', '--max-turns', '1', '--model', 'haiku']));
  });
  it('re-parses a limit that is still there (so the pause is extended)', async () => {
    const f = run([{ exitCode: 1, stdout: LIMIT_RESULT }]);
    const r = await probeClaudeUsage({ bin: 'claude', run: f.run, now: () => NOW, tz: 'UTC' });
    expect(r).toMatchObject({ state: 'limited', hit: { parsed: true } });
    expect(r.state === 'limited' && r.hit.until.toISOString()).toBe('2026-10-15T16:00:00.000Z');
  });
  it('says unknown for a network error, leaving the state alone', async () => {
    const f = run([{ exitCode: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND api.anthropic.com' }]);
    expect(await probeClaudeUsage({ bin: 'claude', run: f.run })).toEqual({ state: 'unknown' });
  });
});

describe('the Claude adapter at the usage limit (fake claude)', () => {
  const fake = (t: string, body: string) => {
    const bin = join(t, 'fakeclaude');
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.299 (Claude Code)"; exit 0; fi\n${body}\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  };
  const input = async (t: string, bin: string) => {
    const paths = runnerPaths(join(t, 'data'));
    const sandbox = await ensureSandbox(paths, A, 'Bob');
    const cwd = join(t, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
    return {
      paths,
      start: {
        shiftId: 'zz',
        prompt: 'hi',
        instructionsMarkdown: '',
        cwd,
        sandbox,
        addDirs: [],
        env: {},
        maxShiftMinutes: 5,
        agent: {
          agentId: A,
          name: 'Bob',
          roleKey: 'reviewer',
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'sonnet',
          skills: [],
          permissions: reviewer?.permissions,
          isDevops: false,
        },
      },
      cfg: ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }),
    };
  };
  const drain = async (s: RuntimeSession): Promise<RuntimeEvent[]> => {
    const out: RuntimeEvent[] = [];
    for await (const e of s.events()) out.push(e);
    return out;
  };
  const withSmoke = async (fn: () => Promise<void>) => {
    const prev = process.env.AOM_CLAUDE_SMOKE;
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.AOM_CLAUDE_SMOKE;
      else process.env.AOM_CLAUDE_SMOKE = prev;
    }
  };

  it('flags the exit with the reset time, reports the runtime limited, and the probe extends then resumes', () =>
    withSmoke(async () => {
      const t = tmp();
      writeFileSync(join(t, 'out.json'), `${LIMIT_RESULT}\n`);
      const bin = fake(t, `cat '${join(t, 'out.json')}'\nexit 1`);
      const { paths, start, cfg } = await input(t, bin);
      const usage = new ClaudeUsageMonitor();
      let clock = new Date();
      // 6pm Johannesburg is 16:00 UTC; pin the clock to just before it so the parsed time is today's
      clock = new Date(`${clock.toISOString().slice(0, 10)}T08:00:00Z`);
      let probe: 'ok' | 'still' | 'unknown' = 'still';
      const adapter = new ClaudeCodeAdapter(cfg, paths, {
        usage,
        now: () => clock,
        zone: 'UTC',
        usageProbe: async () =>
          probe === 'ok'
            ? { state: 'ok' }
            : probe === 'unknown'
              ? { state: 'unknown' }
              : { state: 'limited', hit: { until: new Date(clock.getTime() + 7_200_000), parsed: true } },
      });
      expect((await adapter.capabilities()).available).toBe(true);
      expect((await adapter.capabilities()).usage).toBe('ok');

      const exit = (await drain(await adapter.start(start as never))).at(-1);
      const until = `${clock.toISOString().slice(0, 10)}T16:00:00.000Z`;
      expect(exit).toMatchObject({ kind: 'exit', code: 1, usageLimit: { until } });
      expect(exit).not.toHaveProperty('authFailed');
      expect(usage.state).toBe('limited');
      expect(await adapter.capabilities()).toMatchObject({
        available: false,
        usage: 'limited',
        limitedUntil: until,
        limitedLabel: expect.stringContaining('16:00'),
      });

      // still limited: the pause moves to the freshly read time
      expect(await adapter.probeUsage()).toBe('limited');
      expect(usage.limitedUntil).toBe(new Date(clock.getTime() + 7_200_000).toISOString());
      // unknown: nothing changes
      probe = 'unknown';
      expect(await adapter.probeUsage()).toBe('unknown');
      expect(usage.state).toBe('limited');
      // clean: available again
      probe = 'ok';
      expect(await adapter.probeUsage()).toBe('ok');
      expect(await adapter.capabilities()).toMatchObject({ available: true, usage: 'ok' });
      expect((await adapter.capabilities()).limitedUntil).toBeUndefined();
    }));

  it('a successful real session resumes early', () =>
    withSmoke(async () => {
      const t = tmp();
      const ok = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        usage: { input_tokens: 5, output_tokens: 7 },
      });
      const bin = fake(t, `echo '${ok}'\nexit 0`);
      const { paths, start, cfg } = await input(t, bin);
      const usage = new ClaudeUsageMonitor();
      usage.markLimited(new Date(Date.now() + 3_600_000));
      const adapter = new ClaudeCodeAdapter(cfg, paths, { usage });
      await drain(await adapter.start(start as never));
      expect(usage.state).toBe('ok');
    }));

  it('a limit message on stderr alone is enough, and an assumed hour is used when it has no time', () =>
    withSmoke(async () => {
      const t = tmp();
      const bin = fake(t, `echo "Claude AI usage limit reached" >&2\nexit 1`);
      const { paths, start, cfg } = await input(t, bin);
      const usage = new ClaudeUsageMonitor();
      const now = new Date('2026-10-15T10:00:00Z');
      const adapter = new ClaudeCodeAdapter(cfg, paths, { usage, now: () => now });
      const exit = (await drain(await adapter.start(start as never))).at(-1);
      expect(exit).toMatchObject({ kind: 'exit', usageLimit: { until: '2026-10-15T11:00:00.000Z' } });
    }));
});

describe('supervisor: a shift that dies of the usage limit', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('is rejected as usage_limited with the reset time (no ended shift, so no crash and no loop-breaker count) after the runtime was reported limited', async () => {
    const usage = new ClaudeUsageMonitor();
    const until = new Date(Date.now() + 3 * 3_600_000);
    const adapter: RuntimeAdapter = {
      id: 'mock',
      capabilities: async () => ({
        runtime: 'mock',
        version: 'x',
        available: usage.state === 'ok',
        capabilities: [],
        usage: usage.state,
      }),
      writeInstructions: async () => {},
      start: async () => ({
        events: () =>
          (async function* () {
            usage.markLimited(until);
            yield {
              kind: 'exit',
              code: 1,
              usageLimit: { until: until.toISOString() },
              error: SESSION_LIMIT,
            } as RuntimeEvent;
          })(),
        stop: async () => {},
        usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      }),
    };
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, stage: 'review' });
    h.server.send('shift.start', msg);
    const rej = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId);
    expect(rej.reason).toBe('usage_limited');
    expect(rej.limitedUntil).toBe(until.toISOString());
    expect(rej.detail).toContain('(');
    expect(h.server.of('shift.ended').filter((m) => m.shiftId === msg.shiftId)).toHaveLength(0);
  });
});

describe('runner: reporting the limit and resuming', () => {
  let server: FakeServer | undefined;
  let runner: Runner | undefined;
  afterEach(async () => {
    await runner?.stop();
    await server?.close();
    runner = undefined;
    server = undefined;
  });

  it('reports the runtime limited with the time, probes once the time has passed, and reports it available again', async () => {
    const prev = process.env.AOM_CLAUDE_SMOKE;
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      const t = tmp();
      const bin = join(t, 'fakeclaude');
      writeFileSync(
        bin,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.299 (Claude Code)"; exit 0; fi\necho '{"is_error":false,"result":"ok"}'\n`,
      );
      chmodSync(bin, 0o755);
      const srv = await FakeServer.start();
      server = srv;
      const repo = makeRepo();
      const config = makeConfig(srv.url, {
        repoRoots: [repo.scanRoot],
        runtimes: { 'claude-code': { bin, sandbox: 'off' }, mock: { enabled: true } },
      } as never);
      const r = new Runner({
        config,
        dataDir: tmp('aom-data-'),
        exitGraceMs: 5000,
        minuteMs: 50,
        usageProbeMs: 0,
      });
      runner = r;
      await r.start();
      await waitUntil(() => srv.helloCount > 0 && r.client.isReady, 10_000, 'welcome');
      const claude = () =>
        srv
          .of('runtimes.report')
          .map((m) => m.runtimes.find((x) => x.id === 'claude-code'))
          .filter(Boolean);

      const until = new Date(Date.now() + 400);
      r.claudeUsage.markLimited(until);
      await waitUntil(() => claude().some((x) => x?.usage === 'limited'), 10_000, 'limited report');
      const limited = claude().find((x) => x?.usage === 'limited');
      expect(limited).toMatchObject({ available: false, limitedUntil: until.toISOString() });
      expect(limited?.limitedLabel).toMatch(/\d\d:\d\d \(/);

      // after the reset time the probe (one minimal call) works and the runtime comes back
      await waitUntil(() => claude().some((x) => x?.usage === 'ok' && x.available), 15_000, 'resumed report');
      expect(r.claudeUsage.state).toBe('ok');
    } finally {
      if (prev === undefined) delete process.env.AOM_CLAUDE_SMOKE;
      else process.env.AOM_CLAUDE_SMOKE = prev;
    }
  });
});
