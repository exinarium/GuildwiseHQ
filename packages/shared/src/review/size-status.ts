import type { SizeUnit } from '../projects/review-settings.ts';
import { type PrSizeVerdict, sizeUnitWord } from './size-check.ts';

/** The status context the owner makes required on the branch. Never change it: rules refer to it by name. */
export const SIZE_STATUS_CONTEXT = 'size-budget';
/** Announced by a runner that can post a commit status (`repo.commit_status`). */
export const COMMIT_STATUS_CAPABILITY = 'commit-status:1';
/** GitHub's limit for a commit status description. */
export const COMMIT_STATUS_DESCRIPTION_MAX = 140;
export const COMMIT_STATUS_MAX_ATTEMPTS = 3;

export type SizeStatusState = 'success' | 'failure' | 'pending';
export type SizeStatusReason = 'within' | 'over' | 'owner_exception' | 'inactive' | 'unknown';
export const SIZE_STATUS_POST_STATES = ['pending', 'queued', 'posted', 'failed'] as const;
export type SizeStatusPostState = (typeof SIZE_STATUS_POST_STATES)[number];

export interface SizeStatus {
  state: SizeStatusState;
  reason: SizeStatusReason;
  /** At most 140 characters, always. */
  description: string;
  total?: number;
  budget?: number;
  unit?: SizeUnit;
  members?: string[];
}

/** "700 changed lines", "1 changed file": the plural from `sizeUnitWord`, the singular for exactly 1. */
export function sizeWithUnit(n: number, unit: SizeUnit): string {
  const word = sizeUnitWord(unit);
  return `${n} ${n === 1 ? word.slice(0, -1) : word}`;
}

function fit(core: string, suffix: string): string {
  const full = `${core}${suffix}`;
  if (full.length <= COMMIT_STATUS_DESCRIPTION_MAX) return full;
  // The size, budget and unit part is never cut: the suffix is dropped instead.
  return core.slice(0, COMMIT_STATUS_DESCRIPTION_MAX);
}

/**
 * The status to post for one pull request, or null for "post nothing".
 * - no budget: nothing, unless the repository had the check before, then a passing "inactive" status.
 * - size not known: pending.
 * - over budget with an owner exception: success; over budget otherwise: failure; within: success.
 */
export function sizeStatusFor(i: {
  verdict: PrSizeVerdict;
  excepted: boolean;
  hadStatus: boolean;
}): SizeStatus | null {
  const v = i.verdict;
  if (v.state === 'inactive') {
    if (!i.hadStatus) return null;
    return { state: 'success', reason: 'inactive', description: fit(`Size check ${v.reason}`, '') };
  }
  if (v.state === 'unknown') {
    return { state: 'pending', reason: 'unknown', description: 'Size not measured yet' };
  }
  const sizes = `${sizeWithUnit(v.total, v.unit)}, budget ${sizeWithUnit(v.budget, v.unit)}`;
  const ids = v.members.map((m) => `#${m.changeId}`);
  const suffix =
    v.members.length > 1
      ? ` (stack ${ids.join(' ')})`.length + sizes.length + 16 <= COMMIT_STATUS_DESCRIPTION_MAX
        ? ` (stack ${ids.join(' ')})`
        : ` (stack of ${v.members.length} PRs)`
      : '';
  const common = {
    total: v.total,
    budget: v.budget,
    unit: v.unit,
    members: v.members.map((m) => m.changeId),
  };
  if (v.state === 'over') {
    if (i.excepted) {
      return {
        state: 'success',
        reason: 'owner_exception',
        description: fit(`Passed by owner exception: ${sizes}`, suffix),
        ...common,
      };
    }
    return { state: 'failure', reason: 'over', description: fit(`Over budget: ${sizes}`, suffix), ...common };
  }
  return {
    state: 'success',
    reason: 'within',
    description: fit(`Within budget: ${sizes}`, suffix),
    ...common,
  };
}
