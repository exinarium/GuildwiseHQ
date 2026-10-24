import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAdapter, codexHomeOf, codexMainFolder } from '../src/adapters/codex.ts';
import { GeminiAdapter, geminiHomeOf, geminiMainFolder } from '../src/adapters/gemini.ts';
import {
  CODEX_DEF,
  ensureLoginAccount,
  GEMINI_DEF,
  LoginAccountRegistry,
  registerLoginAccount,
  swapMainLoginAccount,
  unregisterLoginAccount,
} from '../src/adapters/login-accounts.ts';
import type { RuntimeEvent, RuntimeSession, ShiftStartInput } from '../src/adapters/types.ts';
import { loadConfig, RunnerConfigSchema, saveConfig } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const j = (o: object): string => JSON.stringify(o);
const jwt = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const LOGIN = (access: string, email = 'a@x.test', last = '2026-01-01T00:00:00Z') =>
  j({
    tokens: { access_token: access, id_token: jwt(email), refresh_token: `r-${access}` },
    last_refresh: last,
  });

function machine() {
  const home = tmp('aom-acct-home-');
  const root = tmp('aom-acct-root-');
  const paths = runnerPaths(root);
  mkdirSync(paths.secrets, { recursive: true });
  saveConfig(
    paths.config,
    RunnerConfigSchema.parse({ serverUrl: 'http://x', workstationId: 'w', runnerToken: 't' }),
  );
  const codexRegistry = (now?: () => Date) =>
    new LoginAccountRegistry({
      def: CODEX_DEF,
      home,
      stateFile: join(root, 'codex-accounts-state.json'),
      accounts: () => loadConfig(paths.config).runtimes.codex?.accounts ?? [],
      mainFolder: () => codexMainFolder(loadConfig(paths.config).runtimes.codex, home, {}),
      ...(now ? { now } : {}),
    });
  const geminiRegistry = () =>
    new LoginAccountRegistry({
      def: GEMINI_DEF,
      home,
      stateFile: join(root, 'gemini-accounts-state.json'),
      accounts: () => loadConfig(paths.config).runtimes.gemini?.accounts ?? [],
      mainFolder: () => geminiMainFolder(loadConfig(paths.config).runtimes.gemini, home, {}),
    });
  return { home, root, paths, codexRegistry, geminiRegistry };
}

