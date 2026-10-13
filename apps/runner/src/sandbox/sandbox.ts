import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunnerPaths } from '../paths.ts';

export interface Sandbox {
  agentId: string;
  root: string;
  /** Agent HOME / USERPROFILE (.gitconfig with the agent identity, tool caches). */
  home: string;
  /** CLAUDE_CONFIG_DIR. */
  configDir: string;
  scratch: string;
  /**
   * Private temp dir (TMPDIR/TMP/TEMP). On Linux/macOS it is a short path directly under /tmp (`/tmp/aom-<10 hex>`),
   * mode 0700: Unix socket paths are limited to 108 bytes and tools such as Chromium put sockets under TMPDIR
   * (Claude Code's sandbox nests a further `claude-<uid>` dir inside it), so a TMPDIR under the data dir was too long.
   */
  tmp: string;
  /**
   * Runner-level package caches shared by every agent of this runner (`<runner root>/cache`, see `cacheEnv`).
   * Optional so callers and test fixtures that build a Sandbox by hand keep working.
   */
  cacheRoot?: string;
}

/** Sub-directories of `<runner root>/cache`: one per package manager. */
export const CACHE_KINDS = [
  'nuget',
  'nuget-http',
  'nuget-plugins',
  'npm',
  'pnpm',
  'yarn',
  'pip',
  'gradle',
  'maven',
  'go-mod',
  'go-build',
] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];

/** `<runner root>/cache`. */
export const sharedCacheRoot = (paths: Pick<RunnerPaths, 'root'>): string => join(paths.root, 'cache');

/** Absolute directory of one shared cache. */
export const sharedCacheDir = (cacheRoot: string, kind: CacheKind): string => join(cacheRoot, kind);

/**
 * Where .NET keeps the shared memory and lock files behind named mutexes on Linux (it ignores TMPDIR). NuGet takes a
 * named mutex (`NuGet-Migrations`), so `dotnet build`/`test`/`restore` fail with "The system cannot open the device or
 * file specified" when the sandbox cannot write here.
 */
export const DOTNET_SHM_DIR = '/tmp/.dotnet';

/**
 * Env that makes every package manager use the runner's shared caches (never the agent's empty private HOME).
 * Cargo is left out on purpose: its home also holds installed binaries and credentials.
 */
export function cacheEnv(cacheRoot: string): Record<string, string> {
  const d = (k: CacheKind) => sharedCacheDir(cacheRoot, k);
  return {
    NUGET_PACKAGES: d('nuget'),
    NUGET_HTTP_CACHE_PATH: d('nuget-http'),
    NUGET_PLUGINS_CACHE_PATH: d('nuget-plugins'),
    npm_config_cache: d('npm'),
    npm_config_store_dir: d('pnpm'),
    YARN_CACHE_FOLDER: d('yarn'),
    PIP_CACHE_DIR: d('pip'),
    // caches only: the agents' homes are empty, so there is no gradle.properties with credentials to share
    GRADLE_USER_HOME: d('gradle'),
    MAVEN_OPTS: `-Dmaven.repo.local=${d('maven')}`,
    GOMODCACHE: d('go-mod'),
    GOCACHE: d('go-build'),
  };
}

/** .NET variables for a sandboxed agent; `DOTNET_CLI_HOME` is the agent's own writable dir. */
export function dotnetEnv(cliHome: string): Record<string, string> {
  return {
    DOTNET_CLI_HOME: cliHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
    DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: '0',
    // NuGet checks package signature certificates against CRL/OCSP hosts the sandbox does not allow: don't wait for them
    NUGET_CERT_REVOCATION_MODE: 'offline',
    // no build servers that outlive the shift
    MSBUILDDISABLENODEREUSE: '1',
    DOTNET_CLI_USE_MSBUILD_SERVER: '0',
    UseSharedCompilation: 'false',
  };
}

/** Names of every variable the sandbox env adds for caches and .NET (the unsandboxed DevOps engineer keeps its own). */
export const CACHE_ENV_KEYS: string[] = [
  ...Object.keys(cacheEnv('/')),
  ...Object.keys(dotnetEnv('/')),
  'NUGET_FALLBACK_PACKAGES',
];

/** The user's own NuGet packages folder, when it exists: offered to the agents as a read-only NuGet fallback folder. */
export function userNugetPackages(realHome: string = homedir()): string | undefined {
  const dir = join(realHome, '.nuget', 'packages');
  return existsSync(dir) ? dir : undefined;
}

