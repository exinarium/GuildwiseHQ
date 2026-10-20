import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, RuntimeInfoSchema } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAccountRegistry } from '../src/adapters/claude-accounts.ts';
import { ClaudeAuthMonitor, readCredentials } from '../src/adapters/claude-auth.ts';
import {
  accountClaudeConfig,
  buildClaudeChatCommand,
  buildClaudeCommand,
  ClaudeCodeAdapter,
} from '../src/adapters/claude-code.ts';
import type { RuntimeAdapter, RuntimeEvent, ShiftStartInput } from '../src/adapters/types.ts';
import { type ClaudeAccountConfig, ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { parseClaudeAuthLogin } from '../src/integrations/claude-code.ts';
import { claudeAccountFile } from '../src/integrations/claude-store.ts';
import { cleanTerminal } from '../src/integrations/terminal.ts';
import { runnerPaths } from '../src/paths.ts';
import { sandboxFor } from '../src/sandbox/sandbox.ts';
import { SessionRegistry } from '../src/sessions/registry.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { fixture } from './integrations-helpers.ts';

cleanupTmp();

const OAUTH = (expiresAt: number, extra: Record<string, unknown> = {}) => ({
  claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt, ...extra },
});
const writeCreds = (dir: string, doc: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify(doc));
};

function setup(accounts: ClaudeAccountConfig[] = [{ key: 'work', source: 'config_dir' }], persist = true) {
  const home = tmp('aom-acct-home-');
  const root = tmp('aom-acct-root-');
  const stateFile = join(root, 'claude-accounts-state.json');
  const make = () =>
    new ClaudeAccountRegistry({
      home,
      root,
      secretsDir: join(root, 'secrets'),
      ...(persist ? { stateFile } : {}),
      accounts: () => accounts,
      mainCredential: () => ({ authMode: 'oauth', oauthToken: 'MAIN-TOKEN' }),
      now: () => new Date('2026-10-15T10:00:00Z'),
      zone: 'UTC',
    });
  return { home, root, stateFile, make };
}

describe('account registry: login state', () => {
  it('a config-dir account with no login is `none`; with a login it is `ok`', () => {
    const t = setup();
    const reg = t.make();
    const work = reg.get('work');
    expect(work?.auth.state).toBe('none');
    expect(work?.info().login).toBe('none');
    expect(work?.info().configDir).toBe('~/.claude-gw-work');
    expect(work?.usable).toBe(false);
    writeCreds(join(t.home, '.claude-gw-work'), OAUTH(Date.now() + 3_600_000));
    const reg2 = t.make();
    expect(reg2.get('work')?.auth.state).toBe('ok');
    expect(reg2.get('main')?.info().login).toBe('ok');
  });

  it('main first; the runtime is usable while ANY account is', () => {
    const t = setup();
    const reg = t.make();
    expect(reg.list().map((a) => a.key)).toEqual(['main', 'work']);
    expect(reg.anyUsable()).toBe(true);
    reg.main.auth.markExpired();
    expect(reg.anyUsable()).toBe(false);
  });

  it('reports email and plan from .claude.json, never a token', () => {
    const t = setup();
    const dir = join(t.home, '.claude-gw-work');
    writeCreds(dir, OAUTH(Date.now() + 3_600_000));
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@x.test', organizationType: 'claude_team' } }),
    );
    const info = t.make().get('work')?.info();
    expect(info).toMatchObject({ email: 'a@x.test', plan: 'claude_team', source: 'config_dir' });
    expect(JSON.stringify(info)).not.toContain('"a"');
  });
});

describe('account registry: persisted state', () => {
  it('a limit and an expired login survive a restart', () => {
    const t = setup([{ key: 'work', source: 'config_dir' }]);
    writeCreds(join(t.home, '.claude-gw-work'), OAUTH(Date.now() + 3_600_000));
    const reg = t.make();
    const until = new Date('2026-10-15T14:00:00Z');
    reg.get('work')?.usage.markLimited(until);
    reg.main.auth.markExpired();
    const saved = JSON.parse(readFileSync(t.stateFile, 'utf8'));
    expect(saved).toEqual({
      main: { login: 'expired' },
      work: { limitedUntil: until.toISOString() },
    });
    const again = t.make();
    expect(again.get('work')?.usage.state).toBe('limited');
    expect(again.get('work')?.usage.limitedUntil).toBe(until.toISOString());
    expect(again.main.auth.state).toBe('expired');
    // recovery is written too
    again.main.auth.markOk();
    expect(JSON.parse(readFileSync(t.stateFile, 'utf8')).main).toBeUndefined();
  });

  it('an unreadable state file starts clean', () => {
    const t = setup();
    writeFileSync(t.stateFile, 'not json');
    expect(t.make().main.auth.state).toBe('ok');
  });
});

