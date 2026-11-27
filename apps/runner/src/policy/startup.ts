import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Policy } from './schema.ts';

/**
 * The start-up check (R18-P, R21): at start and again after `welcome`. A runner whose user is root-equivalent (uid 0,
 * passwordless sudo, the docker group, a writable socket of another Docker daemon) turns a single approved mistake into
 * root; the runner's own rootless daemon (its socket under its own /run/user/<uid>, parent 0700) never counts. A shared
 * rootless daemon whose acceptance was recorded at install (policy.json `sharedDocker`, after root's checks) only warns while that daemon
 * reports rootless (owner 2026-11-21). A runner whose
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
  /** Every Docker socket found (DOCKER_HOST, the default ones, /run/user/<uid>, /run/<x>/), by real path. */
  dockerSockets: DockerSocketFact[];
  /** The DOCKER_HOST the runner inherited, before `applyDockerEnv` (a tcp:// or ssh:// one reaches another daemon). */
  inheritedDockerHost?: string;
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

export interface DockerSocketFact {
  /** The path it was found at (a symlink such as /run/docker.sock keeps its own name here). */
  path: string;
  /** realpath of `path`. */
  real: string;
  uid: number;
  gid: number;
  /** This user can write it (and so control that daemon). */
  writable: boolean;
  /** The runner's own rootless socket: under its own runtime dir, owned by it, parent owned by it at 0700. */
  own: boolean;
  /** Owner's user name, and the group's name when that group is one of this user's groups. */
  owner?: string;
  group?: string;
  /** `docker info` through it reports `name=rootless` (asked only for the accepted shared socket). */
  rootless?: boolean;
}

type DockerPolicy = Partial<Pick<Policy, 'docker' | 'sharedDocker'>>;

/** The accepted shared rootless daemon (owner 2026-11-21): only exactly the recorded socket, only while rootless. */
export function acceptedShared(s: DockerSocketFact, policy: DockerPolicy): boolean {
  return policy.docker === 'shared' && policy.sharedDocker?.socket === s.real && s.rootless === true;
}

export function rootEquivalentReasons(f: HostFacts, policy: DockerPolicy = {}): string[] {
  const out: string[] = [];
  if (f.uid === 0) out.push('runs as root (uid 0)');
  if (f.passwordlessSudo) out.push('has sudo without a password');
  if (f.groups.includes('docker')) out.push('is in the docker group');
  for (const s of f.dockerSockets) {
    if (s.own || !s.writable || acceptedShared(s, policy)) continue;
    const who = [`owner ${s.owner ?? s.uid}`, ...(s.group ? [`through group ${s.group}`] : [])].join(', ');
    out.push(`can write the Docker socket ${s.real} of another daemon (${who})`);
  }
  const h = f.inheritedDockerHost ?? '';
  if (/^(tcp|ssh|https?):\/\//.test(h) && policy.docker !== 'host')
    out.push(`inherited DOCKER_HOST ${h.replace(/\/\/[^@/]*@/, '//')} reaches another Docker daemon`);
  return out;
}

/** The warning line for an accepted shared rootless daemon (never a refusal). */
export function sharedDockerWarnings(f: HostFacts, policy: DockerPolicy): string[] {
  return f.dockerSockets
    .filter((s) => s.writable && acceptedShared(s, policy))
    .map(
      (s) =>
        `uses the shared rootless Docker daemon ${s.real} (accepted at install${s.group ? `, group ${s.group}` : ''}): it can control every container on that daemon`,
    );
}

export type StartupDecision =
  | { action: 'ok' }
  | { action: 'warn'; reasons: string[] }
  | { action: 'refuse'; reason: string };

export const STARTUP_FIX =
  'reinstall with the dedicated runner user (--runner-user dedicated), or confirm on the machine with `guildwise-runner setup` (typed confirmation)';

export function decideStartup(i: {
  facts: HostFacts;
  policy: Pick<Policy, 'startupRefusal' | 'acceptRootEquivalent'> &
    Partial<Pick<Policy, 'runnerUser' | 'docker' | 'sharedDocker'>>;
  /** A server of this machine said "Only signed runners" is on (cached from `welcome`). */
  serverRequiresSigned: boolean;
}): StartupDecision {
  const rootEq = rootEquivalentReasons(i.facts, i.policy);
  const shared = sharedDockerWarnings(i.facts, i.policy);
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
  const reasons = [
    ...rootEq.map((r) => `the runner user ${r}`),
    ...shared.map((r) => `the runner ${r}`),
    ...unsafe,
  ];
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

function lookupName(file: string, id: number): string | undefined {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] && Number(f[2]) === id) return f[0];
    }
  } catch {
    // unreadable: the number is shown instead
  }
  return undefined;
}

/** DOCKER_HOST (a unix one), the default sockets, the own runtime dir's, /run/user/<uid> and /run/<x>/docker.sock. */
export function dockerSocketCandidates(
  env: NodeJS.ProcessEnv,
  uid: number | null,
  runRoot = '/run',
): string[] {
  const out: string[] = [];
  const host = env.DOCKER_HOST ?? '';
  if (host.startsWith('unix://')) out.push(host.slice('unix://'.length));
  // tests give their own run root and never see the machine's sockets
  if (runRoot === '/run') out.push('/var/run/docker.sock');
  out.push(join(runRoot, 'docker.sock'));
  if (env.XDG_RUNTIME_DIR) out.push(join(env.XDG_RUNTIME_DIR, 'docker.sock'));
  if (uid !== null) out.push(join(runRoot, 'user', String(uid), 'docker.sock'));
  try {
    for (const d of readdirSync(runRoot, { withFileTypes: true }))
      if (d.isDirectory() && d.name !== 'user') out.push(join(runRoot, d.name, 'docker.sock'));
  } catch {
    // no /run
  }
  return out;
}

