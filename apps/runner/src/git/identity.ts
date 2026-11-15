import {
  APP_ERROR_CODES,
  APP_ERROR_TEXT,
  APP_IDENTITY_FAILED_CODE,
  type AppErrorCode,
  type CommitAs,
  type CommitIdentitySource,
  NO_COMMIT_IDENTITY_CODE,
  NO_COMMIT_IDENTITY_MESSAGE,
  type PostAsAppRef,
  type PostAsPlan,
  type PostAsRepo,
  postAsFor,
  type RepoIdentityFact,
} from '@aom/shared';
import { git } from './git.ts';

/*
 * One resolver for EVERY commit the runner or an agent makes (backlog #65, "invisible organisation"): the commits read
 * as the owner's own work. Order:
 *   0. the project's selected app, when the server resolved this repository to it (`postAs.source === 'app'`): the
 *      bot identity, after checking the app can mint a token for the repository. If it cannot, AppIdentityError: the
 *      commit is refused, never made under another identity (fail closed),
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
  /** The app the identity belongs to (source 'app' only). */
  app?: PostAsAppRef;
}

/** A selected app could not be used: nothing is committed, pushed or posted under another identity. */
export class AppIdentityError extends Error {
  readonly code = APP_IDENTITY_FAILED_CODE;
  constructor(
    readonly app: { label: string; integrationId: string },
    readonly reason: string,
  ) {
    super(
      `The app ${app.label} could not be used: ${reason} Nothing was committed or pushed under another identity.`,
    );
  }
}

/** `app_identity_failed: <message>`: the form an app failure takes in a rejection or an error string on the wire. */
export const appIdentityWire = (e: AppIdentityError): string => `${APP_IDENTITY_FAILED_CODE}: ${e.message}`;

/** The wire form of any error: an app failure keeps its code, so the server can raise the right alert. */
export const identityErrorWire = (err: unknown): string | null =>
  err instanceof AppIdentityError ? appIdentityWire(err) : null;

/** Checks the app can mint a token for one repository. The token itself never leaves the broker. */
export interface AppTokenProbe {
  ensure(app: { instance: string; integrationId: string }, repoName: string): Promise<void>;
}

const NO_PROBE: AppTokenProbe = {
  ensure: async () => {
    throw Object.assign(new Error(APP_ERROR_TEXT.runner_too_old), { code: 'runner_too_old' });
  },
};

/**
 * A repository's post-as entry bound to the probe of the runner that received it. Each runner (one per pairing, several
 * in one process) has its own key store and broker, so the probe travels with the entry instead of living in a global.
 * An entry without a probe fails closed for an app identity.
 */
export type BoundPostAs = PostAsRepo & { readonly probe?: AppTokenProbe };

/** Binds a repository's post-as entry to this runner's probe (`null` stays `null`). */
export function bindPostAs(
  postAs: PostAsRepo | null | undefined,
  probe: AppTokenProbe | null | undefined,
): BoundPostAs | null {
  if (!postAs) return null;
  return probe ? { ...postAs, probe } : postAs;
}

/** The entry for `remoteUrlNormalized` in a plan, bound to this runner's probe. */
export function boundPostAsFor(
  plan: PostAsPlan | null | undefined,
  remoteUrlNormalized: string | null | undefined,
  probe: AppTokenProbe | null | undefined,
): BoundPostAs | null {
  return bindPostAs(postAsFor(plan, remoteUrlNormalized), probe);
}

const APP_CODES: ReadonlySet<string> = new Set(APP_ERROR_CODES);

/** A value-free reason: the provider's one sentence for a typed code, else the generic one. Never `String(err)`. */
export function appReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && APP_CODES.has(code)) return APP_ERROR_TEXT[code as AppErrorCode];
  return APP_ERROR_TEXT.unexpected;
}

/** `owner/name` of a normalized remote (`github.com/owner/name`). */
export function repoNameOf(remoteUrlNormalized: string): string {
  const parts = remoteUrlNormalized
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  return parts.slice(-2).join('/');
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
  postAs?: BoundPostAs | null,
): Promise<CommitIdentity | null> {
  if (postAs?.source === 'app') {
    const app = postAs.app;
    if (!app)
      throw new AppIdentityError(
        { label: 'unknown app', integrationId: '' },
        'The app reference is missing.',
      );
    try {
      await (postAs.probe ?? NO_PROBE).ensure(
        { instance: app.instance, integrationId: app.integrationId },
        repoNameOf(postAs.remoteUrlNormalized),
      );
    } catch (err) {
      throw new AppIdentityError(app, appReason(err));
    }
    return {
      name: app.botName,
      email: app.botEmail,
      source: 'app',
      app: { integrationId: app.integrationId, provider: app.provider },
    };
  }
  if (commitAs?.name.trim() && commitAs.email.trim())
    return { name: commitAs.name.trim(), email: commitAs.email.trim(), source: 'project' };
  return repoLevelIdentity(cwd);
}

/** Like {@link resolveCommitIdentity} but throws {@link NoCommitIdentityError} when there is none. */
export async function requireCommitIdentity(
  cwd: string,
  commitAs?: CommitAs | null,
  postAs?: BoundPostAs | null,
): Promise<CommitIdentity> {
  const id = await resolveCommitIdentity(cwd, commitAs, postAs);
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
