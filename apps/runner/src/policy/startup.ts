import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import type { Policy } from './schema.ts';

/**
 * The start-up check (R18-P, R21): at start and again after `welcome`. A runner whose user is root-equivalent (uid 0,
 * passwordless sudo, the docker group, a writable Docker socket) turns a single approved mistake into root; a runner whose
 * files another user can write can be changed under it. With local `startupRefusal` (written by the 1.10.0 installer and
 * by `setup`) or a server that requires signed runners (the server may narrow, never widen) the runner refuses: it
 * connects only to report why, runs nothing and exits 78 (`RestartPreventExitStatus=78`). `acceptRootEquivalent` (a
 * typed local confirmation) lets a root-equivalent runner start with a warning; it never overrides the "writable by
 * another user" checks. Otherwise (a self-hosted runner that updated itself and never ran `setup`) it only warns.
 */

export const STARTUP_REFUSED_EXIT = 78;

export interface HostFacts {
  uid: number | null;
  /** `sudo -n true` succeeded: sudo without a password. */
  passwordlessSudo: boolean;
  groups: string[];
  /** A Docker socket this user can write (`/var/run/docker.sock` or the `DOCKER_HOST` unix socket), or null. */
  writableDockerSocket: string | null;
  /** Files or folders that matter (runner root, policy.json, admin tools) and that another user can write. */
  writableByOthers: string[];
  /** The account this runner runs as (absent: unknown, the check below is skipped). */
  user?: string;
}

/**
 * Named runner instances: a policy.json written for another dedicated runner user (the other instance's, say UAT's
 * under production) is foreign. It is treated like a file another user can write: refused when the check refuses, a
 * warning otherwise. A current-user policy names the person and is not checked here.
 */
export function foreignPolicyReason(
  policy: Pick<Policy, 'runnerUser'>,
  user: string | undefined,
): string | null {
  const ru = policy.runnerUser;
  if (!user || !ru || ru.mode !== 'dedicated' || ru.name === user) return null;
  return `policy.json belongs to the runner user ${ru.name}, not ${user} (another runner instance's files)`;
}

export function rootEquivalentReasons(f: HostFacts): string[] {
  const out: string[] = [];
  if (f.uid === 0) out.push('runs as root (uid 0)');
  if (f.passwordlessSudo) out.push('has sudo without a password');
  if (f.groups.includes('docker')) out.push('is in the docker group');
  if (f.writableDockerSocket) out.push(`can write the Docker socket ${f.writableDockerSocket}`);
  return out;
}

export type StartupDecision =
  | { action: 'ok' }
  | { action: 'warn'; reasons: string[] }
  | { action: 'refuse'; reason: string };

export const STARTUP_FIX =
  'reinstall with the dedicated runner user (--runner-user dedicated), or confirm on the machine with `guildwise-runner setup` (typed confirmation)';

export function decideStartup(i: {
  facts: HostFacts;
  policy: Pick<Policy, 'startupRefusal' | 'acceptRootEquivalent'> & Partial<Pick<Policy, 'runnerUser'>>;
  /** A server of this machine said "Only signed runners" is on (cached from `welcome`). */
  serverRequiresSigned: boolean;
}): StartupDecision {
  const rootEq = rootEquivalentReasons(i.facts);
  const unsafe = i.facts.writableByOthers.map((p) => `${p} is writable by another user`);
  const foreign = foreignPolicyReason(i.policy, i.facts.user);
  if (foreign) unsafe.unshift(foreign);
  const refusing = i.policy.startupRefusal === true || i.serverRequiresSigned;
  if (refusing) {
    if (unsafe.length)
      return { action: 'refuse', reason: `unsafe files: ${unsafe.join('; ')}`.slice(0, 300) };
    if (rootEq.length && !i.policy.acceptRootEquivalent)
      return {
        action: 'refuse',
        reason: `the runner user is root-equivalent: it ${rootEq.join(', ')}; ${STARTUP_FIX}`.slice(0, 300),
      };
  }
  const reasons = [...rootEq.map((r) => `the runner user ${r}`), ...unsafe];
  return reasons.length ? { action: 'warn', reasons } : { action: 'ok' };
}

/** Group or other may write it, or it belongs to a user other than this one and root. */
export function writableByOthers(path: string, uid: number | null): boolean {
  try {
    const s = statSync(path);
    if (s.mode & 0o022) return true;
    return uid !== null && s.uid !== uid && s.uid !== 0;
  } catch {
    return false;
  }
}

function sudoNonInteractive(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn('sudo', ['-n', 'true'], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    p.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

function groupNames(user: string, gids: number[]): string[] {
  // /etc/group: name:x:gid:members
  try {
    const out = new Set<string>();
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const [name, , gid, members] = line.split(':');
      if (!name) continue;
      if (gids.includes(Number(gid)) || (members ?? '').split(',').includes(user)) out.add(name);
    }
    return [...out];
  } catch {
    return [];
  }
}

function writableSocket(env: NodeJS.ProcessEnv): string | null {
  const candidates = ['/var/run/docker.sock', '/run/docker.sock'];
  const host = env.DOCKER_HOST ?? '';
  if (host.startsWith('unix://')) candidates.unshift(host.slice('unix://'.length));
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      accessSync(c, constants.W_OK);
      return c;
    } catch {
      // not writable
    }
  }
  return null;
}

/** Looks at this machine (POSIX; on Windows only the file checks apply). */
export async function probeHost(o: {
  /** Paths whose owner and mode matter: the runner root, policy.json and its folder, the admin tools. */
  paths: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<HostFacts> {
  const env = o.env ?? process.env;
  const posix = process.platform !== 'win32' && typeof process.getuid === 'function';
  const uid = posix ? (process.getuid?.() ?? null) : null;
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return '';
    }
  })();
  return {
    uid,
    passwordlessSudo: posix && uid !== 0 ? await sudoNonInteractive() : false,
    groups: posix ? groupNames(user, process.getgroups?.() ?? []) : [],
    writableDockerSocket: posix ? writableSocket(env) : null,
    writableByOthers: o.paths.filter((p) => existsSync(p) && writableByOthers(p, uid)),
    ...(posix && user ? { user } : {}),
  };
}
