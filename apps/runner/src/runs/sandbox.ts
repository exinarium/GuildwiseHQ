import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve as resolvePath, sep } from 'node:path';
import {
  containerRuntimeMasks,
  DEVOPS_INHERITED_ENV,
  HOME_SECRETS,
  onPath,
} from '../adapters/claude-policy.ts';
import { SECRETISH } from '../toolchain/registry.ts';

/**
 * The service sandbox (docs/design/run-and-integration-tests.md, D10): setup steps and services of a run environment run
 * under the runner's own bubblewrap profile, not the DevOps engineer's session sandbox. Compared with an agent's shell:
 * - the host network (no `--unshare-net`): a dev server must listen on a port a browser can reach;
 * - the same unreadable set (credential folders in the real home, the runner's data dir), plus the sockets that would
 *   let a process break out: the system and session buses, systemd's user manager (`systemd-run --user` would start a
 *   unit outside the sandbox) and Docker's socket (Unix sockets are not filtered here, unlike in an agent's shell);
 * - writes only to the run worktrees, the shared package caches and a private run tmp dir (bound over `/tmp`);
 * - read-only access to the .NET user secrets (`~/.microsoft/usersecrets`, shown at the services' HOME): they are the
 *   secrets a developer keeps outside the repository for `dotnet run` in Development, and only run services get them;
 * - NOT `--die-with-parent`: services outlive the runner process and a shift (the runner re-adopts them).
 */

export interface SandboxSpec {
  /** The runner's data dir: unreadable (the worktrees and caches below are re-opened). */
  runnerRoot: string;
  /** The real home of the OS user: its credential folders are unreadable. */
  realHome: string;
  /** Run worktrees (read-write). */
  worktrees: string[];
  /** The shared package caches (`<runner root>/cache`, read-write). */
  cacheRoot: string;
  /** Private tmp dir of the environment: bound over `/tmp`; the services' HOME lives in it. */
  runTmp: string;
  /** The clones' git dirs the linked worktrees point at: readable (git needs them), never writable. */
  gitDirs?: string[];
  /** More paths made readable again (read-only) after the masks, like the toolchains of a hidden home. */
  readOnly?: string[];
  /** OS user id for `/run/user/<uid>` (injectable for tests). */
  uid?: number;
  /** Mount the .NET user secrets (default true). The builder's checks never get them. */
  userSecrets?: boolean;
  /**
   * `host` (default): the host network, as services need. `none`: a network namespace of its own (`--unshare-net`, only
   * loopback): the handoff checks and the worktree preparation, which must never download anything.
   */
  network?: 'host' | 'none';
  /**
   * More paths to make unreadable, like the runner root (release prep: the machine data dir, so sibling pairings stay
   * hidden). Masked before every other path, so a parent mask never covers a child mask made earlier.
   */
  extraMasked?: string[];
  /** `--die-with-parent`: the command's tree ends with the runner. Off by default (services outlive the runner). */
  dieWithParent?: boolean;
  /** The resolver config to make reachable (default `/etc/resolv.conf`; injectable for tests). */
  resolvConf?: string;
  /** The system paths that are masked (default `containerRuntimeMasks()`; injectable for tests). */
  systemMasks?: string[];
}

/** The services' HOME inside the sandbox (inside the private `/tmp`). */
export const SERVICE_HOME = '/tmp/home';

/** `~/.microsoft/usersecrets` of the real home: the .NET user secrets that `dotnet run` needs in Development. */
export const userSecretsDir = (realHome: string): string => join(realHome, '.microsoft', 'usersecrets');

/** Directories and files that stay out of reach, skipping the ones that do not exist (bwrap cannot create them). */
export function maskedPaths(
  spec: Pick<SandboxSpec, 'runnerRoot' | 'realHome' | 'uid' | 'extraMasked' | 'systemMasks'>,
): string[] {
  const uid = spec.uid ?? process.getuid?.();
  const all = existingReal([
    ...(spec.extraMasked ?? []),
    spec.runnerRoot,
    ...HOME_SECRETS.map((p) => join(spec.realHome, p)),
    ...(spec.systemMasks ?? containerRuntimeMasks()),
    ...(uid !== undefined ? [`/run/user/${uid}`] : []),
  ]);
  // a mask inside a masked runtime dir (`/run/user/<uid>` under `/run/user`) adds only an empty mount point whose name
  // would show in the parent's listing
  const runtime = all.filter((q) => q.startsWith('/run/') || q.startsWith('/var/run/'));
  return all.filter((p) => !runtime.some((q) => q !== p && p.startsWith(`${q}${sep}`)));
}

