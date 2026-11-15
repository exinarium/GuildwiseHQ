import { type ReviewSettings, type SizeUnit, sizeChecksStatus } from '../projects/review-settings.ts';

/**
 * The PR size check, as pure functions. A pull request's size is compared with the project's size budget. Pull requests
 * stacked on each other (the base branch of one is the head branch of another) are one chain and their sizes are added.
 * Each member counts only its own changes, as the git host measures it against its own base, so no line is counted twice.
 */

export interface ChangeSize {
  changedLines: number | null;
  changedFiles: number | null;
}

export interface ChainCandidate {
  changeId: string;
  head: string;
  base: string;
  /** Opened from a fork: its head branch is not a branch of this repository, so nothing can be stacked on it. */
  crossRepo: boolean;
  size: ChangeSize;
  /** A card branch of the project: it neither counts nor links. */
  excluded: boolean;
}

const byChangeId = (a: ChainCandidate, b: ChainCandidate): number => {
  const na = Number(a.changeId);
  const nb = Number(b.changeId);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0;
};

/**
 * The connected group of open pull requests that contains `changeId`, where B and A are linked when B.base == A.head and
 * A is not cross-repository. Excluded pull requests neither count nor link. Empty when `changeId` is not listed (or is
 * excluded). Stable order: by change id, numerically.
 */
export function prChain(changeId: string, open: readonly ChainCandidate[]): ChainCandidate[] {
  const live = open.filter((c) => !c.excluded);
  const start = live.find((c) => c.changeId === changeId);
  if (!start) return [];
  const linked = (a: ChainCandidate, b: ChainCandidate): boolean =>
    a.changeId !== b.changeId && ((b.base === a.head && !a.crossRepo) || (a.base === b.head && !b.crossRepo));
  const seen = new Map<string, ChainCandidate>([[start.changeId, start]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop() as ChainCandidate;
    for (const c of live) {
      if (seen.has(c.changeId) || !linked(cur, c)) continue;
      seen.set(c.changeId, c);
      queue.push(c);
    }
  }
  return [...seen.values()].sort(byChangeId);
}

/** The size of one pull request in the project's unit; null when the git host did not report it. */
export function changeSize(s: ChangeSize, unit: SizeUnit): number | null {
  const v = unit === 'changed_files' ? s.changedFiles : s.changedLines;
  return v === null || v === undefined ? null : v;
}

export interface SizeMember {
  changeId: string;
  size: number;
}

export type PrSizeVerdict =
  | { state: 'inactive'; reason: string }
  | { state: 'unknown'; reason: 'not_listed' | 'no_size' }
  | {
      state: 'within' | 'over';
      unit: SizeUnit;
      budget: number;
      total: number;
      /** False when the open list was cut off (more pull requests than listed): `within` may then be wrong. */
      complete: boolean;
      members: SizeMember[];
    };

/**
 * Whether the chain of `changeId` is over the budget. Over means total > budget (equal is within). A chain of one is a
 * single pull request. A member without a size makes the verdict `unknown`, unless the members that do have sizes are
 * already over the budget.
 */
export function prSizeVerdict(i: {
  settings: Partial<ReviewSettings> | null | undefined;
  changeId: string;
  open: readonly ChainCandidate[];
  complete: boolean;
}): PrSizeVerdict {
  const status = sizeChecksStatus(i.settings);
  if (!status.active) return { state: 'inactive', reason: status.reason };
  const budget = i.settings?.sizeBudget as number;
  const unit = i.settings?.sizeUnit as SizeUnit;
  const chain = prChain(i.changeId, i.open);
  if (chain.length === 0) return { state: 'unknown', reason: 'not_listed' };
  const members: SizeMember[] = [];
  let missing = false;
  for (const c of chain) {
    const s = changeSize(c.size, unit);
    if (s === null) missing = true;
    else members.push({ changeId: c.changeId, size: s });
  }
  const total = members.reduce((n, m) => n + m.size, 0);
  if (total > budget) return { state: 'over', unit, budget, total, complete: i.complete, members };
  if (missing) return { state: 'unknown', reason: 'no_size' };
  return { state: 'within', unit, budget, total, complete: i.complete, members };
}

/**
 * A second timeout: this run timed out, the owner started it by hand, and it is a re-run of a timed-out run. The server
 * only sets `rerunOfRunId` on a re-run of a timed-out run, so no history scan is needed.
 */
export function isSecondTimeout(run: {
  state: string;
  trigger: 'auto' | 'manual';
  rerunOfRunId: string | null;
}): boolean {
  return run.state === 'timed_out' && run.trigger === 'manual' && run.rerunOfRunId !== null;
}

export type TimeoutFollowUp = 'needs_split' | 'owner_pending' | 'none';

/** What a timeout leads to: only an over-budget verdict sends the pull request back; the size check decides, not the timeout. */
export function timeoutFollowUp(secondTimeout: boolean, v: PrSizeVerdict): TimeoutFollowUp {
  if (v.state === 'over') return 'needs_split';
  return secondTimeout ? 'owner_pending' : 'none';
}

export const SPLIT_REASONS = [
  'over_budget',
  'timeout_over_budget',
  'second_timeout_over_budget',
  'size_exception_rejected',
  'size_exception_lapsed',
] as const;
export type SplitReason = (typeof SPLIT_REASONS)[number];
export const SPLIT_NOTICE_STATES = ['pending', 'queued', 'posted', 'failed'] as const;
export type SplitNoticeState = (typeof SPLIT_NOTICE_STATES)[number];
/** Announced by a runner that understands `pr_review.notice`. */
export const PR_NOTICE_CAPABILITY = 'pr-notice:1';
export const SPLIT_NOTICE_MAX_ATTEMPTS = 3;
/** A queued or failed notice is tried again after this long. */
export const SPLIT_NOTICE_RETRY_MS = 15 * 60_000;
export const PR_TIMED_OUT_TWICE_SUBKIND = 'pr_review_timed_out_twice';

export const splitNoticeMarker = (noticeId: string): string => `<!-- size-check:${noticeId} -->`;

const UNIT_WORD: Record<SizeUnit, string> = {
  changed_lines: 'changed lines',
  changed_files: 'changed files',
};
export const sizeUnitWord = (unit: SizeUnit): string => UNIT_WORD[unit];

/** The review body: neutral, names the chain and the numbers, no reviewer or model names, ends with the marker. */
export function splitNoticeBody(i: {
  unit: SizeUnit;
  budget: number;
  total: number;
  members: SizeMember[];
  self: string;
  noticeId: string;
  reason?: string | null;
}): string {
  const word = sizeUnitWord(i.unit);
  const others = i.members.filter((m) => m.changeId !== i.self);
  const chain =
    others.length > 0
      ? ` Together with the pull requests stacked on it (${others.map((m) => `#${m.changeId}`).join(', ')}) it is ${i.total} ${word}, counting each pull request's own changes.`
      : '';
  return [
    `This pull request is over the project's size budget of ${i.budget} ${word}.${chain}`,
    '',
    ...(i.reason === 'size_exception_rejected' || i.reason === 'size_exception_lapsed'
      ? ['A size exception was asked for and not approved.', '']
      : []),
    'Please split it into smaller pull requests. It will be reviewed once the change is within the budget.',
    '',
    splitNoticeMarker(i.noticeId),
  ].join('\n');
}
