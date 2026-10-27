import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  actionKind,
  actionProjectId,
  actionWorkstationId,
  type CardTemplate,
  type CreateScheduleRequest,
  effectiveFeatures,
  emptyFields,
  getStage,
  HR_DESK_SUBKIND,
  isEmailAction,
  isEmailAddress,
  isMailTrigger,
  isOrgLevelAction,
  isOrgManager,
  isOrgOperational,
  isPollAction,
  isTriggerImplemented,
  isWebhookAction,
  normaliseAllowEntry,
  type OrgRole,
  type PatchScheduleRequest,
  parseCardFields,
  RegressionPlatform,
  SCHEDULE_EVENT_TRIGGERS,
  type ScheduleAction,
  type ScheduleDto,
  type ScheduleRunDto,
  type ScheduleTrigger,
  type SystemScheduleDto,
  scheduleBackoffMs,
  scheduleEventLabel,
  streamId,
  unknownMappingTokens,
  usesHookTokens,
} from '@aom/shared';
import { CronExpressionParser } from 'cron-parser';
import { orgRoleOf } from '../auth/org-context.ts';
import { encryptSecret } from '../auth/secrets.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { resolveCardWorkflow } from './cards.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import {
  dayIn,
  executeAction,
  failedRun,
  type RunOutcome,
  type RunSpec,
  runRecordedEvent,
  scheduledCard,
  scheduleScope,
} from './schedule-actions.ts';
import { assertWebhookUrl, attemptDelivery, attemptsOf } from './schedule-delivery.ts';
import { digestAvailable } from './schedule-digest.ts';

