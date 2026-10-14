import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeAuthMonitor,
  type CredentialsDoc,
  harvestAgentCredentials,
  isAuthFailureText,
  loginExpiresAt,
  mcpAuthOf,
  prepareAgentCredentials,
  probeClaudeLogin,
  readCredentials,
  withLock,
} from '../src/adapters/claude-auth.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { ClaudeStreamParser } from '../src/adapters/claude-stream-parser.ts';
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { mcpAuthStates, mcpSignInNote, type PluginMcpServer, reportOf } from '../src/mcp/plugins.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
// the line the shift logs showed when the login had expired (0 tokens, terminal_reason api_error)
const EXPIRED_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  terminal_reason: 'api_error',
  usage: { input_tokens: 0, output_tokens: 0 },
});

const creds = (login: number, mcp: Record<string, number> = {}): CredentialsDoc => ({
  claudeAiOauth: { accessToken: `A${login}`, refreshToken: `R${login}`, expiresAt: login },
  mcpOAuth: Object.fromEntries(
    Object.entries(mcp).map(([k, exp]) => [
      k,
      { accessToken: `m${exp}`, refreshToken: `r${exp}`, expiresAt: exp },
    ]),
  ),
  other: { keep: true },
});
const write = (path: string, doc: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(doc));
};

describe('recognising a dead login', () => {
  it('matches the messages Claude Code gives', () => {
    for (const t of [
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'Invalid API key · Please run /login',
      'OAuth refresh token is no longer valid',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ])
      expect(isAuthFailureText(t), t).toBe(true);
    for (const t of ['', 'Build failed: 2 errors', 'the user table has a login column', 'rate limit reached'])
      expect(isAuthFailureText(t), t).toBe(false);
  });

  it('the stream parser flags an error result, but not text that merely talks about login', () => {
    const p = new ClaudeStreamParser();
    p.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'text', text: 'You must call /login in the OAuth session expired case' }],
        },
      }),
    );
    expect(p.authFailure).toBe(false);
    p.parseLine(EXPIRED_RESULT);
    expect(p.authFailure).toBe(true);
    const q = new ClaudeStreamParser();
    q.parseLine(
      JSON.stringify({
        type: 'assistant',
        error: 'authentication_failed',
        message: { id: 'm', content: [] },
      }),
    );
    expect(q.authFailure).toBe(true);
  });

  it('the monitor tells its listeners only about changes', () => {
    const m = new ClaudeAuthMonitor();
    const seen: string[] = [];
    m.onChange((s) => seen.push(s));
    expect(m.markOk()).toBe(false);
    expect(m.markExpired()).toBe(true);
    expect(m.markExpired()).toBe(false);
    expect(m.expiredSince).toBeDefined();
    expect(m.markOk()).toBe(true);
    expect(seen).toEqual(['expired', 'ok']);
  });
});

describe('the probe', () => {
  const run = (answers: Array<{ exitCode: number; stdout: string; stderr?: string }>) => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_b: string, args: string[]) => {
        calls.push(args);
        const a = answers.shift() ?? { exitCode: 1, stdout: '' };
        return { stderr: '', ...a };
      },
    };
  };
  it('says expired at once when nobody is signed in, without the paid call', async () => {
    const f = run([{ exitCode: 0, stdout: '{"loggedIn":false}' }]);
    expect(await probeClaudeLogin({ bin: 'claude', run: f.run })).toBe('expired');
    expect(f.calls).toHaveLength(1);
  });
  it('makes one minimal call otherwise and reads its verdict', async () => {
    const ok = run([
      { exitCode: 0, stdout: '{"loggedIn":true}' },
      { exitCode: 0, stdout: '{"is_error":false,"result":"ok"}' },
    ]);
    expect(await probeClaudeLogin({ bin: 'claude', run: ok.run })).toBe('ok');
    expect(ok.calls[1]).toEqual(expect.arrayContaining(['-p', '--max-turns', '1']));
    const dead = run([
      { exitCode: 0, stdout: '{"loggedIn":true}' },
      { exitCode: 1, stdout: EXPIRED_RESULT },
    ]);
    expect(await probeClaudeLogin({ bin: 'claude', run: dead.run })).toBe('expired');
    const net = run([
      { exitCode: 0, stdout: '{"loggedIn":true}' },
      { exitCode: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND api.anthropic.com' },
    ]);
    expect(await probeClaudeLogin({ bin: 'claude', run: net.run })).toBe('unknown');
  });
});

