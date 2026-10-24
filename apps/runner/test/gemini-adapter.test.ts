import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runtimeRoleProblem, sealLarge } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildGeminiCommand,
  detectGemini,
  GeminiAdapter,
  geminiHomeOf,
  geminiLoginFreshness,
  geminiPolicy,
  geminiSettings,
} from '../src/adapters/gemini.ts';
import {
  GeminiStreamParser,
  geminiUsageLimit,
  isGeminiAuthFailureText,
} from '../src/adapters/gemini-stream-parser.ts';
import type { HarnessLaunch } from '../src/adapters/harness-session.ts';
import { buildAdapters } from '../src/adapters/registry.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { GeminiRuntimeConfigSchema, RunnerConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

cleanupTmp();

const j = (o: object): string => JSON.stringify(o);
// captured from gemini-cli 0.65.0 (see test/gemini-real.test.ts for the run against the real binary)
const REAL_LINES = [
  j({
    type: 'init',
    timestamp: 't',
    session_id: '696b686d-4be4-47c2-9cdd-7223e3cb4e4a',
    model: 'gemini-2.5-pro',
  }),
  j({ type: 'message', timestamp: 't', role: 'user', content: 'run it' }),
  j({
    type: 'tool_use',
    timestamp: 't',
    tool_name: 'run_shell_command',
    tool_id: 'run_shell_command__1_0',
    parameters: { command: 'echo SHELLOUT && ls /home' },
  }),
  j({
    type: 'tool_result',
    timestamp: 't',
    tool_id: 'run_shell_command__1_0',
    status: 'success',
    output: 'SHELLOUT\npieter',
  }),
  j({ type: 'message', timestamp: 't', role: 'assistant', content: 'hello from fake', delta: true }),
  j({
    type: 'result',
    timestamp: 't',
    status: 'success',
    stats: {
      total_tokens: 182,
      input_tokens: 170,
      output_tokens: 12,
      cached: 20,
      input: 150,
      duration_ms: 143,
      tool_calls: 1,
      models: {},
    },
  }),
];

