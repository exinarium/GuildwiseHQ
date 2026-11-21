import { join } from 'node:path';
import { ANDROID_CMDLINE_TOOLS, BUN_VERSION, GRADLE_VERSION, MAVEN_VERSION, UV_VERSION } from './pins.ts';
import type { Platform } from './types.ts';
import {
  type Archive,
  type ResolveContext,
  sumFromText,
  UserInstallError,
  type UserInstallPlan,
  type UserInstallResolver,
} from './user-install.ts';

/**
 * Where each stack tool comes from and what proves the download (DESIGN §5 table). Vendor checksums are read from the
 * vendor over HTTPS at install time; pins (`pins.ts`) only where the vendor publishes none (Android).
 */

const unsupported = (what: string, ctx: ResolveContext): never => {
  throw new UserInstallError(`no ${what} build for ${ctx.platform}-${ctx.arch}`);
};
const posix = (p: Platform): boolean => p === 'linux' || p === 'darwin';

// ------------------------------------------------------------------------------------------------- Node.js

interface NodeIndexEntry {
  version: string;
  lts: string | false;
}

export const nodeUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const arch = ctx.arch === 'x64' || ctx.arch === 'arm64' ? ctx.arch : unsupported('Node.js', ctx);
  const index = JSON.parse(await ctx.fetchText('https://nodejs.org/dist/index.json')) as NodeIndexEntry[];
  const major = ctx.params.nodeMajor?.split('.')[0];
  const pick = major
    ? index.find((e) => e.version.startsWith(`v${major}.`))
    : index.find((e) => e.lts !== false);
  if (!pick) throw new UserInstallError(`no Node.js ${major ?? 'LTS'} release in nodejs.org/dist/index.json`);
  const v = pick.version;
  const os = ctx.platform === 'darwin' ? 'darwin' : 'linux';
  const file = `node-${v}-${os}-${arch}.${os === 'darwin' ? 'tar.gz' : 'tar.xz'}`;
  const sums = await ctx.fetchText(`https://nodejs.org/dist/${v}/SHASUMS256.txt`);
  return {
    archives: [
      {
        url: `https://nodejs.org/dist/${v}/${file}`,
        checksum: { algo: 'sha256', hex: sumFromText(sums, file) },
        format: 'tar',
        tool: 'node',
        version: v.replace(/^v/, ''),
        strip: true,
        bins: { node: 'bin/node', npm: 'bin/npm', npx: 'bin/npx', corepack: 'bin/corepack' },
      },
    ],
  };
};

// ------------------------------------------------------------------------------------------------ uv, Python

const uvTarget = (ctx: ResolveContext): string => {
  const cpu = ctx.arch === 'x64' ? 'x86_64' : ctx.arch === 'arm64' ? 'aarch64' : unsupported('uv', ctx);
  return ctx.platform === 'darwin' ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-gnu`;
};

async function uvArchive(ctx: ResolveContext): Promise<Archive> {
  const target = uvTarget(ctx);
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.tar.gz`;
  return {
    url,
    checksum: { algo: 'sha256', hex: sumFromText(await ctx.fetchText(`${url}.sha256`)) },
    format: 'tar',
    tool: 'uv',
    version: UV_VERSION,
    strip: true,
    bins: { uv: 'uv', uvx: 'uvx' },
  };
}

/** uv keeps everything it manages under the toolchains root (review nit: decision 8). */
export function uvEnv(root: string): Record<string, string> {
  return {
    UV_PYTHON_INSTALL_DIR: join(root, 'python'),
    UV_PYTHON_BIN_DIR: join(root, 'bin'),
    UV_TOOL_DIR: join(root, 'uv-tools'),
    UV_TOOL_BIN_DIR: join(root, 'bin'),
    UV_CACHE_DIR: join(root, '.cache', 'uv'),
    UV_NO_MODIFY_PATH: '1',
  };
}

export const uvUserInstall: UserInstallResolver = async (ctx) =>
  posix(ctx.platform) ? { archives: [await uvArchive(ctx)] } : null;

