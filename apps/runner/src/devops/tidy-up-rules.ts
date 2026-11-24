import { CARD_BRANCH_PREFIXES, isSafeGitRef } from '@aom/shared';
import type { BranchLedger } from '../git/branch-ledger.ts';
import { PROTECTED_BRANCHES } from './guard.ts';

/**
 * The branch tidy-up's own rules (runner-authority-fixes T1). They live in the runner and take nothing from the server
 * that could widen them: a server-supplied name, prefix or "merged" answer can only narrow what is deleted.
 *
 * - Never: main, master, develop, development, trunk, any `release*` branch, the working branch, the main branch,
 *   the clone's current branch and origin's default branch (as git reports it in the same run).
 * - Origin: only a branch this runner pushed itself (the ledger), while origin's tip still contains what it pushed.
 * - Local: a branch the runner created or pushed (the ledger) or one under a runner-fixed Guildwise prefix.
 *
 * Quiet approvals' deterministic run ([B4]) reuses this module and the ledger unchanged.
 */

/** Branch names no tidy-up ever deletes, whatever the server says. */
export const NEVER_TIDY: readonly string[] = [
  ...new Set(['main', 'master', 'develop', 'development', 'trunk', ...PROTECTED_BRANCHES]),
];
const RELEASE_RE = /^release/i;

/** Runner-fixed card branch prefixes (never the project's server-supplied prefix). */
export const GUILDWISE_PREFIXES: readonly string[] = [
  ...CARD_BRANCH_PREFIXES,
  'guildwise/integration/',
  'aom-integration/',
];

export const hasRunnerPrefix = (branch: string): boolean =>
  GUILDWISE_PREFIXES.some((p) => branch.startsWith(p) && branch.length > p.length);

export interface TidyUpContext {
  /** The repository's working branch (courtesy: the ledger is the protection). */
  wb?: string | null;
  mainBranch?: string | null;
  /** The clone's checked-out branch. */
  current?: string | null;
  /** Origin's default branch (`git ls-remote --symref origin HEAD`, else `refs/remotes/origin/HEAD`). */
  originHead?: string | null;
}

/** Why `name` may never be tidied (null: no rule forbids it; the ledger still decides). */
export function tidyUpRefusal(name: string, ctx: TidyUpContext): string | null {
  if (!isSafeGitRef(name)) return 'not a safe branch name';
  const lower = name.toLowerCase();
  if (NEVER_TIDY.includes(lower)) return `${name} is a protected branch`;
  if (RELEASE_RE.test(name)) return `${name} is a release branch`;
  if (ctx.wb && name === ctx.wb) return `${name} is the working branch`;
  if (ctx.mainBranch && name === ctx.mainBranch) return `${name} is the main branch`;
  if (ctx.current && name === ctx.current) return `${name} is checked out in the clone`;
  if (ctx.originHead && name === ctx.originHead) return `${name} is the repository's default branch`;
  return null;
}

/** The runner pushed `ob` itself (and no rule forbids it): the sha it pushed, else null. */
export function mayDeleteOrigin(
  ledger: BranchLedger | undefined,
  repo: string,
  ob: string,
  ctx: TidyUpContext,
): string | null {
  if (!ledger || tidyUpRefusal(ob, ctx)) return null;
  return ledger.pushedSha(repo, ob);
}

/** The runner created or pushed `b`, or it carries a runner-fixed card prefix (and no rule forbids it). */
export function mayDeleteLocal(
  ledger: BranchLedger | undefined,
  repo: string,
  b: string,
  ctx: TidyUpContext,
): boolean {
  if (tidyUpRefusal(b, ctx)) return false;
  return hasRunnerPrefix(b) || !!ledger?.has(repo, b);
}
