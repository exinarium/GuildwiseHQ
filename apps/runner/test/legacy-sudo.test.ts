import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { legacyDockerNote, removeLegacySudoVault } from '../src/secrets/legacy-sudo.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
afterEach(() => vi.restoreAllMocks());

const logger = () => {
  const lines: string[] = [];
  return { lines, log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } };
};

describe('removeLegacySudoVault (deps-without-sudo §6)', () => {
  it('removes sudo.enc in every pairing without reading or decrypting it; the log has only the path', () => {
    const root = tmp('aom-legacy-');
    const dirs = [root, join(root, 'pairings/uat-1')];
    for (const d of dirs) {
      mkdirSync(join(d, 'secrets'), { recursive: true });
      writeFileSync(join(d, 'secrets/sudo.enc'), 'CIPHERTEXT-NEVER-READ\n');
      // unreadable: removing it must not need to open it
      chmodSync(join(d, 'secrets/sudo.enc'), 0o000);
    }
    const decrypt = vi.spyOn(RunnerKeys.prototype, 'decrypt');
    const { lines, log } = logger();
    const removed = removeLegacySudoVault(dirs, log);
    expect(removed).toEqual(dirs.map((d) => join(d, 'secrets/sudo.enc')));
    for (const d of dirs) expect(existsSync(join(d, 'secrets/sudo.enc'))).toBe(false);
    expect(decrypt).not.toHaveBeenCalled();
    expect(lines).toEqual(
      dirs.map(
        (d) =>
          `removed the sealed sudo password file ${join(d, 'secrets/sudo.enc')} (sudo was removed in 1.10.0)`,
      ),
    );
    expect(lines.join('\n')).not.toContain('CIPHERTEXT');
    // idempotent, and a pairing without the file is quiet
    expect(removeLegacySudoVault(dirs, log)).toEqual([]);
  });

  it('refuses a symlinked file or secrets folder (the target survives)', () => {
    const root = tmp('aom-legacy-');
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sudo.enc'), 'x');
    const a = join(root, 'a');
    mkdirSync(join(a, 'secrets'), { recursive: true });
    symlinkSync(join(outside, 'sudo.enc'), join(a, 'secrets/sudo.enc'));
    const b = join(root, 'b');
    mkdirSync(b, { recursive: true });
    symlinkSync(outside, join(b, 'secrets'));
    const { lines, log } = logger();
    expect(removeLegacySudoVault([a, b], log)).toEqual([]);
    expect(existsSync(join(outside, 'sudo.enc'))).toBe(true);
    expect(lines.join('\n')).toMatch(/symlink/);
    expect(lines.join('\n')).toMatch(/not a real folder/);
  });

  it('says once that narrow mode was removed for an old policy.json', () => {
    const dir = tmp('aom-legacy-');
    writeFileSync(join(dir, 'policy.json'), '{"docker":"narrow"}');
    expect(legacyDockerNote(join(dir, 'policy.json'))).toContain(
      'narrow mode was removed: run guildwise-runner setup',
    );
    writeFileSync(join(dir, 'policy.json'), '{"docker":"rootless"}');
    expect(legacyDockerNote(join(dir, 'policy.json'))).toBeNull();
    expect(legacyDockerNote(join(dir, 'missing.json'))).toBeNull();
  });
});
