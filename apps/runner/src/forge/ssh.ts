import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type ConnectableForge,
  type GitSsh,
  isSshRemote,
  parseRemote,
  remoteUrlForMethod,
  type SshCheckState,
  type SshKeyMode,
  settingsHostFor,
  sshHostFor,
} from '@aom/shared';
import { GIT_HARDEN_ENV, hardenedGitArgs } from '../git/harden.ts';
import type { Executor } from '../toolchain/exec.ts';
import { ensureSshKey, sshKeyPathFor } from './connect.ts';
import type { GitAuth } from './types.ts';

/**
 * SSH as an alternative to API tokens (docs/BACKLOG.md item 6).
 *
 * - The runner keeps, per git host, the workstation default (`https` or `ssh`) and which key it uses: one it generated
 *   (`~/.ssh/aom_<provider>`), a key file the owner named, or the ssh-agent. The private key is only ever read by the
 *   `ssh` process the runner starts; its path (never its content) and the PUBLIC key go to the server.
 * - Git commands for an ssh remote get `GIT_SSH_COMMAND` with that key, `IdentitiesOnly` and a known_hosts file of the
 *   runner (`secrets/known_hosts`, first contact accepted, a changed host key refused).
 * - A clone that uses ssh also gets `core.sshCommand` in its local git config, so every runner-side git command in the
 *   clone and its worktrees (fetch, rebase, push at completion, hygiene) uses the same key without threading it
 *   through each call. Agents run in a sandbox that denies `~/.ssh` and the runner's data directory, so their own
 *   `git fetch`/`git push` cannot read the key; they never get it. The runner does the network work.
 */

export interface SshHostSettings {
  provider?: ConnectableForge;
  default: 'https' | 'ssh';
  key: SshKeyMode;
  keyPath?: string;
  check?: { state: SshCheckState; detail?: string; checkedAt: string };
}

/** `secrets/git-ssh.json`: settings per git host. No secret in it (paths and results), still mode 0600. */
export class SshSettingsStore {
  constructor(readonly file: string) {}

  private read(): Record<string, SshHostSettings> {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { hosts?: Record<string, SshHostSettings> };
      return j.hosts && typeof j.hosts === 'object' ? j.hosts : {};
    } catch {
      return {};
    }
  }

  get(host: string): SshHostSettings | undefined {
    return this.read()[settingsHostFor(host)];
  }

  all(): Array<[string, SshHostSettings]> {
    return Object.entries(this.read());
  }

  set(host: string, s: SshHostSettings): void {
    const hosts = this.read();
    hosts[settingsHostFor(host)] = s;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
  }
}