describe('the Gemini stream parser', () => {
  it('maps the real events: session, tool, result, progress, final, usage with the cached part split out', () => {
    const p = new GeminiStreamParser({ model: 'gemini-2.5-pro' });
    const ev = REAL_LINES.flatMap((l) => p.parseLine(l));
    expect(ev.map((e) => e.kind)).toEqual(['session', 'tool', 'toolresult', 'progress', 'usage', 'final']);
    expect(ev[1]).toMatchObject({ kind: 'tool', name: 'Bash', summary: 'echo SHELLOUT && ls /home' });
    expect(ev[2]).toMatchObject({ kind: 'toolresult', id: 'run_shell_command__1_0', bytes: 15 });
    expect(p.usage()).toEqual({
      inputTokens: 150,
      outputTokens: 12,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      model: 'gemini:gemini-2.5-pro',
    });
    expect(p.contextTokens()).toBe(170);
    expect(p.sessionId).toBe('696b686d-4be4-47c2-9cdd-7223e3cb4e4a');
  });

  it('ignores the CLI’s own text lines and attributes a stored key', () => {
    const p = new GeminiStreamParser({ model: 'm', key: { source: 'org', provider: 'google' } });
    expect(p.parseLine('[STARTUP] Phase cleanup was started')).toEqual([]);
    expect(p.parseLine('YOLO mode is enabled.')).toEqual([]);
    expect(p.parseLine('{broken')).toEqual([]);
    expect(p.usage()).toMatchObject({ keySource: 'org', keyProvider: 'google' });
  });

  it('streams a chat reply as a text block with deltas', () => {
    const p = new GeminiStreamParser({ chat: true });
    const ev = [
      j({ type: 'message', role: 'assistant', content: 'Hel', delta: true }),
      j({ type: 'message', role: 'assistant', content: 'lo', delta: true }),
      j({
        type: 'result',
        status: 'success',
        stats: { input: 1, output_tokens: 1, cached: 0, input_tokens: 1 },
      }),
    ].flatMap((l) => p.parseLine(l));
    expect(ev.map((e) => e.kind)).toEqual(['textstart', 'delta', 'delta', 'progress', 'usage', 'final']);
    expect(ev.at(-1)).toMatchObject({ text: 'Hello' });
  });

  it('turns a refused tool call into a refusal and an error result into the exit text', () => {
    const p = new GeminiStreamParser();
    const ev = [
      j({
        type: 'tool_use',
        tool_name: 'run_shell_command',
        tool_id: 'x',
        parameters: { command: 'git push' },
      }),
      j({
        type: 'tool_result',
        tool_id: 'x',
        status: 'error',
        error: { message: 'Tool execution denied by policy. not allowed for this agent' },
      }),
      j({
        type: 'result',
        status: 'error',
        error: {
          type: 'unknown',
          message:
            '[API Error: {"error":{"code":401,"message":"API key not valid.","status":"UNAUTHENTICATED"}}]',
        },
        stats: {},
      }),
    ].flatMap((l) => p.parseLine(l));
    expect(ev[1]).toMatchObject({ kind: 'toolresult', isError: true, refused: true });
    expect(p.resultError).toMatch(/API key not valid/);
    expect(p.authFailure).toBe(true);
    expect(ev.some((e) => e.kind === 'final')).toBe(false);
  });

  it('recognises login failures and the quota text with its reset time', () => {
    for (const t of [
      'API key not valid. Please pass a valid API key.',
      'invalid_grant: Token has been expired or revoked',
      'Please set an Auth method in your settings.json',
    ])
      expect(isGeminiAuthFailureText(t)).toBe(true);
    expect(isGeminiAuthFailureText('Cannot read properties of undefined')).toBe(false);
    const now = new Date('2026-10-24T10:00:00Z');
    expect(
      geminiUsageLimit(
        'You have exhausted your capacity on this model. Your quota will reset after 3h5m20s.',
        now,
      )?.until.toISOString(),
    ).toBe('2026-10-24T13:05:20.000Z');
    expect(geminiUsageLimit('RESOURCE_EXHAUSTED', now)?.parsed).toBe(false);
    expect(geminiUsageLimit('all fine', now)).toBeUndefined();
  });
});

