import { accessSync, constants, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

/**
 * .NET installations on this workstation. The `dotnet` muxer only resolves SDKs inside its own root, so one root has to
 * hold every SDK the projects need: the runner picks it once (the one with the most SDK versions) and gives it to the
 * agents (PATH, DOTNET_ROOT, sandbox read access). Everything here reads directory names; `dotnet` is never spawned.
 */
export interface DotnetInstall {
  /** Real path of the install root (symlinks resolved). */
  root: string;
  /** SDK versions (`<root>/sdk/*`), ascending. */
  sdks: string[];
  /** `Microsoft.NETCore.App` runtime versions (`<root>/shared/Microsoft.NETCore.App/*`), ascending. */
  runtimes: string[];
}

export interface DotnetSelection {
  /** The root agents use, or undefined when no install with an SDK exists. */
  chosen?: DotnetInstall;
  all: DotnetInstall[];
  /** Why this root: `config` (dotnetRoot override), `superset`, `most-sdks`, `highest-sdk`, `only`. */
  reason?: string;
}

export interface DotnetDetectOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** `dotnetRoot` from config.json (wins when it holds an SDK). */
  override?: string;
  /** Replaces the built-in system locations (`/usr/share/dotnet`, ...); tests use it to stay hermetic. */
  systemRoots?: string[];
}

/** Compares dotted versions with an optional `-preview` suffix (a release sorts after its previews). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [num = '', pre = ''] = v.split(/-(.*)/s);
    return { n: num.split('.').map((x) => Number.parseInt(x, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) {
    const d = (x.n[i] ?? 0) - (y.n[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const VERSION_DIR = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** SDKs and runtimes of one install root, or null when it has neither. */
export function inspectDotnetRoot(root: string): DotnetInstall | null {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return null;
  }
  const sdks = listDir(join(real, 'sdk')).filter((v) => VERSION_DIR.test(v));
  const runtimes = listDir(join(real, 'shared', 'Microsoft.NETCore.App')).filter((v) => VERSION_DIR.test(v));
  if (!sdks.length && !runtimes.length) return null;
  return { root: real, sdks: sdks.sort(compareVersions), runtimes: runtimes.sort(compareVersions) };
}

/** Where .NET usually lives on Linux and macOS, plus `$DOTNET_ROOT`, `~/.dotnet` and the root behind `dotnet` on PATH. */
export function dotnetCandidates(o: DotnetDetectOptions = {}): string[] {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const out: string[] = [];
  if (env.DOTNET_ROOT) out.push(env.DOTNET_ROOT);
  out.push(
    join(home, '.dotnet'),
    ...(o.systemRoots ?? [
      '/usr/share/dotnet',
      '/usr/lib/dotnet',
      '/usr/local/share/dotnet',
      '/opt/dotnet',
      '/opt/homebrew/share/dotnet',
      '/opt/homebrew/opt/dotnet/libexec',
      '/usr/local/opt/dotnet/libexec',
    ]),
  );
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    // `/usr/local/bin/dotnet` -> `/usr/share/dotnet/dotnet`: the root is the folder of the real executable
    try {
      out.push(dirname(realpathSync(join(dir, 'dotnet'))));
    } catch {
      /* no dotnet in this PATH entry */
    }
  }
  return out;
}

const expandHome = (p: string, home: string): string =>
  resolve(p.startsWith('~') ? join(home, p.slice(1)) : p);

/**
 * Picks the root for agents: the `dotnetRoot` override when it holds an SDK; else the install whose SDK set covers
 * the most versions (a superset of the others when there is one); a tie goes to the highest SDK.
 */
export function selectDotnet(o: DotnetDetectOptions = {}): DotnetSelection {
  const home = o.home ?? homedir();
  if ((o.platform ?? process.platform) === 'win32') return { all: [] };
  const seen = new Set<string>();
  const all: DotnetInstall[] = [];
  for (const c of dotnetCandidates(o)) {
    const i = inspectDotnetRoot(expandHome(c, home));
    if (i && !seen.has(i.root)) {
      seen.add(i.root);
      all.push(i);
    }
  }
  if (o.override) {
    const i = inspectDotnetRoot(expandHome(o.override, home));
    if (i?.sdks.length)
      return { chosen: i, all: all.some((a) => a.root === i.root) ? all : [...all, i], reason: 'config' };
  }
  const withSdk = all.filter((i) => i.sdks.length);
  if (!withSdk.length) return { all };
  const max = (i: DotnetInstall) => i.sdks[i.sdks.length - 1] ?? '0';
  const ranked = [...withSdk].sort(
    (a, b) => b.sdks.length - a.sdks.length || compareVersions(max(b), max(a)),
  );
  const best = ranked[0] as DotnetInstall;
  const reason =
    withSdk.length === 1
      ? 'only'
      : withSdk.every((i) => i.sdks.every((v) => best.sdks.includes(v)))
        ? 'superset'
        : best.sdks.length > (ranked[1] as DotnetInstall).sdks.length
          ? 'most-sdks'
          : 'highest-sdk';
  return { chosen: best, all, reason };
}

