import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ZodType } from 'zod';
import { registerSecret } from './redact.ts';

/**
 * One secrets file on this workstation, encrypted at rest: `{ v: 1, alg: 'A256GCM', iv, ct, tag }`, mode 0600 in the
 * 0700 `secrets/` directory. The key comes from the runner's private key (`RunnerKeys.deriveFileKey`), so a copy of the
 * file alone (a backup, a sync folder) is useless. The same protection as the other runner secrets against root or the
 * same user on the machine: none.
 */
interface Envelope {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
  tag: string;
}

export type SealedRead<T> =
  | { state: 'missing' }
  | { state: 'ok'; value: T; migrated: boolean }
  | { state: 'unreadable'; reason: 'key' | 'damaged' };

const isEnvelope = (x: unknown): x is Envelope =>
  !!x &&
  typeof x === 'object' &&
  (x as Envelope).v === 1 &&
  (x as Envelope).alg === 'A256GCM' &&
  typeof (x as Envelope).iv === 'string' &&
  typeof (x as Envelope).ct === 'string' &&
  typeof (x as Envelope).tag === 'string';

/** The message for a secrets file that cannot be opened. It names no file contents and no secret. */
export const unreadableMessage = (what: string, how: string): string =>
  `The saved ${what} on this workstation cannot be read (the runner key changed or the file is damaged). ${how}`;

export class SealedFile<T> {
  constructor(
    private readonly file: string,
    private readonly keyOf: (fileName: string) => Buffer,
    private readonly schema: ZodType<T>,
    /** Values of the loaded secret that must never reach a log line. */
    private readonly secretsOf: (value: T) => string[] = () => [],
  ) {}

  private get name(): string {
    return basename(this.file);
  }

  /**
   * Reads the file and says why it holds nothing usable: missing, sealed with another key (or tampered: GCM cannot tell
   * the two apart) or damaged. With `legacy`, a file that is not an envelope but that `legacy` accepts (the plaintext
   * form a store used before it was sealed) is sealed in place: the new envelope is written to a 0600 temp file and
   * renamed over the plaintext, so no plaintext copy stays under any name. If that write fails, the value is still
   * returned and the next read tries again.
   */
  open(opts: { legacy?: (raw: unknown) => T | undefined } = {}): SealedRead<T> {
    if (!existsSync(this.file)) return { state: 'missing' };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return { state: 'unreadable', reason: 'damaged' };
    }
    if (!isEnvelope(raw)) {
      let value: T | undefined;
      try {
        value = opts.legacy?.(raw);
      } catch {
        value = undefined;
      }
      if (value === undefined) return { state: 'unreadable', reason: 'damaged' };
      for (const s of this.secretsOf(value)) registerSecret(s);
      try {
        this.save(value);
      } catch {
        return { state: 'ok', value, migrated: false };
      }
      return { state: 'ok', value, migrated: true };
    }
    let plain: string;
    try {
      const d = createDecipheriv('aes-256-gcm', this.keyOf(this.name), Buffer.from(raw.iv, 'base64'));
      d.setAAD(Buffer.from(this.name));
      d.setAuthTag(Buffer.from(raw.tag, 'base64'));
      plain = Buffer.concat([d.update(Buffer.from(raw.ct, 'base64')), d.final()]).toString('utf8');
    } catch {
      return { state: 'unreadable', reason: 'key' };
    }
    let parsed: ReturnType<ZodType<T>['safeParse']>;
    try {
      parsed = this.schema.safeParse(JSON.parse(plain));
    } catch {
      return { state: 'unreadable', reason: 'damaged' };
    }
    if (!parsed.success) return { state: 'unreadable', reason: 'damaged' };
    for (const s of this.secretsOf(parsed.data)) registerSecret(s);
    return { state: 'ok', value: parsed.data, migrated: false };
  }

  /** The value, or undefined when the file is missing, not sealed, sealed with another key or damaged. */
  load(): T | undefined {
    try {
      const r = this.open();
      return r.state === 'ok' ? r.value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Moves an unreadable file aside (it stays encrypted) as `<name>.unreadable-<timestamp>`, so a new save does not
   * destroy it and it can still be opened if the old runner key comes back. Returns the new path.
   */
  quarantine(): string | undefined {
    if (!existsSync(this.file)) return undefined;
    const to = `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(this.file, to);
    try {
      chmodSync(to, 0o600);
    } catch {
      // not supported on every platform
    }
    return to;
  }

  save(value: T): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // not supported on every platform
    }
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keyOf(this.name), iv);
    c.setAAD(Buffer.from(this.name));
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    const env: Envelope = {
      v: 1,
      alg: 'A256GCM',
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(env)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // not supported on every platform
    }
    renameSync(tmp, this.file);
    for (const s of this.secretsOf(value)) registerSecret(s);
  }

  remove(): boolean {
    if (!existsSync(this.file)) return false;
    rmSync(this.file, { force: true });
    return true;
  }
}
