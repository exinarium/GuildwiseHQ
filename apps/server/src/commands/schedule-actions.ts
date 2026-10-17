import { randomUUID } from 'node:crypto';
import {
  type CardTemplate,
  cardRef,
  DEFAULT_CARD_PRIORITY,
  type ExpandContext,
  emptyFields,
  expandMapping,
  expandText,
  expandTitle,
  FEED_FIELD_DEFAULTS,
  HR_DESK_SUBKIND,
  isEmailAction,
  isoWeek,
  isPollAction,
  isWebhookAction,
  normaliseSubject,
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
import { singleRepoDefault } from './card-repo.ts';
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
  /** An interest run: the run id, the soft preference for agents, and the `interest` origin. */
  extra: {
    interestRunId?: string;
    preferredAgents?: Record<string, string>;
    origin?: 'schedule' | 'interest' | 'trigger' | 'email';
    /** `draft`: the card waits in Specify for the BA or the owner (drafts are never scheduled to jump the queue). */
    start?: 'draft' | 'queued';
    /** Values written over `template.fields` (a field mapping). */
    fields?: Record<string, unknown>;
  } = {},
): Promise<{ cardId: string; ref: string; event: AppendInput }> {
  const projectWf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!projectWf) throw badRequest('unknown_workflow', `workflow '${project.workflow_key}' is not available`);
  const cardType = template.cardType ?? projectWf.definition.cardTypes[0];
  if (!cardType) throw badRequest('invalid_card_type', 'the workflow has no card types');
  const wf = await resolveCardWorkflow(tx, project, cardType, template.workflowKey);
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
    ...extra.fields,
  });
  if (!parsed.success) throw badRequest('invalid_fields', 'card fields are invalid', parsed.error.issues);
  const number = Number(
    (await one(tx, 'SELECT next_card_number FROM projects WHERE id=$1 FOR UPDATE', [project.id]))
      ?.next_card_number,
  );
  const cardId = randomUUID();
  const ref = cardRef(project.key, number);
  const repoId = await singleRepoDefault(tx, project.id, def);
  const draft = extra.start === 'draft';
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
          stage: draft
            ? def.initialStage
            : specifyTarget(def, { designNeeded: false, investigationOnly: false }).to,
          status: draft ? 'draft' : 'queued',
          fields: parsed.data,
          ownerUserId: await orgOwnerId(tx, project.org_id),
          ...(repoId ? { repoId } : {}),
          origin: extra.origin ?? 'schedule',
          scheduled: !draft,
          ...(scheduleId ? { scheduleId } : {}),
          ...(interestId ? { interestId } : {}),
          ...(extra.interestRunId ? { interestRunId: extra.interestRunId } : {}),
          ...(extra.preferredAgents ? { preferredAgents: extra.preferredAgents } : {}),
          priority: template.priority ?? DEFAULT_CARD_PRIORITY,
          docsNeeded: false,
          designNeeded: false,
          investigationOnly: false,
          dependencies: [],
          requiredCapabilities: [],
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(project.org_id, project.id),
    },
  };
}

/** An inbound message the trigger answers (docs/design/workflow-builder.md D9). */
export interface MailRunInfo {
  messageId: string;
  threadId: string;
  inboxId: string;
  from: string;
  subject: string;
  allowListed: boolean;
  auth: 'pass' | 'fail' | 'unknown';
}

/** Mapping tokens that carry text an outside sender wrote (the date and thread id are ours). */
const OUTSIDE_TOKEN = /\{(?:email\.(?:subject|body|from)|hook\.[A-Za-z0-9_.]+)\}/;

/** Which targets of a field mapping are filled from the sender's text: those fields and the title are untrusted. */
export function untrustedTargets(mapping: Record<string, string> | undefined): {
  fields: string[];
  title: boolean;
} {
  const fields: string[] = [];
  let title = false;
  for (const [target, template] of Object.entries(mapping ?? {})) {
    if (!OUTSIDE_TOKEN.test(template)) continue;
    if (target === 'title') title = true;
    else fields.push(target);
  }
  return { fields, title };
}

