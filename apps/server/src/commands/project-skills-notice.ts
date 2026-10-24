import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { closeDeskNotice, raiseDeskNotice } from '../delivery/notices.ts';

export const PROJECT_SKILLS_REVIEW_SUBKIND = 'project_skills_review';
export const projectSkillsNoticeKey = (projectId: string): string => `project_skills_review:${projectId}`;

/**
 * How many of a project's repository skills, personas and playbooks wait for a review (Q52): never reviewed, or changed since
 * they were. Blocked ones are a decision already taken.
 */
export async function pendingProjectSkills(ctx: Ctx, projectId: string): Promise<number> {
  const r = await one(
    ctx.pool,
    `SELECT count(*)::int AS n
       FROM project_capability_index i
       LEFT JOIN capability_reviews cr ON cr.project_id = i.project_id AND cr.kind = i.kind AND cr.key = i.key
      WHERE i.project_id = $1 AND (cr.status IS NULL OR cr.status = 'unreviewed' OR (cr.status = 'reviewed' AND cr.hash <> i.hash))`,
    [projectId],
  );
  return r?.n ?? 0;
}

/**
 * Keeps the project's desk notice in line with its review list: one open notice while something waits for review (until an
 * Owner or Admin marks it reviewed it is unusable), closed when nothing does. The review itself is a button on the
 * Capabilities page, Project skills tab.
 */
export async function refreshProjectSkillsNotice(ctx: Ctx, orgId: string, projectId: string): Promise<void> {
  const n = await pendingProjectSkills(ctx, projectId);
  const key = projectSkillsNoticeKey(projectId);
  if (n === 0) {
    await closeDeskNotice(ctx, key);
    return;
  }
  const project = await one(ctx.pool, 'SELECT key FROM projects WHERE id=$1', [projectId]);
  await raiseDeskNotice(ctx, {
    orgId,
    projectId,
    subkind: PROJECT_SKILLS_REVIEW_SUBKIND,
    subjectKey: key,
    title: `${project?.key ?? 'A project'}: ${n} skill${n === 1 ? '' : 's'} from its repository wait for review`,
    body: 'Skills, personas and playbooks that a project repository carries are code the organization did not write, so they are not used until an Owner or Admin has read and reviewed them (and again when a file changes). Open Capabilities, Project skills, to review them.',
    data: { projectId, pending: n },
  });
}
