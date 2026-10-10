import { existsSync } from 'node:fs';
import {
  HYGIENE_PROBLEM_LABEL,
  type HygieneProblemKind,
  type HygieneRepoResult,
  type HygieneReport,
  type HygieneRepoSpec,
  type HygieneSpec,
  isSafeGitRef,
} from '@aom/shared';
import { currentBranch, git, hasRemote, revParse } from '../git/git.ts';
import { changedFiles } from '../git/sweep.ts';
import { saveUncommittedWork } from './saved-work.ts';

/**
 * Repository hygiene of one workstation (docs/design/phases.md, "DevOps repository hygiene and the working branch").
 * Deterministic git, run by the DevOps engineer's `aom hygiene run`:
 *
 * - the working branch must be confirmed: while the repository has none, nothing is committed, pulled or pushed, and
 *   the uncommitted changes are only reported (the server turns that into a question on the desk);
 * - uncommitted edits in the user's checkout are stored on a `guildwise/saved-work/<date>` branch and pushed (files that
 *   look like secrets are skipped); the checkout itself and the working branch are never touched by that;
 * - on the working branch: pull (fast-forward, else rebase when the tree is clean), push what is unpushed;
 * - on any other branch: leave the working tree alone, only move the working branch ref and push it;
 * - merged branches of finished cards are deleted locally, never an unmerged one;
 * - whatever cannot be resolved (conflict, auth failure, missing clone) is reported as the repository's problem.
 */

const MAX_FILES = 50;
const AUTH_RE =
  /authentication failed|permission denied|could not read (username|password)|publickey|access denied|terminal prompts disabled|invalid credentials|requested url returned error: 40[13]|repository not found/i;

export interface HygieneRun {
  report: HygieneReport;
  /** The git commands that changed something (fetch, commit, pull, push, branch deletion), for `aom devops-done`. */
  commands: string[];
  summary: string;
}

class Repo {
  readonly commands: string[] = [];
  constructor(readonly path: string) {}

  /** Runs git; `log` records the command for the audit trail. */
  async git(args: string[], log = false, config: string[] = []) {
    const full = [...config.flatMap((c) => ['-c', c]), ...args];
    if (log) this.commands.push(`git -C ${this.path} ${args.join(' ')}`);
    return git(this.path, full);
  }
}

const first = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';
const failText = (r: { stderr: string; stdout: string }) =>
  first(r.stderr) || first(r.stdout) || 'git failed';

/** Short names of the branches of the clone (local and origin), without the agent branches. */
async function listBranches(repo: Repo, prefix: string): Promise<string[]> {
  const r = await repo.git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  const names = new Set<string>();
  for (const ref of r.stdout.split('\n')) {
    const m = /^refs\/(?:heads|remotes\/origin)\/(.+)$/.exec(ref.trim());
    if (m?.[1] && m[1] !== 'HEAD') names.add(m[1]);
  }
  return [...names].filter((b) => !(prefix && b.startsWith(prefix))).sort();
}

