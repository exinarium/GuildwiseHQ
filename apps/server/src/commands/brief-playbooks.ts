import { randomUUID } from 'node:crypto';
import {
  BRIEF_PLAYBOOK_KEYS,
  BRIEF_PLAYBOOKS,
  type BriefPlaybook,
  type BriefPlaybookDto,
  BUILTIN_WORKFLOWS,
  BUSINESS_ROLES,
  briefPlaybookCron,
  briefPlaybookTemplate,
  briefWorkflow,
  briefWorkflowKey,
  type CreateScheduleRequest,
  type InstallBriefPlaybookRequest,
  isBriefPlaybookKey,
  isOrgManager,
  type PatchBriefPlaybookRequest,
  streamId,
  validateCustomWorkflow,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { reportingOf } from '../ceo/prefs.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import { assertBusinessOrg } from '../orgs/mode.ts';
import { orgScope, projectScope, SYSTEM_ACTOR } from './common.ts';
import { createScheduleIn, type OrgCtx, patchScheduleIn } from './schedules.ts';

const BUILTIN_KEYS = BUILTIN_WORKFLOWS.map((w) => w.key);

const playbookOf = (key: string): BriefPlaybook => {
  if (!isBriefPlaybookKey(key)) throw badRequest('unknown_playbook', `no playbook '${key}'`);
  return BRIEF_PLAYBOOKS[key];
};

function managerOrg(org: OrgCtx | null): OrgCtx {
  if (!org) throw forbidden('only the Owner and Admins can use playbooks');
  if (!isOrgManager({ orgRole: org.role })) throw forbidden('only the Owner and Admins can use playbooks');
  return org;
}

/** The installed schedule of each playbook in the organization (by `action.playbook.key`). */
async function installedMap(db: Tx | Ctx['pool'], orgId: string): Promise<Map<string, string>> {
  const r = await rows(
    db,
    `SELECT id, action->'playbook'->>'key' AS key FROM schedules
      WHERE org_id=$1 AND action->'playbook' IS NOT NULL ORDER BY created_at`,
    [orgId],
  );
  return new Map(r.map((x) => [x.key as string, x.id as string]));
}

export async function listBriefPlaybooks(ctx: Ctx, org: OrgCtx | null): Promise<BriefPlaybookDto[]> {
  const o = managerOrg(org);
  await assertBusinessOrg(ctx.pool, o.orgId, 'Playbooks are available in business mode.');
  const installed = await installedMap(ctx.pool, o.orgId);
  return BRIEF_PLAYBOOK_KEYS.map((k) => {
    const p = BRIEF_PLAYBOOKS[k];
    return {
      key: p.key,
      name: p.name,
      description: p.description,
      cadence: p.cadence,
      defaultTime: p.defaultTime,
      defaultWeekday: p.defaultWeekday ?? null,
      defaultOwnerRole: p.defaultOwnerRole,
      maxWords: p.maxWords,
      scheduleId: installed.get(k) ?? null,
    };
  });
}

/**
 * Registers the Brief workflow of `roleKey` in the organization when it is missing and enables it on the project.
 * Returns the workflow key. A definition that does not validate is never registered.
 */
async function ensureBriefWorkflow(
  ctx: Ctx,
  tx: Tx,
  orgId: string,
  project: { id: string; created_by: string },
  roleKey: string,
): Promise<string> {
  const key = briefWorkflowKey(roleKey);
  const have = await one(tx, 'SELECT 1 FROM workflow_versions WHERE org_id=$1 AND key=$2 LIMIT 1', [
    orgId,
    key,
  ]);
  if (!have) {
    const def = briefWorkflow(roleKey);
    const errors = validateCustomWorkflow(def, BUSINESS_ROLES, {
      builtinWorkflowKeys: BUILTIN_KEYS,
      departments: [],
    }).filter((i) => i.severity === 'error');
    if (errors.length)
      throw conflict(
        'brief_workflow_invalid',
        `the Brief workflow is invalid: ${errors.map((e) => e.code).join(', ')}`,
      );
    await ctx.store.append(
      [
        {
          streamId: streamId.workflow(orgId, key),
          event: {
            type: 'WorkflowVersionRegistered',
            payload: {
              workflowVersionId: randomUUID(),
              orgId,
              key,
              version: def.version,
              name: def.name,
              definition: def,
              status: 'active',
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  }
  const enabled = await rows(
    tx,
    `SELECT workflow_key, default_card_types FROM project_workflows WHERE project_id=$1
      ORDER BY is_primary DESC, enabled_at, workflow_key`,
    [project.id],
  );
  if (!enabled.some((e) => e.workflow_key === key)) {
    // Empty default card types: a manual "Report" card keeps going to the business report workflow.
    const entries = [
      ...enabled.map((e) => ({
        workflowKey: e.workflow_key as string,
        defaultCardTypes: (e.default_card_types ?? []) as string[],
      })),
      { workflowKey: key, defaultCardTypes: [] as string[] },
    ];
    await ctx.store.append(
      [
        {
          streamId: streamId.project(project.id),
          event: {
            type: 'ProjectWorkflowsSet',
            payload: { projectId: project.id, enabled: entries, by: project.created_by },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(orgId, project.id),
        },
      ],
      { tx },
    );
  }
  return key;
}

export async function installBriefPlaybook(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  key: string,
  req: InstallBriefPlaybookRequest,
): Promise<{ scheduleId: string; webhookSecret?: string }> {
  const o = managerOrg(org);
  const playbook = playbookOf(key);
  return withAppendTx(ctx.pool, async (tx) => {
    await assertBusinessOrg(tx, o.orgId, 'Playbooks are available in business mode.');
    const installed = (await installedMap(tx, o.orgId)).get(playbook.key);
    if (installed)
      throw conflict('playbook_installed', `${playbook.name} is already installed`, {
        scheduleId: installed,
      });
    const projects = await rows(
      tx,
      `SELECT id, created_by FROM projects WHERE org_id=$1 AND kind='project' AND status='active' ORDER BY created_at`,
      [o.orgId],
    );
    let project = req.projectId ? projects.find((p) => p.id === req.projectId) : undefined;
    if (req.projectId && !project)
      throw badRequest('project_not_found', 'that project is not in this organization');
    if (!project) {
      if (projects.length > 1)
        throw badRequest('project_required', 'choose the project the cards are made in');
      project = projects[0];
    }
    if (!project)
      throw badRequest('project_required', 'the organization has no project to make the cards in');
    const role = req.ownerRole ?? playbook.defaultOwnerRole;
    const workflowKey = await ensureBriefWorkflow(ctx, tx, o.orgId, project as never, role);
    const timezone = req.timezone ?? (await reportingOf(tx, o.orgId)).timezone ?? 'UTC';
    const create: CreateScheduleRequest = {
      name: playbook.name,
      enabled: true,
      trigger: {
        kind: 'cron',
        cron: briefPlaybookCron(playbook, req.time ?? playbook.defaultTime, req.weekday),
        timezone,
      },
      action: {
        kind: 'create_card',
        projectId: project.id,
        template: { ...briefPlaybookTemplate(playbook, role, req.maxWords), workflowKey },
        deliverOutput: { destinations: req.destinations },
        playbook: { key: playbook.key, version: playbook.version },
      },
    } as CreateScheduleRequest;
    const r = await createScheduleIn(ctx, tx, user, o, {
      name: create.name,
      enabled: true,
      trigger: create.trigger as never,
      action: create.action as never,
    });
    return { scheduleId: r.id, ...(r.webhookSecret ? { webhookSecret: r.webhookSecret } : {}) };
  });
}

export async function patchBriefPlaybook(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  scheduleId: string,
  req: PatchBriefPlaybookRequest,
): Promise<{ webhookSecret?: string }> {
  const o = managerOrg(org);
  return withAppendTx(ctx.pool, async (tx) => {
    await assertBusinessOrg(tx, o.orgId, 'Playbooks are available in business mode.');
    const s = await one(tx, 'SELECT * FROM schedules WHERE id=$1 AND org_id=$2', [scheduleId, o.orgId]);
    const action = s?.action as
      | { kind?: string; projectId?: string; template?: Record<string, unknown>; playbook?: { key: string } }
      | undefined;
    if (!s || action?.kind !== 'create_card' || !action.playbook)
      throw badRequest('not_a_playbook', 'this automation was not installed from a playbook');
    const playbook = playbookOf(action.playbook.key);
    const curTrigger = s.trigger as { kind: string; cron: string; timezone: string };
    const curFields = (action.template?.fields ?? {}) as Record<string, unknown>;
    const curRole =
      BUSINESS_ROLES.find((r) => briefWorkflowKey(r.key) === action.template?.workflowKey)?.key ??
      playbook.defaultOwnerRole;
    const role = req.ownerRole ?? curRole;
    const patch: Record<string, unknown> = {};
    if (req.enabled !== undefined) patch.enabled = req.enabled;

    const [curMin = '0', curHour = '7'] = curTrigger.cron.split(' ');
    const time = req.time ?? `${String(curHour).padStart(2, '0')}:${String(curMin).padStart(2, '0')}`;
    const curDow = Number(curTrigger.cron.split(' ')[4]);
    const weekday = req.weekday ?? (Number.isFinite(curDow) ? curDow : playbook.defaultWeekday);
    if (req.time || req.weekday !== undefined || req.timezone)
      patch.trigger = {
        kind: 'cron',
        cron: briefPlaybookCron(playbook, time, weekday),
        timezone: req.timezone ?? curTrigger.timezone,
      };

    const proj = await one(tx, 'SELECT id, created_by FROM projects WHERE id=$1', [action.projectId]);
    if (!proj) throw conflict('project_gone', 'the project of this playbook is gone');
    const workflowKey = await ensureBriefWorkflow(ctx, tx, o.orgId, proj as never, role);
    const cur = s.action as Record<string, unknown> & { deliverOutput?: { destinations: unknown[] } };
    const maxWords =
      req.maxWords ?? (typeof curFields.maxWords === 'number' ? curFields.maxWords : undefined);
    patch.action = {
      ...cur,
      template: {
        ...(action.template ?? {}),
        workflowKey,
        fields: { ...curFields, maxWords: maxWords ?? playbook.maxWords },
      },
      ...(req.destinations ? { deliverOutput: { destinations: req.destinations } } : {}),
    };
    return patchScheduleIn(ctx, tx, user, o, scheduleId, patch as never);
  });
}
