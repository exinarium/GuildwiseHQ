import { z } from 'zod';
import { defineEvent, Id, IsoDate } from './define.ts';

/**
 * What a schedule does, denormalised on the row for filtering. `card` = `create_card`, `regression` = `regression_run`;
 * `feed` stays for replay (new feed schedules are refused: feeds are interests).
 */
export const ScheduleKind = z.enum([
  'feed',
  'regression',
  'card',
  'devops_request',
  'ba_task',
  'integration',
]);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

/** What a scheduled run puts on the card it emits. */
export const CardTemplateSchema = z.object({
  title: z.string().min(1).max(300),
  /** Card type; defaults to the project workflow's first card type. */
  cardType: z.string().min(1).optional(),
  /** One of the project's enabled workflows; absent: the project's default for the card type. */
  workflowKey: z.string().min(1).optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(9).optional(),
  /**
   * Field mapping (docs/design/workflow-builder.md section 5): target -> text with `{token}`s. The target is `title`,
   * `context` or a card field key; tokens are listed in `MAPPING_TOKENS` (schedules/index.ts). Absent: `title` and
   * `fields` are used as written. Applied after `fields`, so a mapped key wins.
   */
  mapping: z.record(z.string().min(1).max(100), z.string().max(2000)).optional(),
  /**
   * State the created card starts in. Absent: as today (queued when ready, draft otherwise). Cards made from outside
   * content (e-mail, webhooks) are drafts unless the owner allows them to be queued.
   */
  start: z.enum(['draft', 'queued']).optional(),
});
export type CardTemplate = z.infer<typeof CardTemplateSchema>;

/** Internal events a schedule can be triggered by (`ScheduleTrigger.event`). */
export const SCHEDULE_EVENT_NAMES = [
  'phase_completed',
  'card_finalized',
  'interest_run_done',
  'project_converted',
  // Workflow-builder triggers (docs/design/workflow-builder.md section 5): accepted by the schema, fired by the server
  // once `SCHEDULE_EVENT_TRIGGERS` lists them (WP6).
  'card_stage_reached',
  'card_done',
  'investigation_reported',
  /** The CEO notified the owner (needs you, urgent, task done): an automation can forward it (Slack, Teams). */
  'ceo_notification',
] as const;
export const ScheduleEventName = z.enum(SCHEDULE_EVENT_NAMES);
export type ScheduleEventName = z.infer<typeof ScheduleEventName>;

/** Narrows which events of an `event` trigger fire a schedule. Every given condition must hold. */
export const TriggerFilterSchema = z.object({
  cardType: z.string().min(1).max(60).optional(),
  /** Card field (or column) equals a value, e.g. `{field: 'urgent', equals: true}`. */
  fieldEquals: z
    .array(z.object({ field: z.string().min(1).max(100), equals: z.unknown() }))
    .max(10)
    .optional(),
});
export type TriggerFilter = z.infer<typeof TriggerFilterSchema>;

/**
 * When a schedule runs. `cron` and `issue_labelled` carry a 5-field cron expression and an IANA zone (for
 * `issue_labelled` they are the polling cadence); `manual` runs only on "Run now"; `event` runs when the internal event
 * happens (evaluated by the server, never by an agent).
 */
export const ScheduleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(60),
  }),
  z.object({ kind: z.literal('manual') }),
  z.object({
    kind: z.literal('event'),
    event: ScheduleEventName,
    /** Only events of this project (phase, card, conversion), or of this interest. Null: any in the organization. */
    projectId: Id.nullish(),
    interestId: Id.nullish(),
    /** `card_stage_reached`, `card_done`: only cards of this workflow; `card_stage_reached`: only this stage. */
    workflowKey: z.string().min(1).max(100).optional(),
    stageId: z.string().min(1).max(100).optional(),
    filter: TriggerFilterSchema.optional(),
  }),
  z.object({
    kind: z.literal('issue_labelled'),
    provider: z.enum(['github', 'jira']),
    workstationId: Id,
    /** GitHub: `owner/repo`. Jira: a JQL filter (the label is added to it). */
    query: z.string().min(1).max(500),
    label: z.string().min(1).max(100),
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(60),
  }),
  /** A message arrived at one of the organisation's inbound addresses (docs/design/workflow-builder.md D9). */
  z.object({
    kind: z.literal('email_received'),
    inboxId: Id,
    /** Sender allow-list: full addresses or `@domain`. Absent: any sender (cards then start as drafts). */
    from: z.array(z.string().min(1).max(254)).max(50).optional(),
    subjectContains: z.string().min(1).max(200).optional(),
  }),
  /** A reply arrived in a mail thread that belongs to a card. */
  z.object({ kind: z.literal('email_reply'), inboxId: Id }),
  /** An intake was created (issues poll, mail, web form). */
  z.object({
    kind: z.literal('intake_ticket'),
    source: z.enum(['issues', 'email', 'web']).optional(),
    projectId: Id.nullish(),
  }),
  /**
   * `POST /api/hooks/:scheduleId[/:secret]` (backlog #14). The server makes the secret and keeps only `secretHash`
   * (SHA-256); a client never sends or reads it. Without a hash the hook refuses every call (revoked).
   */
  z.object({
    kind: z.literal('webhook_in'),
    secretHash: z.string().min(1).max(200).optional(),
    /** Calls accepted per hour (more are refused with 429). Default `HOOK_DEFAULT_PER_HOUR`. */
    maxPerHour: z.number().int().min(1).max(10000).optional(),
    /** The Owner lets cards from this hook start queued when the automation asks for it. Absent: drafts only. */
    allowQueued: z.boolean().optional(),
  }),
]);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

