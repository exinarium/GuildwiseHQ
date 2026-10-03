import { randomUUID } from 'node:crypto';
import {
  type CardTemplate,
  type CreateScheduleRequest,
  cardRef,
  emptyFields,
  FEED_FIELD_DEFAULTS,
  type PatchScheduleRequest,
  parseCardFields,
  type ScheduleDto,
  streamId,
} from '@aom/shared';
import { CronExpressionParser } from 'cron-parser';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { specifyTarget } from './cards.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

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

const toDto = (r: Row): ScheduleDto => ({
  id: r.id,
  projectId: r.project_id,
  projectKey: r.project_key,
  projectName: r.project_name,
  name: r.name,
  kind: r.kind,
  cron: r.cron,
  timezone: r.timezone,
  cardTemplate: r.card_template,
  enabled: r.enabled,
  nextFireAt: iso(r.next_fire_at),
  lastFiredAt: iso(r.last_fired_at),
  lastCardId: r.last_card_id,
  createdAt: iso(r.created_at) as string,
});

const SELECT = `SELECT s.*, p.key AS project_key, p.name AS project_name FROM schedules s JOIN projects p ON p.id = s.project_id`;
const VISIBLE = `s.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active')`;

export async function listSchedules(
  db: Queryable,
  userId: string,
  projectId?: string,
): Promise<ScheduleDto[]> {
  const r = await rows(
    db,
    `${SELECT} WHERE ${VISIBLE} AND ($2::uuid IS NULL OR s.project_id = $2) ORDER BY p.key, s.created_at, s.id`,
    [userId, projectId ?? null],
  );
  return r.map(toDto);
}

export async function getScheduleDto(db: Queryable, userId: string, id: string): Promise<ScheduleDto> {
  const r = await one(db, `${SELECT} WHERE ${VISIBLE} AND s.id = $2`, [userId, id]);
  if (!r) throw notFound('schedule not found');
  return toDto(r);
}

/** Validates a template against the project's workflow field set (a bad feed template must fail now, not at 07:00). */
async function checkTemplate(tx: Queryable, project: Row, kind: string, template: CardTemplate) {
  const wf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!wf) throw badRequest('unknown_workflow', `workflow '${project.workflow_key}' is not available`);
  if (kind === 'feed' && wf.definition.fieldSet !== 'feed')
    throw badRequest('not_a_feed_project', 'feed schedules need a project with the feed workflow');
  const cardType = template.cardType ?? wf.definition.cardTypes[0];
  if (!cardType || !wf.definition.cardTypes.includes(cardType))
    throw badRequest(
      'invalid_card_type',
      `card type '${cardType}' is not allowed in workflow '${wf.definition.key}'`,
    );
  const parsed = parseCardFields(wf.definition.fieldSet, {
    ...emptyFields(wf.definition.fieldSet),
    ...template.fields,
  });
  if (!parsed.success) throw badRequest('invalid_fields', 'card fields are invalid', parsed.error.issues);
}

export async function createSchedule(
  ctx: Ctx,
  user: AuthSession['user'],
  req: CreateScheduleRequest,
): Promise<string> {
  assertCronAndZone(req.cron, req.timezone);
  return withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, req.projectId);
    if (project.my_role !== 'owner') throw forbidden('only the project owner can manage schedules');
    if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
    await checkTemplate(tx, project, req.kind, req.cardTemplate);
    const scheduleId = randomUUID();
    const next = req.enabled ? nextFireAfter(req.cron, req.timezone, ctx.clock.now()) : null;
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(scheduleId),
          event: {
            type: 'ScheduleCreated',
            payload: {
              scheduleId,
              projectId: project.id,
              name: req.name,
              kind: req.kind,
              cron: req.cron.trim(),
              timezone: req.timezone,
              cardTemplate: req.cardTemplate,
              enabled: req.enabled,
              nextFireAt: next?.toISOString() ?? null,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, project.id),
        },
      ],
      { tx },
    );
    return scheduleId;
  });
}

async function lockOwned(tx: Tx, user: AuthSession['user'], id: string): Promise<{ s: Row; project: Row }> {
  const s = await one(tx, 'SELECT * FROM schedules WHERE id=$1 FOR UPDATE', [id]);
  if (!s) throw notFound('schedule not found');
  const project = await loadVisibleProject(tx, user.id, s.project_id);
  if (project.my_role !== 'owner') throw forbidden('only the project owner can manage schedules');
  return { s, project };
}

