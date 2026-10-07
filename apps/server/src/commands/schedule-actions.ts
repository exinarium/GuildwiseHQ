import { randomUUID } from 'node:crypto';
import {
  type CardTemplate,
  cardRef,
  DEFAULT_CARD_PRIORITY,
  type ExpandContext,
  emptyFields,
  expandText,
  expandTitle,
  FEED_FIELD_DEFAULTS,
  isEmailAction,
  isoWeek,
  isPollAction,
  isWebhookAction,
  parseCardFields,
  RegressionPlatform,
  type ScheduleAction,
  type ScheduleDelivery,
  type ScheduleRunResult,
  type ScheduleRunTrigger,
  streamId,
  type WebhookData,
  webhookBody,
} from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { decryptSecret } from '../auth/secrets.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { badRequest, conflict } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { carrierProject } from '../reporter/tasks.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { resolveCardWorkflow, specifyTarget } from './cards.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { createDevOpsRequestIn } from './devops.ts';
import { requestHygiene } from './hygiene.ts';
import { regressionRunEvents } from './regression.ts';
import { buildDigest } from './schedule-digest.ts';

/** `YYYY-MM-DD` of `at` in `timezone`: scheduled cards carry the day in their title. */
export const dayIn = (at: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at);

export const scheduleScope = (s: Row) =>
  s.project_id ? projectScope(s.org_id, s.project_id) : orgScope(s.org_id);

/**
 * The `CardCreated` for a scheduled run: queued at the workflow's first agent stage, `scheduled` so it jumps the
 * queue for its role (docs/SPEC.md scheduling rule 1). Runs inside the caller's append transaction (the card number
 * is taken under the project row lock).
 */
export async function scheduledCard(
  tx: Tx,
  project: Row,
  template: CardTemplate,
  scheduleId: string | undefined,
  title: string,
  interestId?: string | null,
): Promise<{ cardId: string; ref: string; event: AppendInput }> {
  const projectWf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!projectWf) throw badRequest('unknown_workflow', `workflow '${project.workflow_key}' is not available`);
  const cardType = template.cardType ?? projectWf.definition.cardTypes[0];
  if (!cardType) throw badRequest('invalid_card_type', 'the workflow has no card types');
  const wf = await resolveCardWorkflow(tx, project, cardType);
  if (!wf)
    throw badRequest(
      'invalid_card_type',
      `card type '${cardType}' is not allowed in workflow '${projectWf.definition.key}'`,
    );
  const def = wf.definition;
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
          ownerUserId: await orgOwnerId(tx, project.org_id),
          origin: 'schedule',
          scheduled: true,
          ...(scheduleId ? { scheduleId } : {}),
          ...(interestId ? { interestId } : {}),
          priority: template.priority ?? DEFAULT_CARD_PRIORITY,
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

/** Where a run came from, for the text expansion and the history. */
export interface RunSpec {
  trigger: ScheduleRunTrigger;
  /** A source runs a schedule once (an event's seq, `issue:github:owner/repo#1`). */
  sourceKey?: string;
  label?: string;
  firedFor: Date;
  /** The user who pressed "Run now" or "Test". */
  byUserId?: string;
  /** Placeholders: the event name, the card or phase ref, the project key, the issue. */
  text?: Partial<ExpandContext>;
  /** Structured details the webhook carries. */
  details?: Record<string, unknown>;
}

export interface RunOutcome {
  runId: string;
  /** Events the action wants appended with the run record (the action may also have appended its own). */
  events: AppendInput[];
  status: 'ok' | 'failed' | 'pending';
  summary: string;
  result?: ScheduleRunResult;
  delivery?: ScheduleDelivery;
  error?: string;
  /** After the transaction commits: wake the dispatcher, deliver runner commands, make a delivery. */
  after: Array<() => Promise<void>>;
}

const SYSTEM_BY = (s: Row) => ({ kind: 'system' as const, id: null, name: `Schedule "${s.name}"` });

export async function ownerTimezone(db: Tx, s: Row): Promise<string> {
  if (s.timezone) return s.timezone as string;
  const u = s.owner_user_id
    ? await one(db, 'SELECT timezone FROM users WHERE id=$1', [s.owner_user_id])
    : undefined;
  return (u?.timezone as string | null | undefined) ?? 'UTC';
}

