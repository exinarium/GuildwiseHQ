import { basename, join } from 'node:path';
import {
  componentRuleApplies,
  isSafeGitRef,
  type ReleaseDocsPrepPayload,
  type ReleaseDocsPrepResult,
  type ReleaseDocsPrepSummary,
} from '@aom/shared';
import { detectSignOff } from './dco.ts';
import { advanceLocalBranch, git, hasRemote, revParse } from './git.ts';
import { commitEnv, NO_IDENTITY_WIRE, NoCommitIdentityError, requireCommitIdentity } from './identity.ts';
import { integrationBranchName, withIntegrationWorktree } from './integration.ts';
import { DOCS_PREP_STEP_HANDLERS } from './release-docs-prep-steps.ts';
import { lastReleaseTagAt } from './release-facts.ts';
import { pushFastForward } from './release-ship.ts';
import { withRepoLock } from './repo-lock.ts';
import type { GitAuth } from './worktrees.ts';

export interface ReleaseDocsPrepInput {
  payload: ReleaseDocsPrepPayload;
  /** Local clone of the repository. */
  repoPath: string;
  /** Folder of the throwaway integration worktrees. */
  integrationDir: string;
  auth?: GitAuth;
}

const COMMITS_KEPT = 300;
const MERGES_KEPT = 300;
const CARDS_KEPT = 500;
const AREAS_KEPT = 100;
const PATHS_PER_AREA = 50;
const KEPT = 'refs/guildwise/docs-prep';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const cut = (s: string, n = 3500): string => s.trim().slice(0, n);
const failed = (error: string, extra: Partial<ReleaseDocsPrepResult> = {}): ReleaseDocsPrepResult => ({
  ok: false,
  state: 'failed',
  error: cut(error),
  files: [],
  notices: [],
  ...extra,
});
const passed = (extra: Partial<ReleaseDocsPrepResult> = {}): ReleaseDocsPrepResult => ({
  ok: true,
  state: 'passed',
  files: [],
  notices: [],
  ...extra,
});

/**
 * `release.docs_prep`: one step of Release prep (docs and videos) in one repository. Always under the repository lock;
 * never throws for expected failures. Commits go to the release branch only, never to the main branch and never a tag.
 *
 * - `analyse` reads the release branch since the last release tag (or since the main branch) and writes nothing.
 * - a content step runs its handler in a throwaway worktree and keeps the result as a local commit on
 *   `refs/guildwise/docs-prep/<run>/work`.
 * - `commit` / `prepare` squashes the kept work into one commit on the release branch tip (local, kept under
 *   `.../commit`); `commit` / `push` pushes it without force, only once every repository prepared.
 */
export async function runReleaseDocsPrep(input: ReleaseDocsPrepInput): Promise<ReleaseDocsPrepResult> {
  try {
    return await withRepoLock(input.repoPath, () => runLocked(input));
  } catch (err) {
    return failed(errMsg(err));
  }
}

async function runLocked(input: ReleaseDocsPrepInput): Promise<ReleaseDocsPrepResult> {
  const { payload: p, repoPath } = input;
  const b = p.releaseBranch;
  if (!isSafeGitRef(b)) return failed(`refusing unsafe branch name ${JSON.stringify(b)}`);
  if (p.mainBranch !== undefined && !isSafeGitRef(p.mainBranch))
    return failed(`refusing unsafe branch name ${JSON.stringify(p.mainBranch)}`);
  if (p.mainBranch && p.mainBranch === b)
    return failed(`the release branch is the main branch (${b}): there is nothing to prepare`);
  if (!(await hasRemote(repoPath))) return failed('the repository has no origin remote');
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };

  const fetched = await git(repoPath, [...a.args, 'fetch', '--', 'origin', b], { env: a.env });
  if (fetched.exitCode !== 0) {
    const why = (fetched.stderr || fetched.stdout).trim();
    if (/couldn't find remote ref|no such remote ref/i.test(why))
      return {
        ok: true,
        state: 'skipped',
        error: `the release branch '${b}' does not exist on origin`,
        files: [],
        notices: [],
      };
    return failed(`could not fetch ${b}: ${why}`);
  }
  const tip = await revParse(repoPath, `refs/remotes/origin/${b}`);
  if (!tip)
    return {
      ok: true,
      state: 'skipped',
      error: `the release branch '${b}' does not exist on origin`,
      files: [],
      notices: [],
    };

  if (p.step === 'analyse') return analyse(input, a, tip);
  if (p.step === 'commit') return p.phase === 'push' ? commitPush(input, a) : commitPrepare(input, tip);
  return contentStep(input, tip);
}