/** `uv python install <3.x>`: python-build-standalone, hash-checked by uv; `python3` linked to it when missing. */
export const pythonUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const minor = /^3\.(\d+)/.exec(ctx.params.pythonVersion ?? '')?.[1] ?? '12';
  return {
    archives: [await uvArchive(ctx)],
    steps: [
      {
        cmd: join(ctx.root, 'bin', 'uv'),
        args: ['python', 'install', `3.${minor}`],
        env: uvEnv(ctx.root),
      },
    ],
    links: { python3: join(ctx.root, 'bin', `python3.${minor}`) },
  };
};

/** Poetry and Pipenv through `uv tool install` (pip --user fails under PEP 668). */
export const uvToolUserInstall =
  (pkg: string): UserInstallResolver =>
  async (ctx) =>
    posix(ctx.platform)
      ? {
          archives: [await uvArchive(ctx)],
          steps: [{ cmd: join(ctx.root, 'bin', 'uv'), args: ['tool', 'install', pkg], env: uvEnv(ctx.root) }],
        }
      : null;

// ---------------------------------------------------------------------------------------------------- Bun

export const bunUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const cpu = ctx.arch === 'x64' ? 'x64' : ctx.arch === 'arm64' ? 'aarch64' : unsupported('Bun', ctx);
  const name = `bun-${ctx.platform === 'darwin' ? 'darwin' : 'linux'}-${cpu}`;
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}`;
  const sums = await ctx.fetchText(`${base}/SHASUMS256.txt`);
  return {
    archives: [
      {
        url: `${base}/${name}.zip`,
        checksum: { algo: 'sha256', hex: sumFromText(sums, `${name}.zip`) },
        format: 'zip',
        tool: 'bun',
        version: BUN_VERSION,
        strip: true,
        bins: { bun: 'bun', bunx: 'bun' },
      },
    ],
  };
};

// ------------------------------------------------------------------------------------------------------ .NET

interface DotnetFile {
  name: string;
  rid: string;
  url: string;
  hash: string;
}
interface DotnetRelease {
  runtime?: { version: string; files?: DotnetFile[] };
  sdk?: { version: string; files?: DotnetFile[] };
  sdks?: Array<{ version: string; files?: DotnetFile[] }>;
}
interface DotnetReleases {
  'latest-sdk': string;
  'latest-runtime': string;
  releases: DotnetRelease[];
}

const dotnetRid = (ctx: ResolveContext): string => {
  const cpu = ctx.arch === 'x64' || ctx.arch === 'arm64' ? ctx.arch : unsupported('.NET', ctx);
  return `${ctx.platform === 'darwin' ? 'osx' : 'linux'}-${cpu}`;
};

const dotnetMeta = async (ctx: ResolveContext, channel: string): Promise<DotnetReleases> => {
  if (!/^\d+\.\d+$/.test(channel)) throw new UserInstallError(`bad .NET channel ${channel}`);
  return JSON.parse(
    await ctx.fetchText(
      `https://builds.dotnet.microsoft.com/dotnet/release-metadata/${channel}/releases.json`,
    ),
  ) as DotnetReleases;
};

const tarFor = (files: DotnetFile[] | undefined, rid: string, prefix: string): DotnetFile | undefined =>
  files?.find((f) => f.rid === rid && f.name.startsWith(prefix) && f.name.endsWith('.tar.gz'));

/**
 * The SDK (and runtime-only) channels the project needs, from the release metadata: each file's sha512 is the check
 * (dotnet-install.sh does not verify the payload). Unpacked into `into` (the chosen root, else `<root>/dotnet`).
 */