/**
 * Each candidate that exists, resolved and deduplicated by real path. `own` needs all of: the real path is
 * `<own runtime dir>/docker.sock`, the socket and that dir belong to this uid, and the dir is 0700 (so no symlink from
 * there to another daemon, and no other user's socket, ever counts as the runner's own).
 */
export function collectDockerSockets(o: {
  candidates: string[];
  uid: number | null;
  gids: number[];
  /** The runner's own runtime dirs (`/run/user/<uid>`, `$XDG_RUNTIME_DIR`). */
  runtimeDirs: string[];
  passwdFile?: string;
  groupFile?: string;
}): DockerSocketFact[] {
  const seen = new Map<string, DockerSocketFact>();
  const own = new Set(
    o.runtimeDirs.flatMap((d) => {
      try {
        return [realpathSync(d)];
      } catch {
        return [];
      }
    }),
  );
  for (const c of o.candidates) {
    let real: string;
    try {
      real = realpathSync(c);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(real);
    } catch {
      continue;
    }
    let writable = false;
    try {
      accessSync(real, constants.W_OK);
      writable = true;
    } catch {
      // not writable
    }
    const parent = dirname(real);
    let isOwn = false;
    if (o.uid !== null && own.has(parent) && st.uid === o.uid) {
      try {
        const ps = statSync(parent);
        isOwn = ps.uid === o.uid && (ps.mode & 0o777) === 0o700;
      } catch {
        isOwn = false;
      }
    }
    const owner = lookupName(o.passwdFile ?? '/etc/passwd', st.uid);
    const group = o.gids.includes(st.gid) ? lookupName(o.groupFile ?? '/etc/group', st.gid) : undefined;
    seen.set(real, {
      path: c,
      real,
      uid: st.uid,
      gid: st.gid,
      writable,
      own: isOwn,
      ...(owner ? { owner } : {}),
      ...(group ? { group } : {}),
    });
  }
  return [...seen.values()];
}

/**
 * S2: the docker CLI the start-up check may run, never one found on PATH (the runner can write the first PATH entry):
 * the first candidate that resolves to a regular file owned by root (`rootUid`) and not writable by group or others.
 * cli.ts passes this runner's root-owned `<adminDir>/docker/docker`, then `/usr/bin/docker`.
 */
export function trustedDockerCli(candidates: readonly string[], rootUid = 0): string | null {
  for (const c of candidates) {
    try {
      const st = statSync(realpathSync(c));
      if (st.isFile() && st.uid === rootUid && (st.mode & 0o022) === 0) return c;
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * `docker info` SecurityOptions through `socket`, asked with `cli` (an absolute, root-owned path from
 * `trustedDockerCli`), contains `name=rootless` (5 s; no CLI or any failure: false).
 */
export function daemonIsRootless(socket: string, cli: string | null, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!cli?.startsWith('/')) {
      resolve(false);
      return;
    }
    let out = '';
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cli, ['-H', `unix://${socket}`, 'info', '--format', '{{json .SecurityOptions}}'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    p.stdout?.on('data', (d) => {
      out += String(d);
    });
    p.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0 && /name=rootless/.test(out));
    });
  });
}

/** Looks at this machine (POSIX; on Windows only the file checks apply). */
export async function probeHost(o: {
  /** Paths whose owner and mode matter: the runner root, policy.json and its folder, the admin tools. */
  paths: string[];
  env?: NodeJS.ProcessEnv;
  /** The recorded shared daemon socket (policy.json `sharedDocker.socket`): asked whether it is rootless. */
  sharedSocket?: string;
  /** Candidates for the root-owned docker CLI that asks it (S2: absolute paths only, never PATH). */
  dockerCli?: readonly string[];
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
    dockerSockets: posix ? await socketsOf(env, uid, o.sharedSocket, o.dockerCli ?? ['/usr/bin/docker']) : [],
    ...(env.DOCKER_HOST ? { inheritedDockerHost: env.DOCKER_HOST } : {}),
    writableByOthers: o.paths.filter((p) => existsSync(p) && writableByOthers(p, uid)),
    ...(posix && user ? { user } : {}),
  };
}

async function socketsOf(
  env: NodeJS.ProcessEnv,
  uid: number | null,
  shared: string | undefined,
  cliCandidates: readonly string[],
): Promise<DockerSocketFact[]> {
  const runtimeDirs = [
    ...(uid !== null ? [`/run/user/${uid}`] : []),
    ...(env.XDG_RUNTIME_DIR ? [env.XDG_RUNTIME_DIR] : []),
  ];
  const facts = collectDockerSockets({
    candidates: [...dockerSocketCandidates(env, uid), ...(shared ? [shared] : [])],
    uid,
    gids: process.getgroups?.() ?? [],
    runtimeDirs,
  });
  const cli = shared ? trustedDockerCli(cliCandidates) : null;
  for (const f of facts)
    if (shared && f.real === shared && f.writable) f.rootless = await daemonIsRootless(f.real, cli);
  return facts;
}
