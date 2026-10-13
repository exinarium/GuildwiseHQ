import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { DevOpsAccess, EnvEnsurePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { sandboxEnv } from '../src/sandbox/sandbox.ts';
import { dotnetGaps, pathWithDotnet, sdkSatisfies, selectDotnet } from '../src/toolchain/dotnet.ts';
import { type EnsureDeps, ensureEnvironment, type RootRunner } from '../src/toolchain/ensure.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import {
  agentPath,
  describeToolchains,
  detectToolchains,
  ToolchainRegistry,
  toolchainNote,
  toolchainRpc,
} from '../src/toolchain/registry.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const real = (p: string) => realpathSync(p);
const dir = (...parts: string[]): string => {
  mkdirSync(join(...parts), { recursive: true });
  return real(join(...parts));
};
/** A .NET install root with these SDKs and runtimes (directory names only; nothing runs). */
function dotnetRoot(root: string, sdks: string[], runtimes: string[] = []): string {
  for (const v of sdks) dir(root, 'sdk', v);
  for (const v of runtimes) dir(root, 'shared', 'Microsoft.NETCore.App', v);
  return real(root);
}
const exe = (d: string, name: string) => {
  writeFileSync(join(d, name), '#!/bin/sh\nexit 0\n');
  chmodSync(join(d, name), 0o755);
};

describe('.NET detection and root choice', () => {
  const hermetic = (home: string, extra: Record<string, unknown> = {}) => ({
    home,
    systemRoots: [] as string[],
    env: { PATH: '' } as NodeJS.ProcessEnv,
    ...extra,
  });

  it('the owner machine: system root with SDK 8 and ~/.dotnet with 8 and 10 -> the superset ~/.dotnet', () => {
    const home = tmp();
    const sys = dotnetRoot(join(tmp(), 'share', 'dotnet'), ['8.0.425'], ['8.0.31']);
    const mine = dotnetRoot(join(home, '.dotnet'), ['8.0.425', '10.0.401'], ['8.0.31', '10.0.12']);
    const sel = selectDotnet({ ...hermetic(home), systemRoots: [sys] });
    expect(sel.chosen?.root).toBe(mine);
    expect(sel.chosen?.sdks).toEqual(['8.0.425', '10.0.401']);
    expect(sel.reason).toBe('superset');
    expect(sel.all).toHaveLength(2);
  });

  it('no superset: the root with more SDKs wins; a tie goes to the highest SDK', () => {
    const home = tmp();
    const a = dotnetRoot(join(tmp(), 'a'), ['6.0.100', '7.0.100', '8.0.100']);
    const b = dotnetRoot(join(tmp(), 'b'), ['8.0.425', '9.0.100']);
    expect(selectDotnet({ ...hermetic(home), systemRoots: [a, b] })).toMatchObject({
      chosen: { root: a },
      reason: 'most-sdks',
    });
    const c = dotnetRoot(join(tmp(), 'c'), ['8.0.425', '10.0.401']);
    const d = dotnetRoot(join(tmp(), 'd'), ['8.0.100', '9.0.100']);
    expect(selectDotnet({ ...hermetic(home), systemRoots: [d, c] })).toMatchObject({
      chosen: { root: c },
      reason: 'highest-sdk',
    });
  });

  it('the config override wins, even over a superset; an override without an SDK is ignored', () => {
    const home = tmp();
    const big = dotnetRoot(join(home, '.dotnet'), ['8.0.425', '10.0.401']);
    const small = dotnetRoot(join(tmp(), 'small'), ['8.0.425']);
    expect(selectDotnet({ ...hermetic(home), override: small })).toMatchObject({
      chosen: { root: small },
      reason: 'config',
    });
    expect(selectDotnet({ ...hermetic(home), override: join(tmp(), 'nothing') }).chosen?.root).toBe(big);
  });

  it('a symlinked dotnet on PATH resolves to the root of the real executable', () => {
    const home = tmp();
    const sys = dotnetRoot(join(tmp(), 'usr-share-dotnet'), ['8.0.425']);
    exe(sys, 'dotnet');
    const bin = dir(tmp(), 'usr-local-bin');
    symlinkSync(join(sys, 'dotnet'), join(bin, 'dotnet'));
    const sel = selectDotnet({ home, systemRoots: [], env: { PATH: bin } });
    expect(sel.chosen?.root).toBe(sys);
    expect(sel.reason).toBe('only');
  });

  it('$DOTNET_ROOT is a candidate; runtime-only roots are listed but never chosen; nothing found is fine', () => {
    const home = tmp();
    const rt = dotnetRoot(join(tmp(), 'rt'), [], ['8.0.31']);
    const sel = selectDotnet({ ...hermetic(home), env: { PATH: '', DOTNET_ROOT: rt } });
    expect(sel.all.map((i) => i.root)).toEqual([rt]);
    expect(sel.chosen).toBeUndefined();
    expect(selectDotnet(hermetic(tmp())).all).toEqual([]);
  });

  it('versions sort numerically (10 after 8; a release after its preview)', () => {
    const root = dotnetRoot(join(tmp(), 'v'), ['10.0.401', '8.0.425', '9.0.100', '10.0.100-preview.1.2']);
    expect(selectDotnet({ home: tmp(), systemRoots: [root], env: { PATH: '' } }).chosen?.sdks).toEqual([
      '8.0.425',
      '9.0.100',
      '10.0.100-preview.1.2',
      '10.0.401',
    ]);
  });
});

