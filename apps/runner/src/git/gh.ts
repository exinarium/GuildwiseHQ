import { execa } from 'execa';

export interface PrInput {
  cwd: string;
  base: string;
  branch: string;
  title: string;
  body: string;
}
export type PrResult = { url?: string } | { unavailable: string };

/** Opens a pull request. A seam: real use shells out to `gh`, tests inject a fake (nothing talks to GitHub from tests). */
export interface PrCreator {
  create(input: PrInput): Promise<PrResult>;
}

/** `gh pr create` when `gh` is installed; otherwise reports `unavailable` so the caller can push and notify instead. */
export const ghPrCreator: PrCreator = {
  async create(input) {
    let r: Awaited<ReturnType<typeof execa>>;
    try {
      r = await execa(
        'gh',
        [
          'pr',
          'create',
          '--base',
          input.base,
          '--head',
          input.branch,
          '--title',
          input.title,
          '--body',
          input.body,
        ],
        { cwd: input.cwd, reject: false, stdin: 'ignore', timeout: 120_000 },
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return { unavailable: 'gh is not available' };
      throw err;
    }
    if (r.failed && (r as { code?: string }).code === 'ENOENT') return { unavailable: 'gh is not available' };
    if (r.exitCode !== 0) throw new Error(`gh pr create failed: ${String(r.stderr || r.stdout).trim()}`);
    const url = String(r.stdout)
      .split('\n')
      .reverse()
      .find((l) => /^https?:\/\//.test(l.trim()));
    return url ? { url: url.trim() } : {};
  },
};