describe('the Gemini command', () => {
  const input = {
    prompt: 'SECRET PROMPT TEXT',
    model: 'gemini-2.5-pro',
    includeDirs: ['/v/vault', '/r/ref'],
    policyFile: '/g/.gemini/aom-policy.toml',
    sessionEnv: { PATH: '/runner/bin:/usr/bin', HOME: '/agent/home', AOM_SHIFT_TOKEN: 'shift-token' },
    ghome: '/agent/gemini',
    bridgePort: 3128,
  };
  const parent = {
    PATH: '/usr/bin',
    GH_TOKEN: 'gh-secret',
    GEMINI_API_KEY: 'runner-own',
    HOME: '/home/owner',
    SSH_AUTH_SOCK: '/s',
  };

  it('reads the prompt from stdin, bans nothing into argv and passes the model as one argument', () => {
    const c = buildGeminiCommand({ ...input, auth: 'login' }, { bin: '/bin/gemini' }, parent);
    expect(c.args).toEqual([
      '-p',
      '',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
      '--model=gemini-2.5-pro',
      '--admin-policy',
      '/g/.gemini/aom-policy.toml',
      '--include-directories',
      '/v/vault,/r/ref',
    ]);
    expect(c.stdin).toBe('SECRET PROMPT TEXT');
    expect(c.args.join(' ')).not.toContain('SECRET PROMPT');
    expect(
      buildGeminiCommand({ ...input, auth: 'login', model: '-evil' }, { bin: 'g' }, parent).args,
    ).toContain('--model=-evil');
  });

  it('resumes only by a session id (a UUID)', () => {
    const id = '696b686d-4be4-47c2-9cdd-7223e3cb4e4a';
    expect(
      buildGeminiCommand({ ...input, auth: 'login', resumeSessionId: id }, { bin: 'g' }, parent).args.slice(
        -2,
      ),
    ).toEqual(['--resume', id]);
    expect(
      buildGeminiCommand({ ...input, auth: 'login', resumeSessionId: 'latest' }, { bin: 'g' }, parent).args,
    ).not.toContain('--resume');
  });

  it('gives the process a private home, file storage and nothing of the runner’s environment', () => {
    const e = buildGeminiCommand({ ...input, auth: 'login' }, { bin: 'g' }, parent).env;
    expect(e).toMatchObject({
      GEMINI_CLI_HOME: '/agent/gemini',
      GEMINI_FORCE_FILE_STORAGE: 'true',
      HOME: '/agent/home',
      AOM_SHIFT_TOKEN: 'shift-token',
    });
    expect(e.GH_TOKEN).toBeUndefined();
    expect(e.SSH_AUTH_SOCK).toBeUndefined();
    expect(e.GEMINI_API_KEY).toBeUndefined();
  });

  it('in key mode points the CLI at the runner’s route with a dummy key: the real one is not in the environment', () => {
    const e = buildGeminiCommand({ ...input, auth: 'key' }, { bin: 'g' }, parent).env;
    expect(e.GOOGLE_GEMINI_BASE_URL).toBe('http://127.0.0.1:3128/gemini');
    expect(e.GEMINI_API_KEY).toBe('aom-key-is-added-by-the-runner');
  });
});

describe('the Gemini settings and policy', () => {
  it('switches off updates, telemetry, hooks and MCP, and names the auth type', () => {
    const s = geminiSettings({ auth: 'oauth-personal' }) as Record<string, any>;
    expect(s.security.auth.selectedType).toBe('oauth-personal');
    expect(s.general.enableAutoUpdate).toBe(false);
    expect(s.privacy.usageStatisticsEnabled).toBe(false);
    expect(s.telemetry.enabled).toBe(false);
    expect(s.hooksConfig.enabled).toBe(false);
    expect(s.mcp.allowed).toEqual([]);
    expect(s.context.fileName).toEqual(['GEMINI.md', 'AGENTS.md']);
    expect((geminiSettings({ auth: 'gemini-api-key' }) as any).security.auth.selectedType).toBe(
      'gemini-api-key',
    );
  });

  const perms = (allowedTools: string[]) => ({ allowedTools, deniedShellPatterns: [] as string[] });

  it('a builder: denied git commands, no memory writes, no questions, no MCP; its shell is free', () => {
    const t = geminiPolicy({ perms: perms(['read', 'edit', 'shell']), roleKey: 'builder', chat: false });
    expect(t).toContain('commandPrefix = ["git push"');
    expect(t).toContain('"git reset --hard"');
    expect(t).not.toContain('"git rebase"'); // builders may rebase
    expect(t).toContain('toolName = ["save_memory", "ask_user"');
    expect(t).toContain('toolName = "mcp_*"');
    expect(t).toContain('["google_web_search", "web_fetch"]');
    expect(t).not.toContain('commandPrefix = "aom"');
    expect(t).not.toContain('"write_file"');
  });

  it('a role without a shell, and every chat, may run only aom; without edit there are no write tools', () => {
    for (const args of [
      { perms: perms(['read']), roleKey: 'analyst', chat: false },
      { perms: perms(['read', 'edit', 'shell']), roleKey: 'builder', chat: true },
    ]) {
      const t = geminiPolicy(args);
      expect(t).toContain('commandPrefix = "aom"');
      expect(t).toContain('priority = 400');
    }
    expect(geminiPolicy({ perms: perms(['read']), roleKey: 'analyst', chat: false })).toContain(
      '["write_file", "replace"]',
    );
    expect(geminiPolicy({ perms: perms(['read', 'web']), roleKey: 'analyst', chat: false })).not.toContain(
      'google_web_search',
    );
    // a reviewer (not a builder) may not move branches
    expect(geminiPolicy({ perms: perms(['read', 'shell']), roleKey: 'reviewer', chat: false })).toContain(
      '"git checkout"',
    );
  });
});