describe('global.json and target frameworks against the chosen root', () => {
  const install = { root: '/r', sdks: ['8.0.425', '10.0.401'], runtimes: ['8.0.31', '10.0.12'] };

  it('roll-forward policies', () => {
    expect(sdkSatisfies('8.0.425', '8.0.100')).toBe(false); // default latestPatch: same feature band only
    expect(sdkSatisfies('8.0.425', '8.0.400')).toBe(true);
    expect(sdkSatisfies('8.0.425', '8.0.100', 'latestFeature')).toBe(true);
    expect(sdkSatisfies('8.0.425', '8.0.425', 'disable')).toBe(true);
    expect(sdkSatisfies('8.0.425', '8.0.401', 'disable')).toBe(false);
    expect(sdkSatisfies('10.0.401', '8.0.100', 'latestMajor')).toBe(true);
    expect(sdkSatisfies('10.0.401', '8.0.100', 'latestMinor')).toBe(false);
  });

  it('reports the missing SDK and runtime with the channel to install', () => {
    expect(dotnetGaps(install, { globalVersion: '10.0.400', tfmMajors: [10] }).problems).toEqual([]);
    const g = dotnetGaps(
      { root: '/r', sdks: ['8.0.425'], runtimes: ['8.0.31'] },
      {
        globalVersion: '10.0.100',
        tfmMajors: [10],
      },
    );
    expect(g.problems).toEqual(
      expect.arrayContaining([
        'missing SDK 10.0.100 (global.json)',
        'missing SDK 10.0 (target framework net10.0)',
      ]),
    );
    expect(g.channels).toEqual(['10.0']);
    const rt = dotnetGaps({ root: '/r', sdks: ['10.0.401'], runtimes: ['10.0.12'] }, { tfmMajors: [8, 10] });
    expect(rt.problems).toEqual(['missing runtime 8.0']);
    expect(rt.runtimeChannels).toEqual(['8.0']);
    expect(dotnetGaps(undefined, { tfmMajors: [8] }).channels).toEqual(['8.0']);
  });

  it('PATH gets the root first, once', () => {
    expect(pathWithDotnet(`/usr/bin${delimiter}/r`, '/r')).toBe(`/r${delimiter}/usr/bin`);
  });
});

