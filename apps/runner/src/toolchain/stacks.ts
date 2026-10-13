import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Check,
  DepStep,
  Detection,
  Manager,
  Params,
  Platform,
  RepoView,
  StackSpec,
  Step,
  ToolSpec,
} from './types.ts';

// ------------------------------------------------------------------------------------------------ helpers

const findFiles = (repo: RepoView, re: RegExp): string[] => repo.files.filter((f) => re.test(f));
const basename = (f: string): string => f.slice(f.lastIndexOf('/') + 1);
const rootFile = (repo: RepoView, name: string): boolean => repo.files.includes(name);
const readAll = (repo: RepoView, files: string[]): string =>
  files
    .slice(0, 40)
    .map((f) => repo.read(f) ?? '')
    .join('\n');

/** `8` from `net8.0`, `net8.0-android`, `netcoreapp3.1` (3), `net48` (none: .NET Framework). */
function majorOfTfm(tfm: string): number | undefined {
  const m = /^net(?:coreapp)?(\d+)\.(\d+)/i.exec(tfm.trim());
  return m?.[1] ? Number(m[1]) : undefined;
}

function dotnetTargets(repo: RepoView): { tfms: string[]; projects: string[]; text: string } {
  const projects = findFiles(repo, /\.(cs|fs|vb)proj$/i);
  const props = findFiles(repo, /(^|\/)Directory\.Build\.(props|targets)$/i);
  const text = readAll(repo, [...projects, ...props]);
  const tfms: string[] = [];
  for (const m of text.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/gi))
    for (const t of (m[1] ?? '').split(';')) if (t.trim() && !t.includes('$(')) tfms.push(t.trim());
  return { tfms, projects, text };
}

/** The SDK major: `global.json` first, else the highest target framework of the projects. */
function dotnetSdkMajor(repo: RepoView, tfms: string[]): string | undefined {
  for (const g of findFiles(repo, /(^|\/)global\.json$/i)) {
    try {
      const v = (JSON.parse(repo.read(g) ?? '{}') as { sdk?: { version?: string } }).sdk?.version;
      const m = v ? /^(\d+)\./.exec(v) : null;
      if (m?.[1]) return m[1];
    } catch {
      // a broken global.json is the repository's problem; fall through to the target frameworks
    }
  }
  const majors = tfms.map(majorOfTfm).filter((n): n is number => n !== undefined);
  return majors.length ? String(Math.max(...majors)) : undefined;
}

/** Exact `global.json` SDK version and roll-forward policy (the first global.json), and the target framework majors. */
function dotnetNeedParams(repo: RepoView, tfms: string[]): Params {
  const out: Params = {};
  for (const g of findFiles(repo, /(^|\/)global\.json$/i)) {
    try {
      const sdk = (JSON.parse(repo.read(g) ?? '{}') as { sdk?: { version?: string; rollForward?: string } })
        .sdk;
      if (sdk?.version && /^\d+\.\d+\.\d+/.test(sdk.version)) {
        out.globalVersion = sdk.version;
        if (sdk.rollForward) out.rollForward = sdk.rollForward;
        break;
      }
    } catch {
      // a broken global.json is the repository's problem
    }
  }
  const majors = [...new Set(tfms.map(majorOfTfm).filter((n): n is number => n !== undefined))].sort(
    (a, b) => a - b,
  );
  if (majors.length) out.tfmMajors = majors.join(',');
  return out;
}

/** What `dotnet restore` is pointed at: the solution at the root, else the single root project, else the first project. */
function dotnetRestoreTarget(repo: RepoView): string | undefined {
  const root = (re: RegExp) => repo.files.filter((f) => !f.includes('/') && re.test(f));
  return (
    root(/\.slnx?$/i)[0] ??
    root(/\.(cs|fs|vb)proj$/i)[0] ??
    findFiles(repo, /\.slnx?$/i)[0] ??
    findFiles(repo, /\.(cs|fs|vb)proj$/i)[0]
  );
}

const dotnetDeps = (d: Detection): DepStep[] => [
  {
    name: 'dotnet restore',
    cmd: 'dotnet',
    args: ['restore', ...(d.params.restore ? [d.params.restore] : [])],
    after: ['dotnet-sdk'],
  },
];

/** The Android API level a `net8.0-android` / `net8.0-android34.0` target framework asks for. */
function androidApiOfTfm(tfm: string): string | undefined {
  const explicit = /-android(\d+)(?:\.\d+)?$/i.exec(tfm)?.[1];
  if (explicit) return explicit;
  if (!/-android$/i.test(tfm)) return undefined;
  const major = majorOfTfm(tfm);
  // The default Android API level of each .NET release.
  return major === 8 ? '34' : major === 9 ? '35' : major && major >= 10 ? '36' : undefined;
}

// ------------------------------------------------------------------------------------------------ stacks