describe('login accounts: where each runtime keeps them', () => {
  it('Codex: main is ~/.codex, a named account is its own CODEX_HOME', () => {
    const m = machine();
    mkdirSync(join(m.home, '.codex'), { recursive: true });
    writeFileSync(join(m.home, '.codex', 'auth.json'), LOGIN('main-token', 'main@x.test'));
    registerLoginAccount(m.paths.config, 'codex', { key: 'work' });
    const reg = m.codexRegistry();
    expect(reg.main.folder).toBe(join(m.home, '.codex'));
    expect(reg.get('work')?.folder).toBe(join(m.home, '.codex-gw-work'));
    const infos = reg.infos();
    expect(infos.map((i) => i.key)).toEqual(['main', 'work']);
    expect(infos[0]).toMatchObject({ main: true, login: 'ok', email: 'main@x.test', configDir: '~/.codex' });
    expect(infos[1]).toMatchObject({ main: false, login: 'none', configDir: '~/.codex-gw-work' });
    expect(infos[1]?.detail).toContain('CODEX_HOME=~/.codex-gw-work codex login');
  });

  it('Gemini: main is ~/.gemini, a named account is a GEMINI_CLI_HOME with the login inside .gemini', () => {
    const m = machine();
    mkdirSync(join(m.home, '.gemini'), { recursive: true });
    writeFileSync(
      join(m.home, '.gemini', 'oauth_creds.json'),
      j({ access_token: 'g-main', refresh_token: 'r' }),
    );
    writeFileSync(join(m.home, '.gemini', 'google_accounts.json'), j({ active: 'me@gmail.test' }));
    registerLoginAccount(m.paths.config, 'gemini', { key: 'work' });
    const reg = m.geminiRegistry();
    expect(reg.main.folder).toBe(join(m.home, '.gemini'));
    expect(reg.get('work')?.root).toBe(join(m.home, '.gemini-gw-work'));
    expect(reg.get('work')?.folder).toBe(join(m.home, '.gemini-gw-work', '.gemini'));
    expect(reg.main.info()).toMatchObject({ login: 'ok', email: 'me@gmail.test' });
    expect(reg.get('work')?.info().login).toBe('none');
  });

  it('the agent’s home is one per account per agent', () => {
    const base = '/r/agents/ag1';
    expect(codexHomeOf({ configDir: `${base}/claude` })).toBe(`${base}/codex`);
    expect(codexHomeOf({ configDir: `${base}/claude-acct-work` })).toBe(`${base}/codex-acct-work`);
    expect(geminiHomeOf({ configDir: `${base}/claude` })).toBe(`${base}/gemini`);
    expect(geminiHomeOf({ configDir: `${base}/claude-acct-work` })).toBe(`${base}/gemini-acct-work`);
  });

  it('notices a login made in a terminal, a login that went, and a limit that has reset', () => {
    const m = machine();
    registerLoginAccount(m.paths.config, 'codex', { key: 'work' });
    let now = new Date('2026-10-24T10:00:00Z');
    const reg = m.codexRegistry(() => now);
    const work = reg.get('work');
    if (!work) throw new Error('no account');
    expect(work.auth.state).toBe('none');
    mkdirSync(work.folder, { recursive: true });
    writeFileSync(join(work.folder, 'auth.json'), LOGIN('t1'));
    expect(reg.poll().map((a) => a.key)).toEqual(['work']);
    expect(work.auth.state).toBe('ok');
    expect(reg.anyUsable()).toBe(true);
    // the file goes away: none again
    writeFileSync(join(work.folder, 'auth.json'), '{}');
    utimesSync(join(work.folder, 'auth.json'), new Date(), new Date(Date.now() + 5000));
    reg.poll();
    expect(work.auth.state).toBe('none');
    // a limit
    work.auth.markOk();
    work.usage.markLimited(new Date('2026-10-24T12:00:00Z'));
    expect(work.usable).toBe(false);
    expect(work.info()).toMatchObject({ usage: 'limited', limitedUntil: '2026-10-24T12:00:00.000Z' });
    reg.poll();
    expect(work.usage.state).toBe('limited');
    now = new Date('2026-10-24T12:00:01Z');
    reg.poll();
    expect(work.usage.state).toBe('ok');
  });

  it('remembers an expired login and a limit across a restart', () => {
    const m = machine();
    registerLoginAccount(m.paths.config, 'codex', { key: 'work' });
    mkdirSync(join(m.home, '.codex-gw-work'), { recursive: true });
    writeFileSync(join(m.home, '.codex-gw-work', 'auth.json'), LOGIN('t'));
    const a = m.codexRegistry();
    const work = a.get('work');
    work?.auth.markExpired();
    work?.usage.markLimited(new Date(Date.now() + 3600_000));
    const b = m.codexRegistry();
    expect(b.get('work')?.auth.state).toBe('expired');
    expect(b.get('work')?.usage.state).toBe('limited');
    expect(b.main.auth.state).toBe('none');
  });
});