export const WEBHOOK_FORMATS = ['generic', 'slack', 'teams'] as const;
export const WebhookFormat = z.enum(WEBHOOK_FORMATS);
export type WebhookFormat = z.infer<typeof WebhookFormat>;

export const DIGEST_KINDS = ['floor_report', 'project_summary', 'interests'] as const;

export const DigestKind = z.enum(DIGEST_KINDS);
export type DigestKind = z.infer<typeof DigestKind>;

const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/);

/** Where the output of the agent that did the work goes when the card is done (`create_card` + `deliverOutput`). */
export const OUTPUT_DESTINATION_KINDS = ['email', 'webhook', 'whatsapp', 'google_sheet'] as const;
export const OutputDestinationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    to: z.array(z.string().max(254)).min(1).max(10),
    subject: z.string().max(200).default(''),
  }),
  z.object({
    kind: z.literal('webhook'),
    url: z.string().min(1).max(2000),
    format: WebhookFormat.default('generic'),
  }),
  z.object({
    kind: z.literal('whatsapp'),
    workstationId: Id,
    /** The phone number ID of the connected WhatsApp integration. */
    instance: z.string().min(1).max(200),
    to: z.array(E164).min(1).max(5),
    /** An approved message template (needed outside the 24-hour window); absent: a plain text message. */
    template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(15) }).optional(),
  }),
  z.object({
    kind: z.literal('google_sheet'),
    workstationId: Id,
    /** The service account e-mail of the connected Google Sheets integration. */
    instance: z.string().min(1).max(200),
    spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
    sheet: z.string().min(1).max(100).default('Sheet1'),
  }),
]);
export type OutputDestination = z.infer<typeof OutputDestinationSchema>;

export const DeliverOutputSchema = z.object({
  destinations: z.array(OutputDestinationSchema).min(1).max(5),
  /** Signing secret of the webhook destinations (one per automation), encrypted with `AOM_SECRET_KEY`. Never sent to the browser. */
  secretEnc: z.string().max(500).optional(),
});
export type DeliverOutput = z.infer<typeof DeliverOutputSchema>;

/** One action per schedule. `{date}`, `{week}`, `{event}`, `{ref}` and `{issue}` in titles and texts are expanded at fire time. */
export const ScheduleActionSchema = z.union([
  z.object({
    kind: z.literal('create_card'),
    projectId: Id,
    template: CardTemplateSchema,
    /** Event-triggered schedules: cards created per hour at most (default 20); more are skipped with one desk notice. */
    ratePerHour: z.number().int().min(1).max(1000).optional(),
    /** Do not create a second card for the same mail thread, subject and sender, or at all. Absent: `none`. */
    dedupe: z.enum(['thread', 'subject_from', 'none']).optional(),
    /** Send what the agent produced when the card is done. Absent: nothing is sent. */
    deliverOutput: DeliverOutputSchema.optional(),
  }),
  z.object({ kind: z.literal('regression_run'), projectId: Id, template: CardTemplateSchema }),
  z.object({
    kind: z.literal('devops_request'),
    workstationId: Id,
    text: z.string().max(2000).default(''),
    /** "Run repository hygiene now" instead of a free-text request. */
    hygiene: z.boolean().optional(),
    projectId: Id.nullish(),
  }),
  z.object({
    kind: z.literal('ba_task'),
    projectId: Id.nullable(),
    prompt: z.string().min(1).max(2000),
    deliver: z.enum(['desk_notice', 'chat']).default('desk_notice'),
  }),
  z.object({
    kind: z.literal('integration'),
    integration: z.enum(['github', 'jira']),
    operation: z.literal('issues_poll'),
    workstationId: Id,
    query: z.string().min(1).max(500),
    projectId: Id.nullish(),
  }),
  z.object({
    kind: z.literal('integration'),
    integration: z.literal('webhook'),
    operation: z.literal('post').default('post'),
    url: z.string().min(1).max(2000),
    format: WebhookFormat.default('generic'),
    /** The message (Slack and Teams show it as the text). Empty: a summary line of the run. */
    message: z.string().max(2000).default(''),
    /** Append a digest (floor report, project summary) to the text. */
    digest: DigestKind.nullish(),
    projectId: Id.nullish(),
    /** The signing secret, encrypted at rest with `AOM_SECRET_KEY`. Never sent to the browser. */
    secretEnc: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('integration'),
    integration: z.literal('email'),
    operation: z.literal('digest').default('digest'),
    to: z.array(z.string().max(254)).min(1).max(10),
    subject: z.string().max(200).default(''),
    digest: DigestKind,
    projectId: Id.nullish(),
  }),
]);
export type ScheduleAction = z.infer<typeof ScheduleActionSchema>;
export type PollAction = Extract<ScheduleAction, { operation: 'issues_poll' }>;
export type WebhookAction = Extract<ScheduleAction, { integration: 'webhook' }>;
export type EmailAction = Extract<ScheduleAction, { integration: 'email' }>;
export const isPollAction = (a: ScheduleAction): a is PollAction =>
  a.kind === 'integration' && a.integration !== 'webhook' && a.integration !== 'email';
