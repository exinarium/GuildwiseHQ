import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * A full disk killed a shift in P5-27 (`/tmp` was full, #81) and the card was offered again every 39 seconds for hours.
 * Before a shift starts the runner checks the free space of the places a shift writes to (the OS temp folder, where each
 * agent's TMPDIR lives, and the data folder: worktrees, logs, caches) and refuses with `disk_full: ...`, which the server
 * answers with a back-off rather than an immediate retry.
 */
export const MIN_TMP_FREE_BYTES = 512 * 1024 * 1024;
export const MIN_DATA_FREE_BYTES = 1024 * 1024 * 1024;

export function freeBytes(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

const mb = (n: number): string => `${Math.round(n / (1024 * 1024))} MB`;

/** What is wrong with the disk, or null when there is room. A folder that cannot be measured is not a problem. */
export function diskProblem(
  dataDir: string,
  opts: {
    free?: (path: string) => number;
    tmpDir?: string;
    minTmp?: number;
    minData?: number;
  } = {},
): string | null {
  const free = opts.free ?? freeBytes;
  const tmpDir = opts.tmpDir ?? tmpdir();
  const checks: Array<[string, number]> = [
    [tmpDir, opts.minTmp ?? MIN_TMP_FREE_BYTES],
    [dataDir, opts.minData ?? MIN_DATA_FREE_BYTES],
  ];
  const lines: string[] = [];
  for (const [path, min] of checks) {
    let have: number;
    try {
      have = free(path);
    } catch {
      continue;
    }
    if (have < min) lines.push(`${path} has ${mb(have)} free (needs ${mb(min)})`);
  }
  if (lines.length === 0) return null;
  return `disk_full: ${lines.join('; ')}. No shift can start on this workstation until space is freed (the DevOps engineer can clean up).`;
}
