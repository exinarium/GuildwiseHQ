import { type WorkflowDefinition, workflowUsesRepos } from '@aom/shared';
import { rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';

/**
 * The repository a new card takes when nobody named one: the project's only repository. A workflow that works in the
 * vault (research in a code project) never takes one, and a project with several (or no) repositories leaves the choice
 * to the card's creator. Shared by every producer of `CardCreated` that has no repository of its own to inherit
 * (`createCard`, scheduled and interest-run cards): a card without a repository gets no worktree.
 */
export async function singleRepoDefault(
  tx: Tx,
  projectId: string,
  def: WorkflowDefinition,
): Promise<string | undefined> {
  if (!workflowUsesRepos(def)) return undefined;
  const repos = await rows<{ id: string }>(
    tx,
    'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
    [projectId],
  );
  return repos.length === 1 ? repos[0]?.id : undefined;
}
