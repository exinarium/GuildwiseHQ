import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DevOpsAccess, EnvEnsurePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { type EnsureDeps, ensureEnvironment, SYSTEM_DEPENDENCY } from '../src/toolchain/ensure.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { androidHome } from '../src/toolchain/stacks.ts';
import type { Platform } from '../src/toolchain/types.ts';
import {
  toolchainsRoot,
  type UserInstaller,
  type UserInstallResolver,
  type UserInstallResult,
} from '../src/toolchain/user-install.ts';
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
  /** The working folder of each call, by command line. */
  cwds = new Map<string, string | undefined>();
  /** `cmd args` -> reply, consulted before anything else (mutated by installs). */
  answers = new Map<string, ExecResult>();
  installs = new Map<string, { effect: Record<string, ExecResult>; result?: ExecResult }>();
  managers: string[] = [];

  async run(cmd: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
    this.calls.push(line);
    this.cwds.set(line, opts?.cwd);
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

/**
 * A pretend user-space installer (the real one is tested in user-install.test.ts): records which tool it was asked
 * for and makes the tool appear on the pretend machine.
 */
class FakeInstaller implements UserInstaller {
  calls: string[] = [];
  resolvers = new Map<string, UserInstallResolver>();
  effects = new Map<string, { answers: Record<string, ExecResult>; result?: UserInstallResult }>();
  constructor(private readonly m: Machine) {}
  async install(toolId: string, resolver: UserInstallResolver): Promise<UserInstallResult | null> {
    this.calls.push(toolId);
    this.resolvers.set(toolId, resolver);
    const e = this.effects.get(toolId);
    if (!e) return { ok: false, detail: `no fixture for ${toolId}` };
    if (e.result && !e.result.ok) return e.result;
    for (const [k, v] of Object.entries(e.answers)) this.m.answers.set(k, v);
    return e.result ?? { ok: true, detail: 'installed' };
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
    /** D6: run the dependency installs too (off in most tests: the pretend machine knows nothing of them). */
    dependencies?: boolean;
  } = {},
) {
  const m = new Machine();
  const installer = new FakeInstaller(m);
  const repoDir = fixture(files);
  const deps: EnsureDeps = {
    exec: m,
    platform: opts.platform ?? 'linux',
    userInstaller: installer,
    findRepo: async () => ({ localPath: repoDir }),
    installDependencies: opts.dependencies ?? false,
    // the repository's owner allowed its install scripts locally (R18-S): the installs run as written
    installScriptsAllowed: () => true,
  };
  const payload = (a: DevOpsAccess): EnvEnsurePayload => ({
    requestId: '0190aaaa-0000-7000-8000-00000000ffff',
    projectId: PROJECT,
    repos: [{ repoId: REPO_A, name: 'app', remoteUrlNormalized: 'github.com/acme/app' }],
    access: a,
  });
  return { m, installer, deps, payload, repoDir };
}

/** The pretend Android SDK: the command-line tools appear after the user install, then each package after its install. */
function androidSdkInstalls(m: Machine, installer: FakeInstaller, api = '34', buildTools = '34.0.0') {
  const home = androidHome('linux');
  const sdkmanager = `${home}/cmdline-tools/latest/bin/sdkmanager`;
  const listed = (...names: string[]) =>
    ok(
      `Installed packages:\n  Path | Version\n  ---- | ----\n${names.map((n) => `  ${n} | 1 | x`).join('\n')}\n`,
    );
  installer.effects.set('android-cmdline-tools', { answers: { [`${sdkmanager} --version`]: ok('12.0') } });
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

  it('MAUI on a clean Linux box: SDK and JDK in user space, the maui-android workload, then ready; nothing as root', async () => {
    const { m, installer, deps, payload } = setup({ 'App.csproj': MAUI });
    m.managers = ['apt-get'];
    installer.effects.set('dotnet-sdk', { answers: { 'dotnet --version': ok('8.0.404') } });
    m.installs.set('dotnet workload install maui-android', {
      effect: { 'dotnet workload list': ok('Installed Workload Id\n------\nmaui-android   8.0.100\n') },
    });
    installer.effects.set('jdk', { answers: { 'javac -version': ok('javac 17.0.12') } });
    androidSdkInstalls(m, installer);
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
    expect(installer.calls).toEqual(['dotnet-sdk', 'jdk', 'android-cmdline-tools']);
    expect(r.tools[0]?.detail).toContain('checksum-verified');
    // the package manager was only asked for its version: no install, no sudo, ever
    expect(m.calls.filter((c) => c.startsWith('apt-get') && c !== 'apt-get --version')).toEqual([]);
    expect(m.calls.some((c) => c.startsWith('sudo'))).toBe(false);
    expect(r.logTail.join('\n')).not.toContain('sudo');
    expect(m.calls).toContain('dotnet workload install maui-android');
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

  it("Ruby is a system dependency: failed with the owner's command, which is never run; Bundler waits", async () => {
    const { m, installer, deps, payload } = setup({ Gemfile: '' });
    m.managers = ['apt-get'];
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('failed');
    expect(r.tools[0]).toMatchObject({ tool: 'Ruby', status: 'failed', detail: SYSTEM_DEPENDENCY });
    expect(r.tools[0]?.fix).toContain('Ask the machine owner to run: sudo apt-get install -y ruby-full');
    expect(m.calls.some((c) => c.includes('install'))).toBe(false);
    expect(installer.calls).toEqual([]);
    expect(r.tools[1]).toMatchObject({ tool: 'Bundler', status: 'skipped', detail: 'waiting for Ruby' });
  });

  it('a system dependency on a machine without a known package manager says what to install', async () => {
    const { deps, payload } = setup({ 'composer.json': '{}' });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.tools[0]).toMatchObject({ tool: 'PHP', status: 'failed', detail: SYSTEM_DEPENDENCY });
    expect(r.tools[0]?.fix).toContain('php.net');
    expect(r.tools[0]?.fix).toContain('Guildwise does not install system packages');
  });

  it('no step runs as root: user-space installs and `any` steps only (pnpm into the toolchains folder)', async () => {
    const { m, installer, deps, payload } = setup({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    m.managers = ['apt-get'];
    m.answers.set('node --version', ok('v22.1.0'));
    m.installs.set(`npm install -g --prefix ${toolchainsRoot()} pnpm`, {
      effect: { 'pnpm --version': ok('9.12.0') },
    });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(installer.calls).toEqual([]);
    // package managers are only probed (`--version`) to name an owner's command; none runs
    const managerRuns = m.calls.filter(
      (c) => /^(sudo|apt-get|dnf|yum|pacman|zypper|apk|choco)\b/.test(c) && !c.endsWith(' --version'),
    );
    expect(managerRuns).toEqual([]);
  });

  it('an old version is upgraded: node 18 where .nvmrc says 22', async () => {
    const { m, installer, deps, payload } = setup({ 'package.json': '{}', '.nvmrc': '22\n' });
    m.managers = ['apt-get'];
    m.answers.set('node --version', ok('v18.19.0'));
    installer.effects.set('node', { answers: { 'node --version': ok('v22.4.0') } });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('ready');
    expect(r.tools[0]).toMatchObject({ status: 'installed', version: '22.4.0' });
    expect(installer.calls).toEqual(['node']);
    expect(m.calls.some((c) => c.startsWith('apt-get install'))).toBe(false);
  });

  it('a failed install is reported with the last error and the manual fix; dependants are skipped', async () => {
    const { installer, deps, payload } = setup({ 'package.json': '{}', 'yarn.lock': '' });
    installer.effects.set('node', {
      answers: {},
      result: { ok: false, detail: 'checksum mismatch: refused (https://nodejs.org/dist/v22.4.0/x.tar.xz)' },
    });
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.state).toBe('failed');
    expect(r.tools[0]).toMatchObject({ tool: 'Node.js', status: 'failed' });
    expect(r.tools[0]?.detail).toContain('checksum mismatch: refused');
    expect(r.tools[0]?.fix).toContain('nodejs.org');
    expect(r.tools[1]).toMatchObject({ tool: 'Yarn', status: 'skipped' });
  });

  it("Docker is the installer's job: a missing Docker or a daemon that refuses the user says re-run the installer", async () => {
    const { m, deps, payload } = setup({ Dockerfile: '' });
    m.managers = ['apt-get'];
    const a = await ensureEnvironment(payload(access({ allowDocker: true })), deps);
    expect(a.state).toBe('failed');
    expect(a.tools[0]).toMatchObject({ tool: 'Docker', status: 'failed', detail: SYSTEM_DEPENDENCY });
    expect(a.tools[0]?.fix).toContain('set up by the installer: re-run it');
    expect(a.tools[0]?.fix).not.toContain('usermod');
    expect(m.calls.some((c) => c.includes('install'))).toBe(false);

    const b = setup({ Dockerfile: '' });
    b.m.answers.set('docker --version', ok('Docker version 27.1.1'));
    b.m.answers.set(
      'docker info --format {{.ServerVersion}}',
      fail('permission denied while trying to connect to the Docker daemon socket', 1),
    );
    const r = await ensureEnvironment(b.payload(access({ allowDocker: true })), b.deps);
    expect(r.state).toBe('failed');
    expect(r.tools[1]).toMatchObject({ tool: 'Docker daemon', status: 'failed' });
    expect(r.tools[1]?.fix).toContain('set up by the installer: re-run it');
    expect(r.tools[1]?.fix).not.toContain('usermod');
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

  it('Windows (not yet tested on hardware): no user-space install, the winget command is advice only', async () => {
    const { m, deps, payload } = setup({ 'go.mod': 'go 1.22\n' }, { platform: 'win32' });
    m.managers = ['winget'];
    // the fake installer answers like the real one does on win32: no plan
    deps.userInstaller = { install: async () => null };
    const r = await ensureEnvironment(payload(access()), deps);
    expect(r.tools[0]).toMatchObject({ tool: 'Go', status: 'failed', detail: SYSTEM_DEPENDENCY });
    expect(r.tools[0]?.fix).toContain('winget install --id GoLang.Go');
    expect(r.tools[0]?.fix).not.toContain('sudo');
    expect(m.calls.some((c) => c.startsWith('winget install'))).toBe(false);
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

    const { m, installer, deps, payload } = setup(files);
    m.managers = ['apt-get'];
    m.answers.set('javac -version', ok('javac 17.0.12'));
    androidSdkInstalls(m, installer, '35', '35.0.0');
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

describe('env.ensure: project path (the project lives in a sub directory)', () => {
  const withPath = (p: EnvEnsurePayload, projectPath: string | undefined): EnvEnsurePayload => ({
    ...p,
    repos: p.repos.map((r) => ({ ...r, ...(projectPath !== undefined ? { projectPath } : {}) })),
  });

  it('a Node app in web/ is detected from the sub directory and installed there', async () => {
    const { m, deps, payload, repoDir } = setup(
      { 'README.md': 'monorepo', 'web/package.json': '{}', 'web/pnpm-lock.yaml': '', 'web/.nvmrc': '20' },
      { dependencies: true },
    );
    m.answers.set('node --version', ok('v22.1.0'));
    m.answers.set('pnpm --version', ok('9.12.0'));
    m.answers.set('pnpm install', ok('Done'));
    // from the root nothing is detected
    const root = await ensureEnvironment(payload(access()), deps);
    expect(root.stacks).toEqual([]);
    m.calls.length = 0;
    const r = await ensureEnvironment(withPath(payload(access()), 'web'), deps);
    expect(r.state).toBe('ready');
    expect(r.stacks.map((s) => s.id)).toEqual(['node']);
    expect(m.cwds.get('pnpm install')).toBe(join(repoDir, 'web'));
  });

  it('a .NET project in src/app is restored by its own file, from that folder', async () => {
    const { m, deps, payload, repoDir } = setup(
      {
        'README.md': '',
        'src/app/App.csproj':
          '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
      },
      { dependencies: true },
    );
    m.answers.set('dotnet --version', ok('8.0.404'));
    m.answers.set('dotnet restore App.csproj', ok());
    const r = await ensureEnvironment(withPath(payload(access()), './src/app/'), deps);
    expect(r.state).toBe('ready');
    expect(m.calls).toContain('dotnet restore App.csproj');
    expect(m.cwds.get('dotnet restore App.csproj')).toBe(join(repoDir, 'src', 'app'));
  });

  it('a project path that is not in the clone is a clear failure, not a silent "no stack"', async () => {
    const { deps, payload } = setup({ 'package.json': '{}' });
    const r = await ensureEnvironment(withPath(payload(access()), 'nope/here'), deps);
    expect(r.state).toBe('failed');
    expect(r.tools[0]?.detail).toContain('does not exist');
  });

  it('a path that climbs out of the repository is refused', async () => {
    const { m, deps, payload } = setup({ 'package.json': '{}' });
    const r = await ensureEnvironment(withPath(payload(access()), '../outside'), deps);
    expect(r.state).toBe('failed');
    expect(r.tools[0]?.detail).toContain('not a relative sub directory');
    expect(m.calls.filter((c) => !c.endsWith('--version'))).toEqual([]);
  });
});

describe('quiet-approvals [D3]: a tools-only run (the local toolInstall tick)', () => {
  it('a checksum-verified download runs; a tool without one is not run and is deferred for a local yes', async () => {
    const { m, installer, deps, payload } = setup({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      '.nvmrc': '22',
    });
    m.answers.set('node --version', ok('v18.19.0'));
    installer.effects.set('node', { answers: { 'node --version': ok('v22.4.0') } });
    m.installs.set(`npm install -g --prefix ${toolchainsRoot()} pnpm`, {
      effect: { 'pnpm --version': ok('9.12.0') },
    });
    const r = await ensureEnvironment(payload(access()), { ...deps, toolsOnly: true });
    expect(installer.calls).toEqual(['node']);
    expect(r.tools.find((t) => t.tool.toLowerCase().includes('node'))?.status).toBe('installed');
    // pnpm comes from an npm step (no published checksum): never run in a tools-only run
    expect(m.calls.some((c) => c.startsWith('npm install -g'))).toBe(false);
    expect(r.deferred?.some((d) => /pnpm/i.test(d))).toBe(true);
  });

  it('dependency steps never run in a tools-only run; each is listed for the local yes', async () => {
    const { m, deps, payload } = setup(
      { 'package.json': '{}', 'pnpm-lock.yaml': '', '.nvmrc': '20' },
      { dependencies: true },
    );
    m.answers.set('node --version', ok('v22.1.0'));
    m.answers.set('pnpm --version', ok('9.12.0'));
    m.answers.set('pnpm install', ok('Done in 3s'));
    const r = await ensureEnvironment(payload(access()), { ...deps, toolsOnly: true });
    expect(m.calls).not.toContain('pnpm install');
    expect(r.deferred).toContain('pnpm install');
  });

  it('a project with nothing to download needs no local yes (nothing deferred)', async () => {
    const { m, deps, payload } = setup({ 'package.json': '{}', '.nvmrc': '22' });
    m.answers.set('node --version', ok('v22.1.0'));
    const r = await ensureEnvironment(payload(access()), { ...deps, toolsOnly: true });
    expect(r.state).toBe('ready');
    expect(r.deferred).toBeUndefined();
  });

  it('`onlyTools` prepares only the named tool (aom toolchain ensure in the box)', async () => {
    const { m, installer, deps, payload } = setup({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      '.nvmrc': '22',
    });
    m.answers.set('node --version', ok('v18.19.0'));
    installer.effects.set('node', { answers: { 'node --version': ok('v22.4.0') } });
    const r = await ensureEnvironment(payload(access()), {
      ...deps,
      toolsOnly: true,
      onlyTools: ['node'],
      installDependencies: false,
    });
    expect(installer.calls).toEqual(['node']);
    expect(r.tools.map((t) => t.status)).toEqual(['installed']);
  });
});
