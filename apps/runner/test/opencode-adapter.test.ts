import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealLarge } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import type { HarnessLaunch } from '../src/adapters/harness-session.ts';
import {
  buildOpencodeCommand,
  DUMMY_KEY,
  detectOpencode,
  OpencodeAdapter,
  opencodeHomeOf,
  opencodePermission,
  opencodeProviderConfig,
  opencodeRoute,
} from '../src/adapters/opencode.ts';
import {
  isOpencodeAuthFailureText,
  OpencodeStreamParser,
  opencodeUsageLimit,
} from '../src/adapters/opencode-stream-parser.ts';
import { buildAdapters } from '../src/adapters/registry.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { OpencodeRuntimeConfigSchema, RunnerConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

cleanupTmp();
const ORG = '11111111-1111-4111-8111-111111111111';
const j = (o: object): string => JSON.stringify(o);

// captured from opencode 1.19.4 (see test/opencode-real.test.ts for the runs against the real binary)
const SID = 'ses_e9309a524ffe4bIatxCLKVaY83';
const REAL_LINES = [
  j({ type: 'step_start', timestamp: 1, sessionID: SID, part: { type: 'step-start' } }),
  j({
    type: 'tool_use',
    timestamp: 2,
    sessionID: SID,
    part: {
      type: 'tool',
      tool: 'bash',
      callID: 'call_1',
      state: {
        status: 'completed',
        input: { command: 'aom report hi', description: 'x' },
        output: 'AOM-RAN report hi\n',
        metadata: { output: 'x', exit: 0 },
      },
    },
  }),
  j({
    type: 'step_finish',
    timestamp: 3,
    sessionID: SID,
    part: {
      type: 'step-finish',
      reason: 'tool-calls',
      tokens: { total: 55, input: 50, output: 5, reasoning: 0, cache: { write: 0, read: 0 } },
      cost: 0,
    },
  }),
  j({ type: 'text', timestamp: 4, sessionID: SID, part: { type: 'text', text: 'hello from fake oai' } }),
  j({
    type: 'step_finish',
    timestamp: 5,
    sessionID: SID,
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { total: 127, input: 100, output: 7, reasoning: 2, cache: { write: 3, read: 20 } },
      cost: 0,
    },
  }),
];

describe('the opencode stream parser', () => {
  it('maps the real events and sums the steps: input without the cached part, reasoning as output', () => {
    const p = new OpencodeStreamParser({ model: 'openai/gpt-5' });
    const ev = REAL_LINES.flatMap((l) => p.parseLine(l));
    expect(ev.map((e) => e.kind)).toEqual([
      'session',
      'tool',
      'toolresult',
      'usage',
      'progress',
      'usage',
      'final',
    ]);
    expect(ev[1]).toMatchObject({ kind: 'tool', name: 'Bash', summary: 'aom report hi', id: 'call_1' });
    expect(ev[2]).toMatchObject({ kind: 'toolresult', id: 'call_1', bytes: 18 });
    expect(p.usage()).toEqual({
      inputTokens: 150,
      outputTokens: 14,
      cacheReadTokens: 20,
      cacheWriteTokens: 3,
      model: 'opencode:openai/gpt-5',
    });
    expect(p.contextTokens()).toBe(123);
    expect(ev.at(-1)).toMatchObject({ kind: 'final', text: 'hello from fake oai' });
  });

  it('streams a chat reply and attributes the key that paid', () => {
    const p = new OpencodeStreamParser({ chat: true, key: { source: 'org', provider: 'openai' } });
    const ev = [REAL_LINES[3] as string].flatMap((l) => p.parseLine(l));
    expect(ev.map((e) => e.kind)).toEqual(['session', 'textstart', 'delta', 'progress']);
    expect(p.usage()).toMatchObject({ keySource: 'org', keyProvider: 'openai' });
  });

  it('marks a refused call as a refusal and reads an API error', () => {
    const p = new OpencodeStreamParser();
    const ev = [
      j({
        type: 'tool_use',
        sessionID: SID,
        part: {
          tool: 'bash',
          callID: 'c',
          state: {
            status: 'error',
            input: { command: 'ls' },
            error: 'The user has specified a rule which prevents you from using this specific tool call.',
          },
        },
      }),
      j({
        type: 'error',
        sessionID: SID,
        error: { name: 'APIError', data: { message: 'Incorrect API key provided', statusCode: 401 } },
      }),
    ].flatMap((l) => p.parseLine(l));
    expect(ev.find((e) => e.kind === 'toolresult')).toMatchObject({ isError: true, refused: true });
    expect(p.resultError).toMatch(/Incorrect API key provided \(HTTP 401\)/);
    expect(p.authFailure).toBe(true);
    expect(isOpencodeAuthFailureText('rate limit reached')).toBe(false);
    expect(
      opencodeUsageLimit('You exceeded your current quota, please check your plan and billing details')
        ?.parsed,
    ).toBe(false);
    expect(opencodeUsageLimit('Incorrect API key provided')).toBeUndefined();
  });

  it('ignores lines that are not JSON', () => {
    const p = new OpencodeStreamParser();
    expect(p.parseLine('INFO  service=bus')).toEqual([]);
    expect(p.parseLine('{broken')).toEqual([]);
  });
});