describe('sharing the login between agents (copy, lock, write back)', () => {
  const setup = () => {
    const t = tmp();
    const p = {
      canonical: join(t, 'home', '.claude', '.credentials.json'),
      copy: join(t, 'agent', 'claude', '.credentials.json'),
      lock: join(t, 'data', 'claude-credentials.lock'),
    };
    return { t, p };
  };

  it('copies (never links) the canonical file, replacing an old symlink, mode 0600', async () => {
    const { p } = setup();
    write(p.canonical, creds(5_000_000_000_000));
    mkdirSync(join(p.copy, '..'), { recursive: true });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(p.canonical, p.copy);
    expect(await prepareAgentCredentials(p)).toBe('copied');
    expect(lstatSync(p.copy).isSymbolicLink()).toBe(false);
    expect(readCredentials(p.copy)).toEqual(readCredentials(p.canonical));
    if (process.platform !== 'win32') expect(lstatSync(p.copy).mode & 0o077).toBe(0);
    expect(existsSync(p.lock)).toBe(false);
  });

  it('refreshes once, under the lock, when the token expires within 10 minutes; later sessions see the fresh token', async () => {
    const { p } = setup();
    const now = 1_000_000_000_000;
    write(p.canonical, creds(now + 60_000));
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 30));
      write(p.canonical, creds(now + 8 * 3_600_000)); // Claude Code rotated the token
    };
    const copies = [p.copy, `${p.copy}.2`, `${p.copy}.3`].map((copy) => ({ ...p, copy }));
    await Promise.all(copies.map((c) => prepareAgentCredentials(c, { refresh, now: () => now })));
    expect(refreshes).toBe(1);
    for (const c of copies) expect(loginExpiresAt(readCredentials(c.copy))).toBe(now + 8 * 3_600_000);
    // a far-off expiry is not refreshed
    await prepareAgentCredentials(p, { refresh, now: () => now });
    expect(refreshes).toBe(1);
  });

  it('writes a newer login and newer plugin sign-ins back, keeps the rest, and never goes backwards', async () => {
    const { p } = setup();
    write(p.canonical, creds(100, { 'plugin:a:a|1': 10, 'plugin:b:b|2': 50 }));
    write(p.copy, creds(200, { 'plugin:a:a|1': 20, 'plugin:b:b|2': 5, 'plugin:c:c|3': 7 }));
    expect(await harvestAgentCredentials(p)).toEqual({ login: true, mcp: 2 });
    const canon = readCredentials(p.canonical);
    expect(loginExpiresAt(canon)).toBe(200);
    expect(canon?.mcpOAuth?.['plugin:a:a|1']?.expiresAt).toBe(20);
    expect(canon?.mcpOAuth?.['plugin:b:b|2']?.expiresAt).toBe(50); // the older copy entry did not win
    expect(canon?.mcpOAuth?.['plugin:c:c|3']?.expiresAt).toBe(7);
    expect(canon?.other).toEqual({ keep: true });
    // an older copy changes nothing
    write(p.copy, creds(150));
    expect(await harvestAgentCredentials(p)).toEqual({ login: false, mcp: 0 });
    expect(loginExpiresAt(readCredentials(p.canonical))).toBe(200);
  });

  it('a lock left by a crashed process is taken over', async () => {
    const { p } = setup();
    mkdirSync(join(p.lock, '..'), { recursive: true });
    writeFileSync(p.lock, '');
    expect(await withLock(p.lock, async () => 'ran', { staleMs: -1, timeoutMs: 1000 })).toBe('ran');
  });
});

describe('MCP sign-in state', () => {
  const now = 1_000;
  const doc = {
    mcpOAuth: {
      'plugin:atlassian:atlassian|abc': { accessToken: 'x', refreshToken: 'y', expiresAt: now + 10 },
      'plugin:expired:with-refresh|d': { accessToken: 'x', refreshToken: 'y', expiresAt: now - 10 },
      'plugin:expired:no-refresh|e': { accessToken: 'x', expiresAt: now - 10 },
    },
  };
  it('looks at keys and expiry only', () => {
    expect(mcpAuthOf(doc, 'plugin:atlassian:atlassian', now)).toBe('signed_in');
    expect(mcpAuthOf(doc, 'plugin:expired:with-refresh', now)).toBe('signed_in');
    expect(mcpAuthOf(doc, 'plugin:expired:no-refresh', now)).toBe('needs_sign_in');
    expect(mcpAuthOf(doc, 'plugin:atlassian', now)).toBe('needs_sign_in');
    expect(mcpAuthOf(null, 'plugin:atlassian:atlassian', now)).toBe('needs_sign_in');
  });

  const server = (
    name: string,
    transport: PluginMcpServer['transport'],
    config: Record<string, unknown> = {},
  ) =>
    ({
      name: name.replace(/:/g, '_'),
      key: name,
      plugin: name.split(':')[1],
      server: name.split(':')[2],
      transport,
      root: '/x',
      config: { url: 'https://mcp.example.com/mcp', ...config },
    }) as PluginMcpServer;

  it('is reported per server without any token value', () => {
    const home = tmp();
    write(join(home, '.credentials.json'), {
      mcpOAuth: {
        'plugin:atlassian:atlassian|abc': { accessToken: 'SECRET-TOKEN', refreshToken: 'SECRET-R' },
      },
    });
    const servers = [
      server('plugin:atlassian:atlassian', 'http'),
      server('plugin:linear:linear', 'http'),
      server('plugin:files:local', 'stdio', { command: 'x' }),
      server('plugin:keyed:keyed', 'http', { headers: { Authorization: 'Bearer k' } }),
    ];
    const report = reportOf(servers, mcpAuthStates(home));
    expect(Object.fromEntries(report.map((r) => [r.server, r.authState]))).toEqual({
      atlassian: 'signed_in',
      linear: 'needs_sign_in',
      local: 'not_needed',
      keyed: 'not_needed',
    });
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(reportOf(servers)[0]).not.toHaveProperty('authState'); // older callers: unchanged
  });

  it('tells the agent exactly what to say for a granted server that needs sign-in', () => {
    const s = [server('plugin:linear:linear', 'http'), server('plugin:atlassian:atlassian', 'http')];
    const note = mcpSignInNote(s, ['plugin_linear_linear'], () => 'needs_sign_in', 'WS1');
    expect(note).toContain('On WS1, run `claude`, then `/mcp`, choose linear, Authenticate.');
    expect(note).not.toContain('atlassian'); // not granted
    expect(mcpSignInNote(s, ['plugin_linear_linear'], () => 'signed_in', 'WS1')).toBe('');
  });
});

