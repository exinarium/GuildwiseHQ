import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConnectSecretSchema,
  connectSealAad,
  DEPLOY_KEY_COMMENT_PREFIX,
  type DeployConnectPayload,
  type DeployConnectResult,
  type DeployKeyPayload,
  type DeployKeyResult,
  type DeployRevokePayload,
  type DeployRevokeResult,
  type HostKeyEntry,
  type HostKeyScanPayload,
  type HostKeyScanResult,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';
import { type DeployKeys, KeyError, userSshArgs } from './deploy-keys.ts';
import { classifySsh, type Ran, run } from './probe.ts';

/**
 * Guided connect (docs/design/deploy-run-ux-design.md J4, J5 and section 8). Everything here is a fixed procedure:
 *
 * - `hostKeyScan` shows the server's fingerprint(s); nothing is trusted yet.
 * - `createKey` makes this computer's dedicated key (the private key stays in the runner's data folder).
 * - `connect` trusts exactly the host key the person confirmed (a separate known_hosts file, never the person's own), appends our
 *   public key to the server's `authorized_keys` once - with a password typed once, a key file the host gave, an existing sign-in,
 *   or not at all when the person pasted the key into a hosting panel - and tests the new key. A password or key file is used in
 *   memory and in one ssh process only: it is never written to a log, an event or the data folder (a key file lives in a 0600
 *   temp file for the length of that one ssh call).
 * - `revoke` removes ONE key that Guildwise installed (its comment starts with `guildwise-deploy:`), by its public key.
 *
 * The person's `~/.ssh` (config, keys, known_hosts, authorized_keys on this computer) is never read for its content nor changed.
 */

export interface ConnectorDeps {
  keys: DeployKeys;
  /** Opens a sealed value (the runner's private key). */
  decrypt: (ciphertext: string, aad?: string) => string;
  /** The key id the browser sealed to. */
  keyId: () => string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  tmp?: string;
  connectSec?: number;
  commandMs?: number;
  /**
   * The person's own ssh config, passed as `-F` for the calls that must use the person's sign-in (an existing alias). Absent: ssh's
   * default (`~/.ssh/config`). Tests give a file of their own so that nothing reaches a real server.
   */
  userSshConfig?: string;
  log?: Logger;
}

const SAFE_CMD = /^[A-Za-z0-9._-]+$/;

/** Appends our public key to `~/.ssh/authorized_keys` of the signed-in user, once. POSIX sh; the key is `$1`. */
export const INSTALL_KEY_SCRIPT = `set -eu
umask 077
pub=$1
# only a folder or file that group or others can WRITE to is tightened (sshd refuses those); a mode that is fine stays as it is
loose() { m=$(ls -ld "$1" | cut -c1-10); case "$m" in ?????w????|????????w?) return 0 ;; esac; return 1; }
mkdir -p "$HOME/.ssh"
if loose "$HOME/.ssh"; then chmod go-w "$HOME/.ssh"; fi
f="$HOME/.ssh/authorized_keys"
if [ -f "$f" ] && grep -qxF -- "$pub" "$f"; then echo "AOM_RESULT already"; exit 0; fi
bak=
if [ -s "$f" ]; then
  bak="$f.guildwise-bak-$(date +%Y%m%d%H%M%S)"
  cp -p -- "$f" "$bak"
  if [ "$(tail -c 1 "$f" | wc -l)" -eq 0 ]; then echo >> "$f"; fi
fi
printf '%s\\n' "$pub" >> "$f"
if loose "$f"; then chmod go-w "$f"; fi
echo "AOM_RESULT added $bak"
`;

