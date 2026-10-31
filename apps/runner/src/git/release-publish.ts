import { join } from 'node:path';
import {
  changelogSection,
  decideTag,
  type ForgeKind,
  forgeHasReleasePages,
  isLatestRelease,
  isSafeGitRef,
  noReleasePageText,
  RELEASE_TAG_RE,
  type ReleasePublishPayload,
  type ReleasePublishResult,
  type ReleasePublishStep,
  repoTagUrl,
} from '@aom/shared';
import { forgeForUrl } from '../forge/index.ts';
import { errText, ForgeUnavailableError } from '../forge/http.ts';
import type { ChangeState, ForgeEnv } from '../forge/types.ts';
import { detectSignOff } from './dco.ts';
import { isProtectedBranchRejection, type PrCreator } from './gh.ts';
import { git, hasRemote, revParse } from './git.ts';
import { commitEnv, NO_IDENTITY_WIRE, NoCommitIdentityError, requireCommitIdentity } from './identity.ts';
import { integrationBranchName, withIntegrationWorktree } from './integration.ts';
import { isAncestor } from './merged.ts';
import { resolveReleaseBase } from './release-pr.ts';
import { withRepoLock } from './repo-lock.ts';
import type { GitAuth } from './worktrees.ts';

export interface ReleasePublishInput {
  payload: ReleasePublishPayload;
  repoPath: string;
  integrationDir: string;
  forgeEnv: ForgeEnv;
  auth?: GitAuth;
  /** Opens the release PR when main is protected and Guildwise had to merge itself. */
  pr?: PrCreator;
}

const trim = (s: string): string => s.trim().slice(0, 3500);

function failed(
  step: ReleasePublishStep,
  error: string,
  extra: Partial<ReleasePublishResult> = {},
): ReleasePublishResult {
  return { ok: false, stage: 'failed', failedStep: step, error: trim(error), ...extra };
}

/**
 * `release.publish`: land (the release commit is on main), tag, forge release. Every step is worked out again from git
 * and the forge on each run, so a rerun or a Retry continues where it stopped and creates nothing twice. A tag is never
 * moved, nothing is forced, an existing release is never edited. Never throws for expected failures.
 */
export async function publishRelease(input: ReleasePublishInput): Promise<ReleasePublishResult> {
  try {
    return await withRepoLock(input.repoPath, () => publishLocked(input));
  } catch (err) {
    return failed('land', errText(err));
  }
}