describe('login accounts: setting one up, removing it, making it main', () => {
  it('creates a runner-owned folder with a marker and registers it; idempotent', () => {
    const m = machine();
    const deps = {
      home: m.home,
      root: m.root,
      configPath: m.paths.config,
      mainFolder: join(m.home, '.codex'),
    };
    const r = ensureLoginAccount(CODEX_DEF, 'work', deps);
    expect(r).toMatchObject({ ok: true, root: join(m.home, '.codex-gw-work') });
    expect(existsSync(join(m.home, '.codex-gw-work', '.aom-runner-owned'))).toBe(true);
    expect(loadConfig(m.paths.config).runtimes.codex?.accounts).toEqual([{ key: 'work' }]);
    expect(ensureLoginAccount(CODEX_DEF, 'work', deps).ok).toBe(true);
    expect(loadConfig(m.paths.config).runtimes.codex?.accounts).toHaveLength(1);
    const g = ensureLoginAccount(GEMINI_DEF, 'work', { ...deps, mainFolder: join(m.home, '.gemini') });
    expect(g).toMatchObject({ ok: true, root: join(m.home, '.gemini-gw-work') });
    expect(existsSync(join(m.home, '.gemini-gw-work', '.gemini'))).toBe(true);
  });

  it('never adopts a folder it did not create, and refuses the main folder and the data folder', () => {
    const m = machine();
    mkdirSync(join(m.home, '.codex-gw-work'), { recursive: true });
    writeFileSync(join(m.home, '.codex-gw-work', 'auth.json'), LOGIN('someone-elses'));
    const deps = {
      home: m.home,
      root: m.root,
      configPath: m.paths.config,
      mainFolder: join(m.home, '.codex'),
    };
    expect(ensureLoginAccount(CODEX_DEF, 'work', deps)).toMatchObject({
      ok: false,
      error: expect.stringContaining('was not created by Guildwise'),
    });
    expect(loadConfig(m.paths.config).runtimes.codex?.accounts ?? []).toEqual([]);
    // the owner may register a folder on purpose (config.json)
    registerLoginAccount(m.paths.config, 'codex', { key: 'mine', loginDir: '~/.codex-mine' });
    mkdirSync(join(m.home, '.codex-mine'), { recursive: true });
    expect(ensureLoginAccount(CODEX_DEF, 'mine', deps).ok).toBe(true);
    // a folder inside the data folder or the main folder is refused
    registerLoginAccount(m.paths.config, 'codex', { key: 'bad', loginDir: join(m.root, 'x') });
    expect(ensureLoginAccount(CODEX_DEF, 'bad', deps).ok).toBe(false);
    registerLoginAccount(m.paths.config, 'codex', { key: 'same', loginDir: '~/.codex' });
    expect(ensureLoginAccount(CODEX_DEF, 'same', deps)).toMatchObject({
      ok: false,
      error: expect.stringContaining('main'),
    });
  });

  it('unregisters without touching the folder', () => {
    const m = machine();
    registerLoginAccount(m.paths.config, 'gemini', { key: 'work' });
    expect(unregisterLoginAccount(m.paths.config, 'gemini', 'work')).toBe(true);
    expect(unregisterLoginAccount(m.paths.config, 'gemini', 'work')).toBe(false);
    expect(loadConfig(m.paths.config).runtimes.gemini?.accounts).toEqual([]);
  });

  it('Make main swaps the two folders (Codex), and doing it again undoes it', () => {
    const m = machine();
    registerLoginAccount(m.paths.config, 'codex', { key: 'work' });
    const reg = m.codexRegistry();
    expect(reg.main.folder).toBe(join(m.home, '.codex'));
    const r = swapMainLoginAccount(m.paths.config, CODEX_DEF, 'work', m.home, reg.main.folder);
    expect(r).toEqual({ ok: true });
    reg.refresh();
    expect(reg.main.folder).toBe(join(m.home, '.codex-gw-work'));
    expect(reg.get('work')?.folder).toBe(join(m.home, '.codex'));
    expect(swapMainLoginAccount(m.paths.config, CODEX_DEF, 'work', m.home, reg.main.folder)).toEqual({
      ok: true,
    });
    reg.refresh();
    expect(reg.main.folder).toBe(join(m.home, '.codex'));
    expect(reg.get('work')?.folder).toBe(join(m.home, '.codex-gw-work'));
    expect(swapMainLoginAccount(m.paths.config, CODEX_DEF, 'ghost', m.home, reg.main.folder)).toMatchObject({
      ok: false,
    });
  });

  it('Make main converts between the two forms for Gemini (.gemini folder of the main, root of an account)', () => {
    const m = machine();
    registerLoginAccount(m.paths.config, 'gemini', { key: 'work' });
    const reg = m.geminiRegistry();
    expect(swapMainLoginAccount(m.paths.config, GEMINI_DEF, 'work', m.home, reg.main.folder)).toEqual({
      ok: true,
    });
    reg.refresh();
    expect(reg.main.folder).toBe(join(m.home, '.gemini-gw-work', '.gemini'));
    expect(reg.get('work')?.folder).toBe(join(m.home, '.gemini'));
    expect(loadConfig(m.paths.config).runtimes.gemini?.loginDir).toBe('~/.gemini-gw-work/.gemini');
  });
});