const dotnet: StackSpec = {
  id: 'dotnet',
  name: '.NET',
  detect: (repo) => {
    const { tfms, projects } = dotnetTargets(repo);
    const global = findFiles(repo, /(^|\/)global\.json$/i);
    const slns = findFiles(repo, /\.slnx?$/i);
    if (!projects.length && !global.length && !slns.length) return null;
    const sdk = dotnetSdkMajor(repo, tfms);
    const restore = dotnetRestoreTarget(repo);
    return {
      id: 'dotnet',
      name: '.NET',
      evidence: projects[0] ?? global[0] ?? (slns[0] as string),
      params: {
        ...(sdk ? { sdkMajor: sdk } : {}),
        ...(restore ? { restore } : {}),
        ...dotnetNeedParams(repo, tfms),
      },
    };
  },
  tools: () => ['dotnet-sdk'],
  deps: (d) => dotnetDeps(d),
};

/** MAUI: `<UseMaui>`, a Microsoft.Maui package, or a MAUI platform target framework. */
const dotnetMaui: StackSpec = {
  id: 'dotnet-maui',
  name: '.NET MAUI',
  detect: (repo) => {
    const { tfms, projects, text } = dotnetTargets(repo);
    if (!projects.length) return null;
    const useMaui = /<UseMaui>\s*true\s*<\/UseMaui>/i.test(text) || /Include="Microsoft\.Maui\./i.test(text);
    const platformTfm = tfms.some((t) => /-(android|ios|maccatalyst|tizen|windows10)/i.test(t));
    if (!useMaui && !(platformTfm && /maui/i.test(text))) return null;
    const has = (re: RegExp) => tfms.some((t) => re.test(t));
    const sdk = dotnetSdkMajor(repo, tfms);
    const restore = dotnetRestoreTarget(repo);
    const api = tfms.map(androidApiOfTfm).find((a) => a !== undefined);
    return {
      id: 'dotnet-maui',
      name: '.NET MAUI',
      evidence: projects.find((p) => /UseMaui/i.test(repo.read(p) ?? '')) ?? (projects[0] as string),
      params: {
        ...(sdk ? { sdkMajor: sdk } : {}),
        ...dotnetNeedParams(repo, tfms),
        ...(restore ? { restore } : {}),
        ...(api ? { androidApi: api } : {}),
        // Which platform workloads the target frameworks ask for; `tfms` lists nothing when they come from a property.
        ...(has(/-android/i) || tfms.length === 0 ? { android: '1' } : {}),
        ...(has(/-ios/i) ? { ios: '1' } : {}),
        ...(has(/-maccatalyst/i) ? { maccatalyst: '1' } : {}),
        ...(has(/-windows10/i) ? { windows: '1' } : {}),
      },
    };
  },
  tools: (d, platform) => [
    'dotnet-sdk',
    // The `maui` workload does not exist on Linux (only Android can be built there): `maui-android`.
    platform === 'linux' ? 'dotnet-workload-maui-android' : 'dotnet-workload-maui',
    ...(d.params.android && platform !== 'linux' ? ['dotnet-workload-android'] : []),
    ...(d.params.ios && platform === 'darwin' ? ['dotnet-workload-ios'] : []),
    ...(d.params.maccatalyst && platform === 'darwin' ? ['dotnet-workload-maccatalyst'] : []),
    ...(d.params.android ? ['jdk', ...ANDROID_SDK_TOOLS] : []),
  ],
  deps: (d) => dotnetDeps(d),
};

/** Tool ids of the Android SDK pieces (D6), in install order. */
const ANDROID_SDK_TOOLS = [
  'android-cmdline-tools',
  'android-platform-tools',
  'android-platform',
  'android-build-tools',
];

