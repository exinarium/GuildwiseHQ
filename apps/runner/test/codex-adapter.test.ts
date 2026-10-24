import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { codexRoleProblem, costUsdMicros, isCostUnknown } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCodexCommand,
  buildCodexHarnessCommand,
  CodexAdapter,
  type CodexHost,
  codexFilesystem,
  codexHomeOf,
  codexPermissions,
  codexRules,
  codexSkillsDirOf,
  detectCodex,
  tomlValue,
} from '../src/adapters/codex.ts';
import {
  CodexStreamParser,
  codexUsageLimit,
  isCodexAuthFailureText,
} from '../src/adapters/codex-stream-parser.ts';
import type { HarnessLaunch } from '../src/adapters/harness-session.ts';
import { buildAdapters } from '../src/adapters/registry.ts';
import type { ChatStartInput, RuntimeEvent, RuntimeSession, ShiftStartInput } from '../src/adapters/types.ts';
import { RunnerConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

cleanupTmp();

// ------------------------------------------------------------------------------------------------- the fake codex

interface FakeMode {
  /** JSONL lines printed by `codex exec`. */
  lines?: string[];
  exit?: number;
  stderr?: string;
  /** `codex sandbox -- true` fails with this text. */
  sandboxFail?: string;
}

interface Recorded {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  agentsMd: string | null;
  authJson: string | null;
  skills: string[];
  rules: string | null;
}

/**
 * A `codex` that is a node script: `--version`, `sandbox` (the runner's self-test) and `exec` (prints the JSONL of
 * `fake.json` and records its argv, environment, cwd, stdin and what it finds in CODEX_HOME and HOME).
 */
function fakeCodex(mode: FakeMode = {}): {
  bin: string;
  dir: string;
  setMode: (m: FakeMode) => void;
  calls: () => Recorded[];
} {
  const dir = tmp('aom-fake-codex-');
  const bin = join(dir, 'codex');
  const modeFile = join(dir, 'fake.json');
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(modeFile, JSON.stringify(mode));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'), 'utf8'));
const argv = process.argv.slice(2);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
if (argv[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
if (argv[0] === 'sandbox') {
  if (mode.sandboxFail) { console.error(mode.sandboxFail); process.exit(1); }
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const home = process.env.CODEX_HOME || '';
  let skills = [];
  try { skills = fs.readdirSync(path.join(process.env.HOME || '', '.agents', 'skills')); } catch {}
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({
    argv, env: process.env, cwd: process.cwd(), stdin,
    agentsMd: read(path.join(home, 'AGENTS.md')), authJson: read(path.join(home, 'auth.json')), skills,
    rules: read(path.join(home, 'rules', 'aom.rules')),
  }) + '\\n');
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
    setMode: (m) => writeFileSync(modeFile, JSON.stringify(m)),
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Recorded)
        : [],
  };
}

const j = (o: object): string => JSON.stringify(o);
const OK_LINES = [
  j({ type: 'thread.started', thread_id: '01a166aa-c955-7242-8bbe-de9be3f4f8f3' }),
  j({ type: 'turn.started' }),
  j({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } }),
  j({
    type: 'item.started',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: 'ls',
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    },
  }),
  j({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: 'ls',
      aggregated_output: 'a\nb\n',
      exit_code: 0,
      status: 'completed',
    },
  }),
  j({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'all done' } }),
  j({
    type: 'turn.completed',
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_input_tokens: 0,
      output_tokens: 50,
      reasoning_output_tokens: 10,
    },
  }),
];

const PERMS = {
  allowedTools: ['read', 'edit', 'shell'],
  deniedShellPatterns: ['git push*', 'git rebase*', 'rm -rf /*', 'sudo *'],
  writableGlobs: null,
  mayCommit: true,
  browser: false,
  riskTiers: ['small', 'large'],
  readOrgRepos: false,
  repoIds: null,
};

interface Rig {
  adapter: CodexAdapter;
  fake: ReturnType<typeof fakeCodex>;
  root: string;
  login: string;
  sandbox: ShiftStartInput['sandbox'];
  cwd: string;
  parent: NodeJS.ProcessEnv;
}

function rig(
  opts: {
    mode?: FakeMode;
    authMode?: 'login' | 'api_key';
    apiKey?: string;
    noLogin?: boolean;
    sandbox?: 'native' | 'harness';
    host?: CodexHost;
  } = {},
): Rig {
  const fake = fakeCodex(opts.mode ?? { lines: OK_LINES });
  const root = tmp('aom-codex-root-');
  const home = tmp('aom-codex-home-');
  const loginDir = join(home, '.codex');
  mkdirSync(loginDir, { recursive: true });
  const login = join(loginDir, 'auth.json');
  if (!opts.noLogin)
    writeFileSync(login, j({ tokens: { access_token: 'user-token' }, last_refresh: '2026-01-01T00:00:00Z' }));
  const agentDir = join(root, 'agents', 'ag1');
  const sandbox = {
    home: join(agentDir, 'home'),
    configDir: join(agentDir, 'claude'),
    scratch: join(agentDir, 'scratch'),
    tmp: join(agentDir, 'tmp'),
  };
  for (const d of Object.values(sandbox)) mkdirSync(d, { recursive: true });
  const cwd = join(root, 'wt');
  mkdirSync(cwd, { recursive: true });
  const parent = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    RUNNER_SECRET: 'runner-secret',
    GH_TOKEN: 'gh-token',
    SSH_AUTH_SOCK: '/tmp/ssh',
  };
  const adapter = new CodexAdapter(
    {
      enabled: true,
      bin: fake.bin,
      authMode: opts.authMode ?? 'login',
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      toolchainPaths: [],
      sandbox: opts.sandbox ?? 'native',
    },
    runnerPaths(root),
    { home, parent, platform: 'linux', ...(opts.host ?? {}) },
  );
  return { adapter, fake, root, login, sandbox, cwd, parent };
}