export const isWebhookAction = (a: ScheduleAction): a is WebhookAction =>
  a.kind === 'integration' && a.integration === 'webhook';
export const isEmailAction = (a: ScheduleAction): a is EmailAction =>
  a.kind === 'integration' && a.integration === 'email';

export const SCHEDULE_RUN_TRIGGERS = ['cron', 'manual', 'event', 'issue', 'test'] as const;
export const ScheduleRunTrigger = z.enum(SCHEDULE_RUN_TRIGGERS);
export type ScheduleRunTrigger = z.infer<typeof ScheduleRunTrigger>;

/** What a run created or did (the run history shows links). */
export const ScheduleRunResultSchema = z.object({
  cardIds: z.array(Id).optional(),
  devopsRequestId: Id.optional(),
  baTaskId: Id.optional(),
  intakeIds: z.array(Id).optional(),
  commandId: Id.optional(),
  /** Keys of the issues taken into intake. */
  issueKeys: z.array(z.string()).optional(),
  deskItemId: Id.optional(),
  /** Output deliveries: the card whose result was sent. Not `cardIds`: rate limits and dedupe count those. */
  outputCardId: Id.optional(),
});
export type ScheduleRunResult = z.infer<typeof ScheduleRunResultSchema>;

/** The payload a retried delivery sends: stored with the run so a retry sends exactly what the first try did. */
export const ScheduleDeliverySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('webhook'),
    url: z.string(),
    body: z.string(),
    event: z.string(),
    /** `output`: signed with `deliverOutput.secretEnc` instead of the webhook action's own secret. */
    secret: z.literal('output').optional(),
  }),
  z.object({
    kind: z.literal('email'),
    to: z.array(z.string()),
    subject: z.string(),
    text: z.string(),
  }),
  /**
   * WhatsApp and Google Sheets are sent by the runner with the credential kept on the workstation. This record holds
   * no message text: the text is rebuilt from the card for each try and lives only in the runner command.
   */
  z.object({
    kind: z.literal('runner'),
    channel: z.enum(['whatsapp', 'google_sheet']),
    destination: z.number().int().min(0).max(4),
    cardId: Id,
    workstationId: Id,
  }),
]);
export type ScheduleDelivery = z.infer<typeof ScheduleDeliverySchema>;

const ScheduleBody = z.object({
  scheduleId: Id,
  /** Null: an organization-level action (BA task without a project, hygiene, an integration not bound to a project). */
  projectId: Id.nullable(),
  name: z.string().min(1).max(120),
  kind: ScheduleKind,
  /** Standard 5-field cron expression, evaluated in `timezone`. Null for a manual or event trigger. */
  cron: z.string().min(1).max(100).nullable(),
  /** IANA time zone, e.g. `Africa/Johannesburg`. */
  timezone: z.string().min(1).max(60).nullable(),
  /** Legacy rows (before generic actions). New events carry `action` instead. */
  cardTemplate: CardTemplateSchema.optional(),
  /** Absent in events written before generic schedules: `cron` + `timezone` are the trigger. */
  trigger: ScheduleTriggerSchema.optional(),
  /** Absent in events written before generic schedules: derived from `kind` and `cardTemplate` (`legacyAction`). */
  action: ScheduleActionSchema.optional(),
  /** Who created it: workstation actions and the owner's e-mail address are theirs. */
  ownerUserId: Id.optional(),
  enabled: z.boolean(),
  /** The next time the schedule fires (computed by the server from `cron` and `timezone`). */
  nextFireAt: IsoDate.nullable(),
});