/** A native Android project (Gradle with the Android plugin, or an AndroidManifest). */
const android: StackSpec = {
  id: 'android',
  name: 'Android',
  detect: (repo) => {
    const manifest = findFiles(repo, /(^|\/)AndroidManifest\.xml$/i)[0];
    const gradleFiles = findFiles(repo, /(^|\/)build\.gradle(\.kts)?$/i);
    const text = readAll(repo, gradleFiles);
    const isAndroid = /com\.android\.(application|library)|id\(["']com\.android/.test(text);
    if (!isAndroid && !(manifest && gradleFiles.length)) return null;
    const api = /compileSdk(?:Version)?\s*(?:=\s*)?(\d+)/.exec(text)?.[1];
    const bt = /buildToolsVersion\s*(?:=\s*)?["']([\d.]+)["']/.exec(text)?.[1];
    return {
      id: 'android',
      name: 'Android',
      evidence: gradleFiles[0] ?? (manifest as string),
      params: { ...(api ? { androidApi: api } : {}), ...(bt ? { buildTools: bt } : {}) },
    };
  },
  tools: () => ['jdk', ...ANDROID_SDK_TOOLS],
};

const NODE_LOCKS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

const node: StackSpec = {
  id: 'node',
  name: 'Node.js',
  detect: (repo) => {
    if (!rootFile(repo, 'package.json')) return null;
    const params: Params = {};
    let pkg: { packageManager?: string; engines?: { node?: string } } = {};
    try {
      pkg = JSON.parse(repo.read('package.json') ?? '{}');
    } catch {
      // unreadable package.json: still a Node project
    }
    const pm =
      /^(pnpm|yarn|npm|bun)@/.exec(pkg.packageManager ?? '')?.[1] ??
      NODE_LOCKS.find(([f]) => rootFile(repo, f))?.[1];
    params.pm = pm ?? 'npm';
    const pinned = /^(?:pnpm|yarn)@(\d+(?:\.\d+)*)/.exec(pkg.packageManager ?? '')?.[1];
    if (pinned) params.pmVersion = pinned;
    const nvmrc = (repo.read('.nvmrc') ?? repo.read('.node-version') ?? '').trim();
    const toolVersions = /^nodejs\s+(\d+)/m.exec(repo.read('.tool-versions') ?? '')?.[1];
    const fromNvm = /^v?(\d+)/.exec(nvmrc)?.[1];
    const fromEngines = /(\d+)/.exec(pkg.engines?.node ?? '')?.[1];
    const major = fromNvm ?? toolVersions ?? fromEngines;
    if (major) params.nodeMajor = major;
    return { id: 'node', name: 'Node.js', evidence: 'package.json', params };
  },
  tools: (d) => ['node', ...(d.params.pm === 'npm' ? [] : [`node-${d.params.pm}`])],
  deps: (d) => {
    const pm = d.params.pm ?? 'npm';
    return [
      {
        name: `${pm} install`,
        cmd: pm,
        args: ['install'],
        after: ['node', ...(pm === 'npm' ? [] : [`node-${pm}`])],
      },
    ];
  },
};

const python: StackSpec = {
  id: 'python',
  name: 'Python',
  detect: (repo) => {
    const marker =
      ['pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg', 'poetry.lock', 'uv.lock'].find((f) =>
        rootFile(repo, f),
      ) ?? findFiles(repo, /(^|\/)requirements[^/]*\.txt$/i)[0];
    if (!marker) return null;
    const py = repo.read('pyproject.toml') ?? '';
    const params: Params = {};
    if (rootFile(repo, 'uv.lock') || /\[tool\.uv\]/.test(py)) params.manager = 'uv';
    else if (rootFile(repo, 'poetry.lock') || /\[tool\.poetry\]/.test(py)) params.manager = 'poetry';
    else if (rootFile(repo, 'Pipfile')) params.manager = 'pipenv';
    const req = /requires-python\s*=\s*"[^"\d]*(\d+\.\d+)/.exec(py)?.[1];
    const pv = /^(?:python-)?(\d+\.\d+)/m.exec(repo.read('.python-version') ?? '')?.[1];
    const v = pv ?? req;
    if (v) params.pythonVersion = v;
    const reqFile = findFiles(repo, /^requirements[^/]*\.txt$/i).sort((a, b) => a.length - b.length)[0];
    if (reqFile) params.requirements = reqFile;
    if (rootFile(repo, 'pyproject.toml') || rootFile(repo, 'setup.py')) params.installable = '1';
    return { id: 'python', name: 'Python', evidence: marker, params };
  },
  tools: (d) => ['python', 'python-venv', ...(d.params.manager ? [`python-${d.params.manager}`] : [])],
  deps: (d, platform) => {
    const m = d.params.manager;
    if (m === 'uv') return [{ name: 'uv sync', cmd: 'uv', args: ['sync'], after: ['python-uv'] }];
    if (m === 'poetry')
      return [{ name: 'poetry install', cmd: 'poetry', args: ['install'], after: ['python-poetry'] }];
    if (m === 'pipenv')
      return [
        { name: 'pipenv install', cmd: 'pipenv', args: ['install', '--dev'], after: ['python-pipenv'] },
      ];
    // Plain pip: into the project's own virtual environment, never into the system Python.
    const py = platform === 'win32' ? 'python' : 'python3';
    const venvPip = platform === 'win32' ? '.venv\\Scripts\\pip.exe' : '.venv/bin/pip';
    const steps: DepStep[] = [];
    if (!d.params.requirements && !d.params.installable) return steps;
    steps.push({
      name: 'create .venv',
      cmd: py,
      args: ['-m', 'venv', '.venv'],
      after: ['python', 'python-venv'],
    });
    if (d.params.requirements)
      steps.push({
        name: `pip install -r ${d.params.requirements}`,
        cmd: venvPip,
        args: ['install', '-r', d.params.requirements],
        after: ['python'],
      });
    if (d.params.installable)
      steps.push({ name: 'pip install -e .', cmd: venvPip, args: ['install', '-e', '.'], after: ['python'] });
    return steps;
  },
};

const docker: StackSpec = {
  id: 'docker',
  name: 'Docker',
  detect: (repo) => {
    const f = findFiles(
      repo,
      /(^|\/)(Dockerfile(\.(?!md$|txt$)[\w-]+)?|docker-compose(\.[\w.-]+)?\.ya?ml|compose(\.[\w.-]+)?\.ya?ml)$/i,
    )[0];
    return f ? { id: 'docker', name: 'Docker', evidence: f, params: {} } : null;
  },
  tools: () => ['docker', 'docker-daemon'],
};

const go: StackSpec = {
  id: 'go',
  name: 'Go',
  detect: (repo) => {
    if (!rootFile(repo, 'go.mod')) return null;
    const v = /^go\s+(\d+\.\d+)/m.exec(repo.read('go.mod') ?? '')?.[1];
    return { id: 'go', name: 'Go', evidence: 'go.mod', params: v ? { goVersion: v } : {} };
  },
  tools: () => ['go'],
  deps: () => [{ name: 'go mod download', cmd: 'go', args: ['mod', 'download'], after: ['go'] }],
};

const rust: StackSpec = {
  id: 'rust',
  name: 'Rust',
  detect: (repo) =>
    rootFile(repo, 'Cargo.toml') ? { id: 'rust', name: 'Rust', evidence: 'Cargo.toml', params: {} } : null,
  tools: () => ['rust'],
  deps: () => [{ name: 'cargo fetch', cmd: 'cargo', args: ['fetch'], after: ['rust'] }],
};

function javaMajor(text: string): string | undefined {
  const m =
    /<(?:maven\.compiler\.(?:release|source|target)|java\.version)>\s*(?:1\.)?(\d+)\s*</.exec(text) ??
    /JavaVersion\.VERSION_(?:1_)?(\d+)/.exec(text) ??
    /(?:sourceCompatibility|jvmTarget|languageVersion)[^\d\n]*(?:1\.)?(\d+)/.exec(text);
  return m?.[1];
}

const maven: StackSpec = {
  id: 'maven',
  name: 'Java (Maven)',
  detect: (repo) => {
    if (!rootFile(repo, 'pom.xml')) return null;
    const j = javaMajor(repo.read('pom.xml') ?? '');
    return {
      id: 'maven',
      name: 'Java (Maven)',
      evidence: 'pom.xml',
      params: { ...(j ? { javaMajor: j } : {}), ...(rootFile(repo, 'mvnw') ? { wrapper: '1' } : {}) },
    };
  },
  tools: (d) => ['jdk', ...(d.params.wrapper ? [] : ['maven'])],
  deps: (d, platform) => [
    d.params.wrapper
      ? {
          name: 'mvnw dependency:resolve',
          cmd: platform === 'win32' ? 'mvnw.cmd' : './mvnw',
          args: ['-B', '-q', 'dependency:resolve'],
          after: ['jdk'],
        }
      : {
          name: 'mvn dependency:resolve',
          cmd: 'mvn',
          args: ['-B', '-q', 'dependency:resolve'],
          after: ['maven'],
        },
  ],
};

const gradle: StackSpec = {
  id: 'gradle',
  name: 'Java (Gradle)',
  detect: (repo) => {
    const f = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].find((n) =>
      rootFile(repo, n),
    );
    if (!f) return null;
    const j = javaMajor(`${repo.read('build.gradle') ?? ''}\n${repo.read('build.gradle.kts') ?? ''}`);
    return {
      id: 'gradle',
      name: 'Java (Gradle)',
      evidence: f,
      params: { ...(j ? { javaMajor: j } : {}), ...(rootFile(repo, 'gradlew') ? { wrapper: '1' } : {}) },
    };
  },
  tools: (d) => ['jdk', ...(d.params.wrapper ? [] : ['gradle'])],
};

const ruby: StackSpec = {
  id: 'ruby',
  name: 'Ruby',
  detect: (repo) =>
    rootFile(repo, 'Gemfile') ? { id: 'ruby', name: 'Ruby', evidence: 'Gemfile', params: {} } : null,
  tools: () => ['ruby', 'bundler'],
  deps: () => [{ name: 'bundle install', cmd: 'bundle', args: ['install'], after: ['bundler'] }],
};

const php: StackSpec = {
  id: 'php',
  name: 'PHP',
  detect: (repo) =>
    rootFile(repo, 'composer.json')
      ? { id: 'php', name: 'PHP', evidence: 'composer.json', params: {} }
      : null,
  tools: () => ['php', 'composer'],
  deps: () => [{ name: 'composer install', cmd: 'composer', args: ['install'], after: ['composer'] }],
};

/** The stacks the DevOps engineer recognizes. Order = order of the report. Add a stack by adding an object. */
export const STACKS: StackSpec[] = [
  dotnetMaui,
  dotnet,
  android,
  node,
  python,
  docker,
  go,
  rust,
  maven,
  gradle,
  ruby,
  php,
];

// ------------------------------------------------------------------------------------------------- tools

const one = (cmd: string, args: string[], version?: RegExp, contains?: string): Check => ({
  cmd,
  args,
  ...(version ? { version } : {}),
  ...(contains ? { contains } : {}),
});
const VER = /(\d+(?:\.\d+){0,3})/;
const pkg = (m: Manager, ...names: string[]): Partial<Record<Manager, Step[]>> => {
  switch (m) {
    case 'apt':
      return { apt: [{ cmd: 'apt-get', args: ['install', '-y', ...names], root: true }] };
    case 'dnf':
      // yum (older RHEL/CentOS) takes the same package names
      return {
        dnf: [{ cmd: 'dnf', args: ['install', '-y', ...names], root: true }],
        yum: [{ cmd: 'yum', args: ['install', '-y', ...names], root: true }],
      };
    case 'pacman':
      return { pacman: [{ cmd: 'pacman', args: ['-S', '--noconfirm', '--needed', ...names], root: true }] };
    case 'zypper':
      return { zypper: [{ cmd: 'zypper', args: ['--non-interactive', 'install', ...names], root: true }] };
    case 'apk':
      return { apk: [{ cmd: 'apk', args: ['add', ...names], root: true }] };
    case 'brew':
      return { brew: [{ cmd: 'brew', args: ['install', ...names] }] };
    case 'winget':
      return {
        winget: names.map((n) => ({
          cmd: 'winget',
          args: [
            'install',
            '--id',
            n,
            '-e',
            '--silent',
            '--accept-package-agreements',
            '--accept-source-agreements',
          ],
        })),
      };
    case 'choco':
      return { choco: [{ cmd: 'choco', args: ['install', '-y', ...names], root: true }] };
    default:
      return {};
  }
};
/** Merges per-manager step lists. */
const merge = (...parts: Array<Partial<Record<Manager, Step[]>>>): Partial<Record<Manager, Step[]>> =>
  Object.assign({}, ...parts);

const workload = (id: string, extra?: Partial<ToolSpec>): ToolSpec => ({
  id: `dotnet-workload-${id}`,
  name: `.NET workload ${id}`,
  after: ['dotnet-sdk'],
  checks: () => [one('dotnet', ['workload', 'list'], undefined, id)],
  recipes: () => ({ any: [{ cmd: 'dotnet', args: ['workload', 'install', id] }] }),
  manual: () => `dotnet workload install ${id}`,
  ...extra,
});

const DOTNET_INSTALL_SH = (channel: string) =>
  `curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && bash /tmp/dotnet-install.sh --channel ${channel}`;

/** dotnet-install into a given root (user level): one run per SDK channel, then runtime-only channels. */
export const dotnetInstallInto = (root: string, sdkChannels: string[], runtimeChannels: string[]): string => {
  const q = `'${root.replace(/'/g, `'\\''`)}'`;
  const runs = [
    ...sdkChannels.map((c) => `bash /tmp/dotnet-install.sh --install-dir ${q} --channel ${c}`),
    ...runtimeChannels.map(
      (c) => `bash /tmp/dotnet-install.sh --install-dir ${q} --runtime dotnet --channel ${c}`,
    ),
  ];
  return ['curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh', ...runs].join(' && ');
};

// ---------------------------------------------------------------------------------------------- Android SDK

/** Where the Android SDK lives: the user's own setting, else the default folder every Android tool looks in. */
export function androidHome(platform: Platform, env: NodeJS.ProcessEnv = process.env): string {
  const set = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (set) return set;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Android', 'sdk');
  if (platform === 'win32')
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
  return join(homedir(), 'Android', 'Sdk');
}

const sdkmanagerPath = (platform: Platform): string =>
  join(
    androidHome(platform),
    'cmdline-tools',
    'latest',
    'bin',
    platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager',
  );

/** Google's command-line tools bundle (the build number changes rarely; sdkmanager updates itself afterwards). */
const CMDLINE_TOOLS_BUILD = '11076708';

/** Installs the command-line tools into `<sdk>/cmdline-tools/latest` and accepts the licences. User level, no root. */
export const cmdlineToolsScript = (platform: Platform): string => {
  const sdk = androidHome(platform);
  const os = platform === 'darwin' ? 'mac' : 'linux';
  return [
    'set -e',
    `mkdir -p "${sdk}/cmdline-tools"`,
    `curl -fsSL -o "${sdk}/clt.zip" https://dl.google.com/android/repository/commandlinetools-${os}-${CMDLINE_TOOLS_BUILD}_latest.zip`,
    `rm -rf "${sdk}/cmdline-tools/tmp" "${sdk}/cmdline-tools/latest"`,
    `unzip -q -o "${sdk}/clt.zip" -d "${sdk}/cmdline-tools/tmp"`,
    `mv "${sdk}/cmdline-tools/tmp/cmdline-tools" "${sdk}/cmdline-tools/latest"`,
    `rm -rf "${sdk}/cmdline-tools/tmp" "${sdk}/clt.zip"`,
    `yes | "${sdk}/cmdline-tools/latest/bin/sdkmanager" --sdk_root="${sdk}" --licenses > /dev/null || true`,
  ].join('\n');
};

