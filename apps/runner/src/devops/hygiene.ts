import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import {
  HYGIENE_PROBLEM_LABEL,
  type HygieneProblemKind,
  type HygieneRepoResult,
  type HygieneReport,
  type HygieneRepoSpec,
  type HygieneSpec,
  isSafeGitRef,
} from '@aom/shared';
import { type BranchLedger, ledgerRepoKey } from '../git/branch-ledger.ts';
import { recordWorkingConflict } from '../git/conflict-record.ts';
import { currentBranch, git, hasRemote, revParse } from '../git/git.ts';
import { AppIdentityError, committerEnv, inContext } from '../git/identity.ts';
import { changedFiles } from '../git/sweep.ts';
import { type ChangeStateLookup, cleanFinishedCards } from './branch-cleanup.ts';
import { migrateSavedWorkBranches, saveCommitsStash, saveUncommittedWork } from './saved-work.ts';
import { mayDeleteLocal } from './tidy-up-rules.ts';

/**
 * Repository hygiene of one workstation (docs/design/phases.md, "DevOps repository hygiene and the working branch").
 * Deterministic git, run by the runner's fixed tidy-up routine (quiet-approvals [B4]; no AI session):
 *
 * - the working branch must be confirmed: while the repository has none, nothing is committed, pulled or pushed, and
 *   the uncommitted changes are only reported (the server turns that into a question on the desk);
 * - uncommitted edits in the user's checkout are stored in a stash entry, never pushed (files that
 *   look like secrets are skipped); the checkout itself and the working branch are never touched by that;
 * - a working branch the remote REWROTE (force-push dropped commits that the local branch still has) is realigned to
 *   the remote, never merged and never pushed; local commits that were never on the remote go to a stash entry (no branch, never pushed);
 * - on the working branch: pull (fast-forward, else rebase when the tree is clean), push what is unpushed;
 * - on any other branch: leave the working tree alone, only move the working branch ref and push it;
 * - merged branches of finished cards are deleted locally, never an unmerged one;
 * - branches of done or cancelled cards are removed from origin, the clone and their worktree once their work is in the
 *   working branch, migrated (rebased) or their pull request is closed (branch-cleanup.ts; the project can turn it off);
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

/**
 * How one repository reaches its remote when its project posts as an app: extra `-c` pairs and the environment of the
 * git process (may hold a token; never logged), plus the app's identity for commits a pull rewrites.
 */
export interface HygieneNetAuth {
  args: string[];
  env: Record<string, string>;
  identity?: { name: string; email: string };
}

class Repo {
  readonly commands: string[] = [];
  /** Null = plain git with the user's own credentials, exactly as without an app. */
  net: HygieneNetAuth | null = null;
  constructor(
    readonly path: string,
    /** The DevOps shift's own identity: the committer of commits a pull rewrites in a repository not on an app. */
    readonly plainIdentity?: { name: string; email: string },
  ) {}

  /** Runs git; `log` records the command for the audit trail. */
  async git(args: string[], log = false, config: string[] = []) {
    const full = [...config.flatMap((c) => ['-c', c]), ...args];
    if (log) this.commands.push(`git -C ${this.path} ${args.join(' ')}`);
    return git(this.path, full);
  }

