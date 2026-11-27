import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDevopsBoxSettings,
  buildShiftSettings,
  type ClaudeSettings,
  withBoxWorkDirs,
} from '../src/adapters/claude-policy.ts';
import { type BoxPlanInput, boundDirsOf, boxSandbox, boxWorkDirs } from '../src/box/launch.ts';
import { MAC_SYSTEM_READ } from '../src/box/macos-profile.ts';
import { harnessBwrapArgs, systemRoBinds } from '../src/sandbox/harness-sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { policyCtx } from './policy-fixtures.ts';

// a clone named `big` stands for one too big to check (over SCAN_TOTAL_LIMIT entries): the box does not open it at all
vi.mock('../src/adapters/read-only-dirs.ts', async (orig) => {
  const real = await orig<typeof import('../src/adapters/read-only-dirs.ts')>();
  return { ...real, scanMasksFor: (d: string) => (d.endsWith('/big') ? null : real.scanMasksFor(d)) };
});

cleanupTmp();

/**
 * devops-box-access: the folders a boxed DevOps session lists as Claude Code working directories come from the same source as
 * the box's binds. The golden part pins the bubblewrap argv of the inner, outer and CEO plans (recorded on development
 * 9745fc0e before the bind list was split out), so the refactor changes no bind.
 */

const SYSTEM_DIRS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];

/** The system part of the argv exactly as development builds it (links recreated, real folders bound read-only). */
function devSystemPart(): string[] {
  const out: string[] = [];
  for (const d of SYSTEM_DIRS) {
    try {
      if (lstatSync(d).isSymbolicLink()) out.push('--symlink', readlinkSync(d), d);
      else {
        statSync(d);
        out.push('--ro-bind', d, d);
      }
    } catch {
      // absent here
    }
  }
  return out;
}

/** The argv without its host-dependent system triples (checked against `devSystemPart`), the temp root as `<R>`. */
function normalized(args: string[], root: string): { args: string[]; system: string[] } {
  const rest: string[] = [];
  const system: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const dest = args[i + 2];
    if ((a === '--symlink' || a === '--ro-bind') && dest && SYSTEM_DIRS.includes(dest)) {
      system.push(a, args[i + 1] as string, dest);
      i += 2;
      continue;
    }
    // the runner's Node folder: where it sorts depends on this machine's path, so it is checked apart (present unless under /usr)
    if (a === '--ro-bind' && args[i + 1] === NODE_DIR && dest === NODE_DIR) {
      i += 2;
      continue;
    }
    rest.push(a);
  }
  return { args: rest.map((a) => a.replaceAll(root, '<R>')), system };
}

const NODE_DIR = dirname(realpathSync(process.execPath));

interface Fixture {
  root: string;
  requestDir: string;
  configDir: string;
  tmp: string;
  aom: string[];
  plumbing: string[];
  claudeBin: string;
  toolchains: string[];
  clones: string[];
  ipcSocket: string;
  outer: { devopsTools: string; cardWorktrees: string; realHome: string };
  desk: string;
}