/**
 * Runs the action of schedule `s` inside the caller's append transaction: the action's own events are appended here,
 * and the outcome says what the run record should say. Deliveries (webhook, e-mail) and runner commands are not
 * performed in the transaction: they come back as `delivery` / `after`.
 */
export async function executeAction(ctx: Ctx, tx: Tx, s: Row, spec: RunSpec): Promise<RunOutcome> {
  const action = s.action as ScheduleAction | null;
  if (!action) throw conflict('no_action', 'this schedule has no action');
  const runId = randomUUID();
  const tz = await ownerTimezone(tx, s);
  const date = dayIn(spec.firedFor, tz);
  const project = s.project_id
    ? await one(tx, 'SELECT * FROM projects WHERE id=$1', [s.project_id])
    : undefined;
  const text: ExpandContext = {
    date,
    week: isoWeek(date),
    ...(project ? { project: project.key } : {}),
    ...spec.text,
  };
  const base = { runId, events: [] as AppendInput[], after: [] as RunOutcome['after'] };

  if (action.kind === 'create_card') {
    if (!project) throw conflict('project_gone', 'the project of this schedule is gone');
    const card = await scheduledCard(
      tx,
      project,
      action.template,
      s.id,
      expandTitle(action.template.title, text),
      s.interest_id,
    );
    return {
      ...base,
      events: [card.event],
      status: 'ok',
      summary: `Created ${card.ref}`,
      result: { cardIds: [card.cardId] },
      after: [async () => ctx.services.dispatcher.trigger()],
    };
  }

  if (action.kind === 'regression_run') {
    if (!project) throw conflict('project_gone', 'the project of this schedule is gone');
    const owner = await one(
      tx,
      `SELECT user_id FROM project_members WHERE project_id=$1 AND role='owner' AND status='active' LIMIT 1`,
      [project.id],
    );
    const ownerId = (owner?.user_id ?? (await orgOwnerId(tx, project.org_id))) as string;
    const platform = RegressionPlatform.parse(action.template.fields.platform ?? 'web');
    const run = await regressionRunEvents(tx, project, {
      platform,
      ownerUserId: ownerId,
      requestedBy: ownerId,
      actor: SYSTEM_ACTOR,
      scheduled: true,
      startedBy: `schedule "${s.name}"`,
    });
    const cards = run.cards as Array<{ id: string; ref?: string }>;
    return {
      ...base,
      events: run.events,
      status: 'ok',
      summary: `Started a regression run (${cards.map((c) => c.ref ?? c.id).join(', ')})`,
      result: { cardIds: cards.map((c) => c.id) },
      after: [async () => ctx.services.dispatcher.trigger()],
    };
  }

  if (action.kind === 'devops_request') {
    const ws = await one(tx, `SELECT id FROM workstations WHERE id=$1 AND status='active'`, [
      action.workstationId,
    ]);
    if (!ws) throw conflict('workstation_gone', 'the workstation of this schedule is gone');
    const wsId = action.workstationId;
    const deliver = async () => {
      ctx.services.dispatcher.trigger();
      await ctx.services.gateway.deliverPending(wsId);
    };
    if (action.hygiene) {
      const r = await requestHygiene(ctx, tx, {
        workstationId: wsId,
        trigger: 'schedule',
        requestedBy: SYSTEM_BY(s),
      });
      if (!r)
        return {
          ...base,
          status: 'ok',
          summary: 'Nothing to tidy: the workstation holds no project repository',
        };
      return {
        ...base,
        status: 'ok',
        summary: r.alreadyRunning ? 'A hygiene run is already open' : 'Requested a repository hygiene run',
        result: { devopsRequestId: r.requestId },
        after: r.alreadyRunning ? [] : [deliver],
      };
    }
    const summary = expandText(action.text, text).trim();
    if (!summary) throw badRequest('empty_request', 'the DevOps request has no text');
    const r = await createDevOpsRequestIn(ctx, tx, {
      workstationId: wsId,
      summary,
      requestedBy: SYSTEM_BY(s),
      orgId: s.org_id,
    });
    return {
      ...base,
      status: 'ok',
      summary: 'Sent a request to the DevOps engineer',
      result: { devopsRequestId: r.requestId },
      after: [deliver],
    };
  }

  if (action.kind === 'ba_task') {
    const projectId = await carrierProject(tx, s.org_id, action.projectId);
    if (!projectId)
      throw conflict('no_project', 'the organization has no active project to file the task under');
    const taskId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.baTask(taskId),
          event: {
            type: 'BaTaskQueued',
            payload: {
              taskId,
              projectId,
              kind: 'scheduled_brief',
              instructions: expandText(action.prompt, text),
              deliver: action.deliver,
              scheduleId: s.id,
              scheduleName: s.name,
              ...(action.projectId ? {} : { orgLevel: true }),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(s.org_id, projectId),
        },
      ],
      { tx },
    );
    return {
      ...base,
      status: 'ok',
      summary: 'Asked the BA',
      result: { baTaskId: taskId },
      after: [async () => ctx.services.dispatcher.trigger()],
    };
  }

  // integration
  if (isPollAction(action)) {
    await enqueueRunnerCommand(tx, action.workstationId, 'integration.run', {
      scheduleId: s.id,
      runId,
      integration: action.integration,
      query: action.query,
      limit: 30,
    });
    const wsId = action.workstationId;
    return {
      ...base,
      status: 'pending',
      summary: `Polling ${action.integration === 'github' ? 'GitHub' : 'Jira'} on the workstation`,
      after: [async () => ctx.services.gateway.deliverPending(wsId)],
    };
  }

  if (isWebhookAction(action)) {
    const message = expandText(action.message, text).trim();
    let body = message || `${s.name}: ${spec.label ?? spec.trigger}`;
    if (action.digest) {
      const d = await buildDigest(ctx, tx, action.digest, {
        orgId: s.org_id,
        projectId: action.projectId ?? null,
        now: spec.firedFor,
      });
      body = `${body}\n\n${d.text}`;
    }
    const data: WebhookData = {
      scheduleId: s.id,
      scheduleName: s.name,
      trigger: spec.trigger,
      at: spec.firedFor.toISOString(),
      text: body,
      ...(spec.details ? { details: spec.details } : {}),
    };
    return {
      ...base,
      status: 'pending',
      summary: `Webhook to ${hostOf(action.url)}`,
      delivery: {
        kind: 'webhook',
        url: action.url,
        body: JSON.stringify(webhookBody(action.format, data)),
        event: spec.trigger === 'test' ? 'schedule.test' : 'schedule.run',
      },
    };
  }

  // e-mail digest
  if (!isEmailAction(action)) throw conflict('unknown_action', 'unknown integration');
  const d = await buildDigest(ctx, tx, action.digest, {
    orgId: s.org_id,
    projectId: action.projectId ?? null,
    now: spec.firedFor,
  });
  return {
    ...base,
    status: 'pending',
    summary: `E-mail to ${action.to.join(', ')}`,
    delivery: {
      kind: 'email',
      to: action.to,
      subject: expandText(action.subject, text).trim() || d.subject,
      text: d.text,
    },
  };
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The `ScheduleRunRecorded` event of an outcome. */
export function runRecordedEvent(s: Row, o: RunOutcome, spec: RunSpec, now: Date): AppendInput {
  return {
    streamId: streamId.schedule(s.id),
    event: {
      type: 'ScheduleRunRecorded',
      payload: {
        runId: o.runId,
        scheduleId: s.id,
        trigger: spec.trigger,
        ...(spec.sourceKey ? { sourceKey: spec.sourceKey } : {}),
        ...(spec.label ? { label: spec.label } : {}),
        status: o.status,
        summary: o.summary,
        ...(o.result ? { result: o.result } : {}),
        ...(o.error ? { error: o.error } : {}),
        ...(o.delivery ? { delivery: o.delivery, nextAttemptAt: now.toISOString() } : {}),
      },
    },
    actor: spec.byUserId ? userActor(spec.byUserId) : SYSTEM_ACTOR,
    scope: scheduleScope(s),
  };
}

/** A failed run record (the action threw before it could do anything): the history shows why. */
export function failedRun(runId: string, s: Row, spec: RunSpec, error: string): AppendInput {
  return runRecordedEvent(
    s,
    { runId, events: [], status: 'failed', summary: 'Could not run', error: error.slice(0, 1900), after: [] },
    spec,
    spec.firedFor,
  );
}

/** Decrypts the signing secret of a webhook action. */
export async function webhookSecret(ctx: Ctx, action: ScheduleAction): Promise<string | null> {
  if (!isWebhookAction(action) || !action.secretEnc) return null;
  return decryptSecret(ctx, action.secretEnc);
}