describe('account probe environment and credentials', () => {
  it('config_dir sets CLAUDE_CONFIG_DIR and no token; token sets the token; main keeps the main credential', () => {
    const t = setup([
      { key: 'work', source: 'config_dir' },
      { key: 'tok', source: 'token' },
    ]);
    const secrets = join(t.root, 'secrets');
    mkdirSync(join(secrets, 'claude-accounts'), { recursive: true });
    writeFileSync(
      claudeAccountFile(secrets, 'tok'),
      JSON.stringify({ authMode: 'oauth', oauthToken: 'TOK-TOKEN', savedAt: new Date().toISOString() }),
    );
    const reg = t.make();
    const prev = { ...process.env };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'STRAY';
    try {
      const w = reg.get('work')?.probeEnv() ?? {};
      expect(w.CLAUDE_CONFIG_DIR).toBe(join(t.home, '.claude-gw-work'));
      expect(w.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(reg.get('tok')?.probeEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('TOK-TOKEN');
      expect(reg.get('tok')?.info().source).toBe('token');
      expect(reg.main.probeEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('MAIN-TOKEN');
    } finally {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = prev.CLAUDE_CODE_OAUTH_TOKEN;
      if (prev.CLAUDE_CODE_OAUTH_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    expect(reg.get('tok')?.auth.state).toBe('ok');
  });

  it('credential paths: per-account canonical file, per-agent copy, lock next to the account', () => {
    const t = setup();
    const reg = t.make();
    const p = reg.get('work')?.credentialPaths('/data/agents/a1/claude-acct-work');
    expect(p).toEqual({
      canonical: join(t.home, '.claude-gw-work', '.credentials.json'),
      copy: '/data/agents/a1/claude-acct-work/.credentials.json',
      lock: join(t.home, '.claude-gw-work', '.aom-credentials.lock'),
    });
    expect(reg.main.credentialPaths('/data/agents/a1/claude')?.canonical).toBe(
      join(t.home, '.claude', '.credentials.json'),
    );
  });

  it('a changed credentials file of a `none` account asks for an immediate probe; a lost login marks `none`', () => {
    const t = setup();
    const reg = t.make();
    expect(reg.poll()).toEqual([]);
    const dir = join(t.home, '.claude-gw-work');
    writeCreds(dir, OAUTH(Date.now() + 3_600_000));
    expect(reg.poll().map((a) => a.key)).toEqual(['work']);
    expect(reg.poll()).toEqual([]); // seen
    reg.get('work')?.auth.markOk();
    const f = join(dir, '.credentials.json');
    utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(reg.poll()).toEqual([]); // changed while ok: nothing to do
    writeFileSync(f, '{}');
    utimesSync(f, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    expect(reg.poll()).toEqual([]);
    expect(reg.get('work')?.auth.state).toBe('none');
  });
});

describe('B3: session environment per account', () => {
  const cfg = ClaudeRuntimeConfigSchema.parse({ authMode: 'oauth', oauthToken: 'MAIN-TOKEN' });
  const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
  if (!builder) throw new Error('role');
  const input = (configDir: string): ShiftStartInput =>
    ({
      shiftId: 's1',
      prompt: 'hi',
      instructionsMarkdown: '',
      cwd: '/w',
      sandbox: { home: '/d/agents/a1/home', configDir, scratch: '/s', tmp: '/t' },
      agent: { agentId: 'a1', model: 'sonnet', isDevops: false, permissions: builder.permissions },
      env: { PATH: '/usr/bin' },
      addDirs: [],
      maxShiftMinutes: 5,
    }) as unknown as ShiftStartInput;

  it("a config-dir account gets the agent dir claude-acct-<key> and NO token variable (not even main's)", () => {
    const sb = sandboxFor(runnerPaths('/data'), 'a1', 'work');
    expect(sb.configDir).toBe('/data/agents/a1/claude-acct-work');
    expect(sandboxFor(runnerPaths('/data'), 'a1').configDir).toBe('/data/agents/a1/claude');
    expect(sandboxFor(runnerPaths('/data'), 'a1', 'main').configDir).toBe('/data/agents/a1/claude');
    const acfg = accountClaudeConfig(cfg, { authMode: 'default' });
    const c = buildClaudeCommand(input(sb.configDir), acfg);
    expect(c.env.CLAUDE_CONFIG_DIR).toBe('/data/agents/a1/claude-acct-work');
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(buildClaudeCommand(input('/d/agents/a1/claude'), cfg).env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'MAIN-TOKEN',
    );
  });

  it('a token account passes its own token (shift and chat)', () => {
    const acfg = accountClaudeConfig(cfg, { authMode: 'oauth', oauthToken: 'TOK' });
    expect(buildClaudeCommand(input('/x'), acfg).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('TOK');
    const k = accountClaudeConfig(cfg, { authMode: 'api_key', apiKey: 'KEY' });
    const chat = buildClaudeChatCommand(
      { ...input('/x'), chatId: 'c', message: 'hi', readOnly: true } as never,
      k,
    );
    expect(chat.env.ANTHROPIC_API_KEY).toBe('KEY');
    expect(chat.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('B3: credential write-back never crosses accounts', () => {
  it('a session on `work` writes back to work only, even when the config changed meanwhile', async () => {
    const t = setup(
      [
        { key: 'work', source: 'config_dir' },
        { key: 'other', source: 'config_dir' },
      ],
      false,
    );
    const accounts = [
      { key: 'work', source: 'config_dir' as const },
      { key: 'other', source: 'config_dir' as const },
    ];
    const reg = new ClaudeAccountRegistry({
      home: t.home,
      root: t.root,
      accounts: () => accounts,
      mainCredential: () => ({ authMode: 'default' }),
    });
    const workDir = join(t.home, '.claude-gw-work');
    const otherDir = join(t.home, '.claude-gw-other');
    const mainDir = join(t.home, '.claude');
    const old = Date.now() + 3_600_000 * 5;
    for (const d of [workDir, otherDir, mainDir]) writeCreds(d, OAUTH(old, { accessToken: d }));
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({}), runnerPaths(t.root), {
      accounts: reg,
      home: t.home,
    });
    const agentDir = join(t.root, 'agents', 'a1', 'claude-acct-work');
    mkdirSync(agentDir, { recursive: true });
    await adapter.linkCredentials(agentDir, [], 'work');
    expect(readCredentials(join(agentDir, '.credentials.json'))?.claudeAiOauth?.accessToken).toBe(workDir);
    // the session refreshed its token in its own copy
    writeCreds(agentDir, OAUTH(old + 99_000, { accessToken: 'REFRESHED' }));
    // the config now lists the accounts differently: the bound paths do not move
    accounts.splice(0, accounts.length);
    const { harvestAgentCredentials } = await import('../src/adapters/claude-auth.ts');
    const bound = {
      canonical: join(workDir, '.credentials.json'),
      copy: join(agentDir, '.credentials.json'),
      lock: join(workDir, '.aom-credentials.lock'),
    };
    await harvestAgentCredentials(bound);
    expect(readCredentials(join(workDir, '.credentials.json'))?.claudeAiOauth?.accessToken).toBe('REFRESHED');
    expect(readCredentials(join(otherDir, '.credentials.json'))?.claudeAiOauth?.accessToken).toBe(otherDir);
    expect(readCredentials(join(mainDir, '.credentials.json'))?.claudeAiOauth?.accessToken).toBe(mainDir);
    expect(existsSync(join(workDir, '.aom-credentials.lock'))).toBe(false);
  });

  it('capabilities: available while one account is usable; top-level fields describe main; accounts[] lists all', async () => {
    const t = setup([{ key: 'work', source: 'config_dir' }], false);
    writeCreds(join(t.home, '.claude-gw-work'), OAUTH(Date.now() + 3_600_000));
    const reg = new ClaudeAccountRegistry({
      home: t.home,
      root: t.root,
      accounts: () => [{ key: 'work', source: 'config_dir' }],
      mainCredential: () => ({ authMode: 'default' }),
      mainAuth: new ClaudeAuthMonitor(),
    });
    const bin = join(t.root, 'fake-claude');
    writeFileSync(bin, '#!/bin/sh\necho "2.1.304 (Claude Code)"\n', { mode: 0o755 });
    const adapter = new ClaudeCodeAdapter(
      ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }),
      runnerPaths(t.root),
      { accounts: reg, home: t.home },
    );
    // `realClaudeBlocked` reports unavailable under vitest unless opted in
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      reg.main.auth.markExpired();
      const caps = await adapter.capabilities();
      expect(caps.auth).toBe('expired');
      expect(caps.available).toBe(true);
      expect(caps.accounts?.map((a) => [a.key, a.login])).toEqual([
        ['main', 'expired'],
        ['work', 'ok'],
      ]);
      reg.get('work')?.auth.markExpired();
      expect((await adapter.capabilities()).available).toBe(false);
      expect(adapter.accountGate('work')).toEqual({ state: 'login', login: 'expired' });
      expect(adapter.accountGate('nope')).toEqual({ state: 'missing' });
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
    }
  });

  it('capabilities: at most 20 accounts are reported (main first) so the hello always validates', async () => {
    const t = setup([], false);
    const many: ClaudeAccountConfig[] = Array.from({ length: 25 }, (_, i) => ({
      key: `a${String(i).padStart(2, '0')}`,
      source: 'config_dir' as const,
    }));
    const reg = new ClaudeAccountRegistry({
      home: t.home,
      root: t.root,
      accounts: () => many,
      mainCredential: () => ({ authMode: 'default' }),
      mainAuth: new ClaudeAuthMonitor(),
    });
    const bin = join(t.root, 'fake-claude');
    writeFileSync(bin, '#!/bin/sh\necho "2.1.304 (Claude Code)"\n', { mode: 0o755 });
    const adapter = new ClaudeCodeAdapter(
      ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }),
      runnerPaths(t.root),
      { accounts: reg, home: t.home },
    );
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      const caps = await adapter.capabilities();
      expect(caps.accounts).toHaveLength(20);
      expect(caps.accounts?.[0]?.key).toBe('main');
      expect(RuntimeInfoSchema.safeParse({ id: 'claude-code', ...caps }).success).toBe(true);
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
    }
  });

  it('a persisted limit is restored once; a rebuilt account object does not get it again', () => {
    const t = setup([{ key: 'work', source: 'config_dir' }]);
    writeFileSync(t.stateFile, JSON.stringify({ work: { limitedUntil: '2026-10-15T18:00:00.000Z' } }));
    const accounts: ClaudeAccountConfig[] = [{ key: 'work', configDir: '~/dir-a', source: 'config_dir' }];
    const reg = new ClaudeAccountRegistry({
      home: t.home,
      root: t.root,
      stateFile: t.stateFile,
      accounts: () => accounts,
      mainCredential: () => ({ authMode: 'default' }),
    });
    expect(reg.get('work')?.usage.state).toBe('limited');
    // the owner points the key at another folder: a new object, which starts clean
    accounts[0] = { key: 'work', configDir: '~/dir-b', source: 'config_dir' };
    reg.refresh();
    expect(reg.get('work')?.configDir).toBe(join(t.home, 'dir-b'));
    expect(reg.get('work')?.usage.state).toBe('ok');
  });
});

describe('B3: resume never crosses accounts', () => {
  it('decide gives fresh_other_account in both directions, before the transcript check', () => {
    const dir = tmp('aom-sessions-');
    const reg = new SessionRegistry(join(dir, 'sessions.json'));
    reg.record({ sessionId: 's-main', agentId: 'a1', cwd: '/w' });
    reg.record({ sessionId: 's-work', agentId: 'a1', cwd: '/w', accountKey: 'work' });
    expect(reg.decide('s-main', 'a1', '/nope', 'work')).toMatchObject({
      state: 'fresh_other_account',
      detail: 'the session ran on account main; this shift runs on work',
    });
    expect(reg.decide('s-work', 'a1', '/nope', 'main').state).toBe('fresh_other_account');
    expect(reg.decide('s-work', 'a1', '/nope', 'work').state).toBe('fresh_transcript_missing');
    expect(reg.decide('s-main', 'a1', '/nope').state).toBe('fresh_transcript_missing');
  });
});

describe('B2: `claude auth login` transcript (fixture derived from the setup-token screen; UNVERIFIED against a real login)', () => {
  const tr = (raw: string, since?: string) => ({
    raw,
    text: cleanTerminal(raw),
    sinceInput: since ?? cleanTerminal(raw),
    inputs: since === undefined ? 0 : 1,
  });
  it('finds the sign-in link and the paste prompt', () => {
    const r = parseClaudeAuthLogin(tr(fixture('claude-auth-login.txt')));
    expect(r.awaiting).toBe('code');
    expect(r.prompt?.urlHost).toBe('claude.com');
    expect(r.prompt?.url).toContain('/oauth/authorize');
  });
  it('a wrong code fails; a success line after a paste is done', () => {
    const raw = fixture('claude-auth-login.txt');
    expect(parseClaudeAuthLogin(tr(raw, 'OAuth error: invalid code. Press Enter to retry')).failed).toMatch(
      /did not accept/,
    );
    expect(parseClaudeAuthLogin(tr(raw, 'Login successful. Logged in as a@x.test')).done).toBe(true);
    expect(parseClaudeAuthLogin(tr(raw)).done).toBeUndefined();
  });
});

describe('B3: supervisor guard and spawning on an account', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });
  const exit0 = (): RuntimeEvent => ({ kind: 'exit', code: 0 });
  function adapterWith(
    gate: ReturnType<NonNullable<RuntimeAdapter['accountGate']>>,
    started: ShiftStartInput[] = [],
  ): RuntimeAdapter {
    return {
      id: 'mock',
      capabilities: async () => ({ runtime: 'mock', version: 'x', available: true, capabilities: [] }),
      accountGate: () => gate,
      writeInstructions: async () => {},
      start: async (i) => {
        started.push(i);
        return {
          events: () =>
            (async function* () {
              yield exit0();
            })(),
          stop: async () => {},
          usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        };
      },
    };
  }
  const onWork = (h0: Harness): { shiftId: string; [k: string]: unknown } => ({
    ...(makeShiftStart({ remoteNormalized: h0.repo.remoteNormalized, stage: 'review' }) as {
      shiftId: string;
    }),
    account: { key: 'work' },
  });

  it.each([
    [{ state: 'missing' } as const, 'runtime_unavailable', 'account_missing:work'],
    [{ state: 'login', login: 'expired' } as const, 'auth_expired', undefined],
    [{ state: 'login', login: 'none' } as const, 'auth_expired', undefined],
    [
      { state: 'limited', limitedUntil: '2026-10-15T14:00:00.000Z', label: '16:00' } as const,
      'usage_limited',
      '16:00',
    ],
  ])('%j is rejected as %s with the account key', async (gate, reason, detail) => {
    h = await startHarness({}, { adapters: new Map([['mock', adapterWith(gate)]]) });
    const msg = onWork(h);
    h.server.send('shift.start', msg as never);
    const rej = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId);
    expect(rej.reason).toBe(reason);
    expect(rej.accountKey).toBe('work');
    if (detail) expect(rej.detail).toContain(detail);
    if (gate.state === 'limited') expect(rej.limitedUntil).toBe(gate.limitedUntil);
  });

  it('a usable account starts the session on the per-account config dir', async () => {
    const started: ShiftStartInput[] = [];
    h = await startHarness({}, { adapters: new Map([['mock', adapterWith({ state: 'ok' }, started)]]) });
    const msg = onWork(h);
    h.server.send('shift.start', msg as never);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId);
    expect(started[0]?.account).toBe('work');
    expect(started[0]?.sandbox.configDir).toMatch(/agents\/[^/]+\/claude-acct-work$/);
  });

  it('a main shift uses the plain dir and passes no account', async () => {
    const started: ShiftStartInput[] = [];
    h = await startHarness({}, { adapters: new Map([['mock', adapterWith({ state: 'ok' }, started)]]) });
    const msg = makeShiftStart({ remoteNormalized: h.repo.remoteNormalized, stage: 'review' });
    h.server.send('shift.start', msg as never);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId);
    expect(started[0]?.account).toBeUndefined();
    expect(started[0]?.sandbox.configDir).toMatch(/agents\/[^/]+\/claude$/);
  });
});