/** The real paths of the entries that exist, each once. */
function existingReal(all: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of new Set(all)) {
    try {
      if (lstatSync(p).isSymbolicLink()) continue; // a symlink is masked through its target (listed separately)
      // `/var/run` is usually a link to `/run`: two spellings of one file are masked once (bwrap cannot create the
      // second mount point under a path it has already covered).
      const real = realpathSync(p);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(real);
    } catch {
      // not there: nothing to mask
    }
  }
  return out;
}

const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + sep);

/**
 * What name resolution needs in a sandbox that masks system paths. On systemd-resolved hosts `/etc/resolv.conf` links
 * into `/run/systemd/resolve/`, which the mask hides, so the link dangles and every lookup fails. When the file resolves
 * to a regular file under a masked system path, exactly that file is bound read-only (never its folder, which holds
 * resolved's sockets; never a file under the runner's root, home secrets or `/run/user`). A missing or dangling config
 * gives a warning and no bind.
 */
export function resolverMount(
  resolvConf: string,
  systemMasked: string[],
  otherMasked: string[],
): { bind?: string; warning?: string } {
  const unavailable = (why: string) => ({
    warning: `run sandbox: DNS unavailable, ${resolvConf} ${why}`,
  });
  let real: string;
  try {
    real = realpathSync(resolvConf);
  } catch {
    try {
      const target = resolvePath(dirname(resolvConf), readlinkSync(resolvConf));
      const hidden = systemMasked.some((m) => under(target, m));
      return unavailable(
        hidden
          ? `points into masked ${systemMasked.find((m) => under(target, m))} and the target is missing`
          : `points at ${target}, which does not exist`,
      );
    } catch {
      return unavailable('does not exist');
    }
  }
  if (otherMasked.some((m) => under(real, m))) return unavailable(`points into a masked path (${real})`);
  const dir = systemMasked.find((m) => under(real, m));
  if (!dir) return {}; // a plain file or a link into the visible filesystem: nothing to do
  try {
    if (!statSync(real).isFile()) return unavailable(`points into masked ${dir} and is not a regular file`);
  } catch {
    return unavailable(`points into masked ${dir} and cannot be read`);
  }
  return { bind: real };
}

/** The bubblewrap arguments (without the command); the command follows `--`. */
export function bwrapArgs(spec: SandboxSpec): string[] {
  return bwrapSetup(spec).args;
}

function bwrapSetup(spec: SandboxSpec): { args: string[]; warning?: string } {
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--unshare-ipc',
    ...(spec.network === 'none' ? ['--unshare-net'] : []),
    ...(spec.dieWithParent ? ['--die-with-parent'] : []),
    '--cap-drop',
    'ALL',
  ];
  for (const p of maskedPaths(spec)) {
    try {
      if (lstatSync(p).isDirectory()) args.push('--tmpfs', p);
      else args.push('--ro-bind', '/dev/null', p);
    } catch {
      // gone meanwhile
    }
  }
  // DNS: after the masks, so the one file shows through the tmpfs. Not for `none`: no network, no lookups to serve.
  let warning: string | undefined;
  if (spec.network !== 'none') {
    const systemMasked = existingReal(spec.systemMasks ?? containerRuntimeMasks());
    const uid = spec.uid ?? process.getuid?.();
    const otherMasked = existingReal([
      spec.runnerRoot,
      ...HOME_SECRETS.map((p) => join(spec.realHome, p)),
      ...(uid !== undefined ? [`/run/user/${uid}`] : []),
    ]);
    const m = resolverMount(spec.resolvConf ?? '/etc/resolv.conf', systemMasked, otherMasked);
    if (m.bind) args.push('--ro-bind', m.bind, m.bind);
    warning = m.warning;
  }
  // a re-open never exposes a masked path again: an entry that is a masked path or holds one is dropped
  const masks = maskedPaths(spec);
  const safe = (spec.readOnly ?? []).filter((r) => !masks.some((m) => m === r || m.startsWith(`${r}${sep}`)));
  for (const g of [...(spec.gitDirs ?? []), ...safe]) if (existsSync(g)) args.push('--ro-bind', g, g);
  args.push('--bind', spec.runTmp, '/tmp');
  for (const w of [...spec.worktrees, spec.cacheRoot]) args.push('--bind', w, w);
  // .NET user secrets (`dotnet run` in Development reads them): read-only, at the services' HOME. Services only: an
  // agent's shell never gets them.
  const secrets = userSecretsDir(spec.realHome);
  if (spec.userSecrets !== false && existsSync(secrets))
    args.push('--ro-bind', secrets, `${SERVICE_HOME}/.microsoft/usersecrets`);
  return { args, warning };
}