export async function patchSchedule(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  patch: PatchScheduleRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { s, project } = await lockOwned(tx, user, id);
    const next = {
      name: patch.name ?? s.name,
      cron: (patch.cron ?? s.cron).trim(),
      timezone: patch.timezone ?? s.timezone,
      cardTemplate: (patch.cardTemplate ?? s.card_template) as CardTemplate,
      enabled: patch.enabled ?? s.enabled,
    };
    assertCronAndZone(next.cron, next.timezone);
    if (patch.cardTemplate) await checkTemplate(tx, project, s.kind, next.cardTemplate);
    // A changed cron/zone, or re-enabling, recomputes the next fire; otherwise the pending fire is kept.
    const reschedule =
      patch.cron !== undefined || patch.timezone !== undefined || (patch.enabled && !s.enabled);
    const nextFireAt = !next.enabled
      ? null
      : reschedule || !s.next_fire_at
        ? (nextFireAfter(next.cron, next.timezone, ctx.clock.now())?.toISOString() ?? null)
        : (iso(s.next_fire_at) as string);
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(id),
          event: {
            type: 'ScheduleUpdated',
            payload: {
              scheduleId: id,
              projectId: s.project_id,
              kind: s.kind,
              ...next,
              nextFireAt,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, project.id),
        },
      ],
      { tx },
    );
  });
}

export async function deleteSchedule(ctx: Ctx, user: AuthSession['user'], id: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { s, project } = await lockOwned(tx, user, id);
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(id),
          event: { type: 'ScheduleDeleted', payload: { scheduleId: s.id } },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, project.id),
        },
      ],
      { tx },
    );
  });
}

/** `YYYY-MM-DD` of `at` in `timezone`: scheduled cards carry the day in their title. */
const dayIn = (at: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at);

/**
 * The `CardCreated` for a scheduled run: queued at the workflow's first agent stage, `scheduled` so it jumps the
 * queue for its role (docs/SPEC.md scheduling rule 1). Runs inside the caller's append transaction (the card number
 * is taken under the project row lock).
 */