// -------------------------------------------------------------------------------------------------------- analyse

const GENERIC_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

function cardKeys(text: string, projectKey: string): string[] {
  const found = new Set(text.match(GENERIC_KEY) ?? []);
  if (projectKey) for (const k of text.match(new RegExp(`\\b${projectKey}-\\d+\\b`, 'g')) ?? []) found.add(k);
  return [...found];
}

export function areaOf(path: string, rules: ReleaseDocsPrepPayload['components']): string {
  for (const r of rules) if (componentRuleApplies(r, [path]).applies) return r.name;
  const seg = path.split('/');
  if (seg.length === 1) return '(root)';
  return seg.length === 2 ? (seg[0] as string) : `${seg[0]}/${seg[1]}`;
}

async function analyse(
  input: ReleaseDocsPrepInput,
  a: { args: string[]; env: Record<string, string> },
  tip: string,
): Promise<ReleaseDocsPrepResult> {
  const { payload: p, repoPath } = input;
  const main = p.mainBranch;
  if (main) await git(repoPath, [...a.args, 'fetch', '--', 'origin', main], { env: a.env });
  await git(
    repoPath,
    [...a.args, 'fetch', '--no-recurse-submodules', '--', 'origin', 'refs/tags/*:refs/tags/*'],
    {
      env: a.env,
    },
  );
  // Kept refs of an earlier run (a failed one) are of no use to this one.
  const refs = (await git(repoPath, ['for-each-ref', '--format=%(refname)', `${KEPT}/`])).stdout
    .split('\n')
    .filter((r) => r && !r.startsWith(`${KEPT}/${p.runId}/`));
  for (const r of refs) await git(repoPath, ['update-ref', '-d', r]);

  const last = await lastReleaseTagAt(repoPath, tip);
  let base: ReleaseDocsPrepSummary['base'];
  if (last) base = { kind: 'tag', tag: last.name, sha: last.sha };
  else {
    const mainRef = main
      ? (await revParse(repoPath, `refs/remotes/origin/${main}`))
        ? `origin/${main}`
        : main
      : null;
    const mb = mainRef ? (await git(repoPath, ['merge-base', mainRef, tip])).stdout.trim() : '';
    if (!mb)
      return failed(
        `cannot find where '${p.releaseBranch}' starts: set the main branch in the project settings`,
      );
    base = { kind: 'main', branch: main as string, sha: mb };
  }
  const range = `${base.sha}..${tip}`;

  const count = Number(
    (await git(repoPath, ['rev-list', '--no-merges', '--count', range])).stdout.trim() || '0',
  );
  const log = await git(repoPath, ['log', '--no-merges', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e', range]);
  const commitRows = split(log.stdout);
  const merges = split(
    (
      await git(repoPath, [
        'log',
        '--merges',
        '--first-parent',
        '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e',
        range,
      ])
    ).stdout,
  );
  const keys = new Set<string>();
  const mergeOut = merges.slice(0, MERGES_KEPT).map((r) => {
    const [sha = '', , , subject = '', body = ''] = r;
    const ks = cardKeys(`${subject}\n${body}`, p.projectKey);
    for (const k of ks) keys.add(k);
    const pr = /Merge pull request #(\d+)/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
    return {
      sha: sha.slice(0, 40),
      subject: subject.slice(0, 300),
      cardKeys: ks.slice(0, 20),
      prNumber: pr ? Number(pr[1]) : null,
    };
  });
  for (const r of commitRows)
    for (const k of cardKeys(`${r[3] ?? ''}\n${r[4] ?? ''}`, p.projectKey)) keys.add(k);

  const diff = await git(repoPath, ['diff', '--name-status', '-z', '--no-renames', base.sha, tip]);
  const byArea = new Map<
    string,
    { added: number; modified: number; deleted: number; paths: string[]; files: number }
  >();
  const toks = diff.stdout.split('\0').filter((t) => t !== '');
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const status = (toks[i] as string)[0];
    const path = toks[i + 1] as string;
    const area = areaOf(path, p.components);
    const e = byArea.get(area) ?? { added: 0, modified: 0, deleted: 0, paths: [], files: 0 };
    e.files += 1;
    if (status === 'A') e.added += 1;
    else if (status === 'D') e.deleted += 1;
    else e.modified += 1;
    if (e.paths.length < PATHS_PER_AREA) e.paths.push(path.slice(0, 300));
    byArea.set(area, e);
  }
  const areas = [...byArea.entries()]
    .sort((x, y) => y[1].files - x[1].files || x[0].localeCompare(y[0]))
    .slice(0, AREAS_KEPT)
    .map(([area, e]) => ({ area: area.slice(0, 200), ...e }));

  const summary: ReleaseDocsPrepSummary = {
    repoName: basename(repoPath),
    branch: p.releaseBranch,
    headSha: tip,
    base,
    commitCount: count,
    commits: commitRows.slice(0, COMMITS_KEPT).map((r) => ({
      sha: (r[0] ?? '').slice(0, 40),
      author: (r[1] ?? '').slice(0, 200),
      date: (r[2] ?? '').slice(0, 40),
      subject: (r[3] ?? '').slice(0, 300),
    })),
    commitsTruncated: commitRows.length > COMMITS_KEPT,
    merges: mergeOut,
    cards: [...keys]
      .sort()
      .slice(0, CARDS_KEPT)
      .map((key) => ({ key, title: null })),
    areas,
  };
  return passed({
    summary,
    baseTag: base.kind === 'tag' ? base.tag : null,
    baseSha: base.sha,
    headSha: tip,
  });
}

function split(out: string): string[][] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim() !== '')
    .map((r) => r.split('\x1f'));
}

