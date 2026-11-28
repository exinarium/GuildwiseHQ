import { isSafeGitRef, type PostAsPlan } from '@aom/shared';
import { git, hasCommit, originTip } from '../git/git.ts';
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
import { latestTip, ruleA } from '../git/pushable-tips.ts';
import { isCardBranch, PROTECTED_BRANCHES } from './guard.ts';

/**
 * The git argv of the DevOps engineer's `aom git push|fetch --repo <dir>` (run by the runner with the repository's
 * credentials). Refspecs are plain `src[:dst]` names: no force (`+`), no options. A delete names plain branches only
 * (no `src:dst`) and never a protected branch: the guard's set (main, master, develop, trunk) plus the shift's own
 * protected branches (the project's working branch and the worktree base), the same rule as the guard's push check.
 */
export function devopsPushPlan(
  op: 'push' | 'fetch',
  refspecs: string[],
  del: boolean,
  tags: boolean,
  protectedBranches: readonly string[] = [],
): { args: string[]; operation: string } | { error: string } {
  if (op === 'fetch') {
    if (refspecs.length > 0 || del || tags) return { error: 'aom git fetch --repo <dir> takes no refspec' };
    return { args: ['fetch', '--prune', 'origin'], operation: 'fetch' };
  }
  // gate-fixes-2 B4: never all tags at once; a tag goes by name and only at a sha the runner recorded (resolveBrokerPush)
  if (tags) return { error: 'aom git push --tags is not available: push one tag by name (refs/tags/<tag>)' };
  if (refspecs.length === 0) return { error: 'aom git push --repo <dir> needs at least one refspec' };
  for (const r of refspecs) {
    if (r.startsWith('+') || r.startsWith('-'))
      return { error: `refusing ${JSON.stringify(r)}: aom git push never forces and takes no options` };
    const parts = r.split(':');
    if (
      parts.length > 2 ||
      parts.some((p) => p !== '' && !isSafeGitRef(p.replace(/^refs\/(heads|tags)\//, '')))
    )
      return { error: `refusing unsafe refspec ${JSON.stringify(r)}` };
    if (del && parts.length > 1)
      return { error: `--delete takes plain branch names, not ${JSON.stringify(r)}` };
    const dst = (parts[1] ?? parts[0] ?? '').replace(/^refs\/heads\//, '');
    if (del && (dst === 'HEAD' || PROTECTED_BRANCHES.includes(dst) || protectedBranches.includes(dst)))
      return { error: `refusing to delete ${dst} from origin: it is a protected branch` };
    if (!del && parts[0] === '') return { error: 'use --delete to remove a branch from origin' };
    // gate-fixes-2 B4: a card branch reaches origin only through the card's own finalize
    if (!del && !dst.startsWith('refs/tags/') && isCardBranch(dst))
      return {
        error: `refusing to push ${dst}: card branches go to origin only through the card's finalize`,
      };
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

/**
 * gate-fixes-2 B4 and Rule A for the broker: the push refspecs rewritten to the shas the runner checked. A protected
 * branch takes only its local branch's tip when that is a fast-forward of origin (Rule B) and the runner made or
 * recorded it (Rule A); a tag only the tag object the runner recorded. Other branches are passed as they are.
 */
export async function resolveBrokerPush(
  dir: string,
  refspecs: string[],
  protectedBranches: readonly string[],
  auth: { args: string[]; env: Record<string, string> },
): Promise<{ refspecs: string[] } | { error: string }> {
  const out: string[] = [];
  for (const r of refspecs) {
    const [src = '', dstRaw] = r.split(':');
    const dst = dstRaw ?? src;
    if (dst.startsWith('refs/tags/') || src.startsWith('refs/tags/')) {
      const tag = (dstRaw ?? src).replace(/^refs\/tags\//, '');
      const t = (await git(dir, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`])).stdout.trim();
      const rec = await latestTip(dir, `refs/tags/${tag}`);
      if (!t || rec?.sha !== t)
        return {
          error: `refusing to push the tag ${tag}: the runner did not make or record it at ${t.slice(0, 10)}`,
        };
      out.push(`${t}:refs/tags/${tag}`);
      continue;
    }
    const name = dst.replace(/^refs\/heads\//, '');
    if (!PROTECTED_BRANCHES.includes(name) && !protectedBranches.includes(name)) {
      out.push(r);
      continue;
    }
    const local = src.replace(/^refs\/heads\//, '');
    const tip = (
      await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${local}^{commit}`])
    ).stdout.trim();
    if (!tip) return { error: `refusing to push ${name}: ${local} is not a local branch` };
    // Rework 2 (B4): a protected branch goes out only from itself (`card:main` would land a card without its finalize);
    // Rule A is checked against the destination's own record
    if (local !== name) {
      const own = (
        await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${name}^{commit}`])
      ).stdout.trim();
      if (own !== tip)
        return { error: `refusing to push ${local} to ${name}: push ${name} from its own branch` };
    }
    let origin: string | null;
    try {
      origin = await originTip(dir, name, auth);
    } catch (err) {
      return { error: `refusing to push ${name}: origin could not be asked (${String(err).slice(0, 200)})` };
    }
    if (origin && !(await hasCommit(dir, origin)))
      return { error: `refusing to push ${name}: fetch first (origin's tip is not in this clone)` };
    if (origin && (await git(dir, ['merge-base', '--is-ancestor', origin, tip])).exitCode !== 0)
      return { error: `refusing to push ${name}: it is not a fast-forward of origin` };
    const a = await ruleA(dir, name, tip, origin);
    if (!a.push) {
      if ('notPushed' in a) return { error: `refusing to push ${name}: ${a.notPushed}` };
      continue; // nothing to push
    }
    out.push(`${tip}:refs/heads/${name}`);
  }
  return { refspecs: out };
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