/** `sdkmanager --install <package>` for the SDK folder of this machine. */
const sdkInstall = (platform: Platform, pkgName: string): Step[] => [
  { cmd: sdkmanagerPath(platform), args: [`--sdk_root=${androidHome(platform)}`, pkgName] },
];

/** An installed-package check: `sdkmanager --list_installed` names the package at the start of a line. */
const sdkHas = (platform: Platform, pkgName: string): Check[] => [
  one(
    sdkmanagerPath(platform),
    [`--sdk_root=${androidHome(platform)}`, '--list_installed'],
    undefined,
    pkgName,
  ),
];

/** The API level the project targets (its own setting, else a current default) and the build-tools that go with it. */
const androidApi = (p: Params): string => p.androidApi ?? '34';
const androidBuildTools = (p: Params): string => p.buildTools ?? `${androidApi(p)}.0.0`;

const ANDROID_TOOLS: ToolSpec[] = [
  {
    id: 'android-cmdline-tools',
    name: 'Android SDK command-line tools',
    after: ['jdk'],
    checks: (_p, platform) => [one(sdkmanagerPath(platform), ['--version'], VER)],
    recipes: (_p, platform) =>
      platform === 'win32' ? {} : { any: [{ cmd: 'bash', args: ['-c', cmdlineToolsScript(platform)] }] },
    manual: (_p, platform) =>
      `Install the Android command-line tools into ${join(androidHome(platform), 'cmdline-tools', 'latest')} (https://developer.android.com/studio#command-line-tools-only; curl and unzip are needed)`,
  },
  {
    id: 'android-platform-tools',
    name: 'Android platform-tools',
    after: ['android-cmdline-tools'],
    checks: (_p, platform) => sdkHas(platform, 'platform-tools'),
    recipes: (_p, platform) => ({ any: sdkInstall(platform, 'platform-tools') }),
    manual: () => 'sdkmanager "platform-tools"',
  },
  {
    id: 'android-platform',
    name: 'Android SDK platform',
    after: ['android-cmdline-tools'],
    checks: (p, platform) => sdkHas(platform, `platforms;android-${androidApi(p)}`),
    recipes: (p, platform) => ({ any: sdkInstall(platform, `platforms;android-${androidApi(p)}`) }),
    manual: (p) => `sdkmanager "platforms;android-${androidApi(p)}"`,
  },
  {
    id: 'android-build-tools',
    name: 'Android build-tools',
    after: ['android-cmdline-tools'],
    checks: (p, platform) => sdkHas(platform, `build-tools;${androidBuildTools(p)}`),
    recipes: (p, platform) => ({ any: sdkInstall(platform, `build-tools;${androidBuildTools(p)}`) }),
    manual: (p) => `sdkmanager "build-tools;${androidBuildTools(p)}"`,
  },
];

