import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type IntegrationKindId, type IntegrationSessionMsg, sealForRunner } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { codexMainFolder } from '../src/adapters/codex.ts';
import { geminiMainFolder } from '../src/adapters/gemini.ts';
import { CODEX_DEF, GEMINI_DEF, LoginAccountRegistry } from '../src/adapters/login-accounts.ts';
import { loadConfig, RunnerConfigSchema, saveConfig } from '../src/config.ts';
import { MemoryTokenStore } from '../src/forge/index.ts';
import { ClaudeCredentialStore, claudeFile } from '../src/integrations/claude-store.ts';
import { buildIntegrationAdapters, IntegrationService } from '../src/integrations/index.ts';
import type { AdapterEnv } from '../src/integrations/types.ts';
import { runnerPaths } from '../src/paths.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { fakeExec, fixture, scriptedSpawner, until } from './integrations-helpers.ts';

cleanupTmp();

const WS = '22222222-2222-4222-8222-222222222222';

function setup(over: { installed?: boolean; primary?: boolean } = {}) {
  const dir = tmp('aom-lint-');
  const paths = runnerPaths(join(dir, 'runner-data'));
  mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logs, { recursive: true });
  saveConfig(
    paths.config,
    RunnerConfigSchema.parse({ serverUrl: 'http://x', workstationId: WS, runnerToken: 'aomr_x' }),
  );
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const config = () => loadConfig(paths.config);
  const codex = new LoginAccountRegistry({
    def: CODEX_DEF,
    home: dir,
    accounts: () => config().runtimes.codex?.accounts ?? [],
    mainFolder: () => codexMainFolder(config().runtimes.codex, dir, {}),
  });
  const gemini = new LoginAccountRegistry({
    def: GEMINI_DEF,
    home: dir,
    accounts: () => config().runtimes.gemini?.accounts ?? [],
    mainFolder: () => geminiMainFolder(config().runtimes.gemini, dir, {}),
  });
  const ex = fakeExec();
  const changes: number[] = [];
  const logLines: string[] = [];
  const rec = (l: string) => (m: string, e?: unknown) =>
    void logLines.push(`${l} ${m}${e === undefined ? '' : ` ${JSON.stringify(e)}`}`);
  const installed = over.installed ?? true;
  const env: AdapterEnv = {
    log: { info: rec('INFO'), warn: rec('WARN'), error: rec('ERROR') },
    paths,
    forge: { exec: ex.exec, fetch: async () => new Response('{}'), tokens: new MemoryTokenStore() },
    exec: ex.exec,
    fetch: async () => new Response('{}'),
    config,
    now: () => new Date(),
    home: dir,
    claudeStore: new ClaudeCredentialStore(claudeFile(paths.secrets)),
    claude: {
      bin: () => 'claude',
      probe: async () => 'ok',
      probeLogin: async () => 'ok',
      authState: () => 'ok',
      afterChange: async () => undefined,
    },
    loginRuntimes: {
      codex: {
        registry: codex,
        bin: () => (installed ? '/fake/codex' : undefined),
        afterChange: () => void changes.push(1),
      },
      gemini: {
        registry: gemini,
        bin: () => (installed ? '/fake/gemini' : undefined),
        afterChange: () => void changes.push(2),
      },
    },
    mcp: { discover: () => [], authOf: () => () => 'needs_sign_in' },
    repoHosts: () => ({}),
    sessionCwd: join(dir, 'tmp', 'integrations'),
    touchRecheck: () => undefined,
  };
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sp = scriptedSpawner();
  const service = new IntegrationService({
    workstationId: WS,
    keys,
    env,
    adapters: buildIntegrationAdapters(env),
    send: (type, payload) => void sent.push({ type, payload }),
    spawn: sp.spawn,
    ...(over.primary === false ? { isPrimary: () => false } : {}),
  });
  const sessions = (): IntegrationSessionMsg[] =>
    sent
      .filter((s) => s.type === 'integration.session')
      .map((s) => s.payload as unknown as IntegrationSessionMsg);
  const seal = (kind: IntegrationKindId, instance: string, ref: string, value: string) =>
    sealForRunner({
      publicKey: keys.publicKey.publicKey,
      keyId: keys.publicKey.keyId,
      workstationId: WS,
      ref,
      kind,
      instance,
      op: 'input',
      fields: { value },
      serverTimeMs: Date.now(),
    });
  return { dir, paths, service, env, codex, gemini, sp, sessions, seal, changes, logLines, config };
}

const writeCodexLogin = (folder: string) => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'tok',
        id_token: `h.${Buffer.from(JSON.stringify({ email: 'w@x.test' })).toString('base64url')}.s`,
      },
    }),
  );
};