/** The clone's git dir a linked worktree points at (`<clone>/.git`), so a sandboxed `git` can read it. */
export function gitDirOf(worktree: string): string[] {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(worktree, '.git'), 'utf8'));
    if (!m) return [];
    // <clone>/.git/worktrees/<name>  ->  <clone>/.git
    return [resolvePath(m[1] as string, '..', '..')];
  } catch {
    return [];
  }
}

/** `bwrap <args> -- cmd...` */
export function sandboxCommand(
  spec: SandboxSpec,
  argv: string[],
): { cmd: string; args: string[]; warning?: string } {
  const { args, warning } = bwrapSetup(spec);
  return { cmd: 'bwrap', args: [...args, '--', ...argv], ...(warning ? { warning } : {}) };
}

/**
 * `systemd-run --user --scope`: the command runs in a scope of its own under the user manager instead of in the runner
 * service's cgroup. The default `KillMode=control-group` of the runner's unit then does not kill the services when the
 * runner restarts or updates itself. The scope is entered by systemd-run itself, so the pid (and the process group the
 * runner made) stay those of the command and the runner can re-adopt it by pid and start time.
 */
export function scopeCommand(unit: string, argv: string[]): { cmd: string; args: string[] } {
  return { cmd: 'systemd-run', args: ['--user', '--scope', '--quiet', `--unit=${unit}`, '--', ...argv] };
}

/** The environment a sandboxed service gets: the runner's, without credentials, buses and the runner's own variables. */
export function scrubEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const drop = new Set<string>([
    ...DEVOPS_INHERITED_ENV,
    'DBUS_SESSION_BUS_ADDRESS',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || drop.has(k)) continue;
    if (k.startsWith('AOM_') || /^(CLAUDE|ANTHROPIC)/.test(k) || SECRETISH.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const run = (cmd: string, args: string[], timeoutMs = 8000): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });

/** What this machine can do for services. Probed once per process (`probe*` are injectable for tests). */
export class ServiceLauncher {
  private bwrap: Promise<boolean> | undefined;
  private scope: Promise<boolean> | undefined;
  private netns: Promise<boolean> | undefined;

  constructor(
    private readonly opts: {
      platform?: NodeJS.Platform;
      pathVar?: string;
      probeBwrap?: () => Promise<boolean>;
      probeScope?: () => Promise<boolean>;
      probeNetns?: () => Promise<boolean>;
      /** `AOM_RUN_NO_SCOPE=1` turns the systemd scope off. */
      noScope?: boolean;
    } = {},
  ) {}

  /** Can a process be started under bubblewrap here (a trial run with the real profile's flags)? */
  sandboxAvailable(): Promise<boolean> {
    this.bwrap ??= (async () => {
      if ((this.opts.platform ?? process.platform) !== 'linux') return false;
      if (this.opts.probeBwrap) return this.opts.probeBwrap();
      if (!onPath('bwrap', this.opts.pathVar ?? process.env.PATH ?? '')) return false;
      return run('bwrap', [
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--unshare-pid',
        'true',
      ]);
    })();
    return this.bwrap;
  }

  /**
   * Can bubblewrap give a process a network namespace of its own here (`--unshare-net`; some hosts forbid unprivileged
   * network namespaces)? Probed once. False: a check runs with the host network and the offline environment only.
   */
  networkIsolationAvailable(): Promise<boolean> {
    this.netns ??= (async () => {
      if (!(await this.sandboxAvailable())) return false;
      if (this.opts.probeNetns) return this.opts.probeNetns();
      return run('bwrap', [
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--unshare-pid',
        '--unshare-net',
        'true',
      ]);
    })();
    return this.netns;
  }

  /** Is the systemd user manager reachable (a trial `systemd-run --user --scope true`)? */
  scopeAvailable(): Promise<boolean> {
    this.scope ??= (async () => {
      if (this.opts.noScope || process.env.AOM_RUN_NO_SCOPE === '1') return false;
      if ((this.opts.platform ?? process.platform) !== 'linux') return false;
      if (this.opts.probeScope) return this.opts.probeScope();
      const path = this.opts.pathVar ?? process.env.PATH ?? '';
      if (!path.split(delimiter).some((d) => d && existsSync(join(d, 'systemd-run')))) return false;
      if (!process.env.XDG_RUNTIME_DIR) return false;
      return run('systemd-run', ['--user', '--scope', '--quiet', 'true']);
    })();
    return this.scope;
  }
}