/** The next time `cron` fires strictly after `from`, evaluated in the IANA zone `timezone`. Null: it never fires again. */
export function nextFireAfter(cron: string, timezone: string, from: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

/** 400 for a bad cron expression or time zone. */
export function assertCronAndZone(cron: string, timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw badRequest('invalid_timezone', `'${timezone}' is not an IANA time zone (e.g. Africa/Johannesburg)`);
  }
  if (cron.trim().split(/\s+/).length !== 5)
    throw badRequest('invalid_cron', 'the cron expression must have 5 fields: minute hour day month weekday');
  try {
    CronExpressionParser.parse(cron, { tz: timezone });
  } catch (err) {
    throw badRequest(
      'invalid_cron',
      `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ------------------------------------------------------------------------------------------------ views

/** The viewer's organization, for actions that belong to the organization rather than to a project. */
export interface OrgCtx {
  orgId: string;
  role: OrgRole | null;
}

/** The action without its secret. */
function publicAction(a: ScheduleAction | null): ScheduleAction | null {
  if (a && isWebhookAction(a)) {
    const { secretEnc: _s, ...rest } = a;
    return rest;
  }
  return a;
}

const toDto = (r: Row, roles: Map<string, OrgRole>): ScheduleDto => {
  const action = r.action as ScheduleAction;
  const orgLevel = isOrgLevelAction(action);
  const role = roles.get(r.org_id) ?? null;
  const stored = (r.trigger as ScheduleTrigger | null) ?? {
    kind: 'cron' as const,
    cron: r.cron,
    timezone: r.timezone,
  };
  // The hash of an incoming webhook's secret stays on the server.
  const trigger: ScheduleTrigger =
    stored.kind === 'webhook_in' ? (({ secretHash: _h, ...rest }) => rest)(stored) : stored;
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    projectKey: r.project_key ?? null,
    projectName: r.project_name ?? null,
    name: r.name,
    kind: r.kind,
    trigger,
    action: publicAction(action) as ScheduleAction,
    cron: r.cron ?? null,
    timezone: r.timezone ?? null,
    ...(r.card_template ? { cardTemplate: r.card_template } : {}),
    enabled: r.enabled,
    nextFireAt: iso(r.next_fire_at),
    lastFiredAt: iso(r.last_fired_at),
    lastCardId: r.last_card_id,
    failCount: r.fail_count ?? 0,
    lastError: r.last_error ?? null,
    createdAt: iso(r.created_at) as string,
    ownerUserId: r.owner_user_id ?? null,
    ownerName: r.owner_name ?? null,
    orgLevel,
    canEdit: !orgLevel || isOrgManager({ orgRole: role }),
    hasWebhookSecret:
      stored.kind === 'webhook_in'
        ? !!stored.secretHash
        : !!action && isWebhookAction(action) && !!action.secretEnc,
    ...(stored.kind === 'webhook_in' ? { hookUrl: `/api/hooks/${r.id}` } : {}),
    lastStatus: r.last_status ?? null,
    lastSummary: r.last_summary ?? null,
  };
};

const SELECT = `SELECT s.*, p.key AS project_key, p.name AS project_name, u.display_name AS owner_name
  FROM schedules s LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN users u ON u.id = s.owner_user_id`;

/** Project-bound: the viewer is an active member of the (active) project. Organization-level: the viewer is its Owner or an Admin. */
const VISIBLE = `((s.project_id IS NOT NULL AND p.status = 'active' AND s.project_id IN
        (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'))
   OR (s.project_id IS NULL AND s.org_id IN
        (SELECT org_id FROM org_members WHERE user_id = $1 AND status = 'active' AND role IN ('owner','admin'))))
  AND (s.project_id IS NULL OR (p.status = 'active'))`;

async function rolesOf(db: Queryable, userId: string): Promise<Map<string, OrgRole>> {
  const list = await rows<{ org_id: string; role: OrgRole }>(
    db,
    `SELECT org_id, role FROM org_members WHERE user_id=$1 AND status='active'`,
    [userId],
  );
  return new Map(list.map((r) => [r.org_id, r.role]));
}

export async function listSchedules(
  db: Queryable,
  userId: string,
  projectId?: string,
): Promise<ScheduleDto[]> {
  const r = await rows(
    db,
    `${SELECT} WHERE ${VISIBLE} AND ($2::uuid IS NULL OR s.project_id = $2) ORDER BY p.key NULLS FIRST, s.created_at, s.id`,
    [userId, projectId ?? null],
  );
  const roles = await rolesOf(db, userId);
  return r.filter((x) => x.action).map((x) => toDto(x, roles));
}

export async function getScheduleDto(db: Queryable, userId: string, id: string): Promise<ScheduleDto> {
  const r = await one(db, `${SELECT} WHERE ${VISIBLE} AND s.id = $2`, [userId, id]);
  if (!r || !r.action) throw notFound('schedule not found');
  return toDto(r, await rolesOf(db, userId));
}

/** The jobs the system runs by itself, shown read-only next to the schedules (decision 8). */
export async function listSystemSchedules(ctx: Ctx, userId: string): Promise<SystemScheduleDto[]> {
  const out: SystemScheduleDto[] = [];
  const now = ctx.clock.now();
  const ws = await rows(
    ctx.pool,
    `SELECT w.id, w.name, w.hygiene_interval_hours, w.hygiene_last_at, w.paired_at FROM workstations w
      WHERE w.user_id=$1 AND w.status='active' AND w.hygiene_interval_hours > 0
        AND EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.is_devops AND a.status='active')
      ORDER BY w.name, w.id`,
    [userId],
  );
  for (const w of ws) {
    const last = w.hygiene_last_at ?? null;
    const base = new Date(last ?? w.paired_at);
    out.push({
      id: `system:hygiene:${w.id}`,
      kind: 'hygiene',
      name: `Repository hygiene on ${w.name}`,
      description:
        'The DevOps engineer commits and pushes unsaved work on the working branch, sweeps worktrees of finished cards and reports stale branches.',
      when: `Every ${w.hygiene_interval_hours} hour${w.hygiene_interval_hours === 1 ? '' : 's'}`,
      lastRunAt: iso(last),
      nextRunAt: new Date(base.getTime() + w.hygiene_interval_hours * 3_600_000).toISOString(),
      configureAt: '/workstations',
    });
  }
  const orgs = await rows(
    ctx.pool,
    `SELECT om.org_id, o.name, u.timezone, u.reporting,
            (SELECT cs.settings->>'reportAt' FROM ceo_settings cs WHERE cs.org_id = om.org_id) AS ceo_report_at,
            (SELECT max(created_at) FROM desk_items d WHERE d.org_id = om.org_id AND d.subkind IN ('floor_report','ceo_report')) AS last_at
       FROM org_members om JOIN organizations o ON o.id = om.org_id AND o.status IN ('trial','active')
       JOIN users u ON u.id = o.owner_user_id
      WHERE om.user_id=$1 AND om.status='active' AND om.role IN ('owner','admin') ORDER BY o.name`,
    [userId],
  );
  for (const o of orgs) {
    const dailyAt: string =
      o.ceo_report_at ?? (o.reporting as { dailyAt?: string } | null)?.dailyAt ?? '08:00';
    const [hh = '8', mm = '0'] = dailyAt.split(':');
    const tz: string = o.timezone ?? 'UTC';
    out.push({
      id: `system:floor_report:${o.org_id}`,
      kind: 'floor_report',
      name: orgs.length > 1 ? `CEO daily report (${o.name})` : 'CEO daily report',
      description:
        'The CEO writes one report a day: what it handled, what needs you, phases, stuck work, failures, spend and open DevOps requests.',
      when: `Daily at ${dailyAt} (${tz})`,
      lastRunAt: iso(o.last_at),
      nextRunAt: nextFireAfter(`${Number(mm)} ${Number(hh)} * * *`, tz, now)?.toISOString() ?? null,
      configureAt: '/ceo',
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------- validation

/** Validates a template against the project's workflow field set (a bad feed template must fail now, not at 07:00). */
export async function checkTemplate(tx: Queryable, project: Row, kind: string, template: CardTemplate) {
  const wf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!wf) throw badRequest('unknown_workflow', `workflow '${project.workflow_key}' is not available`);
  if (kind === 'feed' && wf.definition.fieldSet !== 'feed')
    throw badRequest('not_a_feed_project', 'feed schedules need a project with the feed workflow');
  if (kind === 'regression') {
    if (!getStage(wf.definition, 'test'))
      throw badRequest('no_test_stage', 'regression schedules need a project workflow with a test stage');
    if (!RegressionPlatform.safeParse(template.fields.platform ?? 'web').success)
      throw badRequest('invalid_platform', "a regression schedule's platform must be web, mobile or both");
    return;
  }
  const cardType = template.cardType ?? wf.definition.cardTypes[0];
  const cardWf = cardType ? await resolveCardWorkflow(tx, project, cardType, template.workflowKey) : null;
  if (!cardType || !cardWf)
    throw badRequest(
      'invalid_card_type',
      `card type '${cardType}' is not allowed in workflow '${wf.definition.key}'`,
    );
  const parsed = parseCardFields(cardWf.definition.fieldSet, {
    ...emptyFields(cardWf.definition.fieldSet),
    ...template.fields,
  });
  if (!parsed.success) throw badRequest('invalid_fields', 'card fields are invalid', parsed.error.issues);
}

interface Normalized {
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  action: ScheduleAction;
}

/** The new `{trigger, action}` request, or the old `{projectId, kind, cron, timezone, cardTemplate}` one, as one shape. */
function normalizeCreate(req: CreateScheduleRequest): Normalized {
  if (req.kind === 'feed')
    throw badRequest(
      'use_interests',
      'feeds are interests now: create the feed on the Interests page (it brings its own schedule)',
    );
  let action = req.action;
  if (!action) {
    if (!req.projectId || !req.cardTemplate)
      throw badRequest('action_required', 'a schedule needs an action (what it does)');
    action =
      req.kind === 'regression'
        ? { kind: 'regression_run', projectId: req.projectId, template: req.cardTemplate }
        : { kind: 'create_card', projectId: req.projectId, template: req.cardTemplate };
  }
  const trigger: ScheduleTrigger | undefined =
    req.trigger ??
    (req.action && !req.cron
      ? undefined
      : { kind: 'cron', cron: req.cron ?? '0 7 * * *', timezone: req.timezone ?? 'UTC' });
  if (!trigger) throw badRequest('trigger_required', 'a schedule needs a trigger (when it runs)');
  return { name: req.name, enabled: req.enabled, trigger, action };
}

/**
 * Who may create or change a schedule (docs/design/restructure.md, "Impact of organizations"): an action tied to a
 * project belongs to the project's members, guests on a shared project included; an organization-level action (a BA
 * task without a project, hygiene, an integration without a project) to the Owner and Admins. An action that runs on a
 * workstation also needs that workstation's user.
 */
async function authorize(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  n: Normalized,
): Promise<{ orgId: string; project: Row | null }> {
  const projectId = actionProjectId(n.action);
  let orgId: string;
  let project: Row | null = null;
  if (projectId) {
    project = await loadVisibleProject(tx, user.id, projectId);
    if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
    orgId = project.org_id;
  } else {
    if (!org) throw forbidden('organization-level schedules need an organization');
    orgId = org.orgId;
  }
  if (isOrgLevelAction(n.action)) {
    const role = org && org.orgId === orgId ? org.role : await orgRoleOf(tx, user.id, orgId);
    if (!isOrgManager({ orgRole: role }))
      throw forbidden(
        'only the Owner and Admins can create or change a schedule that acts for the whole organization (a BA task, hygiene, an integration without a project)',
      );
  }
  const ws = actionWorkstationId(n.action, n.trigger);
  if (ws) {
    const w = await one(tx, `SELECT user_id FROM workstations WHERE id=$1 AND status='active'`, [ws]);
    if (!w || w.user_id !== user.id)
      throw forbidden('the workstation is not yours: an action on a workstation runs as its user');
  }
  if (n.trigger.kind === 'event') {
    if (n.trigger.projectId) await loadVisibleProject(tx, user.id, n.trigger.projectId);
    if (n.trigger.interestId) {
      const i = await one(tx, 'SELECT org_id FROM interests WHERE id=$1', [n.trigger.interestId]);
      if (!i || i.org_id !== orgId) throw notFound('interest not found');
    }
  }
  void ctx;
  return { orgId, project };
}

/** Triggers that react to something that happened in the organization (the "Automations" of the UI). */
const isEventTrigger = (t: ScheduleTrigger): boolean =>
  t.kind === 'event' || t.kind === 'intake_ticket' || t.kind === 'webhook_in' || isMailTrigger(t);

/** What can be checked about an event trigger now: which events take which conditions, and that the stage exists. */
async function validateEventTrigger(tx: Tx, orgId: string, t: ScheduleTrigger): Promise<void> {
  if (t.kind === 'intake_ticket') {
    if (t.projectId)
      throw badRequest(
        'invalid_trigger',
        'an intake has no project when it arrives: leave the project out of this trigger',
      );
    return;
  }
  if (isMailTrigger(t)) {
    const inbox = await one(tx, 'SELECT 1 FROM mail_inboxes WHERE id=$1 AND org_id=$2', [t.inboxId, orgId]);
    if (!inbox) throw badRequest('unknown_inbox', 'that e-mail inbox does not exist in this organisation');
    if (t.kind === 'email_received') {
      const bad = (t.from ?? []).filter((x) => !normaliseAllowEntry(x));
      if (bad.length) throw badRequest('invalid_trigger', `not an address or a domain: ${bad.join(', ')}`);
    }
    return;
  }
  if (t.kind !== 'event') return;
  const def = SCHEDULE_EVENT_TRIGGERS.find((e) => e.id === t.event);
  const conditions = t.workflowKey || t.stageId || t.filter;
  if (conditions && !def?.cardFilters)
    throw badRequest(
      'invalid_trigger',
      `${scheduleEventLabel(t.event).toLowerCase()} takes no workflow, stage or filter`,
    );
  if (t.stageId && def?.cardFilters !== 'stage')
    throw badRequest('invalid_trigger', 'only "a card reaches a stage" takes a stage');
  if (t.event === 'card_stage_reached' && (!t.workflowKey || !t.stageId))
    throw badRequest('invalid_trigger', 'choose the workflow and the stage the card must reach');
  if (t.workflowKey) {
    const wf = await resolveWorkflow(tx, orgId, t.workflowKey);
    if (!wf) throw badRequest('unknown_workflow', `workflow '${t.workflowKey}' is not available`);
    if (t.stageId && !getStage(wf.definition, t.stageId))
      throw badRequest('unknown_stage', `workflow '${t.workflowKey}' has no stage '${t.stageId}'`);
  }
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Everything about the action and trigger that can be checked now rather than at 07:00. */
async function validate(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  orgId: string,
  project: Row | null,
  n: Normalized,
  isManager: boolean,
): Promise<void> {
  const t = n.trigger;
  if (!isTriggerImplemented(t))
    throw badRequest(
      'trigger_not_available',
      t.kind === 'intake_ticket' && t.source === 'email'
        ? 'an intake does not start from e-mail: use the "an e-mail arrives" trigger'
        : t.kind === 'webhook_in'
          ? 'incoming webhooks are not available yet'
          : 'this kind of trigger is not available yet',
    );
  await validateEventTrigger(tx, orgId, t);
  if (t.kind === 'webhook_in' && t.allowQueued && (await orgRoleOf(tx, user.id, orgId)) !== 'owner')
    throw forbidden('only the Owner can let cards from an incoming webhook start queued');
  if (n.action.kind === 'create_card' && usesHookTokens(n.action.template.mapping) && t.kind !== 'webhook_in')
    throw badRequest('invalid_mapping', 'the {hook.*} fields only exist for an incoming webhook trigger');
  if (t.kind === 'cron' || t.kind === 'issue_labelled') assertCronAndZone(t.cron, t.timezone);
  if (t.kind === 'issue_labelled') {
    if (t.provider === 'github' && !GITHUB_REPO.test(t.query.trim()))
      throw badRequest('invalid_query', 'a GitHub trigger takes a repository as owner/repo');
    if (
      n.action.kind === 'regression_run' ||
      (n.action.kind === 'integration' && 'workstationId' in n.action)
    )
      throw badRequest('invalid_trigger', 'this action cannot answer a labelled issue');
  }
  const a = n.action;
  switch (a.kind) {
    case 'create_card':
    case 'regression_run': {
      if (a.kind === 'create_card') {
        const bad = unknownMappingTokens(a.template.mapping);
        if (bad.length)
          throw badRequest(
            'unknown_mapping_token',
            `unknown field mapping token: ${bad.map((x) => `{${x}}`).join(', ')}`,
          );
        if (isEventTrigger(t) && !isManager) {
          // Members may only set up automations that make draft cards: the BA or an Owner takes it from there.
          if (a.template.start === 'queued')
            throw forbidden(
              'members can create automations that make draft cards only; ask an Owner or Admin to queue cards directly',
            );
          n.action = { ...a, template: { ...a.template, start: 'draft' } };
        }
      }
      const wf = await resolveWorkflow(tx, (project as Row).org_id, (project as Row).workflow_key);
      if (wf?.definition.fieldSet === 'feed')
        throw badRequest('use_interests', 'a feed is an interest now: create it on the Interests page');
      await checkTemplate(
        tx,
        project as Row,
        a.kind === 'regression_run' ? 'regression' : 'card',
        a.template,
      );
      break;
    }
    case 'devops_request': {
      if (!a.hygiene && !a.text.trim())
        throw badRequest(
          'empty_request',
          'write what the DevOps engineer should do, or choose repository hygiene',
        );
      const { devopsAgentOn } = await import('./devops.ts');
      if (!(await devopsAgentOn(tx, a.workstationId, orgId)))
        throw conflict('no_devops_agent', 'this workstation has no DevOps engineer');
      break;
    }
    case 'ba_task':
      break;
    case 'integration': {
      if (isPollAction(a)) {
        if (a.integration === 'github' && !GITHUB_REPO.test(a.query.trim()))
          throw badRequest('invalid_query', 'a GitHub poll takes a repository as owner/repo');
      } else if (isWebhookAction(a)) {
        assertWebhookUrl(ctx, a.url);
        if (a.digest === 'floor_report' && project)
          throw badRequest(
            'org_level_digest',
            'the daily report covers the organization: leave the project out',
          );
        if (a.digest === 'project_summary' && !project)
          throw badRequest('project_required', 'a project summary needs a project');
        if (a.digest && !digestAvailable(a.digest))
          throw badRequest('digest_unavailable', `the ${a.digest} digest is not available yet`);
      } else if (isEmailAction(a)) {
        for (const to of a.to)
          if (!isEmailAddress(to)) throw badRequest('invalid_email', `'${to}' is not an e-mail address`);
        if (a.digest === 'floor_report' && project)
          throw badRequest(
            'org_level_digest',
            'the daily report covers the organization: leave the project out',
          );
        if (a.digest === 'project_summary' && !project)
          throw badRequest('project_required', 'a project summary needs a project');
        if (!digestAvailable(a.digest))
          throw badRequest('digest_unavailable', `the ${a.digest} digest is not available yet`);
        if (!isManager) {
          // A member or guest may mail only themselves: the site is not a way to send mail to other people.
          const mine = String(
            (await one(tx, 'SELECT email FROM users WHERE id=$1', [user.id]))?.email ?? '',
          ).toLowerCase();
          if (a.to.some((x) => x.toLowerCase() !== mine))
            throw forbidden(
              'you can send a digest to your own address only; ask an Owner or Admin for others',
            );
        }
      }
    }
  }
}

const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** The secret of an incoming webhook: shown once; only its SHA-256 is kept (it is 192 random bits, so no salt is needed). */
export const newHookSecret = () => `hook_${randomBytes(24).toString('base64url')}`;
export const hashHookSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
const stripHash = (
  t: Extract<ScheduleTrigger, { kind: 'webhook_in' }>,
): Extract<ScheduleTrigger, { kind: 'webhook_in' }> => {
  const { secretHash: _h, ...rest } = t;
  return rest;
};

/** `next_fire_at`: cron and polling triggers only. */
const nextFor = (t: ScheduleTrigger, enabled: boolean, now: Date): string | null =>
  enabled && (t.kind === 'cron' || t.kind === 'issue_labelled')
    ? (nextFireAfter(t.cron, t.timezone, now)?.toISOString() ?? null)
    : null;

const templateOf = (a: ScheduleAction): CardTemplate | undefined =>
  a.kind === 'create_card' || a.kind === 'regression_run' ? a.template : undefined;

function bodyOf(
  id: string,
  n: Normalized,
  extra: { ownerUserId?: string | undefined; nextFireAt: string | null },
) {
  const t = n.trigger;
  const template = templateOf(n.action);
  return {
    scheduleId: id,
    projectId: actionProjectId(n.action),
    name: n.name,
    kind: actionKind(n.action),
    cron: t.kind === 'cron' || t.kind === 'issue_labelled' ? t.cron : null,
    timezone: t.kind === 'cron' || t.kind === 'issue_labelled' ? t.timezone : null,
    ...(template ? { cardTemplate: template } : {}),
    trigger: t,
    action: n.action,
    ...(extra.ownerUserId ? { ownerUserId: extra.ownerUserId } : {}),
    enabled: n.enabled,
    nextFireAt: extra.nextFireAt,
  };
}

// ------------------------------------------------------------------------------------------ commands

export async function createSchedule(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  req: CreateScheduleRequest,
): Promise<{ id: string; webhookSecret?: string }> {
  const n = normalizeCreate(req);
  return withAppendTx(ctx.pool, async (tx) => {
    const { orgId, project } = await authorize(ctx, tx, user, org, n);
    const isManager = isOrgManager({ orgRole: await orgRoleOf(tx, user.id, orgId) });
    await validate(ctx, tx, user, orgId, project, n, isManager);
    let webhookSecret: string | undefined;
    if (n.trigger.kind === 'webhook_in') {
      webhookSecret = newHookSecret();
      n.trigger = { ...stripHash(n.trigger), secretHash: hashHookSecret(webhookSecret) };
    }
    if (n.action.kind === 'integration' && n.action.integration === 'webhook') {
      webhookSecret = newSecret();
      n.action = { ...n.action, secretEnc: await encryptSecret(ctx, webhookSecret) };
    }
    const id = randomUUID();
    const nextFireAt = nextFor(n.trigger, n.enabled, ctx.clock.now());
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(id),
          event: { type: 'ScheduleCreated', payload: bodyOf(id, n, { ownerUserId: user.id, nextFireAt }) },
          actor: userActor(user.id),
          scope: project ? projectScope(orgId, project.id) : orgScope(orgId),
        },
      ],
      { tx },
    );
    return { id, ...(webhookSecret ? { webhookSecret } : {}) };
  });
}

/**
 * Locks the schedule and checks that the user may manage it: a member of its project, or (organization-level) an
 * Owner or Admin.
 */
async function lockManaged(
  tx: Tx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  id: string,
): Promise<{ s: Row; project: Row | null; orgId: string }> {
  const s = await one(tx, 'SELECT * FROM schedules WHERE id=$1 FOR UPDATE', [id]);
  if (!s || !s.action) throw notFound('schedule not found');
  let project: Row | null = null;
  if (s.project_id) {
    project = await loadVisibleProject(tx, user.id, s.project_id);
  } else if (!(await orgRoleOf(tx, user.id, s.org_id))) throw notFound('schedule not found');
  if (isOrgLevelAction(s.action as ScheduleAction)) {
    const role = org && org.orgId === s.org_id ? org.role : await orgRoleOf(tx, user.id, s.org_id);
    if (!isOrgManager({ orgRole: role }))
      throw forbidden('only the Owner and Admins can change a schedule that acts for the whole organization');
  }
  return { s, project, orgId: s.org_id };
}

export async function patchSchedule(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  id: string,
  patch: PatchScheduleRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { s, project, orgId } = await lockManaged(tx, user, org, id);
    const cur = s.action as ScheduleAction;
    let action = patch.action ?? cur;
    if (patch.cardTemplate && (cur.kind === 'create_card' || cur.kind === 'regression_run'))
      action = { ...cur, template: patch.cardTemplate };
    const curTrigger: ScheduleTrigger = s.trigger ?? { kind: 'cron', cron: s.cron, timezone: s.timezone };
    let trigger: ScheduleTrigger = patch.trigger ?? curTrigger;
    if ((patch.cron || patch.timezone) && !patch.trigger && trigger.kind === 'cron')
      trigger = {
        kind: 'cron',
        cron: patch.cron ?? trigger.cron,
        timezone: patch.timezone ?? trigger.timezone,
      };
    if (
      action.kind !== cur.kind ||
      (action.kind === 'integration' &&
        cur.kind === 'integration' &&
        JSON.stringify([
          action.integration === 'github' || action.integration === 'jira' ? 'poll' : action.integration,
        ]) !==
          JSON.stringify([
            cur.integration === 'github' || cur.integration === 'jira' ? 'poll' : cur.integration,
          ]))
    )
      throw badRequest('action_kind_fixed', 'what a schedule does cannot be changed: create a new schedule');
    if (isWebhookAction(action) && isWebhookAction(cur))
      action = { ...action, secretEnc: cur.secretEnc as string };
    if (trigger.kind === 'webhook_in') {
      const kept = curTrigger.kind === 'webhook_in' ? curTrigger.secretHash : undefined;
      trigger = { ...stripHash(trigger), ...(kept ? { secretHash: kept } : {}) } as ScheduleTrigger;
    }
    const n: Normalized = {
      name: patch.name ?? s.name,
      enabled: patch.enabled ?? s.enabled,
      trigger,
      action,
    };
    const actionChanged = JSON.stringify(action) !== JSON.stringify(cur);
    const triggerChanged = !isDeepStrictEqual(trigger, curTrigger);
    if (actionChanged || triggerChanged) {
      await authorize(ctx, tx, user, org, n);
      await validate(
        ctx,
        tx,
        user,
        orgId,
        project,
        n,
        isOrgManager({ orgRole: await orgRoleOf(tx, user.id, orgId) }),
      );
    }
    // A changed trigger, or re-enabling, recomputes the next fire; otherwise the pending fire is kept.
    const reschedule = triggerChanged || Boolean(patch.enabled && !s.enabled);
    const nextFireAt = !n.enabled
      ? null
      : reschedule || !s.next_fire_at
        ? nextFor(trigger, true, ctx.clock.now())
        : (iso(s.next_fire_at) as string);
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(s.id),
          event: {
            type: 'ScheduleUpdated',
            payload: bodyOf(s.id, n, { ownerUserId: s.owner_user_id ?? undefined, nextFireAt }),
          },
          actor: userActor(user.id),
          scope: scheduleScope(s),
        },
      ],
      { tx },
    );
  });
}

/** A new signing secret for a webhook schedule; the old one stops working at once. Shown to the caller this once. */
export async function rotateWebhookSecret(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  id: string,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const { s } = await lockManaged(tx, user, org, id);
    const cur = s.action as ScheduleAction;
    const curTrigger: ScheduleTrigger = s.trigger ?? { kind: 'cron', cron: s.cron, timezone: s.timezone };
    if (curTrigger.kind !== 'webhook_in' && !isWebhookAction(cur))
      throw badRequest('not_a_webhook', 'only a webhook schedule has a signing secret');
    const secret = curTrigger.kind === 'webhook_in' ? newHookSecret() : newSecret();
    const action: ScheduleAction =
      curTrigger.kind === 'webhook_in' || !isWebhookAction(cur)
        ? cur
        : { ...cur, secretEnc: await encryptSecret(ctx, secret) };
    const trigger: ScheduleTrigger =
      curTrigger.kind === 'webhook_in' ? { ...curTrigger, secretHash: hashHookSecret(secret) } : curTrigger;
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(s.id),
          event: {
            type: 'ScheduleUpdated',
            payload: bodyOf(
              s.id,
              { name: s.name, enabled: s.enabled, trigger, action },
              { ownerUserId: s.owner_user_id ?? undefined, nextFireAt: iso(s.next_fire_at) },
            ),
          },
          actor: userActor(user.id),
          scope: scheduleScope(s),
        },
      ],
      { tx },
    );
    return secret;
  });
}

/** Switches an incoming webhook off for good until a new secret is made: every call is refused. */
export async function revokeHookSecret(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  id: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { s } = await lockManaged(tx, user, org, id);
    const trigger = s.trigger as ScheduleTrigger | null;
    if (trigger?.kind !== 'webhook_in')
      throw badRequest('not_a_webhook', 'only an incoming-webhook automation has a secret');
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(s.id),
          event: {
            type: 'ScheduleUpdated',
            payload: bodyOf(
              s.id,
              { name: s.name, enabled: s.enabled, trigger: stripHash(trigger), action: s.action },
              { ownerUserId: s.owner_user_id ?? undefined, nextFireAt: iso(s.next_fire_at) },
            ),
          },
          actor: userActor(user.id),
          scope: scheduleScope(s),
        },
      ],
      { tx },
    );
  });
}

/**
 * The `ScheduleUpdated` for `next` (a full snapshot). Next-fire rules: disabled has none; a changed cron or time zone,
 * or re-enabling (`reschedule`), recomputes it; otherwise the pending fire is kept.
 */
export function scheduleUpdateEvent(
  s: Row,
  project: Row,
  next: { name: string; cron: string; timezone: string; cardTemplate: CardTemplate; enabled: boolean },
  reschedule: boolean,
  now: Date,
  actor: AppendInput['actor'],
): AppendInput {
  const nextFireAt = !next.enabled
    ? null
    : reschedule || !s.next_fire_at
      ? (nextFireAfter(next.cron, next.timezone, now)?.toISOString() ?? null)
      : (iso(s.next_fire_at) as string);
  return {
    streamId: streamId.schedule(s.id),
    event: {
      type: 'ScheduleUpdated',
      payload: { scheduleId: s.id, projectId: s.project_id, kind: s.kind, ...next, nextFireAt },
    },
    actor,
    scope: projectScope(project.org_id, project.id),
  };
}

export async function deleteSchedule(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  id: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { s } = await lockManaged(tx, user, org, id);
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(id),
          event: { type: 'ScheduleDeleted', payload: { scheduleId: s.id } },
          actor: userActor(user.id),
          scope: scheduleScope(s),
        },
      ],
      { tx },
    );
  });
}

// ------------------------------------------------------------------------------------------ running

/** Runs what an outcome left to do after its transaction: the hooks, then the delivery's first try. */
export async function afterRun(ctx: Ctx, o: RunOutcome): Promise<void> {
  for (const f of o.after) await f().catch((err) => ctx.log.warn({ err }, 'schedule follow-up failed'));
  if (o.delivery)
    await attemptDelivery(ctx, o.runId).catch((err) => ctx.log.warn({ err }, 'delivery failed'));
}

/** Records a run of `s` that was started by someone or something other than the cron: run now, an event, an issue. */
export async function runNow(ctx: Ctx, tx: Tx, s: Row, spec: RunSpec): Promise<RunOutcome> {
  const outcome = await executeAction(ctx, tx, s, spec);
  await ctx.store.append([...outcome.events, runRecordedEvent(s, outcome, spec, ctx.clock.now())], { tx });
  return outcome;
}

/** "Run now": the action runs once, whatever the trigger; the schedule's own timing is not touched. */
export async function runScheduleNow(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  id: string,
): Promise<{ runId: string; status: string; summary: string; cardId: string | null; ref: string | null }> {
  const { outcome, card } = await withAppendTx(ctx.pool, async (tx) => {
    const { s } = await lockManaged(tx, user, org, id);
    if (s.kind === 'feed') throw conflict('use_interests', 'run a feed from the Interests page');
    const o = await runNow(ctx, tx, s, {
      trigger: 'manual',
      label: `run now by ${user.displayName}`,
      firedFor: ctx.clock.now(),
      byUserId: user.id,
    });
    const cardId = o.result?.cardIds?.[0] ?? null;
    const card = cardId ? await one(tx, 'SELECT ref FROM cards WHERE id=$1', [cardId]) : undefined;
    return { outcome: o, card: card ? { id: cardId as string, ref: card.ref as string } : null };
  });
  await afterRun(ctx, outcome);
  const final = outcome.delivery
    ? await one(ctx.pool, 'SELECT status, summary, error FROM schedule_runs WHERE id=$1', [outcome.runId])
    : undefined;
  return {
    runId: outcome.runId,
    status: final?.status ?? outcome.status,
    summary: final?.error ? `${outcome.summary}: ${final.error}` : outcome.summary,
    cardId: card?.id ?? null,
    ref: card?.ref ?? null,
  };
}

/** `POST /api/schedules/:id/test`: one signed test delivery of a webhook (or e-mail) schedule. Not retried. */
export async function testSchedule(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgCtx | null,
  id: string,
): Promise<{
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  runId: string;
}> {
  const outcome = await withAppendTx(ctx.pool, async (tx) => {
    const { s } = await lockManaged(tx, user, org, id);
    const a = s.action as ScheduleAction;
    if (!isWebhookAction(a) && !isEmailAction(a))
      throw badRequest('not_testable', 'only a webhook or an e-mail schedule can be tested');
    const spec: RunSpec = {
      trigger: 'test',
      label: `test by ${user.displayName}`,
      firedFor: ctx.clock.now(),
      byUserId: user.id,
      text: { event: 'test' },
      details: { test: true },
    };
    const o = await executeAction(ctx, tx, s, spec);
    if (o.delivery?.kind === 'webhook' && isWebhookAction(a))
      o.delivery = {
        ...o.delivery,
        body: JSON.stringify(testBody(a.format, s, o.delivery.body, ctx.clock.now())),
      };
    const ev = runRecordedEvent(s, o, spec, ctx.clock.now());
    // A test is sent now and never retried: no next try is scheduled.
    const p = (ev.event as { payload: Record<string, unknown> }).payload;
    p.nextAttemptAt = undefined;
    await ctx.store.append([ev], { tx });
    return o;
  });
  const r = await attemptDelivery(ctx, outcome.runId, { single: true });
  return {
    ok: r?.ok ?? false,
    httpStatus: r?.httpStatus ?? null,
    error: r?.error ?? null,
    durationMs: r?.durationMs ?? null,
    runId: outcome.runId,
  };
}

function testBody(format: string, s: Row, original: string, now: Date): Record<string, unknown> {
  const text = `Test delivery from the schedule "${s.name}". If you can read this, the webhook works.`;
  const o = JSON.parse(original) as Record<string, unknown>;
  if (format === 'slack') return { ...o, text };
  if (format === 'teams') return { ...o, text };
  return { ...o, event: 'schedule.test', text, at: now.toISOString() };
}

/** The run history of a schedule (newest first) with the delivery log of each. */
export async function listRuns(
  ctx: Ctx,
  userId: string,
  scheduleId: string,
  limit = 50,
): Promise<ScheduleRunDto[]> {
  await getScheduleDto(ctx.pool, userId, scheduleId);
  const list = await rows(
    ctx.pool,
    `SELECT * FROM schedule_runs WHERE schedule_id=$1 ORDER BY started_at DESC, id DESC LIMIT $2`,
    [scheduleId, limit],
  );
  const attempts = await attemptsOf(
    ctx.pool,
    list.map((r) => r.id),
  );
  return list.map((r) => {
    const d = r.delivery as { kind: 'webhook' | 'email'; url?: string; to?: string[] } | null;
    return {
      id: r.id,
      scheduleId: r.schedule_id,
      trigger: r.trigger,
      label: r.label ?? null,
      status: r.status,
      summary: r.summary,
      error: r.error ?? null,
      result: r.result ?? null,
      delivery: d
        ? { kind: d.kind, target: d.kind === 'webhook' ? (d.url as string) : (d.to ?? []).join(', ') }
        : null,
      attempts: r.attempts,
      nextAttemptAt: iso(r.next_attempt_at),
      startedAt: iso(r.started_at) as string,
      finishedAt: iso(r.finished_at),
      attemptLog: attempts
        .filter((a) => a.run_id === r.id)
        .map((a) => ({
          attempt: a.attempt,
          at: iso(a.at) as string,
          ok: a.ok,
          httpStatus: a.http_status ?? null,
          error: a.error ?? null,
          durationMs: a.duration_ms ?? null,
        })),
    };
  });
}

// ----------------------------------------------------------------------------------- the cron sweep

export interface FiredSchedule {
  scheduleId: string;
  cardId?: string;
}

/**
 * Fires every due schedule once (`next_fire_at <= now`): the action runs, the run is recorded and `ScheduleFired`
 * moves the next fire to strictly after now, in one append, so fires missed while the server was down happen once, not
 * N times. A labelled-issue trigger does not run its action: it asks the workstation for the labelled issues
 * (`integration.run`); the answer runs the action once per new issue. Safe to call from several processes (row locks,
 * SKIP LOCKED).
 */
export async function fireDueSchedules(ctx: Ctx): Promise<FiredSchedule[]> {
  const fired: FiredSchedule[] = [];
  const now = ctx.clock.now();
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM schedules WHERE enabled AND next_fire_at <= $1
        AND COALESCE(trigger->>'kind','cron') IN ('cron','issue_labelled') ORDER BY next_fire_at, id LIMIT 20`,
    [now],
  );
  for (const { id } of due) {
    try {
      const r = await withAppendTx(ctx.pool, async (tx) => {
        const s = await one(
          tx,
          `SELECT * FROM schedules WHERE id=$1 AND enabled AND next_fire_at <= $2 FOR UPDATE SKIP LOCKED`,
          [id, now],
        );
        if (!s?.action) return null;
        const project = s.project_id
          ? await one(tx, 'SELECT * FROM projects WHERE id=$1', [s.project_id])
          : null;
        const firedFor = new Date(s.next_fire_at);
        const next = nextFireAfter(s.cron, s.timezone, now);
        // An archived project's schedules stop firing but keep their place.
        if (s.project_id && (!project || project.status !== 'active')) return null;
        // A suspended or cancelled organization starts nothing (docs/design/organizations.md section 7.2); a switched-off
        // feature stops its own schedules. The fire is skipped and recorded, the cron moves on.
        const org = await one(tx, 'SELECT status, plan, features FROM organizations WHERE id=$1', [s.org_id]);
        // A project an Owner or Admin paused by hand starts nothing: the firing is skipped and recorded, the cron moves on
        // (no catch-up when it is resumed).
        const skip =
          org && !isOrgOperational(org.status)
            ? ('org_suspended' as const)
            : project?.paused_at
              ? ('project_paused' as const)
              : null;
        if (skip) {
          await ctx.store.append(
            [
              {
                streamId: streamId.schedule(s.id),
                event: {
                  type: 'ScheduleSkipped',
                  payload: {
                    scheduleId: s.id,
                    firedFor: firedFor.toISOString(),
                    nextFireAt: next?.toISOString() ?? null,
                    reason: skip,
                  },
                },
                actor: SYSTEM_ACTOR,
                scope: scheduleScope(s),
              },
            ],
            { tx },
          );
          return null;
        }
        await assertOwnerStillAllowed(tx, s);
        const trigger = (s.trigger ?? { kind: 'cron' }) as ScheduleTrigger;
        const fire = (cardId?: string, runId?: string): AppendInput => ({
          streamId: streamId.schedule(s.id),
          event: {
            type: 'ScheduleFired',
            payload: {
              scheduleId: s.id,
              ...(cardId ? { cardId } : {}),
              ...(runId ? { runId } : {}),
              firedFor: firedFor.toISOString(),
              nextFireAt: next?.toISOString() ?? null,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: scheduleScope(s),
        });
        if (trigger.kind === 'issue_labelled') {
          const { enqueueRunnerCommand } = await import('../runner-gateway/commands-queue.ts');
          await enqueueRunnerCommand(tx, trigger.workstationId, 'integration.run', {
            scheduleId: s.id,
            integration: trigger.provider,
            query: trigger.query,
            label: trigger.label,
            limit: 30,
          });
          await ctx.store.append([...(await resolveFailureNotice(tx, s)), fire()], { tx });
          return {
            scheduleId: s.id as string,
            after: [() => ctx.services.gateway.deliverPending(trigger.workstationId)],
          };
        }
        const spec: RunSpec = {
          trigger: 'cron',
          label: `scheduled for ${dayIn(firedFor, s.timezone ?? 'UTC')}`,
          firedFor,
        };
        const o = await executeAction(ctx, tx, s, spec);
        const cardId = o.result?.cardIds?.[0];
        await ctx.store.append(
          [
            ...o.events,
            ...(await resolveFailureNotice(tx, s)),
            runRecordedEvent(s, o, spec, now),
            fire(cardId, o.runId),
          ],
          { tx },
        );
        return { scheduleId: s.id as string, ...(cardId ? { cardId } : {}), outcome: o };
      });
      if (r) {
        fired.push({ scheduleId: r.scheduleId, ...('cardId' in r && r.cardId ? { cardId: r.cardId } : {}) });
        if ('outcome' in r && r.outcome) await afterRun(ctx, r.outcome);
        if ('after' in r && r.after) for (const f of r.after) await f().catch(() => {});
      }
    } catch (err) {
      ctx.log.error({ err, scheduleId: id }, 'schedule failed to fire');
      await recordFireFailure(ctx, id, err, now).catch((e2) =>
        ctx.log.error({ err: e2, scheduleId: id }, 'could not record the schedule failure'),
      );
    }
  }
  if (fired.length) ctx.services.dispatcher.trigger();
  return fired;
}

/** An action runs as the schedule's owner: it stops (with a notice) when they lose access to its project. */
export async function assertOwnerStillAllowed(tx: Tx, s: Row): Promise<void> {
  if (!s.owner_user_id) return; // written before owners were recorded
  const u = await one(tx, `SELECT status FROM users WHERE id=$1`, [s.owner_user_id]);
  if (!u || u.status !== 'active')
    throw conflict('owner_inactive', "the schedule's owner is no longer active");
  if (s.project_id) {
    const m = await one(
      tx,
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
      [s.project_id, s.owner_user_id],
    );
    if (!m)
      throw conflict(
        'owner_left',
        "the schedule's owner no longer has access to its project: change the owner by saving it again",
      );
  } else if (!(await orgRoleOf(tx, s.owner_user_id, s.org_id)))
    throw conflict('owner_left', "the schedule's owner has left the organization");
}

/** A fire that works again closes the desk notice its earlier failures raised. */
async function resolveFailureNotice(tx: Tx, s: Row): Promise<AppendInput[]> {
  if (!s.failure_desk_item_id) return [];
  const open = await one(tx, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [
    s.failure_desk_item_id,
  ]);
  if (!open) return [];
  return [
    {
      streamId: streamId.desk(s.failure_desk_item_id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: s.failure_desk_item_id,
          resolution: 'acknowledged',
          note: 'The schedule fired again.',
          by: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: scheduleScope(s),
    },
  ];
}

/**
 * A schedule that cannot run its action (a regression schedule on a project without a repo, say) must not be retried
 * on every tick: back off (1 min doubling to 6 h) and raise one desk notice for the whole streak. The next fire time
 * moves to the retry time; a successful fire (or an edit of the schedule) resets the streak.
 */
async function recordFireFailure(ctx: Ctx, id: string, err: unknown, now: Date): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const s = await one(
      tx,
      `SELECT * FROM schedules WHERE id=$1 AND enabled AND next_fire_at <= $2 FOR UPDATE SKIP LOCKED`,
      [id, now],
    );
    if (!s) return;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const attempts = Number(s.fail_count ?? 0) + 1;
    const nextFireAt = new Date(now.getTime() + scheduleBackoffMs(attempts));
    const noticeOpen = s.failure_desk_item_id
      ? await one(tx, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [s.failure_desk_item_id])
      : undefined;
    const deskItemId = noticeOpen ? undefined : randomUUID();
    const scope = scheduleScope(s);
    const events: AppendInput[] = [
      {
        streamId: streamId.schedule(id),
        event: {
          type: 'ScheduleFireFailed',
          payload: {
            scheduleId: id,
            error: message,
            attempts,
            nextFireAt: nextFireAt.toISOString(),
            ...(deskItemId ? { deskItemId } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
      // The history shows the failed run as well (a cron fire that could not happen).
      failedRun(randomUUID(), s, { trigger: 'cron', firedFor: now, label: 'scheduled' }, message),
    ];
    if (deskItemId) {
      events.push({
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: HR_DESK_SUBKIND.scheduleFailed,
            title: `Schedule "${s.name}" cannot run`,
            body: `${message}\n\nThe schedule keeps trying with growing pauses (next try ${nextFireAt.toISOString()}). Fix the cause or disable the schedule; this notice closes when it fires again.`,
            blocking: false,
            pinned: false,
            options: [],
            ...(s.project_id ? { projectId: s.project_id } : {}),
            affectedCardIds: [],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      });
    }
    await ctx.store.append(events, { tx });
  });
}