function shiftInput(
  r: Rig,
  over: Partial<ShiftStartInput> & { permissions?: object; roleKey?: string; isDevops?: boolean } = {},
): ShiftStartInput {
  const { permissions, roleKey, isDevops, ...rest } = over;
  return {
    shiftId: 'sh1',
    prompt: 'Work card ABC-1 now',
    instructionsMarkdown: '# role',
    cwd: r.cwd,
    sandbox: r.sandbox,
    agent: {
      agentId: 'ag1',
      name: 'Ada',
      roleKey: roleKey ?? 'builder',
      seniority: 'senior',
      runtime: 'codex',
      model: 'gpt-6-sol',
      effort: 'high',
      skills: [],
      permissions: { ...PERMS, ...(permissions ?? {}) },
      ...(isDevops ? { isDevops: true } : {}),
    },
    env: {
      HOME: r.sandbox.home,
      TMPDIR: r.sandbox.tmp,
      PATH: '/runner/bin:/usr/bin',
      AOM_SHIFT_TOKEN: 'shift-token',
      AOM_SHIFT_ID: 'sh1',
      AOM_IPC_URL: 'http://127.0.0.1:1234',
      AOM_IPC_SOCKET: '/tmp/aom-ipc-x/ipc.sock',
      CLAUDE_CONFIG_DIR: r.sandbox.configDir,
    },
    addDirs: [],
    maxShiftMinutes: 5,
    ...rest,
  } as unknown as ShiftStartInput;
}

async function drain(s: RuntimeSession): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of s.events()) out.push(e);
  return out;
}

const argAfter = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
const configs = (argv: string[]): string[] => argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []));

// ------------------------------------------------------------------------------------------------- tests

