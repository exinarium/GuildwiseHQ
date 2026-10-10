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

/** What the code host says about a branch: `protected`, `open` (no protection) or `unknown` (no CLI, no rights, another host). */
export type BranchProtection = 'protected' | 'open' | 'unknown';

/** Asks the code host whether a branch is protected. A seam: real use shells out to `gh api`, tests inject a fake. */
export interface BranchProtectionChecker {
  check(input: { cwd: string; branch: string }): Promise<BranchProtection>;
}

/** `gh api repos/{owner}/{repo}/branches/<branch>/protection`: success is protected, "Branch not protected" is open, anything else unknown. */
export const ghBranchProtection: BranchProtectionChecker = {
  async check({ cwd, branch }) {
    try {
      const r = await execa(
        'gh',
        ['api', `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}/protection`],
        { cwd, reject: false, stdin: 'ignore', timeout: 30_000 },
      );
      if (r.exitCode === 0) return 'protected';
      return /branch not protected/i.test(String(r.stderr) + String(r.stdout)) ? 'open' : 'unknown';
    } catch {
      return 'unknown';
    }
  },
};

/** A push the host rejected because the branch is protected (GitHub GH006/GH013, GitLab, Bitbucket and Azure wording). */
export function isProtectedBranchRejection(output: string): boolean {
  return /GH006|GH013|protected branch|branch is protected|pre-receive hook declined|push declined due to repository rule|TF402455/i.test(
    output,
  );
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
