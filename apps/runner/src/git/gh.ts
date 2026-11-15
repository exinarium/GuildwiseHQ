import { type ForgeKind, type PostAsAppIdentity, type PostAsPlan, postAsFor } from '@aom/shared';
import { execa } from 'execa';

export interface PrInput {
  cwd: string;
  base: string;
  branch: string;
  title: string;
  body: string;
  /** The provider chosen on the repository (otherwise detected from the origin URL). */
  forge?: ForgeKind | null;
}
export type PrResult = { url?: string } | { unavailable: string };

/** Opens a pull request. A seam: real use goes through the repository's forge adapter (`forge/index.ts`), tests inject a fake (nothing talks to GitHub from tests). */
export interface PrCreator {
  create(input: PrInput): Promise<PrResult>;
}

/**
 * A push the host rejected because of a branch policy (GitHub GH006/GH013, GitLab, Bitbucket and Azure wording): the
 * completion then opens a pull/merge request through the repository's forge instead of failing.
 */
export function isProtectedBranchRejection(output: string): boolean {
  return /GH006|GH013|protected branch|branch is protected|pre-receive hook declined|push declined due to repository rule|TF402455|not allowed to push|pushes to this branch are not permitted/i.test(
    output,
  );
}

/**
 * What the owner must change when GitHub refused a push or an API call made as an app: the rule and the permission or
 * bypass the app needs. Null when the output is not one of the known refusals (or no app acted).
 */
export function describePushRejection(
  output: string,
  app?: { label: string; botName?: string } | null,
): string | null {
  if (!app) return null;
  const who = `the app '${app.label}'`;
  const gh006 = /GH006: Protected branch update failed for refs\/heads\/([^\s.]+(?:\.[^\s.]+)*)\.?/.exec(
    output,
  );
  if (gh006) {
    const branch = gh006[1] as string;
    const reason =
      /remote: error: ((?!GH006)[^\n]+)/.exec(output.slice(output.indexOf('GH006') + 5))?.[1]?.trim() ??
      'protected branch';
    return `GitHub refused the push to ${branch}: branch protection (${reason}). Give ${who} a bypass (Settings > Branches > the rule for ${branch} > "Allow specified actors to bypass required pull requests") or let changes go through a pull request.`;
  }
  const gh013 = /GH013: Repository rule violations found for refs\/heads\/(\S+?)\.?(?:\s|$)/.exec(output);
  if (gh013) {
    const rules = [...output.matchAll(/^remote:\s+-\s+(.+)$/gm)].map((m) => (m[1] as string).trim());
    return `GitHub refused the push to ${gh013[1]}: repository ruleset (${rules.length ? rules.join('; ') : 'rule violation'}). Add ${who} to the ruleset's bypass list (Settings > Rules > Rulesets > Bypass list).`;
  }
  const workflow = /refusing to allow a GitHub App to create or update workflow [`'"]?([^`'"\s]+)[`'"]?/.exec(
    output,
  );
  if (workflow)
    return `The change touches ${workflow[1]}; ${who} needs the Workflows: Read and write permission.`;
  const denied = /Permission to (\S+?)(?:\.git)? denied to ([^.\s]+)/.exec(output);
  if (denied || /The requested URL returned error: 403/.test(output)) {
    const repo = denied?.[1] ?? 'the repository';
    return `${who[0]?.toUpperCase()}${who.slice(1)} cannot write to ${repo}: it needs Contents: Read and write, and the installation must include ${repo}.`;
  }
  if (/Resource not accessible by integration/i.test(output))
    return `${who[0]?.toUpperCase()}${who.slice(1)} lacks a permission for this step: Pull requests: Read and write (pull requests, reviews), Contents: Read and write (releases), Administration: Read (branch rules).`;
  return null;
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

/** The app a repository posts as in a plan (for refusal reports), or null. */
export function appOfPlan(
  plan: PostAsPlan | null | undefined,
  remoteUrlNormalized: string,
): PostAsAppIdentity | null {
  const e = postAsFor(plan, remoteUrlNormalized);
  return e?.source === 'app' ? (e.app ?? null) : null;
}

/** `message` plus, on a following line, what the app needs when the host refused it ({@link describePushRejection}). */
export function withPushReport(
  message: string,
  why: string,
  app: { label: string; botName?: string } | null | undefined,
): string {
  const report = describePushRejection(why, app);
  return report ? `${message}\n${report}` : message;
}