/** Where a run came from, for the text expansion and the history. */
export interface RunSpec {
  /** Inbound e-mail triggers: the message that started the run. */
  mail?: MailRunInfo;
  trigger: ScheduleRunTrigger;
  /** A source runs a schedule once (an event's seq, `issue:github:owner/repo#1`). */
  sourceKey?: string;
  label?: string;
  firedFor: Date;
  /** The user who pressed "Run now" or "Test". */
  byUserId?: string;
  /** Placeholders: the event name, the card or phase ref, the project key, the issue. */
  text?: Partial<ExpandContext>;
  /** Values of the `{tokens}` of a field mapping (`card.ref`, `issue.title`, `card.fields.x`, ...). */
  tokens?: Record<string, string | undefined>;
  /** Incoming webhook calls: the Owner's choice about queued cards (otherwise a card from a call is a draft). */
  hook?: { allowQueued: boolean };
  /** The thing the run answers (source card or intake id), for `dedupe: 'thread'`. */
  sourceId?: string;
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
  dedupeKey?: string;
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
    const t = action.template;
    const tokens: Record<string, string | undefined> = { event: spec.text?.event, date, ...spec.tokens };
    const mapped: Record<string, unknown> = {};
    let title = expandTitle(t.title, text);
    for (const [target, template] of Object.entries(t.mapping ?? {})) {
      const value = expandMapping(template, tokens);
      if (target === 'title') title = value.trim().slice(0, 300) || title;
      else mapped[target] = value;
    }
    // Event-triggered automations: one card per event, within a rate, without repeating a card for the same content.
    const fromEvent = spec.trigger === 'event' || spec.trigger === 'issue';
    const dedupeKey =
      action.dedupe === 'thread' && spec.sourceId
        ? `thread:${spec.sourceId}`
        : action.dedupe === 'subject_from'
          ? `subject_from:${normaliseSubject(tokens['email.subject'] ?? title)}|${(tokens['email.from'] ?? '').toLowerCase()}`
          : undefined;
    if (fromEvent && dedupeKey) {
      const prior = await one(
        tx,
        `SELECT result->'cardIds'->>0 AS card_id FROM schedule_runs
          WHERE schedule_id=$1 AND dedupe_key=$2 AND result->'cardIds' IS NOT NULL LIMIT 1`,
        [s.id, dedupeKey],
      );
      if (prior)
        return {
          ...base,
          status: 'ok',
          summary: 'Skipped: a card was already created for this',
          result: { cardIds: [] },
        };
    }
    if (spec.trigger === 'event') {
      const limit = action.ratePerHour ?? DEFAULT_RATE_PER_HOUR;
      const made = Number(
        (
          await one(
            tx,
            `SELECT count(*) AS n FROM schedule_runs
              WHERE schedule_id=$1 AND trigger='event' AND started_at > $2
                AND jsonb_array_length(COALESCE(result->'cardIds', '[]'::jsonb)) > 0`,
            [s.id, new Date(spec.firedFor.getTime() - 3_600_000)],
          )
        )?.n ?? 0,
      );
      if (made >= limit) return rateLimited(tx, s, spec, limit, base);
    }
    // A card made from e-mail is a draft unless the automation asks for it to be queued AND the sender is on the
    // Owner's allow-list AND the sender could be verified (an address in From can be forged).
    const mail = spec.mail;
    const hook = spec.hook;
    // A card from an incoming webhook is a draft too, unless the Owner allowed this hook to queue directly.
    const start = mail
      ? t.start === 'queued' && mail.allowListed && mail.auth === 'pass'
        ? 'queued'
        : 'draft'
      : hook
        ? t.start === 'queued' && hook.allowQueued
          ? 'queued'
          : 'draft'
        : t.start;
    const card = await scheduledCard(tx, project, t, s.id, title, s.interest_id, {
      ...(mail ? { origin: 'email' as const } : fromEvent ? { origin: 'trigger' as const } : {}),
      ...(start ? { start } : {}),
      ...(Object.keys(mapped).length ? { fields: mapped } : {}),
    });
    const events: AppendInput[] = [card.event];
    if (mail) {
      const untrusted = untrustedTargets(t.mapping);
      const linked = await tx.query(
        `UPDATE mail_threads SET card_id=$2, untrusted_fields=$3, untrusted_title=$4
          WHERE id=$1 AND card_id IS NULL`,
        [mail.threadId, card.cardId, untrusted.fields, untrusted.title],
      );
      await tx.query(`UPDATE mail_messages SET status=$2, card_id=$3 WHERE id=$1 AND status='received'`, [
        mail.messageId,
        start === 'draft' ? 'draft_created' : 'card_created',
        card.cardId,
      ]);
      if (linked.rowCount)
        events.push({
          streamId: streamId.mailInbox(mail.inboxId),
          event: {
            type: 'MailThreadLinked',
            payload: { threadId: mail.threadId, cardId: card.cardId, messageId: mail.messageId },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(s.org_id),
        });
    }
    if (hook) {
      // The fields filled from the payload are outside content: briefs render them in an untrusted block.
      const untrusted = untrustedTargets(t.mapping);
      await tx.query(
        `INSERT INTO card_untrusted (card_id, org_id, source, fields, title, created_at)
         VALUES ($1,$2,'webhook',$3,$4,$5) ON CONFLICT (card_id) DO NOTHING`,
        [card.cardId, s.org_id, untrusted.fields, untrusted.title, spec.firedFor],
      );
    }
    return {
      ...base,
      events,
      status: 'ok',
      summary: `Created ${card.ref}${start === 'draft' ? ' as a draft' : ''}${mail ? ' from an e-mail' : hook ? ' from a webhook call' : ''}`,
      result: { cardIds: [card.cardId] },
      ...(dedupeKey ? { dedupeKey } : {}),
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

export const DEFAULT_RATE_PER_HOUR = 20;

/**
 * More cards than `ratePerHour` in an hour: this one is not created. The run is recorded (so the event is not tried
 * again), a `ScheduleSkipped` says why, and one desk notice per hour tells the owner.
 */
async function rateLimited(
  tx: Tx,
  s: Row,
  spec: RunSpec,
  limit: number,
  base: Pick<RunOutcome, 'runId' | 'events' | 'after'>,
): Promise<RunOutcome> {
  const events: AppendInput[] = [
    {
      streamId: streamId.schedule(s.id),
      event: {
        type: 'ScheduleSkipped',
        payload: {
          scheduleId: s.id,
          firedFor: spec.firedFor.toISOString(),
          nextFireAt: null,
          reason: 'rate_limited',
        },
      },
      actor: SYSTEM_ACTOR,
      scope: scheduleScope(s),
    },
  ];
  const recent = await one(
    tx,
    `SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND summary LIKE 'Skipped: rate limit%' AND started_at > $2`,
    [s.id, new Date(spec.firedFor.getTime() - 3_600_000)],
  );
  if (!recent) {
    const deskItemId = randomUUID();
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: HR_DESK_SUBKIND.scheduleFailed,
          title: `Automation "${s.name}" is making too many cards`,
          body: `It reached its limit of ${limit} cards per hour, so further cards are skipped until the hour is over. Raise the limit on the automation, or check what keeps triggering it.`,
          blocking: false,
          pinned: false,
          options: [],
          ...(s.project_id ? { projectId: s.project_id } : {}),
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: scheduleScope(s),
    });
  }
  return {
    ...base,
    events,
    status: 'ok',
    summary: `Skipped: rate limit of ${limit} cards per hour reached`,
    result: { cardIds: [] },
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
        ...(o.dedupeKey ? { dedupeKey: o.dedupeKey } : {}),
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