function fixture(): Fixture {
  const root = realpathSync(tmp('aom-bwd-'));
  const agent = join(root, 'agents', 'a1');
  const requestDir = join(agent, 'devops', 'req-1');
  const configDir = join(agent, 'config', 'outer', 'req-1');
  const t = join(agent, 'tmp', 'req-1');
  const guard = `${configDir}.guard`;
  const docker = join(root, 'dk');
  const protectedInRequest = join(requestDir, 'clone', '.git', 'config');
  const claudeBin = join(root, 'claude', 'lib', 'claude.exe');
  const toolchain = join(root, 'toolchains', 'bun');
  const clone = join(root, 'clones', 'app');
  const plain = join(root, 'clones', 'lib');
  const devopsTools = join(root, 'devops-tools');
  const cardWorktrees = join(root, 'worktrees');
  const realHome = join(root, 'home');
  const desk = join(root, 'desk');
  for (const d of [
    requestDir,
    join(configDir, 'home'),
    t,
    guard,
    docker,
    dirname(protectedInRequest),
    dirname(claudeBin),
    join(root, 'bin'),
    join(root, 'aom'),
    toolchain,
    clone,
    plain,
    join(root, 'ipc'),
    devopsTools,
    join(cardWorktrees, 'card-1'),
    join(realHome, '.ssh'),
    desk,
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(protectedInRequest, '');
  writeFileSync(claudeBin, '');
  writeFileSync(join(clone, '.env'), 'SECRET=1');
  writeFileSync(join(realHome, '.gitconfig'), '');
  return {
    root,
    requestDir,
    configDir,
    tmp: t,
    aom: [join(root, 'bin'), join(root, 'aom')],
    plumbing: [guard, docker, protectedInRequest],
    claudeBin,
    toolchains: [toolchain, join(root, 'toolchains', 'missing')],
    clones: [clone, plain],
    ipcSocket: join(root, 'ipc', 'ipc.sock'),
    outer: { devopsTools, cardWorktrees, realHome },
    desk,
  };
}

/** The argv bubblewrap gets for a plan, as `launchInHarnessSandbox` builds it. */
const argvOf = (sb: ReturnType<typeof boxSandbox>, root: string): string[] =>
  harnessBwrapArgs({
    ...sb,
    proxySocket: join(root, 'eg', 'p.sock'),
    bridgePort: 3128,
    hiddenFromShell: [],
  });

describe('golden: the box argv is unchanged (recorded on development)', () => {
  it('inner, outer and CEO plans', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'eg'));
    const inner = boxSandbox({
      level: 'inner',
      requestDir: f.requestDir,
      configDir: f.configDir,
      tmp: f.tmp,
      aomReadPaths: f.aom,
      plumbingReadPaths: f.plumbing,
      claudeBin: f.claudeBin,
      toolchainReadDirs: f.toolchains,
      cloneDirs: f.clones,
      ipcSocket: f.ipcSocket,
    });
    const outer = boxSandbox({
      level: 'outer',
      requestDir: f.requestDir,
      configDir: f.configDir,
      tmp: f.tmp,
      aomReadPaths: f.aom,
      plumbingReadPaths: f.plumbing,
      claudeBin: f.claudeBin,
      toolchainReadDirs: f.toolchains,
      cloneDirs: f.clones,
      ipcSocket: f.ipcSocket,
      outer: f.outer,
      fdBinds: [{ fdIndex: 3, real: f.desk, writable: true }],
    });
    const ceo = boxSandbox({
      level: 'outer',
      requestDir: f.requestDir,
      configDir: f.configDir,
      tmp: f.tmp,
      aomReadPaths: f.aom,
      claudeBin: f.claudeBin,
      toolchainReadDirs: [],
      cloneDirs: [],
      outer: f.outer,
      fdBinds: [{ fdIndex: 3, real: f.desk, writable: false }],
    });
    for (const sb of [inner, outer, ceo]) {
      const argv = argvOf(sb, f.root);
      expect(normalized(argv, f.root).system).toEqual(devSystemPart());
      expect(argv.join(' ').includes(`--ro-bind ${NODE_DIR} ${NODE_DIR}`)).toBe(
        !NODE_DIR.startsWith('/usr/'),
      );
    }
    expect(normalized(argvOf(inner, f.root), f.root).args).toMatchInlineSnapshot(`
      [
        "--unshare-user",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/run",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/etc",
        "/etc",
        "--tmpfs",
        "/etc/ssh",
        "--ro-bind",
        "<R>/dk",
        "<R>/dk",
        "--ro-bind",
        "<R>/eg",
        "<R>/eg",
        "--ro-bind",
        "<R>/bin",
        "<R>/bin",
        "--ro-bind",
        "<R>/aom",
        "<R>/aom",
        "--ro-bind",
        "<R>/ipc",
        "<R>/ipc",
        "--ro-bind",
        "<R>/claude/lib",
        "<R>/claude/lib",
        "--ro-bind",
        "<R>/clones/app",
        "<R>/clones/app",
        "--ro-bind",
        "<R>/clones/lib",
        "<R>/clones/lib",
        "--ro-bind",
        "<R>/toolchains/bun",
        "<R>/toolchains/bun",
        "--ro-bind",
        "/dev/null",
        "<R>/clones/app/.env",
        "--bind",
        "<R>/agents/a1/tmp/req-1",
        "<R>/agents/a1/tmp/req-1",
        "--bind",
        "<R>/agents/a1/devops/req-1",
        "<R>/agents/a1/devops/req-1",
        "--bind",
        "<R>/agents/a1/config/outer/req-1",
        "<R>/agents/a1/config/outer/req-1",
        "--bind",
        "<R>/agents/a1/config/outer/req-1/home",
        "<R>/agents/a1/config/outer/req-1/home",
        "--ro-bind",
        "<R>/agents/a1/config/outer/req-1.guard",
        "<R>/agents/a1/config/outer/req-1.guard",
        "--ro-bind",
        "<R>/agents/a1/devops/req-1/clone/.git/config",
        "<R>/agents/a1/devops/req-1/clone/.git/config",
      ]
    `);
    expect(normalized(argvOf(outer, f.root), f.root).args).toMatchInlineSnapshot(`
      [
        "--unshare-user",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/run",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/etc",
        "/etc",
        "--tmpfs",
        "/etc/ssh",
        "--ro-bind",
        "<R>/dk",
        "<R>/dk",
        "--ro-bind",
        "<R>/eg",
        "<R>/eg",
        "--ro-bind",
        "<R>/bin",
        "<R>/bin",
        "--ro-bind",
        "<R>/aom",
        "<R>/aom",
        "--ro-bind",
        "<R>/ipc",
        "<R>/ipc",
        "--ro-bind",
        "<R>/worktrees",
        "<R>/worktrees",
        "--ro-bind",
        "<R>/home/.ssh",
        "<R>/home/.ssh",
        "--ro-bind",
        "<R>/claude/lib",
        "<R>/claude/lib",
        "--ro-bind",
        "<R>/clones/app",
        "<R>/clones/app",
        "--ro-bind",
        "<R>/clones/lib",
        "<R>/clones/lib",
        "--bind",
        "<R>/devops-tools",
        "<R>/devops-tools",
        "--ro-bind",
        "<R>/toolchains/bun",
        "<R>/toolchains/bun",
        "--ro-bind",
        "<R>/home/.gitconfig",
        "<R>/home/.gitconfig",
        "--ro-bind",
        "/dev/null",
        "<R>/clones/app/.env",
        "--bind",
        "<R>/agents/a1/tmp/req-1",
        "<R>/agents/a1/tmp/req-1",
        "--bind",
        "<R>/agents/a1/devops/req-1",
        "<R>/agents/a1/devops/req-1",
        "--bind",
        "<R>/agents/a1/config/outer/req-1",
        "<R>/agents/a1/config/outer/req-1",
        "--bind",
        "<R>/agents/a1/config/outer/req-1/home",
        "<R>/agents/a1/config/outer/req-1/home",
        "--ro-bind",
        "<R>/agents/a1/config/outer/req-1.guard",
        "<R>/agents/a1/config/outer/req-1.guard",
        "--ro-bind",
        "<R>/agents/a1/devops/req-1/clone/.git/config",
        "<R>/agents/a1/devops/req-1/clone/.git/config",
        "--bind-fd",
        "3",
        "<R>/desk",
      ]
    `);
    expect(normalized(argvOf(ceo, f.root), f.root).args).toMatchInlineSnapshot(`
      [
        "--unshare-user",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/run",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/etc",
        "/etc",
        "--tmpfs",
        "/etc/ssh",
        "--ro-bind",
        "<R>/eg",
        "<R>/eg",
        "--ro-bind",
        "<R>/bin",
        "<R>/bin",
        "--ro-bind",
        "<R>/aom",
        "<R>/aom",
        "--ro-bind",
        "<R>/worktrees",
        "<R>/worktrees",
        "--ro-bind",
        "<R>/home/.ssh",
        "<R>/home/.ssh",
        "--ro-bind",
        "<R>/claude/lib",
        "<R>/claude/lib",
        "--bind",
        "<R>/devops-tools",
        "<R>/devops-tools",
        "--ro-bind",
        "<R>/home/.gitconfig",
        "<R>/home/.gitconfig",
        "--bind",
        "<R>/agents/a1/tmp/req-1",
        "<R>/agents/a1/tmp/req-1",
        "--bind",
        "<R>/agents/a1/devops/req-1",
        "<R>/agents/a1/devops/req-1",
        "--bind",
        "<R>/agents/a1/config/outer/req-1",
        "<R>/agents/a1/config/outer/req-1",
        "--bind",
        "<R>/agents/a1/config/outer/req-1/home",
        "<R>/agents/a1/config/outer/req-1/home",
        "--ro-bind-fd",
        "3",
        "<R>/desk",
      ]
    `);
  });
});