describe('the opencode command and configuration', () => {
  const store = {
    anthropic: { id: 'anthropic' as const, apiKey: 'sk-ant-REAL', models: [], source: 'org' as const },
    openai: { id: 'openai' as const, apiKey: 'sk-oai-REAL', models: [], source: 'workstation' as const },
    google: { id: 'google' as const, apiKey: 'AIza-REAL', models: [] },
    compat: {
      id: 'openai-compatible' as const,
      apiKey: 'k-REAL',
      baseUrl: 'http://localhost:11434/v1',
      models: ['llama3'],
    },
  };

  it('routes each provider to its API with the key in its own header; the config holds only stand-ins', () => {
    expect(opencodeRoute(store.anthropic)).toMatchObject({
      prefix: '/anthropic',
      upstream: 'https://api.anthropic.com',
      headers: { 'x-api-key': 'sk-ant-REAL' },
    });
    expect(opencodeRoute(store.openai)).toMatchObject({
      prefix: '/openai',
      headers: { authorization: 'Bearer sk-oai-REAL' },
    });
    expect(opencodeRoute(store.google)).toMatchObject({
      prefix: '/google',
      headers: { 'x-goog-api-key': 'AIza-REAL' },
    });
    expect(opencodeRoute(store.compat)).toMatchObject({
      prefix: '/compat',
      upstream: 'http://localhost:11434/v1',
      allowPrivateUpstream: true,
    });
    expect(opencodeRoute({ ...store.compat, baseUrl: undefined })).toBeUndefined();
    const cfg = opencodeProviderConfig(Object.values(store));
    expect(JSON.stringify(cfg)).not.toMatch(/REAL/);
    expect(cfg.openai).toEqual({
      options: { baseURL: 'http://127.0.0.1:3128/openai/v1', apiKey: DUMMY_KEY },
    });
    expect((cfg.google as any).options.baseURL).toBe('http://127.0.0.1:3128/google/v1beta');
    expect((cfg['openai-compatible'] as any).models).toEqual({ llama3: { name: 'llama3' } });
  });

  it('builds the argv and the environment: prompt on stdin, private XDG folders, every outside influence switched off', () => {
    const c = buildOpencodeCommand(
      {
        prompt: 'SECRET PROMPT',
        model: 'openai/gpt-5',
        sessionEnv: { PATH: '/runner/bin:/usr/bin', HOME: '/agent/home', AOM_SHIFT_TOKEN: 't' },
        configContent: { model: 'openai/gpt-5' },
        ohome: '/agent/opencode',
      },
      { bin: '/bin/opencode' },
      { PATH: '/usr/bin', GH_TOKEN: 'x', OPENAI_API_KEY: 'runner-own', HOME: '/home/owner' },
    );
    expect(c.args).toEqual(['run', '--format', 'json', '--model=openai/gpt-5']);
    expect(c.stdin).toBe('SECRET PROMPT');
    expect(c.env).toMatchObject({
      XDG_CONFIG_HOME: '/agent/opencode/config',
      XDG_DATA_HOME: '/agent/opencode/data',
      XDG_CACHE_HOME: '/agent/opencode/cache',
      XDG_STATE_HOME: '/agent/opencode/state',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_PURE: '1',
      HOME: '/agent/home',
    });
    expect(JSON.parse(c.env.OPENCODE_CONFIG_CONTENT as string)).toEqual({ model: 'openai/gpt-5' });
    expect(c.env.GH_TOKEN).toBeUndefined();
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
    const id = 'ses_e9309a524ffe4bIatxCLKVaY83';
    expect(
      buildOpencodeCommand(
        { prompt: 'p', model: 'm/x', sessionEnv: {}, configContent: {}, ohome: '/o', resumeSessionId: id },
        { bin: 'o' },
        {},
      ).args.slice(-2),
    ).toEqual(['--session', id]);
    expect(
      buildOpencodeCommand(
        {
          prompt: 'p',
          model: 'm/x',
          sessionEnv: {},
          configContent: {},
          ohome: '/o',
          resumeSessionId: '--evil',
        },
        { bin: 'o' },
        {},
      ).args,
    ).not.toContain('--session');
  });

  it('builds permissions: free shell for a builder, aom only for a shell-less role and every chat; edit and web by tool', () => {
    const p = (allowedTools: string[]) => ({ allowedTools, deniedShellPatterns: [] as string[] });
    const b = opencodePermission({
      perms: p(['read', 'edit', 'shell']),
      roleKey: 'builder',
      chat: false,
    }) as any;
    expect(b.bash['*']).toBe('allow');
    expect(b.bash['git push']).toBe('deny');
    expect(b.bash['git push *']).toBe('deny');
    expect(b.bash['git rebase']).toBeUndefined(); // builders may rebase
    expect(b).toMatchObject({
      edit: 'allow',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
      question: 'deny',
      doom_loop: 'deny',
    });
    const a = opencodePermission({ perms: p(['read']), roleKey: 'analyst', chat: false }) as any;
    expect(a.bash).toMatchObject({ '*': 'deny', aom: 'allow', 'aom *': 'allow' });
    expect(a.edit).toBe('deny');
    const chat = opencodePermission({
      perms: p(['read', 'edit', 'shell', 'web']),
      roleKey: 'reviewer',
      chat: true,
    }) as any;
    expect(chat.bash['*']).toBe('deny');
    expect(chat.edit).toBe('deny');
    expect(chat.webfetch).toBe('allow');
    expect(
      (opencodePermission({ perms: p(['read', 'shell']), roleKey: 'reviewer', chat: false }) as any).bash[
        'git checkout'
      ],
    ).toBe('deny');
  });
});

