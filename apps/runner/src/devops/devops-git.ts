import { isSafeGitRef, type PostAsPlan } from '@aom/shared';
import { CONVENTIONAL_MAIN_BRANCHES } from '../git/git.ts';
import {
  AppIdentityError,
  type AppTokenProbe,
  appIdentityWire,
  boundPostAsFor,
  type CommitIdentity,
  inContext,
  repoNameOf,
  resolveCommitIdentity,
} from '../git/identity.ts';

/**
 * The git argv of the DevOps engineer's `aom git push|fetch --repo <dir>` (run by the runner with the repository's
 * credentials). Refspecs are plain `src[:dst]` names: no force (`+`), no options, no main branch deleted.
 */
export function devopsPushPlan(
  op: 'push' | 'fetch',
  refspecs: string[],
  del: boolean,
  tags: boolean,
): { args: string[]; operation: string } | { error: string } {
  if (op === 'fetch') {
    if (refspecs.length > 0 || del || tags) return { error: 'aom git fetch --repo <dir> takes no refspec' };
    return { args: ['fetch', '--prune', 'origin'], operation: 'fetch' };
  }
  if (refspecs.length === 0 && !tags)
    return { error: 'aom git push --repo <dir> needs at least one refspec' };
  for (const r of refspecs) {
    if (r.startsWith('+') || r.startsWith('-'))
      return { error: `refusing ${JSON.stringify(r)}: aom git push never forces and takes no options` };
    const parts = r.split(':');
    if (
      parts.length > 2 ||
      parts.some((p) => p !== '' && !isSafeGitRef(p.replace(/^refs\/(heads|tags)\//, '')))
    )
      return { error: `refusing unsafe refspec ${JSON.stringify(r)}` };
    const dst = (parts[1] ?? parts[0] ?? '').replace(/^refs\/heads\//, '');
    if (del && CONVENTIONAL_MAIN_BRANCHES.includes(dst))
      return { error: `refusing to delete ${dst} from origin` };
    if (!del && parts[0] === '') return { error: 'use --delete to remove a branch from origin' };
  }
  const operation = del
    ? 'delete branch'
    : tags || refspecs.some((r) => r.startsWith('refs/tags/'))
      ? 'push tag'
      : 'push';
  return {
    args: [
      'push',
      ...(del ? ['--delete'] : []),
      ...(tags ? ['--tags'] : []),
      'origin',
      ...(refspecs.length ? ['--', ...refspecs] : []),
    ],
    operation,
  };
}

/** Where a raw push to an app repository goes from the DevOps engineer's shell: nowhere (the host does not resolve). */
export const APP_PUSH_REFUSED_URL = 'https://app-push-refused.invalid/';

/**
 * The DevOps engineer's environment with a `pushInsteadOf` for every repository of the plan that posts as an app (its
 * https and ssh forms, with and without `.git`): a raw `git push` there fails at DNS instead of going out with the
 * user's own credentials. A backstop behind the guard; `aom git push --repo` runs in the runner without it. Repositories
 * not on an app are untouched, and without app repositories the environment is returned as it is.
 */
export function withAppPushRefusal(
  env: Record<string, string>,
  plan: { repos: ReadonlyArray<{ remoteUrlNormalized: string; source: string }> } | null | undefined,
): Record<string, string> {
  const urls: string[] = [];
  for (const e of plan?.repos ?? []) {
    if (e.source !== 'app') continue;
    const n = e.remoteUrlNormalized.replace(/\.git$/, '');
    const slash = n.indexOf('/');
    if (slash <= 0) continue;
    const host = n.slice(0, slash);
    const path = n.slice(slash + 1);
    for (const u of [`https://${n}`, `ssh://git@${host}/${path}`, `git@${host}:${path}`])
      urls.push(u, `${u}.git`);
  }
  if (urls.length === 0) return env;
  const out = { ...env };
  let count = Number(out.GIT_CONFIG_COUNT ?? '0') || 0;
  for (const u of urls) {
    out[`GIT_CONFIG_KEY_${count}`] = `url.${APP_PUSH_REFUSED_URL}.pushInsteadOf`;
    out[`GIT_CONFIG_VALUE_${count}`] = u;
    count++;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

/**
 * The commit identity of a DevOps request about a card whose repository posts as an app (a conflict resolution): the
 * app's bot, checked to mint first. Null when the card repository is not on an app (today's identity). A wire error
 * (`app_identity_failed: ...`, naming the project, the app and the operation) when the app cannot be used.
 */
export async function devopsRequestIdentity(
  plan: PostAsPlan | null | undefined,
  cardRemoteUrlNormalized: string | null | undefined,
  root: string,
  probe: AppTokenProbe | null | undefined,
): Promise<CommitIdentity | null | string> {
  const bound = cardRemoteUrlNormalized ? boundPostAsFor(plan, cardRemoteUrlNormalized, probe) : null;
  if (!cardRemoteUrlNormalized || bound?.source !== 'app') return null;
  try {
    return await resolveCommitIdentity(root, null, bound);
  } catch (err) {
    if (!(err instanceof AppIdentityError)) throw err;
    return appIdentityWire(
      inContext(err, {
        ...(bound.projectKey ? { projectKey: bound.projectKey } : {}),
        operation: 'DevOps request',
        repo: repoNameOf(cardRemoteUrlNormalized),
      }),
    );
  }
}
