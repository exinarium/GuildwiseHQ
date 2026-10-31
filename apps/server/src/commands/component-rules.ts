import { type ComponentRule, componentRuleProblems, normalizeComponentRules, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { projectScope, userActor } from './common.ts';

/**
 * The project owner replaces the component version rules of a repository (an empty list clears them). The semantic
 * checks run here, before anything is stored, so the answer names the problem.
 */
export async function setRepoComponentRules(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  rules: ComponentRule[],
): Promise<void> {
  const problems = componentRuleProblems(rules);
  if (problems.length > 0)
    throw badRequest('invalid_component_rules', problems.map((p) => p.message).join(' '), { problems });
  const normalized = normalizeComponentRules(rules);
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const r = await one(
      tx,
      'SELECT id, component_rules FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!r) throw notFound('repository not found');
    if (JSON.stringify(r.component_rules ?? []) === JSON.stringify(normalized)) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectRepoComponentRulesSet',
            payload: { projectId, repoId, rules: normalized, setBy: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/** The project owner sets the name used in the release tag message and title (null or empty: the project name). */
export async function setRepoReleaseName(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  name: string | null,
): Promise<void> {
  const value = name?.trim() ? name.trim().slice(0, 100) : null;
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const r = await one(
      tx,
      'SELECT id FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!r) throw notFound('repository not found');
    await exec(tx, 'UPDATE project_repos SET release_name=$2 WHERE id=$1', [repoId, value]);
  });
}