// ---------------------------------------------------------------------------------------------------- the work dirs

const perms = BUILTIN_ROLES.find((r) => r.key === 'devops')?.permissions;
if (!perms) throw new Error('no devops role');

/** The folders the argv really shows: every bind and read-only bind destination (no /dev/null mask) and the fd binds. */
function boundInArgv(args: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--bind' || a === '--ro-bind') && args[i + 1] !== '/dev/null') out.add(args[i + 2] as string);
    if (a === '--bind-fd' || a === '--ro-bind-fd') out.add(args[i + 2] as string);
  }
  return out;
}

function planInput(f: Fixture, level: 'inner' | 'outer'): BoxPlanInput {
  return {
    level,
    requestDir: f.requestDir,
    configDir: f.configDir,
    tmp: f.tmp,
    aomReadPaths: f.aom,
    plumbingReadPaths: f.plumbing,
    claudeBin: f.claudeBin,
    toolchainReadDirs: f.toolchains,
    cloneDirs: [...f.clones, join(f.root, 'clones', 'big')],
    ipcSocket: f.ipcSocket,
    ...(level === 'outer' ? { outer: f.outer, fdBinds: [{ fdIndex: 3, real: f.desk, writable: true }] } : {}),
  };
}

/** The settings a boxed session writes, derived the way `startBoxedSession` does. */
function boxedSettings(f: Fixture, level: 'inner' | 'outer'): { s: ClaudeSettings; base: ClaudeSettings } {
  const agent = join(f.root, 'agents', 'a1');
  const ctx = policyCtx({
    runnerRoot: f.root,
    agentDir: agent,
    cwd: f.requestDir,
    gitDirs: [],
    readDirs: [...f.clones, join(f.root, 'clones', 'big')],
    aomReadPaths: f.aom,
    realHome: f.outer.realHome,
    toolchainReadPaths: f.toolchains,
  });
  const paths = {
    home: join(agent, 'home'),
    configDir: f.configDir,
    scratch: join(agent, 'scratch'),
    tmp: f.tmp,
  };
  const base =
    level === 'inner'
      ? buildDevopsBoxSettings(perms as never, ctx, { ...paths, scratch: f.requestDir })
      : buildShiftSettings(perms as never, ctx, paths, 'devops', true);
  delete (base as { sandbox?: unknown }).sandbox;
  const pi = planInput(f, level);
  const bound = new Set(boundDirsOf(boxSandbox(pi)));
  return {
    s: withBoxWorkDirs(
      base,
      boxWorkDirs(pi, (p) => bound.has(p), systemRoBinds()),
    ),
    base,
  };
}