// ------------------------------------------------------------------------------------------------- the adapter with a fake opencode

function fakeOpencode(mode: { lines?: string[]; exit?: number; stderr?: string } = {}) {
  const dir = tmp('aom-fake-opencode-');
  const bin = join(dir, 'opencode');
  const modeFile = join(dir, 'fake.json');
  writeFileSync(modeFile, JSON.stringify(mode));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'), 'utf8'));
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('1.19.4'); process.exit(0); }
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const cfg = process.env.XDG_CONFIG_HOME || '';
  let skills = []; try { skills = fs.readdirSync(path.join(cfg, 'opencode', 'skills')); } catch {}
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, env: process.env, cwd: process.cwd(), stdin, agentsMd: read(path.join(cfg, 'opencode', 'AGENTS.md')), skills }) + '\\n');
  for (const l of mode.lines || []) console.log(l);
  if (mode.stderr) console.error(mode.stderr);
  process.exit(mode.exit || 0);
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    set: (m: object) => writeFileSync(modeFile, JSON.stringify(m)),
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
  providers: Array<{
    id: 'openai' | 'google' | 'openai-compatible';
    key?: string;
    org?: boolean;
    baseUrl?: string;
    models?: string[];
  }>,
  mode: object = { lines: REAL_LINES },
) {
  const t = tmp();
  const fake = fakeOpencode(mode);
  const paths = runnerPaths(join(t, 'data'));
  const sb = await ensureSandbox(paths, A, 'Oc');
  const cwd = join(t, 'wt');
  mkdirSync(cwd, { recursive: true });
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
  for (const p of providers)
    store.set({
      provider: p.id,
      keyId: keys.publicKey.keyId,
      ...(p.org ? { source: 'org' as const, orgId: ORG } : {}),
      ...(p.key ? { ciphertext: await sealLarge(keys.publicKey.publicKey, p.key) } : {}),
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      models: p.models ?? [],
    });
  const launches: HarnessLaunch[] = [];
  const adapter = new OpencodeAdapter(
    OpencodeRuntimeConfigSchema.parse({ bin: fake.bin }) as never,
    paths,
    store,
    {
      sandboxProbe: () => ({ ok: true, reason: 'test' }),
      listModels: async (ps) =>
        ps.flatMap((p) => [`${p.id}/model-a`, `${p.id}/model-b`, 'opencode/hosted-free']),
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
    name: 'Oc',
    roleKey: 'builder',
    seniority: 'senior',
    runtime: 'opencode',
    model: 'openai/model-a',
    skills: [],
    permissions: PERMS,
    isDevops: false,
    ...over,
  });
  const start = async (over: { agent?: object; kind?: string; skills?: string[] } = {}) => {
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
      ...(over.skills
        ? {
            grantedSkills: over.skills.map((name) => ({
              name,
              files: { 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\nb\n` },
            })),
          }
        : {}),
    } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    return { ev, usage: s.usage() };
  };
  return { t, fake, paths, sb, cwd, store, keys, adapter, launches, start, agent };
}

describe('the opencode adapter (fake binary)', () => {
  it('registers only when the binary exists, on Linux', () => {
    const f = fakeOpencode();
    expect(detectOpencode({ bin: f.bin, enabled: true } as never, { platform: 'linux' })).toBe(f.bin);
    expect(detectOpencode({ bin: '/nope', enabled: true } as never, { platform: 'linux' })).toBeUndefined();
    expect(detectOpencode({ bin: f.bin, enabled: false } as never, { platform: 'linux' })).toBeUndefined();
    expect(detectOpencode({ bin: f.bin, enabled: true } as never, { platform: 'win32' })).toBeUndefined();
    expect(detectOpencode(undefined, { platform: 'linux', pathVar: '/nope', blocked: true })).toBeUndefined();
    const t = tmp();
    const cfg = makeConfig(t, { runtimes: { 'claude-code': {}, opencode: { bin: f.bin } } } as never);
    expect(buildAdapters(RunnerConfigSchema.parse(cfg), runnerPaths(join(t, 'data'))).has('opencode')).toBe(
      process.platform === 'linux',
    );
  });

  it('runs a shift: stdin prompt, inline config with routes and stand-in keys, private folders, instructions and skills', async () => {
    const w = await world([
      { id: 'openai', key: 'sk-oai-REAL', org: true },
      { id: 'google', key: 'AIza-REAL' },
    ]);
    await w.adapter.writeInstructions(w.sb, '# Role\nINSTR\n');
    const { ev, usage } = await w.start({ skills: ['a', 'b'] });
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    expect(usage).toMatchObject({
      model: 'opencode:openai/model-a',
      keySource: 'org',
      keyProvider: 'openai',
    });
    const c = w.fake.calls()[0];
    expect(c.stdin).toBe('do the card');
    expect(c.argv).toEqual(['run', '--format', 'json', '--model=openai/model-a']);
    expect(c.agentsMd).toContain('INSTR');
    expect(c.skills.sort()).toEqual(['a', 'b']);
    expect(c.env.XDG_CONFIG_HOME).toBe(`${opencodeHomeOf(w.sb)}/config`);
    expect(JSON.stringify(c.env)).not.toMatch(/REAL/);
    const cfg = JSON.parse(c.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.enabled_providers).toEqual(['openai', 'google']);
    expect(cfg.model).toBe('openai/model-a');
    expect(cfg.share).toBe('disabled');
    expect(cfg.permission.bash['*']).toBe('allow');
    const l = w.launches[0] as HarnessLaunch;
    expect(l.routes?.map((r) => r.prefix)).toEqual(['/openai', '/google']);
    expect(l.routes?.[0]?.headers.authorization).toBe('Bearer sk-oai-REAL');
    expect(l.cliHosts).toEqual(['api.openai.com', 'generativelanguage.googleapis.com']);
    expect(l.sandbox.writable).toEqual([opencodeHomeOf(w.sb)]);
    expect(l.sandbox.mayCommit).toBe(true);
    expect(l.sandbox.readonly).toContain('/vault');
    expect(l.hiddenFromShell).toBeUndefined();
    // a second shift grants fewer skills: the folder holds exactly those
    await w.start({ skills: ['b'] });
    expect(readdirSync(join(opencodeHomeOf(w.sb), 'config', 'opencode', 'skills'))).toEqual(['b']);
  });

  it('adds the repository’s AGENTS.md by path when there is one', async () => {
    const w = await world([{ id: 'openai', key: 'k' }]);
    await w.start();
    expect(JSON.parse(w.fake.calls()[0].env.OPENCODE_CONFIG_CONTENT).instructions).toBeUndefined();
    writeFileSync(join(w.cwd, 'AGENTS.md'), 'repo');
    await w.start();
    expect(JSON.parse(w.fake.calls()[1].env.OPENCODE_CONFIG_CONTENT).instructions).toEqual([
      join(w.cwd, 'AGENTS.md'),
    ]);
  });

  it('a workstation key beats the organization key; a keyless local endpoint spends none', async () => {
    const own = await world([{ id: 'openai', key: 'sk-org', org: true }]);
    own.store.set({
      provider: 'openai',
      keyId: own.keys.publicKey.keyId,
      ciphertext: await sealLarge(own.keys.publicKey.publicKey, 'sk-own'),
      models: [],
    });
    expect((await own.start()).usage.keySource).toBe('workstation');
    expect(own.launches[0]?.routes?.[0]?.headers.authorization).toBe('Bearer sk-own');
    const local = await world([
      { id: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', models: ['llama3'] },
    ]);
    const { usage } = await local.start({ agent: { model: 'openai-compatible/llama3' } });
    expect(usage.keySource).toBeUndefined();
    expect(local.launches[0]?.routes?.[0]).toMatchObject({ prefix: '/compat', allowPrivateUpstream: true });
  });

  it('reports the models of the providers held here, and is unavailable without a key', async () => {
    const w = await world([
      { id: 'openai', key: 'k', org: true },
      { id: 'google', key: 'g' },
    ]);
    const caps = await w.adapter.capabilities();
    expect(caps).toMatchObject({
      runtime: 'opencode',
      available: true,
      auth: 'ok',
      sandbox: 'enforced',
      version: '1.19.4',
    });
    expect(caps.models?.map((m) => m.id)).toEqual([
      'openai/model-a',
      'openai/model-b',
      'google/model-a',
      'google/model-b',
    ]);
    const none = await world([]);
    expect(await none.adapter.capabilities()).toMatchObject({ available: false, auth: 'expired' });
    await expect(none.start()).rejects.toThrow(/not set up on this workstation/);
  });

  it('reports the sandbox problem and an old binary', async () => {
    const w = await world([{ id: 'openai', key: 'k' }]);
    const bad = new OpencodeAdapter(
      OpencodeRuntimeConfigSchema.parse({ bin: w.fake.bin }) as never,
      w.paths,
      w.store,
      { sandboxProbe: () => ({ ok: false, reason: 'socat not installed' }) },
    );
    expect(await bad.capabilities()).toMatchObject({
      available: false,
      sandbox: 'unavailable',
      sandboxReason: 'socat not installed',
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
      readFileSync(w.fake.bin, 'utf8').replace("console.log('1.19.4')", "console.log('1.18.0')"),
    );
    expect(await w.adapter.capabilities()).toMatchObject({
      available: false,
      sandboxReason: expect.stringMatching(/older than 1\.19\.4/),
    });
  });

  it('puts a key failure back and turns a spent quota into a usage limit', async () => {
    const w = await world([{ id: 'openai', key: 'k' }], {
      lines: [
        j({
          type: 'error',
          sessionID: SID,
          error: { name: 'APIError', data: { message: 'Incorrect API key provided', statusCode: 401 } },
        }),
      ],
      exit: 1,
    });
    expect((await w.start()).ev.at(-1)).toMatchObject({ kind: 'exit', code: 1, authFailed: true });
    w.fake.set({
      lines: [
        j({
          type: 'error',
          sessionID: SID,
          error: {
            name: 'APIError',
            data: {
              message: 'You exceeded your current quota, please check your plan and billing details',
              statusCode: 429,
            },
          },
        }),
      ],
      exit: 1,
    });
    expect((await w.start()).ev.at(-1)).toMatchObject({
      kind: 'exit',
      usageLimit: { until: expect.any(String) },
    });
  });

  it('refuses the roles its sandbox cannot confine, and DevOps, CEO and intake', async () => {
    const w = await world([{ id: 'openai', key: 'k' }]);
    await expect(
      w.start({ agent: { roleKey: 'tester', permissions: { ...PERMS, browser: true } } }),
    ).rejects.toThrow(/runtime_role_refused.*browsers/);
    await expect(
      w.start({ agent: { roleKey: 'writer', permissions: { ...PERMS, writableGlobs: ['docs/**'] } } }),
    ).rejects.toThrow(/certain paths/);
    await expect(w.start({ agent: { roleKey: 'ceo' } })).rejects.toThrow(/guard/);
    await expect(w.start({ kind: 'devops' })).rejects.toThrow(/DevOps and CEO/);
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
    const { ev } = await w.start({
      agent: { roleKey: 'analyst', permissions: { ...PERMS, allowedTools: ['read'], mayCommit: false } },
    });
    expect(ev.at(-1)).toMatchObject({ code: 0 });
    expect(JSON.parse(w.fake.calls().at(-1).env.OPENCODE_CONFIG_CONTENT).permission.bash['*']).toBe('deny');
    expect(w.launches.at(-1)?.sandbox.readOnlyCwd).toBe(true);
  });

  it('resumes a chat by its opencode session id', async () => {
    const w = await world([{ id: 'openai', key: 'k' }]);
    const s = await w.adapter.startChat({
      chatId: 'c',
      message: 'hello',
      cwd: w.cwd,
      sandbox: w.sb,
      agent: w.agent({ roleKey: 'reviewer' }),
      env: { PATH: '/usr/bin' },
      readOnly: true,
      resumeSessionId: SID,
    } as never);
    for await (const _ of s.events());
    const c = w.fake.calls()[0];
    expect(c.stdin).toBe('hello');
    expect(c.argv.slice(-2)).toEqual(['--session', SID]);
    expect(JSON.parse(c.env.OPENCODE_CONFIG_CONTENT).permission.bash['*']).toBe('deny');
  });
});