// ------------------------------------------------------------------------------------------------- the adapter with a fake gemini

interface FakeMode {
  lines?: string[];
  exit?: number;
  stderr?: string;
  /** Written into the private home's `.gemini/oauth_creds.json` while the session runs (a refresh). */
  refreshTo?: string;
}

function fakeGemini(mode: FakeMode = {}) {
  const dir = tmp('aom-fake-gemini-');
  const bin = join(dir, 'gemini');
  const modeFile = join(dir, 'fake.json');
  writeFileSync(modeFile, JSON.stringify(mode));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'), 'utf8'));
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('0.65.0'); process.exit(0); }
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const g = path.join(process.env.GEMINI_CLI_HOME || '', '.gemini');
  let skills = []; try { skills = fs.readdirSync(path.join(g, 'skills')); } catch {}
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({
    argv, env: process.env, cwd: process.cwd(), stdin,
    settings: read(path.join(g, 'settings.json')), policy: read(path.join(g, 'aom-policy.toml')),
    geminiMd: read(path.join(g, 'GEMINI.md')), oauth: read(path.join(g, 'oauth_creds.json')), skills,
  }) + '\\n');
  if (mode.refreshTo) fs.writeFileSync(path.join(g, 'oauth_creds.json'), mode.refreshTo);
  for (const l of mode.lines || []) console.log(l);
  if (mode.stderr) console.error(mode.stderr);
  process.exit(mode.exit || 0);
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    set: (m: FakeMode) => writeFileSync(modeFile, JSON.stringify(m)),
    calls: () => {
      const f = join(dir, 'calls.jsonl');
      return existsSync(f)
        ? readFileSync(f, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
        : [];
    },
  };
}

