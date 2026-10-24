import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gitAdminDirOf } from '../adapters/codex.ts';
import { scanMasksFor } from '../adapters/read-only-dirs.ts';
import { protectedGitPaths } from '../git/harden.ts';

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
  /**
   * A CLI that starts its shell by absolute path (`/bin/bash`, Codex) never looks in PATH: the shim is mounted over the box's own
   * `bash` instead, and the real shell is reachable only at `REAL_SHELL_IN_BOX` (the shim runs it in the nested sandbox).
   */
  shellOverride?: { shim: string; real: string };
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
  if (i.shellOverride) {
    args.push('--ro-bind', i.shellOverride.real, REAL_SHELL_IN_BOX);
    // the box's bash (and sh) are the shim: whatever starts `/bin/bash` by its absolute path runs the masked shell
    for (const p of ['/usr/bin/bash', '/bin/bash']) {
      try {
        if (exists(p) && !lstatSync(p).isSymbolicLink() && !lstatSync(dirname(p)).isSymbolicLink())
          args.push('--ro-bind', i.shellOverride.shim, p);
      } catch {
        // not there on this distribution
      }
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
  // The pointers and the configuration git reads (the worktree's `.git` file, `commondir`, `gitdir`, `config`, `hooks` of its
  // administrative folder) are read-only in the box whatever else is writable: git runs later outside the box and a
  // configuration the agent wrote (core.fsmonitor, a hook) would run there (security review, finding 9). A file bound read-only
  // cannot be replaced or removed either.
  for (const p of protectedGitPaths(i.cwd))
    if (inside(i.cwd, p) || i.gitDirs.some((g) => inside(g, p)))
      mounts.push({ kind: 'ro-bind', src: p, dest: p });
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

/** Where the real shell lives inside a box whose `bash` is replaced by the shim. */
export const REAL_SHELL_IN_BOX = '/run/aom-real-bash';

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
  /** The shim's own interpreter. When the shim REPLACES the box's bash (and `sh` is bash) it must not be `/bin/sh`. */
  interpreter = '/bin/sh',
  /** The shell runs only `aom ...` (see `AOM_ONLY_VALIDATOR`): the shim is then the enforcement, whatever the CLI's own rules say. */
  aomOnly?: { trustedScripts: string[] },
): string {
  for (const p of [...hidden, ...unset, realShell, bwrap, ...(aomOnly?.trustedScripts ?? [])])
    if (/['\n]/.test(p))
      throw new Error('a path or name with a quote or a newline cannot go into the shell shim');
  if (aomOnly && !/bash$/.test(interpreter))
    throw new Error('the aom-only shell needs bash as the shim interpreter');
  const list = hidden.map((p) => `'${p}'`).join(' ');
  const unsets = unset.map((v) => `--unsetenv '${v}'`).join(' ');
  const evalLine = String.raw`eval "exec '${bwrap}' --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --bind / / --proc /proc --dev /dev $masks ${unsets} -- '${realShell}' \"\$@\""`;
  return `#!${interpreter}
${aomOnly ? aomOnlyPrologue(aomOnly.trustedScripts) : ''}masks=""
for f in ${list || "''"}; do
  [ -n "$f" ] || continue
  if [ -d "$f" ]; then masks="$masks --tmpfs '$f'"
  elif [ -e "$f" ]; then masks="$masks --ro-bind /dev/null '$f'"; fi
done
${evalLine}
`;
}

/**
 * The shell of a role that has no `shell` tool, and of every chat, in a box where the CLI's own rules cannot be trusted to hold
 * (Codex, whose shell tool always exists): the box's `bash` is this shim, and it runs a command only when the command is exactly
 * `aom` and its arguments, written as plain words or in quotes without any expansion. No `;`, `&&`, `|`, redirection, `$`, backtick,
 * subshell, glob, brace or newline outside quotes, and no `$`, backtick, backslash or `!` inside double quotes, so what runs is the
 * runner's `aom` command and nothing the model composed around it. `bash <script>` is allowed for the runner's own scripts
 * (`trustedScripts`, read-only in the box), which is how a `#!/usr/bin/env bash` helper starts. (Owner decision Q68.)
 */
function aomOnlyPrologue(trustedScripts: string[]): string {
  const trusted = trustedScripts.map((t) => `${t.replace(/\/+$/, '')}/*`).join('|');
  return `aom_refuse() { echo "this agent may run only the aom command in the shell" >&2; exit 126; }
aom_valid() {
  local s="$1" n=\${#1} i=0 c st=0
  case "$s" in aom|"aom "*) ;; *) return 1 ;; esac
  case "$s" in *$'\n'*|*$'\r'*) return 1 ;; esac
  while [ "$i" -lt "$n" ]; do
    c="\${s:$i:1}"; i=$((i+1))
    case $st in
      0) case "$c" in
           [A-Za-z0-9_./:=@%+,-]|" ") ;;
           "'") st=1 ;;
           '"') st=2 ;;
           *) return 1 ;;
         esac ;;
      1) [ "$c" = "'" ] && st=0 ;;
      2) case "$c" in
           '"') st=0 ;;
           '$'|'\`'|'\\'|'!') return 1 ;;
         esac ;;
    esac
  done
  [ "$st" -eq 0 ]
}
aom_orig=("$@")
aom_cmd=""; aom_mode=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -l|--login|--noprofile|--norc) shift ;;
    -c|-lc|-cl) shift; [ "$#" -ge 1 ] || aom_refuse; aom_mode=c; aom_cmd="$1"; shift; break ;;
    -*) aom_refuse ;;
    *) aom_mode=file; break ;;
  esac
done
case "$aom_mode" in
  c) [ "$#" -eq 0 ] || aom_refuse; aom_valid "$aom_cmd" || aom_refuse ;;
  file) ${trusted ? `case "$1" in *..*) aom_refuse ;; ${trusted}) ;; *) aom_refuse ;; esac` : 'aom_refuse'} ;;
  *) aom_refuse ;;
esac
set -- "\${aom_orig[@]}"
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
    // the launcher must not be the masking shim itself: with the shim over `bash`, it runs the real shell
    args: [
      ...harnessBwrapArgs(i),
      '--',
      i.shellOverride ? REAL_SHELL_IN_BOX : '/bin/sh',
      '-c',
      script,
      'sh',
      cmd.bin,
      ...cmd.args,
    ],
    env,
  };
}

/** Which `bash` the shim wraps: the host's, found in the standard places (inside the sandbox `/usr` and the links are there). */
export function realShellPath(): string {
  for (const p of ['/usr/bin/bash', '/bin/bash']) if (exists(p)) return p;
  return '/bin/sh';
}