describe('env.ensure for .NET against the chosen root', () => {
  const access: DevOpsAccess = { allowInstall: true, allowDocker: false, allowedPaths: [], sudo: false };
  const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
  const run = async (files: Record<string, string>, root: string, allowInstall = true) => {
    const repo = tmp('aom-dn-');
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), text);
    }
    const calls: Array<{ line: string; env?: Record<string, string> }> = [];
    const exec: Executor = {
      async run(cmd, args, opts) {
        calls.push({ line: [cmd, ...args].join(' '), ...(opts?.env ? { env: opts.env } : {}) });
        return ok();
      },
    };
    const rootRunner: RootRunner = {
      mode: async () => ({ mode: 'none', detail: '' }),
      run: async () => ok(),
    };
    const deps: EnsureDeps = {
      exec,
      platform: 'linux',
      root: rootRunner,
      findRepo: async () => ({ localPath: repo }),
      installDependencies: true,
      dotnet: () => selectDotnet({ home: tmp(), systemRoots: [root], env: { PATH: '' } }),
    };
    const payload: EnvEnsurePayload = {
      requestId: '0190aaaa-0000-7000-8000-00000000ffff',
      projectId: '0190aaaa-0000-7000-8000-000000000001',
      repos: [{ repoId: '0190aaaa-0000-7000-8000-0000000000a1', name: 'app', remoteUrlNormalized: 'x/y' }],
      access: { ...access, allowInstall },
    } as EnvEnsurePayload;
    return { report: await ensureEnvironment(payload, deps), calls };
  };
  const proj = (tfm: string) =>
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${tfm}</TargetFramework></PropertyGroup></Project>`;

  it('both SDKs present: ready, the report lists the SDKs of the root, dotnet runs with that root', async () => {
    const root = dotnetRoot(join(tmp(), 'dn'), ['8.0.425', '10.0.401'], ['8.0.31', '10.0.12']);
    const { report, calls } = await run(
      {
        'global.json': '{"sdk":{"version":"10.0.100","rollForward":"latestFeature"}}',
        'a.csproj': proj('net10.0'),
      },
      root,
    );
    expect(report.state).toBe('ready');
    expect(report.tools[0]).toMatchObject({ tool: '.NET SDKs', version: '8.0.425, 10.0.401', status: 'ok' });
    const restore = calls.find((c) => c.line.startsWith('dotnet restore'));
    expect(restore?.env?.DOTNET_ROOT).toBe(root);
    expect(restore?.env?.PATH?.startsWith(root)).toBe(true);
  });

  it('missing SDK 10: reported, and installed into the (user-writable) chosen root', async () => {
    const root = dotnetRoot(join(tmp(), 'dn'), ['8.0.425'], ['8.0.31']);
    const off = await run(
      { 'global.json': '{"sdk":{"version":"10.0.100"}}', 'a.csproj': proj('net10.0') },
      root,
      false,
    );
    expect(off.report.state).toBe('needs_access');
    expect(off.report.summary).toContain('missing SDK 10.0.100 (global.json)');
    expect(off.report.tools.find((t) => t.tool === '.NET SDK')?.fix).toContain('aom toolchain add');

    const on = await run(
      { 'global.json': '{"sdk":{"version":"10.0.100"}}', 'a.csproj': proj('net10.0') },
      root,
    );
    const install = on.calls.find((c) => c.line.startsWith('bash -c curl'));
    expect(install?.line).toContain(`--install-dir '${root}'`);
    expect(install?.line).toContain('--channel 10.0');
  });

  it('missing runtime 8 for a net8.0 test project on a net10-only root', async () => {
    const root = dotnetRoot(join(tmp(), 'dn'), ['10.0.401'], ['10.0.12']);
    const r = await run({ 'a.csproj': proj('net8.0') }, root, false);
    expect(r.report.summary).toContain('missing runtime 8.0');
  });
});

describe('agent toolchain registry', () => {
  const setup = () => {
    const root = real(tmp());
    const home = dir(tmp(), 'home');
    const reg = new ToolchainRegistry(
      join(root, 'toolchains.json'),
      root,
      () => ({ toolchainPaths: [] }),
      home,
      'linux',
      { env: { PATH: '' }, systemRoots: [] },
    );
    return { root, home, reg };
  };
  const goBin = (home: string, v = '1.23.1') => {
    const b = dir(home, 'go', 'sdk', `go${v}`, 'bin');
    exe(b, 'go');
    writeFileSync(join(dirname(b), 'VERSION'), `go${v}\ntime 2024\n`);
    return dirname(b);
  };

  it('registers a tool: persisted 0600, listed, on PATH, readable, env merged, survives a restart', () => {
    const { root, home, reg } = setup();
    const bin = dir(home, '.local', 'tools', 'zig');
    exe(bin, 'zig');
    const e = reg.add({ name: 'zig', bin: [bin], read: [dirname(bin)], env: { ZIG_HOME: bin } }, 'devops');
    expect(e).toMatchObject({ name: 'zig', source: 'devops', addedBy: 'devops' });
    const file = join(root, 'toolchains.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).toolchains).toHaveLength(1);
    const again = new ToolchainRegistry(file, root, () => ({ toolchainPaths: [] }), home, 'linux', {
      env: { PATH: '' },
      systemRoots: [],
    }).resolve();
    expect(again.pathDirs).toEqual([bin]);
    expect(again.readDirs).toEqual(expect.arrayContaining([bin, dirname(bin)]));
    expect(again.env).toEqual({ ZIG_HOME: bin });
  });

  it('refuses unsafe directories', () => {
    const { root, home, reg } = setup();
    const ok = dir(home, 'tools');
    exe(ok, 'x');
    const refuse = (bin: string[], read: string[] = [], re: RegExp) =>
      expect(() => reg.add({ name: 'bad', bin, read })).toThrow(re);
    refuse(['/'], [], /not allowed/);
    refuse([home], [], /not allowed/); // the home dir itself
    refuse([dirname(home)], [], /not allowed/); // a parent of the home dir
    refuse([root], [], /not allowed/); // the runner data dir
    refuse([dir(root, 'agents')], [], /not allowed/); // inside it
    refuse([dir(home, '.ssh')], [], /not allowed/);
    refuse([dir(home, '.aws', 'bin')], [], /not allowed/);
    refuse([ok], ['/'], /not allowed/);
    refuse([ok], [home], /not allowed/);
    refuse(['relative/bin'], [], /absolute/);
    refuse([join(home, 'nope')], [], /does not exist/);
    refuse([dir(home, 'empty')], [], /no executable/);
    expect(() => reg.add({ name: 'bad name!', bin: [ok] })).toThrow(/name/);
    expect(() => reg.add({ name: 'x' })).toThrow(/at least one/);
    expect(reg.persisted()).toEqual([]);
  });

  it('a symlink into a credential store is refused by its real path', () => {
    const { home, reg } = setup();
    const secret = dir(home, '.ssh', 'keys');
    exe(secret, 'x');
    symlinkSync(secret, join(home, 'innocent'));
    expect(() => reg.add({ name: 'sneaky', bin: [join(home, 'innocent')] })).toThrow(/not allowed/);
  });

  it('refuses credentials and runner-managed variables in env, allows the known path settings', () => {
    const { home, reg } = setup();
    const bin = dir(home, 'tools');
    exe(bin, 'x');
    const add = (env: Record<string, string>) => () => reg.add({ name: 't', bin: [bin], env });
    expect(add({ GITHUB_TOKEN: 'abc' })).toThrow(/credential/);
    expect(add({ MY_SECRET: 'abc' })).toThrow(/credential/);
    expect(add({ DB_PASSWORD: 'abc' })).toThrow(/credential/);
    expect(add({ API_KEY: 'abc' })).toThrow(/credential/);
    expect(add({ FOO: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })).toThrow(/secret/);
    expect(add({ PATH: '/evil' })).toThrow(/managed by the runner/);
    expect(add({ HOME: '/evil' })).toThrow(/managed by the runner/);
    expect(add({ LD_PRELOAD: '/evil.so' })).toThrow(/managed by the runner/);
    expect(add({ AOM_SHIFT_TOKEN: 'x' })).toThrow(/managed by the runner/);
    expect(add({ 'BAD NAME': 'x' })).toThrow(/valid variable/);
    expect(add({ FOO: 'a\nb' })).toThrow(/one line/);
    for (const k of ['JAVA_HOME', 'GOROOT', 'DOTNET_ROOT', 'ANDROID_HOME'])
      expect(add({ [k]: bin })).not.toThrow();
  });

  it('PATH order: registered first, then configured, then detected; the aom shim stays first', () => {
    const { root, home } = setup();
    goBin(home);
    const reg = new ToolchainRegistry(
      join(root, 'toolchains.json'),
      root,
      () => ({ toolchainPaths: [dir(home, 'cfg')] }),
      home,
      'linux',
      {
        env: { PATH: '' },
        systemRoots: [],
      },
    );
    const mine = dir(home, 'mine');
    exe(mine, 'x');
    reg.add({ name: 'mine', bin: [mine] });
    const tc = reg.resolve();
    expect(tc.entries.map((e) => e.name)).toEqual(['mine', `path:${join(home, 'cfg')}`, 'go']);
    expect(tc.entries.map((e) => e.source)).toEqual(['devops', 'config', 'detected']);
    expect(tc.pathDirs).toEqual([mine, join(home, 'go', 'sdk', 'go1.23.1', 'bin')]);
    expect(tc.readDirs).toEqual(
      expect.arrayContaining([join(home, 'cfg'), join(home, 'go', 'sdk', 'go1.23.1')]),
    );
    expect(tc.env.GOROOT).toBe(join(home, 'go', 'sdk', 'go1.23.1'));
    const path = agentPath(tc, '/runner/bin', `/usr/bin${delimiter}${mine}`).split(delimiter);
    expect(path).toEqual(['/runner/bin', mine, join(home, 'go', 'sdk', 'go1.23.1', 'bin'), '/usr/bin']);
  });

  it('a registered entry replaces a detected one of the same name; remove only touches registered ones', () => {
    const { home, reg } = setup();
    goBin(home);
    const mine = dir(home, 'my-go');
    exe(mine, 'go');
    reg.add({ name: 'go', bin: [mine] });
    expect(reg.list().filter((e) => e.name === 'go')).toHaveLength(1);
    expect(reg.list()[0]?.binDirs).toEqual([mine]);
    expect(reg.remove('go')).toBe(true);
    expect(reg.remove('go')).toBe(false);
    expect(reg.list()[0]?.source).toBe('detected');
  });

  it('a hand-edited file cannot open the home folder or a credential store', () => {
    const { root, home, reg } = setup();
    writeFileSync(
      join(root, 'toolchains.json'),
      JSON.stringify({
        toolchains: [
          { name: 'evil', binDirs: [home], readDirs: [], env: {}, source: 'devops' },
          { name: 'evil2', binDirs: [], readDirs: [dir(home, '.ssh')], env: {}, source: 'devops' },
          { name: 'envy', binDirs: [dir(home, 't')], readDirs: [], env: { X_TOKEN: 'a' }, source: 'devops' },
        ],
      }),
    );
    expect(reg.persisted()).toEqual([]);
  });

  it('detects the usual user-space managers by directory reads', () => {
    const home = dir(tmp(), 'h');
    const nvm = dir(home, '.nvm', 'versions', 'node');
    for (const v of ['v18.19.0', 'v22.1.0']) dir(nvm, v, 'bin');
    mkdirSync(join(home, '.nvm', 'alias'), { recursive: true });
    writeFileSync(join(home, '.nvm', 'alias', 'default'), '18\n');
    dir(home, '.pyenv', 'shims');
    writeFileSync(join(home, '.pyenv', 'version'), '3.12.4\n');
    dir(home, '.cargo', 'bin');
    dir(home, '.cargo', 'registry'); // credentials live in the cargo home: never listed
    dir(home, '.rustup', 'toolchains');
    dir(home, '.sdkman', 'candidates', 'java', '21.0.2-tem', 'bin');
    symlinkSync(
      join(home, '.sdkman', 'candidates', 'java', '21.0.2-tem'),
      join(home, '.sdkman', 'candidates', 'java', 'current'),
    );
    dir(home, '.local', 'share', 'mise', 'shims');
    dir(home, '.local', 'bin');
    goBin(home, '1.22.0');
    goBin(home, '1.23.1');
    const found = detectToolchains({ home, systemRoots: [], env: { PATH: '' } });
    const by = (n: string) => found.find((e) => e.name === n);
    expect(found.every((e) => e.source === 'detected')).toBe(true);
    expect(by('node-nvm')).toMatchObject({ version: '18.19.0', binDirs: [join(nvm, 'v18.19.0', 'bin')] });
    expect(by('python-pyenv')?.version).toBe('3.12.4');
    expect(by('go')).toMatchObject({
      version: '1.23.1',
      env: { GOROOT: join(home, 'go', 'sdk', 'go1.23.1') },
    });
    expect(by('rust')?.binDirs).toEqual([join(home, '.cargo', 'bin')]);
    expect(by('rust')?.readDirs).not.toContain(join(home, '.cargo'));
    expect(by('java-sdkman')?.env.JAVA_HOME).toBe(join(home, '.sdkman', 'candidates', 'java', 'current'));
    expect(by('mise')).toBeDefined();
    expect(by('local-bin')?.binDirs).toEqual([join(home, '.local', 'bin')]);
    expect(describeToolchains(found)).toContain('go 1.23.1');
  });

  it('detects the dotnet root (superset) with DOTNET_ROOT, its SDK list in the version', () => {
    const home = dir(tmp(), 'h');
    const sys = dotnetRoot(join(tmp(), 'sys'), ['8.0.425']);
    const mine = dotnetRoot(join(home, '.dotnet'), ['8.0.425', '10.0.401']);
    const e = detectToolchains({ home, systemRoots: [sys], env: { PATH: '' } }).find(
      (x) => x.name === 'dotnet',
    );
    expect(e).toMatchObject({ binDirs: [mine], readDirs: [mine], env: { DOTNET_ROOT: mine } });
    expect(e?.version).toBe('8.0.425, 10.0.401 (~/.dotnet)');
    expect(describeToolchains([e as never])).toBe('dotnet 8.0.425, 10.0.401');
  });

  it('the agent instruction line lists the toolchains and sends missing tools to DevOps', () => {
    const line = toolchainNote('dotnet 8.0.425, 10.0.401; go 1.23.1');
    expect(line).toContain('dotnet 8.0.425, 10.0.401; go 1.23.1');
    expect(line).toContain('aom devops');
    expect(line).toContain('aom toolchain add');
    expect(toolchainNote('')).toContain('none registered');
  });

  it('sandbox env carries the toolchain variables but cannot be overridden by them', () => {
    const sb = {
      agentId: 'a',
      root: '/r',
      home: '/r/home',
      configDir: '/r/c',
      scratch: '/r/s',
      tmp: '/tmp/x',
    };
    const env = sandboxEnv(sb, '/nohome', { DOTNET_ROOT: '/dn', HOME: '/evil' });
    expect(env.DOTNET_ROOT).toBe('/dn');
    expect(env.HOME).toBe('/r/home');
  });
});

describe('aom toolchain over the ipc: scope', () => {
  const setup = () => {
    const root = real(tmp());
    const home = dir(tmp(), 'home');
    const reg = new ToolchainRegistry(
      join(root, 'toolchains.json'),
      root,
      () => ({ toolchainPaths: [] }),
      home,
      'linux',
      {
        env: { PATH: '' },
        systemRoots: [],
      },
    );
    const bin = dir(home, 'tools');
    exe(bin, 'x');
    return { reg, bin };
  };

  it('only the DevOps engineer may add or remove; every agent may list', () => {
    const { reg, bin } = setup();
    const add = { name: 'zig', bin: [bin] };
    expect(toolchainRpc(reg, 'toolchain.add', add, false)).toMatchObject({
      ok: false,
      error: expect.stringContaining('only the DevOps'),
    });
    expect(reg.persisted()).toEqual([]);
    expect(toolchainRpc(reg, 'toolchain.add', add, true)).toMatchObject({ ok: true });
    expect(toolchainRpc(reg, 'toolchain.list', {}, false)).toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('zig') },
    });
    expect(toolchainRpc(reg, 'toolchain.remove', { name: 'zig' }, false)).toMatchObject({ ok: false });
    expect(reg.persisted()).toHaveLength(1);
    expect(toolchainRpc(reg, 'toolchain.remove', { name: 'zig' }, true)).toMatchObject({ ok: true });
    expect(toolchainRpc(reg, 'toolchain.remove', { name: 'zig' }, true)).toMatchObject({ ok: false });
  });

  it('refusals come back as errors the agent can read', () => {
    const { reg } = setup();
    expect(toolchainRpc(reg, 'toolchain.add', { name: 'x', bin: ['/'] }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not allowed'),
    });
    expect(toolchainRpc(undefined, 'toolchain.list', {}, true)).toMatchObject({ ok: false });
  });
});
