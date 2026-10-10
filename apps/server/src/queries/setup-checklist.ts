import {
  isOrgManager,
  type OrgRole,
  SETUP_TEAM_ROLES,
  type SetupChecklist,
  type SetupStep,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';

const ROLE_NAME: Record<string, string> = {
  ba: 'business analyst',
  builder: 'builder',
  reviewer: 'reviewer',
  tester: 'tester',
};

/**
 * The state of the organization's "Get started" checklist, computed from what exists now (so it also ticks by itself
 * when the work was done elsewhere, and un-ticks if something is removed). Every member sees the progress; a step the
 * viewer's role may not do comes without a link ("ask an Owner or Admin"). Guests have no checklist.
 */
export async function getSetupChecklist(
  ctx: Ctx,
  userId: string,
  orgId: string,
  role: OrgRole | null,
): Promise<SetupChecklist> {
  const dismissed =
    (
      await one<{ d: boolean }>(ctx.pool, 'SELECT setup_checklist_dismissed AS d FROM users WHERE id=$1', [
        userId,
      ])
    )?.d === true;
  if (role === null) return { steps: [], doneCount: 0, complete: false, dismissed };
  const manager = isOrgManager({ orgRole: role });

  const project = await one<{ id: string }>(
    ctx.pool,
    `SELECT id FROM projects WHERE org_id=$1 AND kind <> 'interest' AND status = 'active' ORDER BY created_at LIMIT 1`,
    [orgId],
  );
  const withRepo = await one<{ id: string }>(
    ctx.pool,
    `SELECT p.id FROM projects p WHERE p.org_id=$1 AND p.kind <> 'interest' AND p.status = 'active'
        AND EXISTS (SELECT 1 FROM project_repos r WHERE r.project_id = p.id) ORDER BY p.created_at LIMIT 1`,
    [orgId],
  );
  const ws = await one(
    ctx.pool,
    `SELECT 1 FROM workstations w JOIN org_members om ON om.user_id = w.user_id AND om.org_id = $1 AND om.status = 'active'
      WHERE w.status = 'active' LIMIT 1`,
    [orgId],
  );
  const hired = await one<{ roles: string[] }>(
    ctx.pool,
    `SELECT COALESCE(array_agg(DISTINCT role_key), ARRAY[]::text[]) AS roles FROM agents
      WHERE org_id=$1 AND status = 'active' AND NOT is_devops`,
    [orgId],
  );
  const have = new Set(hired?.roles ?? []);
  const missing = SETUP_TEAM_ROLES.filter((r) => !have.has(r));
  const talked = await one(
    ctx.pool,
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM intakes WHERE org_id=$1)
         OR EXISTS (SELECT 1 FROM threads t JOIN agents a ON a.id = t.agent_id AND a.role_key = 'ba'
                     WHERE t.org_id=$1 AND t.kind = 'chat'
                       AND EXISTS (SELECT 1 FROM thread_messages m WHERE m.thread_id = t.id AND m.author_kind = 'user'))`,
    [orgId],
  );

  const steps: SetupStep[] = [
    {
      id: 'project',
      title: 'Create your first project',
      hint: 'A project holds a board of cards, its repositories and its team.',
      done: !!project,
      actionable: manager,
      link: manager && !project ? '/projects?new=1' : null,
    },
    {
      id: 'repository',
      title: 'Add its repository',
      hint: 'Tell Guildwise HQ where the code lives: GitHub, GitLab, Bitbucket, Azure DevOps or any git server.',
      done: !!withRepo,
      actionable: manager,
      link:
        manager && !withRepo
          ? project
            ? `/projects/${project.id}/settings#repos`
            : '/projects?new=1'
          : null,
    },
    {
      id: 'workstation',
      title: 'Pair a workstation',
      hint: 'The machine that runs your agents: your own computer, a VPS or a GitHub Codespace. A DevOps engineer for it is hired automatically.',
      done: !!ws,
      actionable: true,
      link: ws ? null : '/workstations?add=1',
    },
    {
      id: 'team',
      title: 'Hire your team',
      hint: 'A business analyst, a builder, a reviewer and a tester.',
      done: missing.length === 0,
      actionable: true,
      link: missing.length === 0 ? null : `/agents?hire=${missing[0]}`,
      missing: missing.map((r) => ROLE_NAME[r] ?? r),
    },
    {
      id: 'ba',
      title: 'Talk to the business analyst',
      hint: 'Describe something you need, in a chat or an intake; the analyst turns it into cards.',
      done: !!talked,
      actionable: true,
      // Intake is for Owners and Admins; everyone else reaches the analyst from Chat (top bar, or on the desk).
      link: talked ? null : manager ? '/intake' : '/desk',
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, complete: doneCount === steps.length, dismissed };
}
