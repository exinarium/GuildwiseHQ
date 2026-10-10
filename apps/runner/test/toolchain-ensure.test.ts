import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DevOpsAccess, EnvEnsurePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { type EnsureDeps, ensureEnvironment, type RootRunner } from '../src/toolchain/ensure.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { androidHome, cmdlineToolsScript } from '../src/toolchain/stacks.ts';
import type { Platform } from '../src/toolchain/types.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const PROJECT = '0190aaaa-0000-7000-8000-000000000001';
const REPO_A = '0190aaaa-0000-7000-8000-0000000000a1';
const REPO_B = '0190aaaa-0000-7000-8000-0000000000b1';

function fixture(files: Record<string, string>): string {
  const root = tmp('aom-env-');
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

const MAUI = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
  <TargetFrameworks>net8.0-android;net8.0-ios</TargetFrameworks><UseMaui>true</UseMaui></PropertyGroup></Project>`;

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'not found', exitCode = 127): ExecResult => ({ exitCode, stdout: '', stderr });

/**
 * A pretend machine: which commands exist and what they answer. `installs` maps the install command line to the
 * tools it makes appear. Records every call, in order.
 */
class Machine implements Executor {
  calls: string[] = [];
  /** `cmd args` -> reply, consulted before anything else (mutated by installs). */
  answers = new Map<string, ExecResult>();
  installs = new Map<string, { effect: Record<string, ExecResult>; result?: ExecResult }>();
  managers: string[] = [];

  async run(cmd: string, args: string[]): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
    this.calls.push(line);
    const install = this.installs.get(line);
    if (install) {
      if (install.result && install.result.exitCode !== 0) return install.result;
      for (const [k, v] of Object.entries(install.effect)) this.answers.set(k, v);
      return install.result ?? ok('done');
    }
    if (args.length === 1 && args[0] === '--version' && this.managers.includes(cmd)) return ok(`${cmd} 1.0`);
    return this.answers.get(line) ?? fail();
  }
}

const access = (over: Partial<DevOpsAccess> = {}): DevOpsAccess => ({
  allowInstall: true,
  allowDocker: false,
  allowedPaths: [],
  sudo: true,
  ...over,
});

function setup(
  files: Record<string, string>,
  opts: {
    platform?: Platform;
    root?: Awaited<ReturnType<RootRunner['mode']>>['mode'];
    /** D6: run the dependency installs too (off in most tests: the pretend machine knows nothing of them). */
    dependencies?: boolean;
  } = {},
) {
  const m = new Machine();
  const rootCalls: string[] = [];
  const rootMode = opts.root ?? 'passwordless';
  const root: RootRunner = {
    mode: async () => ({ mode: rootMode, detail: rootMode }),
    run: async (cmd, args) => {
      rootCalls.push([cmd, ...args].join(' '));
      return m.run(cmd, args);
    },
  };
  const repoDir = fixture(files);
  const deps: EnsureDeps = {
    exec: m,
    platform: opts.platform ?? 'linux',
    root,
    findRepo: async () => ({ localPath: repoDir }),
    installDependencies: opts.dependencies ?? false,
  };
  const payload = (a: DevOpsAccess): EnvEnsurePayload => ({
    requestId: '0190aaaa-0000-7000-8000-00000000ffff',
    projectId: PROJECT,
    repos: [{ repoId: REPO_A, name: 'app', remoteUrlNormalized: 'github.com/acme/app' }],
    access: a,
  });
  return { m, rootCalls, deps, payload, repoDir };
}

/** The pretend Android SDK: the command-line tools appear after the script, then each package after its install. */
function androidSdkInstalls(m: Machine, api = '34', buildTools = '34.0.0') {
  const home = androidHome('linux');
  const sdkmanager = `${home}/cmdline-tools/latest/bin/sdkmanager`;
  const listed = (...names: string[]) =>
    ok(
      `Installed packages:\n  Path | Version\n  ---- | ----\n${names.map((n) => `  ${n} | 1 | x`).join('\n')}\n`,
    );
  m.installs.set(`bash -c ${cmdlineToolsScript('linux')}`, {
    effect: { [`${sdkmanager} --version`]: ok('12.0') },
  });
  const list = `${sdkmanager} --sdk_root=${home} --list_installed`;
  m.installs.set(`${sdkmanager} --sdk_root=${home} platform-tools`, {
    effect: { [list]: listed('platform-tools') },
  });
  m.installs.set(`${sdkmanager} --sdk_root=${home} platforms;android-${api}`, {
    effect: { [list]: listed('platform-tools', `platforms;android-${api}`) },
  });
  m.installs.set(`${sdkmanager} --sdk_root=${home} build-tools;${buildTools}`, {
    effect: { [list]: listed('platform-tools', `platforms;android-${api}`, `build-tools;${buildTools}`) },
  });
}

describe('env.ensure', () => {
  it('a machine that already has everything is ready and nothing is installed', async () => {
    const { m, deps, payload } = setup({ 'package.json': '{}', 'pnpm-lock.yaml': '', '.nvmrc': '20' });
    m.answers.set('node --version', ok('v22.1.0'));
    m.answers.set('pnpm --version', ok('9.12.0'));
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(r.tools.map((t) => [t.tool, t.status, t.version])).toEqual([
      ['Node.js', 'ok', '22.1.0'],
      ['pnpm', 'ok', '9.12.0'],
    ]);
    expect(r.summary).toContain('Ready: Node.js');
    expect(m.calls.some((c) => c.includes('install'))).toBe(false);
  });

  it('MAUI on a clean Linux box: SDK from apt as root, the maui-android workload and the JDK, then ready', async () => {
    const { m, rootCalls, deps, payload } = setup({ 'App.csproj': MAUI }, { root: 'passwordless' });
    m.managers = ['apt-get'];
    m.installs.set('apt-get install -y dotnet-sdk-8.0', { effect: { 'dotnet --version': ok('8.0.404') } });
    m.installs.set('dotnet workload install maui-android', {
      effect: { 'dotnet workload list': ok('Installed Workload Id\n------\nmaui-android   8.0.100\n') },
    });
    m.installs.set('apt-get install -y openjdk-17-jdk', {
      effect: { 'javac -version': ok('javac 17.0.12') },
    });
    androidSdkInstalls(m);
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(r.stacks).toEqual([{ id: 'dotnet-maui', name: '.NET MAUI', repo: 'app' }]);
    expect(r.tools.map((t) => [t.tool, t.status])).toEqual([
      ['.NET SDK', 'installed'],
      ['.NET workload maui-android', 'installed'],
      ['JDK', 'installed'],
      ['Android SDK command-line tools', 'installed'],
      ['Android platform-tools', 'installed'],
      ['Android SDK platform', 'installed'],
      ['Android build-tools', 'installed'],
    ]);
    // the apt installs ran as root, the workload did not
    expect(rootCalls).toEqual(['apt-get install -y dotnet-sdk-8.0', 'apt-get install -y openjdk-17-jdk']);
    expect(m.calls).toContain('dotnet workload install maui-android');
    expect(rootCalls).not.toContain('dotnet workload install maui-android');
    // order: SDK before the workload (the workload waits for it)
    expect(m.calls.indexOf('apt-get install -y dotnet-sdk-8.0')).toBeLessThan(
      m.calls.indexOf('dotnet workload install maui-android'),
    );
    expect(r.logTail.join('\n')).toContain('$ sudo apt-get install -y dotnet-sdk-8.0');
  });

  it('a workload is recognized by its whole id: maui-android does not satisfy maui', async () => {
    const { m, deps, payload } = setup({ 'App.csproj': MAUI }, { platform: 'darwin' });
    m.managers = ['brew'];
    m.answers.set('dotnet --version', ok('8.0.404'));
    m.answers.set('dotnet workload list', ok('Installed Workload Id\n-----\nmaui-android   8.0.100\n'));
    m.installs.set('dotnet workload install maui', { effect: {}, result: fail('boom', 1) });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(m.calls).toContain('dotnet workload install maui');
    expect(r.tools.find((t) => t.tool === '.NET workload maui')?.status).toBe('failed');
  });

  it('without "install" access nothing is installed and the report says what to tick', async () => {
    const { m, deps, payload } = setup({ 'go.mod': 'go 1.22\n' });
    m.managers = ['apt-get'];
    const r = await ensureEnvironment(payload(access({ allowInstall: false })), deps);
    expect(r.state).toBe('needs_access');
    expect(r.tools[0]).toMatchObject({ tool: 'Go', status: 'needs_access' });
    expect(r.tools[0]?.fix).toContain('Install packages and tools');
    expect(r.tools[0]?.fix).toContain('Install Go');
    expect(m.calls.filter((c) => c.startsWith('apt-get install'))).toEqual([]);
    expect(r.summary).toMatch(/^Needs access: Go/);
  });

  it('without sudo, a root-only installer is not tried; the user-level script is used when there is one', async () => {
    const { m, rootCalls, deps, payload } = setup(
      { 'global.json': '{"sdk":{"version":"8.0.100"}}' },
      { root: 'none' },
    );
    m.managers = ['apt-get'];
    const script = [
      'bash',
      '-c',
      'curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && bash /tmp/dotnet-install.sh --channel 8.0',
    ].join(' ');
    m.installs.set(script, { effect: { 'dotnet --version': ok('8.0.404') } });
    const r = await ensureEnvironment(payload(access({ sudo: false })), deps);
    expect(r.state).toBe('ready');
    expect(rootCalls).toEqual([]);
    expect(r.tools[0]?.detail).toContain('official installer');
  });

  it('a root-only tool without sudo needs access, and says sudo', async () => {
    const { m, rootCalls, deps, payload } = setup({ Gemfile: '' }, { root: 'none' });
    m.managers = ['apt-get'];
    const r = await ensureEnvironment(payload(access({ sudo: false })), deps);
    expect(r.state).toBe('needs_access');
    expect(r.tools[0]?.fix).toContain('Administrator (sudo)');
    expect(rootCalls).toEqual([]);
    // Bundler waits for Ruby
    expect(r.tools[1]).toMatchObject({ tool: 'Bundler', status: 'skipped', detail: 'waiting for Ruby' });
  });

  it('sudo ticked but not working says to enter the password', async () => {
    const { m, deps, payload } = setup({ Gemfile: '' }, { root: 'none' });
    m.managers = ['apt-get'];
    const r = await ensureEnvironment(payload(access({ sudo: true })), deps);
    expect(r.tools[0]?.fix).toContain('password');
  });

  it('an old version is upgraded: node 18 where .nvmrc says 22', async () => {
    const { m, rootCalls, deps, payload } = setup(
      { 'package.json': '{}', '.nvmrc': '22\n' },
      { root: 'root' },
    );
    m.managers = ['apt-get'];
    m.answers.set('node --version', ok('v18.19.0'));
    m.installs.set('apt-get install -y nodejs npm', { effect: { 'node --version': ok('v22.4.0') } });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(r.tools[0]).toMatchObject({ status: 'installed', version: '22.4.0' });
    // the machine is root: the install ran directly, not through sudo
    expect(rootCalls).toEqual([]);
  });

  it('a failed install is reported with the last error and the manual fix; dependants are skipped', async () => {
    const { m, deps, payload } = setup({ 'package.json': '{}', 'yarn.lock': '' }, { root: 'passwordless' });
    m.managers = ['apt-get'];
    m.installs.set('apt-get install -y nodejs npm', {
      effect: {},
      result: fail('E: Unable to locate package nodejs\nE: network is down', 100),
    });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('failed');
    expect(r.tools[0]).toMatchObject({ tool: 'Node.js', status: 'failed' });
    expect(r.tools[0]?.detail).toContain('network is down');
    expect(r.tools[0]?.fix).toContain('nodejs.org');
    expect(r.tools[1]).toMatchObject({ tool: 'Yarn', status: 'skipped' });
  });

  it('Docker needs the Docker right as well as install; a daemon that refuses the user is a rights problem', async () => {
    const { m, deps, payload } = setup({ Dockerfile: '' });
    m.managers = ['apt-get'];
    const a = await ensureEnvironment(payload(access({ allowDocker: false })), deps);
    expect(a.state).toBe('needs_access');
    expect(a.tools[0]?.fix).toContain('"Docker"');

    const b = setup({ Dockerfile: '' });
    b.m.answers.set('docker --version', ok('Docker version 27.1.1'));
    b.m.answers.set(
      'docker info --format {{.ServerVersion}}',
      fail('permission denied while trying to connect to the Docker daemon socket', 1),
    );
    const r = await ensureEnvironment(b.payload(access({ allowDocker: true })), b.deps);
    expect(r.state).toBe('failed');
    expect(r.tools[1]).toMatchObject({ tool: 'Docker daemon', status: 'failed' });
    expect(r.tools[1]?.fix).toContain('usermod -aG docker');
  });

  it('two repositories asking for different node majors: the higher one wins', async () => {
    const a = setup({ 'package.json': '{}', '.nvmrc': '18' });
    const other = fixture({ 'package.json': '{}', '.nvmrc': '22' });
    const dirs = [a.repoDir, other];
    let i = 0;
    a.deps.findRepo = async () => ({ localPath: dirs[i++ % 2] as string });
    a.m.answers.set('node --version', ok('v20.0.0'));
    const payload = a.payload(access({ allowInstall: false }));
    payload.repos.push({ repoId: REPO_B, name: 'web', remoteUrlNormalized: 'github.com/acme/web' });
    const r = await ensureEnvironment(payload, a.deps);
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]).toMatchObject({ status: 'needs_access' });
    expect(r.tools[0]?.detail).toContain('need 22');
  });

  it('a repository with no clone on the workstation is a failure with a fix', async () => {
    const { deps, payload } = setup({});
    deps.findRepo = async () => undefined;
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('failed');
    expect(r.tools[0]).toMatchObject({ stack: 'repository', status: 'failed' });
  });

  it('an unknown stack is ready with nothing to do', async () => {
    const { deps, payload } = setup({ 'README.md': 'hi' });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r).toMatchObject({ state: 'ready', stacks: [], tools: [] });
    expect(r.summary).toContain('no toolchain to prepare');
  });

  it('writes the full log to the log file', async () => {
    const { m, deps, payload } = setup({ 'go.mod': 'go 1.22\n' });
    m.answers.set('go version', ok('go version go1.23.1 linux/amd64'));
    const logFile = join(tmp('aom-envlog-'), 'logs', 'env', `${PROJECT}.log`);
    await ensureEnvironment(payload(access()), { ...deps, logFile });
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('Go: ok 1.23.1');
  });

  it('works for every supported platform without throwing (windows uses winget)', async () => {
    const { m, deps, payload } = setup(
      { 'go.mod': 'go 1.22\n' },
      { platform: 'win32', root: 'unsupported' as never },
    );
    m.managers = ['winget'];
    m.installs.set(
      'winget install --id GoLang.Go -e --silent --accept-package-agreements --accept-source-agreements',
      { effect: { 'go version': ok('go version go1.23.1 windows/amd64') } },
    );
    const r = await ensureEnvironment(payload(access({ sudo: false })), deps);
    expect(r.state).toBe('ready');
  });

  it('D6: a native Android project gets the SDK pieces it targets (compileSdk 35), within the install access', async () => {
    const files = {
      'build.gradle': "plugins { id 'com.android.application' }\nandroid { compileSdk 35 }\n",
      gradlew: '',
    };
    const denied = setup(files);
    denied.m.managers = ['apt-get'];
    denied.m.answers.set('javac -version', ok('javac 17.0.12'));
    const r0 = await ensureEnvironment(denied.payload(access({ allowInstall: false })), denied.deps);
    expect(r0.state).toBe('needs_access');
    expect(r0.tools.find((t) => t.tool === 'Android SDK command-line tools')?.status).toBe('needs_access');

    const { m, deps, payload } = setup(files);
    m.managers = ['apt-get'];
    m.answers.set('javac -version', ok('javac 17.0.12'));
    androidSdkInstalls(m, '35', '35.0.0');
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(r.stacks.map((s) => s.id)).toContain('android');
    expect(m.calls.some((c) => c.endsWith('platforms;android-35'))).toBe(true);
    expect(m.calls.some((c) => c.endsWith('build-tools;35.0.0'))).toBe(true);
  });

  it('D6: after the tools, the project dependencies are installed (pnpm install)', async () => {
    const { m, deps, payload } = setup(
      { 'package.json': '{}', 'pnpm-lock.yaml': '', '.nvmrc': '20' },
      { dependencies: true },
    );
    m.answers.set('node --version', ok('v22.1.0'));
    m.answers.set('pnpm --version', ok('9.12.0'));
    m.answers.set('pnpm install', ok('Done in 3s'));
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(r.tools.map((t) => [t.tool, t.status])).toContainEqual(['pnpm install', 'installed']);
    expect(r.logTail.join('\n')).toContain('pnpm install');
  });

  it('D6: a failing dependency install makes the environment failed, with the log tail and the command to run', async () => {
    const { m, deps, payload } = setup({ 'go.mod': 'module x\ngo 1.22\n' }, { dependencies: true });
    m.answers.set('go version', ok('go version go1.22.3 linux/amd64'));
    m.answers.set('go mod download', fail('dial tcp: lookup proxy.golang.org: no such host', 1));
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('failed');
    const t = r.tools.find((x) => x.tool === 'go mod download');
    expect(t?.status).toBe('failed');
    expect(t?.detail).toContain('no such host');
    expect(t?.fix).toContain('go mod download');
  });

  it('D6: dependencies are not installed without install access, and wait for a tool that is not fine', async () => {
    const off = setup({ 'go.mod': 'go 1.22\n' }, { dependencies: true });
    off.m.answers.set('go version', ok('go version go1.22.3 linux/amd64'));
    const r = await ensureEnvironment(off.payload(access({ allowInstall: false })), off.deps);
    expect(r.state).toBe('ready');
    expect(off.m.calls).not.toContain('go mod download');
    expect(r.tools.find((t) => t.tool === 'go mod download')?.status).toBe('skipped');

    const noTool = setup({ 'go.mod': 'go 1.22\n' }, { dependencies: true });
    noTool.m.managers = [];
    const r2 = await ensureEnvironment(noTool.payload(access()), noTool.deps);
    expect(noTool.m.calls).not.toContain('go mod download');
    expect(r2.tools.find((t) => t.tool === 'go mod download')).toBeUndefined();
  });

  it('D6: python installs into the project venv, never the system python', async () => {
    const { m, deps, payload } = setup(
      { 'requirements.txt': 'flask\n', 'pyproject.toml': '[project]\nname="x"\n' },
      { dependencies: true },
    );
    m.answers.set('python3 --version', ok('Python 3.12.1'));
    m.answers.set('python3 -m venv --help', ok('usage'));
    m.answers.set('python3 -m venv .venv', ok());
    m.answers.set('.venv/bin/pip install -r requirements.txt', ok());
    m.answers.set('.venv/bin/pip install -e .', ok());
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    const ran = m.calls.filter((c) => c.includes('pip install') || c.endsWith('-m venv .venv'));
    expect(ran).toEqual([
      'python3 -m venv .venv',
      '.venv/bin/pip install -r requirements.txt',
      '.venv/bin/pip install -e .',
    ]);
  });

  it('D6: .NET restores the solution at the root', async () => {
    const { m, deps, payload } = setup(
      {
        'App.sln': '',
        'src/Api/Api.csproj':
          '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
      },
      { dependencies: true },
    );
    m.answers.set('dotnet --version', ok('8.0.404'));
    m.answers.set('dotnet restore App.sln', ok());
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(m.calls).toContain('dotnet restore App.sln');
  });
});