export const TOOLS: Record<string, ToolSpec> = Object.fromEntries(
  (
    [
      {
        id: 'dotnet-sdk',
        name: '.NET SDK',
        checks: () => [one('dotnet', ['--version'], VER)],
        minVersion: (p) => p.sdkMajor,
        recipes: (p, platform) => {
          const v = p.sdkMajor ?? '8';
          return merge(
            pkg('apt', `dotnet-sdk-${v}.0`),
            pkg('dnf', `dotnet-sdk-${v}.0`),
            pkg('pacman', `dotnet-sdk-${v}.0`),
            pkg('zypper', `dotnet-sdk-${v}.0`),
            pkg('apk', `dotnet${v}-sdk`),
            pkg('brew', `dotnet@${v}`),
            pkg('winget', `Microsoft.DotNet.SDK.${v}`),
            // The official installer script: user level, no administrator rights (Linux and macOS).
            platform === 'win32' ? {} : { any: [{ cmd: 'bash', args: ['-c', DOTNET_INSTALL_SH(`${v}.0`)] }] },
          );
        },
        manual: (p) =>
          `Install the .NET SDK ${p.sdkMajor ?? ''} from https://dot.net/download`.replace('  ', ' '),
      },
      workload('maui'),
      workload('maui-android'),
      workload('android'),
      workload('ios'),
      workload('maccatalyst'),
      {
        id: 'jdk',
        name: 'JDK',
        checks: () => [one('javac', ['-version'], VER)],
        minVersion: (p) => p.javaMajor ?? '17',
        recipes: (p) => {
          const v = p.javaMajor && Number(p.javaMajor) >= 17 ? p.javaMajor : '17';
          return merge(
            pkg('apt', `openjdk-${v}-jdk`),
            pkg('dnf', `java-${v}-openjdk-devel`),
            pkg('pacman', `jdk${v}-openjdk`),
            pkg('zypper', `java-${v}-openjdk-devel`),
            pkg('apk', `openjdk${v}`),
            pkg('brew', `openjdk@${v}`),
            pkg('winget', `Microsoft.OpenJDK.${v}`),
          );
        },
        manual: (p) => `Install a JDK ${p.javaMajor ?? '17'} (https://adoptium.net)`,
      },
      {
        id: 'node',
        name: 'Node.js',
        checks: () => [one('node', ['--version'], VER)],
        minVersion: (p) => p.nodeMajor,
        recipes: (p) =>
          merge(
            pkg('apt', 'nodejs', 'npm'),
            pkg('dnf', 'nodejs', 'npm'),
            pkg('pacman', 'nodejs', 'npm'),
            pkg('zypper', 'nodejs-default', 'npm-default'),
            pkg('apk', 'nodejs', 'npm'),
            pkg('brew', p.nodeMajor ? `node@${p.nodeMajor}` : 'node'),
            pkg('winget', p.nodeMajor ? `OpenJS.NodeJS.${p.nodeMajor}` : 'OpenJS.NodeJS.LTS'),
          ),
        manual: (p) => `Install Node.js ${p.nodeMajor ?? 'LTS'} (https://nodejs.org or nvm)`,
      },
      {
        id: 'node-pnpm',
        name: 'pnpm',
        after: ['node'],
        checks: () => [one('pnpm', ['--version'], VER)],
        minVersion: (p) => p.pmVersion,
        recipes: (p) => ({
          any: [{ cmd: 'npm', args: ['install', '-g', p.pmVersion ? `pnpm@${p.pmVersion}` : 'pnpm'] }],
        }),
        manual: () => 'npm install -g pnpm (or corepack enable)',
      },
      {
        id: 'node-yarn',
        name: 'Yarn',
        after: ['node'],
        checks: () => [one('yarn', ['--version'], VER)],
        recipes: () => ({ any: [{ cmd: 'npm', args: ['install', '-g', 'yarn'] }] }),
        manual: () => 'npm install -g yarn (or corepack enable)',
      },
      {
        id: 'node-bun',
        name: 'Bun',
        checks: () => [one('bun', ['--version'], VER)],
        recipes: (_p, platform) =>
          merge(
            pkg('brew', 'oven-sh/bun/bun'),
            platform === 'win32'
              ? {}
              : { any: [{ cmd: 'bash', args: ['-c', 'curl -fsSL https://bun.sh/install | bash'] }] },
          ),
        manual: () => 'Install Bun from https://bun.sh',
      },
      {
        id: 'python',
        name: 'Python',
        checks: (_p, platform) =>
          platform === 'win32'
            ? [one('python', ['--version'], VER), one('py', ['-3', '--version'], VER)]
            : [one('python3', ['--version'], VER)],
        minVersion: (p) => p.pythonVersion,
        recipes: (p) =>
          merge(
            pkg('apt', 'python3', 'python3-pip'),
            pkg('dnf', 'python3', 'python3-pip'),
            pkg('pacman', 'python', 'python-pip'),
            pkg('zypper', 'python3', 'python3-pip'),
            pkg('apk', 'python3', 'py3-pip'),
            pkg('brew', p.pythonVersion ? `python@${p.pythonVersion}` : 'python'),
            pkg(
              'winget',
              p.pythonVersion ? `Python.Python.${p.pythonVersion.replace('.', '.')}` : 'Python.Python.3.12',
            ),
          ),
        manual: (p) => `Install Python ${p.pythonVersion ?? '3'} (https://python.org)`,
      },
      {
        id: 'python-venv',
        name: 'Python venv',
        after: ['python'],
        checks: (_p, platform) => [
          one(platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', '--help']),
        ],
        recipes: () => merge(pkg('apt', 'python3-venv'), pkg('dnf', 'python3'), pkg('pacman', 'python')),
        manual: () => 'Install the venv module of your Python (Debian: apt install python3-venv)',
      },
      {
        id: 'python-uv',
        name: 'uv',
        after: ['python'],
        checks: () => [one('uv', ['--version'], VER)],
        recipes: (_p, platform) =>
          merge(
            pkg('brew', 'uv'),
            platform === 'win32'
              ? {}
              : { any: [{ cmd: 'bash', args: ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'] }] },
          ),
        manual: () => 'Install uv (https://docs.astral.sh/uv/)',
      },
      {
        id: 'python-poetry',
        name: 'Poetry',
        after: ['python'],
        checks: () => [one('poetry', ['--version'], VER)],
        recipes: (_p, platform) => ({
          any: [
            {
              cmd: platform === 'win32' ? 'python' : 'python3',
              args: ['-m', 'pip', 'install', '--user', 'poetry'],
            },
          ],
        }),
        manual: () => 'pip install --user poetry',
      },
      {
        id: 'python-pipenv',
        name: 'Pipenv',
        after: ['python'],
        checks: () => [one('pipenv', ['--version'], VER)],
        recipes: (_p, platform) => ({
          any: [
            {
              cmd: platform === 'win32' ? 'python' : 'python3',
              args: ['-m', 'pip', 'install', '--user', 'pipenv'],
            },
          ],
        }),
        manual: () => 'pip install --user pipenv',
      },
      {
        id: 'docker',
        name: 'Docker',
        docker: true,
        checks: () => [one('docker', ['--version'], VER)],
        recipes: () =>
          merge(
            pkg('apt', 'docker.io', 'docker-compose-v2'),
            pkg('dnf', 'docker', 'docker-compose'),
            pkg('pacman', 'docker', 'docker-compose'),
            pkg('zypper', 'docker', 'docker-compose'),
            pkg('apk', 'docker', 'docker-cli-compose'),
            pkg('brew', 'docker', 'docker-compose'),
            pkg('winget', 'Docker.DockerDesktop'),
          ),
        manual: () => 'Install Docker (https://docs.docker.com/engine/install/)',
      },
      {
        id: 'docker-daemon',
        name: 'Docker daemon',
        docker: true,
        after: ['docker'],
        checks: () => [one('docker', ['info', '--format', '{{.ServerVersion}}'], VER)],
        recipes: (_p, platform) =>
          platform === 'linux'
            ? { any: [{ cmd: 'systemctl', args: ['enable', '--now', 'docker'], root: true }] }
            : {},
        manual: (_p, platform) =>
          platform === 'linux'
            ? 'sudo systemctl enable --now docker; add the runner user to the docker group: sudo usermod -aG docker $USER (then log in again)'
            : 'Start Docker Desktop',
      },
      {
        id: 'go',
        name: 'Go',
        checks: () => [one('go', ['version'], /go(\d+\.\d+(?:\.\d+)?)/)],
        minVersion: (p) => p.goVersion,
        recipes: () =>
          merge(
            pkg('apt', 'golang-go'),
            pkg('dnf', 'golang'),
            pkg('pacman', 'go'),
            pkg('zypper', 'go'),
            pkg('apk', 'go'),
            pkg('brew', 'go'),
            pkg('winget', 'GoLang.Go'),
          ),
        manual: () => 'Install Go (https://go.dev/dl/)',
      },
      {
        id: 'rust',
        name: 'Rust (cargo)',
        checks: () => [one('cargo', ['--version'], VER)],
        recipes: (_p, platform) =>
          merge(
            pkg('brew', 'rustup'),
            pkg('winget', 'Rustlang.Rustup'),
            platform === 'win32'
              ? {}
              : {
                  any: [
                    {
                      cmd: 'bash',
                      args: ['-c', "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"],
                    },
                  ],
                },
          ),
        manual: () => 'Install Rust with rustup (https://rustup.rs)',
      },
      {
        id: 'maven',
        name: 'Maven',
        after: ['jdk'],
        checks: () => [one('mvn', ['--version'], VER)],
        recipes: () =>
          merge(
            pkg('apt', 'maven'),
            pkg('dnf', 'maven'),
            pkg('pacman', 'maven'),
            pkg('zypper', 'maven'),
            pkg('apk', 'maven'),
            pkg('brew', 'maven'),
            pkg('winget', 'Apache.Maven'),
          ),
        manual: () => 'Install Maven (https://maven.apache.org)',
      },
      {
        id: 'gradle',
        name: 'Gradle',
        after: ['jdk'],
        checks: () => [one('gradle', ['--version'], VER)],
        recipes: () =>
          merge(
            pkg('apt', 'gradle'),
            pkg('dnf', 'gradle'),
            pkg('pacman', 'gradle'),
            pkg('zypper', 'gradle'),
            pkg('apk', 'gradle'),
            pkg('brew', 'gradle'),
            pkg('winget', 'Gradle.Gradle'),
          ),
        manual: () => 'Install Gradle (https://gradle.org) or add a wrapper to the repository',
      },
      {
        id: 'ruby',
        name: 'Ruby',
        checks: () => [one('ruby', ['--version'], VER)],
        recipes: () =>
          merge(
            pkg('apt', 'ruby-full'),
            pkg('dnf', 'ruby'),
            pkg('pacman', 'ruby'),
            pkg('zypper', 'ruby'),
            pkg('apk', 'ruby'),
            pkg('brew', 'ruby'),
            pkg('winget', 'RubyInstallerTeam.Ruby.3.3'),
          ),
        manual: () => 'Install Ruby (https://www.ruby-lang.org)',
      },
      {
        id: 'bundler',
        name: 'Bundler',
        after: ['ruby'],
        checks: () => [one('bundle', ['--version'], VER)],
        recipes: () => ({ any: [{ cmd: 'gem', args: ['install', 'bundler'] }] }),
        manual: () => 'gem install bundler',
      },
      {
        id: 'php',
        name: 'PHP',
        checks: () => [one('php', ['--version'], VER)],
        recipes: () =>
          merge(
            pkg('apt', 'php-cli'),
            pkg('dnf', 'php-cli'),
            pkg('pacman', 'php'),
            pkg('zypper', 'php8-cli'),
            pkg('brew', 'php'),
            pkg('winget', 'PHP.PHP'),
          ),
        manual: () => 'Install PHP (https://php.net)',
      },
      {
        id: 'composer',
        name: 'Composer',
        after: ['php'],
        checks: () => [one('composer', ['--version'], VER)],
        recipes: () =>
          merge(
            pkg('apt', 'composer'),
            pkg('dnf', 'composer'),
            pkg('pacman', 'composer'),
            pkg('zypper', 'php-composer2'),
            pkg('apk', 'composer'),
            pkg('brew', 'composer'),
            pkg('winget', 'Composer.Composer'),
          ),
        manual: () => 'Install Composer (https://getcomposer.org)',
      },
    ] satisfies ToolSpec[]
  )
    .concat(ANDROID_TOOLS)
    .map((t) => [t.id, t]),
);

export type { Detection, Platform, RepoView };
