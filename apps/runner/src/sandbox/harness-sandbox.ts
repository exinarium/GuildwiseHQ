import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gitAdminDirOf } from '../adapters/codex.ts';
import { scanMasksFor } from '../adapters/read-only-dirs.ts';

/**
 * An OS sandbox for a whole agent CLI (Gemini CLI, opencode): bubblewrap around the CLI process itself, so the CLI, its tools and
 * every command it starts share one set of guarantees that the runner owns instead of whatever the CLI offers (docs/RUNNER.md,
 * "Sandbox parity of the other runtimes"). Claude Code and Codex sandbox only the agent's shell; these CLIs have no such split,
 * so the model traffic goes through the box as well, by the egress proxy (`egress-proxy.ts`).
 *
 * What the process sees:
 * - a filesystem that is empty except for: `/usr` and the system links (read-only), `/etc` (read-only), a fresh `/proc` and `/dev`,
 *   a private `/tmp`, and the paths below, each at its own absolute path;
 * - writable: the working folder (read-only for a role that cannot edit), the agent's private home, scratch and temp folders, the
 *   shared package caches, the harness's own state folder and, for a role that commits, the worktree's git admin folder, `objects`,
 *   `refs` and `logs` of the main repository (its `config` and `hooks` stay read-only);
 * - read-only: the toolchain folders, the runner's `bin/` and the `aom` script's folder, the CLI's install, the vault and the
 *   reference repositories (their secret files masked with /dev/null, whole folders that are too big to check left out);
 * - NOT there: the owner's home, the runner's data directory with its token and secrets, other agents' folders, `~/.ssh`, the Docker
 *   socket, other users' processes (new PID namespace), the host network (a new network namespace with only a loopback that reaches
 *   the egress proxy).
 * The files named in `hiddenFromShell` (the CLI's own login) exist for the CLI but not for the commands it starts: the shell is
 * a shim that runs the real shell in a second sandbox with those paths masked.
 */
export interface HarnessSandboxInput {
  cwd: string;
  /** The working folder is read-only: no edit tool, or a chat. */
  readOnlyCwd: boolean;
  home: string;
  scratch: string;
  tmp: string;
  cacheRoot?: string;
  /** More writable folders: the CLI's own state folder. */
  writable: string[];
  /** Read-only folders: toolchain, runner bin, the CLI install, the vault, added folders. */
  readonly: string[];
  /** Reference repositories (read-only, secret files masked). */
  readDirs: string[];
  /** The main repositories' `.git` dirs of a linked worktree. */
  gitDirs: string[];
  /** The agent commits: the worktree's git admin folder, objects, refs and logs become writable. */
  mayCommit: boolean;
  /** The runner's IPC socket, for the `aom` command. */
  ipcSocket?: string;
  /** The egress proxy's Unix socket on the host. */
  proxySocket: string;
  /** The loopback port the bridge listens on inside the sandbox. */
  bridgePort: number;
  /** Paths the CLI needs but its shell must not see (files or folders). */
  hiddenFromShell: string[];
  /** Where the shell shim lives (a folder the runner wrote, mounted read-only first in `PATH`). Needed with `hiddenFromShell`. */
  shimDir?: string;
  nugetFallbackDir?: string;
  dotnetShmDir?: string;
  /** The `bwrap` binary (default: `bwrap` on PATH). */
  bwrap?: string;
}

/** System folders every program needs. Links (merged /usr) are recreated as links, real folders are bound read-only. */
const SYSTEM_DIRS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

const inside = (parent: string, child: string): boolean => {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(`${p}/`);
};

type Mount = { kind: 'bind' | 'ro-bind' | 'tmpfs' | 'ro-null'; src?: string; dest: string };

/**
 * The bubblewrap arguments (up to and excluding the `--` before the command). Pure apart from reading the host's system links and
 * scanning the reference repositories for secret files; unit tested with the real bubblewrap.
 */