describe('Codex sign-in for an account (integration kind `codex`)', () => {
  it('runs `codex login --device-auth` with CODEX_HOME set to the account folder and shows the link and the code', async () => {
    const t = setup();
    const begun = await t.service.handle('integration.begin', {
      sessionId: 's-codex',
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
    expect(begun).toEqual({ accepted: true });
    const proc = t.sp.procs[0];
    if (!proc) throw new Error('no process');
    expect(proc.spec).toMatchObject({ cmd: '/fake/codex', args: ['login', '--device-auth'], pty: true });
    expect(proc.spec.env?.CODEX_HOME).toBe(join(t.dir, '.codex-gw-work'));
    // the account was set up first: folder with a marker, and a config entry
    expect(existsSync(join(t.dir, '.codex-gw-work', '.aom-runner-owned'))).toBe(true);
    expect(loadConfig(t.paths.config).runtimes.codex?.accounts).toEqual([{ key: 'work' }]);
    proc.feed(fixture('codex-device-auth.txt'));
    await until(() => t.sessions().some((s) => s.state === 'awaiting_user'), 'awaiting_user');
    const prompt = t.sessions().find((s) => s.state === 'awaiting_user')?.prompt;
    expect(prompt).toMatchObject({ urlHost: 'auth.openai.com', userCode: 'AB12-CD345', inputKind: 'none' });
    // the user approved in the browser: the CLI writes its login and exits
    writeCodexLogin(join(t.dir, '.codex-gw-work'));
    proc.feed('\r\nSuccessfully logged in\r\n');
    proc.exit(0);
    await until(() => t.sessions().some((s) => s.state === 'connected'), 'connected');
    const done = t.sessions().find((s) => s.state === 'connected');
    expect(done?.status).toMatchObject({
      kind: 'codex',
      instance: 'work',
      state: 'connected',
      account: 'w@x.test',
    });
    expect(t.codex.get('work')?.auth.state).toBe('ok');
    expect(t.changes.length).toBeGreaterThan(0);
    expect(t.logLines.join('\n')).not.toMatch(/AB12|auth\.openai|tok/);
  });

  it('a sign-in that ends without a login is an error with the terminal command', async () => {
    const t = setup();
    await t.service.handle('integration.begin', {
      sessionId: 's2',
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
    const proc = t.sp.procs[0];
    if (!proc) throw new Error('no process');
    proc.feed(fixture('codex-device-auth.txt'));
    proc.exit(1);
    await until(() => t.sessions().some((s) => s.state === 'failed'), 'failed');
    expect(t.sessions().find((s) => s.state === 'failed')?.error).toContain(
      'CODEX_HOME=~/.codex-gw-work codex login --device-auth',
    );
  });

  it('signs the main account in at the owner’s own folder', async () => {
    const t = setup();
    await t.service.handle('integration.begin', {
      sessionId: 's3',
      kind: 'codex',
      instance: '',
      method: 'codex_login',
    });
    expect(t.sp.procs[0]?.spec.env?.CODEX_HOME).toBe(join(t.dir, '.codex'));
    expect(loadConfig(t.paths.config).runtimes.codex?.accounts ?? []).toEqual([]);
  });

  it('a link to a host that is not OpenAI’s is never shown', async () => {
    const t = setup();
    await t.service.handle('integration.begin', {
      sessionId: 's4',
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
    t.sp.procs[0]?.feed('1. Open https://evil.example.com/codex/device\n2. Enter the code AB12-CD345\n');
    await new Promise((r) => setTimeout(r, 60));
    expect(JSON.stringify(t.sessions())).not.toContain('evil.example.com');
  });

  it('refuses when the program is not installed, and says so in the status', async () => {
    const t = setup({ installed: false });
    const r = await t.service.handle('integration.begin', {
      sessionId: 's5',
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
    expect(r).toMatchObject({ code: 'unavailable', error: expect.stringContaining('not installed') });
    const status = await t.service.adapters.get('codex')?.status('');
    expect(status).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('not installed') });
  });

  it('is a machine-wide login: only the primary pairing may start it from the web', async () => {
    const t = setup({ primary: false });
    const r = await t.service.handle('integration.begin', {
      sessionId: 's6',
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
    expect(r).toMatchObject({ code: 'machine_scope' });
    expect(t.sp.procs).toHaveLength(0);
  });

  it('status and remove: a named account goes (with the login the runner stored), main is never removed from here', async () => {
    const t = setup();
    await t.service.handle('integration.begin', {
      sessionId: 's7',
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
    writeCodexLogin(join(t.dir, '.codex-gw-work'));
    const codex = t.service.adapters.get('codex');
    expect(await codex?.instances()).toEqual(['', 'work']);
    expect((await codex?.status('work'))?.state).toBe('connected');
    const rm = await t.service.handle('integration.remove', {
      requestId: 'r1',
      kind: 'codex',
      instance: 'work',
    });
    expect(rm.error).toBeUndefined();
    expect(existsSync(join(t.dir, '.codex-gw-work'))).toBe(false);
    expect(loadConfig(t.paths.config).runtimes.codex?.accounts).toEqual([]);
    const main = await t.service.handle('integration.remove', {
      requestId: 'r2',
      kind: 'codex',
      instance: '',
    });
    expect(main).toMatchObject({ code: 'unsupported' });
  });

  it('a folder the runner did not create is only unregistered when the account is removed', async () => {
    const t = setup();
    const cfg = loadConfig(t.paths.config);
    saveConfig(t.paths.config, {
      ...cfg,
      runtimes: {
        ...cfg.runtimes,
        codex: {
          enabled: true,
          authMode: 'login',
          toolchainPaths: [],
          accounts: [{ key: 'mine', loginDir: '~/.codex-mine' }],
        },
      },
    });
    writeCodexLogin(join(t.dir, '.codex-mine'));
    await t.service.handle('integration.remove', { requestId: 'r3', kind: 'codex', instance: 'mine' });
    expect(existsSync(join(t.dir, '.codex-mine', 'auth.json'))).toBe(true);
    expect(loadConfig(t.paths.config).runtimes.codex?.accounts).toEqual([]);
  });
});

describe('Gemini CLI sign-in for an account (integration kind `gemini`)', () => {
  it('starts the CLI with its own home and NO_BROWSER, shows the Google link, and takes the pasted code', async () => {
    const t = setup();
    expect(
      await t.service.handle('integration.begin', {
        sessionId: 'g1',
        kind: 'gemini',
        instance: 'work',
        method: 'gemini_login',
      }),
    ).toEqual({ accepted: true });
    const proc = t.sp.procs[0];
    if (!proc) throw new Error('no process');
    expect(proc.spec).toMatchObject({ cmd: '/fake/gemini', args: [], pty: true });
    expect(proc.spec.env).toMatchObject({
      GEMINI_CLI_HOME: join(t.dir, '.gemini-gw-work'),
      NO_BROWSER: 'true',
      GEMINI_FORCE_FILE_STORAGE: 'true',
    });
    // the CLI is told to start on the Google login, with no other settings
    const settings = JSON.parse(
      readFileSync(join(t.dir, '.gemini-gw-work', '.gemini', 'settings.json'), 'utf8'),
    ) as object;
    expect(settings).toEqual({ security: { auth: { selectedType: 'oauth-personal' } } });
    proc.feed(fixture('gemini-login.txt'));
    await until(() => t.sessions().some((s) => s.state === 'awaiting_code'), 'awaiting_code');
    expect(t.sessions().find((s) => s.state === 'awaiting_code')?.prompt).toMatchObject({
      urlHost: 'accounts.google.com',
      inputKind: 'code',
    });
    const input = await t.seal('gemini', 'work', 'g1:1', '4/0AbCdEf');
    expect(
      await t.service.handle('integration.input', {
        sessionId: 'g1',
        kind: 'gemini',
        instance: 'work',
        envelope: input,
      }),
    ).toEqual({ accepted: true });
    expect(proc.writes[0]).toBe('4/0AbCdEf');
    // the CLI stored the login: the session ends connected without waiting for the CLI to quit
    mkdirSync(join(t.dir, '.gemini-gw-work', '.gemini'), { recursive: true });
    writeFileSync(
      join(t.dir, '.gemini-gw-work', '.gemini', 'oauth_creds.json'),
      JSON.stringify({ access_token: 'g', refresh_token: 'r' }),
    );
    writeFileSync(
      join(t.dir, '.gemini-gw-work', '.gemini', 'google_accounts.json'),
      JSON.stringify({ active: 'me@gmail.test' }),
    );
    proc.feed('\r\nLoaded cached credentials.\r\n');
    await until(() => t.sessions().some((s) => s.state === 'connected'), 'connected', 8000);
    expect(t.sessions().find((s) => s.state === 'connected')?.status).toMatchObject({
      kind: 'gemini',
      instance: 'work',
      account: 'me@gmail.test',
    });
    expect(t.gemini.get('work')?.auth.state).toBe('ok');
    expect(t.logLines.join('\n')).not.toMatch(/4\/0AbCdEf|accounts\.google/);
  });

  it('refuses a method of another kind and an account without a program', async () => {
    const t = setup();
    expect(
      await t.service.handle('integration.begin', {
        sessionId: 'g2',
        kind: 'gemini',
        instance: 'work',
        method: 'codex_login',
      }),
    ).toMatchObject({ error: expect.any(String) });
    const none = setup({ installed: false });
    expect(
      await none.service.handle('integration.begin', {
        sessionId: 'g3',
        kind: 'gemini',
        instance: 'work',
        method: 'gemini_login',
      }),
    ).toMatchObject({ code: 'unavailable' });
  });
});
