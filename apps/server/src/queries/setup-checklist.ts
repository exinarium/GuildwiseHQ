import {
  effectiveFeatures,
  isBusinessOrg,
  isDevOnlyRoleKey,
  isOrgManager,
  type OrgRole,
  SETUP_TEAM_ROLES,
  type SetupChecklist,
  type SetupStep,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';

export interface SetupFacts {
  business: boolean;
  manager: boolean;
  intakeOn: boolean;
  project: { id: string } | null;
  /** Dev orgs only (not queried in business orgs). */
  withRepo: boolean;
  workstation: boolean;
  /** SETUP_TEAM_ROLES not hired; dev-only roles are left out in business orgs. */
  missing: string[];
  talked: boolean;
  /** Business orgs only. */
  knowledge: boolean;
  rules: boolean;
  connections: boolean;
}

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
  const org = await one<{ plan: string; features: unknown; mode: string | null }>(
    ctx.pool,
    'SELECT plan, features, mode FROM organizations WHERE id=$1',
    [orgId],
  );
  // The intake page is part of the integrations feature; when it is off, everyone chats from the desk.
  const intakeOn = org ? effectiveFeatures(org.plan, org.features as never).integrations : true;

  const business = isBusinessOrg(org);

  const project = await one<{ id: string }>(
    ctx.pool,
    `SELECT id FROM projects WHERE org_id=$1 AND kind <> 'interest' AND status = 'active' ORDER BY created_at LIMIT 1`,
    [orgId],
  );
  const withRepo = business
    ? null
    : await one<{ id: string }>(
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
  // A Business mode organization has no repository and no builder, reviewer or tester to hire.
  const missing = SETUP_TEAM_ROLES.filter((r) => !have.has(r) && !(business && isDevOnlyRoleKey(r)));
  const talked = await one(
    ctx.pool,
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM intakes WHERE org_id=$1)
         OR EXISTS (SELECT 1 FROM threads t JOIN agents a ON a.id = t.agent_id AND a.role_key = 'ba'
                     WHERE t.org_id=$1 AND t.kind = 'chat'
                       AND EXISTS (SELECT 1 FROM thread_messages m WHERE m.thread_id = t.id AND m.author_kind = 'user'))`,
    [orgId],
  );

  let knowledge = false;
  let rules = false;
  let connections = false;
  if (business) {
    // A note on the runner, or a document the user wrote or uploaded (not one an agent drafted from a chat).
    knowledge = !!(await one(
      ctx.pool,
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM documents d WHERE d.org_id = $1 AND d.status <> 'archived'
                               AND (d.kind = 'file' OR cardinality(d.source_thread_ids) = 0))
         OR EXISTS (SELECT 1 FROM workstation_vaults wv
                      JOIN vaults v ON v.id = wv.vault_id AND v.org_id = $1 AND v.kind IN ('org','project')
                      JOIN workstations w ON w.id = wv.workstation_id AND w.status = 'active'
                     WHERE wv.note_count > 0)`,
      [orgId],
    ));
    rules = !!(await one(
      ctx.pool,
      `SELECT 1 FROM ledger_entries WHERE org_id = $1 AND scope = 'standing_order'
          AND superseded_by IS NULL AND retired_at IS NULL LIMIT 1`,
      [orgId],
    ));
    // An MCP grant, a digest webhook/e-mail automation, or an automation that delivers its output.
    connections = !!(await one(
      ctx.pool,
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM projects p WHERE p.org_id = $1 AND p.status = 'active'
                               AND cardinality(p.mcp_servers) > 0)
         OR EXISTS (SELECT 1 FROM schedules s WHERE s.org_id = $1 AND s.enabled
                      AND ((s.action->>'kind' = 'integration' AND s.action->>'integration' IN ('webhook','email'))
                           OR jsonb_array_length(COALESCE(s.action->'deliverOutput'->'destinations', '[]'::jsonb)) > 0))`,
      [orgId],
    ));
  }

  return summarize(
    buildSetupSteps({
      business,
      manager,
      intakeOn,
      project: project ?? null,
      withRepo: !!withRepo,
      workstation: !!ws,
      missing: [...missing],
      talked: !!talked,
      knowledge,
      rules,
      connections,
    }),
    dismissed,
  );
}

/** The steps for the facts. Pure: dev orgs get the five original steps, business orgs the seven business ones. */
export function buildSetupSteps(f: SetupFacts): SetupStep[] {
  const { manager, project, missing } = f;
  const teamDone = missing.length === 0;
  const ba: SetupStep = {
    id: 'ba',
    title: 'Talk to the business analyst',
    hint: 'Describe something you need, in a chat or an intake; the analyst turns it into cards.',
    done: f.talked,
    actionable: true,
    // Intake is for Owners and Admins (when the feature is on); everyone else reaches the analyst from Chat (top bar, or on the desk).
    link: f.talked ? null : manager && f.intakeOn ? '/intake' : '/desk',
  };
  const teamLink = teamDone ? null : `/agents?hire=${missing[0]}`;
  const missingNames = missing.map((r) => ROLE_NAME[r] ?? r);
  if (!f.business) {
    return [
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
        done: f.withRepo,
        actionable: manager,
        link:
          manager && !f.withRepo
            ? project
              ? `/projects/${project.id}/settings#repos`
              : '/projects?new=1'
            : null,
      },
      {
        id: 'workstation',
        title: 'Add a workstation',
        hint: 'The machine that runs your agents: your own computer, a VPS or a GitHub Codespace. A DevOps engineer for it is hired automatically.',
        done: f.workstation,
        actionable: true,
        link: f.workstation ? null : '/workstations?add=1',
      },
      {
        id: 'team',
        title: 'Hire your team',
        hint: 'A business analyst, a builder, a reviewer and a tester.',
        done: teamDone,
        actionable: true,
        link: teamLink,
        missing: missingNames,
      },
      ba,
    ];
  }
  return [
    {
      id: 'project',
      title: 'Create your first project',
      hint: 'A project holds a board of cards and the team that works on it.',
      done: !!project,
      actionable: manager,
      link: manager && !project ? '/projects?new=1' : null,
    },
    {
      id: 'workstation',
      title: 'Add a workstation',
      hint: 'The computer that runs your agents: your own machine or a server you rent.',
      done: f.workstation,
      actionable: true,
      link: f.workstation ? null : '/workstations?add=1',
    },
    {
      id: 'team',
      title: 'Hire your team',
      hint: 'A business analyst: they turn what you describe into cards for the team.',
      done: teamDone,
      actionable: true,
      link: teamLink,
      missing: missingNames,
    },
    {
      id: 'knowledge',
      title: 'Add something to Knowledge',
      hint: 'Upload a document or write a note your agents should know about your business.',
      done: f.knowledge,
      actionable: manager,
      link: manager && !f.knowledge ? '/documents' : null,
    },
    {
      id: 'rules',
      title: 'Set your first rule',
      hint: 'Add a standing order in Rules & decisions: something your agents must always or never do.',
      done: f.rules,
      actionable: manager,
      link: manager && !f.rules ? '/ledger' : null,
    },
    ba,
    {
      id: 'connections',
      title: 'Connect a tool or a destination',
      hint: 'Recommended: let your agents use one of your tools, or send their results to an e-mail address, a chat or a sheet.',
      done: f.connections,
      actionable: manager,
      link: manager && !f.connections ? '/automations' : null,
      optional: true,
    },
  ];
}

/** `doneCount` and `complete` count only the required (not optional) steps. */
export function summarize(steps: SetupStep[], dismissed = false): SetupChecklist {
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  return { steps, doneCount, complete: doneCount === required.length, dismissed };
}
