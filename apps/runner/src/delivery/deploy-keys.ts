import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEPLOY_KEY_COMMENT_PREFIX, keyLabel } from '@aom/shared';
import { execa } from 'execa';

/**
 * The dedicated deploy keys of this computer (docs/design/deploy-run-ux-design.md sections 6.4, 7.4 and 8):
 *
 *   <data dir>/keys/deploy/<targetId>/id_ed25519      the private key (0600): it never leaves this folder
 *                                     id_ed25519.pub   the public key, comment `guildwise-deploy:<target>:<computer>`
 *                                     ssh_config       how ssh reaches the server with it (used as `ssh -F`)
 *                                     known_hosts      the host key the person confirmed (this file only)
 *                                     meta.json        alias, address, user, port, how it was made
 *   <data dir>/keys/deploy/pending/<keyRef>/...        the same for a key made before its target exists
 *
 * Nothing here touches `~/.ssh`: the config that uses a key is the runner's own file, passed to ssh with `-F`. For an existing
 * alias (`mode: 'alias'`) that file only adds our identity in front and then `Include`s the person's own ssh config.
 */

export interface DeployKeyMeta {
  alias: string;
  mode: 'managed' | 'alias';
  address?: string;
  user?: string;
  port?: number;
  hostKeyFingerprint?: string;
  fingerprint: string;
  createdAt: string;
}

export interface KeyInfo {
  dir: string;
  publicKey: string;
  fingerprint: string;
  existed: boolean;
}

export interface DeployKeysOptions {
  /** `<data dir>/keys/deploy`. */
  dir: string;
  home?: string;
  /** The person's ssh config that an existing alias includes (default `~/.ssh/config`; tests give their own). */
  userConfig?: string;
  /** Environment for ssh-keygen (tests put fakes on PATH). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * ssh arguments that name the person's own config and known_hosts EXPLICITLY. OpenSSH finds `~/.ssh/config` and `known_hosts`
 * through the account database, not `$HOME`, so a temporary HOME does not isolate it: every ssh call that is not made with a
 * managed config therefore passes these (tests point `home` at a temp folder). A missing config is `/dev/null`.
 */
export function userSshArgs(home: string, userConfig?: string): string[] {
  const cfg = userConfig ?? join(home, '.ssh', 'config');
  return [
    '-F',
    existsSync(cfg) ? cfg : '/dev/null',
    '-o',
    `UserKnownHostsFile=${join(home, '.ssh', 'known_hosts')}`,
  ];
}

const PENDING = 'pending';
const KEY_FILE = 'id_ed25519';
const WEEK_MS = 7 * 24 * 3600_000;

export class DeployKeys {
  readonly dir: string;
  private readonly home: string;
  private readonly userConfig: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly now: () => Date;

  constructor(o: DeployKeysOptions) {
    this.dir = o.dir;
    this.home = o.home ?? homedir();
    this.userConfig = o.userConfig;
    this.env = o.env;
    this.now = o.now ?? (() => new Date());
  }

  /** The folder of a target's key, or of a pending reference. */
  folder(ref: { targetId?: string | undefined; keyRef?: string | undefined }): string {
    if (ref.targetId) return join(this.dir, ref.targetId);
    if (ref.keyRef) return join(this.dir, PENDING, ref.keyRef);
    throw new Error('a target or a key reference is needed');
  }

  has(targetId: string): boolean {
    return (
      existsSync(join(this.dir, targetId, KEY_FILE)) && existsSync(join(this.dir, targetId, 'meta.json'))
    );
  }

