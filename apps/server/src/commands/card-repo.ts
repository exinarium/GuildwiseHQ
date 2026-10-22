import { type WorkflowDefinition, workflowUsesRepos } from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
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

/** Repo of a project by id or name. */
export async function resolveRepo(tx: Queryable, projectId: string, repo: string): Promise<string> {
  const list = await rows<{ id: string; name: string }>(
    tx,
    'SELECT id, name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
    [projectId],
  );
  const hit = list.find((r) => r.id === repo || r.name.toLowerCase() === repo.toLowerCase());
  if (!hit)
    throw new Error(
      `unknown repo '${repo}' (this project has: ${list.map((r) => r.name).join(', ') || 'none'})`,
    );
  return hit.id;
}

/**
 * A draft that has no repository in a project with two or more: nobody has to pick one, because the BA (or an architect)
 * works out which repositories the card touches (`spec_card` in its repository-scoping mode). A project with one
 * repository takes it by default, and one with none (or a workflow that does not use repositories) is out of scope.
 */
export async function needsRepoScoping(db: Queryable, card: Row): Promise<boolean> {
  if (card.status !== 'draft' || card.repo_id) return false;
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  if (!wf || !workflowUsesRepos(wf.definition)) return false;
  const n = await one<{ n: number }>(
    db,
    'SELECT count(*)::int AS n FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
    [card.project_id],
  );
  return (n?.n ?? 0) >= 2;
}