describe('the Claude adapter with an expired login (fake claude)', () => {
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

  it('flags the exit, pauses the runtime, and a successful probe resumes it', async () => {
    const prev = process.env.AOM_CLAUDE_SMOKE;
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      const t = tmp();
      const home = join(t, 'home');
      write(join(home, '.claude', '.credentials.json'), creds(5_000_000_000_000));
      const bin = fake(t, `echo '${EXPIRED_RESULT}'\nexit 1`);
      const { paths, start, cfg } = await input(t, bin);
      const auth = new ClaudeAuthMonitor();
      let probeAnswer: 'ok' | 'expired' | 'unknown' = 'expired';
      const adapter = new ClaudeCodeAdapter(cfg, paths, { auth, home, probe: async () => probeAnswer });
      expect((await adapter.capabilities()).available).toBe(true);
      const exit = (await drain(await adapter.start(start as never))).at(-1);
      expect(exit).toMatchObject({ kind: 'exit', code: 1, authFailed: true });
      expect(auth.state).toBe('expired');
      expect(await adapter.capabilities()).toMatchObject({ available: false, auth: 'expired' });
      expect(await adapter.probeLogin()).toBe('expired');
      expect(auth.state).toBe('expired');
      probeAnswer = 'ok';
      expect(await adapter.probeLogin()).toBe('ok');
      expect(await adapter.capabilities()).toMatchObject({ available: true, auth: 'ok' });
    } finally {
      if (prev === undefined) delete process.env.AOM_CLAUDE_SMOKE;
      else process.env.AOM_CLAUDE_SMOKE = prev;
    }
  });

  it('writes the token an agent refreshed back to the machine login after the session', async () => {
    const prev = process.env.AOM_CLAUDE_SMOKE;
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      const t = tmp();
      const home = join(t, 'home');
      const canon = join(home, '.claude', '.credentials.json');
      write(canon, creds(1_000));
      // the fake "refreshes" the copy in its config dir the way Claude Code does
      const bin = fake(
        t,
        `echo '{"claudeAiOauth":{"accessToken":"NEW","refreshToken":"R2","expiresAt":9000000000000}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"\necho '{"type":"result","subtype":"success","result":"done","usage":{"output_tokens":5}}'\nexit 0`,
      );
      const { paths, start, cfg } = await input(t, bin);
      const auth = new ClaudeAuthMonitor();
      const adapter = new ClaudeCodeAdapter(cfg, paths, { auth, home, probe: async () => 'ok' });
      const exit = (await drain(await adapter.start(start as never))).at(-1);
      expect(exit).toMatchObject({ kind: 'exit', code: 0 });
      expect(loginExpiresAt(readCredentials(canon))).toBe(9_000_000_000_000);
      expect(auth.state).toBe('ok');
    } finally {
      if (prev === undefined) delete process.env.AOM_CLAUDE_SMOKE;
      else process.env.AOM_CLAUDE_SMOKE = prev;
    }
  });
});

describe('supervisor: a shift that dies of an expired login', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('is rejected as auth_expired (no crashed outcome, so no loop-breaker count) after the runtime was reported paused', async () => {
    const auth = new ClaudeAuthMonitor();
    const adapter: RuntimeAdapter = {
      id: 'mock',
      capabilities: async () => ({
        runtime: 'mock',
        version: 'x',
        available: auth.state === 'ok',
        capabilities: [],
        auth: auth.state,
      }),
      writeInstructions: async () => {},
      start: async () => ({
        events: () =>
          (async function* () {
            auth.markExpired();
            yield {
              kind: 'exit',
              code: 1,
              authFailed: true,
              error: 'Failed to authenticate',
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
    expect(rej.reason).toBe('auth_expired');
    expect(h.server.of('shift.ended').filter((m) => m.shiftId === msg.shiftId)).toHaveLength(0);
  });
});
