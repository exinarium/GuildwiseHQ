import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type IntegrationCommandResult,
  type IntegrationKindId,
  type IntegrationSessionMsg,
  type McpAuthState,
  sealForRunner,
} from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAccountRegistry } from '../src/adapters/claude-accounts.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { loadConfig, RunnerConfigSchema, saveConfig } from '../src/config.ts';
import { MemoryTokenStore } from '../src/forge/index.ts';
import {
  ClaudeCredentialStore,
  claudeFile,
  resolveClaudeCredential,
} from '../src/integrations/claude-store.ts';
import { buildIntegrationAdapters, IntegrationService } from '../src/integrations/index.ts';
import type { AdapterEnv } from '../src/integrations/types.ts';
import type { PluginMcpServer } from '../src/mcp/plugins.ts';
import { runnerPaths } from '../src/paths.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { fakeExec, fixture, scriptedSpawner, until } from './integrations-helpers.ts';

cleanupTmp();

const WS = '22222222-2222-4222-8222-222222222222';
const TOKEN = `sk-ant-oat01-${'Zx9Qw8Er7Ty6'.repeat(6)}`;

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

function setup(over: {
  config?: Record<string, unknown>;
  exec?: Parameters<typeof fakeExec>[0];
  fetch?: typeof fetch;
  jiraFetch?: (url: string, init: RequestInit) => Promise<Response>;
  servers?: PluginMcpServer[];
  mcpAuth?: () => McpAuthState;
  probe?: (env: NodeJS.ProcessEnv) => Promise<'ok' | 'expired' | 'unknown'>;
  claudeBin?: string;
  isPrimary?: () => boolean;
  spawn?: ReturnType<typeof scriptedSpawner>['spawn'];
  now?: () => number;
  /** Additional Claude accounts: writes config.json and gives the env an account registry. */
  accounts?: Array<{ key: string; configDir?: string; source?: 'config_dir' | 'token' }>;
}) {
  const dir = tmp('aom-int-');
  const paths = runnerPaths(dir);
  mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logs, { recursive: true });
  const config = RunnerConfigSchema.parse({
    serverUrl: 'http://x',
    workstationId: WS,
    runnerToken: 'aomr_x',
    ...over.config,
  });
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  saveConfig(paths.config, config);
  const claudeAccounts = over.accounts
    ? new ClaudeAccountRegistry({
        home: dir,
        root: dir,
        secretsDir: paths.secrets,
        accounts: () => loadConfig(paths.config).runtimes['claude-code'].accounts,
        mainCredential: () => ({ authMode: 'default' }),
      })
    : undefined;
  if (over.accounts)
    saveConfig(paths.config, {
      ...config,
      runtimes: {
        ...config.runtimes,
        'claude-code': {
          ...config.runtimes['claude-code'],
          accounts: over.accounts.map((a) => ({ source: 'config_dir' as const, ...a })),
        },
      },
    });
  const ex = fakeExec(over.exec);
  const claudeStore = new ClaudeCredentialStore(claudeFile(paths.secrets));
  const afterChange: number[] = [];
  const logLines: string[] = [];
  const rec = (l: string) => (m: string, e?: unknown) =>
    void logLines.push(`${l} ${m}${e === undefined ? '' : ` ${JSON.stringify(e)}`}`);
  const env: AdapterEnv = {
    log: { info: rec('INFO'), warn: rec('WARN'), error: rec('ERROR') },
    paths,
    forge: {
      exec: ex.exec,
      fetch: over.fetch ?? (async () => new Response('{}', { status: 404 })),
      tokens: new MemoryTokenStore(),
    },
    exec: ex.exec,
    fetch: over.fetch ?? (async () => new Response('{}', { status: 404 })),
    config: () => config,
    now: () => new Date(),
    home: dir,
    claudeStore,
    claude: {
      bin: () => over.claudeBin ?? 'claude',
      probe: over.probe ?? (async () => 'ok'),
      probeLogin: async () => 'ok',
      authState: (k) => claudeAccounts?.get(k ?? 'main')?.auth.state ?? 'ok',
      afterChange: async () => void afterChange.push(Date.now()),
    },
    ...(claudeAccounts ? { claudeAccounts } : {}),
    mcp: {
      discover: () => over.servers ?? [],
      authOf: () => () => over.mcpAuth?.() ?? 'needs_sign_in',
    },
    repoHosts: () => ({}),
    sessionCwd: join(dir, 'tmp', 'integrations'),
    touchRecheck: () => undefined,
  };
  const sent: Sent[] = [];
  const sessions = (): IntegrationSessionMsg[] =>
    sent
      .filter((s) => s.type === 'integration.session')
      .map((s) => s.payload as unknown as IntegrationSessionMsg);
  const service = new IntegrationService({
    workstationId: WS,
    keys,
    env,
    adapters: buildIntegrationAdapters(env, over.jiraFetch ? { jiraFetch: over.jiraFetch } : {}),
    send: (type, payload) => void sent.push({ type, payload }),
    ...(over.spawn ? { spawn: over.spawn } : {}),
    ...(over.isPrimary ? { isPrimary: over.isPrimary } : {}),
    ...(over.now ? { now: over.now } : {}),
  });
  let n = 0;
  const seal = (
    kind: IntegrationKindId,
    instance: string,
    op: 'connect' | 'input',
    fields: Record<string, string>,
    o: { ref?: string; method?: string } = {},
  ) =>
    sealForRunner({
      publicKey: keys.publicKey.publicKey,
      keyId: keys.publicKey.keyId,
      workstationId: WS,
      ref: o.ref ?? `req-${++n}`,
      kind,
      instance,
      op,
      ...(o.method ? { method: o.method } : {}),
      fields,
      serverTimeMs: Date.now(),
    });
  const connect = async (
    kind: IntegrationKindId,
    instance: string,
    method: string,
    fields: Record<string, string>,
    ref = `req-${++n}`,
  ): Promise<IntegrationCommandResult> =>
    service.handle('integration.connect', {
      requestId: ref,
      kind,
      instance,
      method,
      envelope: await seal(kind, instance, 'connect', fields, { ref, method }),
    });
  const everything = () => JSON.stringify(sent) + readLog(paths.logs);
  return {
    logLines,
    dir,
    paths,
    keys,
    service,
    sent,
    sessions,
    seal,
    connect,
    claudeStore,
    afterChange,
    ex,
    env,
    config,
    everything,
  };
}