/** What the forge adapters and the git code need for ssh. Absent: ssh remotes use the user's own ssh setup. */
export interface SshEnv {
  settings: SshSettingsStore;
  /** The runner's known_hosts file (`secrets/known_hosts`). */
  knownHosts: string;
  home?: string;
  /** The `ssh` binary (tests). */
  sshBin?: string;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** What a key choice means for one host: the file to use, or null for the ssh-agent / the user's ssh config. */
export function resolveKey(
  ssh: SshEnv,
  provider: ConnectableForge | undefined,
  host: string,
): { mode: SshKeyMode; keyPath: string | null } {
  const s = ssh.settings.get(host);
  const home = ssh.home ?? homedir();
  if (s?.key === 'agent') return { mode: 'agent', keyPath: null };
  if (s?.key === 'path' && s.keyPath) return { mode: 'path', keyPath: s.keyPath };
  const gen = s?.provider ?? provider;
  if (gen) {
    const generated = sshKeyPathFor(gen, home);
    // Not configured yet: the generated key when it exists, else the user's own ssh setup (agent, ~/.ssh/config).
    if (s?.key === 'generated' || existsSync(generated)) return { mode: 'generated', keyPath: generated };
  }
  return { mode: 'agent', keyPath: null };
}

/** The `ssh` options as separate arguments (for `ssh -T` and tests). */
export function sshOptionArgs(ssh: SshEnv, key: { keyPath: string | null }): string[] {
  return [
    ...(key.keyPath ? ['-i', key.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${ssh.knownHosts}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
  ];
}

/** The value of `GIT_SSH_COMMAND` / `core.sshCommand` (a shell-parsed string, paths quoted). */
export function sshCommandString(ssh: SshEnv, key: { keyPath: string | null }): string {
  return [
    ssh.sshBin ? shq(ssh.sshBin) : 'ssh',
    ...(key.keyPath ? ['-i', shq(key.keyPath), '-o', 'IdentitiesOnly=yes'] : []),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${shq(ssh.knownHosts)}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
  ].join(' ');
}

/** The git env for an ssh remote; null when the url is not ssh or the runner has no ssh settings (the user's own setup). */
export function sshGitAuth(ssh: SshEnv | undefined, url: string): GitAuth | null {
  if (!ssh || !isSshRemote(url)) return null;
  const p = parseRemote(url);
  const provider =
    p &&
    (p.kind === 'github' || p.kind === 'gitlab' || p.kind === 'bitbucket-cloud' || p.kind === 'azure-devops')
      ? p.kind
      : undefined;
  const key = resolveKey(ssh, provider, p?.host ?? '');
  mkdirSync(dirname(ssh.knownHosts), { recursive: true, mode: 0o700 });
  return { args: [], env: { GIT_SSH_COMMAND: sshCommandString(ssh, key) } };
}

/** The workstation default for a git host (`https` when nothing was chosen). */
export function defaultMethodFor(ssh: SshEnv | undefined, host: string): 'https' | 'ssh' {
  return ssh?.settings.get(host)?.default ?? 'https';
}

export interface SshCheckResult {
  state: SshCheckState;
  detail: string;
}

/** Maps what `ssh`/`git` printed to a state with a sentence the owner can act on. */
export function classifySshOutput(exitCode: number, text: string, host: string): SshCheckResult {
  const t = text.trim();
  if (exitCode === 127 || /ssh: command not found|No such file or directory.*ssh/i.test(t))
    return {
      state: 'tool_missing',
      detail: 'The ssh program is not installed on this workstation (install the OpenSSH client).',
    };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(t))
    return {
      state: 'host_key',
      detail: `The host key of ${host} differs from the one seen before. If you did not expect that, stop; otherwise remove the ${host} line from the runner's secrets/known_hosts.`,
    };
  if (/Permission denied|publickey|Authentication failed|access denied/i.test(t))
    return {
      state: 'not_authorized',
      detail: `${host} refused the key. Add the public key to your account on ${host}, then check again.`,
    };
  if (
    /Could not resolve hostname|Connection (timed out|refused|reset)|Network is unreachable|No route to host|timed out/i.test(
      t,
    )
  )
    return {
      state: 'unreachable',
      detail: `Could not reach ${host} over ssh (port 22). A firewall may block it; some hosts also offer ssh over port 443.`,
    };
  if (/no such identity|Load key .*: (No such file|invalid format)|not accessible/i.test(t))
    return { state: 'no_key', detail: 'The private key file was not found or cannot be read.' };
  if (exitCode === 0 || exitCode === 1)
    return { state: 'ok', detail: t.split('\n')[0]?.slice(0, 200) || `${host} accepted the key.` };
  return { state: 'unknown', detail: t.slice(0, 300) || `ssh to ${host} failed (exit ${exitCode}).` };
}

/**
 * Checks that ssh works for a host: `git ls-remote` against a repository when one is given (the real thing), else
 * `ssh -T git@<host>` (GitHub answers with exit 1 and "successfully authenticated", which is a success). ssh exits 255
 * when the connection or the authentication fails.
 */
export async function checkSsh(
  exec: Executor,
  ssh: SshEnv,
  q: { provider?: ConnectableForge | undefined; host: string; repoUrl?: string | undefined },
): Promise<SshCheckResult> {
  const key = resolveKey(ssh, q.provider, q.host);
  if (key.keyPath && !existsSync(key.keyPath))
    return {
      state: 'no_key',
      detail: `The key ${key.keyPath} does not exist. Create it with "guildwise-runner git-connect ${q.provider ?? '<provider>'} --ssh" or choose another key.`,
    };
  mkdirSync(dirname(ssh.knownHosts), { recursive: true, mode: 0o700 });
  if (q.repoUrl) {
    const url = isSshRemote(q.repoUrl) ? q.repoUrl : remoteUrlForMethod(q.repoUrl, 'ssh');
    if (!url) return { state: 'unknown', detail: 'The ssh address of this repository cannot be derived.' };
    const r = await exec.run('git', hardenedGitArgs(['ls-remote', '--exit-code', '--', url, 'HEAD']), {
      timeoutMs: 60_000,
      env: { ...GIT_HARDEN_ENV, GIT_SSH_COMMAND: sshCommandString(ssh, key) },
    });
    if (r.exitCode === 0) return { state: 'ok', detail: `git can read ${url} over ssh.` };
    return classifySshOutput(r.exitCode === 128 ? 255 : r.exitCode, `${r.stderr}\n${r.stdout}`, q.host);
  }
  const target = sshHostFor(q.host);
  const r = await exec.run(ssh.sshBin ?? 'ssh', ['-T', ...sshOptionArgs(ssh, key), `git@${target}`], {
    timeoutMs: 30_000,
  });
  return classifySshOutput(r.exitCode, `${r.stderr}\n${r.stdout}`, q.host);
}

/** The public key of a private key file, when it exists. */
export function readPublicKey(keyPath: string): string | undefined {
  try {
    return readFileSync(`${keyPath}.pub`, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The ssh facts of one host for the git report; undefined when the owner never touched ssh here. */
export function sshInfo(
  ssh: SshEnv | undefined,
  provider: ConnectableForge,
  host: string,
): GitSsh | undefined {
  if (!ssh) return undefined;
  const s = ssh.settings.get(host);
  if (!s) {
    const key = resolveKey(ssh, provider, host);
    if (!key.keyPath) return undefined;
    const publicKey = readPublicKey(key.keyPath);
    return {
      defaultMethod: 'https',
      key: 'generated',
      keyPath: key.keyPath,
      ...(publicKey ? { publicKey } : {}),
    };
  }
  const key = resolveKey(ssh, provider, host);
  const publicKey = key.keyPath ? readPublicKey(key.keyPath) : undefined;
  return {
    defaultMethod: s.default,
    key: key.mode,
    ...(key.keyPath ? { keyPath: key.keyPath } : {}),
    ...(publicKey ? { publicKey } : {}),
    ...(s.check ? { check: s.check } : {}),
  };
}

export interface SshActionInput {
  provider: ConnectableForge;
  host: string;
  action: 'prepare' | 'check' | 'save';
  defaultMethod?: 'https' | 'ssh' | undefined;
  key?: SshKeyMode | undefined;
  keyPath?: string | undefined;
  repoUrl?: string | undefined;
  now?: () => Date;
}

/**
 * `git.ssh` and `aom-runner git-connect --ssh`: `prepare` creates the generated key (the public key is reported),
 * `save` records the default and the key choice, `check` runs the check and stores its result for the next report.
 */
export async function runSshAction(
  exec: Executor,
  ssh: SshEnv,
  a: SshActionInput,
): Promise<{
  state: SshCheckState | 'saved' | 'prepared';
  detail: string;
  publicKey?: string;
  keyPath?: string;
}> {
  const now = (a.now?.() ?? new Date()).toISOString();
  const current = ssh.settings.get(a.host);
  const base: SshHostSettings = current ?? { provider: a.provider, default: 'https', key: 'generated' };
  base.provider = a.provider;
  if (a.action === 'save' || a.action === 'prepare') {
    if (a.key) base.key = a.key;
    if (a.keyPath) base.keyPath = a.keyPath;
    if (a.key && a.key !== 'path') delete base.keyPath;
    if (a.defaultMethod) base.default = a.defaultMethod;
    if (base.key === 'path' && !base.keyPath) throw new Error('name the private key file (keyPath)');
    if (base.key === 'path' && !existsSync(base.keyPath as string))
      throw new Error(`${base.keyPath} does not exist on this workstation`);
  }
  if (a.action === 'prepare') {
    if (base.key !== 'generated') {
      ssh.settings.set(a.host, base);
      return { state: 'prepared', detail: 'A key of your own is in use; nothing to create.' };
    }
    const k = await ensureSshKey(exec, a.provider, ssh.home);
    ssh.settings.set(a.host, base);
    return {
      state: 'prepared',
      detail: `${k.created ? 'Created' : 'Using the existing'} key ${k.path}`,
      publicKey: k.publicKey,
      keyPath: k.path,
    };
  }
  if (a.action === 'save') {
    ssh.settings.set(a.host, base);
    return { state: 'saved', detail: `Default for ${a.host}: ${base.default}` };
  }
  ssh.settings.set(a.host, base);
  const r = await checkSsh(exec, ssh, { provider: a.provider, host: a.host, repoUrl: a.repoUrl });
  base.check = { state: r.state, detail: r.detail.slice(0, 400), checkedAt: now };
  ssh.settings.set(a.host, base);
  return { state: r.state, detail: r.detail };
}
