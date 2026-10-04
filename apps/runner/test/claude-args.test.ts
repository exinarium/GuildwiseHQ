import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildClaudeCommand, sessionEnv } from '../src/adapters/claude-code.ts';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import type { ShiftStartInput } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { type Sandbox, sandboxEnv } from '../src/sandbox/sandbox.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
const tester = BUILTIN_ROLES.find((r) => r.key === 'tester');
if (!builder || !reviewer || !tester) throw new Error('roles');

const input = (over: Partial<ShiftStartInput> = {}): ShiftStartInput => ({
  shiftId: 's1',
  prompt: '# TOY-1: Add greeting',
  instructionsMarkdown: '# Who you are',
  cwd: '/data/worktrees/TOY/TOY-1',
  sandbox: {
    home: '/data/agents/a1/home',
    configDir: '/data/agents/a1/claude',
    scratch: '/data/agents/a1/scratch',
    tmp: '/data/agents/a1/tmp',
  },
  agent: {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'builder',
    seniority: 'junior',
    runtime: 'claude-code',
    model: 'sonnet',
    effort: 'medium',
    skills: [],
    permissions: builder.permissions,
    isDevops: false,
  },
  env: {
    AOM_IPC_URL: 'http://127.0.0.1:5555',
    AOM_SHIFT_TOKEN: 'tok',
    AOM_SHIFT_ID: 's1',
    PATH: '/data/bin:/usr/bin',
  },
  addDirs: [],
  maxShiftMinutes: 30,
  ...over,
});

