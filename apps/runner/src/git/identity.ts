import {
  type CommitAs,
  type CommitIdentitySource,
  NO_COMMIT_IDENTITY_CODE,
  NO_COMMIT_IDENTITY_MESSAGE,
  type RepoIdentityFact,
} from '@aom/shared';
import { git } from './git.ts';

/*
 * One resolver for EVERY commit the runner or an agent makes (backlog #65, "invisible organisation"): the commits read
 * as the owner's own work. Order:
 *   1. the project's "Commit as" setting (carried in shift.start / finalize.execute / repo.create),
 *   2. the clone's repository-level `git config user.name/user.email` (a card worktree shares the clone's config),
 *   3. the workstation user's global git config (then the system one), as the runner's OS user sees it,
 *   4. none: the commit is refused with NO_COMMIT_IDENTITY_MESSAGE. Never an agent or product name.
 * Name and e-mail come from the same level; a level that has only one of them is skipped.
 */

export interface CommitIdentity {
  name: string;
  email: string;
  source: CommitIdentitySource;
}

/** The commit was refused because no identity is set anywhere. */
export class NoCommitIdentityError extends Error {
  readonly code = NO_COMMIT_IDENTITY_CODE;
  constructor() {
    super(NO_COMMIT_IDENTITY_MESSAGE);
  }
}

/** `no_commit_identity: <message>`: the form a refusal takes in a rejection or an error string that crosses the wire. */
export const NO_IDENTITY_WIRE = `${NO_COMMIT_IDENTITY_CODE}: ${NO_COMMIT_IDENTITY_MESSAGE}`;

export const isNoCommitIdentity = (err: unknown): boolean =>
  err instanceof NoCommitIdentityError ||
  (typeof err === 'string' && err.startsWith(NO_COMMIT_IDENTITY_CODE)) ||
  (err instanceof Error && err.message === NO_COMMIT_IDENTITY_MESSAGE);

async function level(
  cwd: string,
  scope: '--local' | '--global' | '--system',
): Promise<{ name: string; email: string } | null> {
  const get = async (key: string) => {
    const r = await git(cwd, ['config', scope, '--get', key]);
    return r.exitCode === 0 ? r.stdout.trim() : '';
  };
  const name = await get('user.name');
  const email = await get('user.email');
  return name && email ? { name, email } : null;
}

/** The identity commits get in `cwd` without a project setting: repository, then global, then system git config. */
export async function repoLevelIdentity(cwd: string): Promise<RepoIdentityFact | null> {
  for (const [scope, source] of [
    ['--local', 'repo'],
    ['--global', 'global'],
    ['--system', 'system'],
  ] as const) {
    const id = await level(cwd, scope);
    if (id) return { ...id, source };
  }
  return null;
}

/** The identity for a commit in `cwd` (a clone or one of its worktrees), or `null` when none is set anywhere. */
export async function resolveCommitIdentity(
  cwd: string,
  commitAs?: CommitAs | null,
): Promise<CommitIdentity | null> {
  if (commitAs?.name.trim() && commitAs.email.trim())
    return { name: commitAs.name.trim(), email: commitAs.email.trim(), source: 'project' };
  return repoLevelIdentity(cwd);
}

/** Like {@link resolveCommitIdentity} but throws {@link NoCommitIdentityError} when there is none. */
export async function requireCommitIdentity(
  cwd: string,
  commitAs?: CommitAs | null,
): Promise<CommitIdentity> {
  const id = await resolveCommitIdentity(cwd, commitAs);
  if (!id) throw new NoCommitIdentityError();
  return id;
}

/** Author and committer environment for one git process. */
export const commitEnv = (id: { name: string; email: string }): Record<string, string> => ({
  GIT_AUTHOR_NAME: id.name,
  GIT_AUTHOR_EMAIL: id.email,
  GIT_COMMITTER_NAME: id.name,
  GIT_COMMITTER_EMAIL: id.email,
});

/** Only the committer (a rebase keeps the authors of the commits it rewrites). */
export const committerEnv = (id: { name: string; email: string }): Record<string, string> => ({
  GIT_COMMITTER_NAME: id.name,
  GIT_COMMITTER_EMAIL: id.email,
});