const readLog = (logs: string): string => {
  const f = join(logs, 'integrations.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

afterEach(() => unregisterSecret(TOKEN));

const jiraOk = (token: string) => async (url: string, init: RequestInit) => {
  const auth = (init.headers as Record<string, string>).authorization;
  const want = `Basic ${Buffer.from(`me@acme.com:${token}`).toString('base64')}`;
  return url.endsWith('/rest/api/2/myself') && auth === want
    ? new Response(JSON.stringify({ displayName: 'Pieter' }), { status: 200 })
    : new Response('{}', { status: 401 });
};

describe('connect from the web (fields methods)', () => {
  it('Jira: a refused token saves nothing; the right one is stored and reported', async () => {
    const t = setup({ jiraFetch: jiraOk('right-token-123') });
    const bad = await t.connect('jira', '', 'token', {
      baseUrl: 'https://acme.atlassian.net',
      email: 'me@acme.com',
      token: 'wrong-token-999',
    });
    expect(bad.error).toMatch(/did not accept/);
    expect(existsSync(join(t.paths.secrets, 'jira.json'))).toBe(false);
    const good = await t.connect('jira', '', 'token', {
      baseUrl: 'https://acme.atlassian.net/',
      email: 'me@acme.com',
      token: 'right-token-123',
    });
    expect(good.status).toMatchObject({
      kind: 'jira',
      state: 'connected',
      account: 'Pieter',
      site: 'https://acme.atlassian.net',
    });
    expect(JSON.parse(readFileSync(join(t.paths.secrets, 'jira.json'), 'utf8')).apiToken).toBe(
      'right-token-123',
    );
    const jiraState = () =>
      (
        t.sent.filter((s) => s.type === 'integrations.report').at(-1)?.payload as
          | { integrations: Array<{ kind: string; state: string }> }
          | undefined
      )?.integrations.find((i) => i.kind === 'jira')?.state;
    await until(() => jiraState() === 'connected', 'a report with Jira connected');
    // no secret anywhere the runner sent or logged
    expect(t.everything()).not.toContain('right-token-123');
    expect(t.everything()).not.toContain('wrong-token-999');
  });

  it('refuses a replayed envelope, another key, and unknown or later-phase methods', async () => {
    const t = setup({ jiraFetch: jiraOk('tok-abcdef-1') });
    const env = await t.seal(
      'jira',
      '',
      'connect',
      { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com', token: 'tok-abcdef-1' },
      { ref: 'same', method: 'token' },
    );
    const payload = { requestId: 'same', kind: 'jira', instance: '', method: 'token', envelope: env };
    expect((await t.service.handle('integration.connect', payload)).status?.state).toBe('connected');
    expect(await t.service.handle('integration.connect', payload)).toMatchObject({ code: 'replayed' });
    const wrongKey = { ...payload, requestId: 'r2', envelope: { ...env, keyId: 'ffffffffffffffff' } };
    expect(await t.service.handle('integration.connect', wrongKey)).toMatchObject({ code: 'key' });
    const e3 = await t.seal('jira', '', 'connect', { token: 'x' }, { ref: 'r3', method: 'nope' });
    expect(
      await t.service.handle('integration.connect', {
        requestId: 'r3',
        kind: 'jira',
        instance: '',
        method: 'nope',
        envelope: e3,
      }),
    ).toMatchObject({ code: 'unsupported' });
    const e4 = await t.seal('claude-code', '', 'connect', { x: 'y' }, { ref: 'r4', method: 'default_login' });
    expect(
      await t.service.handle('integration.connect', {
        requestId: 'r4',
        kind: 'claude-code',
        instance: '',
        method: 'default_login',
        envelope: e4,
      }),
    ).toMatchObject({ code: 'unsupported' });
  });

  it('claude API key: a key the probe calls expired is refused and not saved; a good one is saved and the runtime is told', async () => {
    const seen: Array<string | undefined> = [];
    const t = setup({
      probe: async (env) => {
        seen.push(env.ANTHROPIC_API_KEY);
        return env.ANTHROPIC_API_KEY === 'sk-ant-api03-good' ? 'ok' : 'expired';
      },
    });
    const bad = await t.connect('claude-code', '', 'api_key', { apiKey: 'sk-ant-api03-bad' });
    expect(bad).toMatchObject({ code: 'refused' });
    expect(t.claudeStore.load()).toBeUndefined();
    const good = await t.connect('claude-code', '', 'api_key', { apiKey: 'sk-ant-api03-good' });
    expect(good.status).toMatchObject({
      kind: 'claude-code',
      state: 'connected',
      method: 'api_key',
      scope: 'workstation',
    });
    expect(t.claudeStore.load()).toMatchObject({
      authMode: 'api_key',
      apiKey: 'sk-ant-api03-good',
      via: 'web',
    });
    expect(t.afterChange.length).toBe(1);
    expect(t.everything()).not.toContain('sk-ant-api03-good');
    expect(JSON.stringify(good)).not.toContain('sk-ant-api03-good');
  });

  it('claude token made elsewhere: stored, and the Claude adapter uses it at the next session without a restart', async () => {
    const t = setup({});
    expect(resolveClaudeCredential(t.claudeStore, t.config.runtimes['claude-code']).authMode).toBe('default');
    const r = await t.connect('claude-code', '', 'oauth_token', { oauthToken: TOKEN });
    expect(r.status).toMatchObject({ state: 'connected', method: 'oauth_token' });
    expect(r.status?.expiresAt).toBeDefined();
    const adapter = new ClaudeCodeAdapter(t.config.runtimes['claude-code'], t.paths, {
      credentials: () => resolveClaudeCredential(t.claudeStore, t.config.runtimes['claude-code']),
    });
    const env = (adapter as unknown as { probeEnv(): NodeJS.ProcessEnv }).probeEnv();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(statModeOk(claudeFile(t.paths.secrets))).toBe(true);
    t.claudeStore.remove();
    expect(
      (adapter as unknown as { probeEnv(): NodeJS.ProcessEnv }).probeEnv().CLAUDE_CODE_OAUTH_TOKEN,
    ).toBeUndefined();
  });

  it('GitHub token: handed to gh on stdin only, then setup-git, then the scopes are read', async () => {
    const t = setup({
      exec: [
        {
          match: (c, a) => c === 'gh' && a[0] === 'api',
          result: { stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: repo, read:org, gist\n\n{"login":"octo"}' },
        },
        {
          match: (c, a) => c === 'gh' && a[0] === 'auth' && a[1] === 'status',
          result: { stdout: 'Logged in to github.com account octo', stderr: '' },
        },
      ],
    });
    const r = await t.connect('github', 'github.com', 'token', { token: 'ghp_SECRETSECRETSECRET1234' });
    expect(r.status?.kind).toBe('github');
    const login = t.ex.calls.find((c) => c.args[0] === 'auth' && c.args[1] === 'login');
    expect(login?.args).toEqual(['auth', 'login', '--with-token', '--hostname', 'github.com']);
    expect(login?.input).toBe('ghp_SECRETSECRETSECRET1234\n');
    expect(t.ex.calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'setup-git')).toBe(true);
    expect(t.ex.calls.every((c) => !c.args.join(' ').includes('ghp_SECRET'))).toBe(true);
    expect(r.status?.scopes).toEqual(['repo', 'read:org', 'gist']);
    expect(t.everything()).not.toContain('ghp_SECRET');
  });

  it('Bitbucket and GitLab tokens go through the same saveAndVerify as git-connect; a refusal gives the provider reason', async () => {
    const fetchFn: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes('api.bitbucket.org/2.0/user'))
        return new Response(JSON.stringify({ nickname: 'bbuser' }), { status: 200 });
      if (u.includes('/api/v4/personal_access_tokens/self'))
        return new Response(
          JSON.stringify({ scopes: ['api', 'write_repository'], expires_at: '2027-01-31' }),
          { status: 200 },
        );
      if (u.includes('/api/v4/user'))
        return new Response(JSON.stringify({ username: 'gluser' }), { status: 200 });
      return new Response('{}', { status: 401 });
    };
    const t = setup({ fetch: fetchFn });
    const bb = await t.connect('bitbucket-cloud', '', 'token', {
      email: 'me@acme.com',
      token: 'bb-token-1234567',
    });
    expect(bb.status).toMatchObject({
      kind: 'bitbucket-cloud',
      state: 'connected',
      account: 'bbuser',
      scope: 'workstation',
    });
    const gl = await t.connect('gitlab', 'gitlab.com', 'token', { token: 'glpat-abcdefghij' });
    expect(gl.status).toMatchObject({
      kind: 'gitlab',
      state: 'connected',
      account: 'gluser',
      scopes: ['api', 'write_repository'],
    });
    expect(gl.status?.expiresAt).toBe('2027-01-31T23:59:59.000Z');
    expect(await t.connect('bitbucket-cloud', '', 'token', { token: 'only-token' })).toMatchObject({
      code: 'failed',
    });
  });

  it('Bitbucket without the read scope reports the missing-scope reason (#5)', async () => {
    const fetchFn: typeof fetch = async (url) => {
      const u = String(url);
      // /user refused (no account scope), the repository call refused too
      return u.includes('bitbucket')
        ? new Response('{}', { status: 403 })
        : new Response('{}', { status: 404 });
    };
    const t = setup({ fetch: fetchFn });
    const r = await t.connect('bitbucket-cloud', '', 'token', {
      email: 'me@acme.com',
      token: 'bb-token-1234567',
    });
    expect(r.code).toBe('refused');
    expect(r.error).toMatch(/scope/i);
  });
});

function statModeOk(file: string): boolean {
  return process.platform === 'win32' || (statSync(file).mode & 0o777) === 0o600;
}

describe('local policy (D8)', () => {
  it('web-submitted credentials off: connect, sign-in and remove are refused with the local switch named; test still works', async () => {
    const t = setup({
      config: { integrations: { allowWeb: false } },
      jiraFetch: jiraOk('x'),
      spawn: scriptedSpawner().spawn,
    });
    const r = await t.connect('jira', '', 'token', { baseUrl: 'https://a.net', token: 'abc-123-456' });
    expect(r).toMatchObject({ code: 'allow_web_off' });
    expect(r.error).toContain('guildwise-runner integrations allow-web on');
    expect(
      await t.service.handle('integration.begin', {
        sessionId: 's1',
        kind: 'claude-code',
        instance: '',
        method: 'setup_token',
      }),
    ).toMatchObject({ code: 'allow_web_off' });
    expect(
      await t.service.handle('integration.remove', { requestId: 'q', kind: 'jira', instance: '' }),
    ).toMatchObject({ code: 'allow_web_off' });
    const test = await t.service.handle('integration.test', { requestId: 'q2', kind: 'jira', instance: '' });
    expect(test.status?.state).toBe('not_connected');
    expect(t.service.policy()).toEqual({
      allowWeb: false,
      machineScopeFromWeb: 'primary',
      primaryPairing: true,
    });
  });

  it('a machine-wide login (gh) can only be changed from the primary pairing', async () => {
    const t = setup({ isPrimary: () => false });
    const r = await t.connect('github', 'github.com', 'token', { token: 'ghp_abcdefghijkl' });
    expect(r).toMatchObject({ code: 'machine_scope' });
    expect(t.ex.calls.length).toBe(0);
    // a workstation-scope kind is fine from any pairing
    const ok = await t.connect('claude-code', '', 'api_key', { apiKey: 'sk-ant-api03-zzz' });
    expect(ok.status?.state).toBe('connected');
    const never = setup({ config: { integrations: { machineScopeFromWeb: 'never' } } });
    expect(await never.connect('github', 'github.com', 'token', { token: 'ghp_abcdefghijkl' })).toMatchObject(
      { code: 'machine_scope' },
    );
  });
});

describe('Claude accounts: claude_login for an account instance', () => {
  const AUTH_STATUS = (loggedIn: boolean) => ({
    match: (cmd: string, args: string[]) => cmd === 'claude' && args[0] === 'auth' && args[1] === 'status',
    result: { stdout: JSON.stringify({ loggedIn, email: 'w@x.test' }) },
  });

  it('runs `claude auth login --claudeai` in the account folder; the pasted code goes in; finish marks the account ok', async () => {
    const sp = scriptedSpawner();
    const t = setup({
      spawn: sp.spawn,
      accounts: [{ key: 'work', configDir: '~/.claude-gw-work' }],
      exec: [AUTH_STATUS(true)],
    });
    const reg = t.env.claudeAccounts;
    expect(reg?.get('work')?.auth.state).toBe('none');
    const begun = await t.service.handle('integration.begin', {
      sessionId: 'sess-acct',
      kind: 'claude-code',
      instance: 'work',
      method: 'claude_login',
    });
    expect(begun).toEqual({ accepted: true });
    const proc = sp.procs[0];
    if (!proc) throw new Error('no process');
    expect(proc.spec).toMatchObject({ cmd: 'claude', args: ['auth', 'login', '--claudeai'], pty: true });
    expect(proc.spec.env?.CLAUDE_CONFIG_DIR).toBe(join(t.dir, '.claude-gw-work'));
    expect(proc.spec.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    proc.feed(fixture('claude-auth-login.txt'));
    await until(() => t.sessions().some((s) => s.state === 'awaiting_code'), 'awaiting_code');
    expect(t.sessions().find((s) => s.state === 'awaiting_code')?.prompt?.urlHost).toBe('claude.com');
    const input = await t.seal(
      'claude-code',
      'work',
      'input',
      { value: 'CODE#STATE' },
      { ref: 'sess-acct:1' },
    );
    expect(
      await t.service.handle('integration.input', {
        sessionId: 'sess-acct',
        kind: 'claude-code',
        instance: 'work',
        envelope: input,
      }),
    ).toEqual({ accepted: true });
    expect(proc.writes[0]).toBe('CODE#STATE');
    proc.feed('\r\nLogin successful\r\n');
    proc.exit(0);
    await until(() => t.sessions().some((s) => s.state === 'connected'), 'connected');
    const done = t.sessions().find((s) => s.state === 'connected');
    expect(done?.instance).toBe('work');
    expect(done?.status).toMatchObject({
      kind: 'claude-code',
      instance: 'work',
      state: 'connected',
      account: 'w@x.test',
    });
    expect(reg?.get('work')?.auth.state).toBe('ok');
    // the sign-in is in the runner log, with the account and folder but no URL, code or state
    expect(t.logLines.some((l) => l.includes('claude account work: sign-in started'))).toBe(true);
    expect(t.logLines.some((l) => l.includes('claude account work: sign-in finished'))).toBe(true);
    expect(t.logLines.join('\n')).not.toMatch(/https?:|CODE|STATE/);
    expect(t.afterChange.length).toBeGreaterThan(0);
    // the CLI was asked in the account's folder, with no stray token
    expect(t.ex.calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'status')).toBe(true);
  });

  it('finish without a login is an error with the terminal command', async () => {
    const sp = scriptedSpawner();
    const t = setup({
      spawn: sp.spawn,
      accounts: [{ key: 'work', configDir: '~/.claude-gw-work' }],
      exec: [AUTH_STATUS(false)],
    });
    await t.service.handle('integration.begin', {
      sessionId: 'sess-no',
      kind: 'claude-code',
      instance: 'work',
      method: 'claude_login',
    });
    const proc = sp.procs[0];
    if (!proc) throw new Error('no process');
    proc.feed(fixture('claude-auth-login.txt'));
    proc.exit(1);
    await until(() => t.sessions().some((s) => s.state === 'failed'), 'failed');
    expect(t.sessions().find((s) => s.state === 'failed')?.error).toContain(
      'CLAUDE_CONFIG_DIR=~/.claude-gw-work claude auth login',
    );
    expect(
      t.logLines.some(
        (l) => l.startsWith('WARN') && l.includes('claude account work: sign-in did not finish'),
      ),
    ).toBe(true);
  });

  it('refuses claude_login for the main account', async () => {
    const t = setup({ accounts: [{ key: 'work' }] });
    const r = await t.service.handle('integration.begin', {
      sessionId: 's',
      kind: 'claude-code',
      instance: '',
      method: 'claude_login',
    });
    expect(r).toMatchObject({ error: expect.stringMatching(/account key/) });
  });

  it('instances: main plus each account; status of an account; remove unregisters but keeps the folder', async () => {
    const t = setup({ accounts: [{ key: 'work', configDir: '~/.claude-gw-work' }] });
    mkdirSync(join(t.dir, '.claude-gw-work'), { recursive: true });
    const adapters = buildIntegrationAdapters(t.env);
    const a = adapters.get('claude-code');
    expect(await a?.instances()).toEqual(['', 'work']);
    expect((await a?.status('work'))?.state).toBe('not_connected');
    await a?.remove('work');
    expect(await a?.instances()).toEqual(['']);
    expect(loadConfig(t.paths.config).runtimes['claude-code'].accounts).toEqual([]);
    expect(existsSync(join(t.dir, '.claude-gw-work'))).toBe(true);
  });
});

describe('interactive sign-ins', () => {
  it('claude setup-token: URL and paste prompt out, the sealed code in, the token stored, the workstation switches to oauth', async () => {
    const sp = scriptedSpawner();
    const t = setup({ spawn: sp.spawn });
    const begun = await t.service.handle('integration.begin', {
      sessionId: 'sess-claude',
      kind: 'claude-code',
      instance: '',
      method: 'setup_token',
    });
    expect(begun).toEqual({ accepted: true });
    const proc = sp.procs[0];
    if (!proc) throw new Error('no process');
    expect(proc.spec).toMatchObject({ cmd: 'claude', args: ['setup-token'], pty: true });
    proc.feed(fixture('s1.raw.txt'));
    await until(() => t.sessions().some((s) => s.state === 'awaiting_code'), 'awaiting_code');
    const prompt = t.sessions().find((s) => s.state === 'awaiting_code')?.prompt;
    expect(prompt?.urlHost).toBe('claude.com');
    // the paste: sealed, op input, ref sessionId:1
    const input = await t.seal(
      'claude-code',
      '',
      'input',
      { value: 'CODE123#STATE456' },
      { ref: 'sess-claude:1' },
    );
    const got = await t.service.handle('integration.input', {
      sessionId: 'sess-claude',
      kind: 'claude-code',
      instance: '',
      envelope: input,
    });
    expect(got).toEqual({ accepted: true });
    expect(proc.writes[0]).toBe('CODE123#STATE456');
    await until(() => proc.writes.includes('\r'), 'the Enter key');
    // the same envelope again is a replay
    expect(
      await t.service.handle('integration.input', {
        sessionId: 'sess-claude',
        kind: 'claude-code',
        instance: '',
        envelope: input,
      }),
    ).toMatchObject({ code: 'replayed' });
    // the CLI prints the token and exits
    proc.feed(`\r\nYour long-lived token:\r\n${TOKEN}\r\n`);
    proc.exit(0);
    await until(() => t.sessions().some((s) => s.state === 'connected'), 'connected');
    expect(t.claudeStore.load()).toMatchObject({
      authMode: 'oauth',
      oauthToken: TOKEN,
      method: 'setup_token',
      via: 'web',
    });
    const done = t.sessions().find((s) => s.state === 'connected');
    expect(done?.status).toMatchObject({ kind: 'claude-code', state: 'connected', method: 'setup_token' });
    expect(t.afterChange.length).toBeGreaterThan(0);
    // neither the code nor the token went anywhere
    for (const secret of [TOKEN, 'CODE123', 'STATE456']) {
      expect(t.everything()).not.toContain(secret);
      expect(redact(`x ${secret} y`)).toContain('x ');
    }
  });

  it('claude setup-token: a wrong code ends the session as failed with the terminal fallback, never a hang', async () => {
    const sp = scriptedSpawner();
    const t = setup({ spawn: sp.spawn });
    await t.service.handle('integration.begin', {
      sessionId: 'sess-bad',
      kind: 'claude-code',
      instance: '',
      method: 'setup_token',
    });
    const proc = sp.procs[0];
    if (!proc) throw new Error('no process');
    proc.feed(fixture('s1.raw.txt'));
    await until(() => t.sessions().some((s) => s.state === 'awaiting_code'), 'awaiting_code');
    await t.service.handle('integration.input', {
      sessionId: 'sess-bad',
      kind: 'claude-code',
      instance: '',
      envelope: await t.seal('claude-code', '', 'input', { value: 'FAKE' }, { ref: 'sess-bad:1' }),
    });
    proc.feed(fixture('s1b.raw.txt'));
    await until(() => t.sessions().some((s) => s.state === 'failed'), 'failed');
    expect(t.sessions().at(-1)?.error).toMatch(/did not accept the code/);
    expect(proc.killed).toBe(true);
    expect(t.claudeStore.load()).toBeUndefined();
  });

  it('claude setup-token: output nobody understands ends in failed with the terminal command after the exit', async () => {
    const sp = scriptedSpawner();
    const t = setup({ spawn: sp.spawn });
    await t.service.handle('integration.begin', {
      sessionId: 'sess-odd',
      kind: 'claude-code',
      instance: '',
      method: 'setup_token',
    });
    sp.procs[0]?.feed('Something new\r\n');
    sp.procs[0]?.exit(1);
    await until(() => t.sessions().some((s) => s.state === 'failed'), 'failed');
    expect(t.sessions().at(-1)?.error).toContain('claude setup-token');
  });

  it('the session times out into expired', async () => {
    const sp = scriptedSpawner();
    const dir = setup({ spawn: sp.spawn });
    const short = new IntegrationService({
      workstationId: WS,
      keys: dir.keys,
      env: dir.env,
      adapters: buildIntegrationAdapters(dir.env),
      send: (type, payload) => void dir.sent.push({ type, payload }),
      spawn: sp.spawn,
      sessionLimitMs: 80,
    });
    await short.handle('integration.begin', {
      sessionId: 'sess-slow',
      kind: 'claude-code',
      instance: '',
      method: 'setup_token',
    });
    await until(() => dir.sessions().some((s) => s.state === 'expired'), 'expired');
    expect(sp.procs[0]?.killed).toBe(true);
  });

  const server: PluginMcpServer = {
    name: 'plugin_atlassian_atlassian',
    key: 'plugin:atlassian:atlassian',
    plugin: 'atlassian',
    server: 'atlassian',
    transport: 'http',
    root: '/x',
    config: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' },
  };

  it('MCP: a wrong address is asked for again, the right one finishes; the sign-in shows up as connected', async () => {
    const sp = scriptedSpawner();
    let signedIn = false;
    const t = setup({
      spawn: sp.spawn,
      servers: [server],
      mcpAuth: () => (signedIn ? 'signed_in' : 'needs_sign_in'),
    });
    const st = await t.service.handle('integration.test', {
      requestId: 'q',
      kind: 'mcp',
      instance: server.name,
    });
    expect(st.status).toMatchObject({ state: 'needs_sign_in', scope: 'machine', site: 'mcp.atlassian.com' });
    await t.service.handle('integration.begin', {
      sessionId: 'sess-mcp',
      kind: 'mcp',
      instance: server.name,
      method: 'oauth_paste',
    });
    const proc = sp.procs[0];
    if (!proc) throw new Error('no process');
    expect(proc.spec.args).toEqual(['mcp', 'login', 'plugin:atlassian:atlassian', '--no-browser']);
    proc.feed(fixture('s2.raw.txt').split('http://localhost:1234')[0] as string);
    await until(() => t.sessions().some((s) => s.state === 'awaiting_code'), 'awaiting_code');
    expect(t.sessions().find((s) => s.state === 'awaiting_code')?.prompt).toMatchObject({
      urlHost: 'mcp.atlassian.com',
      inputKind: 'redirect_url',
    });
    // first paste: not the right address
    await t.service.handle('integration.input', {
      sessionId: 'sess-mcp',
      kind: 'mcp',
      instance: server.name,
      envelope: await t.seal(
        'mcp',
        server.name,
        'input',
        { value: 'http://localhost:1/callback?code=A&state=B' },
        { ref: 'sess-mcp:1' },
      ),
    });
    proc.feed(
      "\r\nThat doesn't look like a redirect URL for this sign-in\r\n\x1b[1G\x1b[0JOr paste the redirect URL here: ",
    );
    await until(() => t.sessions().at(-1)?.error !== undefined, 'the retry message');
    expect(t.sessions().at(-1)).toMatchObject({ state: 'awaiting_code' });
    expect(t.sessions().at(-1)?.error).toMatch(/did not match/);
    // second paste works: the CLI stores the sign-in and exits
    await t.service.handle('integration.input', {
      sessionId: 'sess-mcp',
      kind: 'mcp',
      instance: server.name,
      envelope: await t.seal(
        'mcp',
        server.name,
        'input',
        { value: 'http://localhost:1/callback?code=GOOD&state=OK' },
        { ref: 'sess-mcp:2' },
      ),
    });
    signedIn = true;
    proc.exit(0);
    await until(() => t.sessions().some((s) => s.state === 'connected'), 'connected');
    expect(t.sessions().at(-1)?.status).toMatchObject({ kind: 'mcp', state: 'connected' });
    expect(t.everything()).not.toContain('code=GOOD');
    // a fourth paste would be refused
    expect(
      await t.service.handle('integration.input', {
        sessionId: 'sess-mcp',
        kind: 'mcp',
        instance: server.name,
        envelope: await t.seal('mcp', server.name, 'input', { value: 'x' }, { ref: 'sess-mcp:3' }),
      }),
    ).toMatchObject({ code: 'expired' });
  });

  it('GitHub device: the code and link go out, exit 0 runs setup-git and reports connected', async () => {
    const sp = scriptedSpawner();
    const t = setup({
      spawn: sp.spawn,
      exec: [
        {
          match: (c, a) => c === 'gh' && a[0] === 'auth' && a[1] === 'status',
          result: { stdout: 'Logged in to github.com account octo' },
        },
      ],
    });
    await t.service.handle('integration.begin', {
      sessionId: 'sess-gh',
      kind: 'github',
      instance: 'github.com',
      method: 'device',
    });
    const proc = sp.procs[0];
    if (!proc) throw new Error('no process');
    expect(proc.spec).toMatchObject({ cmd: 'gh', pty: false });
    proc.feed(fixture('s3.raw.txt'));
    await until(() => t.sessions().some((s) => s.state === 'awaiting_user'), 'awaiting_user');
    const p = t.sessions().find((s) => s.state === 'awaiting_user')?.prompt;
    expect(p).toMatchObject({ url: 'https://github.com/login/device', inputKind: 'none' });
    expect(p?.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    proc.exit(0);
    await until(() => t.sessions().some((s) => s.state === 'connected'), 'connected');
    expect(t.ex.calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'setup-git')).toBe(true);
  });

  it('one sign-in per kind and instance, and a new one needs the old one finished', async () => {
    const sp = scriptedSpawner();
    const t = setup({ spawn: sp.spawn });
    expect(
      await t.service.handle('integration.begin', {
        sessionId: 'a',
        kind: 'claude-code',
        instance: '',
        method: 'setup_token',
      }),
    ).toEqual({ accepted: true });
    expect(
      await t.service.handle('integration.begin', {
        sessionId: 'b',
        kind: 'claude-code',
        instance: '',
        method: 'setup_token',
      }),
    ).toMatchObject({ code: 'busy' });
    await t.service.handle('integration.cancel', { sessionId: 'a' });
    await until(() => t.sessions().some((s) => s.state === 'cancelled'), 'cancelled');
    expect(sp.procs[0]?.killed).toBe(true);
    expect(
      await t.service.handle('integration.begin', {
        sessionId: 'c',
        kind: 'claude-code',
        instance: '',
        method: 'setup_token',
      }),
    ).toEqual({ accepted: true });
  });
});

describe('real pseudo-terminal (script(1)) with a fake CLI', () => {
  const hasScript = existsSync('/usr/bin/script') && process.platform === 'linux';
  it.skipIf(!hasScript)(
    'drives a terminal program end to end: link, prompt, paste, token, exit',
    async () => {
      const dir = tmp('aom-fakeclaude-');
      const bin = join(dir, 'claude');
      // A stand-in for `claude setup-token`: prints the link as an OSC 8 hyperlink, asks for a code, answers with a token.
      writeFileSync(
        bin,
        `#!${process.execPath}
const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s';
process.stdout.write('\\x1b]8;id=1;' + url + '\\x07' + url.slice(0, 40) + '\\x1b]8;;\\x07\\r\\n');
process.stdout.write('Paste code here if prompted > ');
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  if (buf.includes('\\r') || buf.includes('\\n')) {
    process.stdout.write('\\r\\nToken: ${TOKEN}\\r\\n');
    setTimeout(() => process.exit(0), 100);
  }
});
`,
      );
      chmodSync(bin, 0o755);
      const t = setup({ claudeBin: bin });
      expect(
        await t.service.handle('integration.begin', {
          sessionId: 'sess-real',
          kind: 'claude-code',
          instance: '',
          method: 'setup_token',
        }),
      ).toEqual({ accepted: true });
      await until(() => t.sessions().some((s) => s.state === 'awaiting_code'), 'the paste prompt', 8000);
      expect(t.sessions().find((s) => s.state === 'awaiting_code')?.prompt?.url).toContain(
        'https://claude.com/cai/oauth/authorize',
      );
      await t.service.handle('integration.input', {
        sessionId: 'sess-real',
        kind: 'claude-code',
        instance: '',
        envelope: await t.seal('claude-code', '', 'input', { value: 'PASTED-CODE' }, { ref: 'sess-real:1' }),
      });
      await until(() => t.sessions().some((s) => s.state === 'connected'), 'connected', 8000);
      expect(t.claudeStore.load()?.oauthToken).toBe(TOKEN);
      expect(t.everything()).not.toContain(TOKEN);
    },
    20_000,
  );
});

describe('report', () => {
  it('lists every kind it has instances for, only re-sends on change, and sees a change made by the CLI', async () => {
    const t = setup({ servers: [], jiraFetch: jiraOk('tok-1234567') });
    await t.service.report(true);
    const first = t.sent.at(-1)?.payload as {
      integrations: Array<{ kind: string; instance: string; state: string }>;
      policy: { allowWeb: boolean };
    };
    expect(first.policy.allowWeb).toBe(true);
    const kinds = first.integrations.map((i) => i.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['claude-code', 'github', 'gitlab', 'bitbucket-cloud', 'jira']),
    );
    const n = t.sent.length;
    await t.service.report(false);
    expect(t.sent.length).toBe(n);
    // `aom-runner auth api-key` writes the same store the page does
    t.claudeStore.save({ authMode: 'api_key', apiKey: 'sk-ant-api03-cli', via: 'cli' });
    await t.service.report(false);
    const second = t.sent.at(-1)?.payload as typeof first;
    expect(second.integrations.find((i) => i.kind === 'claude-code')).toMatchObject({
      state: 'connected',
      method: 'api_key',
    });
    expect(JSON.stringify(t.sent)).not.toContain('sk-ant-api03-cli');
  });
});