/** Branches checked out in some worktree of the clone (they cannot be deleted or moved). */
async function checkedOut(repo: Repo): Promise<Set<string>> {
  const r = await repo.git(['worktree', 'list', '--porcelain']);
  const out = new Set<string>();
  for (const l of r.stdout.split('\n')) {
    const m = /^branch refs\/heads\/(.+)$/.exec(l.trim());
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

const isAncestor = async (repo: Repo, a: string, b: string): Promise<boolean> =>
  (await repo.git(['merge-base', '--is-ancestor', a, b])).exitCode === 0;

/** The user's own uncommitted edits go to a saved-work branch (pushed), never onto the working branch. */
async function saveWork(repo: Repo, res: HygieneRepoResult, remote: boolean): Promise<void> {
  const { saved, error } = await saveUncommittedWork(repo.path, {
    remote,
    log: (c) => repo.commands.push(c),
  });
  if (saved?.branch) {
    res.savedWork = saved;
    res.actions.push(
      `stored ${saved.files.length} unsaved file(s) on ${saved.branch}${saved.pushed ? ' and pushed it' : ''}; your checkout was not changed`,
    );
  } else if (saved?.skipped.length) {
    res.savedWork = saved;
  }
  if (saved?.skipped.length)
    res.actions.push(
      `left ${saved.skipped.length} file(s) that look like secrets alone: ${saved.skipped.slice(0, 5).join(', ')}`,
    );
  if (error) mark(res, /authentication|permission|denied/i.test(error) ? 'auth_failed' : 'error', error);
}

const mark = (res: HygieneRepoResult, kind: HygieneProblemKind, detail: string) => {
  // The first problem wins, except that an unconfirmed branch is always the one to ask about.
  if (!res.problem || kind === 'needs_branch') res.problem = { kind, detail };
};

export async function hygieneRepo(
  spec: HygieneRepoSpec,
): Promise<{ result: HygieneRepoResult; commands: string[] }> {
  const res: HygieneRepoResult = {
    repoId: spec.repoId,
    actions: [],
    problem: null,
    branches: [],
    uncommitted: [],
    pushed: false,
    removedBranches: [],
  };
  const repo = new Repo(spec.localPath);
  const done = () => ({ result: res, commands: repo.commands });

  if (!existsSync(spec.localPath) || (await repo.git(['rev-parse', '--git-dir'])).exitCode !== 0) {
    mark(res, 'missing', `no git clone at ${spec.localPath}`);
    return done();
  }
  const remote = await hasRemote(spec.localPath);
  let fetched = false;
  if (remote) {
    const f = await repo.git(['fetch', '--prune', 'origin'], true);
    if (f.exitCode === 0) {
      fetched = true;
      res.actions.push('fetched origin');
    } else {
      const why = failText(f);
      mark(res, AUTH_RE.test(f.stderr) ? 'auth_failed' : 'error', `git fetch failed: ${why}`);
    }
  }
  res.branches = await listBranches(repo, spec.branchPrefix);
  const cur = await currentBranch(spec.localPath);
  const dirty = await changedFiles(spec.localPath);
  const wb = spec.workingBranch;

  // The working branch must be confirmed, never guessed.
  if (!wb) {
    res.uncommitted = dirty;
    res.actions.push(
      dirty.length
        ? `working branch not confirmed: ${dirty.length} uncommitted file(s) reported, nothing committed or pushed`
        : 'working branch not confirmed: nothing committed or pushed',
    );
    mark(res, 'needs_branch', 'the working branch of this repository has not been confirmed');
    return done();
  }
  if (!isSafeGitRef(wb)) {
    mark(res, 'error', `refusing unsafe branch name ${JSON.stringify(wb)}`);
    return done();
  }
  const hasLocal = !!(await revParse(spec.localPath, `refs/heads/${wb}`));
  const hasRemoteRef = !!(await revParse(spec.localPath, `refs/remotes/origin/${wb}`));
  if (!hasLocal && !hasRemoteRef) {
    res.uncommitted = dirty;
    mark(res, 'branch_missing', `the working branch ${wb} exists neither locally nor on origin`);
    return done();
  }

  if (cur === wb) {
    if (dirty.length > 0) await saveWork(repo, res, remote);
    if (remote && fetched) {
      if (hasRemoteRef) {
        const pull = await repo.git(['pull', '--ff-only', 'origin', wb], true);
        if (pull.exitCode === 0) {
          if (!/already up to date/i.test(pull.stdout)) res.actions.push(`pulled ${wb}`);
        } else if (dirty.length > 0) {
          // Unsaved edits stay in the checkout: do not rebase over them, update again once they are committed.
          res.actions.push(`${wb} not updated yet: your own unsaved edits are in the way`);
        } else {
          const rebase = await repo.git(['pull', '--rebase', 'origin', wb], true);
          if (rebase.exitCode === 0) res.actions.push(`rebased ${wb} onto origin/${wb}`);
          else {
            await repo.git(['rebase', '--abort']);
            mark(
              res,
              AUTH_RE.test(rebase.stderr) ? 'auth_failed' : 'conflict',
              `${wb} and origin/${wb} could not be combined: ${failText(rebase)}`,
            );
            return done();
          }
        }
      }
      const ahead = hasRemoteRef
        ? !(await isAncestor(repo, `refs/heads/${wb}`, `refs/remotes/origin/${wb}`))
        : true;
      if (ahead) {
        const push = await repo.git(['push', '-u', 'origin', wb], true);
        if (push.exitCode === 0) {
          res.pushed = true;
          res.actions.push(`pushed ${wb}`);
        } else
          mark(
            res,
            AUTH_RE.test(push.stderr)
              ? 'auth_failed'
              : /rejected|non-fast-forward/i.test(push.stderr)
                ? 'conflict'
                : 'error',
            `git push failed: ${failText(push)}`,
          );
      }
    }
  } else {
    // The checkout is on another branch: its working tree is not ours to touch.
    if (dirty.length > 0) await saveWork(repo, res, remote);
    if (hasLocal && hasRemoteRef) {
      const local = `refs/heads/${wb}`;
      const origin = `refs/remotes/origin/${wb}`;
      if (!(await isAncestor(repo, local, origin))) {
        if (await isAncestor(repo, origin, local)) {
          if (remote && fetched) {
            const push = await repo.git(['push', 'origin', wb], true);
            if (push.exitCode === 0) {
              res.pushed = true;
              res.actions.push(`pushed ${wb}`);
            } else
              mark(
                res,
                AUTH_RE.test(push.stderr) ? 'auth_failed' : 'error',
                `git push failed: ${failText(push)}`,
              );
          }
        } else mark(res, 'conflict', `${wb} and origin/${wb} have diverged; combine them by hand`);
      } else if (!(await isAncestor(repo, origin, local))) {
        const moved = await repo.git(['branch', '-f', wb, `origin/${wb}`], true);
        if (moved.exitCode === 0) res.actions.push(`moved ${wb} forward to origin/${wb}`);
      }
    } else if (hasLocal && !hasRemoteRef && remote && fetched) {
      const push = await repo.git(['push', '-u', 'origin', wb], true);
      if (push.exitCode === 0) {
        res.pushed = true;
        res.actions.push(`pushed ${wb}`);
      } else
        mark(res, AUTH_RE.test(push.stderr) ? 'auth_failed' : 'error', `git push failed: ${failText(push)}`);
    }
  }

  // Branches of finished cards that are merged into the working branch.
  const target = hasRemoteRef ? `refs/remotes/origin/${wb}` : `refs/heads/${wb}`;
  const busy = await checkedOut(repo);
  for (const b of spec.finishedBranches) {
    if (!spec.branchPrefix || !b.startsWith(spec.branchPrefix) || !isSafeGitRef(b) || busy.has(b)) continue;
    if (!(await revParse(spec.localPath, `refs/heads/${b}`))) continue;
    if (!(await isAncestor(repo, `refs/heads/${b}`, target))) continue;
    if ((await repo.git(['branch', '-D', '--', b], true)).exitCode === 0) res.removedBranches.push(b);
  }
  if (res.removedBranches.length)
    res.actions.push(`deleted merged branch(es) ${res.removedBranches.join(', ')}`);
  await repo.git(['worktree', 'prune'], true);
  if (res.actions.filter((a) => a !== 'fetched origin').length === 0) res.actions.push(`${wb} is in order`);
  return done();
}

/** One line per repository for the request thread and `aom devops-done`. */
export function summarizeHygiene(spec: HygieneSpec, report: HygieneReport): string {
  const lines = report.repos.map((r) => {
    const s = spec.repos.find((x) => x.repoId === r.repoId);
    const head = s ? `${s.projectKey} ${s.name}` : r.repoId;
    const problem = r.problem
      ? ` PROBLEM ${HYGIENE_PROBLEM_LABEL[r.problem.kind]}: ${r.problem.detail}.`
      : '';
    return `- ${head}: ${r.actions.join('; ') || 'nothing to do'}.${problem}`;
  });
  const bad = report.repos.filter((r) => r.problem).length;
  return [
    `Repository hygiene: ${report.repos.length} repositor${report.repos.length === 1 ? 'y' : 'ies'} checked, ${bad === 0 ? 'all in order' : `${bad} need attention`}.`,
    ...lines,
  ].join('\n');
}

export async function runHygiene(spec: HygieneSpec): Promise<HygieneRun> {
  const repos: HygieneRepoResult[] = [];
  const commands: string[] = [];
  for (const r of spec.repos) {
    const { result, commands: cmds } = await hygieneRepo(r);
    result.uncommitted = result.uncommitted.slice(0, MAX_FILES);
    repos.push(result);
    commands.push(...cmds);
  }
  const report: HygieneReport = { repos };
  return { report, commands: commands.slice(0, 400), summary: summarizeHygiene(spec, report) };
}
