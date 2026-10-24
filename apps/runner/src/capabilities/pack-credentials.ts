import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PackCredentialKind, type PackCredentialResult, packCredentialAad } from '@aom/shared';
import { execa } from 'execa';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';

/**
 * The deploy key or token of ONE private git pack on this workstation (docs/ARCHITECTURE.md section 38.8). It arrives sealed in
 * the browser to this runner's key; here it is opened once and written 0600 in a 0700 folder of its own
 * (`<packs>/.cred/<packId>/`). It is used only to clone and fetch that pack, inside the isolated git environment, and is never
 * written to a git config, never sent to the server and registered with the redaction registry so no log line carries it.
 */

export interface StoredCredential {
  kind: PackCredentialKind;
  username?: string;
  fingerprint?: string;
  /** The host of the pack's git URL the credential was bound to when it was sealed: it is used for no other host. */
  host?: string;
}

const KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export class PackCredentialStore {
  constructor(
    private readonly root: string,
    private readonly decrypt: (sealed: string, aad?: string) => string,
    private readonly keyId: () => string,
  ) {}

  private dirOf(packId: string): string {
    return join(this.root, '.cred', packId);
  }

  /** Re-registers the stored secrets with the redaction registry (after a restart). */
  load(packIds: Iterable<string>): void {
    for (const id of packIds) {
      const c = this.secretOf(id);
      if (c) registerSecret(c);
    }
  }

  private secretOf(packId: string): string | undefined {
    const m = this.meta(packId);
    if (!m) return undefined;
    try {
      return readFileSync(join(this.dirOf(packId), m.kind === 'ssh' ? 'key' : 'token'), 'utf8');
    } catch {
      return undefined;
    }
  }

  meta(packId: string): StoredCredential | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dirOf(packId), 'meta.json'), 'utf8')) as StoredCredential;
    } catch {
      return undefined;
    }
  }

  has(packId: string): boolean {
    return !!this.meta(packId);
  }

  /**
   * Why this credential may not be used for a pack at `host`, or undefined when it may. A credential stored before binding existed
   * (no host in its record) is not used: the admin enters it again. One bound to another host is not sent there.
   */
  hostProblem(packId: string, host: string): string | undefined {
    const m = this.meta(packId);
    if (!m) return undefined;
    if (!m.host)
      return 'the deploy key or token of this pack was stored in the older form that is not tied to a host: enter it again';
    if (m.host !== host.toLowerCase())
      return `the deploy key or token of this pack is bound to ${m.host}, not ${host}: the pack's address changed. Enter the credential again for the new address`;
    return undefined;
  }

  keyFile(packId: string): string {
    return join(this.dirOf(packId), 'key');
  }

  knownHostsFile(packId: string): string {
    return join(this.dirOf(packId), 'known_hosts');
  }

  /** The token, for the one-shot askpass of a single git call. */
  token(packId: string): string | undefined {
    const m = this.meta(packId);
    return m?.kind === 'token' ? this.secretOf(packId)?.trim() : undefined;
  }

  /** `pack.credential.set`. Never returns or logs the secret. */
  async set(p: {
    packId: string;
    keyId: string;
    kind: PackCredentialKind;
    ciphertext: string;
    username?: string | undefined;
    host?: string | undefined;
  }): Promise<PackCredentialResult> {
    if (p.keyId !== this.keyId())
      return { stored: false, error: 'the credential was sealed for another runner key: enter it again' };
    // The credential opens only with the pack, the kind, the host and this runner's key it was sealed for: a deploy key relabelled
    // for another pack or aimed at another host does not open. The older, unbound form is refused (enter it again).
    const host = (p.host ?? '').toLowerCase();
    if (!host || !p.ciphertext.startsWith('h2.'))
      return {
        stored: false,
        error:
          'the credential was sealed in the older form that is not tied to its pack and host: enter the deploy key or token again',
      };
    let plain: string;
    try {
      plain = this.decrypt(
        p.ciphertext,
        packCredentialAad({ packId: p.packId, kind: p.kind, host, keyId: p.keyId }),
      );
    } catch {
      return {
        stored: false,
        error: 'the credential could not be opened for this pack and host: enter it again',
      };
    }
    const dir = this.dirOf(p.packId);
    if (p.kind === 'ssh') {
      // a trailing newline matters to ssh ("invalid format" without it)
      const key = `${plain.replace(/\r\n/g, '\n').trim()}\n`;
      if (!KEY_RE.test(key))
        return { stored: false, error: 'that is not a private key (paste the whole key file)' };
      if (/ENCRYPTED/.test(key.split('\n')[0] ?? '') || /Proc-Type:\s*4,ENCRYPTED/.test(key))
        return { stored: false, error: 'the key has a passphrase: a deploy key must have none' };
      this.prepare(dir);
      writeFileSync(join(dir, 'key'), key, { mode: 0o600 });
      chmodSync(join(dir, 'key'), 0o600);
      rmSync(join(dir, 'token'), { force: true });
      const checked = await inspectKey(join(dir, 'key'));
      if (checked.ok === false) {
        rmSync(join(dir, 'key'), { force: true });
        return {
          stored: false,
          error: 'that key cannot be used: it has a passphrase (a deploy key must have none) or is damaged',
        };
      }
      const fingerprint = checked.fingerprint;
      const prev = this.secretOf(p.packId);
      if (prev && prev !== key) unregisterSecret(prev);
      registerSecret(key);
      // each base64 line too: a log line may carry part of the key
      for (const line of key.split('\n'))
        if (line.length > 20 && !line.startsWith('-----')) registerSecret(line);
      this.writeMeta(dir, { kind: 'ssh', host, ...(fingerprint ? { fingerprint } : {}) });
      return { stored: true, ...(fingerprint ? { fingerprint } : {}) };
    }
    const token = plain.trim();
    if (!token || /\s/.test(token) || token.length > 500)
      return { stored: false, error: 'a token is one line with no spaces' };
    this.prepare(dir);
    writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
    chmodSync(join(dir, 'token'), 0o600);
    rmSync(join(dir, 'key'), { force: true });
    const prev = this.secretOf(p.packId);
    if (prev && prev !== token) unregisterSecret(prev);
    registerSecret(token);
    this.writeMeta(dir, {
      kind: 'token',
      host,
      username: (p.username?.trim() || 'x-access-token').slice(0, 100),
    });
    return { stored: true };
  }

  clear(packId: string): void {
    const s = this.secretOf(packId);
    if (s) {
      unregisterSecret(s);
      for (const line of s.split('\n')) if (line.length > 20) unregisterSecret(line);
    }
    rmSync(this.dirOf(packId), { recursive: true, force: true });
  }

  private prepare(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(join(this.root, '.cred'), 0o700);
      chmodSync(dir, 0o700);
    } catch {
      // Windows: the data dir sits in the user's profile
    }
  }

  private writeMeta(dir: string, m: StoredCredential): void {
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(m), { mode: 0o600 });
  }

  /** The pinned host key line of the pack's host, or undefined before the first fetch pinned one. */
  hostKey(packId: string): string | undefined {
    try {
      const t = readFileSync(this.knownHostsFile(packId), 'utf8').trim();
      return t || undefined;
    } catch {
      return undefined;
    }
  }

  /** Writes a host key line the server remembered (a re-installed runner keeps the pin). */
  seedHostKey(packId: string, line: string): void {
    if (!existsSync(this.dirOf(packId))) return;
    if (this.hostKey(packId)) return;
    writeFileSync(this.knownHostsFile(packId), `${line.trim()}\n`, { mode: 0o600 });
  }
}

/**
 * Derives the public half with `ssh-keygen -y -P ''` (never prompts): that fails for a key with a passphrase or one that is not a
 * private key. `ok: undefined` when ssh-keygen is not installed (the key is then taken as it is).
 */
async function inspectKey(keyFile: string): Promise<{ ok: boolean | undefined; fingerprint?: string }> {
  const env = { PATH: process.env.PATH ?? '' };
  try {
    const pub = await execa('ssh-keygen', ['-y', '-P', '', '-f', keyFile], {
      timeout: 10_000,
      extendEnv: false,
      env,
      stdin: 'ignore',
    });
    const pubFile = `${keyFile}.pub`;
    writeFileSync(pubFile, `${pub.stdout.trim()}\n`, { mode: 0o600 });
    try {
      const r = await execa('ssh-keygen', ['-lf', pubFile], {
        timeout: 10_000,
        extendEnv: false,
        env,
        stdin: 'ignore',
      });
      return { ok: true, fingerprint: /(SHA256:\S+)/.exec(r.stdout)?.[1] as string };
    } finally {
      rmSync(pubFile, { force: true });
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { ok: undefined };
    return { ok: false };
  }
}