describe('AC1: a boxed DevOps session lists exactly the folders its box binds', () => {
  it('the system binds are /usr, /etc and the real (not linked) system folders of this host', () => {
    const sys = systemRoBinds();
    expect(sys.slice(0, 2)).toEqual(['/usr', '/etc']);
    for (const d of SYSTEM_DIRS) {
      let real = false;
      try {
        real = !lstatSync(d).isSymbolicLink() && statSync(d).isDirectory();
      } catch {
        // absent
      }
      expect(sys.includes(d), d).toBe(real);
    }
  });

  it('inner: additionalDirectories are the bound work dirs read from the argv; no scratch, no missing or unopened folder', () => {
    const f = fixture();
    const { s, base } = boxedSettings(f, 'inner');
    const argv = argvOf(boxSandbox(planInput(f, 'inner')), f.root);
    const inArgv = boundInArgv(argv);
    const dirs = s.permissions.additionalDirectories;
    for (const d of dirs) expect(inArgv.has(d) || systemRoBinds().includes(d), d).toBe(true);
    expect(dirs).toEqual([
      join(f.configDir, 'home'),
      f.tmp,
      ...systemRoBinds(),
      join(f.root, 'toolchains', 'bun'),
      ...f.clones,
    ]);
    // a too-big clone (not opened), a missing toolchain, the request folder itself (the cwd): not listed
    for (const gone of [join(f.root, 'clones', 'big'), join(f.root, 'toolchains', 'missing'), f.requestDir])
      expect(dirs).not.toContain(gone);
    // never the runner's own plumbing, its bin, Claude's install or the config dir itself
    for (const never of [...f.aom, ...f.plumbing, dirname(f.claudeBin), f.configDir, join(f.root, 'ipc')])
      expect(dirs).not.toContain(never);
    // the write rules are unchanged; only Edit denies on the read-only folders are added
    expect(s.permissions.allow).toEqual(base.permissions.allow);
    expect(s.permissions.deny).toContain('Edit(//usr/**)');
    expect(s.permissions.deny).toContain(`Edit(/${join(f.root, 'toolchains', 'bun')}/**)`);
    expect(
      s.permissions.deny.filter((d) => d.startsWith('Edit(') && !base.permissions.deny.includes(d)),
    ).not.toContainEqual(expect.stringContaining(f.requestDir));
  });

  it('outer: the card worktrees, devops-tools and a writable Desk fd bind are listed; the credentials are denied to its tools', () => {
    const f = fixture();
    const { s, base } = boxedSettings(f, 'outer');
    // development listed only `<agent>/scratch` (not bound in any box)
    expect(base.permissions.additionalDirectories).toEqual([join(f.root, 'agents', 'a1', 'scratch')]);
    const inArgv = boundInArgv(argvOf(boxSandbox(planInput(f, 'outer')), f.root));
    const dirs = s.permissions.additionalDirectories;
    for (const d of dirs) expect(inArgv.has(d) || systemRoBinds().includes(d), d).toBe(true);
    expect(dirs).toEqual([
      join(f.configDir, 'home'),
      f.tmp,
      f.outer.devopsTools,
      f.desk,
      ...systemRoBinds(),
      join(f.root, 'toolchains', 'bun'),
      ...f.clones,
      f.outer.cardWorktrees,
    ]);
    expect(dirs).not.toContain(join(f.root, 'agents', 'a1', 'scratch'));
    // ~/.ssh and ~/.gitconfig are bound for git, never listed, and Claude's own tools are refused on them
    for (const c of ['.ssh', '.gitconfig']) {
      const p = join(f.outer.realHome, c);
      expect(dirs).not.toContain(p);
      expect(s.permissions.deny).toEqual(expect.arrayContaining([`Read(/${p})`, `Read(/${p}/**)`]));
    }
    // read-only folders get Edit denies; the writable ones never do
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        `Edit(/${f.outer.cardWorktrees})`,
        `Edit(/${f.outer.cardWorktrees}/**)`,
        'Edit(//etc/**)',
      ]),
    );
    for (const w of [f.desk, f.outer.devopsTools, f.tmp, f.requestDir])
      expect(s.permissions.deny.filter((d) => !base.permissions.deny.includes(d)).join(' ')).not.toContain(
        `Edit(/${w}`,
      );
    // Edit stays limited to the request folder (and the session's own scratch, tmp and home)
    expect(s.permissions.allow).toEqual(base.permissions.allow);
  });
});