async function scheduledCard(
  tx: Tx,
  project: Row,
  template: CardTemplate,
  scheduleId: string | undefined,
  title: string,
): Promise<{ cardId: string; ref: string; event: AppendInput }> {
  const wf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!wf) throw badRequest('unknown_workflow', `workflow '${project.workflow_key}' is not available`);
  const def = wf.definition;
  const cardType = template.cardType ?? def.cardTypes[0];
  if (!cardType) throw badRequest('invalid_card_type', 'the workflow has no card types');
  const defaults = def.fieldSet === 'feed' ? { ...FEED_FIELD_DEFAULTS } : {};
  const parsed = parseCardFields(def.fieldSet, {
    ...emptyFields(def.fieldSet),
    ...defaults,
    ...template.fields,
  });
  if (!parsed.success) throw badRequest('invalid_fields', 'card fields are invalid', parsed.error.issues);
  const number = Number(
    (await one(tx, 'SELECT next_card_number FROM projects WHERE id=$1 FOR UPDATE', [project.id]))
      ?.next_card_number,
  );
  const cardId = randomUUID();
  const ref = cardRef(project.key, number);
  return {
    cardId,
    ref,
    event: {
      streamId: streamId.card(cardId),
      event: {
        type: 'CardCreated',
        payload: {
          cardId,
          projectId: project.id,
          number,
          ref,
          title,
          cardType: cardType as never,
          workflowVersionId: wf.id,
          stage: specifyTarget(def).to,
          status: 'queued',
          fields: parsed.data,
          ownerUserId: project.org_id,
          origin: 'schedule',
          scheduled: true,
          ...(scheduleId ? { scheduleId } : {}),
          priority: template.priority ?? 2,
          docsNeeded: false,
          dependencies: [],
          requiredCapabilities: [],
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(project.org_id, project.id),
    },
  };
}

/**
 * Fires every due schedule once (`next_fire_at <= now`): `ScheduleFired` + the scheduled card in one append, with the
 * next fire computed strictly after now, so fires missed while the server was down happen once, not N times.
 * Returns the cards it created. Safe to call from several processes (row locks, SKIP LOCKED).
 */
export async function fireDueSchedules(ctx: Ctx): Promise<Array<{ scheduleId: string; cardId: string }>> {
  const fired: Array<{ scheduleId: string; cardId: string }> = [];
  const now = ctx.clock.now();
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM schedules WHERE enabled AND next_fire_at <= $1 ORDER BY next_fire_at, id LIMIT 20`,
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
        if (!s) return null;
        const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [s.project_id]);
        const firedFor = new Date(s.next_fire_at);
        const next = nextFireAfter(s.cron, s.timezone, now);
        if (!project || project.status !== 'active') {
          // An archived project's schedules stop firing but keep their place.
          return null;
        }
        const template = s.card_template as CardTemplate;
        const card = await scheduledCard(
          tx,
          project,
          template,
          s.id,
          `${template.title} (${dayIn(firedFor, s.timezone)})`,
        );
        await ctx.store.append(
          [
            card.event,
            {
              streamId: streamId.schedule(s.id),
              event: {
                type: 'ScheduleFired',
                payload: {
                  scheduleId: s.id,
                  cardId: card.cardId,
                  firedFor: firedFor.toISOString(),
                  nextFireAt: next?.toISOString() ?? null,
                },
              },
              actor: SYSTEM_ACTOR,
              scope: projectScope(project.org_id, project.id),
            },
          ],
          { tx },
        );
        return { scheduleId: s.id as string, cardId: card.cardId };
      });
      if (r) fired.push(r);
    } catch (err) {
      ctx.log.error({ err, scheduleId: id }, 'schedule failed to fire');
    }
  }
  if (fired.length) ctx.services.dispatcher.trigger();
  return fired;
}

/** Default template for "Run now" on a feed project without a schedule. */
const defaultFeedTemplate = (project: Row): CardTemplate => ({
  title: `${project.name} feed`,
  cardType: 'feed',
  fields: { topic: project.name },
});

/**
 * "Run now" from the board: the same scheduled-card path as a due schedule (`FeedRunRequested` + `CardCreated`).
 * With a schedule, its template is used and its own timing is not touched; for a feed project without schedules a
 * default template (topic = project name) is used.
 */
export async function runFeedNow(
  ctx: Ctx,
  user: AuthSession['user'],
  target: { projectId?: string; scheduleId?: string },
): Promise<{ cardId: string; ref: string }> {
  const r = await withAppendTx(ctx.pool, async (tx) => {
    let schedule: Row | undefined;
    if (target.scheduleId) {
      schedule = await one(tx, 'SELECT * FROM schedules WHERE id=$1', [target.scheduleId]);
      if (!schedule) throw notFound('schedule not found');
    }
    const projectId = schedule?.project_id ?? target.projectId;
    if (!projectId) throw badRequest('missing_target', 'a project or schedule is required');
    const project = await loadVisibleProject(tx, user.id, projectId);
    if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
    if (!schedule && target.projectId) {
      schedule = await one(
        tx,
        `SELECT * FROM schedules WHERE project_id=$1 AND kind='feed' ORDER BY enabled DESC, created_at LIMIT 1`,
        [project.id],
      );
    }
    const wf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
    if (!schedule && wf?.definition.fieldSet !== 'feed')
      throw badRequest('not_a_feed_project', 'this project has no feed to run');
    const template = (schedule?.card_template as CardTemplate | undefined) ?? defaultFeedTemplate(project);
    const now = ctx.clock.now();
    const timezone = (schedule?.timezone as string | undefined) ?? 'UTC';
    const card = await scheduledCard(
      tx,
      project,
      template,
      schedule?.id,
      `${template.title} (run now ${dayIn(now, timezone)} ${now.toISOString().slice(11, 16)}Z)`,
    );
    await ctx.store.append(
      [
        card.event,
        {
          streamId: streamId.card(card.cardId),
          event: {
            type: 'FeedRunRequested',
            payload: {
              projectId: project.id,
              ...(schedule ? { scheduleId: schedule.id } : {}),
              cardId: card.cardId,
              requestedBy: user.id,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, project.id),
        },
      ],
      { tx },
    );
    return { cardId: card.cardId, ref: card.ref };
  });
  ctx.services.dispatcher.trigger();
  return r;
}