// --------------------------------------------------------------------------------------------------- content steps

const workRef = (runId: string): string => `${KEPT}/${runId}/work`;
const commitRef = (runId: string): string => `${KEPT}/${runId}/commit`;
/** Where the work chain was started: the base of the squash commit when there is no analysis to name it. */
const startRef = (runId: string): string => `${KEPT}/${runId}/start`;

async function contentStep(input: ReleaseDocsPrepInput, tip: string): Promise<ReleaseDocsPrepResult> {
  const { payload: p, repoPath } = input;
  const handler = DOCS_PREP_STEP_HANDLERS[p.step];
  if (!handler) return failed(`this runner has no handler for the step '${p.step}': update the runner`);
  let identity: Awaited<ReturnType<typeof requireCommitIdentity>>;
  try {
    identity = await requireCommitIdentity(repoPath, p.commitAs);
  } catch (err) {
    return failed(err instanceof NoCommitIdentityError ? NO_IDENTITY_WIRE : errMsg(err));
  }
  const kept = await revParse(repoPath, workRef(p.runId));
  const start = kept ?? p.summary?.headSha ?? tip;
  if (!kept && !(await revParse(repoPath, startRef(p.runId))))
    await git(repoPath, ['update-ref', startRef(p.runId), start]);
  const made = await withIntegrationWorktree(
    {
      repoPath,
      dir: join(input.integrationDir, `docs-prep-${p.repoId}`),
      root: input.integrationDir,
      tempBranch: integrationBranchName(`docs-prep-${p.runId.slice(0, 8)}-${p.step}`),
      startPoint: start,
    },
    async (wt): Promise<ReleaseDocsPrepResult> => {
      const out = await handler({ worktree: wt, payload: p, summary: p.summary });
      if (!out.ok) return failed(out.error);
      if (out.files.length > 0) {
        const add = await git(wt, ['add', '--', ...out.files]);
        if (add.exitCode !== 0) return failed(`git add failed: ${(add.stderr || add.stdout).trim()}`);
      }
      const status = (await git(wt, ['status', '--porcelain'])).stdout
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      const extra = status.filter((f) => !out.files.includes(f));
      if (extra.length > 0) return failed(`unexpected changes in the worktree: ${extra.join(', ')}`);
      if (status.length === 0) return passed({ notices: ['no changes'] });
      const commit = await git(wt, ['commit', '-m', `docs(release): ${p.step}`], {
        env: commitEnv(identity),
      });
      if (commit.exitCode !== 0)
        return failed(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
      const sha = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repoPath, ['update-ref', workRef(p.runId), sha]);
      return passed({ files: status });
    },
  );
  return made.ok ? made.value : failed(made.error);
}

// ----------------------------------------------------------------------------------------------------- commit

const treeOf = async (repoPath: string, ref: string): Promise<string | null> => {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
};

