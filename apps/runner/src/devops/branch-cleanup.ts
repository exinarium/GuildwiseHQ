import { realpathSync } from 'node:fs';
import {
  CARD_BRANCH_PREFIXES,
  type HygieneRepoResult,
  type HygieneRepoSpec,
  isSafeGitRef,
} from '@aom/shared';
import { git, revParse } from '../git/git.ts';

/**
 * Removal of the branches of finished cards (owner decision 2026-10-13: card branches stay local unless a pull request or
 * a pushed branch needs them, and hygiene removes the ones that are done with).
 *
 * A card branch is removed, from origin, the clone and its worktree, only when ALL of these hold:
 * - the server says the card is done or cancelled (`spec.finishedCards`; a reopened card is not in the list);
 * - the name sits under a Guildwise prefix (the project's branch prefix, `guildwise/`, the legacy `aom/`, the runner's integration branches), and is not the
 *   working or main branch;
 * - its pull request, when it had one, is not open;
 * - and its work is somewhere else: (a) every tip is contained in the working branch, or (b) every commit's patch is
 *   already in the working branch or main (rebased, cherry-picked, squashed per commit), or (c) the pull request was
 *   merged. A declined pull request releases nothing by itself: its branch goes only by (a) or (b), otherwise it holds
 *   the only copy of the work and is kept.
 * Anything else (unmerged commits, an unreadable branch, a worktree with edits) is left alone.
 */

export type ChangeStateLookup = (q: {
  remoteUrl: string;
  prUrl: string;
}) => Promise<'open' | 'merged' | 'closed' | null>;

export interface CleanupInput {
  repoPath: string;
  spec: HygieneRepoSpec;
  /** The working branch ref the work is compared with (`refs/remotes/origin/<wb>` or the local one). */
  target: string;
  wb: string;
  remote: boolean;
  /** Origin was fetched (and pruned) in this run: the remote-tracking refs are current. */
  fetched: boolean;
  /** Worktrees with a running shift: never touched. */
  busy: string[];
  changeState?: ChangeStateLookup;
  /** Records a command that changed something (for the audit trail). */
  log: (command: string) => void;
}

type Cleaned = HygieneRepoResult['cleaned'][number];

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const GUILDWISE_PREFIXES: readonly string[] = [
  ...CARD_BRANCH_PREFIXES,
  'guildwise/integration/',
  'aom-integration/',
];

const hasGuildwisePrefix = (branch: string, projectPrefix: string): boolean =>
  [...GUILDWISE_PREFIXES, ...(projectPrefix ? [projectPrefix] : [])].some(
    (p) => p.length > 1 && branch.startsWith(p) && branch.length > p.length,
  );

/** Worktrees of the clone: path by branch. */
async function worktreesByBranch(repoPath: string): Promise<Map<string, string>> {
  const r = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const out = new Map<string, string>();
  for (const block of r.stdout.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && branch) out.set(branch, path);
  }
  return out;
}

/** Commits of `tip` whose patch is not in `upstream` (`git cherry`: `+` lines). */
async function unmigrated(repoPath: string, upstream: string, tip: string): Promise<string[] | null> {
  const r = await git(repoPath, ['cherry', upstream, tip]);
  if (r.exitCode !== 0) return null;
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('+ '))
    .map((l) => l.slice(2).trim());
}

async function mainRef(repoPath: string, mainBranch: string | null): Promise<string | null> {
  if (mainBranch && isSafeGitRef(mainBranch)) {
    for (const ref of [`refs/remotes/origin/${mainBranch}`, `refs/heads/${mainBranch}`])
      if (await revParse(repoPath, ref)) return ref;
  }
  const head = await git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const ref = head.stdout.trim();
  return head.exitCode === 0 && ref && (await revParse(repoPath, ref)) ? ref : null;
}

/** Why the tip's work is elsewhere (null: it is not, keep the branch). */
async function whereIsTheWork(input: CleanupInput, tip: string, main: string | null): Promise<string | null> {
  const { repoPath, target, wb } = input;
  if ((await git(repoPath, ['merge-base', '--is-ancestor', tip, target])).exitCode === 0)
    return `merged into ${wb}`;
  const notInWorking = await unmigrated(repoPath, target, tip);
  if (notInWorking === null) return null;
  if (notInWorking.length === 0) return `all commits are already in ${wb} (rebased or cherry-picked)`;
  if (!main) return null;
  if ((await git(repoPath, ['merge-base', '--is-ancestor', tip, main])).exitCode === 0)
    return `merged into ${input.spec.mainBranch ?? 'the main branch'}`;
  const notInMain = await unmigrated(repoPath, main, tip);
  if (notInMain === null) return null;
  const stillMissing = notInWorking.filter((c) => notInMain.includes(c));
  return stillMissing.length === 0
    ? `all commits are already in ${wb} or the main branch (rebased or cherry-picked)`
    : null;
}