describe('codex adapter: a shift on a fake codex binary', () => {
  it('runs `codex exec --json` with the verified flags, a private CODEX_HOME and a minimal environment', async () => {
    const r = rig();
    await r.adapter.writeInstructions(r.sandbox, '# Instructions\nbe good\n');
    const events = await drain(
      await r.adapter.start(
        shiftInput(r, {
          grantedSkills: [
            { name: 'demo-skill', files: { 'SKILL.md': '---\nname: demo-skill\ndescription: d\n---\nbody' } },
          ],
        }),
      ),
    );
    const [call] = r.fake.calls();
    expect(call).toBeDefined();
    const c = call as Recorded;
    // argv: exec, JSON events, no repo check, strict config, the working folder and model; the prompt comes from stdin
    expect(c.argv[0]).toBe('exec');
    expect(c.argv).toContain('--json');
    expect(c.argv).toContain('--skip-git-repo-check');
    expect(c.argv).toContain('--strict-config');
    expect(argAfter(c.argv, '--cd')).toBe(r.cwd);
    expect(c.argv).toContain('--model=gpt-6-sol');
    expect(c.argv.at(-1)).toBe('-');
    expect(c.argv).not.toContain('--sandbox'); // a permission profile does not combine with it
    expect(c.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(c.argv.join(' ')).not.toContain('Work card ABC-1'); // the prompt never shows in argv
    expect(c.stdin).toBe('Work card ABC-1 now');
    expect(c.cwd).toBe(r.cwd);
    const cfg = configs(c.argv);
    expect(cfg).toContain('approval_policy="never"');
    expect(cfg).toContain('default_permissions="aom"');
    expect(cfg).toContain('model_reasoning_effort="high"');
    expect(cfg).toContain('web_search="disabled"');
    expect(cfg).toContain('allow_login_shell=false');
    expect(cfg).toContain('cli_auth_credentials_store="file"');
    expect(cfg.find((x) => x.startsWith('permissions.aom='))).toContain('"enabled" = false');
    // the codex process: allow-listed variables, the session's, CODEX_HOME, nothing of the runner's
    expect(c.env.CODEX_HOME).toBe(codexHomeOf(r.sandbox));
    expect(c.env.HOME).toBe(r.sandbox.home);
    expect(c.env.AOM_SHIFT_TOKEN).toBe('shift-token');
    expect(c.env.PATH).toBe('/runner/bin:/usr/bin');
    expect(c.env.RUNNER_SECRET).toBeUndefined();
    expect(c.env.GH_TOKEN).toBeUndefined();
    expect(c.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(c.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(c.env.CODEX_API_KEY).toBeUndefined();
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
    // the shell's environment is set in full, without the codex-only variables
    const shellPolicy = cfg.find((x) => x.startsWith('shell_environment_policy=')) ?? '';
    expect(shellPolicy).toContain('"inherit" = "none"');
    expect(shellPolicy).toContain('"AOM_SHIFT_TOKEN" = "shift-token"');
    expect(shellPolicy).toContain('"AOM_IPC_SOCKET"');
    expect(shellPolicy).not.toMatch(
      /RUNNER_SECRET|CODEX_HOME|CODEX_API_KEY|CLAUDE_CONFIG_DIR|runner-secret|gh-token/,
    );
    // instructions: the shared renderer's text, verbatim, as the global AGENTS.md of the private home
    expect(c.agentsMd).toBe('# Instructions\nbe good\n');
    expect(existsSync(join(r.sandbox.home, '..', 'codex', 'AGENTS.md'))).toBe(true);
    // skills: the USER-scope folder inside the agent's private HOME, nothing in the worktree
    expect(c.skills).toEqual(['demo-skill']);
    expect(codexSkillsDirOf(r.sandbox)).toBe(join(r.sandbox.home, '.agents', 'skills'));
    expect(existsSync(join(r.cwd, '.agents'))).toBe(false);
    // the owner's login was copied in privately (mode 0600), the rules are there
    expect(c.authJson).toContain('user-token');
    expect(statSync(join(codexHomeOf(r.sandbox), 'auth.json')).mode & 0o777).toBe(0o600);
    expect(c.rules).toContain('prefix_rule(pattern=["aom"], decision="allow")');
    expect(c.rules).toContain('pattern=["git","push"], decision="forbidden"');
    // the events
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'thinking',
      'tool',
      'toolresult',
      'progress',
      'usage',
      'final',
      'exit',
    ]);
    expect(events[0]).toEqual({ kind: 'session', runtimeSessionId: '01a166aa-c955-7242-8bbe-de9be3f4f8f3' });
    expect(events[2]).toEqual({ kind: 'tool', name: 'Bash', summary: 'ls', id: 'item_1' });
    expect(events[3]).toEqual({ kind: 'toolresult', id: 'item_1', bytes: 4 });
    expect(events.at(-3)).toMatchObject({
      kind: 'usage',
      usage: {
        inputTokens: 400,
        cacheReadTokens: 600,
        cacheWriteTokens: 0,
        outputTokens: 50,
        model: 'codex:gpt-6-sol',
      },
    });
    expect(events.at(-2)).toEqual({ kind: 'final', text: 'all done' });
    expect(events.at(-1)).toEqual({ kind: 'exit', code: 0 });
  });

  it('resumes a thread with `resume <id> -` and replaces the skills of an earlier shift', async () => {
    const r = rig();
    const skills = (names: string[]) =>
      names.map((name) => ({ name, files: { 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\n` } }));
    await drain(await r.adapter.start(shiftInput(r, { grantedSkills: skills(['one', 'two']) })));
    await drain(
      await r.adapter.start(
        shiftInput(r, {
          resumeSessionId: '0190aaaa-1111-7222-8333-444455556666',
          grantedSkills: skills(['two']),
        }),
      ),
    );
    const calls = r.fake.calls();
    expect(calls[0]?.skills).toEqual(['one', 'two']);
    expect(calls[1]?.skills).toEqual(['two']);
    const argv = calls[1]?.argv ?? [];
    expect(argv.slice(-4)).toEqual(['resume', '--', '0190aaaa-1111-7222-8333-444455556666', '-']);
    expect(argv.indexOf('--json')).toBeLessThan(argv.indexOf('resume'));
  });

  it('hands a refreshed login back to the owner, and never overwrites a fresher private copy', async () => {
    const r = rig();
    await drain(await r.adapter.start(shiftInput(r)));
    const mine = join(codexHomeOf(r.sandbox), 'auth.json');
    // codex refreshed the token during the session
    writeFileSync(mine, j({ tokens: { access_token: 'refreshed' }, last_refresh: '2026-06-01T00:00:00Z' }));
    await drain(await r.adapter.start(shiftInput(r)));
    expect(readFileSync(r.login, 'utf8')).toContain('refreshed');
    expect(readFileSync(mine, 'utf8')).toContain('refreshed');
  });

  it('api_key mode passes CODEX_API_KEY and forces the API login; no login file is read', async () => {
    const r = rig({ authMode: 'api_key', apiKey: 'sk-test-key', noLogin: true });
    await drain(await r.adapter.start(shiftInput(r)));
    const c = r.fake.calls()[0] as Recorded;
    expect(c.env.CODEX_API_KEY).toBe('sk-test-key');
    expect(c.authJson).toBeNull();
    expect(configs(c.argv)).toContain('forced_login_method="api"');
    expect(c.argv.join(' ')).not.toContain('sk-test-key');
    expect(JSON.stringify(configs(c.argv))).not.toContain('sk-test-key');
  });

  it('refuses a shift when nobody is signed in, and says how to fix it', async () => {
    const r = rig({ noLogin: true });
    await expect(r.adapter.start(shiftInput(r))).rejects.toThrow(/not signed in.*codex login/);
    const caps = await r.adapter.capabilities();
    expect(caps).toMatchObject({ available: false, auth: 'expired' });
  });

  it('maps a login failure to authFailed (the shift is put back, not counted as a crash)', async () => {
    const r = rig({
      mode: {
        lines: [
          j({ type: 'thread.started', thread_id: 't1' }),
          j({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized)' }),
          j({
            type: 'turn.failed',
            error: {
              message:
                'unexpected status 401 Unauthorized: Incorrect API key provided: sk-abc123456789012345678901',
            },
          }),
        ],
        exit: 1,
      },
    });
    const events = await drain(await r.adapter.start(shiftInput(r)));
    const exit = events.at(-1);
    expect(exit).toMatchObject({ kind: 'exit', code: 1, authFailed: true });
    expect((exit as { error: string }).error).toContain('401');
    expect((exit as { error: string }).error).not.toContain('sk-abc123456789012345678901'); // redacted
    // the runtime now reports itself as signed out until the login file changes
    expect(await r.adapter.capabilities()).toMatchObject({ available: false, auth: 'expired' });
    writeFileSync(r.login, j({ last_refresh: '2026-07-01T00:00:00Z', tokens: { access_token: 'new' } }));
    expect(await r.adapter.capabilities()).toMatchObject({ available: true, auth: 'ok' });
  });

  it('maps a usage limit to usageLimit', async () => {
    const r = rig({
      mode: {
        lines: [
          j({
            type: 'turn.failed',
            error: { message: "You've hit your usage limit. Try again in 2 hours 5 minutes." },
          }),
        ],
        exit: 1,
      },
    });
    const events = await drain(await r.adapter.start(shiftInput(r)));
    const exit = events.at(-1) as Extract<RuntimeEvent, { kind: 'exit' }>;
    expect(exit.code).toBe(1);
    expect(exit.authFailed).toBeUndefined();
    const until = Date.parse(exit.usageLimit?.until ?? '');
    expect(until - Date.now()).toBeGreaterThan(2 * 3600_000);
    expect(until - Date.now()).toBeLessThan(2.2 * 3600_000);
  });

  it('reports an ordinary failure with its text and the exit code', async () => {
    const r = rig({
      mode: {
        lines: [j({ type: 'turn.failed', error: { message: 'the model is overloaded' } })],
        exit: 1,
        stderr: 'boom',
      },
    });
    const events = await drain(await r.adapter.start(shiftInput(r)));
    expect(events.at(-1)).toMatchObject({ kind: 'exit', code: 1 });
    expect((events.at(-1) as { error: string }).error).toContain('the model is overloaded');
    expect(events.at(-1)).not.toHaveProperty('authFailed');
  });

  it('reports a spawn failure as startFailed', async () => {
    const r = rig();
    const adapter = new CodexAdapter(
      { enabled: true, bin: '/nonexistent/codex', authMode: 'login', toolchainPaths: [], sandbox: 'native' },
      runnerPaths(r.root),
      {
        home: join(r.login, '..', '..'),
        sandboxProbe: async () => ({ ok: true, reason: 'test' }),
      },
    );
    const events = await drain(await adapter.start(shiftInput(r)));
    expect(events.at(-1)).toMatchObject({ kind: 'exit', startFailed: true });
  });
});

describe('codex adapter: sandbox state and refusals', () => {
  it('reports the sandbox from a real self-test and refuses to run without it', async () => {
    const r = rig({
      mode: { lines: OK_LINES, sandboxFail: 'bwrap: No permissions to create new namespace' },
    });
    const caps = await r.adapter.capabilities();
    expect(caps).toMatchObject({
      runtime: 'codex',
      version: '0.163.0',
      available: false,
      sandbox: 'unavailable',
      capabilities: [],
    });
    expect(caps.sandboxReason).toContain('No permissions to create new namespace');
    await expect(r.adapter.start(shiftInput(r))).rejects.toThrow(/Codex sandbox is unavailable/);
    await expect(r.adapter.startChat({ ...(chatInput(r) as object) } as ChatStartInput)).rejects.toThrow(
      /sandbox is unavailable/,
    );
    expect(r.fake.calls()).toHaveLength(0); // codex exec never ran
  });

  it('is available with an enforced sandbox and a login', async () => {
    const r = rig();
    const caps = await r.adapter.capabilities();
    expect(caps).toMatchObject({
      runtime: 'codex',
      version: '0.163.0',
      available: true,
      sandbox: 'enforced',
      auth: 'ok',
    });
    expect(caps.capabilities).toEqual(['shell', 'edit', 'web', 'skills', 'resume']);
    expect(caps.capabilities).not.toContain('mcp');
  });

  it('is unavailable on a platform without the Codex sandbox', async () => {
    const r = rig();
    const adapter = new CodexAdapter(
      { enabled: true, bin: r.fake.bin, authMode: 'login', toolchainPaths: [], sandbox: 'native' },
      runnerPaths(r.root),
      {
        platform: 'win32',
        home: join(r.login, '..', '..'),
      },
    );
    expect(await adapter.capabilities()).toMatchObject({ available: false, sandbox: 'unavailable' });
  });

  it.each([
    ['devops', { roleKey: 'devops', isDevops: true }],
    ['ceo', { roleKey: 'ceo' }],
    ['a role with no shell', { roleKey: 'analyst', permissions: { allowedTools: ['read'] } }],
    [
      'a role that writes only some paths (tester, writer)',
      { roleKey: 'writer', permissions: { writableGlobs: ['docs/**'] } },
    ],
    ['a browser role', { roleKey: 'tester', permissions: { browser: true } }],
  ])('refuses %s', async (_n, over) => {
    const r = rig();
    await expect(r.adapter.start(shiftInput(r, over as never))).rejects.toThrow(/codex_role_refused/);
    expect(r.fake.calls()).toHaveLength(0);
  });

  it('refuses the DevOps guard and the DevOps/CEO shift kinds', async () => {
    const r = rig();
    await expect(r.adapter.start(shiftInput(r, { devopsGuard: { sessionRef: 'x' } }))).rejects.toThrow(
      /codex_role_refused/,
    );
    await expect(r.adapter.start(shiftInput(r, { kind: 'ceo' }))).rejects.toThrow(/codex_role_refused/);
  });

  it('shares its role rule with the server (codexRoleProblem)', () => {
    expect(codexRoleProblem({ roleKey: 'builder', permissions: PERMS })).toBeNull();
    expect(
      codexRoleProblem({ roleKey: 'reviewer', permissions: { ...PERMS, allowedTools: ['read', 'shell'] } }),
    ).toBeNull();
    expect(codexRoleProblem({ roleKey: 'devops', permissions: PERMS })).toMatch(/guard/);
    expect(codexRoleProblem({ roleKey: 'x', isDevops: true, permissions: PERMS })).not.toBeNull();
    expect(codexRoleProblem({ roleKey: 'x', permissions: { ...PERMS, allowedTools: ['read'] } })).toMatch(
      /no shell/,
    );
  });
});

function chatInput(r: Rig, over: Partial<ChatStartInput> = {}): ChatStartInput {
  return {
    chatId: 'chat1',
    message: 'What is in this repo?',
    cwd: r.cwd,
    sandbox: r.sandbox,
    agent: {
      agentId: 'ag1',
      name: 'Ada',
      roleKey: 'reviewer',
      seniority: 'senior',
      runtime: 'codex',
      model: 'gpt-6-luna',
      skills: [],
      permissions: { ...PERMS, allowedTools: ['read', 'shell'], mayCommit: false },
    },
    env: {
      HOME: r.sandbox.home,
      PATH: '/runner/bin:/usr/bin',
      AOM_SHIFT_TOKEN: 'chat-token',
      CLAUDE_CONFIG_DIR: r.sandbox.configDir,
    },
    readOnly: true,
    ...over,
  } as unknown as ChatStartInput;
}

describe('codex adapter: chats', () => {
  it('streams the reply as textstart + delta, resumes by thread id, and keeps the worktree read-only', async () => {
    const r = rig();
    const events = await drain(
      await r.adapter.startChat(chatInput(r, { resumeSessionId: '0190bbbb-1111-7222-8333-444455556666' })),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'thinking',
      'tool',
      'toolresult',
      'textstart',
      'delta',
      'progress',
      'usage',
      'final',
      'exit',
    ]);
    expect(events.find((e) => e.kind === 'delta')).toEqual({ kind: 'delta', text: 'all done' });
    const c = r.fake.calls()[0] as Recorded;
    expect(c.argv.slice(-4)).toEqual(['resume', '--', '0190bbbb-1111-7222-8333-444455556666', '-']);
    expect(c.argv).toContain('--model=gpt-6-luna');
    expect(c.stdin).toBe('What is in this repo?');
    expect(configs(c.argv).find((x) => x.startsWith('permissions.aom='))).toContain(
      '":workspace_roots" = {"." = "read"}',
    );
  });

  it.each([
    ['the CEO', { agent: { roleKey: 'ceo' } }],
    ['the DevOps engineer', { agent: { roleKey: 'devops', isDevops: true } }],
    ['the intake chat', { intake: true }],
  ])('refuses %s', async (_n, over) => {
    const r = rig();
    const base = chatInput(r);
    const input = {
      ...base,
      ...over,
      agent: { ...base.agent, ...((over as { agent?: object }).agent ?? {}) },
    } as ChatStartInput;
    await expect(r.adapter.startChat(input)).rejects.toThrow(/codex_role_refused/);
    expect(r.fake.calls()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------- pure parts

describe('codex command and profile', () => {
  const profileBase = {
    cwd: '/work/wt',
    readOnlyCwd: false,
    sandbox: {
      home: '/runner/agents/a/home',
      scratch: '/runner/agents/a/scratch',
      tmp: '/tmp/aom-abc',
      cacheRoot: '/runner/cache',
    },
    gitDirs: [],
    mayCommit: false,
    readDirs: [],
    addDirs: [],
    toolchainReadPaths: ['/opt/node'],
    aomReadPaths: ['/runner/bin'],
    codexReadPaths: ['/opt/codex'],
  };

  it('grants a deny-by-default filesystem: the private home, the worktree, named read-only folders, nothing else', () => {
    const fs = codexFilesystem({ ...profileBase, addDirs: ['/vault/proj'], readDirs: ['/refs/repo'] });
    expect(fs[':minimal']).toBe('read');
    expect(fs['/runner/agents/a/home']).toBe('write');
    expect(fs['/runner/agents/a/scratch']).toBe('write');
    expect(fs['/tmp/aom-abc']).toBe('write');
    expect(fs['/runner/cache']).toBe('write');
    expect(fs['/opt/node']).toBe('read');
    expect(fs['/runner/bin']).toBe('read');
    expect(fs['/opt/codex']).toBe('read');
    expect(fs['/vault/proj']).toBe('read');
    expect(fs['/refs/repo']).toBe('read');
    // reference repositories keep their secret files unreadable
    expect(fs['/refs/repo/**/.env']).toBe('deny');
    expect(fs['/refs/repo/**/id_rsa*']).toBe('deny');
    // nothing grants the runner's data dir, the owner's home or this agent's Codex home
    const granted = Object.keys(fs).join('\n');
    expect(granted).not.toMatch(/codex'|\/codex$|config\.json|secrets|\.ssh|\.codex/);
  });

  it('opens the git metadata of a worktree for committing only: admin dir, objects, refs, logs', () => {
    const repo = tmp('aom-codex-repo-');
    const common = join(repo, '.git');
    mkdirSync(join(common, 'worktrees', 'card'), { recursive: true });
    const wt = tmp('aom-codex-wt-');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(common, 'worktrees', 'card')}\n`);
    const commit = codexFilesystem({ ...profileBase, cwd: wt, gitDirs: [common], mayCommit: true });
    expect(commit[common]).toBe('read');
    for (const p of [
      join(common, 'worktrees', 'card'),
      join(common, 'objects'),
      join(common, 'refs'),
      join(common, 'logs'),
    ])
      expect(commit[p]).toBe('write');
    expect(commit[join(common, 'config')]).toBeUndefined();
    expect(commit[join(common, 'hooks')]).toBeUndefined();
    const readOnly = codexFilesystem({ ...profileBase, cwd: wt, gitDirs: [common], mayCommit: false });
    expect(Object.entries(readOnly).filter(([k, v]) => k.startsWith(common) && v === 'write')).toEqual([]);
  });

  it('a read-only working folder is read-only, scratch included when it is the working folder', () => {
    const p = codexPermissions({ ...profileBase, readOnlyCwd: true, cwd: '/runner/agents/a/scratch' }) as {
      filesystem: Record<string, unknown>;
      network: { enabled: boolean };
    };
    expect(p.filesystem[':workspace_roots']).toEqual({ '.': 'read' });
    expect(p.filesystem['/runner/agents/a/scratch']).toBeUndefined();
    expect(p.network).toEqual({ enabled: false });
    const q = codexPermissions({ ...profileBase, readOnlyCwd: true }) as {
      filesystem: Record<string, unknown>;
    };
    expect(q.filesystem['/runner/agents/a/scratch']).toBe('write'); // a reviewer still writes its notes
  });

  it('writes TOML the way codex parses -c values', () => {
    expect(tomlValue({ a: 'x"y', b: [1, true], 'c d': { e: false } })).toBe(
      '{"a" = "x\\"y", "b" = [1, true], "c d" = {"e" = false}}',
    );
  });

  it('turns the role patterns into execpolicy rules, aom allowed outside the sandbox', () => {
    const rules = codexRules(
      { deniedShellPatterns: ['git push*', 'git rebase*', 'rm -rf /*', 'sudo *', 'git fetch*'] },
      'reviewer',
    );
    expect(rules).toContain('prefix_rule(pattern=["aom"], decision="allow")');
    for (const w of [
      ['git', 'push'],
      ['git', 'rebase'],
      ['git', 'checkout'],
      ['sudo'],
      ['git', 'fetch'],
      ['git', 'reset', '--hard'],
      ['git', 'stash', 'drop'],
    ])
      expect(rules).toContain(`pattern=${JSON.stringify(w)}, decision="forbidden"`);
    expect(rules).not.toContain('/*'); // not expressible as a prefix
    // a builder may move its own branch
    expect(codexRules({ deniedShellPatterns: [] }, 'builder')).not.toContain('"checkout"');
  });

  it('builds the exact command (pure)', () => {
    const cmd = buildCodexCommand(
      {
        prompt: 'P',
        cwd: '/work/wt',
        model: 'gpt-6-sol',
        effort: 'bogus',
        shellEnv: { PATH: '/p', AOM_SHIFT_TOKEN: 't' },
        profile: profileBase,
        web: true,
        codexHome: '/runner/agents/a/codex',
      },
      { enabled: true, bin: '/usr/bin/codex', authMode: 'login', toolchainPaths: [] },
      { PATH: '/usr/bin', HOME: '/home/owner', GH_TOKEN: 'x' },
    );
    expect(cmd.bin).toBe('/usr/bin/codex');
    expect(cmd.args.slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '--strict-config']);
    expect(cmd.args.at(-1)).toBe('-');
    expect(configs(cmd.args)).toContain('web_search="live"');
    expect(configs(cmd.args).some((x) => x.startsWith('model_reasoning_effort'))).toBe(false); // unknown effort is dropped
    expect(cmd.stdin).toBe('P');
    expect(cmd.env).toEqual({ PATH: '/p', AOM_SHIFT_TOKEN: 't', CODEX_HOME: '/runner/agents/a/codex' });
  });
});

describe('codex stream parser', () => {
  it('reads the events of codex-cli 0.163.0, as recorded from a real run', () => {
    const p = new CodexStreamParser({ model: 'gpt-6-sol' });
    const lines = [
      '{"type":"thread.started","thread_id":"01a166aa-c955-7242-8bbe-de9be3f4f8f3"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 200 OK)"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hello from mock"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":2}}',
    ];
    const ev = lines.flatMap((l) => p.parseLine(l));
    expect(ev.map((e) => e.kind)).toEqual(['session', 'progress', 'usage', 'final']);
    expect(p.resultError).toBeUndefined(); // retries and non-fatal items are not failures
    expect(p.authFailure).toBe(false);
    expect(p.usage()).toEqual({
      inputTokens: 60,
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      model: 'codex:gpt-6-sol',
    });
    expect(p.contextTokens()).toBe(100);
  });

  it('maps file changes, web searches and declined commands; ignores noise', () => {
    const p = new CodexStreamParser();
    const ev = [
      'not json',
      '[]',
      j({
        type: 'item.completed',
        item: {
          id: 'f1',
          type: 'file_change',
          status: 'completed',
          changes: [
            { path: 'a.ts', kind: 'update' },
            { path: 'b.ts', kind: 'add' },
          ],
        },
      }),
      j({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'token=abc12345678 docs' } }),
      j({
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command: 'rm x',
          aggregated_output: '',
          exit_code: null,
          status: 'declined',
        },
      }),
      j({
        type: 'item.completed',
        item: {
          id: 'c2',
          type: 'command_execution',
          command: 'false',
          aggregated_output: 'no',
          exit_code: 1,
          status: 'failed',
        },
      }),
      j({ type: 'item.completed', item: { id: 't', type: 'todo_list', items: [] } }),
    ].flatMap((l) => p.parseLine(l));
    expect(ev).toEqual([
      { kind: 'tool', name: 'Edit', summary: 'a.ts, b.ts', id: 'f1' },
      { kind: 'toolresult', id: 'f1', bytes: 0 },
      { kind: 'tool', name: 'WebSearch', summary: 'token=*** docs', id: 'w1' },
      { kind: 'toolresult', id: 'w1', bytes: 0 },
      { kind: 'tool', name: 'Bash', summary: 'rm x', id: 'c1' },
      { kind: 'toolresult', id: 'c1', bytes: 0, isError: true, refused: true },
      { kind: 'tool', name: 'Bash', summary: 'false', id: 'c2' },
      { kind: 'toolresult', id: 'c2', bytes: 2, isError: true },
    ]);
  });

  it('adds the usage of every turn and recognises login and limit texts', () => {
    const p = new CodexStreamParser({ model: 'm' });
    for (let i = 0; i < 2; i++)
      p.parseLine(
        j({
          type: 'turn.completed',
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
        }),
      );
    expect(p.usage()).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(isCodexAuthFailureText('unexpected status 401 Unauthorized')).toBe(true);
    expect(
      isCodexAuthFailureText(
        'Your access token could not be refreshed because your refresh token was already used',
      ),
    ).toBe(true);
    expect(isCodexAuthFailureText('the model is overloaded')).toBe(false);
    expect(codexUsageLimit('The model is overloaded')).toBeUndefined();
    const now = new Date('2026-10-23T10:00:00Z');
    expect(
      codexUsageLimit("You've hit your usage limit. Try again in 3 hours.", now)?.until.toISOString(),
    ).toBe('2026-10-23T13:00:00.000Z');
    expect(codexUsageLimit("You've hit your usage limit.", now)).toMatchObject({ parsed: false });
  });
});

describe('codex cost', () => {
  it('prices a listed Codex model by tokens, never as a Claude model; an unlisted one is cost unknown', () => {
    for (const m of ['codex:gpt-6-sol', 'gpt-6-sol', 'gpt-6.1-sol', 'codex:gpt-6-astra']) {
      expect(isCostUnknown(m)).toBe(false);
      expect(costUsdMicros(m, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeGreaterThanOrEqual(
        12_000_000,
      );
    }
    expect(isCostUnknown('codex:some-new-model')).toBe(true);
    expect(costUsdMicros('codex:some-new-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      0,
    );
    expect(isCostUnknown('sonnet')).toBe(false);
  });
});

describe('codex registration', () => {
  const cfg = (codex?: object) =>
    RunnerConfigSchema.parse({
      serverUrl: 'http://x',
      workstationId: 'w',
      runnerToken: 't',
      runtimes: { ...(codex ? { codex } : {}) },
    });
  const paths = runnerPaths(tmp('aom-codex-reg-'));

  it('registers `codex` only when the binary exists', () => {
    const fake = fakeCodex();
    // (vitest counts as a blocked environment: only an explicit bin is looked at)
    expect([...buildAdapters(cfg({ bin: fake.bin }), paths).keys()]).toContain('codex');
    expect([...buildAdapters(cfg({ bin: join(fake.dir, 'missing') }), paths).keys()]).not.toContain('codex');
    expect([...buildAdapters(cfg(), paths).keys()]).not.toContain('codex');
    expect([...buildAdapters(cfg({ bin: fake.bin, enabled: false }), paths).keys()]).not.toContain('codex');
    expect([...buildAdapters(makeConfig('http://x'), paths).keys()]).toEqual(['claude-code', 'mock']);
  });

  it('finds the binary on PATH outside tests, and on no platform without the sandbox', () => {
    const fake = fakeCodex();
    expect(detectCodex(undefined, { pathVar: `/nowhere:${fake.dir}`, platform: 'linux' })).toBe(fake.bin);
    expect(detectCodex(undefined, { pathVar: `/nowhere:${fake.dir}`, platform: 'darwin' })).toBe(fake.bin);
    expect(detectCodex(undefined, { pathVar: '/nowhere', platform: 'linux' })).toBeUndefined();
    expect(detectCodex(undefined, { pathVar: fake.dir, platform: 'win32' })).toBeUndefined();
    expect(
      detectCodex({ enabled: false } as never, { pathVar: fake.dir, platform: 'linux' }),
    ).toBeUndefined();
    expect(detectCodex(undefined, { pathVar: fake.dir, platform: 'linux', blocked: true })).toBeUndefined();
    expect(detectCodex({ enabled: true, bin: fake.bin } as never, { platform: 'linux', blocked: true })).toBe(
      fake.bin,
    );
  });

  it('is listed in the runner report like the other runtimes', async () => {
    const fake = fakeCodex();
    const adapters = buildAdapters(cfg({ bin: fake.bin }), paths);
    const caps = await adapters.get('codex')?.capabilities();
    expect(caps?.runtime).toBe('codex');
    expect(caps?.version).toBe('0.163.0');
    expect(readdirSync(fake.dir)).toContain('codex');
  });
});

// ------------------------------------------------------------------------------------------------- the harness sandbox (R3c)

describe('codex in the runner harness sandbox: the command', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    prompt: 'Work card ABC-1',
    cwd: '/work/wt',
    model: 'gpt-6-sol',
    shellEnv: {
      PATH: '/runner/bin:/usr/bin',
      HOME: '/agent/home',
      AOM_SHIFT_TOKEN: 't',
      HTTPS_PROXY: 'http://127.0.0.1:3128',
    },
    web: false,
    codexHome: '/agent/codex',
    auth: 'login' as const,
    bridgePort: 3128,
    ...over,
  });
  const cfg = { bin: '/usr/bin/codex' };
  const configs = (args: string[]): string[] => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));

  it('switches Codex’s own sandbox off, with no permission profile: the runner’s bubblewrap is the boundary', () => {
    const cmd = buildCodexHarnessCommand(input(), cfg, { PATH: '/usr/bin' });
    const c = configs(cmd.args);
    expect(c).toContain('sandbox_mode="danger-full-access"');
    expect(c).toContain('approval_policy="never"');
    expect(c.some((x) => x.startsWith('permissions.aom') || x.startsWith('default_permissions'))).toBe(false);
    expect(cmd.args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(cmd.args).toContain('--strict-config');
    // the prompt is on stdin, never in argv
    expect(cmd.args.at(-1)).toBe('-');
    expect(cmd.args.join(' ')).not.toContain('Work card');
    expect(cmd.stdin).toBe('Work card ABC-1');
    expect(cmd.env.CODEX_HOME).toBe('/agent/codex');
    // the shell gets the session's variables (the proxy's among them), not the codex process's
    const shell = c.find((x) => x.startsWith('shell_environment_policy')) ?? '';
    expect(shell).toContain('"inherit" = "none"');
    expect(shell).toContain('HTTPS_PROXY');
    expect(shell).not.toContain('CODEX_');
  });

  it('login mode keeps the owner’s own login method and has no key; key mode points Codex at the proxy with a dummy key', () => {
    const login = buildCodexHarnessCommand(input(), cfg, { PATH: '/usr/bin' });
    expect(configs(login.args).some((x) => x.startsWith('forced_login_method'))).toBe(false);
    expect(configs(login.args).some((x) => x.startsWith('openai_base_url'))).toBe(false);
    expect(login.env.CODEX_API_KEY).toBeUndefined();
    const key = buildCodexHarnessCommand(input({ auth: 'key' }), cfg, { PATH: '/usr/bin' });
    expect(configs(key.args)).toContain('forced_login_method="api"');
    expect(configs(key.args)).toContain('openai_base_url="http://127.0.0.1:3128/openai/v1"');
    expect(key.env.CODEX_API_KEY).toBe('aom-key-is-added-by-the-runner');
    expect(JSON.stringify(key)).not.toMatch(/sk-/);
  });

  it('resumes only a thread id (a UUID), passes web search and a known effort, and drops an unknown one', () => {
    const id = '0190bbbb-1111-7222-8333-444455556666';
    const resumed = buildCodexHarnessCommand(input({ resumeSessionId: id, web: true, effort: 'high' }), cfg);
    expect(resumed.args.slice(-4)).toEqual(['resume', '--', id, '-']);
    expect(configs(resumed.args)).toContain('web_search="live"');
    expect(configs(resumed.args)).toContain('model_reasoning_effort="high"');
    const bad = buildCodexHarnessCommand(input({ resumeSessionId: '--oops', effort: 'bogus' }), cfg);
    expect(bad.args.slice(-2)).toEqual(['--', '-']);
    expect(configs(bad.args).some((x) => x.startsWith('model_reasoning_effort'))).toBe(false);
  });

  it('writes the execpolicy rules without the "run aom outside the sandbox" exception, keeping the denied prefixes', () => {
    const native = codexRules(PERMS, 'builder');
    expect(native).toContain('prefix_rule(pattern=["aom"], decision="allow")');
    const harness = codexRules(PERMS, 'builder', true);
    expect(harness).not.toContain('decision="allow"');
    expect(harness).toContain('pattern=["git","push"], decision="forbidden"');
  });
});