export const dotnetUserInstall =
  (into: string | undefined, sdkChannels: string[], runtimeChannels: string[]): UserInstallResolver =>
  async (ctx) => {
    if (!posix(ctx.platform)) return null;
    const rid = dotnetRid(ctx);
    const dir = into ?? join(ctx.root, 'dotnet');
    const archives: Archive[] = [];
    for (const channel of sdkChannels) {
      const meta = await dotnetMeta(ctx, channel);
      const v = meta['latest-sdk'];
      const sdk = meta.releases.flatMap((r) => [r.sdk, ...(r.sdks ?? [])]).find((s) => s?.version === v);
      const f = tarFor(sdk?.files, rid, 'dotnet-sdk');
      if (!f) throw new UserInstallError(`no .NET SDK ${v} for ${rid} in the ${channel} release metadata`);
      archives.push({
        url: f.url,
        checksum: { algo: 'sha512', hex: f.hash },
        format: 'tar',
        tool: 'dotnet',
        version: `sdk-${v}`,
        into: { dir, mode: 'merge' },
        present: join(dir, 'sdk', v),
      });
    }
    for (const channel of runtimeChannels) {
      const meta = await dotnetMeta(ctx, channel);
      const v = meta['latest-runtime'];
      const rt = meta.releases.find((r) => r.runtime?.version === v)?.runtime;
      const f = tarFor(rt?.files, rid, 'dotnet-runtime');
      if (!f)
        throw new UserInstallError(`no .NET runtime ${v} for ${rid} in the ${channel} release metadata`);
      archives.push({
        url: f.url,
        checksum: { algo: 'sha512', hex: f.hash },
        format: 'tar',
        tool: 'dotnet',
        version: `runtime-${v}`,
        into: { dir, mode: 'merge' },
        present: join(dir, 'shared', 'Microsoft.NETCore.App', v),
      });
    }
    // only a root of our own is linked; ~/.dotnet and a configured root are found by the registry
    const last = archives.at(-1);
    if (last && dir === join(ctx.root, 'dotnet')) last.bins = { dotnet: 'dotnet' };
    return { archives };
  };

// ------------------------------------------------------------------------------------- JDK, Maven, Gradle

interface AdoptiumAsset {
  binary: { package: { link: string; checksum: string; name: string } };
  release_name: string;
}

export const jdkUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const major = ctx.params.javaMajor && Number(ctx.params.javaMajor) >= 17 ? ctx.params.javaMajor : '17';
  if (!/^\d+$/.test(major)) throw new UserInstallError(`bad Java version ${major}`);
  const os = ctx.platform === 'darwin' ? 'mac' : 'linux';
  const cpu = ctx.arch === 'x64' ? 'x64' : ctx.arch === 'arm64' ? 'aarch64' : unsupported('JDK', ctx);
  const assets = JSON.parse(
    await ctx.fetchText(
      `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=${os}&architecture=${cpu}&image_type=jdk`,
    ),
  ) as AdoptiumAsset[];
  const a = assets.find((x) => x.binary?.package?.name?.endsWith('.tar.gz'));
  if (!a) throw new UserInstallError(`no Temurin JDK ${major} for ${os}-${cpu} from api.adoptium.net`);
  const bin = os === 'mac' ? 'Contents/Home/bin' : 'bin';
  return {
    archives: [
      {
        url: a.binary.package.link,
        checksum: { algo: 'sha256', hex: a.binary.package.checksum },
        format: 'tar',
        tool: 'jdk',
        version: a.release_name.replace(/[^\w.+-]/g, '_'),
        strip: true,
        bins: Object.fromEntries(
          ['java', 'javac', 'jar', 'jshell', 'keytool', 'jarsigner'].map((b) => [b, `${bin}/${b}`]),
        ),
      },
    ],
  };
};

export const mavenUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const v = MAVEN_VERSION;
  const url = `https://archive.apache.org/dist/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.tar.gz`;
  return {
    archives: [
      {
        url,
        checksum: { algo: 'sha512', hex: sumFromText(await ctx.fetchText(`${url}.sha512`)) },
        format: 'tar',
        tool: 'maven',
        version: v,
        strip: true,
        bins: { mvn: 'bin/mvn' },
      },
    ],
  };
};

export const gradleUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const v = GRADLE_VERSION;
  const url = `https://services.gradle.org/distributions/gradle-${v}-bin.zip`;
  return {
    archives: [
      {
        url,
        checksum: { algo: 'sha256', hex: sumFromText(await ctx.fetchText(`${url}.sha256`)) },
        format: 'zip',
        tool: 'gradle',
        version: v,
        strip: true,
        bins: { gradle: 'bin/gradle' },
      },
    ],
  };
};

// ------------------------------------------------------------------------------------------------------ Go

interface GoRelease {
  version: string;
  stable: boolean;
  files: Array<{ filename: string; os: string; arch: string; sha256: string; kind: string }>;
}