describe('boxWorkDirs rules', () => {
  const base = (over: Partial<BoxPlanInput> = {}): BoxPlanInput => ({
    level: 'outer',
    requestDir: '/r/agents/a/devops/q',
    configDir: '/r/agents/a/config/outer/q',
    tmp: '/r/agents/a/tmp/q',
    aomReadPaths: ['/r/bin'],
    plumbingReadPaths: ['/r/agents/a/config/outer/q.guard'],
    claudeBin: '/opt/claude/claude',
    toolchainReadDirs: [],
    cloneDirs: [],
    outer: { devopsTools: '/r/devops-tools', cardWorktrees: '/r/worktrees', realHome: '/home/me' },
    ...over,
  });
  const all = () => true;

  it('a Node prefix of /usr dedupes with the system entry; any other prefix is listed like a toolchain', () => {
    const w = boxWorkDirs(base({ toolchainReadDirs: ['/usr', '/opt/node'] }), all, ['/usr', '/etc']);
    expect(w.dirs.filter((d) => d === '/usr')).toHaveLength(1);
    expect(w.dirs).toContain('/opt/node');
    expect(w.readOnly).toEqual(expect.arrayContaining(['/usr', '/etc', '/opt/node']));
  });

  it('drops what is inside the request folder, what is not bound and duplicates; never lists plumbing or the config dir', () => {
    const w = boxWorkDirs(
      base({
        toolchainReadDirs: ['/opt/t', '/opt/t', '/r/agents/a/devops/q/sub', '/opt/unbound'],
        cloneDirs: ['/r/clones/c'],
      }),
      (p) => p !== '/opt/unbound',
      [],
    );
    expect(w.dirs).toEqual([
      '/r/agents/a/config/outer/q/home',
      '/r/agents/a/tmp/q',
      '/r/devops-tools',
      '/opt/t',
      '/r/clones/c',
      '/r/worktrees',
    ]);
    expect(w.credentials).toEqual(['/home/me/.ssh', '/home/me/.gitconfig']);
  });

  it('a read-only entry that holds the request folder or a writable folder gets no Edit deny', () => {
    const w = boxWorkDirs(base({ toolchainReadDirs: ['/r/agents', '/r'] }), all, ['/usr']);
    expect(w.dirs).toEqual(expect.arrayContaining(['/r/agents', '/r']));
    expect(w.readOnly).toEqual(['/usr', '/r/worktrees']);
  });

  it('the inner level: no devops-tools, worktrees or credentials; read-only fd binds are read-only', () => {
    const { outer: _o, ...inner } = base();
    const w = boxWorkDirs(
      { ...inner, level: 'inner', fdBinds: [{ fdIndex: 3, real: '/srv/ro', writable: false }] },
      all,
      [],
    );
    expect(w.dirs).toEqual(['/r/agents/a/config/outer/q/home', '/r/agents/a/tmp/q', '/srv/ro']);
    expect(w.readOnly).toEqual(['/srv/ro']);
    expect(w.credentials).toEqual([]);
  });

  it('macOS: the system part is the Seatbelt system read list (no /dev)', () => {
    expect(MAC_SYSTEM_READ).not.toContain('/dev');
    const w = boxWorkDirs(base(), all, MAC_SYSTEM_READ);
    expect(w.dirs).toEqual(expect.arrayContaining([...MAC_SYSTEM_READ]));
  });
});