/** Removes ONE key by its public key, only a line Guildwise made (its comment). A dated copy of the file is made first. */
export const REVOKE_KEY_SCRIPT = `set -eu
key=$1
f="$HOME/.ssh/authorized_keys"
if [ ! -f "$f" ]; then echo "AOM_RESULT 0"; exit 0; fi
p=${'$'}{2:-${DEPLOY_KEY_COMMENT_PREFIX}}
n=$(awk -v k="$key" -v p="$p" '{ if ($1 " " $2 == k && index($3, p) == 1) c++ } END { print c + 0 }' "$f")
if [ "$n" = 0 ]; then echo "AOM_RESULT 0"; exit 0; fi
bak="$f.guildwise-bak-$(date +%Y%m%d%H%M%S)"
cp -p -- "$f" "$bak"
tmp="$f.aom-tmp.$$"
trap 'rm -f -- "$tmp"' EXIT
cp -p -- "$f" "$tmp"
awk -v k="$key" -v p="$p" '{ if ($1 " " $2 == k && index($3, p) == 1) next; print }' "$f" > "$tmp"
mv -- "$tmp" "$f"
echo "AOM_RESULT $n $bak"
`;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The remote command line: a fixed script (base64, nothing to quote) and arguments, all single-quoted. */
export function remoteCommand(script: string, ...args: string[]): string {
  return `sh -c "$(printf %s ${b64(script)} | base64 -d)" aom-remote${args.map((a) => ` ${shq(a)}`).join('')}`;
}

/** The line to put in a known_hosts file for a scanned host key. */
function knownHostsLine(address: string, port: number, line: string): string {
  const m = /^\S+\s+(\S+)\s+(\S+)/.exec(line);
  if (!m) throw new Error('unreadable host key');
  return `${port === 22 ? address : `[${address}]:${port}`} ${m[1]} ${m[2]}`;
}

export class DeployConnector {
  private readonly log: Logger;
  private readonly home: string;
  constructor(private readonly deps: ConnectorDeps) {
    this.log = deps.log ?? nullLogger;
    this.home = deps.home ?? homedir();
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private base(): string[] {
    return [
      '-o',
      `ConnectTimeout=${this.deps.connectSec ?? 10}`,
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
    ];
  }

  // ------------------------------------------------------------------------------------------ host key

  /** Scans the host keys the server offers: type and SHA256 fingerprint of each. Trusts nothing. */
  async hostKeyScan(p: HostKeyScanPayload): Promise<HostKeyScanResult> {
    const scan = await this.scanLines(p.address, p.port);
    if (!scan.ok) return scan;
    const keys: HostKeyEntry[] = [];
    for (const l of scan.lines) {
      const fp = await this.fingerprintOf(l);
      if (fp) keys.push(fp);
    }
    if (!keys.length) return { ok: false, error: 'no_keys', detail: 'the server did not offer a host key' };
    return { ok: true, keys: keys.slice(0, 6) };
  }

  private async scanLines(
    address: string,
    port: number,
  ): Promise<{ ok: true; lines: string[] } | Extract<HostKeyScanResult, { ok: false }>> {
    const r = await run(
      'ssh-keyscan',
      ['-T', String(this.deps.connectSec ?? 8), '-p', String(port), '-t', 'ed25519,ecdsa,rsa', '--', address],
      { timeoutMs: (this.deps.commandMs ?? 25_000) + 5000, env: this.env },
    );
    if (r.missing) return { ok: false, error: 'no_ssh', detail: 'ssh-keyscan is not installed' };
    if (r.timedOut) return { ok: false, error: 'timeout' };
    const lines = r.stdout
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.trim());
    if (!lines.length)
      return {
        ok: false,
        error: 'unreachable',
        detail: (r.stderr.split('\n').find((l) => l && !l.startsWith('#')) ?? 'no answer').slice(0, 200),
      };
    return { ok: true, lines };
  }

  private async fingerprintOf(line: string): Promise<HostKeyEntry | null> {
    const r = await run('ssh-keygen', ['-lf', '-'], {
      timeoutMs: 10_000,
      input: `${line}\n`,
      env: this.env,
    });
    const m = /^(\d+)\s+(SHA256:[A-Za-z0-9+/]{43})\s.*\(([A-Z0-9]+)\)\s*$/.exec(r.stdout.trim());
    const type = /^\S+\s+(\S+)/.exec(line)?.[1];
    if (!m || !type) return null;
    return { type, fingerprint: m[2] as string, bits: Number(m[1]) };
  }