async function publishLocked(input: ReleasePublishInput): Promise<ReleasePublishResult> {
  const { payload: p, repoPath } = input;
  for (const ref of [p.workingBranch, p.tag, ...(p.mainBranch ? [p.mainBranch] : [])])
    if (!isSafeGitRef(ref)) return failed('land', `refusing unsafe name ${JSON.stringify(ref)}`);
  if (!RELEASE_TAG_RE.test(p.tag) || p.tag !== `v${p.version}`)
    return failed('land', `${p.tag} is not the release tag of ${p.version}`);
  if (!(await hasRemote(repoPath))) return failed('land', 'the repository has no origin remote');
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };
  const authEnv = { env: a.env };

  const resolved = await resolveReleaseBase(repoPath, { base: p.mainBranch, forge: p.forge }, input.auth, 'cannot publish');
  if (!resolved.ok) return failed('land', resolved.error);
  const base = resolved.base;
  const baseRef = `refs/remotes/origin/${base}`;
  const fetchBase = () => git(repoPath, [...a.args, 'fetch', '--', 'origin', base], authEnv);
  const f1 = await fetchBase();
  if (f1.exitCode !== 0) return failed('land', `could not fetch ${base}: ${(f1.stderr || f1.stdout).trim()}`);
  await git(repoPath, [...a.args, 'fetch', '--', 'origin', p.workingBranch], authEnv);

  // 1. land
  const R = p.releaseCommitSha;
  if ((await git(repoPath, ['cat-file', '-e', `${R}^{commit}`])).exitCode !== 0)
    return failed(
      'land',
      'the release commit is not in this clone (was the working branch rewritten?). Ship the release again.',
    );

  let landed: NonNullable<ReleasePublishResult['land']> | null = null;
  let target: string | null = null;
  if (await isAncestor(repoPath, R, baseRef)) {
    target = await firstParentTarget(repoPath, R, baseRef);
    landed = { mode: p.land.mode, mergeSha: target, by: 'found', ...(p.land.mode === 'pr' && p.land.prUrl ? { prUrl: p.land.prUrl } : {}) };
  } else if (p.land.mode === 'pr') {
    const out = await landByPr(input, base, baseRef, fetchBase);
    if ('result' in out) return out.result;
    target = out.sha;
    landed = { mode: 'pr', mergeSha: out.sha, by: 'forge', ...(p.land.prUrl ? { prUrl: p.land.prUrl } : {}) };
  } else {
    const out = await landByMerge(input, a, base, baseRef);
    if ('result' in out) return out.result;
    target = out.sha;
    landed = { mode: 'merge', mergeSha: out.sha, by: 'guildwise', signedOff: out.signedOff };
  }
  const carry: Partial<ReleasePublishResult> = { land: landed };

  // 2. tag
  const remoteTag = await git(
    repoPath,
    [...a.args, 'ls-remote', '--tags', 'origin', `refs/tags/${p.tag}`, `refs/tags/${p.tag}^{}`],
    authEnv,
  );
  if (remoteTag.exitCode !== 0)
    return failed('tag', `could not list the tags of origin: ${(remoteTag.stderr || remoteTag.stdout).trim()}`, carry);
  const remoteSha = peeledTag(remoteTag.stdout, p.tag);
  const localRaw = await git(repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${p.tag}^{commit}`]);
  const localSha = localRaw.exitCode === 0 ? localRaw.stdout.trim() : null;
  const decision = decideTag({ tag: p.tag, target, remote: remoteSha, local: localSha });
  if (decision.action === 'refuse') return failed('tag', decision.message, carry);

  // the notes come from CHANGELOG.md at the tag target: it must hold the version
  let notes: string;
  if (p.notesSource === 'commits') {
    notes = p.notes?.trim() || `Release ${p.version}.`;
  } else {
    const shown = await git(repoPath, ['show', `${target}:CHANGELOG.md`]);
    const section = shown.exitCode === 0 ? changelogSection(shown.stdout, p.version) : null;
    if (section === null)
      return failed(
        'tag',
        `CHANGELOG.md on ${base} at ${target.slice(0, 10)} has no section for ${p.version}`,
        carry,
      );
    notes = section || `Release ${p.version}.`;
  }

  if (decision.action === 'create') {
    let identity;
    try {
      identity = await requireCommitIdentity(repoPath, p.commitAs);
    } catch (err) {
      return failed('tag', err instanceof NoCommitIdentityError ? NO_IDENTITY_WIRE : errText(err), carry);
    }
    const made = await git(repoPath, ['tag', '-a', p.tag, '-m', p.title, target], { env: commitEnv(identity) });
    if (made.exitCode !== 0) return failed('tag', `git tag failed: ${(made.stderr || made.stdout).trim()}`, carry);
  }
  if (decision.action === 'create' || decision.action === 'push') {
    const push = await git(repoPath, [...a.args, 'push', 'origin', `refs/tags/${p.tag}`], authEnv);
    if (push.exitCode !== 0)
      return failed('tag', `pushing ${p.tag} failed: ${(push.stderr || push.stdout).trim()}`, carry);
  }
  const tagUrl = repoTagUrl(url, p.tag, p.forge);
  carry.tag = {
    name: p.tag,
    target,
    state: decision.action === 'report' ? 'existed' : 'created',
    url: tagUrl,
  };

  // 3. the forge release
  const hit = forgeForUrl(input.forgeEnv, url, p.forge);
  const kind: ForgeKind = hit?.forge.kind ?? p.forge ?? 'git';
  if (!hit || !hit.forge.caps.releases || !hit.forge.createRelease || !hit.forge.findRelease || !forgeHasReleasePages(kind)) {
    return {
      ok: true,
      stage: 'done',
      ...carry,
      release: { state: 'none', url: null, message: noReleasePageText(kind, p.tag) },
    };
  }
  try {
    const found = await hit.forge.findRelease(hit.repo, p.tag);
    if (found) {
      return {
        ok: true,
        stage: 'done',
        ...carry,
        release: {
          state: 'existed',
          url: found.url,
          ...(found.draft ? { message: 'A draft release exists for this tag: publish it on the forge.' } : {}),
        },
      };
    }
    const tags = await git(repoPath, [...a.args, 'ls-remote', '--tags', 'origin', 'refs/tags/v*'], authEnv);
    const remoteTags = tags.stdout
      .split('\n')
      .map((l) => /refs\/tags\/(\S+?)(\^\{\})?$/.exec(l.trim())?.[1])
      .filter((t): t is string => !!t);
    const latest = isLatestRelease(p.version, remoteTags);
    const made = await hit.forge.createRelease(hit.repo, {
      tag: p.tag,
      title: p.title,
      notes,
      latest,
      prerelease: p.version.includes('-'),
    });
    return {
      ok: true,
      stage: 'done',
      ...carry,
      release: { state: 'created', url: made.url, latest },
    };
  } catch (err) {
    const msg = err instanceof ForgeUnavailableError ? `${errText(err)}` : errText(err);
    return failed('publish', msg, carry);
  }
}

/** The commit of `base` to tag: the first-parent commit that brought `R` in, or `R` itself when it was fast-forwarded. */
async function firstParentTarget(repoPath: string, R: string, baseRef: string): Promise<string> {
  const list = await git(repoPath, ['rev-list', '--first-parent', '--ancestry-path', `${R}..${baseRef}`]);
  const shas = list.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const oldest = shas[shas.length - 1];
  if (!oldest) return R;
  const parent = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${oldest}^1`])).stdout.trim();
  return parent === R ? R : oldest;
}