export function harnessBwrapArgs(i: HarnessSandboxInput): string[] {
  const args: string[] = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/etc',
    '/etc',
  ];
  for (const d of SYSTEM_DIRS) {
    try {
      if (lstatSync(d).isSymbolicLink()) args.push('--symlink', readlinkSync(d), d);
      else if (exists(d)) args.push('--ro-bind', d, d);
    } catch {
      // absent on this distribution
    }
  }
  const mounts: Mount[] = [];
  const bind = (p: string, writable: boolean): void => {
    if (exists(p)) mounts.push({ kind: writable ? 'bind' : 'ro-bind', src: p, dest: p });
  };
  bind(i.cwd, !i.readOnlyCwd);
  for (const p of [i.home, i.tmp]) bind(p, true);
  // the scratch folder is writable unless it IS the (read-only) working folder
  if (!(i.readOnlyCwd && (inside(i.scratch, i.cwd) || inside(i.cwd, i.scratch)))) bind(i.scratch, true);
  if (i.cacheRoot) bind(i.cacheRoot, true);
  if (i.dotnetShmDir) bind(i.dotnetShmDir, true);
  for (const p of i.writable) bind(p, true);
  for (const p of i.readonly) bind(p, false);
  if (i.nugetFallbackDir) bind(i.nugetFallbackDir, false);
  if (i.ipcSocket) bind(dirname(i.ipcSocket), false);
  bind(dirname(i.proxySocket), false);
  if (i.shimDir) mounts.push({ kind: 'ro-bind', src: i.shimDir, dest: i.shimDir });
  // reference repositories: read-only, secret files masked; a clone too big to check is not opened at all
  for (const d of i.readDirs) {
    const masks = scanMasksFor(d);
    if (!masks) continue;
    bind(d, false);
    for (const f of masks.files) mounts.push({ kind: 'ro-null', dest: f });
    for (const dir of masks.dirs) mounts.push({ kind: 'tmpfs', dest: dir });
  }
  // git: a linked worktree commits into <repo>/.git/worktrees/<name>, objects, refs and logs; config and hooks stay read-only
  const admin = gitAdminDirOf(i.cwd);
  for (const common of i.gitDirs) {
    bind(common, false);
    if (i.mayCommit && !i.readOnlyCwd && admin) {
      for (const p of [admin, `${common}/objects`, `${common}/refs`, `${common}/logs`]) bind(p, true);
    }
  }
  // parents before children, so a read-only parent never hides a writable child bound earlier
  mounts.sort((a, b) => a.dest.length - b.dest.length);
  const seen = new Set<string>();
  for (const m of mounts) {
    const key = `${m.kind}:${m.dest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.kind === 'bind') args.push('--bind', m.src as string, m.dest);
    else if (m.kind === 'ro-bind') args.push('--ro-bind', m.src as string, m.dest);
    else if (m.kind === 'ro-null') args.push('--ro-bind', '/dev/null', m.dest);
    else args.push('--tmpfs', m.dest);
  }
  return args;
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell shim: what the CLI finds as `bash` (and `sh`) first in PATH. It runs the real shell in a second sandbox of its own, in
 * which the paths in `hidden` are masked (a file with /dev/null, a folder with an empty tmpfs) and the variables in `unset` do not
 * exist. The commands the model runs therefore never see the CLI's login, even though the CLI itself needs it. The masks are chosen
 * when each command starts, so a file the CLI creates during the session (a migrated login) is hidden from then on too.
 */
export function shellShimScript(
  realShell: string,
  hidden: string[],
  unset: string[],
  bwrap = 'bwrap',
): string {
  for (const p of [...hidden, ...unset, realShell, bwrap])
    if (/['\n]/.test(p))
      throw new Error('a path or name with a quote or a newline cannot go into the shell shim');
  const list = hidden.map((p) => `'${p}'`).join(' ');
  const unsets = unset.map((v) => `--unsetenv '${v}'`).join(' ');
  const evalLine = String.raw`eval "exec '${bwrap}' --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --bind / / --proc /proc --dev /dev $masks ${unsets} -- '${realShell}' \"\$@\""`;
  return `#!/bin/sh
masks=""
for f in ${list || "''"}; do
  [ -n "$f" ] || continue
  if [ -d "$f" ]; then masks="$masks --tmpfs '$f'"
  elif [ -e "$f" ]; then masks="$masks --ro-bind /dev/null '$f'"; fi
done
${evalLine}
`;
}

export interface WrappedCommand {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

/** The environment that sends the CLI and every command it starts through the bridge. */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    ALL_PROXY: url,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    // Node 24+: make fetch and http honour the variables above
    NODE_USE_ENV_PROXY: '1',
  };
}

/**
 * `bwrap <sandbox> -- sh -c '<bridge>; exec "$@"' sh <bin> <args>`: the bridge (`socat`) turns the loopback port into the proxy
 * socket and dies with the sandbox.
 */
export function wrapInHarnessSandbox(
  i: HarnessSandboxInput,
  cmd: { bin: string; args: string[]; env: Record<string, string> },
): WrappedCommand {
  const bridge = `socat TCP-LISTEN:${i.bridgePort},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${sq(i.proxySocket)} >/dev/null 2>&1 &`;
  // give the bridge a moment to listen before the CLI makes its first request
  const script = `${bridge} sleep 0.2; exec "$@"`;
  const env = { ...cmd.env };
  if (i.shimDir) env.PATH = `${i.shimDir}:${env.PATH ?? '/usr/bin:/bin'}`;
  return {
    bin: i.bwrap ?? 'bwrap',
    args: [...harnessBwrapArgs(i), '--', '/bin/sh', '-c', script, 'sh', cmd.bin, ...cmd.args],
    env,
  };
}

/** Which `bash` the shim wraps: the host's, found in the standard places (inside the sandbox `/usr` and the links are there). */
export function realShellPath(): string {
  for (const p of ['/usr/bin/bash', '/bin/bash']) if (exists(p)) return p;
  return '/bin/sh';
}
