import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { BROWSER_MASKED, DEVOPS_INHERITED_ENV, HOME_SECRETS, onPath } from '../adapters/claude-policy.ts';
import { SECRETISH } from '../toolchain/registry.ts';

/**
 * The service sandbox (docs/design/run-and-integration-tests.md, D10): setup steps and services of a run environment run
 * under the runner's own bubblewrap profile, not the DevOps engineer's session sandbox. Compared with an agent's shell:
 * - the host network (no `--unshare-net`): a dev server must listen on a port a browser can reach;
 * - the same unreadable set (credential folders in the real home, the runner's data dir), plus the sockets that would
 *   let a process break out: the system and session buses, systemd's user manager (`systemd-run --user` would start a
 *   unit outside the sandbox) and Docker's socket (Unix sockets are not filtered here, unlike in an agent's shell);
 * - writes only to the run worktrees, the shared package caches and a private run tmp dir (bound over `/tmp`);
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
  /** OS user id for `/run/user/<uid>` (injectable for tests). */
  uid?: number;
}

/** Directories and files that stay out of reach, skipping the ones that do not exist (bwrap cannot create them). */
export function maskedPaths(spec: Pick<SandboxSpec, 'runnerRoot' | 'realHome' | 'uid'>): string[] {
  const uid = spec.uid ?? process.getuid?.();
  const all = [
    spec.runnerRoot,
    ...HOME_SECRETS.map((p) => join(spec.realHome, p)),
    ...BROWSER_MASKED,
    ...(uid !== undefined ? [`/run/user/${uid}`] : []),
  ];
  return [...new Set(all)].filter((p) => {
    try {
      return !lstatSync(p).isSymbolicLink(); // a symlink is masked through its target (listed separately)
    } catch {
      return false;
    }
  });
}

/** The bubblewrap arguments (without the command); the command follows `--`. */
export function bwrapArgs(spec: SandboxSpec): string[] {
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
  for (const g of spec.gitDirs ?? []) if (existsSync(g)) args.push('--ro-bind', g, g);
  args.push('--bind', spec.runTmp, '/tmp');
  for (const w of [...spec.worktrees, spec.cacheRoot]) args.push('--bind', w, w);
  return args;
}

/** `bwrap <args> -- cmd...` */
export function sandboxCommand(spec: SandboxSpec, argv: string[]): { cmd: string; args: string[] } {
  return { cmd: 'bwrap', args: [...bwrapArgs(spec), '--', ...argv] };
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

  constructor(
    private readonly opts: {
      platform?: NodeJS.Platform;
      pathVar?: string;
      probeBwrap?: () => Promise<boolean>;
      probeScope?: () => Promise<boolean>;
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