  meta(targetId: string): DeployKeyMeta | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, targetId, 'meta.json'), 'utf8')) as DeployKeyMeta;
    } catch {
      return null;
    }
  }

  /** The `-F` file for a target whose key this computer holds for `alias`; null when it holds none (use the person's own ssh). */
  sshConfigFor(targetId: string | undefined, alias: string | undefined): string | null {
    if (!targetId || !alias) return null;
    const m = this.meta(targetId);
    if (!m || m.alias !== alias) return null;
    const cfg = join(this.dir, targetId, 'ssh_config');
    return existsSync(cfg) ? cfg : null;
  }

  /** The ssh arguments for a target: its managed config, else the person's own config named explicitly (see `userSshArgs`). */
  sshArgsFor(targetId: string | undefined, alias: string | undefined): string[] {
    const cfg = this.sshConfigFor(targetId, alias);
    return cfg ? ['-F', cfg] : this.userSshArgs();
  }

  userSshArgs(): string[] {
    return userSshArgs(this.home, this.userConfig);
  }

  /** `AOM_DEPLOY_SSH` for a deploy script, or null (then the script uses plain `ssh` as the person does). */
  deploySsh(targetId: string | null | undefined, alias: string | null | undefined): string | null {
    const cfg = this.sshConfigFor(targetId ?? undefined, alias ?? undefined);
    // the script splits this on spaces: a path with whitespace cannot be passed that way
    return cfg && !/\s/.test(cfg) ? `ssh -F ${cfg}` : null;
  }

  /** Makes the key unless it is there (an existing key is kept, never replaced). Returns the public parts. */
  async ensure(
    ref: { targetId?: string | undefined; keyRef?: string | undefined },
    computerName: string,
  ): Promise<KeyInfo> {
    const dir = this.folder(ref);
    const priv = join(dir, KEY_FILE);
    const existed = existsSync(priv) && existsSync(`${priv}.pub`);
    if (!existed) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(join(this.dir), 0o700);
      rmSync(priv, { force: true });
      rmSync(`${priv}.pub`, { force: true });
      const comment = `${DEPLOY_KEY_COMMENT_PREFIX}${(ref.targetId ?? ref.keyRef ?? '').slice(0, 8)}:${keyLabel(computerName)}`;
      const r = await execa('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', priv], {
        reject: false,
        timeout: 30_000,
        stdin: 'ignore',
        ...(this.env ? { env: this.env } : {}),
      });
      if (r.exitCode !== 0 || !existsSync(priv))
        throw new KeyError(
          'keygen_failed',
          `ssh-keygen failed${r.stderr ? `: ${String(r.stderr).slice(0, 150)}` : ''}`,
        );
      chmodSync(priv, 0o600);
    }
    const publicKey = readFileSync(`${priv}.pub`, 'utf8').trim();
    return { dir, publicKey, fingerprint: await this.fingerprint(`${priv}.pub`), existed };
  }

  async fingerprint(pubFile: string): Promise<string> {
    const r = await execa('ssh-keygen', ['-lf', pubFile], {
      reject: false,
      timeout: 15_000,
      stdin: 'ignore',
      ...(this.env ? { env: this.env } : {}),
    });
    const m = /(SHA256:[A-Za-z0-9+/]{43})/.exec(String(r.stdout));
    if (!m) throw new KeyError('keygen_failed', 'could not read the key fingerprint');
    return m[1] as string;
  }

  /** The public key line and fingerprint of a target's key (no private material). */
  async publicOf(targetId: string): Promise<{ publicKey: string; fingerprint: string } | null> {
    if (!this.has(targetId)) return null;
    const pub = join(this.dir, targetId, `${KEY_FILE}.pub`);
    return { publicKey: readFileSync(pub, 'utf8').trim(), fingerprint: await this.fingerprint(pub) };
  }

  /** Moves a pending key under its target (the key is made before the target exists). */
  adopt(keyRef: string, targetId: string): void {
    const from = join(this.dir, PENDING, keyRef);
    const to = join(this.dir, targetId);
    if (!existsSync(from)) return;
    if (existsSync(to)) {
      // this computer already has a key for the target: keep that one, drop the pending one
      rmSync(from, { recursive: true, force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    renameSync(from, to);
  }

  /** Writes the ssh config and the metadata of a key that works for `alias`. */
  write(
    dir: string,
    m: Omit<DeployKeyMeta, 'createdAt'> & { createdAt?: string },
    hostKeyLine?: string,
  ): string {
    const cfg = join(dir, 'ssh_config');
    const key = join(dir, KEY_FILE);
    const lines: string[] = [`# Written by Guildwise for ${m.alias}. Used as: ssh -F <this file>`];
    if (m.mode === 'managed') {
      if (hostKeyLine) writeFileSync(join(dir, 'known_hosts'), `${hostKeyLine}\n`, { mode: 0o600 });
      lines.push(
        `Host ${m.alias}`,
        `  HostName ${m.address}`,
        `  User ${m.user}`,
        `  Port ${m.port ?? 22}`,
        `  IdentityFile ${key}`,
        '  IdentitiesOnly yes',
        `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
        '  GlobalKnownHostsFile /dev/null',
        '  StrictHostKeyChecking yes',
        '  BatchMode yes',
        '  PasswordAuthentication no',
        '  ForwardAgent no',
        '  ForwardX11 no',
      );
    } else {
      // an existing alias: our identity first, then everything the person's own config says about that host
      lines.push(`Host ${m.alias}`, `  IdentityFile ${key}`, '  IdentitiesOnly yes', '  ForwardAgent no');
      const own = this.userConfig ?? join(this.home, '.ssh', 'config');
      if (existsSync(own)) lines.push('', `Include ${own}`);
    }
    writeFileSync(cfg, `${lines.join('\n')}\n`, { mode: 0o600 });
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ ...m, createdAt: m.createdAt ?? this.now().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    return cfg;
  }

  /** Deletes this computer's key for a target (the server's copy of it is removed separately, by another computer). */
  forget(targetId: string): void {
    rmSync(join(this.dir, targetId), { recursive: true, force: true });
  }

  /** A made-but-never-used key is dropped after a week. */
  sweepPending(): void {
    const p = join(this.dir, PENDING);
    if (!existsSync(p)) return;
    for (const name of readdirSync(p)) {
      const f = join(p, name);
      try {
        if (this.now().getTime() - statSync(f).mtimeMs > WEEK_MS) rmSync(f, { recursive: true, force: true });
      } catch {
        // gone already
      }
    }
  }
}

export class KeyError extends Error {
  constructor(
    readonly code: 'keygen_failed' | 'no_ssh',
    message: string,
  ) {
    super(message);
  }
}
