import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { remoteWorkerConfig } from '../src/video/remote-worker.ts';

/**
 * Release-readiness O5: the secret key and the two-factor key can come from two separate files (`AOM_SECRET_KEY_FILE`,
 * `AOM_TWO_FACTOR_KEY_FILE`, compose secrets), so they no longer share one .env. The value never lands in
 * `config.env` or `process.env`, and an error never shows it.
 */
const dir = mkdtempSync(join(tmpdir(), 'aom-keyfiles-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// test-only placeholder values, not secrets
const SECRET = `test-secret-${'s'.repeat(30)}`;
const TWO_FACTOR = `test-two-factor-${'t'.repeat(40)}`;
const file = (name: string, text: string, mode = 0o400) => {
  const p = join(dir, name);
  rmSync(p, { force: true });
  writeFileSync(p, text, { mode });
  return p;
};
const base = () => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AOM_SECRET_KEY;
  delete env.AOM_TWO_FACTOR_KEY;
  delete env.AOM_SECRET_KEY_FILE;
  delete env.AOM_TWO_FACTOR_KEY_FILE;
  return env;
};

describe('O5: keys from separate files', () => {
  it('reads both keys from their own files, trimming the trailing newline', () => {
    const env = {
      ...base(),
      AOM_SECRET_KEY_FILE: file('secret_key', `${SECRET}\n`),
      AOM_TWO_FACTOR_KEY_FILE: file('two_factor_key', `  ${TWO_FACTOR}\r\n`),
    };
    const c = loadConfig(env);
    expect(c.secretKey).toBe(SECRET);
    expect(c.twoFactorKey).toBe(TWO_FACTOR);
    // never copied into the environment the config keeps, nor into process.env
    expect(c.env.AOM_SECRET_KEY).toBeUndefined();
    expect(c.env.AOM_TWO_FACTOR_KEY).toBeUndefined();
    expect(process.env.AOM_TWO_FACTOR_KEY).not.toBe(TWO_FACTOR);
    expect(JSON.stringify(c)).not.toContain('AOM_SECRET_KEY_FILE');
  });

  it('a file key goes through the same rules (too short, both keys equal)', () => {
    expect(() => loadConfig({ ...base(), AOM_TWO_FACTOR_KEY_FILE: file('short', 'too-short\n') })).toThrow();
    const same = file('same', `${TWO_FACTOR}\n`);
    expect(() => loadConfig({ ...base(), AOM_SECRET_KEY_FILE: same, AOM_TWO_FACTOR_KEY_FILE: same })).toThrow(
      /must differ/,
    );
  });

  it.each(['AOM_SECRET_KEY', 'AOM_TWO_FACTOR_KEY'])(
    'refuses %s set both as a value and as a file',
    (name) => {
      const value = name === 'AOM_SECRET_KEY' ? SECRET : TWO_FACTOR;
      const env = { ...base(), [name]: value, [`${name}_FILE`]: file(`both-${name}`, `${value}\n`) };
      expect(() => loadConfig(env)).toThrow(`${name} and ${name}_FILE are both set`);
    },
  );

  it('an unreadable or missing file names the variable and the errno, never a value', () => {
    let msg = '';
    try {
      loadConfig({ ...base(), AOM_SECRET_KEY_FILE: join(dir, 'nope') });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^AOM_SECRET_KEY_FILE .*nope cannot be read: ENOENT$/);
    if (process.getuid?.() !== 0) {
      const locked = file('locked', `${SECRET}\n`, 0o000);
      chmodSync(locked, 0o000);
      expect(() => loadConfig({ ...base(), AOM_SECRET_KEY_FILE: locked })).toThrow(
        /AOM_SECRET_KEY_FILE .* cannot be read: EACCES/,
      );
    }
  });

  it('an empty file is refused', () => {
    expect(() => loadConfig({ ...base(), AOM_TWO_FACTOR_KEY_FILE: file('empty', '\n\n') })).toThrow(
      /AOM_TWO_FACTOR_KEY_FILE .* is empty/,
    );
  });

  it('a remote render worker refuses the key file variables too', () => {
    for (const k of ['AOM_SECRET_KEY_FILE', 'AOM_TWO_FACTOR_KEY', 'AOM_TWO_FACTOR_KEY_FILE'])
      expect(() =>
        remoteWorkerConfig({ AOM_RENDER_SERVER_URL: 'https://hq.example.com', [k]: '/run/secrets/x' }),
      ).toThrow(`${k} is set`);
  });
});