/** Scheduler events (docs/ARCHITECTURE.md section 5.2 and 10, M5). */
export const scheduleEvents = [
  /** `interestId`: the interest that owns this schedule (docs/design/interests.md). */
  defineEvent('ScheduleCreated', ScheduleBody.extend({ interestId: Id.optional() })),
  defineEvent('ScheduleUpdated', ScheduleBody),
  /** Adopts a schedule into an interest, or (null) unlinks it. Linking back-fills `cards.interest_id` of its earlier cards. */
  defineEvent('ScheduleLinked', z.object({ scheduleId: Id, interestId: Id.nullable() })),
  defineEvent('ScheduleDeleted', z.object({ scheduleId: Id })),
  /** Always appended together with the `CardCreated{scheduled:true, origin:'schedule'}` it causes. */
  defineEvent(
    'ScheduleFired',
    z.object({
      scheduleId: Id,
      /** Absent for actions that emit no card (a webhook, an e-mail, a DevOps request). */
      cardId: Id.optional(),
      firedFor: IsoDate,
      nextFireAt: IsoDate.nullable(),
      /** The run history entry this fire created (absent in events written before generic schedules). */
      runId: Id.optional(),
    }),
  ),
  /**
   * A run of a schedule that is not a cron fire (run now, an event, a polled issue, a webhook test), or the details
   * of a cron fire (`ScheduleFired.runId`). `status: 'pending'` is a delivery (webhook, e-mail) that still has to be
   * made or retried; `delivery` is what it sends.
   */
  defineEvent(
    'ScheduleRunRecorded',
    z.object({
      runId: Id,
      scheduleId: Id,
      trigger: ScheduleRunTrigger,
      /** The event the run answers (`<seq>` of the log, or `issue:<provider>:<key>`): a source runs a schedule once. */
      sourceKey: z.string().max(300).optional(),
      /** Content key for `create_card.dedupe`: a second run with the same key creates no card. */
      dedupeKey: z.string().max(500).optional(),
      /** Human label of the source: "PhaseCompleted WEB-P2", "issue owner/repo#12". */
      label: z.string().max(300).optional(),
      status: z.enum(['ok', 'failed', 'pending']),
      summary: z.string().max(2000),
      result: ScheduleRunResultSchema.optional(),
      error: z.string().max(2000).optional(),
      delivery: ScheduleDeliverySchema.optional(),
      nextAttemptAt: IsoDate.optional(),
    }),
  ),
  /** A try was handed to the runner: the run is not picked again before `deadline`. Holds no message text. */
  defineEvent(
    'ScheduleDeliveryDispatched',
    z.object({
      runId: Id,
      scheduleId: Id,
      attempt: z.number().int().positive(),
      commandId: Id,
      deadline: IsoDate,
    }),
  ),
  /** One try of a delivery: the delivery log. `status` is the run's status after it. */
  defineEvent(
    'ScheduleDeliveryAttempted',
    z.object({
      runId: Id,
      scheduleId: Id,
      attempt: z.number().int().positive(),
      ok: z.boolean(),
      httpStatus: z.number().int().optional(),
      error: z.string().max(2000).optional(),
      durationMs: z.number().int().nonnegative().optional(),
      status: z.enum(['ok', 'failed', 'pending']),
      nextAttemptAt: IsoDate.optional(),
    }),
  ),
  /** The run's outcome was learned later (the runner's poll answered): status, summary and result are replaced. */
  defineEvent(
    'ScheduleRunCompleted',
    z.object({
      runId: Id,
      scheduleId: Id,
      status: z.enum(['ok', 'failed']),
      summary: z.string().max(2000),
      result: ScheduleRunResultSchema.optional(),
      error: z.string().max(2000).optional(),
    }),
  ),
  /**
   * A due fire that did not happen because the organization is not running (suspended or cancelled) or the feature is
   * switched off: recorded, not retried; the next fire is the next one on the cron.
   */
  defineEvent(
    'ScheduleSkipped',
    z.object({
      scheduleId: Id,
      firedFor: IsoDate,
      nextFireAt: IsoDate.nullable(),
      reason: z.enum(['org_suspended', 'feature_disabled', 'rate_limited', 'project_paused']),
    }),
  ),
  /** The manager ran a feed (or schedule) right now; same card path as `ScheduleFired`. */
  defineEvent(
    'FeedRunRequested',
    z.object({ projectId: Id, scheduleId: Id.optional(), cardId: Id, requestedBy: Id }),
  ),
] as const;
