import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * runner-bare-bin (S1): fake runtime binaries live outside every temp root (the box refuses a binary under `/tmp`, the system
 * tmp, the agent tmp root or the runner data root): a mode 0700 folder in the account home, removed after the file.
 */
const homes: string[] = [];
let hooked = false;

export function binHome(): string {
  if (!hooked) {
    hooked = true;
    afterAll(() => {
      for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
    });
  }
  const d = mkdtempSync(join(userInfo().homedir, '.aom-test-bin-'));
  chmodSync(d, 0o700);
  homes.push(d);
  return d;
}
