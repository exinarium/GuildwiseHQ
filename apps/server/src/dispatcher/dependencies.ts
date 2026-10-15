import { type Queryable, rows } from '../db/sql.ts';

/**
 * A dependency counts as satisfied once its work has LANDED on the working branch (backlog #80): the card is done or
 * cancelled, or it passed Finalize with a merge (`merged_into_working_at`, set by the `merge` completion action or, for
 * a `pr`/`push_branch` card of a phase, by the merge check that sees the branch in the working branch). A card that
 * waits in Manual QA or an approval step after a merge-finalize has landed. A pr card whose merge was not detected
 * counts at done, as before. `dc` is the alias of the dependency card.
 */
export const landedSql = (dc = 'dc'): string =>
  `(${dc}.status IN ('done','cancelled') OR ${dc}.merged_into_working_at IS NOT NULL)`;

export interface DependencyState {
  id: string;
  ref: string;
  title: string;
  status: string;
  stage: string;
  landed: boolean;
  /** Finalized and merged, but the card itself is not done yet (Manual QA, approval step). */
  landedEarly: boolean;
}

/** The dependencies of a card with whether each one has landed. */
export async function dependencyStates(db: Queryable, cardId: string): Promise<DependencyState[]> {
  const r = await rows(
    db,
    `SELECT dc.id, dc.ref, dc.title, dc.status, dc.stage, ${landedSql('dc')} AS landed,
            (dc.status NOT IN ('done','cancelled') AND dc.merged_into_working_at IS NOT NULL) AS landed_early
       FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
      WHERE d.card_id=$1 ORDER BY dc.number`,
    [cardId],
  );
  return r.map((d) => ({
    id: d.id,
    ref: d.ref,
    title: d.title,
    status: d.status,
    stage: d.stage,
    landed: !!d.landed,
    landedEarly: !!d.landed_early,
  }));
}