  /** A command that talks to origin (fetch, pull, push): with the app's auth on an app repository. */
  async remote(args: string[], log = true, rewrites = false) {
    if (!this.net) {
      if (!rewrites || !this.plainIdentity) return this.git(args, log);
      if (log) this.commands.push(`git -C ${this.path} ${args.join(' ')}`);
      return git(this.path, args, { env: committerEnv(this.plainIdentity) });
    }
    if (log) this.commands.push(`git -C ${this.path} ${args.join(' ')}`);
    const env = {
      ...this.net.env,
      ...(rewrites && this.net.identity ? committerEnv(this.net.identity) : {}),
    };
    return git(this.path, [...this.net.args, ...args], { env });
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

/**
 * Did the remote force-update `origin/<wb>`? Yes when an earlier value of the remote-tracking ref (its reflog) was
 * dropped from the branch (not reachable from the current tip) and the local branch is that value, behind it or on top
 * of it, while the local branch is not simply contained in the remote. `unique` are the local commits that were never
 * on the remote (oldest first), the only work a realignment could lose.
 */
async function rewrittenRemote(repo: Repo, wb: string): Promise<{ unique: string[] } | null> {
  const local = `refs/heads/${wb}`;
  const origin = `refs/remotes/origin/${wb}`;
  if (await isAncestor(repo, local, origin)) return null;
  const log = await repo.git(['log', '-g', '--format=%H', '-n', '100', origin]);
  if (log.exitCode !== 0) return null;
  const olds = [
    ...new Set(
      log.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  let dropped = false;
  for (const o of olds) {
    if (await isAncestor(repo, o, origin)) continue;
    if ((await isAncestor(repo, local, o)) || (await isAncestor(repo, o, local))) {
      dropped = true;
      break;
    }
  }
  if (!dropped) return null;
  const r = await repo.git(['rev-list', '--reverse', local, '--not', origin, ...olds]);
  return { unique: r.stdout.split('\n').filter(Boolean) };
}

/**
 * Realigns the local working branch to the rewritten remote. Local commits that were never on the remote are kept on a
 * saved-work branch first and named in the result. Nothing is pushed to the working branch.
 */
async function realignRewritten(
  repo: Repo,
  res: HygieneRepoResult,
  wb: string,
  unique: string[],
  checkedOutHere: boolean,
  remote: boolean,
): Promise<void> {
  const info: NonNullable<HygieneRepoResult['rewritten']> = {
    branch: wb,
    realigned: false,
    commits: [],
    pushed: false,
  };
  if (unique.length) {
    const subjects = await repo.git(['log', '--no-walk=unsorted', '--format=%h %s', ...unique.slice(0, 20)]);
    info.commits = subjects.stdout.split('\n').filter(Boolean);
    const tip = (await repo.git(['rev-parse', `refs/heads/${wb}`])).stdout.trim();
    const kept = await saveCommitsStash(repo.path, tip, {
      count: unique.length,
      branch: wb,
      log: (c) => repo.commands.push(c),
    });
    if (!kept.stash) {
      // Without a safe copy the branch stays as it is.
      mark(
        res,
        'error',
        `${wb} was rewritten on origin but its own commits could not be saved: ${kept.error}`,
      );
      res.rewritten = info;
      return;
    }
    info.savedStash = kept.stash;
  }
  const moved = checkedOutHere
    ? await repo.git(['reset', '--keep', `refs/remotes/origin/${wb}`], true)
    : await repo.git(['branch', '-f', wb, `origin/${wb}`], true);
  if (moved.exitCode === 0) {
    info.realigned = true;
    res.actions.push(
      `origin/${wb} was rewritten (commits were removed there): ${wb} now matches it${info.savedBranch ? `; ${unique.length} local commit(s) that were never on origin are kept on ${info.savedBranch}` : ''}; nothing was pushed to ${wb}`,
    );
  } else {
    res.actions.push(
      `origin/${wb} was rewritten but ${wb} not realigned yet: ${checkedOutHere ? 'your own unsaved edits are in the way' : failText(moved)}`,
    );
  }
  res.rewritten = info;
}

/** The user's own uncommitted edits go to a stash entry (local, never pushed), never onto the working branch. */
async function saveWork(repo: Repo, res: HygieneRepoResult, remote: boolean): Promise<void> {
  const { saved, error } = await saveUncommittedWork(repo.path, {
    log: (c) => repo.commands.push(c),
  });
  if (saved?.stash) {
    res.savedWork = saved;
    res.actions.push(
      `stored ${saved.files.length} unsaved file(s) in a stash (git stash list: '${saved.stash}'); your checkout was not changed`,
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

/** Worktrees of the clone (other than the clone itself) that have a running shift. */
async function busyShiftWorktrees(repo: Repo, busy: string[]): Promise<string[]> {
  if (busy.length === 0) return [];
  const r = await repo.git(['worktree', 'list', '--porcelain']);
  const mine = r.stdout
    .split(/\n\n+/)
    .slice(1)
    .map((b) => /^worktree (.+)$/m.exec(b)?.[1])
    .filter((p): p is string => !!p);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const busyReal = new Set(busy.map(real));
  return mine.filter((p) => busyReal.has(real(p)));
}

export interface HygieneDeps {
  /** State of a card's pull request on its git host (answered by the runner, which holds the logins). */
  changeState?: ChangeStateLookup;
  /**
   * The app auth of one origin URL: null for a repository not on an app (plain git, exactly as today, never the
   * runner's own credentials). Throws `AppIdentityError` when the app is selected but cannot be used.
   */
  appAuth?: (url: string) => Promise<HygieneNetAuth | null>;
  /**
   * The DevOps shift's resolved commit identity. Hygiene used to run in the engineer's process, whose environment set
   * it as committer; a repository not on an app keeps that committer for the commits a pull rewrites.
   */
  identity?: { name: string; email: string };
  /** The card branches this runner created or pushed (T1): absent, nothing is deleted on origin. */
  ledger?: BranchLedger;
  /**
   * quiet-approvals [B4]: this computer's code folders (`repoRoots`). When given, a clone whose real path is not inside
   * one of them is reported `missing` and left alone, whatever path the server named.
   */
  repoRoots?: readonly string[];
}

/** [B4] Is `path` (by its real path) inside one of `roots` (each by its real path), separator-aware? */
export function insideRepoRoots(path: string, roots: readonly string[]): boolean {
  const real = (p: string): string | null => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const target = real(path);
  if (!target) return false;
  return roots.some((r) => {
    const root = real(r);
    return !!root && (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep));
  });
}

export async function hygieneRepo(
  spec: HygieneRepoSpec,
  busyWorktrees: string[] = [],
  deps: HygieneDeps = {},
): Promise<{ result: HygieneRepoResult; commands: string[] }> {
  const res: HygieneRepoResult = {
    repoId: spec.repoId,
    actions: [],
    problem: null,
    branches: [],
    uncommitted: [],
    pushed: false,
    removedBranches: [],
    cleaned: [],
  };
  const repo = new Repo(spec.localPath, deps.identity);
  const done = () => ({ result: res, commands: repo.commands });

  if (deps.repoRoots && !insideRepoRoots(spec.localPath, deps.repoRoots)) {
    mark(res, 'missing', `${spec.localPath} is not inside this computer's code folders`);
    return done();
  }
  if (!existsSync(spec.localPath) || (await repo.git(['rev-parse', '--git-dir'])).exitCode !== 0) {
    mark(res, 'missing', `no git clone at ${spec.localPath}`);
    return done();
  }
  // Branches and saved-work refs live in the .git a running shift shares: do not move any while a card shift works here.
  const running = await busyShiftWorktrees(repo, busyWorktrees);
  if (running.length > 0) {
    res.actions.push(
      `deferred: ${running.length} card shift(s) are running in this repository; nothing was changed, the next run tidies it`,
    );
    return done();
  }
  const remote = await hasRemote(spec.localPath);
  let reachable = remote;
  if (remote && deps.appAuth) {
    const url = (await repo.git(['remote', 'get-url', 'origin'])).stdout.trim();
    try {
      repo.net = url ? await deps.appAuth(url) : null;
    } catch (err) {
      if (!(err instanceof AppIdentityError)) throw err;
      // Fail closed: nothing reaches origin under another identity; local steps (stashes) still run.
      const e = inContext(err, { projectKey: spec.projectKey, operation: 'hygiene' });
      mark(res, 'app_identity_failed', e.message);
      reachable = false;
    }
  }
  // Every later remote step needs a fetch of this run, so a failed app leaves origin untouched.
  let fetched = false;
  if (reachable) {
    const f = await repo.remote(['fetch', '--prune', 'origin']);
    if (f.exitCode === 0) {
      fetched = true;
      res.actions.push('fetched origin');
    } else {
      const why = failText(f);
      mark(res, AUTH_RE.test(f.stderr) ? 'auth_failed' : 'error', `git fetch failed: ${why}`);
    }
  }
  // Saved work of older runners sat on `guildwise/saved-work/*` branches (some on origin): move them into stashes.
  {
    const mig = await migrateSavedWorkBranches(spec.localPath, {
      remote: remote && fetched,
      log: (c) => repo.commands.push(c),
      ...(repo.net ? { auth: repo.net } : {}),
    });
    res.actions.push(...mig.actions);
    for (const e of mig.errors) mark(res, AUTH_RE.test(e) ? 'auth_failed' : 'error', e);
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

  // A remote that was force-updated is followed, never merged back (and the dropped commits are never pushed again).
  let rewritten = false;
  if (remote && fetched && hasLocal && hasRemoteRef) {
    const rw = await rewrittenRemote(repo, wb);
    if (rw) {
      rewritten = true;
      if (dirty.length > 0) await saveWork(repo, res, remote);
      const here = cur === wb;
      if (!here && (await checkedOut(repo)).has(wb)) {
        res.actions.push(
          `origin/${wb} was rewritten, but ${wb} is checked out in another worktree: left alone`,
        );
        res.rewritten = { branch: wb, realigned: false, commits: [], pushed: false };
      } else await realignRewritten(repo, res, wb, rw.unique, here, remote);
    }
  }

  if (rewritten) {
    // handled above: nothing to pull, push or combine
  } else if (cur === wb) {
    if (dirty.length > 0) await saveWork(repo, res, remote);
    if (remote && fetched) {
      if (hasRemoteRef) {
        const pull = await repo.remote(['pull', '--ff-only', 'origin', wb], true, true);
        if (pull.exitCode === 0) {
          if (!/already up to date/i.test(pull.stdout)) res.actions.push(`pulled ${wb}`);
        } else if (dirty.length > 0) {
          // Unsaved edits stay in the checkout: do not rebase over them, update again once they are committed.
          res.actions.push(`${wb} not updated yet: your own unsaved edits are in the way`);
        } else {
          const rebase = await repo.remote(['pull', '--rebase', 'origin', wb], true, true);
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
        const push = await repo.remote(['push', 'origin', `${wb}:${wb}`]);
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
            const push = await repo.remote(['push', 'origin', wb]);
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
      const push = await repo.remote(['push', 'origin', `${wb}:${wb}`]);
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
  const handled = new Set(spec.finishedCards.map((c) => c.branch));
  // The runner's own rules decide (T1): a server prefix such as "mai" never makes `main` deletable.
  const originHeadRef = (
    await repo.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  ).stdout.trim();
  const tidyCtx = {
    wb,
    mainBranch: spec.mainBranch,
    current: cur,
    originHead: originHeadRef.startsWith('origin/') ? originHeadRef.slice('origin/'.length) : null,
  };
  const repoKey = spec.finishedBranches.length ? await ledgerRepoKey(spec.localPath) : '';
  for (const b of spec.finishedBranches) {
    if (handled.has(b)) continue;
    if (!isSafeGitRef(b) || busy.has(b) || !mayDeleteLocal(deps.ledger, repoKey, b, tidyCtx)) continue;
    if (!(await revParse(spec.localPath, `refs/heads/${b}`))) continue;
    if (!(await isAncestor(repo, `refs/heads/${b}`, target))) continue;
    if ((await repo.git(['branch', '-D', '--', b], true)).exitCode === 0) res.removedBranches.push(b);
  }
  if (res.removedBranches.length)
    res.actions.push(`deleted merged branch(es) ${res.removedBranches.join(', ')}`);
  if (spec.finishedCards.length) {
    const swept = await cleanFinishedCards({
      repoPath: spec.localPath,
      spec,
      target,
      wb,
      remote,
      fetched,
      busy: busyWorktrees,
      ...(deps.ledger ? { ledger: deps.ledger } : {}),
      ...(deps.changeState ? { changeState: deps.changeState } : {}),
      ...(repo.net ? { auth: repo.net } : {}),
      log: (c) => repo.commands.push(c),
    });
    res.cleaned = swept.cleaned;
    for (const c of swept.cleaned) res.removedBranches.push(c.branch);
    if (swept.cleaned.length)
      res.actions.push(
        `removed ${swept.cleaned.length} finished card branch(es): ${swept.cleaned.map((c) => `${c.branch} (${c.reason})`).join('; ')}`,
      );
    res.actions.push(...swept.notes);
  }
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

export async function runHygiene(
  spec: HygieneSpec,
  busyWorktrees: string[] = [],
  deps: HygieneDeps = {},
): Promise<HygieneRun> {
  const repos: HygieneRepoResult[] = [];
  const commands: string[] = [];
  for (const r of spec.repos) {
    const { result, commands: cmds } = await hygieneRepo(r, busyWorktrees, deps);
    // T7: the runner saw this conflict itself; a DevOps resolution may later be moved onto the working branch by it
    if (result.problem?.kind === 'conflict' && r.workingBranch && isSafeGitRef(r.workingBranch))
      await recordWorkingConflict(r.localPath, r.workingBranch);
    result.uncommitted = result.uncommitted.slice(0, MAX_FILES);
    repos.push(result);
    commands.push(...cmds);
  }
  const report: HygieneReport = { repos };
  return { report, commands: commands.slice(0, 400), summary: summarizeHygiene(spec, report) };
}