/** True when the current user can add files to the root (a user-level install such as `~/.dotnet`). */
export function dotnetRootWritable(root: string): boolean {
  try {
    accessSync(root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `PATH` with the .NET root first. */
export function pathWithDotnet(path: string | undefined, root: string): string {
  return [root, ...(path ?? '').split(delimiter).filter((p) => p && p !== root)].join(delimiter);
}

/** `~/.dotnet` for a path under the home folder. */
export function shortPath(p: string, home: string = homedir()): string {
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** One line for reports and agent instructions: `8.0.425, 10.0.401 (~/.dotnet)`. */
export function describeDotnet(i: DotnetInstall, home?: string): string {
  return `${i.sdks.join(', ')} (${shortPath(i.root, home)})`;
}

/** Process env that makes `dotnet` use this root (the muxer resolves SDKs only inside its own root). */
export function dotnetProcessEnv(i: DotnetInstall, path: string | undefined): Record<string, string> {
  return { DOTNET_ROOT: i.root, PATH: pathWithDotnet(path, i.root) };
}

// ------------------------------------------------------------------------------------- what a project needs

export interface DotnetNeeds {
  /** `sdk.version` of global.json. */
  globalVersion?: string;
  rollForward?: string;
  /** Major versions of the target frameworks (net8.0 -> 8). */
  tfmMajors: number[];
}

/** Parses `8.0.425` into major, minor and the feature band (hundreds of the patch). */
function parts(v: string): { major: number; minor: number; band: number; patch: number } {
  const [a = 0, b = 0, c = 0] = (v.split('-')[0] ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  return { major: a, minor: b, band: Math.floor(c / 100), patch: c };
}

/** Does an installed SDK satisfy `global.json`'s version under its `rollForward` policy (default `latestPatch`)? */
export function sdkSatisfies(installed: string, want: string, rollForward = 'latestPatch'): boolean {
  const i = parts(installed);
  const w = parts(want);
  const ge = compareVersions(installed.split('-')[0] ?? '', want.split('-')[0] ?? '') >= 0;
  switch (rollForward.toLowerCase()) {
    case 'disable':
      return compareVersions(installed, want) === 0;
    case 'patch':
    case 'latestpatch':
      return i.major === w.major && i.minor === w.minor && i.band === w.band && i.patch >= w.patch;
    case 'feature':
    case 'latestfeature':
      return i.major === w.major && i.minor === w.minor && ge;
    case 'minor':
    case 'latestminor':
      return i.major === w.major && ge;
    default: // major, latestMajor
      return ge;
  }
}

export interface DotnetGap {
  /** Short texts for the report: `missing SDK 10.0.100 (global.json)`. */
  problems: string[];
  /** Channels (`10.0`) dotnet-install.sh has to fetch as SDKs to close the gaps. */
  channels: string[];
  /** Runtime-only gaps (an SDK of that channel is not needed): fetched with `--runtime dotnet`. */
  runtimeChannels: string[];
}

/** What the chosen root lacks for a project: the SDK global.json asks for, an SDK new enough for the target frameworks, the runtimes. */
export function dotnetGaps(install: DotnetInstall | undefined, needs: DotnetNeeds): DotnetGap {
  const gap: DotnetGap = { problems: [], channels: [], runtimeChannels: [] };
  const sdks = install?.sdks ?? [];
  const runtimes = install?.runtimes ?? [];
  if (needs.globalVersion) {
    const ok = sdks.some((v) => sdkSatisfies(v, needs.globalVersion as string, needs.rollForward));
    if (!ok) {
      gap.problems.push(`missing SDK ${needs.globalVersion} (global.json)`);
      const p = parts(needs.globalVersion);
      gap.channels.push(`${p.major}.${p.minor}`);
    }
  }
  const top = needs.tfmMajors.length ? Math.max(...needs.tfmMajors) : undefined;
  if (top !== undefined && top >= 5 && !sdks.some((v) => parts(v).major >= top)) {
    gap.problems.push(`missing SDK ${top}.0 (target framework net${top}.0)`);
    if (!gap.channels.includes(`${top}.0`)) gap.channels.push(`${top}.0`);
  }
  for (const m of [...new Set(needs.tfmMajors)].sort((a, b) => a - b)) {
    if (m < 5) continue; // netcoreapp3.1 and older are not served by the current SDKs
    if (!runtimes.some((r) => parts(r).major === m)) {
      gap.problems.push(`missing runtime ${m}.0`);
      if (!gap.channels.some((c) => c.startsWith(`${m}.`))) gap.runtimeChannels.push(`${m}.0`);
    }
  }
  return gap;
}
