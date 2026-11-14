import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { CodexAdapter, codexFilesystem } from '../src/adapters/codex.ts';
import { GeminiAdapter } from '../src/adapters/gemini.ts';
import {
  ClaudeRuntimeConfigSchema,
  CodexRuntimeConfigSchema,
  GeminiRuntimeConfigSchema,
} from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { type HarnessSandboxInput, harnessBwrapArgs } from '../src/sandbox/harness-sandbox.ts';
import {
  DOTNET_SHM_DIR,
  ensureDotnetShm,
  ensurePnpmLockDirs,
  ensureSandbox,
  PNPM_LOCK_DIR_NAMES,
  pnpmLockDirs,
  usablePnpmLockDirs,
} from '../src/sandbox/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

cleanupTmp();
const posix = process.platform !== 'win32' && typeof process.getuid === 'function';
const uid = posix ? (process.getuid?.() as number) : 0;
const mode = (p: string) => statSync(p).mode & 0o777;

const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};

describe('pnpm 12 lock folder names', () => {
  it('names exactly the three fixed folders, one set per uid', () => {
    expect(PNPM_LOCK_DIR_NAMES).toEqual([
      'pnpm-store-operation-locks',
      'pnpm-dir-locks',
      'pnpm-verify-deps-install-locks',
    ]);
    expect(pnpmLockDirs(1000)).toEqual([
      '/tmp/pnpm-store-operation-locks-1000',
      '/tmp/pnpm-dir-locks-1000',
      '/tmp/pnpm-verify-deps-install-locks-1000',
    ]);
    expect(pnpmLockDirs(7, '/r')).toEqual(PNPM_LOCK_DIR_NAMES.map((n) => `/r/${n}-7`));
  });
});

