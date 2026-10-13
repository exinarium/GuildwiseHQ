import { homedir } from 'node:os';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildClaudeCommand, sessionEnv } from '../src/adapters/claude-code.ts';
import {
  buildShiftSettings,
  SESSION_TOOLS_DENIED,
  toolchainReadPaths,
} from '../src/adapters/claude-policy.ts';
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

  it('builder: edits only inside its worktree; may rebase/checkout/switch there (G-Q12); denies push and reset --hard', () => {
    const s = buildShiftSettings(builder.permissions, policyCtx(), POLICY_PATHS, 'builder');
    expect(s.permissions.allow).toEqual(['Read', 'Glob', 'Grep', `Edit(${CWD}/**)`, 'Bash']);
    for (const d of ['Bash(git rebase:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)'])
      expect(s.permissions.deny).not.toContain(d);
    for (const d of [
      'Bash(git push:*)',
      'Bash(git reset --hard:*)',
      'Bash(git stash drop:*)',
      'Bash(git stash pop:*)',
      'Bash(git stash clear:*)',
      'Bash(sudo:*)',
      'Bash(rm -rf /*)',
      'WebFetch',
    ]) {
      expect(s.permissions.deny).toContain(d);
    }
    expect(s.permissions.deny).not.toContain('Edit');
  });

  // card P4-7: a builder's `cd x && python3 - <<'E' ... E` + `VAR=1 cmd` call was denied "in don't ask mode". Not a
  // policy gap: Claude Code 2.1.296 forces an ask for some `cd <other dir>` compounds whatever the rules say (verified
  // with allow `Bash`, `Bash(*)`, a PreToolUse hook and without the sandbox), and dontAsk turns every ask into a
  // denial. Shell roles must keep the bare `Bash` allow (a pattern list would deny far more); the shared
  // instructions tell agents to retry with plain one-command calls (see packages/shared/src/prompt/instructions.ts).
  it('every role with a shell gets the bare Bash allow and no Bash pattern allow list', () => {
    for (const [key, p] of [
      ['builder', builder.permissions],
      ['reviewer', reviewer.permissions],
      ['tester', tester.permissions],
    ] as const) {
      const allow = buildShiftSettings(p, policyCtx(), POLICY_PATHS, key).permissions.allow;
      expect(allow, key).toContain('Bash');
      expect(
        allow.filter((a) => a.startsWith('Bash(')),
        key,
      ).toEqual([]);
    }
  });

  it('roles that may not commit keep the git rebase/checkout/switch deny (G-Q12)', () => {
    const s = settings(reviewer.permissions);
    for (const d of ['Bash(git rebase:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)'])
      expect(s.permissions.deny).toContain(d);
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
      expect.arrayContaining(['/data/worktrees/TOY-0192abcd/TOY-1', '/data/vaults/v1', '/data/bin']),
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
    expect(fs?.denyWrite).toEqual(
      expect.arrayContaining(['/home/me/toy/.git/hooks', '/home/me/toy/.git/config']),
    );
    expect(fs?.allowRead).toContain('/data/worktrees/TOY-0192abcd/TOY-1');
  });

  it('aom runs outside the sandbox (Linux cannot connect Unix sockets from inside it)', () => {
    // Bash(...) rule syntax: a bare word matches only the command with no arguments, so `aom *` is required for
    // `aom handoff ...`; agents also call the shim by its absolute path. Found by a real Claude Code smoke run.
    const ex = settings(builder.permissions).sandbox?.excludedCommands ?? [];
    expect(ex).toContain('aom');
    expect(ex).toContain('aom *');
    expect(ex.some((e) => e.endsWith('/bin/aom *'))).toBe(true);
    expect(ex.every((e) => /(^|\/)aom( \*)?$/.test(e))).toBe(true); // nothing but aom leaves the sandbox
  });

  it('tools that reach outside the shift (other sessions, triggers, schedules) are denied by name', () => {
    // dontAsk still runs tools that need no approval; a real smoke run showed an agent calling ListAgents.
    for (const role of [builder, reviewer]) {
      const deny = settings(role.permissions).permissions.deny;
      for (const t of SESSION_TOOLS_DENIED) expect(deny).toContain(t);
    }
  });

  it('toolchains: the Node install is readable under the read block, home and credential dirs never are', () => {
    const home = '/home/u';
    const paths = toolchainReadPaths(
      ['~/.dotnet', '~', '/home', '/', '~/.ssh', '~/.ssh/keys', '~/.config', '/opt/go'],
      '/home/u/.nvm/versions/node/v22.0.0/bin/node',
      home,
    );
    expect(paths).toEqual(['/home/u/.nvm/versions/node/v22.0.0', '/home/u/.dotnet', '/opt/go']);
    const s = settings(builder.permissions, { toolchainReadPaths: paths });
    expect(s.sandbox?.filesystem.allowRead).toEqual(expect.arrayContaining(paths));
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
    WSL_INTEROP: '/run/WSL/1_interop',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    GPG_AGENT_INFO: '/tmp/gpg',
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
      'WSL_INTEROP',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR',
      'DOCKER_HOST',
      'GPG_AGENT_INFO',
      'AWS_SECRET_ACCESS_KEY',
      'ANTHROPIC_API_KEY',
      'NPM_TOKEN',
    ])
      expect(env[k], k).toBeUndefined();
  });
  it('gives the session a private, writable temp dir instead of the shared /tmp', () => {
    const env = sessionEnv(input(), ClaudeRuntimeConfigSchema.parse({}), {
      PATH: '/usr/bin',
      TMPDIR: '/tmp',
    });
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

describe('browser roles and read-only worktrees in the sandbox', () => {
  const ctx = { uid: 1000, tmpEntries: ['ssh-AbC123', 'keyring-x', 'other', '.X11-unix'] };
  const forRole = (key: string, p: typeof builder.permissions, over = {}) =>
    buildShiftSettings(p, policyCtx({ ...ctx, ...over }), POLICY_PATHS, key).sandbox;

  it('tester: Unix sockets open, and the dangerous sockets and credential dirs are masked', () => {
    const sb = forRole('tester', tester.permissions);
    expect(sb?.network.allowAllUnixSockets).toBe(true);
    expect(sb?.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        '/data', // existing denies are kept
        '/home/me/.ssh',
        '/var/run/docker.sock',
        '/run/docker.sock',
        '/run/WSL',
        '/run/user/1000',
        '/tmp/ssh-AbC123',
        '/tmp/keyring-x',
      ]),
    );
    expect(sb?.filesystem.denyRead).not.toContain('/tmp/other');
    expect(sb?.filesystem.denyRead).not.toContain('/tmp');
  });

  it('a hired tester without the flag (older agent) still gets browser access', () => {
    expect(forRole('tester', { ...tester.permissions, browser: false })?.network.allowAllUnixSockets).toBe(
      true,
    );
  });

  it('a custom role opts in with permissions.browser', () => {
    expect(forRole('qa-lead', { ...builder.permissions, browser: true })?.network.allowAllUnixSockets).toBe(
      true,
    );
    expect(forRole('qa-lead', { ...builder.permissions })?.network.allowAllUnixSockets).toBeUndefined();
  });

  it('builder and reviewer: no open Unix sockets and no browser mask', () => {
    for (const [k, r] of [
      ['builder', builder],
      ['reviewer', reviewer],
    ] as const) {
      const sb = forRole(k, r.permissions);
      expect(sb?.network.allowAllUnixSockets, k).toBeUndefined();
      expect(sb?.filesystem.denyRead, k).not.toContain('/var/run/docker.sock');
      expect(sb?.filesystem.denyRead, k).not.toContain('/run/user/1000');
    }
    expect(forRole('builder', builder.permissions)?.network.allowUnixSockets).toEqual([]);
  });

  it('the built-in roles: only the tester declares browser', () => {
    expect(BUILTIN_ROLES.filter((r) => r.permissions.browser).map((r) => r.key)).toEqual(['tester']);
  });

  it('reviewer (no edit, may not commit): the worktree is read-only to its shell; scratch and tmp stay writable', () => {
    const fs = forRole('reviewer', reviewer.permissions)?.filesystem;
    expect(fs?.denyWrite).toContain('/data/worktrees/TOY-0192abcd/TOY-1');
    expect(fs?.allowWrite).toEqual(
      expect.arrayContaining(['/data/agents/a1/scratch', '/data/agents/a1/tmp', '/data/agents/a1/home']),
    );
    const s = buildShiftSettings(reviewer.permissions, policyCtx(), POLICY_PATHS, 'reviewer');
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
  });

  it('BA and any custom role without edit and commit are read-only too; builder and tester are not', () => {
    const ba = BUILTIN_ROLES.find((r) => r.key === 'ba');
    if (!ba) throw new Error('ba');
    const wt = '/data/worktrees/TOY-0192abcd/TOY-1';
    expect(forRole('ba', ba.permissions)?.filesystem.denyWrite).toContain(wt);
    expect(forRole('x', { ...reviewer.permissions, mayCommit: false })?.filesystem.denyWrite).toContain(wt);
    expect(forRole('builder', builder.permissions)?.filesystem.denyWrite).not.toContain(wt);
    expect(forRole('tester', tester.permissions)?.filesystem.denyWrite).not.toContain(wt);
    // a role that can edit without committing (researcher) keeps its edits
    expect(
      forRole('r', { ...reviewer.permissions, allowedTools: ['read', 'edit'] })?.filesystem.denyWrite,
    ).not.toContain(wt);
  });

  it('a read-only role working in its own scratch dir has nothing to lock', () => {
    const fs = forRole('reviewer', reviewer.permissions, { cwd: '/data/agents/a1/scratch' })?.filesystem;
    expect(fs?.denyWrite).not.toContain('/data/agents/a1/scratch');
  });

  it("other agents' private temp dirs are denied to sandboxed commands", () => {
    const s2 = settings(builder.permissions, {
      otherAgentTmps: ['/tmp/aom-aaaaaaaaaa', '/tmp/aom-bbbbbbbbbb'],
    });
    expect(s2.sandbox?.filesystem.denyRead).toEqual(
      expect.arrayContaining(['/tmp/aom-aaaaaaaaaa', '/tmp/aom-bbbbbbbbbb']),
    );
  });
});