describe('withBoxWorkDirs', () => {
  it('sets the dirs, adds Edit denies for read-only and Read denies for credentials; allows and other fields untouched', () => {
    const s: ClaudeSettings = {
      permissions: {
        allow: ['Bash', 'Edit(//w/**)'],
        deny: ['WebFetch'],
        defaultMode: 'dontAsk',
        additionalDirectories: ['/x'],
      },
      includeCoAuthoredBy: false,
    } as ClaudeSettings;
    const out = withBoxWorkDirs(s, { dirs: ['/a', '/ro'], readOnly: ['/ro'], credentials: ['/h/.ssh'] });
    expect(out.permissions.additionalDirectories).toEqual(['/a', '/ro']);
    expect(out.permissions.allow).toEqual(['Bash', 'Edit(//w/**)']);
    expect(out.permissions.deny).toEqual([
      'WebFetch',
      'Edit(//ro)',
      'Edit(//ro/**)',
      'Read(//h/.ssh)',
      'Read(//h/.ssh/**)',
    ]);
    expect(out.includeCoAuthoredBy).toBe(false);
    // pure: the input is not changed
    expect(s.permissions.additionalDirectories).toEqual(['/x']);
  });
});

describe('the DevOps chat and backend box shift (Claude Code’s own sandbox): Read rules for its toolchains, nothing added', () => {
  const ctx = policyCtx({
    cwd: '/data/agents/a1/devops/req',
    gitDirs: [],
    toolchainReadPaths: ['/opt/node-24', '/data/toolchains'],
  });
  const paths = {
    home: '/data/agents/a1/home',
    configDir: '/data/agents/a1/claude',
    scratch: '/data/agents/a1/devops/req',
    tmp: '/data/agents/a1/tmp',
  };

  it('Read allows for the toolchain folders its sandbox opens; no additionalDirectories added', () => {
    const s = buildDevopsBoxSettings(perms as never, ctx, paths);
    expect(s.permissions.allow).toEqual(
      expect.arrayContaining(['Read(//opt/node-24)', 'Read(//opt/node-24/**)', 'Read(//data/toolchains/**)']),
    );
    expect(s.permissions.additionalDirectories).toEqual(['/data/agents/a1/devops/req']);
    expect(s.sandbox?.filesystem.allowRead).toEqual(
      expect.arrayContaining(['/opt/node-24', '/data/toolchains']),
    );
  });

  it('its sandbox block is byte-identical to development (recorded there; host-specific masks left out)', () => {
    const sb = buildDevopsBoxSettings(perms as never, ctx, paths).sandbox;
    const fs = sb?.filesystem;
    const pinned = {
      ...sb,
      filesystem: {
        ...fs,
        denyRead: fs?.denyRead.filter((p) => p.startsWith('/data') || p.startsWith('/home/me')),
      },
    };
    expect(JSON.stringify(pinned)).toMatchInlineSnapshot(
      `"{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":true,"filesystem":{"allowWrite":["/data/agents/a1/home","/data/agents/a1/devops/req","/data/agents/a1/tmp"],"denyWrite":["/data/config.json","/data/outbox","/data/outbound","/data/active-shifts","/data/vaults.json","/data/status.json","/data/logs","/data/mock-state","/data/secrets","/data/keys","/data/session-env","/data/toolchains.json","/data/card-branches.json","/data/conflicts.json","/data/approved-requests.json"],"denyRead":["/data","/home/me/.ssh","/home/me/.aws","/home/me/.azure","/home/me/.gnupg","/home/me/.kube","/home/me/.docker","/home/me/.netrc","/home/me/.npmrc","/home/me/.pypirc","/home/me/.git-credentials","/home/me/.config/gh","/home/me/.config/gcloud","/home/me/.claude","/home/me/.claude.json","/home/me/.mozilla","/home/me/.config/google-chrome","/home/me/.config/chromium","/home/me/.config/BraveSoftware","/home/me/.config/microsoft-edge","/home/me/Library/Application Support/Google/Chrome","/home/me/Library/Application Support/Firefox","/home/me/Library/Application Support/BraveSoftware"],"allowRead":["/data/agents/a1/devops/req","/data/bin","/opt/node-24","/data/toolchains"]},"excludedCommands":["aom","aom *","/data/bin/aom","/data/bin/aom *"],"network":{"allowedDomains":["registry.npmjs.org","*.npmjs.org","registry.yarnpkg.com","pypi.org","files.pythonhosted.org","crates.io","static.crates.io","index.crates.io","proxy.golang.org","sum.golang.org","rubygems.org","index.rubygems.org","repo.maven.apache.org","repo1.maven.org","api.nuget.org","*.nuget.org","plugins.gradle.org","services.gradle.org","github.com","codeload.github.com","objects.githubusercontent.com"],"strictAllowlist":true,"allowUnixSockets":[],"allowLocalBinding":true}}"`,
    );
  });
});