export async function cleanFinishedCards(
  input: CleanupInput,
): Promise<{ cleaned: Cleaned[]; notes: string[] }> {
  const { repoPath, spec, wb } = input;
  const cleaned: Cleaned[] = [];
  const notes: string[] = [];
  if (spec.finishedCards.length === 0) return { cleaned, notes };
  // Remote-tracking refs from before the fetch could say a branch is gone or unchanged when it is not.
  if (input.remote && !input.fetched) {
    notes.push('finished card branches left for the next run: origin could not be fetched');
    return { cleaned, notes };
  }
  const main = await mainRef(repoPath, spec.mainBranch);
  const busy = new Set(input.busy.map(real));
  const current = (await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const seen = new Set<string>();

  for (const card of spec.finishedCards) {
    const b = card.branch;
    if (seen.has(b)) continue;
    seen.add(b);
    if (!isSafeGitRef(b) || !hasGuildwisePrefix(b, spec.branchPrefix)) continue;
    if (b === wb || b === spec.mainBranch || b === current) continue;
    // The pull request branch on origin has the name the server stored for this card (`<prefix>/<ticket>`), found by
    // that name alone, never by a prefix: other branches of the user under the same prefix are not touched.
    const ob = card.remoteBranch ?? b;
    if (!isSafeGitRef(ob) || ob === wb || ob === spec.mainBranch) continue;
    const localSha = await revParse(repoPath, `refs/heads/${b}`);
    const originSha = input.remote ? await revParse(repoPath, `refs/remotes/origin/${ob}`) : null;
    if (!localSha && !originSha) continue;

    // Its pull request decides first: an open one keeps the branch; a merged one releases it. A declined one does not:
    // its commits may exist nowhere else, so (a) and (b) decide.
    let prState: 'open' | 'merged' | 'closed' | null = null;
    if (card.prUrl && input.changeState) {
      prState = await input.changeState({ remoteUrl: spec.remoteUrl, prUrl: card.prUrl }).catch(() => null);
      if (prState === 'open') continue;
    }
    let reason: string | null = null;
    if (prState === 'merged') reason = 'its pull request was merged';
    else {
      const tips = [...new Set([localSha, originSha].filter((t): t is string => !!t))];
      for (const tip of tips) {
        const r = await whereIsTheWork(input, tip, main);
        if (!r) {
          reason = null;
          break;
        }
        reason = r;
      }
    }
    if (!reason) {
      if (prState === 'closed') notes.push(`${b} kept: pull request declined, has unmerged commits`);
      continue;
    }

    const entry: Cleaned = {
      cardId: card.cardId,
      ref: card.ref,
      branch: b,
      reason,
      origin: false,
      local: false,
      worktree: false,
    };
    // The card's worktree goes first (a branch checked out in it cannot be deleted); one with edits or a running shift stays.
    const wt = (await worktreesByBranch(repoPath)).get(b);
    if (wt && real(wt) !== real(repoPath)) {
      if (busy.has(real(wt))) continue;
      input.log(`git -C ${repoPath} worktree remove -- ${wt}`);
      const rm = await git(repoPath, ['worktree', 'remove', '--', wt]);
      if (rm.exitCode !== 0) {
        notes.push(`${b} kept: its worktree has changes or is in use`);
        continue;
      }
      entry.worktree = true;
    } else if (wt) continue;
    if (originSha) {
      input.log(`git -C ${repoPath} push --delete origin ${ob}`);
      const del = await git(repoPath, [
        'push',
        '--delete',
        `--force-with-lease=refs/heads/${ob}:${originSha}`,
        'origin',
        '--',
        ob,
      ]);
      if (del.exitCode === 0) entry.origin = true;
      else {
        const why = (del.stderr || del.stdout).trim().split('\n')[0] ?? 'git failed';
        notes.push(`${ob} not removed from origin: ${why}`);
        // The local copy stays too: the next run decides again with the remote branch still there.
        if (entry.worktree) cleaned.push(entry);
        continue;
      }
    }
    if (localSha) {
      input.log(`git -C ${repoPath} branch -D -- ${b}`);
      entry.local = (await git(repoPath, ['branch', '-D', '--', b])).exitCode === 0;
    }
    if (entry.origin || entry.local || entry.worktree) cleaned.push(entry);
  }
  return { cleaned, notes };
}