describe.skipIf(!posix)('ensurePnpmLockDirs / usablePnpmLockDirs (a temp root stands in for /tmp)', () => {
  it('creates the three folders, owned by the uid, mode 0700, and returns them', async () => {
    const root = tmp();
    const logs: string[] = [];
    const got = await ensurePnpmLockDirs({ root, uid, log: (m) => logs.push(m) });
    expect(got).toEqual(pnpmLockDirs(uid, root));
    for (const d of got) {
      const st = lstatSync(d);
      expect(st.isDirectory(), d).toBe(true);
      expect(st.uid, d).toBe(uid);
      expect(st.mode & 0o777, d).toBe(0o700);
    }
    expect(usablePnpmLockDirs({ root, uid })).toEqual(got);
    expect(logs).toEqual([]);
  });

  it('is idempotent: a second call returns the same folders, mode unchanged', async () => {
    const root = tmp();
    const first = await ensurePnpmLockDirs({ root, uid, log: () => {} });
    const second = await ensurePnpmLockDirs({ root, uid, log: () => {} });
    expect(second).toEqual(first);
    for (const d of second) expect(mode(d)).toBe(0o700);
  });

  it('fixes the mode of an existing own folder to 0700', async () => {
    const root = tmp();
    const [first] = pnpmLockDirs(uid, root) as [string];
    mkdirSync(first, { mode: 0o755 });
    expect(mode(first)).toBe(0o755);
    const got = await ensurePnpmLockDirs({ root, uid, log: () => {} });
    expect(got).toContain(first);
    expect(mode(first)).toBe(0o700);
  });

  it('a mode that is still wrong (not fixed yet) is left off the write list', () => {
    const root = tmp();
    const [first] = pnpmLockDirs(uid, root) as [string];
    mkdirSync(first, { mode: 0o755 });
    expect(usablePnpmLockDirs({ root, uid })).toEqual([]);
  });

  it('refuses a symlink: not followed, not granted, the reason logged; the target is untouched', async () => {
    const root = tmp();
    const target = join(tmp(), 'elsewhere');
    mkdirSync(target, { mode: 0o755 });
    const [, dir] = pnpmLockDirs(uid, root) as [string, string];
    symlinkSync(target, dir);
    const logs: string[] = [];
    const got = await ensurePnpmLockDirs({ root, uid, log: (m) => logs.push(m) });
    expect(got).not.toContain(dir);
    expect(got).toHaveLength(2);
    expect(mode(target)).toBe(0o755);
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(dir);
    expect(logs[0]).toContain('symlink');
    expect(logs[0]).toContain('not added to the sandbox write list');
    expect(usablePnpmLockDirs({ root, uid })).not.toContain(dir);
    expect(usablePnpmLockDirs({ root, uid })).toHaveLength(2);
  });

  it('refuses a plain file at the path', async () => {
    const root = tmp();
    const [, , dir] = pnpmLockDirs(uid, root) as [string, string, string];
    writeFileSync(dir, 'x');
    const logs: string[] = [];
    const got = await ensurePnpmLockDirs({ root, uid, log: (m) => logs.push(m) });
    expect(got).not.toContain(dir);
    expect(logs.join('\n')).toContain(`${dir} not added to the sandbox write list: is not a directory`);
    expect(usablePnpmLockDirs({ root, uid })).not.toContain(dir);
  });

  it('refuses folders owned by another uid and names the owner', async () => {
    const root = tmp();
    // the folders are created as the real uid, so for `uid + 1` every one of them belongs to someone else
    const other = uid + 1;
    const logs: string[] = [];
    const got = await ensurePnpmLockDirs({ root, uid: other, log: (m) => logs.push(m) });
    expect(got).toEqual([]);
    expect(logs).toHaveLength(3);
    for (const l of logs) expect(l).toContain(`owned by uid ${uid}, not ${other}`);
    expect(usablePnpmLockDirs({ root, uid: other })).toEqual([]);
  });

  it('a foreign folder that cannot even be opened (EACCES) is refused and still names its owner', async () => {
    const root = tmp();
    const other = uid + 1;
    const dirs = pnpmLockDirs(other, root);
    // mode 0000: as a normal user open() fails with EACCES, as another user's 0700 folder would
    for (const d of dirs) mkdirSync(d, { mode: 0o000 });
    const logs: string[] = [];
    try {
      const got = await ensurePnpmLockDirs({ root, uid: other, log: (m) => logs.push(m) });
      expect(got).toEqual([]);
      expect(logs).toHaveLength(3);
      for (const l of logs) expect(l).toContain(`owned by uid ${uid}, not ${other}`);
      for (const d of dirs) expect(mode(d)).toBe(0o000);
    } finally {
      for (const d of dirs) chmodSync(d, 0o700);
    }
  });

  it('logs a bad folder once, not on every call', async () => {
    const root = tmp();
    const [dir] = pnpmLockDirs(uid, root) as [string];
    symlinkSync(tmp(), dir);
    const logs: string[] = [];
    await ensurePnpmLockDirs({ root, uid, log: (m) => logs.push(m) });
    await ensurePnpmLockDirs({ root, uid, log: (m) => logs.push(m) });
    expect(logs).toHaveLength(1);
  });

  it('missing folders are not granted', () => {
    expect(usablePnpmLockDirs({ root: tmp(), uid })).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('ensureSandbox creates the real lock folders (Linux)', () => {
  it('after ensureSandbox the three /tmp folders exist, owned by the runner uid, mode 0700', async () => {
    await ensureSandbox(runnerPaths(tmp()), '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', 'Ada', null, undefined, {
      log: { info() {}, warn() {}, error() {} },
    });
    // a folder another user owns on this machine is refused (and logged), never granted: the check is the same
    for (const d of usablePnpmLockDirs()) {
      const st = lstatSync(d);
      expect(st.isDirectory() && st.uid === uid && (st.mode & 0o777) === 0o700, d).toBe(true);
    }
    expect(pnpmLockDirs(uid).every((d) => existsSync(d))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ the write lists

const LOCKS = pnpmLockDirs(1000);
const underTmp = (paths: string[]) => paths.filter((p) => p === '/tmp' || p.startsWith('/tmp/'));

describe('Claude Code: allowWrite carries exactly the three lock folders under /tmp', () => {
  it('builder, reviewer and tester: /tmp/.dotnet and the three lock folders, no /tmp or wildcard', () => {
    const ctx = policyCtx({ dotnetShmDir: DOTNET_SHM_DIR, pnpmLockDirs: LOCKS });
    for (const key of ['builder', 'reviewer', 'tester']) {
      const fs = buildShiftSettings(role(key).permissions, ctx, POLICY_PATHS, key).sandbox?.filesystem;
      expect(underTmp(fs?.allowWrite ?? []), key).toEqual([DOTNET_SHM_DIR, ...LOCKS]);
      expect(fs?.allowWrite ?? [], key).not.toContain('/tmp');
      expect(
        (fs?.allowWrite ?? []).some((p) => p.includes('*')),
        key,
      ).toBe(false);
      expect(fs?.denyWrite ?? [], key).not.toEqual(expect.arrayContaining(LOCKS));
    }
  });

  it('without the field the list is as before', () => {
    const without = buildShiftSettings(
      role('builder').permissions,
      policyCtx({ dotnetShmDir: DOTNET_SHM_DIR }),
      POLICY_PATHS,
      'builder',
    ).sandbox?.filesystem;
    expect(underTmp(without?.allowWrite ?? [])).toEqual([DOTNET_SHM_DIR]);
  });

  it('the adapter fills the context from usablePnpmLockDirs on Linux (also for a hand-built Sandbox)', () => {
    const a = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ bin: 'no-such-claude-binary' }));
    const root = tmp();
    // a Sandbox built by hand, as PR review does: no ensureSandbox
    const sandbox = {
      agentId: 'x',
      root,
      home: join(root, 'home'),
      configDir: join(root, 'c'),
      scratch: root,
      tmp: root,
    };
    // policy() is private
    const ctx = (a as any).policy({ env: {}, sandbox }, root);
    if (process.platform === 'linux') expect(ctx.pnpmLockDirs).toEqual(usablePnpmLockDirs());
    else expect(ctx.pnpmLockDirs).toBeUndefined();
  });
});

describe('Codex and Gemini adapters fill pnpmLockDirs beside dotnetShmDir', () => {
  const handBuilt = () => {
    const root = tmp();
    return {
      cwd: root,
      env: {},
      sandbox: {
        agentId: 'x',
        root,
        home: join(root, 'home'),
        configDir: join(root, 'c'),
        scratch: root,
        tmp: root,
      },
    };
  };
  const codex = (platform: NodeJS.Platform) =>
    new CodexAdapter(CodexRuntimeConfigSchema.parse({ bin: 'no-such-codex-binary' }) as never, undefined, {
      platform,
      home: tmp(),
    } as never);

  it('Codex native profile: on a Linux host it carries the usable lock folders, elsewhere none', () => {
    // profile() is private
    const linux = (codex('linux') as any).profile(handBuilt(), false, false);
    expect(linux.dotnetShmDir).toBe(DOTNET_SHM_DIR);
    expect(linux.pnpmLockDirs).toEqual(usablePnpmLockDirs());
    const mac = (codex('darwin') as any).profile(handBuilt(), false, false);
    expect(mac.pnpmLockDirs).toBeUndefined();
    expect(mac.dotnetShmDir).toBeUndefined();
  });

  it('Codex harness box: the box input carries the usable lock folders on Linux', () => {
    // harnessSpec() is private
    const spec = (codex('linux') as any).harnessSpec(handBuilt(), false, false, tmp());
    if (process.platform === 'linux') expect(spec.pnpmLockDirs).toEqual(usablePnpmLockDirs());
    else expect(spec.pnpmLockDirs).toBeUndefined();
  });

  it('Gemini harness box: the box input carries the usable lock folders on Linux', () => {
    const g = new GeminiAdapter(
      GeminiRuntimeConfigSchema.parse({ bin: 'no-such-gemini-binary' }) as never,
      undefined,
      undefined,
      { home: tmp() } as never,
    );
    // launchSpec() is private
    const spec = (g as any).launchSpec(handBuilt(), false, false, tmp());
    if (process.platform === 'linux') expect(spec.pnpmLockDirs).toEqual(usablePnpmLockDirs());
    else expect(spec.pnpmLockDirs).toBeUndefined();
  });
});

describe('Codex: the profile grants exactly the three lock folders under /tmp', () => {
  const base = {
    cwd: '/work/wt',
    readOnlyCwd: false,
    sandbox: {
      home: '/runner/agents/a/home',
      scratch: '/runner/agents/a/scratch',
      tmp: '/runner/agents/a/tmp',
    },
    gitDirs: [],
    mayCommit: false,
    readDirs: [],
    addDirs: [],
    toolchainReadPaths: [],
    aomReadPaths: [],
    codexReadPaths: [],
  };

  it('the three folders and /tmp/.dotnet are writable, /tmp itself is not granted', () => {
    const fs = codexFilesystem({ ...base, dotnetShmDir: DOTNET_SHM_DIR, pnpmLockDirs: LOCKS });
    for (const p of LOCKS) expect(fs[p], p).toBe('write');
    expect(fs['/tmp']).toBeUndefined();
    expect(underTmp(Object.keys(fs)).sort()).toEqual([DOTNET_SHM_DIR, ...LOCKS].sort());
  });

  it('without the field nothing new is granted', () => {
    const fs = codexFilesystem({ ...base, dotnetShmDir: DOTNET_SHM_DIR });
    expect(underTmp(Object.keys(fs))).toEqual([DOTNET_SHM_DIR]);
  });
});

// The harness box is a bubblewrap box (Linux only), and harnessBwrapArgs drops every path that is missing on the
// host. So the folders are real: the lock folders are made under a temp root for this test's own uid, and
// /tmp/.dotnet is made by ensureDotnetShm here rather than relying on another test having run first.
describe.skipIf(process.platform !== 'linux' || !posix)(
  'harness box: the three lock folders are bound writable, /tmp stays a private tmpfs',
  () => {
    let root = '';
    let locks: string[] = [];
    beforeAll(async () => {
      await ensureDotnetShm();
      root = tmp();
      locks = await ensurePnpmLockDirs({ root, uid, log: () => {} });
    });
    const input: HarnessSandboxInput = {
      cwd: '/work/wt',
      readOnlyCwd: false,
      home: '/runner/agents/a/home',
      scratch: '/runner/agents/a/scratch',
      tmp: '/runner/agents/a/tmp',
      writable: [],
      readonly: [],
      readDirs: [],
      gitDirs: [],
      mayCommit: false,
      proxySocket: '/runner/proxy.sock',
      bridgePort: 3128,
      hiddenFromShell: [],
    };
    const binds = (args: string[]) =>
      args.flatMap((a, i) =>
        a === '--bind' || a === '--bind-try' ? [`${args[i + 1]}=>${args[i + 2]}`] : [],
      );
    const roBinds = (args: string[]) =>
      args.flatMap((a, i) => (a === '--ro-bind' || a === '--ro-bind-try' ? [`${args[i + 1]}`] : []));
    // the temp root may itself sit under /tmp (os.tmpdir()), so both count as "under /tmp" here
    const underTmpOrRoot = (b: string) => b.startsWith('/tmp') || b.startsWith(root);

    it('the fixtures are real: /tmp/.dotnet and the three lock folders exist on the host', () => {
      expect(existsSync(DOTNET_SHM_DIR)).toBe(true);
      expect(locks).toEqual(pnpmLockDirs(uid, root));
    });

    it('one writable bind per folder, at its own path; nothing else under /tmp', () => {
      const args = harnessBwrapArgs({ ...input, dotnetShmDir: DOTNET_SHM_DIR, pnpmLockDirs: locks });
      const tmpBinds = binds(args).filter(underTmpOrRoot);
      expect(tmpBinds.sort()).toEqual([DOTNET_SHM_DIR, ...locks].map((p) => `${p}=>${p}`).sort());
      expect(roBinds(args).filter(underTmpOrRoot)).toEqual([]);
      expect(args[args.indexOf('/tmp') - 1]).toBe('--tmpfs');
      expect(binds(args)).not.toContain('/tmp=>/tmp');
    });

    it('without the field only /tmp/.dotnet is bound', () => {
      const args = harnessBwrapArgs({ ...input, dotnetShmDir: DOTNET_SHM_DIR });
      expect(binds(args).filter(underTmpOrRoot)).toEqual([`${DOTNET_SHM_DIR}=>${DOTNET_SHM_DIR}`]);
    });

    it('a missing lock folder is not bound (the box cannot mount it), the others still are', () => {
      const missing = join(tmp(), 'pnpm-dir-locks-gone');
      const args = harnessBwrapArgs({
        ...input,
        dotnetShmDir: DOTNET_SHM_DIR,
        pnpmLockDirs: [missing, ...locks],
      });
      expect(binds(args).some((b) => b.startsWith(missing))).toBe(false);
      for (const p of locks) expect(binds(args)).toContain(`${p}=>${p}`);
    });
  },
);

// ---------------------------------------------------------------------------------- real sandbox (bubblewrap)

const which = (bin: string): string | undefined =>
  (process.env.PATH ?? '')
    .split(':')
    .map((d) => join(d, bin))
    .find((p) => existsSync(p));
const bwrap = process.platform === 'linux' ? which('bwrap') : undefined;
const bwrapWorks =
  bwrap !== undefined &&
  spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;
const pnpm = which('pnpm');
const pnpmMajor = pnpm
  ? Number((spawnSync(pnpm, ['--version'], { encoding: 'utf8' }).stdout ?? '').split('.')[0])
  : 0;

/** Read-only `/` with only the Claude policy's allowWrite paths (and the work folder) writable, like the shift sandbox. */
describe.skipIf(!bwrapWorks)('pnpm lock folders in a real bubblewrap sandbox (skipped without bwrap)', () => {
  const run = async (script: string, opts: { withLocks?: boolean } = {}) => {
    const root = realpathSync(tmp());
    const paths = runnerPaths(root);
    const sb = await ensureSandbox(paths, '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', 'Ada', null, undefined, {
      log: { info() {}, warn() {}, error() {} },
    });
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    const locks = opts.withLocks === false ? [] : usablePnpmLockDirs();
    const policy = buildShiftSettings(
      role('builder').permissions,
      policyCtx({
        runnerRoot: root,
        agentDir: paths.agentDir('019e3f6a-7b1c-7a2d-8c3e-0123456789a1'),
        cwd,
        gitDirs: [],
        sharedCacheDir: sb.cacheRoot,
        dotnetShmDir: DOTNET_SHM_DIR,
        pnpmLockDirs: locks,
      }),
      sb,
      'builder',
    );
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
    for (const w of (policy.sandbox?.filesystem.allowWrite ?? []).filter((p) => existsSync(p)))
      args.push('--bind', w, w);
    args.push('--bind', cwd, cwd, '--chdir', cwd);
    return spawnSync(bwrap as string, [...args, 'bash', '-c', script], {
      env: { PATH: process.env.PATH ?? '', HOME: sb.home, TMPDIR: sb.tmp, CI: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    });
  };

  it('a lock folder is writable, any other /tmp path is not', async () => {
    const dir = `/tmp/pnpm-dir-locks-${uid}`;
    const r = await run(
      `touch ${dir}/aom-probe && echo LOCK-OK; rm -f ${dir}/aom-probe; touch /tmp/aom-pnpm-x 2>&1 || echo TMP-DENIED`,
    );
    expect(r.stdout, r.stderr).toContain('LOCK-OK');
    expect(r.stdout).toContain('TMP-DENIED');
    expect(r.stdout).toMatch(/Read-only file system/);
  }, 60_000);

  const workspace = [
    `printf '%s' '{"name":"w","version":"1.0.0","private":true,"scripts":{"hi":"echo HI-RAN"}}' > package.json`,
    `printf "lockfileVersion: '9.0'\\n\\nsettings:\\n  autoInstallPeers: true\\n  excludeLinksFromLockfile: false\\n\\nimporters:\\n\\n  .: {}\\n" > pnpm-lock.yaml`,
  ].join(' && ');

  it.skipIf(pnpmMajor < 12)(
    'pnpm 12: install --frozen-lockfile, run and exec pass without a lock error',
    async () => {
      const r = await run(
        `${workspace} && pnpm install --frozen-lockfile 2>&1; pnpm run hi 2>&1; pnpm exec node -v 2>&1`,
      );
      const out = `${r.stdout}${r.stderr}`;
      expect(out).not.toContain('ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK');
      expect(out).not.toMatch(/store operation lock/i);
      expect(out).toContain('HI-RAN');
      expect(out).toMatch(/v\d+\.\d+/);
    },
    120_000,
  );

  it.skipIf(pnpmMajor < 12)(
    'without the lock folders pnpm 12 install fails on the lock (the bug)',
    async () => {
      const r = await run(`${workspace} && pnpm install --frozen-lockfile 2>&1`, { withLocks: false });
      expect(`${r.stdout}${r.stderr}`).toMatch(
        /store operation lock|ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK/i,
      );
    },
    120_000,
  );
});
