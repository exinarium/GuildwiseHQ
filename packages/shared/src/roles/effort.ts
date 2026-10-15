/**
 * Roles whose agents must never be moved below an effort level by an automatic actor (the HR recommendations and the
 * CEO). Lowering it is the owner's own decision. Reviewers do an adversarial review and a risk analysis (backlog #70),
 * which needs high effort.
 */
export const MIN_EFFORT_BY_ROLE: Readonly<Record<string, string>> = { reviewer: 'high' };

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

const effortRank = (effort: string | null | undefined): number => {
  const i = EFFORT_LADDER.indexOf((effort ?? '').toLowerCase());
  // An unset effort means the role default, which is not below any protected minimum.
  return i;
};

/** True when `effort` is set and below the minimum that `roleKey` is protected at. */
export function effortBelowRoleMinimum(roleKey: string, effort: string | null | undefined): boolean {
  const min = MIN_EFFORT_BY_ROLE[roleKey];
  if (!min || !effort) return false;
  const rank = effortRank(effort);
  return rank < effortRank(min);
}