/** The commit a remote tag peels to (annotated: the `^{}` line; lightweight: the ref line). */
function peeledTag(out: string, tag: string): string | null {
  let direct: string | null = null;
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    if (m[2] === `refs/tags/${tag}^{}`) return m[1] as string;
    if (m[2] === `refs/tags/${tag}`) direct = m[1] as string;
  }
  return direct;
}

type Landing = { sha: string } | { result: ReleasePublishResult };

async function landByPr(
  input: ReleasePublishInput,
  base: string,
  baseRef: string,
  refetch: () => Promise<unknown>,
): Promise<Landing> {
  const { payload: p, repoPath } = input;
  const waiting = (reason: string, prState: ChangeState | null): Landing => ({
    result: { ok: true, stage: 'waiting', waiting: { reason, prState } },
  });
  const prUrl = p.land.mode === 'pr' ? p.land.prUrl : undefined;
  if (!prUrl) return waiting('the release pull request is not merged yet', null);
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const hit = forgeForUrl(input.forgeEnv, url, p.forge);
  const id = /\/(?:pull|pull-requests|merge_requests)\/(\d+)/.exec(prUrl)?.[1];
  if (!hit?.forge.changeState || !id) return waiting('the release pull request is not merged yet', null);
  let state: ChangeState;
  try {
    state = await hit.forge.changeState(hit.repo, id);
  } catch {
    return waiting('the release pull request is not merged yet', null);
  }
  if (state === 'closed')
    return { result: failed('land', `The release pull request ${prUrl} was closed without merging.`) };
  if (state === 'open') return waiting('the release pull request is not merged yet', 'open');
  const sha = hit.forge.changeMergeCommit ? await hit.forge.changeMergeCommit(hit.repo, id).catch(() => null) : null;
  if (!sha) return waiting('the release pull request is merged; waiting for its merge commit on ' + base, 'merged');
  await refetch();
  if (!(await isAncestor(repoPath, sha, baseRef)))
    return waiting(`the release pull request is merged; waiting for ${base} to show it`, 'merged');
  return { sha };
}

async function landByMerge(
  input: ReleasePublishInput,
  a: { args: string[]; env: Record<string, string> },
  base: string,
  baseRef: string,
): Promise<{ sha: string; signedOff: boolean } | { result: ReleasePublishResult }> {
  const { payload: p, repoPath } = input;
  const R = p.releaseCommitSha;
  let identity;
  try {
    identity = await requireCommitIdentity(repoPath, p.commitAs);
  } catch (err) {
    return { result: failed('land', err instanceof NoCommitIdentityError ? NO_IDENTITY_WIRE : errText(err)) };
  }
  const tip = await revParse(repoPath, baseRef);
  if (!tip) return { result: failed('land', `the main branch '${base}' does not exist on origin`) };
  const dir = join(input.integrationDir, `publish-${p.repoId}`);
  const made = await withIntegrationWorktree(
    {
      repoPath,
      dir,
      root: input.integrationDir,
      tempBranch: integrationBranchName(`publish-${p.version}`),
      startPoint: tip,
    },
    async (wt): Promise<{ sha: string; signedOff: boolean } | { result: ReleasePublishResult }> => {
      const signedOff =
        p.land.mode === 'merge' && p.land.signoff !== undefined ? p.land.signoff : (await detectSignOff(wt)).required;
      const merge = await git(
        wt,
        [
          'merge',
          '--no-ff',
          ...(signedOff ? ['--signoff'] : []),
          '-m',
          `Merge ${p.workingBranch} into ${base} for release ${p.version}`,
          R,
        ],
        { env: commitEnv(identity) },
      );
      if (merge.exitCode !== 0) {
        const files = (await git(wt, ['diff', '--name-only', '--diff-filter=U'])).stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        await git(wt, ['merge', '--abort']);
        return {
          result: failed(
            'land',
            files.length > 0
              ? `Merging the release into ${base} conflicts in ${files.join(', ')}. Merge ${base} into ${p.workingBranch} first, then Retry.`
              : `merging the release into ${base} failed: ${(merge.stderr || merge.stdout).trim()}`,
          ),
        };
      }
      const sha = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
      const push = await git(wt, [...a.args, 'push', 'origin', `HEAD:refs/heads/${base}`], { env: a.env });
      if (push.exitCode !== 0) {
        const why = (push.stderr || push.stdout).trim();
        if (isProtectedBranchRejection(why) && input.pr) {
          const r = await input.pr.create({
            cwd: repoPath,
            base,
            branch: p.workingBranch,
            title: p.title,
            body: `Release ${p.version}`,
            ...(p.forge ? { forge: p.forge } : {}),
          });
          if ('url' in r && r.url)
            return {
              result: {
                ok: true,
                stage: 'waiting',
                waiting: { reason: `${base} is protected: the release pull request ${r.url} must be merged`, prState: 'open' },
                land: { mode: 'pr', mergeSha: '', by: 'forge', prUrl: r.url },
              },
            };
        }
        return { result: failed('land', `pushing ${base} failed: ${why}`) };
      }
      return { sha, signedOff };
    },
  );
  if (!made.ok) return { result: failed('land', made.error) };
  return made.value;
}