  // ------------------------------------------------------------------------------------------ the key

  async createKey(p: DeployKeyPayload): Promise<DeployKeyResult> {
    try {
      this.deps.keys.sweepPending();
      const k = await this.deps.keys.ensure(p, p.label);
      return { ok: true, publicKey: k.publicKey, fingerprint: k.fingerprint as never, existed: k.existed };
    } catch (err) {
      if (err instanceof KeyError) return { ok: false, error: err.code, detail: err.message.slice(0, 280) };
      return { ok: false, error: 'bad_request', detail: String(err).slice(0, 200) };
    }
  }

  // ------------------------------------------------------------------------------------------ connect

  async connect(p: DeployConnectPayload): Promise<DeployConnectResult> {
    const fail = (error: Extract<DeployConnectResult, { ok: false }>['error'], detail?: string) =>
      ({ ok: false, error, ...(detail ? { detail: detail.slice(0, 280) } : {}) }) as DeployConnectResult;
    const secrets: string[] = [];
    try {
      // 1. the secret (a password or a key file), opened in memory
      let secret: ReturnType<typeof ConnectSecretSchema.parse> | null = null;
      if (p.method === 'password' || p.method === 'keyfile') {
        if (p.keyId !== this.deps.keyId()) return fail('key_changed');
        try {
          secret = ConnectSecretSchema.parse(
            JSON.parse(
              this.deps.decrypt(
                p.ciphertext as string,
                connectSealAad({
                  projectId: p.projectId,
                  address: p.address as string,
                  port: p.port,
                  user: p.user as string,
                }),
              ),
            ),
          );
        } catch {
          return fail('sealed_unreadable');
        }
        for (const v of Object.values(secret)) if (typeof v === 'string' && v) secrets.push(v);
        for (const v of secrets) registerSecret(v);
      }
      if (p.method === 'password' && !(await this.sshCanAskpass())) return fail('copy_paste_needed');

      // 2. the key: this computer's, for this target (a key made earlier under a reference moves under the target)
      if (p.keyRef && !existsSync(this.deps.keys.folder({ targetId: p.targetId })))
        this.deps.keys.adopt(p.keyRef, p.targetId);
      const key = await this.deps.keys.ensure({ targetId: p.targetId }, p.label);
      const dir = this.deps.keys.folder({ targetId: p.targetId });
      const pub = key.publicKey;

      // 3. the host key the person confirmed (not for an existing alias: the person's own known_hosts decides there)
      let hostLine: string | undefined;
      if (p.method !== 'alias') {
        const address = p.address as string;
        const scan = await this.scanLines(address, p.port);
        if (!scan.ok) return fail(scan.error === 'timeout' ? 'timeout' : 'unreachable', scan.detail);
        let pinned: string | undefined;
        for (const l of scan.lines) {
          const fp = await this.fingerprintOf(l);
          if (fp?.fingerprint === p.hostKeyFingerprint) {
            pinned = l;
            break;
          }
        }
        if (!pinned) return fail('host_key_mismatch');
        hostLine = knownHostsLine(address, p.port, pinned);
      }

      // 4. write the config so every later call (and the deploy scripts) use it
      const meta = {
        alias: p.alias,
        mode: p.method === 'alias' ? ('alias' as const) : ('managed' as const),
        ...(p.method === 'alias' ? {} : { address: p.address, user: p.user, port: p.port }),
        ...(p.hostKeyFingerprint ? { hostKeyFingerprint: p.hostKeyFingerprint } : {}),
        fingerprint: key.fingerprint,
      };
      // A reconnect (a config is there already) is staged: the old config and pinned host key stay until the new connection works.
      const staging = existsSync(join(dir, 'ssh_config')) ? join(dir, 'staging') : undefined;
      if (staging) rmSync(staging, { recursive: true, force: true });
      const confDir = staging ?? dir;
      const cfg = this.deps.keys.write(dir, meta, hostLine, confDir);
      const dropStaging = () => {
        if (staging) rmSync(staging, { recursive: true, force: true });
      };

      // 5. put our public key on the server (once), by the way the person chose
      let installed: 'added' | 'already' | 'pasted' = 'pasted';
      let backup: string | undefined;
      if (p.method === 'password' || p.method === 'keyfile' || p.method === 'alias') {
        const r =
          p.method === 'password'
            ? await this.installWithPassword(p, (secret as { password: string }).password, pub, confDir)
            : p.method === 'keyfile'
              ? await this.installWithKeyFile(
                  p,
                  secret as { privateKey: string; passphrase?: string },
                  pub,
                  confDir,
                )
              : await this.installViaAlias(p.alias, pub);
        if (!r.ok) {
          dropStaging();
          if (!key.existed && !this.keepKeyAfterFailure(p)) this.deps.keys.forget(p.targetId);
          return fail(r.error, r.detail);
        }
        installed = r.installed;
        backup = r.backup;
      }

      // 6. the connection test with the new key, the way the deploy will use it
      const test = await run(
        'ssh',
        ['-F', cfg, ...this.base(), '-o', 'BatchMode=yes', '--', p.alias, 'true'],
        { timeoutMs: (this.deps.commandMs ?? 25_000) + 5000, env: this.env },
      );
      if (test.code !== 0) {
        dropStaging();
        const c = classifySsh(test);
        if (c.state === 'host_key_changed') return fail('host_key_changed');
        if (c.state === 'unreachable') return fail(test.timedOut ? 'timeout' : 'unreachable', c.detail);
        return fail('key_not_accepted');
      }
      if (staging) this.deps.keys.promote(dir, staging);
      return {
        ok: true,
        publicKey: pub,
        fingerprint: key.fingerprint as never,
        ...(p.hostKeyFingerprint ? { hostKeyFingerprint: p.hostKeyFingerprint as never } : {}),
        installed,
        ...(backup ? { backup } : {}),
      };
    } catch (err) {
      this.log.warn(`deploy.connect failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof KeyError) return fail(err.code === 'no_ssh' ? 'no_ssh' : 'bad_request', err.message);
      return fail('bad_request', err instanceof Error ? err.message : String(err));
    } finally {
      for (const v of secrets) unregisterSecret(v);
    }
  }

  /** A failed first install leaves nothing behind; a pasted-key flow (the person may try again) keeps its key. */
  private keepKeyAfterFailure(p: DeployConnectPayload): boolean {
    return p.method === 'panel';
  }

  /** `SSH_ASKPASS_REQUIRE=force` needs OpenSSH 8.4 or newer. */
  private async sshCanAskpass(): Promise<boolean> {
    const r = await run('ssh', ['-V'], { timeoutMs: 8000, env: this.env });
    const m = /OpenSSH_(\d+)\.(\d+)/.exec(`${r.stderr}${r.stdout}`);
    if (!m) return true;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    return maj > 8 || (maj === 8 && min >= 4);
  }

  private parseInstall(
    r: Ran,
  ):
    | { ok: true; installed: 'added' | 'already'; backup?: string }
    | { ok: false; error: 'install_failed'; detail: string } {
    const m = /AOM_RESULT (added|already)(?: (\S+))?/.exec(r.stdout);
    if (!m)
      return {
        ok: false,
        error: 'install_failed',
        detail: (r.stderr.split('\n').find(Boolean) ?? 'the server gave no answer').slice(0, 200),
      };
    return { ok: true, installed: m[1] as 'added' | 'already', ...(m[2] ? { backup: m[2] } : {}) };
  }

  private failOf(r: Ran, kind: 'password' | 'keyfile') {
    const c = classifySsh(r);
    if (c.state === 'host_key_changed') return { ok: false as const, error: 'host_key_changed' as const };
    if (c.state === 'asks_password' || /Permission denied/i.test(r.stderr))
      return {
        ok: false as const,
        error: (kind === 'password' ? 'bad_password' : 'bad_key_file') as 'bad_password',
      };
    if (r.timedOut) return { ok: false as const, error: 'timeout' as const };
    if (c.state === 'unreachable')
      return { ok: false as const, error: 'unreachable' as const, detail: c.detail };
    return {
      ok: false as const,
      error: 'install_failed' as const,
      detail: c.detail ?? r.stderr.slice(0, 150),
    };
  }

  private async withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const root = this.deps.tmp ?? tmpdir();
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'aom-connect-'));
    chmodSync(dir, 0o700);
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** `ssh` asks for the password through SSH_ASKPASS (OpenSSH 8.4+, `SSH_ASKPASS_REQUIRE=force`); one attempt. */
  private async installWithPassword(p: DeployConnectPayload, password: string, pub: string, confDir: string) {
    return this.withTemp(async (tmp) => {
      const askpass = join(tmp, 'askpass.sh');
      writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$AOM_ASKPASS_SECRET"\n', { mode: 0o700 });
      const r = await run(
        'ssh',
        [
          '-F',
          '/dev/null',
          ...this.base(),
          '-o',
          `UserKnownHostsFile=${join(confDir, 'known_hosts')}`,
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'PubkeyAuthentication=no',
          '-o',
          'PreferredAuthentications=password,keyboard-interactive',
          '-o',
          'NumberOfPasswordPrompts=1',
          '-o',
          'BatchMode=no',
          '-p',
          String(p.port),
          '-l',
          p.user as string,
          '--',
          p.address as string,
          remoteCommand(INSTALL_KEY_SCRIPT, pub),
        ],
        {
          timeoutMs: (this.deps.commandMs ?? 25_000) + 10_000,
          env: {
            ...this.env,
            SSH_ASKPASS: askpass,
            SSH_ASKPASS_REQUIRE: 'force',
            AOM_ASKPASS_SECRET: password,
            DISPLAY: this.env.DISPLAY ?? ':0',
          },
        },
      );
      return r.code === 0 ? this.parseInstall(r) : this.failOf(r, 'password');
    });
  }

  /** The key file the host gave (with its passphrase, if any): written to a 0600 temp file for this one ssh call. */
  private async installWithKeyFile(
    p: DeployConnectPayload,
    s: { privateKey: string; passphrase?: string },
    pub: string,
    confDir: string,
  ) {
    return this.withTemp(async (tmp) => {
      const file = join(tmp, 'host-key');
      writeFileSync(file, s.privateKey.endsWith('\n') ? s.privateKey : `${s.privateKey}\n`, { mode: 0o600 });
      const askpass = join(tmp, 'askpass.sh');
      writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$AOM_ASKPASS_SECRET"\n', { mode: 0o700 });
      const r = await run(
        'ssh',
        [
          '-F',
          '/dev/null',
          ...this.base(),
          '-o',
          `UserKnownHostsFile=${join(confDir, 'known_hosts')}`,
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          `BatchMode=${s.passphrase ? 'no' : 'yes'}`,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'IdentityAgent=none',
          '-i',
          file,
          '-p',
          String(p.port),
          '-l',
          p.user as string,
          '--',
          p.address as string,
          remoteCommand(INSTALL_KEY_SCRIPT, pub),
        ],
        {
          timeoutMs: (this.deps.commandMs ?? 25_000) + 10_000,
          env: {
            ...this.env,
            ...(s.passphrase
              ? {
                  SSH_ASKPASS: askpass,
                  SSH_ASKPASS_REQUIRE: 'force',
                  AOM_ASKPASS_SECRET: s.passphrase,
                  DISPLAY: this.env.DISPLAY ?? ':0',
                }
              : {}),
          },
        },
      );
      writeFileSync(file, '0'.repeat(s.privateKey.length));
      return r.code === 0 ? this.parseInstall(r) : this.failOf(r, 'keyfile');
    });
  }

  /** The person's own sign-in for that alias (non-interactive, strict host keys) adds our key. */
  private async installViaAlias(alias: string, pub: string) {
    const r = await run(
      'ssh',
      [
        ...(this.deps.userSshConfig
          ? userSshArgs(this.home, this.deps.userSshConfig)
          : this.deps.keys.userSshArgs()),
        ...this.base(),
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '--',
        alias,
        remoteCommand(INSTALL_KEY_SCRIPT, pub),
      ],
      { timeoutMs: (this.deps.commandMs ?? 25_000) + 10_000, env: this.env },
    );
    if (r.code === 0) return this.parseInstall(r);
    const c = classifySsh(r);
    return c.state === 'host_key_changed'
      ? { ok: false as const, error: 'host_key_changed' as const }
      : { ok: false as const, error: 'alias_not_reachable' as const, detail: c.detail };
  }

  // ------------------------------------------------------------------------------------------ revoke

  async revoke(p: DeployRevokePayload): Promise<DeployRevokeResult> {
    const r = await this.revokeOnServer(p);
    // "Remove this server": this computer's key material for it goes when the server dropped the key, or when the person confirmed
    // that it may go anyway (the server may be gone for good). Otherwise it is kept, so the removal can be tried again.
    if (p.forget) {
      if (!r.ok && !p.forgetAnyway)
        return { ...r, forgotten: false, localKeyKept: true } as DeployRevokeResult;
      try {
        this.deps.keys.forget(p.targetId);
        return { ...r, forgotten: true } as DeployRevokeResult;
      } catch {
        return r;
      }
    }
    return r;
  }

  private async revokeOnServer(p: DeployRevokePayload): Promise<DeployRevokeResult> {
    const pubParts = p.publicKey.trim().split(/\s+/);
    if (
      pubParts.length < 3 ||
      !SAFE_CMD.test(pubParts[0] ?? '') ||
      !/^[A-Za-z0-9+/=]+$/.test(pubParts[1] ?? '')
    )
      return { ok: false, error: 'bad_request', detail: 'not a public key line' };
    // only a key Guildwise made can be removed
    if (!(pubParts[2] ?? '').startsWith(DEPLOY_KEY_COMMENT_PREFIX)) return { ok: false, error: 'not_ours' };
    const own = await this.deps.keys.publicOf(p.targetId);
    if (own && own.fingerprint === p.fingerprint && !p.forget) return { ok: false, error: 'own_key' };
    const r = await run(
      'ssh',
      [
        ...this.deps.keys.sshArgsFor(p.targetId, p.alias),
        ...this.base(),
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '--',
        p.alias,
        remoteCommand(REVOKE_KEY_SCRIPT, `${pubParts[0]} ${pubParts[1]}`, DEPLOY_KEY_COMMENT_PREFIX),
      ],
      { timeoutMs: (this.deps.commandMs ?? 25_000) + 10_000, env: this.env },
    );
    if (r.timedOut) return { ok: false, error: 'timeout' };
    const m = /AOM_RESULT (\d+)(?: (\S+))?/.exec(r.stdout);
    if (r.code !== 0 || !m) {
      const c = classifySsh(r);
      return c.state === 'reachable'
        ? { ok: false, error: 'failed', detail: r.stderr.slice(0, 150) }
        : { ok: false, error: 'unreachable', detail: c.detail };
    }
    return { ok: true, removed: Number(m[1]), ...(m[2] ? { backup: m[2] } : {}) };
  }

  /** Does this computer's key for the target still work? `ssh <alias> true`, non-interactive (the daily check). */
  async check(targetId: string | undefined, alias: string): Promise<Ran> {
    return run(
      'ssh',
      [
        ...this.deps.keys.sshArgsFor(targetId, alias),
        ...this.base(),
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '--',
        alias,
        'true',
      ],
      { timeoutMs: (this.deps.commandMs ?? 25_000) + 5000, env: this.env },
    );
  }
}
