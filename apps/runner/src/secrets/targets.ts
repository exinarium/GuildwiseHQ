import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunnerKeys } from './keys.ts';
import { registerSecret, unregisterSecret } from './redact.ts';

/** Names of target secrets: environment-variable shaped, so they can go into a dotenv file. */
export const TARGET_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

export interface TargetSecretSetResult {
  stored: boolean;
  error?: string;
}

/**
 * Test accounts for remote targets (docs/design/run-and-integration-tests.md D11): `<data dir>/secrets/targets.json`
 * (mode 0600) maps a deploy target to `{NAME: ciphertext}`. The browser encrypts each value with the runner's public key;
 * the server relays the ciphertext and never holds the value. The runner decrypts when a tester shift on that target starts,
 * writes a 0600 dotenv file of the names the target declares into the shift's private temp dir (`AOM_ENV_SECRETS_FILE`) and
 * registers the values with the redaction registry, so logs and attached evidence never show them.
 */
export class TargetSecrets {
  constructor(
    private readonly deps: {
      file: string;
      keys: Pick<RunnerKeys, 'decrypt'> & { publicKey: { keyId: string } };
    },
  ) {
    // After a restart redaction must know the values before the first log line.
    for (const values of Object.values(this.all())) for (const c of Object.values(values)) this.register(c);
  }

  private all(): Record<string, Record<string, string>> {
    if (!existsSync(this.deps.file)) return {};
    try {
      const j = JSON.parse(readFileSync(this.deps.file, 'utf8')) as unknown;
      return j && typeof j === 'object' ? (j as Record<string, Record<string, string>>) : {};
    } catch {
      return {};
    }
  }

  private save(all: Record<string, Record<string, string>>): void {
    mkdirSync(dirname(this.deps.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, this.deps.file);
    try {
      chmodSync(this.deps.file, 0o600);
    } catch {
      // Windows
    }
  }

  private register(ciphertext: string): void {
    try {
      registerSecret(this.deps.keys.decrypt(ciphertext));
    } catch {
      // another key: the value is unreadable anyway
    }
  }

  /** `env.secret.set`: store one value for a target. Never returns or logs the value. */
  set(p: { targetId: string; name: string; keyId: string; ciphertext: string }): TargetSecretSetResult {
    if (!TARGET_SECRET_NAME.test(p.name))
      return { stored: false, error: 'the name must look like MY_ACCOUNT_PASSWORD' };
    if (p.keyId !== this.deps.keys.publicKey.keyId)
      return {
        stored: false,
        error: 'the value was encrypted for another key (the runner key changed): enter it again',
      };
    let plain: string;
    try {
      plain = this.deps.keys.decrypt(p.ciphertext);
    } catch {
      return { stored: false, error: 'the value could not be decrypted: enter it again' };
    }
    if (!plain) return { stored: false, error: 'empty value' };
    const all = this.all();
    const old = all[p.targetId]?.[p.name];
    if (old) {
      try {
        unregisterSecret(this.deps.keys.decrypt(old));
      } catch {
        // unreadable
      }
    }
    all[p.targetId] = { ...(all[p.targetId] ?? {}), [p.name]: p.ciphertext };
    this.save(all);
    registerSecret(plain);
    return { stored: true };
  }

  /** `env.secret.clear`: forget one value, or every value of the target. */
  clear(targetId: string, name?: string): void {
    const all = this.all();
    const mine = all[targetId];
    if (!mine) return;
    for (const [n, c] of Object.entries(mine)) {
      if (name && n !== name) continue;
      try {
        unregisterSecret(this.deps.keys.decrypt(c));
      } catch {
        // unreadable
      }
      delete mine[n];
    }
    if (Object.keys(mine).length === 0) delete all[targetId];
    this.save(all);
  }

  /** Names stored for a target (never values). */
  names(targetId: string): string[] {
    return Object.keys(this.all()[targetId] ?? {}).sort();
  }

  /** The values of the wanted names; names that are not stored come back as `missing`. */
  values(targetId: string, wanted: readonly string[]): { values: Record<string, string>; missing: string[] } {
    const stored = this.all()[targetId] ?? {};
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const n of wanted) {
      const c = stored[n];
      if (!c) {
        missing.push(n);
        continue;
      }
      try {
        values[n] = this.deps.keys.decrypt(c);
      } catch {
        missing.push(n);
      }
    }
    return { values, missing };
  }

  /** Writes the dotenv file for a shift (mode 0600, in the shift's own temp dir); returns its path, or null without values. */
  writeFile(
    dir: string,
    targetId: string,
    wanted: readonly string[],
  ): { path: string | null; missing: string[] } {
    const { values, missing } = this.values(targetId, wanted);
    const names = Object.keys(values);
    if (names.length === 0) return { path: null, missing };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'env-secrets.env');
    const quote = (v: string): string => `"${v.replace(/\r?\n/g, '\\n').replace(/"/g, '\\"')}"`;
    const body = names.map((n) => `${n}=${quote(values[n] as string)}`).join('\n');
    rmSync(path, { force: true });
    writeFileSync(path, `${body}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows
    }
    return { path, missing };
  }
}
