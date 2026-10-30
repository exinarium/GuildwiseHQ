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

  load(): T | undefined {
    try {
      if (!existsSync(this.file)) return undefined;
      const env = JSON.parse(readFileSync(this.file, 'utf8')) as Envelope;
      if (env.v !== 1 || env.alg !== 'A256GCM') return undefined;
      const d = createDecipheriv('aes-256-gcm', this.keyOf(this.name), Buffer.from(env.iv, 'base64'));
      d.setAAD(Buffer.from(this.name));
      d.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
      const parsed = this.schema.safeParse(JSON.parse(plain));
      if (!parsed.success) return undefined;
      for (const s of this.secretsOf(parsed.data)) registerSecret(s);
      return parsed.data;
    } catch {
      return undefined;
    }
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