// ------------------------------------------------------------------------------------------------- Codex on an account

function fakeCodex(): {
  bin: string;
  dir: string;
  mode: (m: object) => void;
  calls: () => Array<{ codexHome: string; auth: string | null }>;
} {
  const dir = tmp('aom-fake-codex-acct-');
  const bin = join(dir, 'codex');
  writeFileSync(join(dir, 'fake.json'), '{}');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'), 'utf8'));
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
if (argv[0] === 'sandbox') process.exit(0);
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const home = process.env.CODEX_HOME || '';
  let auth = null; try { auth = fs.readFileSync(path.join(home, 'auth.json'), 'utf8'); } catch {}
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ codexHome: home, auth }) + '\\n');
  if (mode.authTo) fs.writeFileSync(path.join(home, 'auth.json'), mode.authTo);
  for (const l of mode.lines || []) console.log(l);
  process.exit(mode.exit || 0);
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    mode: (m) => writeFileSync(join(dir, 'fake.json'), JSON.stringify(m)),
    calls: () =>
      existsSync(join(dir, 'calls.jsonl'))
        ? readFileSync(join(dir, 'calls.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
        : [],
  };
}

const PERMS = {
  allowedTools: ['read', 'edit', 'shell'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: true,
  browser: false,
  riskTiers: ['small'],
  readOrgRepos: false,
  repoIds: null,
};
const OK_LINES = [
  j({ type: 'thread.started', thread_id: 't1' }),
  j({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'done' } }),
  j({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }),
];

function codexRig() {
  const m = machine();
  const fake = fakeCodex();
  mkdirSync(join(m.home, '.codex'), { recursive: true });
  writeFileSync(join(m.home, '.codex', 'auth.json'), LOGIN('main-token', 'main@x.test'));
  mkdirSync(join(m.home, '.codex-gw-work'), { recursive: true });
  writeFileSync(join(m.home, '.codex-gw-work', 'auth.json'), LOGIN('work-token', 'work@x.test'));
  registerLoginAccount(m.paths.config, 'codex', { key: 'work' });
  const accounts = m.codexRegistry();
  const adapter = new CodexAdapter(
    { enabled: true, bin: fake.bin, authMode: 'login', toolchainPaths: [], sandbox: 'native' },
    m.paths,
    { home: m.home, parent: { PATH: '/usr/bin:/bin' }, platform: 'linux', accounts },
  );
  const sandboxFor = (account?: string) => {
    const agentDir = join(m.root, 'agents', 'ag1');
    const s = {
      home: join(agentDir, 'home'),
      configDir: join(agentDir, account ? `claude-acct-${account}` : 'claude'),
      scratch: join(agentDir, 'scratch'),
      tmp: join(agentDir, 'tmp'),
    };
    for (const d of Object.values(s)) mkdirSync(d, { recursive: true });
    return s;
  };
  const cwd = join(m.root, 'wt');
  mkdirSync(cwd, { recursive: true });
  const input = (account?: string): ShiftStartInput => {
    const sandbox = sandboxFor(account);
    return {
      shiftId: `sh-${account ?? 'main'}`,
      prompt: 'work',
      instructionsMarkdown: '# role',
      cwd,
      sandbox,
      ...(account ? { account } : {}),
      agent: {
        agentId: 'ag1',
        name: 'Ada',
        roleKey: 'builder',
        seniority: 'senior',
        runtime: 'codex',
        model: 'gpt-6-sol',
        skills: [],
        permissions: PERMS,
      },
      env: {
        HOME: sandbox.home,
        TMPDIR: sandbox.tmp,
        PATH: '/usr/bin',
        AOM_SHIFT_TOKEN: 't',
        CLAUDE_CONFIG_DIR: sandbox.configDir,
      },
      addDirs: [],
      maxShiftMinutes: 5,
    } as unknown as ShiftStartInput;
  };
  return { ...m, fake, accounts, adapter, input };
}

