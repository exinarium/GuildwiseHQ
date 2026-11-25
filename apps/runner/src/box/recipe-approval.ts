import { createHash } from 'node:crypto';

/**
 * quiet-approvals phase B, D9 and S6: a test-services recipe (server-authorable: the project vault) runs its containers with
 * no internet unless (1) the local ceiling allows container egress and (2) a Desk click approved exactly this recipe: its
 * sha256 plus every image digest. Any change, a moved tag included, needs a new click. With `containerEgress` off (the
 * default) egress is impossible, and the Desk item says "needs a change on your computer".
 */

export interface RecipeApproval {
  recipeSha256: string;
  digests: string[];
}

export const recipeSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The binding a Desk click approves (digests sorted; each must be a content digest, never a tag). */
export function recipeBinding(text: string, digests: readonly string[]): RecipeApproval {
  for (const d of digests) if (!DIGEST.test(d)) throw new Error(`not an image digest: ${d}`);
  return { recipeSha256: recipeSha256(text), digests: [...new Set(digests)].sort() };
}

export type EgressDecision =
  | { egress: true }
  | { egress: false; reason: 'ceiling' | 'not_approved' | 'changed' };

export function recipeEgress(
  ceilingEgress: boolean,
  approved: RecipeApproval | undefined,
  text: string,
  digests: readonly string[],
): EgressDecision {
  if (!ceilingEgress) return { egress: false, reason: 'ceiling' };
  if (!approved) return { egress: false, reason: 'not_approved' };
  let now: RecipeApproval;
  try {
    now = recipeBinding(text, digests);
  } catch {
    return { egress: false, reason: 'changed' };
  }
  const same =
    now.recipeSha256 === approved.recipeSha256 &&
    now.digests.length === approved.digests.length &&
    now.digests.every((d, i) => d === approved.digests[i]);
  return same ? { egress: true } : { egress: false, reason: 'changed' };
}