/** Creates the shared cache directories (idempotent). */
export async function ensureSharedCaches(cacheRoot: string): Promise<void> {
  await Promise.all(CACHE_KINDS.map((k) => mkdir(sharedCacheDir(cacheRoot, k), { recursive: true })));
}

/** Creates `/tmp/.dotnet` the way .NET does (world-writable) so the sandbox can be told to write there. Linux only. */
export async function ensureDotnetShm(): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    await mkdir(DOTNET_SHM_DIR, { recursive: true, mode: 0o777 });
    chmodSync(DOTNET_SHM_DIR, 0o777);
  } catch {
    /* owned by another user or not creatable: .NET then fails as before, nothing else is affected */
  }
}

/** `/tmp/aom-<hash of runner data dir + agent id>` on POSIX; `<agent dir>/tmp` on Windows. */
export function agentTmpDir(paths: RunnerPaths, agentId: string): string {
  if (process.platform === 'win32') return join(paths.agentDir(agentId), 'tmp');
  const h = createHash('sha256')
    .update(`${dirname(paths.agentDir(agentId))}\0${agentId}`)
    .digest('hex');
  return `/tmp/aom-${h.slice(0, 10)}`;
}

export function sandboxFor(paths: RunnerPaths, agentId: string): Sandbox {
  const root = paths.agentDir(agentId);
  return {
    agentId,
    root,
    home: join(root, 'home'),
    configDir: join(root, 'claude'),
    scratch: join(root, 'scratch'),
    tmp: agentTmpDir(paths, agentId),
    cacheRoot: sharedCacheRoot(paths),
  };
}

export function agentEmail(agentId: string): string {
  return `${agentId}@agents.aom.invalid`;
}

/** Creates `agents/<id>/{home,claude,scratch,tmp}` and the agent's `.gitconfig` (idempotent; refreshes the name). */
export async function ensureSandbox(
  paths: RunnerPaths,
  agentId: string,
  agentName: string,
): Promise<Sandbox> {
  const sb = sandboxFor(paths, agentId);
  await Promise.all([sb.home, sb.configDir, sb.scratch].map((d) => mkdir(d, { recursive: true })));
  await mkdir(sb.tmp, { recursive: true, mode: 0o700 });
  if (sb.cacheRoot) await ensureSharedCaches(sb.cacheRoot);
  await ensureDotnetShm();
  const gitconfig = [
    '[user]',
    `\tname = ${agentName} (aom)`,
    `\temail = ${agentEmail(agentId)}`,
    '[commit]',
    '\tgpgsign = false',
    '[core]',
    '\tautocrlf = false',
    '[init]',
    '\tdefaultBranch = main',
    '',
  ].join('\n');
  await writeFile(join(sb.home, '.gitconfig'), gitconfig);
  return sb;
}

/** Environment that makes every child process (agent, git) use the agent's private home and identity. */
export function sandboxEnv(
  sb: Sandbox,
  realHome: string = homedir(),
  /** Variables of the agent toolchains (DOTNET_ROOT, JAVA_HOME, ...), already checked by the registry. */
  toolchainEnv: Record<string, string> = {},
): Record<string, string> {
  const nugetFallback = userNugetPackages(realHome);
  return {
    ...toolchainEnv,
    ...(sb.cacheRoot ? cacheEnv(sb.cacheRoot) : {}),
    ...dotnetEnv(sb.home),
    // read-only: packages already restored for the user are found without a download
    ...(nugetFallback ? { NUGET_FALLBACK_PACKAGES: nugetFallback } : {}),
    HOME: sb.home,
    USERPROFILE: sb.home,
    GIT_CONFIG_GLOBAL: join(sb.home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    CLAUDE_CONFIG_DIR: sb.configDir,
    TMPDIR: sb.tmp,
    TMP: sb.tmp,
    TEMP: sb.tmp,
  };
}

/** `agent.wipe`: removes `agents/<id>` recursively. Idempotent. */
export async function wipeAgent(paths: RunnerPaths, agentId: string): Promise<{ removed: boolean }> {
  const dir = paths.agentDir(agentId);
  const existed = existsSync(dir);
  await rm(dir, { recursive: true, force: true });
  await rm(agentTmpDir(paths, agentId), { recursive: true, force: true });
  return { removed: existed };
}
