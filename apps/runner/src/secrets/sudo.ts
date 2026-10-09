import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SudoSetPayload, SudoSetResult } from '@aom/shared';
import type { ExecOptions, ExecResult, Executor } from '../toolchain/exec.ts';
import type { RunnerKeys } from './keys.ts';
import { redact, registerSecret, unregisterSecret } from './redact.ts';

export type SudoMode = 'root' | 'passwordless' | 'password' | 'none' | 'unsupported';

/**
 * The sudo password of the workstation's DevOps engineer, and the only code that uses it.
 *
 * Storage: the browser encrypts the password with the runner's public key (RSA-OAEP, `keys.ts`) and the server only
 * relays the ciphertext. The runner keeps that ciphertext in `<data dir>/secrets/sudo.enc` (mode 0600) and decrypts it
 * in memory when a command needs it. The plain password is registered with the redaction registry (so logs and command
 * output never show it) and is written to the stdin of `sudo -S` only; it is never a command-line argument, an
 * environment variable, an event or an RPC answer.
 */
export class SudoVault {
  constructor(
    private readonly deps: {
      file: string;
      keys: RunnerKeys;
      exec: Executor;
      platform?: NodeJS.Platform;
      /** Effective user id; 0 = already root (tests set it). */
      uid?: () => number;
    },
  ) {
    // After a restart, redaction must know the password before the first log line.
    const p = this.password();
    if (p) registerSecret(p);
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private isRoot(): boolean {
    const uid = this.deps.uid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : -1));
    return uid() === 0;
  }

  /** Is a password stored? */
  has(): boolean {
    return existsSync(this.deps.file);
  }

  private password(): string | null {
    if (!this.has()) return null;
    try {
      return this.deps.keys.decrypt(readFileSync(this.deps.file, 'utf8').trim());
    } catch {
      return null;
    }
  }

  /** `sudo.set` command: decrypt, store, and try it. Never returns or logs the password. */
  async set(p: SudoSetPayload): Promise<SudoSetResult> {
    if (p.keyId !== this.deps.keys.publicKey.keyId)
      return {
        stored: false,
        error: 'the password was encrypted for another key (the runner key changed): enter it again',
      };
    let plain: string;
    try {
      plain = this.deps.keys.decrypt(p.ciphertext);
    } catch {
      return { stored: false, error: 'the password could not be decrypted: enter it again' };
    }
    if (!plain) return { stored: false, error: 'empty password' };
    const old = this.password();
    if (old) unregisterSecret(old);
    mkdirSync(dirname(this.deps.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.deps.file, `${p.ciphertext}\n`, { mode: 0o600 });
    try {
      chmodSync(this.deps.file, 0o600);
    } catch {
      // Windows
    }
    registerSecret(plain);
    const works = await this.passwordWorks(plain);
    return { stored: true, works, ...(works ? {} : { error: 'stored, but sudo did not accept it' }) };
  }

  clear(): void {
    const old = this.password();
    if (old) unregisterSecret(old);
    rmSync(this.deps.file, { force: true });
  }

  private async passwordWorks(plain: string): Promise<boolean> {
    if (this.platform === 'win32') return false;
    const r = await this.deps.exec.run('sudo', ['-S', '-p', '', '-k', '-v'], {
      input: `${plain}\n`,
      timeoutMs: 15_000,
    });
    return r.exitCode === 0;
  }

  /** How privileged commands can run on this machine right now. */
  async mode(): Promise<{ mode: SudoMode; detail: string }> {
    if (this.platform === 'win32') {
      const r = await this.deps.exec.run('net', ['session'], { timeoutMs: 10_000 });
      return r.exitCode === 0
        ? { mode: 'root', detail: 'the runner runs elevated (administrator)' }
        : { mode: 'unsupported', detail: 'the runner is not elevated; sudo does not exist on Windows' };
    }
    if (this.isRoot()) return { mode: 'root', detail: 'the runner runs as root' };
    const probe = await this.deps.exec.run('sudo', ['-n', 'true'], { timeoutMs: 10_000 });
    if (probe.exitCode === 0)
      return { mode: 'passwordless', detail: 'sudo works without a password for this user' };
    if (probe.exitCode === 127) return { mode: 'none', detail: 'sudo is not installed' };
    const pw = this.password();
    if (pw) {
      return (await this.passwordWorks(pw))
        ? { mode: 'password', detail: 'sudo works with the stored password' }
        : { mode: 'none', detail: 'the stored sudo password was not accepted: enter it again' };
    }
    return { mode: 'none', detail: 'sudo needs a password and none is stored' };
  }

  /**
   * Runs `cmd args` as root: directly when the runner is root, with `sudo -n` when sudo needs no password, else with
   * `sudo -S` and the stored password on stdin. Output is redacted.
   */
  async run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.platform === 'win32' || this.isRoot()) return this.deps.exec.run(cmd, args, opts);
    const passwordless = await this.deps.exec.run('sudo', ['-n', 'true'], { timeoutMs: 10_000 });
    if (passwordless.exitCode === 0) return this.deps.exec.run('sudo', ['-n', '--', cmd, ...args], opts);
    const pw = this.password();
    if (!pw)
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'sudo needs a password and none is stored on this workstation',
      };
    const r = await this.deps.exec.run('sudo', ['-S', '-p', '', '--', cmd, ...args], {
      ...opts,
      input: `${pw}\n`,
    });
    return { ...r, stdout: redact(r.stdout), stderr: redact(r.stderr) };
  }
}