describe('the DevOps engineer runs unsandboxed (owner decision)', () => {
  const devopsRole = BUILTIN_ROLES.find((r) => r.key === 'devops');
  if (!devopsRole) throw new Error('devops role');
  const dev = () => buildShiftSettings(devopsRole.permissions, policyCtx(), POLICY_PATHS, 'devops', true);

  it('has no sandbox block and broad permissions', () => {
    const s = dev();
    expect(s.sandbox).toBeUndefined();
    expect(s.permissions.defaultMode).toBe('dontAsk');
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined();
    expect(s.permissions.allow).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'WebFetch', 'WebSearch']),
    );
    expect(s.permissions.allow.some((a) => a.startsWith('Edit('))).toBe(false);
  });

  it('may read ~/.ssh, ~/.docker and ~/.kube, but not the runner state or the Claude login', () => {
    const deny = dev().permissions.deny;
    for (const d of ['.ssh', '.docker', '.kube', '.aws', '.config/gh'])
      expect(deny.some((r) => r.includes(`/home/me/${d}`))).toBe(false);
    expect(deny).toEqual(
      expect.arrayContaining([
        'Read(//data/config.json)',
        'Edit(//data/config.json)',
        'Read(//data/outbox/**)',
        'Read(//data/active-shifts/**)',
        'Edit(//data/agents/a1/claude/**)',
        'Read(//home/me/.claude/**)',
        'ListAgents',
      ]),
    );
    expect(deny).not.toContain('Bash(git push:*)');
    expect(deny).not.toContain('Bash');
    expect(deny).not.toContain('Edit');
  });

  it('is decided by the isDevops flag only: other roles keep the sandbox and the worktree-only rules', () => {
    for (const [key, role] of [
      ['builder', builder],
      ['reviewer', reviewer],
      ['tester', tester],
    ] as const) {
      const s = buildShiftSettings(role.permissions, policyCtx(), POLICY_PATHS, key, false);
      expect(s.sandbox?.enabled).toBe(true);
      expect(s.sandbox?.failIfUnavailable).toBe(true);
      expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
      expect(s.permissions.deny).toContain('Read(//home/me/.ssh/**)');
    }
    // the role key alone does not unsandbox
    expect(
      buildShiftSettings(devopsRole.permissions, policyCtx(), POLICY_PATHS, 'devops').sandbox,
    ).toBeDefined();
  });

  it('shift env: real HOME, agent CLAUDE_CONFIG_DIR, no env scrub; chats and other roles keep the private home', () => {
    const cfg = ClaudeRuntimeConfigSchema.parse({ scrubSubprocessEnv: true });
    const parent = { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1', DOCKER_HOST: 'unix:///x' };
    const env = { ...sandboxEnv(input().sandbox as Sandbox), AOM_SHIFT_ID: 's1' };
    const d = sessionEnv({ env, sandbox: input().sandbox, agent: { isDevops: true } }, cfg, parent);
    expect(d.HOME).toBe(homedir());
    expect(d.CLAUDE_CONFIG_DIR).toBe('/data/agents/a1/claude');
    expect(d.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(d.SSH_AUTH_SOCK).toBe('/tmp/ssh-x/agent.1');
    expect(d.DOCKER_HOST).toBe('unix:///x');
    const o = sessionEnv({ env, sandbox: input().sandbox, agent: { isDevops: false } }, cfg, parent);
    expect(o.HOME).toBe('/data/agents/a1/home');
    expect(o.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    expect(o.SSH_AUTH_SOCK).toBeUndefined();
  });
});