describe('codex in the runner harness sandbox: the adapter', () => {
  /** Starts the fake binary directly (no bubblewrap in a unit test) and records what the adapter asked of the sandbox. */
  function harnessRig(
    opts: { authMode?: 'login' | 'api_key'; apiKey?: string; noLogin?: boolean; probeOk?: boolean } = {},
  ) {
    const launches: HarnessLaunch[] = [];
    const r = rig({
      sandbox: 'harness',
      ...(opts.authMode ? { authMode: opts.authMode } : {}),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.noLogin ? { noLogin: true } : {}),
      host: {
        harnessProbe: () =>
          opts.probeOk === false
            ? { ok: false, reason: 'bwrap not installed: apt install bubblewrap socat' }
            : { ok: true, reason: 'runner-managed bubblewrap with an egress proxy' },
        launch: async (l) => {
          launches.push(l);
          return {
            command: { bin: l.cmd.bin, args: l.cmd.args, env: l.cmd.env },
            proxy: { close: async () => undefined, denied: () => [], asked: () => [] },
            cleanup: async () => undefined,
          };
        },
      },
    });
    return { ...r, launches };
  }

  it('is the default on Linux and Codex’s own profile elsewhere, and can be forced', async () => {
    const mk = (platform: NodeJS.Platform, sandbox?: 'native' | 'harness' | 'auto') =>
      new CodexAdapter(
        {
          enabled: true,
          bin: '/x/codex',
          authMode: 'login',
          toolchainPaths: [],
          ...(sandbox ? { sandbox } : {}),
        },
        undefined,
        { platform },
      ).sandboxKind();
    expect(mk('linux')).toBe('harness');
    expect(mk('darwin')).toBe('native');
    expect(mk('linux', 'native')).toBe('native');
    expect(mk('darwin', 'harness')).toBe('harness');
  });

  it('runs a shift in the harness: domain allow-list of the login, writable Codex home, hidden login, replaced shell, aom socket', async () => {
    const r = harnessRig();
    const events = await drain(await r.adapter.start(shiftInput(r)));
    expect(events.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    const l = r.launches[0] as HarnessLaunch;
    expect(l.cliHosts).toEqual(expect.arrayContaining(['chatgpt.com', 'auth.openai.com', 'api.openai.com']));
    expect(l.routes).toBeUndefined();
    expect(l.sandbox.writable).toEqual([codexHomeOf(r.sandbox)]);
    expect(l.sandbox.readOnlyCwd).toBe(false);
    expect(l.sandbox.mayCommit).toBe(true);
    expect(l.hiddenFromShell).toEqual([join(codexHomeOf(r.sandbox), 'auth.json')]);
    expect(l.unsetForShell).toEqual(expect.arrayContaining(['CODEX_API_KEY', 'CODEX_HOME']));
    expect(l.replaceShell).toBe(true);
    // the install of the binary is readable in the box; the runner's token and the owner's home are not offered
    expect(l.sandbox.readonly.some((p) => p === r.fake.dir)).toBe(true);
    expect(JSON.stringify(l.sandbox)).not.toContain('runner-secret');
    // the codex process still gets its login copy, the agent’s skills and rules (no aom exception)
    const call = r.fake.calls()[0] as Recorded;
    expect(call.authJson).toContain('user-token');
    expect(call.skills).toEqual([]);
    expect(call.rules).not.toContain('decision="allow"');
    expect(call.rules).toContain('forbidden');
    expect(call.argv).toContain('sandbox_mode="danger-full-access"');
  });

  it('api key mode: the key lives in the proxy route, never in the process environment, argv, or the box', async () => {
    const r = harnessRig({ authMode: 'api_key', apiKey: 'sk-config-key-9999' });
    const events = await drain(await r.adapter.start(shiftInput(r)));
    expect(events.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    const l = r.launches[0] as HarnessLaunch;
    expect(l.cliHosts).toEqual(['api.openai.com']);
    expect(l.routes).toEqual([
      {
        prefix: '/openai',
        upstream: 'https://api.openai.com',
        headers: { authorization: 'Bearer sk-config-key-9999' },
      },
    ]);
    expect(l.hiddenFromShell).toEqual([]);
    const seen = JSON.stringify({ args: l.cmd.args, env: l.cmd.env, sandbox: l.sandbox });
    expect(seen).not.toContain('sk-config-key-9999');
    const call = r.fake.calls()[0] as Recorded;
    expect(call.env.CODEX_API_KEY).toBe('aom-key-is-added-by-the-runner');
    expect(call.authJson).toBeNull();
    // the usage is attributed to the key (the organization cap counts it)
    const usage = events.find((e) => e.kind === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage).toMatchObject({
      keySource: 'workstation',
      keyProvider: 'openai',
      model: 'codex:gpt-6-sol',
    });
  });

  it('chats run with a read-only working folder and cannot commit', async () => {
    const r = harnessRig();
    const events = await drain(await r.adapter.startChat(chatInput(r)));
    expect(events.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    const l = r.launches[0] as HarnessLaunch;
    expect(l.sandbox.readOnlyCwd).toBe(true);
    expect(l.sandbox.mayCommit).toBe(false);
  });

  it('reports the harness sandbox in the capabilities, and refuses every session when it does not start', async () => {
    const down = harnessRig({ probeOk: false });
    const caps = await down.adapter.capabilities();
    expect(caps).toMatchObject({ available: false, sandbox: 'unavailable', capabilities: [] });
    expect(caps.sandboxReason).toContain('bwrap not installed');
    await expect(down.adapter.start(shiftInput(down))).rejects.toThrow(/Codex sandbox is unavailable/);
    expect(down.fake.calls()).toHaveLength(0);
    const up = harnessRig();
    expect(await up.adapter.capabilities()).toMatchObject({
      available: true,
      sandbox: 'enforced',
      sandboxReason: 'runner-managed bubblewrap with an egress proxy',
    });
  });

  it('refuses with the reason when nobody is signed in and there is no key', async () => {
    const r = harnessRig({ noLogin: true });
    await expect(r.adapter.start(shiftInput(r))).rejects.toThrow(/not signed in/);
    const k = harnessRig({ authMode: 'api_key' });
    await expect(k.adapter.start(shiftInput(k))).rejects.toThrow(/no API key/);
  });

  it('keeps the same role refusals (shell-less roles, browser, path-scoped writers, DevOps, CEO)', async () => {
    const r = harnessRig();
    for (const [roleKey, permissions] of [
      ['analyst', { allowedTools: ['read'] }],
      ['tester', { browser: true }],
      ['writer', { writableGlobs: ['docs/**'] }],
    ] as const)
      await expect(
        r.adapter.start(shiftInput(r, { roleKey, permissions: { ...PERMS, ...permissions } })),
      ).rejects.toThrow(/codex_role_refused/);
    await expect(r.adapter.start(shiftInput(r, { roleKey: 'ceo' }))).rejects.toThrow(/codex_role_refused/);
    expect(r.launches).toHaveLength(0);
  });
});