describe('claude command builder (ARCHITECTURE section 12.2)', () => {
  it('builds the exact argv', () => {
    const cmd = buildClaudeCommand(
      input({ addDirs: ['/vaults/work/proj', '/vaults/work/shared'] }),
      ClaudeRuntimeConfigSchema.parse({}),
    );
    expect(cmd.bin).toBe('claude');
    expect(cmd.args).toEqual([
      '-p',
      '# TOY-1: Add greeting',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
      '--effort',
      'medium',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      '/data/agents/a1/claude/mcp.json',
      '--add-dir',
      '/vaults/work/proj',
      '--add-dir',
      '/vaults/work/shared',
    ]);
  });

  it('omits --effort when unset and adds --resume for chat', () => {
    const base = input();
    const cmd = buildClaudeCommand(
      input({ agent: { ...base.agent, effort: undefined }, resumeSessionId: 'sess-1' }),
      ClaudeRuntimeConfigSchema.parse({}),
    );
    expect(cmd.args).not.toContain('--effort');
    expect(cmd.args.slice(-2)).toEqual(['--resume', 'sess-1']);
  });

  it('sets the sandbox env, passes the aom env through and adds OAuth auth', () => {
    const cmd = buildClaudeCommand(
      input(),
      ClaudeRuntimeConfigSchema.parse({ authMode: 'oauth', oauthToken: 'sk-ant-oat-x', bin: '/opt/claude' }),
    );
    expect(cmd.bin).toBe('/opt/claude');
    expect(cmd.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/data/agents/a1/claude',
      HOME: '/data/agents/a1/home',
      USERPROFILE: '/data/agents/a1/home',
      PATH: '/data/bin:/usr/bin',
      AOM_IPC_URL: 'http://127.0.0.1:5555',
      AOM_SHIFT_TOKEN: 'tok',
      AOM_SHIFT_ID: 's1',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
    });
    expect(cmd.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('uses ANTHROPIC_API_KEY in api_key mode and no credentials in default mode', () => {
    const api = buildClaudeCommand(
      input(),
      ClaudeRuntimeConfigSchema.parse({ authMode: 'api_key', apiKey: 'sk-ant-api' }),
    );
    expect(api.env.ANTHROPIC_API_KEY).toBe('sk-ant-api');
    const def = buildClaudeCommand(input(), ClaudeRuntimeConfigSchema.parse({}));
    expect(def.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(def.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

const settings = (p: typeof builder.permissions, over = {}) =>
  buildShiftSettings(p, policyCtx(over), POLICY_PATHS);
const CWD = '//data/worktrees/TOY-0192abcd/TOY-1';

describe('claude settings.json: permissions per role (review M3)', () => {
  it('dontAsk, never acceptEdits: only what a rule allows runs', () => {
    const s = settings(builder.permissions);
    expect(s.permissions.defaultMode).toBe('dontAsk');
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.includeCoAuthoredBy).toBe(false);
  });

  it('builder: edits only inside its worktree; denies git push/rebase/checkout/switch/reset --hard', () => {
    const s = settings(builder.permissions);
    expect(s.permissions.allow).toEqual(['Read', 'Glob', 'Grep', `Edit(${CWD}/**)`, 'Bash']);
    for (const d of [
      'Bash(git push:*)',
      'Bash(git rebase:*)',
      'Bash(git checkout:*)',
      'Bash(git switch:*)',
      'Bash(git reset --hard:*)',
      'Bash(sudo:*)',
      'Bash(rm -rf /*)',
      'WebFetch',
    ]) {
      expect(s.permissions.deny).toContain(d);
    }
    expect(s.permissions.deny).not.toContain('Edit');
  });

  it('restricts Edit to the writable globs inside the worktree (tester, writer, custom roles)', () => {
    const s = settings(tester.permissions);
    expect(s.permissions.allow).toContain(`Edit(${CWD}/e2e/**)`);
    expect(s.permissions.allow).not.toContain('Edit');
    const custom = settings({ ...builder.permissions, writableGlobs: ['notes/**', '*.md'] });
    expect(custom.permissions.allow).toEqual(
      expect.arrayContaining([`Edit(${CWD}/notes/**)`, `Edit(${CWD}/*.md)`]),
    );
    expect(custom.permissions.allow.some((a) => a === `Edit(${CWD}/**)`)).toBe(false);
  });

  it('roles without the edit tool deny Edit, Write and NotebookEdit outright', () => {
    const s = settings({ ...reviewer.permissions, allowedTools: ['read', 'shell', 'web'] });
    expect(s.permissions.allow).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch']);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
    expect(s.permissions.deny).not.toContain('WebFetch');
  });

  it('nobody edits the vault, the agent config dir or the worktree .git; runner state is unreadable', () => {
    const s = settings(builder.permissions, { addDirs: ['/data/vaults/v1'] });
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        'Edit(//data/vaults/v1/**)',
        'Edit(//data/agents/a1/claude/**)',
        `Edit(${CWD}/.git/**)`,
        'Read(//data/config.json)',
        'Read(//data/outbox/**)',
        'Read(//data/active-shifts/**)',
        'Read(//home/me/.ssh/**)',
        'Read(//home/me/.claude/**)',
      ]),
    );
  });
});

describe('claude settings.json: OS sandbox per role (review H2)', () => {
  it('turns the sandbox on, strict: no unsandboxed retry, fail rather than run unsandboxed', () => {
    const sb = settings(builder.permissions).sandbox;
    expect(sb).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
    });
    expect(settings(builder.permissions, { mode: 'best_effort' }).sandbox?.failIfUnavailable).toBe(false);
    expect(settings(builder.permissions, { mode: 'off' }).sandbox).toBeUndefined();
  });

  it("denies reads of the runner data dir and credential stores, re-opening only the agent's own areas", () => {
    const fs = settings(builder.permissions, { addDirs: ['/data/vaults/v1'] }).sandbox?.filesystem;
    expect(fs?.denyRead).toEqual(
      expect.arrayContaining([
        '/data',
        '/home/me/.ssh',
        '/home/me/.aws',
        '/home/me/.claude',
        '/home/me/.config/gh',
      ]),
    );
    expect(fs?.allowRead).toEqual(
      expect.arrayContaining([
        '/data/worktrees/TOY-0192abcd/TOY-1',
        '/data/vaults/v1',
        '/data/bin',
      ]),
    );
    // another agent's sandbox or another card's worktree is not among them
    expect(fs?.allowRead.some((p) => p.includes('agents/a2'))).toBe(false);
  });

  it('writes: own home and scratch plus the repo git dir, never its hooks/config or the vault', () => {
    const fs = settings(builder.permissions, { addDirs: ['/data/vaults/v1'] }).sandbox?.filesystem;
    expect(fs?.allowWrite).toEqual([
      '/data/agents/a1/home',
      '/data/agents/a1/scratch',
      '/data/agents/a1/tmp',
      '/home/me/toy/.git',
    ]);
    expect(fs?.denyWrite).toEqual(
      expect.arrayContaining([
        '/home/me/toy/.git/hooks',
        '/home/me/toy/.git/config',
        '/data/vaults/v1',
        '/data/config.json',
      ]),
    );
  });

  it('no allowed read is a directory that holds a writable path (bubblewrap would make that path read-only)', () => {
    for (const ctx of [{}, { addDirs: ['/data/vaults/v1'] }, { gitDirs: [] }]) {
      const fs = settings(builder.permissions, ctx).sandbox?.filesystem;
      for (const r of fs?.allowRead ?? [])
        for (const w of fs?.allowWrite ?? [])
          expect(w === r || !w.startsWith(`${r}/`), `${r} holds writable ${w}`).toBe(true);
    }
    // the agent's own writable areas are readable because they are writable; its Claude config dir is not exposed
    const fs = settings(builder.permissions).sandbox?.filesystem;
    expect(fs?.allowRead).not.toContain('/data/agents/a1');
    expect(fs?.allowRead).not.toContain('/data/agents/a1/claude');
  });

  it('the worktree and the main repo git dir (which holds .git/worktrees/<name>) are writable; hooks and config are not', () => {
    const fs = settings(builder.permissions).sandbox?.filesystem;
    // the worktree itself is the session cwd, which Claude Code always makes writable; its admin dir is under the git dir
    expect(fs?.allowWrite).toContain('/home/me/toy/.git');
    expect(fs?.denyWrite).toEqual(expect.arrayContaining(['/home/me/toy/.git/hooks', '/home/me/toy/.git/config']));
    expect(fs?.allowRead).toContain('/data/worktrees/TOY-0192abcd/TOY-1');
  });

  it('aom runs outside the sandbox (Linux cannot connect Unix sockets from inside it)', () => {
    expect(settings(builder.permissions).sandbox?.excludedCommands).toEqual(['aom']);
  });

  it('network: shell roles reach package registries only, others nothing; the IPC socket is allowed', () => {
    const b = settings(builder.permissions, {
      ipcSocket: '/tmp/aom-ipc/x.sock',
      extraAllowedDomains: ['npm.corp'],
    });
    expect(b.sandbox?.network).toMatchObject({
      strictAllowlist: true,
      allowUnixSockets: ['/tmp/aom-ipc/x.sock'],
      allowLocalBinding: true,
    });
    expect(b.sandbox?.network.allowedDomains).toEqual(
      expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'npm.corp']),
    );
    const noShell = settings({ ...reviewer.permissions, allowedTools: ['read', 'edit'] });
    expect(noShell.sandbox?.network.allowedDomains).toEqual([]);
    expect(noShell.sandbox?.network.allowLocalBinding).toBe(false);
  });
});