async function drain(s: RuntimeSession): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of s.events()) out.push(e);
  return out;
}

describe('Codex: a shift on a named account', () => {
  it('runs in the account’s own Codex home with the account’s login, never the main one', async () => {
    const r = codexRig();
    r.fake.mode({ lines: OK_LINES });
    await drain(await r.adapter.start(r.input('work')));
    await drain(await r.adapter.start(r.input()));
    const [work, main] = r.fake.calls();
    expect(work?.codexHome).toBe(join(r.root, 'agents', 'ag1', 'codex-acct-work'));
    expect(work?.auth).toContain('work-token');
    expect(work?.auth).not.toContain('main-token');
    expect(main?.codexHome).toBe(join(r.root, 'agents', 'ag1', 'codex'));
    expect(main?.auth).toContain('main-token');
  });

  it('hands a refreshed login back to the account’s own file only', async () => {
    const r = codexRig();
    r.fake.mode({ lines: OK_LINES, authTo: LOGIN('work-refreshed', 'work@x.test', '2026-09-01T00:00:00Z') });
    await drain(await r.adapter.start(r.input('work')));
    expect(readFileSync(join(r.home, '.codex-gw-work', 'auth.json'), 'utf8')).toContain('work-refreshed');
    expect(readFileSync(join(r.home, '.codex', 'auth.json'), 'utf8')).toContain('main-token');
  });

  it('a login that does not work expires that account only; the workstation stays available', async () => {
    const r = codexRig();
    r.fake.mode({
      lines: [
        j({ type: 'thread.started', thread_id: 't1' }),
        j({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: bad token' } }),
      ],
      exit: 1,
    });
    const events = await drain(await r.adapter.start(r.input('work')));
    expect(events.at(-1)).toMatchObject({ kind: 'exit', authFailed: true });
    expect(r.accounts.get('work')?.auth.state).toBe('expired');
    expect(r.accounts.main.auth.state).toBe('ok');
    expect(r.adapter.accountGate('work')).toEqual({ state: 'login', login: 'expired' });
    expect(r.adapter.accountGate('main')).toEqual({ state: 'ok' });
    const caps = await r.adapter.capabilities();
    expect(caps.available).toBe(true);
    expect(caps.accounts?.map((a) => [a.key, a.login])).toEqual([
      ['main', 'ok'],
      ['work', 'expired'],
    ]);
    // signing in again (the file changes) clears it
    writeFileSync(
      join(r.home, '.codex-gw-work', 'auth.json'),
      LOGIN('work-new', 'work@x.test', '2026-10-01T00:00:00Z'),
    );
    utimesSync(join(r.home, '.codex-gw-work', 'auth.json'), new Date(), new Date(Date.now() + 10_000));
    expect(r.adapter.accountGate('work')).toEqual({ state: 'ok' });
  });

  it('a usage limit pauses that account, with its reset time', async () => {
    const r = codexRig();
    r.fake.mode({
      lines: [
        j({ type: 'thread.started', thread_id: 't1' }),
        j({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 2 hours." } }),
      ],
      exit: 1,
    });
    const events = await drain(await r.adapter.start(r.input('work')));
    expect(events.at(-1)).toMatchObject({ kind: 'exit', usageLimit: { until: expect.any(String) } });
    const gate = r.adapter.accountGate('work');
    expect(gate).toMatchObject({ state: 'limited', limitedUntil: expect.any(String) });
    expect(r.adapter.accountGate('main')).toEqual({ state: 'ok' });
    expect((await r.adapter.capabilities()).accounts?.find((a) => a.key === 'work')).toMatchObject({
      usage: 'limited',
    });
  });

  it('the gate knows an unknown account, an account with no login yet, and a main-only runner', async () => {
    const r = codexRig();
    expect(r.adapter.accountGate('ghost')).toEqual({ state: 'missing' });
    registerLoginAccount(r.paths.config, 'codex', { key: 'fresh' });
    expect(r.adapter.accountGate('fresh')).toEqual({ state: 'login', login: 'none' });
    await expect(r.adapter.start(r.input('fresh'))).rejects.toThrow(/account fresh is not signed in/);
    // without a registry (an adapter built without accounts) only main exists
    const plain = new CodexAdapter(
      { enabled: true, bin: r.fake.bin, authMode: 'login', toolchainPaths: [], sandbox: 'native' },
      r.paths,
      { home: r.home, parent: { PATH: '/usr/bin:/bin' }, platform: 'linux' },
    );
    expect(plain.accountGate('main')).toEqual({ state: 'ok' });
    expect(plain.accountGate('work')).toEqual({ state: 'missing' });
  });

  it('the runtime is available while any account is usable', async () => {
    const r = codexRig();
    rmLogin(join(r.home, '.codex', 'auth.json'));
    const caps = await r.adapter.capabilities();
    expect(caps.auth).toBe('expired'); // main, as before
    expect(caps.available).toBe(true); // the work account still works
    rmLogin(join(r.home, '.codex-gw-work', 'auth.json'));
    expect((await r.adapter.capabilities()).available).toBe(false);
  });
});

function rmLogin(file: string): void {
  writeFileSync(file, '{}');
  utimesSync(file, new Date(), new Date(Date.now() + 20_000));
}

// ------------------------------------------------------------------------------------------------- Gemini on an account

describe('Gemini CLI: accounts', () => {
  function geminiRig() {
    const m = machine();
    mkdirSync(join(m.home, '.gemini'), { recursive: true });
    writeFileSync(
      join(m.home, '.gemini', 'oauth_creds.json'),
      j({ access_token: 'g-main', refresh_token: 'rm', expiry_date: Date.now() + 3600_000 }),
    );
    mkdirSync(join(m.home, '.gemini-gw-work', '.gemini'), { recursive: true });
    writeFileSync(
      join(m.home, '.gemini-gw-work', '.gemini', 'oauth_creds.json'),
      j({ access_token: 'g-work', refresh_token: 'rw', expiry_date: Date.now() + 3600_000 }),
    );
    registerLoginAccount(m.paths.config, 'gemini', { key: 'work' });
    const accounts = m.geminiRegistry();
    const adapter = new GeminiAdapter(
      {
        enabled: true,
        bin: '/nonexistent/gemini',
        authMode: 'auto',
        toolchainPaths: [],
        extraAllowedDomains: [],
        models: [],
      },
      m.paths,
      undefined,
      {
        home: m.home,
        parent: {},
        platform: 'linux',
        accounts,
        sandboxProbe: () => ({ ok: true, reason: 'test' }),
      },
    );
    return { ...m, accounts, adapter };
  }

  it('reads each account’s own login folder; main is untouched', () => {
    const r = geminiRig();
    expect(r.adapter.loginDir()).toBe(join(r.home, '.gemini'));
    expect(r.adapter.loginDir('work')).toBe(join(r.home, '.gemini-gw-work', '.gemini'));
    expect(r.adapter.loginFile('work')).toBe(join(r.home, '.gemini-gw-work', '.gemini', 'oauth_creds.json'));
    expect(r.adapter.authSelection(undefined, 'work')).toEqual({ via: 'login' });
    expect(r.adapter.accountGate('work')).toEqual({ state: 'ok' });
    expect(r.adapter.accountGate('main')).toEqual({ state: 'ok' });
    expect(r.adapter.accountGate('ghost')).toEqual({ state: 'missing' });
  });

  it('a lost login makes that account unusable and nothing else', () => {
    const r = geminiRig();
    writeFileSync(join(r.home, '.gemini-gw-work', '.gemini', 'oauth_creds.json'), '');
    utimesSync(
      join(r.home, '.gemini-gw-work', '.gemini', 'oauth_creds.json'),
      new Date(),
      new Date(Date.now() + 9000),
    );
    expect(r.adapter.accountGate('work')).toEqual({ state: 'login', login: 'none' });
    expect(r.adapter.accountGate('main')).toEqual({ state: 'ok' });
  });

  it('an account that is not a login account is a key account of the Google key (or `org`)', () => {
    const r = geminiRig();
    expect(r.adapter.authSelection(undefined, 'personal')).toMatchObject({ via: 'none' });
  });
});
