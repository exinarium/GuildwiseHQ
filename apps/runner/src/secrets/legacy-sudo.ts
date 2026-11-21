import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 1.10.0 removed the sealed sudo password (DESIGN deps-without-sudo §6): at every start the runner deletes
 * `secrets/sudo.enc` of each pairing. The file is never opened or decrypted; a symlink (as the file or as `secrets/`)
 * is refused, and a file that cannot be removed is only logged. The log names the path, never anything inside.
 */
export function removeLegacySudoVault(
  pairingDirs: readonly string[],
  log: { info(m: string): void; warn(m: string): void },
): string[] {
  const removed: string[] = [];
  for (const dir of pairingDirs) {
    const secrets = join(dir, 'secrets');
    const file = join(secrets, 'sudo.enc');
    try {
      const sd = lstatSync(secrets, { throwIfNoEntry: false });
      if (!sd) continue;
      if (sd.isSymbolicLink() || !sd.isDirectory()) {
        log.warn(`not removing ${file}: ${secrets} is not a real folder`);
        continue;
      }
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isSymbolicLink()) {
        log.warn(`not following the symlink ${file}; remove it yourself (sudo was removed in 1.10.0)`);
        continue;
      }
      unlinkSync(file);
      removed.push(file);
      log.info(`removed the sealed sudo password file ${file} (sudo was removed in 1.10.0)`);
    } catch (err) {
      // ENOENT/EACCES and the like are not fatal: say where, carry on
      log.warn(`could not remove ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  return removed;
}

/** A policy.json written before 1.10.0 that chose narrow mode (it now reads as `none`): one line saying so. */
export function legacyDockerNote(policyFile: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(policyFile, 'utf8')) as { docker?: unknown };
    return raw.docker === 'narrow'
      ? 'narrow mode was removed: run guildwise-runner setup (the runner has no Docker until then)'
      : null;
  } catch {
    return null;
  }
}