describe('the agent process gets a minimal environment (review H2a)', () => {
  const parent = {
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    GH_TOKEN: 'ghp_secret',
    GITHUB_TOKEN: 'ghp_secret2',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    AWS_SECRET_ACCESS_KEY: 'aws',
    ANTHROPIC_API_KEY: 'sk-parent',
    NPM_TOKEN: 'npm',
    HOME: '/home/me',
  };
  it('drops everything not allow-listed and keeps only the configured provider credential', () => {
    const env = sessionEnv(
      input(),
      ClaudeRuntimeConfigSchema.parse({ authMode: 'oauth', oauthToken: 'sk-ant-oat-x' }),
      parent,
    );
    expect(env.PATH).toBe('/data/bin:/usr/bin'); // the session's PATH (aom shim first) wins
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.HOME).toBe('/data/agents/a1/home');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-x');
    expect(env.AOM_SHIFT_TOKEN).toBe('tok');
    for (const k of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
      'AWS_SECRET_ACCESS_KEY',
      'ANTHROPIC_API_KEY',
      'NPM_TOKEN',
    ])
      expect(env[k], k).toBeUndefined();
  });
  it('gives the session a private, writable temp dir instead of the shared /tmp', () => {
    const env = sessionEnv(input(), ClaudeRuntimeConfigSchema.parse({}), { PATH: '/usr/bin', TMPDIR: '/tmp' });
    expect(env.CLAUDE_CODE_TMPDIR).toBe('/data/agents/a1/tmp');
    expect(sandboxEnv(input().sandbox as Sandbox)).toMatchObject({
      TMPDIR: '/data/agents/a1/tmp',
      TMP: '/data/agents/a1/tmp',
      TEMP: '/data/agents/a1/tmp',
    });
    // the same dir is in the sandbox's write list
    expect(settings(builder.permissions).sandbox?.filesystem.allowWrite).toContain('/data/agents/a1/tmp');
  });
  it("does not forward the runner's ANTHROPIC_API_KEY in default auth mode, and scrubbing is opt-in", () => {
    const def = sessionEnv(input(), ClaudeRuntimeConfigSchema.parse({}), parent);
    expect(def.ANTHROPIC_API_KEY).toBeUndefined();
    expect(def.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    const scrub = sessionEnv(input(), ClaudeRuntimeConfigSchema.parse({ scrubSubprocessEnv: true }), parent);
    expect(scrub.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
  });
});