export const goUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const cpu = ctx.arch === 'x64' ? 'amd64' : ctx.arch === 'arm64' ? 'arm64' : unsupported('Go', ctx);
  const releases = JSON.parse(await ctx.fetchText('https://go.dev/dl/?mode=json&include=all')) as GoRelease[];
  const want = ctx.params.goVersion;
  const rel =
    releases.find(
      (r) => r.stable && (!want || r.version === `go${want}` || r.version.startsWith(`go${want}.`)),
    ) ?? releases.find((r) => r.stable);
  const f = rel?.files.find((x) => x.os === ctx.platform && x.arch === cpu && x.kind === 'archive');
  if (!rel || !f) throw new UserInstallError(`no Go release for ${ctx.platform}-${cpu} on go.dev/dl`);
  return {
    archives: [
      {
        url: `https://go.dev/dl/${f.filename}`,
        checksum: { algo: 'sha256', hex: f.sha256 },
        format: 'tar',
        tool: 'go',
        version: rel.version.replace(/^go/, ''),
        strip: true,
        bins: { go: 'bin/go', gofmt: 'bin/gofmt' },
      },
    ],
  };
};

// ---------------------------------------------------------------------------------------------------- Rust

/** rustup's homes under the root; the proxies need RUSTUP_HOME (the registry and the probes set it). */
export function rustEnv(root: string): Record<string, string> {
  return { CARGO_HOME: join(root, 'rust', 'cargo'), RUSTUP_HOME: join(root, 'rust', 'rustup') };
}

export const rustUserInstall: UserInstallResolver = async (ctx) => {
  if (!posix(ctx.platform)) return null;
  const cpu = ctx.arch === 'x64' ? 'x86_64' : ctx.arch === 'arm64' ? 'aarch64' : unsupported('rustup', ctx);
  const target = ctx.platform === 'darwin' ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-gnu`;
  const url = `https://static.rust-lang.org/rustup/dist/${target}/rustup-init`;
  const hex = sumFromText(await ctx.fetchText(`${url}.sha256`));
  const version = hex.slice(0, 12);
  const env = rustEnv(ctx.root);
  const cargoBin = join(env.CARGO_HOME as string, 'bin');
  return {
    archives: [
      {
        url,
        checksum: { algo: 'sha256', hex },
        format: 'file',
        fileName: 'rustup-init',
        tool: 'rustup-init',
        version,
      },
    ],
    steps: [
      {
        cmd: join(ctx.root, 'rustup-init', version, 'rustup-init'),
        args: ['-y', '--no-modify-path', '--profile', 'minimal'],
        env,
      },
    ],
    links: Object.fromEntries(['cargo', 'rustc', 'rustup'].map((b) => [b, join(cargoBin, b)])),
  };
};

// ------------------------------------------------------------------------------------------------- Android

/** The pinned command-line tools into `<sdk>/cmdline-tools/latest`, then the licences accepted. */
export const androidCmdlineUserInstall =
  (sdk: string): UserInstallResolver =>
  async (ctx: ResolveContext): Promise<UserInstallPlan | null> => {
    const key =
      ctx.platform === 'linux'
        ? 'linux'
        : ctx.platform === 'darwin'
          ? ctx.arch === 'arm64'
            ? 'darwin-arm64'
            : 'darwin-x64'
          : null;
    if (!key) return null;
    const pin = ANDROID_CMDLINE_TOOLS.files[key];
    const sdkmanager = join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    return {
      archives: [
        {
          url: `https://dl.google.com/android/repository/${pin.file}`,
          checksum: { algo: 'sha256', hex: pin.sha256 },
          format: 'zip',
          tool: 'android-cmdline-tools',
          version: ANDROID_CMDLINE_TOOLS.build,
          strip: true,
          into: { dir: join(sdk, 'cmdline-tools', 'latest'), mode: 'replace' },
          present: join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
        },
      ],
      steps: [
        {
          cmd: 'bash',
          args: ['-c', `yes | ${q(sdkmanager)} --sdk_root=${q(sdk)} --licenses > /dev/null || true`],
        },
      ],
    };
  };