const PERMS = {
  allowedTools: ['read', 'edit', 'shell'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: true,
  browser: false,
  riskTiers: ['small', 'large'],
  readOrgRepos: false,
  repoIds: null,
};
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

async function world(
  opts: {
    login?: string;
    mode?: FakeMode;
    key?: 'org' | 'own';
    authMode?: 'auto' | 'login' | 'api_key';
  } = {},
) {
  const t = tmp();
  const fake = fakeGemini(opts.mode);
  const paths = runnerPaths(join(t, 'data'));
  const sb = await ensureSandbox(paths, A, 'Gem');
  const cwd = join(t, 'wt');
  mkdirSync(cwd, { recursive: true });
  const ownerHome = join(t, 'owner');
  mkdirSync(join(ownerHome, '.gemini'), { recursive: true });
  const loginFile = join(ownerHome, '.gemini', 'oauth_creds.json');
  if (opts.login) writeFileSync(loginFile, opts.login);
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
  if (opts.key)
    store.set({
      provider: 'google',
      keyId: keys.publicKey.keyId,
      ...(opts.key === 'org' ? { source: 'org' as const } : {}),
      ciphertext: await sealLarge(keys.publicKey.publicKey, 'AIza-secret-key-1234'),
      models: [],
    });
  const launches: HarnessLaunch[] = [];
  const adapter = new GeminiAdapter(
    GeminiRuntimeConfigSchema.parse({
      bin: fake.bin,
      authMode: opts.authMode ?? 'auto',
      models: ['gemini-9-custom'],
    }) as never,
    paths,
    store,
    {
      home: ownerHome,
      parent: { PATH: process.env.PATH ?? '', GH_TOKEN: 'runner-token' },
      sandboxProbe: () => ({ ok: true, reason: 'test' }),
      launch: async (l) => {
        launches.push(l);
        return {
          command: l.cmd,
          proxy: { close: async () => {}, denied: () => [], asked: () => [] },
          cleanup: async () => {},
        };
      },
    },
  );
  const agent = (over: object = {}) => ({
    agentId: A,
    name: 'Gem',
    roleKey: 'builder',
    seniority: 'senior',
    runtime: 'gemini',
    model: 'gemini-2.5-pro',
    skills: [],
    permissions: PERMS,
    isDevops: false,
    ...over,
  });
  const start = async (over: { agent?: object; kind?: string; devopsGuard?: object } = {}) => {
    const s = await adapter.start({
      shiftId: 's1',
      prompt: 'do the card',
      instructionsMarkdown: '',
      cwd,
      sandbox: sb,
      addDirs: ['/vault'],
      env: {
        PATH: '/runner/bin:/usr/bin',
        HOME: sb.home,
        AOM_SHIFT_TOKEN: 'tok',
        AOM_IPC_SOCKET: '/run/ipc.sock',
      },
      maxShiftMinutes: 5,
      agent: agent(over.agent),
      ...(over.kind ? { kind: over.kind } : {}),
      ...(over.devopsGuard ? { devopsGuard: over.devopsGuard } : {}),
    } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    return { ev, usage: s.usage() };
  };
  return { t, fake, paths, sb, cwd, ownerHome, loginFile, store, keys, adapter, launches, start, agent };
}

describe('the Gemini adapter (fake binary)', () => {
  it('registers only when the binary exists, and never picks one up from PATH under tests', async () => {
    const f = fakeGemini();
    expect(detectGemini({ bin: f.bin, enabled: true } as never, { platform: 'linux' })).toBe(f.bin);
    expect(
      detectGemini({ bin: '/no/such/gemini', enabled: true } as never, { platform: 'linux' }),
    ).toBeUndefined();
    expect(detectGemini({ enabled: false, bin: f.bin } as never, { platform: 'linux' })).toBeUndefined();
    expect(detectGemini({ bin: f.bin, enabled: true } as never, { platform: 'darwin' })).toBeUndefined();
    expect(
      detectGemini(undefined, { platform: 'linux', pathVar: '/nonexistent', blocked: true }),
    ).toBeUndefined();
    const t = tmp();
    const cfg = makeConfig(t, { runtimes: { 'claude-code': {}, gemini: { bin: f.bin } } } as never);
    const adapters = buildAdapters(RunnerConfigSchema.parse(cfg), runnerPaths(join(t, 'data')));
    expect(adapters.has('gemini')).toBe(process.platform === 'linux');
  });

  it('runs a shift: stdin prompt, private home with settings, policy, instructions and skills; the owner’s login is copied', async () => {
    const w = await world({
      login: j({ access_token: 'ya29.a', refresh_token: 'r', expiry_date: 1_900_000_000_000 }),
      mode: { lines: REAL_LINES },
    });
    await w.adapter.writeInstructions(w.sb, '# Role\nINSTR\n');
    const { ev, usage } = await w.start();
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    expect(usage).toMatchObject({ inputTokens: 150, model: 'gemini:gemini-2.5-pro' });
    expect(usage.keySource).toBeUndefined(); // a login is not a key
    const c = w.fake.calls()[0];
    expect(c.stdin).toBe('do the card');
    expect(c.argv).toContain('--admin-policy');
    expect(c.env.GEMINI_CLI_HOME).toBe(geminiHomeOf(w.sb));
    expect(c.env.GH_TOKEN).toBeUndefined();
    expect(c.geminiMd).toContain('INSTR');
    expect(JSON.parse(c.settings).security.auth.selectedType).toBe('oauth-personal');
    expect(c.policy).toContain('git push');
    expect(JSON.parse(c.oauth).access_token).toBe('ya29.a');
    // the launch hands the sandbox what it needs: private writable home, login hidden from the shell, the key variables unset
    const l = w.launches[0] as HarnessLaunch;
    expect(l.sandbox.writable).toEqual([geminiHomeOf(w.sb)]);
    expect(l.sandbox.readOnlyCwd).toBe(false);
    expect(l.sandbox.mayCommit).toBe(true);
    expect(l.sandbox.readonly).toContain('/vault');
    expect(l.sandbox.ipcSocket).toBe('/run/ipc.sock');
    expect(l.hiddenFromShell?.some((p) => p.endsWith('oauth_creds.json'))).toBe(true);
    expect(l.unsetForShell).toContain('GEMINI_API_KEY');
    expect(l.cliHosts).toContain('cloudcode-pa.googleapis.com');
    expect(l.routes).toBeUndefined();
  });

  it('hands a refreshed login back to the owner, and keeps a newer owner login', async () => {
    const w = await world({
      login: j({ access_token: 'old', refresh_token: 'r', expiry_date: 1_000 }),
      mode: {
        lines: REAL_LINES,
        refreshTo: j({ access_token: 'new', refresh_token: 'r', expiry_date: 9_000_000_000_000 }),
      },
    });
    await w.start();
    expect(JSON.parse(readFileSync(w.loginFile, 'utf8')).access_token).toBe('new');
    // a second agent session finds the owner's file newer than a stale private copy: it starts from the owner's
    const copy = join(geminiHomeOf(w.sb), '.gemini', 'oauth_creds.json');
    writeFileSync(copy, j({ access_token: 'stale', expiry_date: 5 }));
    w.fake.set({ lines: REAL_LINES });
    await w.start();
    expect(JSON.parse(w.fake.calls()[1].oauth).access_token).toBe('new');
    expect(geminiLoginFreshness(w.loginFile)).toBe(9_000_000_000_000);
  });

  it('uses the stored key when there is no login: the key goes to the proxy route, never to the process', async () => {
    const w = await world({ key: 'org', mode: { lines: REAL_LINES } });
    const { usage } = await w.start();
    expect(usage).toMatchObject({ keySource: 'org', keyProvider: 'google' });
    const c = w.fake.calls()[0];
    expect(JSON.stringify(c.env)).not.toContain('AIza-secret-key-1234');
    expect(c.env.GOOGLE_GEMINI_BASE_URL).toBe('http://127.0.0.1:3128/gemini');
    expect(JSON.parse(c.settings).security.auth.selectedType).toBe('gemini-api-key');
    expect(c.oauth).toBeNull();
    const l = w.launches[0] as HarnessLaunch;
    expect(l.routes?.[0]).toMatchObject({
      prefix: '/gemini',
      upstream: 'https://generativelanguage.googleapis.com',
      headers: { 'x-goog-api-key': 'AIza-secret-key-1234' },
    });
    expect(l.hiddenFromShell).toEqual([]);
  });

  it('a workstation key beats the organization key; auto prefers the login over a key', async () => {
    const own = await world({ key: 'own', mode: { lines: REAL_LINES } });
    expect((await own.start()).usage.keySource).toBe('workstation');
    const both = await world({
      key: 'org',
      login: j({ access_token: 'a', expiry_date: 1 }),
      mode: { lines: REAL_LINES },
    });
    expect(both.adapter.authSelection().via).toBe('login');
    const keyOnly = new GeminiAdapter(
      GeminiRuntimeConfigSchema.parse({ bin: both.fake.bin, authMode: 'api_key' }) as never,
      both.paths,
      both.store,
      { home: both.ownerHome },
    );
    expect(keyOnly.authSelection().via).toBe('key');
  });

  it('is available with a login or a key, reports its auth path and extra models, and is unavailable without sign-in', async () => {
    const none = await world();
    const c0 = await none.adapter.capabilities();
    expect(c0).toMatchObject({ runtime: 'gemini', available: false, auth: 'expired', sandbox: 'enforced' });
    expect(c0.models).toEqual([{ id: 'gemini-9-custom', label: 'gemini-9-custom' }]);
    const login = await world({ login: j({ access_token: 'a', expiry_date: 1 }) });
    expect(await login.adapter.capabilities()).toMatchObject({
      available: true,
      authVia: 'login',
      auth: 'ok',
      version: '0.65.0',
    });
    const key = await world({ key: 'org' });
    expect(await key.adapter.capabilities()).toMatchObject({ available: true, authVia: 'key' });
    await expect(none.start()).rejects.toThrow(/not signed in/);
  });

  it('reports the runtime unavailable when its sandbox cannot start, and when the CLI is too old', async () => {
    const w = await world({ login: j({ access_token: 'a', expiry_date: 1 }) });
    const bad = new GeminiAdapter(
      GeminiRuntimeConfigSchema.parse({ bin: w.fake.bin }) as never,
      w.paths,
      w.store,
      { home: w.ownerHome, sandboxProbe: () => ({ ok: false, reason: 'bwrap not installed' }) },
    );
    expect(await bad.capabilities()).toMatchObject({
      available: false,
      sandbox: 'unavailable',
      sandboxReason: 'bwrap not installed',
    });
    await expect(
      bad.start({
        shiftId: 'x',
        prompt: 'p',
        instructionsMarkdown: '',
        cwd: w.cwd,
        sandbox: w.sb,
        addDirs: [],
        env: {},
        maxShiftMinutes: 1,
        agent: w.agent(),
      } as never),
    ).rejects.toThrow(/sandbox is unavailable/);
    writeFileSync(
      w.fake.bin,
      readFileSync(w.fake.bin, 'utf8').replace("console.log('0.65.0')", "console.log('0.64.9')"),
    );
    expect(await w.adapter.capabilities()).toMatchObject({
      available: false,
      sandboxReason: expect.stringMatching(/older than 0\.65\.0/),
    });
  });

  it('puts a login failure back instead of counting a crash, and the runtime reports expired until the login changes', async () => {
    const w = await world({
      login: j({ access_token: 'a', expiry_date: 1 }),
      mode: {
        lines: [
          j({
            type: 'result',
            status: 'error',
            error: { message: 'invalid_grant: Token has been expired or revoked' },
            stats: {},
          }),
        ],
        exit: 1,
      },
    });
    const { ev } = await w.start();
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 1, authFailed: true });
    expect((await w.adapter.capabilities()).auth).toBe('expired');
    writeFileSync(w.loginFile, j({ access_token: 'b', expiry_date: 42 }));
    expect((await w.adapter.capabilities()).auth).toBe('ok');
  });

  it('turns a quota message into a usage limit with its reset time', async () => {
    const w = await world({
      login: j({ access_token: 'a', expiry_date: 1 }),
      mode: {
        lines: [
          j({
            type: 'result',
            status: 'error',
            error: {
              message: 'You have exhausted your capacity on this model. Your quota will reset after 2h.',
            },
            stats: {},
          }),
        ],
        exit: 1,
      },
    });
    const { ev } = await w.start();
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', usageLimit: { until: expect.any(String) } });
  });

  it('refuses the roles its sandbox cannot confine, DevOps and CEO shifts and the intake chat', async () => {
    const w = await world({ login: j({ access_token: 'a', expiry_date: 1 }), mode: { lines: REAL_LINES } });
    await expect(
      w.start({ agent: { roleKey: 'tester', permissions: { ...PERMS, browser: true } } }),
    ).rejects.toThrow(/runtime_role_refused.*browsers/);
    await expect(
      w.start({ agent: { roleKey: 'writer', permissions: { ...PERMS, writableGlobs: ['docs/**'] } } }),
    ).rejects.toThrow(/certain paths/);
    await expect(w.start({ agent: { roleKey: 'devops', isDevops: true } })).rejects.toThrow(/guard/);
    await expect(w.start({ kind: 'ceo' })).rejects.toThrow(/DevOps and CEO/);
    await expect(
      w.adapter.startChat({
        chatId: 'c',
        message: 'm',
        cwd: w.cwd,
        sandbox: w.sb,
        agent: w.agent({ roleKey: 'ba' }),
        env: {},
        readOnly: true,
        intake: true,
      } as never),
    ).rejects.toThrow(/intake/);
    expect(runtimeRoleProblem('gemini', { roleKey: 'builder', permissions: PERMS })).toBeNull();
    // a role without a shell does run: its shell is limited to aom by the policy
    const { ev } = await w.start({
      agent: { roleKey: 'analyst', permissions: { ...PERMS, allowedTools: ['read'], mayCommit: false } },
    });
    expect(ev.at(-1)).toMatchObject({ code: 0 });
    expect(w.fake.calls().at(-1).policy).toContain('commandPrefix = "aom"');
    expect(w.launches.at(-1)?.sandbox.readOnlyCwd).toBe(true);
  });

  it('writes exactly the granted skills and nothing from an earlier shift', async () => {
    const w = await world({ login: j({ access_token: 'a', expiry_date: 1 }), mode: { lines: REAL_LINES } });
    const skill = (name: string) => ({
      name,
      files: { 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\nbody\n` },
    });
    await w.adapter
      .start({
        shiftId: 's',
        prompt: 'p',
        instructionsMarkdown: '',
        cwd: w.cwd,
        sandbox: w.sb,
        addDirs: [],
        env: {},
        maxShiftMinutes: 1,
        agent: w.agent(),
        grantedSkills: [skill('a'), skill('b')],
      } as never)
      .then(async (s) => {
        for await (const _ of s.events());
      });
    expect(w.fake.calls()[0].skills.sort()).toEqual(['a', 'b']);
    await w.adapter
      .start({
        shiftId: 's',
        prompt: 'p',
        instructionsMarkdown: '',
        cwd: w.cwd,
        sandbox: w.sb,
        addDirs: [],
        env: {},
        maxShiftMinutes: 1,
        agent: w.agent(),
        grantedSkills: [skill('b')],
      } as never)
      .then(async (s) => {
        for await (const _ of s.events());
      });
    expect(w.fake.calls()[1].skills).toEqual(['b']);
    expect(readdirSync(join(geminiHomeOf(w.sb), '.gemini', 'skills'))).toEqual(['b']);
    void utimesSync;
  });

  it('a chat runs read-only with an aom-only shell and streams deltas', async () => {
    const w = await world({
      login: j({ access_token: 'a', expiry_date: 1 }),
      mode: {
        lines: [
          j({ type: 'init', session_id: '696b686d-4be4-47c2-9cdd-7223e3cb4e4a', model: 'm' }),
          j({ type: 'message', role: 'assistant', content: 'Hi', delta: true }),
          j({
            type: 'result',
            status: 'success',
            stats: { input: 3, input_tokens: 3, output_tokens: 1, cached: 0 },
          }),
        ],
      },
    });
    const s = await w.adapter.startChat({
      chatId: 'c',
      message: 'hello',
      cwd: w.cwd,
      sandbox: w.sb,
      agent: w.agent({ roleKey: 'reviewer' }),
      env: { PATH: '/usr/bin' },
      readOnly: true,
      resumeSessionId: '696b686d-4be4-47c2-9cdd-7223e3cb4e4a',
    } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    expect(ev.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['textstart', 'delta', 'session', 'usage', 'exit']),
    );
    const c = w.fake.calls()[0];
    expect(c.stdin).toBe('hello');
    expect(c.argv.slice(-2)).toEqual(['--resume', '696b686d-4be4-47c2-9cdd-7223e3cb4e4a']);
    expect(c.policy).toContain('commandPrefix = "aom"');
    expect(w.launches[0]?.sandbox.readOnlyCwd).toBe(true);
  });
});