async function commitPrepare(
  input: ReleaseDocsPrepInput,
  tip: string,
): Promise<ReleaseDocsPrepResult> {
  const { payload: p, repoPath } = input;
  // The commit the work chain was built on. The release branch may have moved since; the newer commits are carried
  // over below, never reverted.
  const analysed = p.summary?.headSha ?? (await revParse(repoPath, startRef(p.runId))) ?? tip;
  const work = await revParse(repoPath, workRef(p.runId));
  // Nothing produced a change: no commit (the repository is left as it is).
  if (!work || (await treeOf(repoPath, work)) === (await treeOf(repoPath, analysed)))
    return passed({ notices: ['no changes'] });
  let identity: Awaited<ReturnType<typeof requireCommitIdentity>>;
  try {
    identity = await requireCommitIdentity(repoPath, p.commitAs);
  } catch (err) {
    return failed(err instanceof NoCommitIdentityError ? NO_IDENTITY_WIRE : errMsg(err));
  }
  const kept = await revParse(repoPath, commitRef(p.runId));
  if (kept) {
    const parent = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${kept}^`])).stdout.trim();
    if (parent === tip) return passed({ commit: kept, files: await changedFiles(repoPath, parent, kept) });
  }
  const sign =
    p.signOff === undefined ? await detectSignOff(repoPath) : { required: p.signOff, reason: 'requested' };
  const subject = p.message ?? `docs(release): prepare the release documentation for ${p.releaseBranch}`;
  const message = sign.required
    ? `${subject}\n\nSigned-off-by: ${identity.name} <${identity.email}>\n`
    : `${subject}\n`;
  const squash = await git(repoPath, ['commit-tree', `${work}^{tree}`, '-p', analysed, '-m', message], {
    env: commitEnv(identity),
  });
  if (squash.exitCode !== 0)
    return failed(`git commit-tree failed: ${(squash.stderr || squash.stdout).trim()}`);
  let sha = squash.stdout.trim();
  if (analysed !== tip) {
    // The release branch moved since the analysis: carry the squash commit over onto the new tip.
    const moved = await withIntegrationWorktree(
      {
        repoPath,
        dir: join(input.integrationDir, `docs-prep-${p.repoId}`),
        root: input.integrationDir,
        tempBranch: integrationBranchName(`docs-prep-${p.runId.slice(0, 8)}-commit`),
        startPoint: tip,
      },
      async (wt): Promise<{ sha: string | null; error?: string }> => {
        const pick = await git(wt, ['cherry-pick', sha], { env: commitEnv(identity) });
        if (pick.exitCode !== 0) {
          const unmerged = (await git(wt, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
          await git(wt, ['cherry-pick', '--abort']);
          if (!unmerged) return { sha: null }; // the changes are on the tip already
          return {
            sha: null,
            error: 'the release branch moved and the prepared files conflict: run prep again',
          };
        }
        return { sha: (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim() };
      },
    );
    if (!moved.ok) return failed(moved.error);
    if (moved.value.error) return failed(moved.value.error);
    if (!moved.value.sha) return passed({ notices: ['no changes'] });
    sha = moved.value.sha;
  }
  await git(repoPath, ['update-ref', commitRef(p.runId), sha]);
  return passed({ commit: sha, files: await changedFiles(repoPath, `${sha}^`, sha) });
}

async function changedFiles(repoPath: string, from: string, to: string): Promise<string[]> {
  return (await git(repoPath, ['diff', '--name-only', from, to])).stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, 500);
}

async function commitPush(
  input: ReleaseDocsPrepInput,
  a: { args: string[]; env: Record<string, string> },
): Promise<ReleaseDocsPrepResult> {
  const { payload: p, repoPath } = input;
  const sha = await revParse(repoPath, commitRef(p.runId));
  if (!sha) return passed({ notices: ['no changes'] });
  // Redelivered, or pushed by an earlier attempt: it is on origin already.
  const onOrigin = await git(repoPath, [
    'merge-base',
    '--is-ancestor',
    sha,
    `refs/remotes/origin/${p.releaseBranch}`,
  ]);
  if (onOrigin.exitCode === 0) {
    await cleanup(repoPath, p.runId);
    return passed({ commit: sha, pushed: true, alreadyPushed: true });
  }
  const parent = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^`])).stdout.trim();
  const tip = await revParse(repoPath, `refs/remotes/origin/${p.releaseBranch}`);
  if (parent !== tip)
    return failed(`${p.releaseBranch} moved since the prepared commit was made: run prep again`, {
      commit: sha,
    });
  const pushed = await pushFastForward(repoPath, sha, p.releaseBranch, a);
  if (!pushed.ok) return failed(pushed.error, { commit: sha });
  await cleanup(repoPath, p.runId);
  await advanceLocalBranch(repoPath, p.releaseBranch, sha);
  return passed({ commit: sha, pushed: true });
}

async function cleanup(repoPath: string, runId: string): Promise<void> {
  for (const r of [workRef(runId), commitRef(runId), startRef(runId)]) await git(repoPath, ['update-ref', '-d', r]);
}
