import type {
  CardTemplate,
  ScheduleAction,
  ScheduleEventName,
  ScheduleKind,
  ScheduleTrigger,
  WebhookFormat,
} from '../events/schedule.ts';

/** The internal events a schedule can wait for, with the event-log type each one is read from. */
export const SCHEDULE_EVENT_TRIGGERS: ReadonlyArray<{
  id: ScheduleEventName;
  label: string;
  /** The domain event the server's trigger sweep matches (docs/ARCHITECTURE.md section 10.3). */
  eventType: string;
  /** More domain events that count as the same trigger (a card reaching a stage by any route). */
  alsoEventTypes?: string[];
  hint: string;
  /** Takes the workflow/stage/filter conditions of the card triggers (`workflowKey`, `stageId`, `filter`). */
  cardFilters?: 'stage' | 'workflow';
}> = [
  {
    id: 'phase_completed',
    label: 'A phase is completed',
    eventType: 'PhaseCompleted',
    hint: 'All cards of a phase are done and the BA is asked for the phase report.',
  },
  {
    id: 'card_finalized',
    label: 'A card is finalized',
    eventType: 'CardFinalized',
    hint: 'A card was merged, pushed or turned into a pull request and moved to Done.',
  },
  {
    id: 'interest_run_done',
    label: 'An interest run is done',
    eventType: 'InterestRunDone',
    hint: 'A scan of an interest posted its digest, or a research run published its note.',
  },
  {
    id: 'project_converted',
    label: 'A project is converted',
    eventType: 'ProjectConverted',
    hint: 'A research project became a code project (or another stage).',
  },
  {
    id: 'card_stage_reached',
    label: 'A card reaches a stage',
    eventType: 'StageCompleted',
    alsoEventTypes: ['CardSpecified', 'CardMovedByManager'],
    hint: 'A card of a workflow moves into the stage you choose (by an agent, the BA or a manager).',
    cardFilters: 'stage',
  },
  {
    id: 'card_done',
    label: 'A card of a workflow is done',
    eventType: 'CardFinalized',
    // With manual QA the card is done when QA passes or is skipped, not at the merge.
    alsoEventTypes: ['QaPassed', 'QaSkipped'],
    hint: 'A card of the workflow you choose was finalized (and passed manual QA, when that is on) and moved to Done.',
    cardFilters: 'workflow',
  },
  {
    id: 'investigation_reported',
    label: 'An investigation is reported',
    eventType: 'InvestigationReported',
    hint: 'The architect recorded an investigation or design report for a card.',
    cardFilters: 'workflow',
  },
  {
    id: 'ceo_notification',
    label: 'The CEO notifies you',
    eventType: 'CeoNotified',
    hint: 'Your CEO needs you, has something urgent, or finished a task you gave it. Use it to forward the message with "Send a webhook" (Slack, Teams).',
  },
];

/** Every domain event type a trigger name is read from. */
export const eventTypesOf = (id: ScheduleEventName): string[] => {
  const t = SCHEDULE_EVENT_TRIGGERS.find((e) => e.id === id);
  return t ? [t.eventType, ...(t.alsoEventTypes ?? [])] : [];
};

export const scheduleEventLabel = (id: ScheduleEventName): string =>
  SCHEDULE_EVENT_TRIGGERS.find((e) => e.id === id)?.label ?? id;

/** The action an old schedule row stands for (before generic actions): `regression` runs a regression, the rest emit a card. */
export function legacyAction(
  kind: ScheduleKind | string,
  projectId: string,
  template: CardTemplate,
): ScheduleAction {
  return kind === 'regression'
    ? { kind: 'regression_run', projectId, template }
    : { kind: 'create_card', projectId, template };
}

/** The denormalised `kind` of an action (`schedules.kind`). */
export function actionKind(action: ScheduleAction): ScheduleKind {
  switch (action.kind) {
    case 'create_card':
      return 'card';
    case 'regression_run':
      return 'regression';
    default:
      return action.kind;
  }
}

/** The project an action is bound to, or null for an organization-level action. */
export function actionProjectId(action: ScheduleAction): string | null {
  switch (action.kind) {
    case 'create_card':
    case 'regression_run':
      return action.projectId;
    case 'ba_task':
    case 'devops_request':
    case 'integration':
      return ('projectId' in action ? action.projectId : null) ?? null;
  }
}

/**
 * Organization-level actions: BA tasks without a project, repository hygiene and DevOps requests without a project,
 * integrations not bound to a project. Only the Owner and Admins may create or change them
 * (docs/design/restructure.md, "Impact of organizations"). The actions bound to a project are open to its members.
 */
export function isOrgLevelAction(action: ScheduleAction): boolean {
  if (action.kind === 'devops_request' && action.hygiene) return true;
  return actionProjectId(action) === null;
}

/** The workstation an action runs on (it must belong to the schedule's owner), if any. */
export function actionWorkstationId(action: ScheduleAction, trigger?: ScheduleTrigger): string | null {
  if (trigger?.kind === 'issue_labelled') return trigger.workstationId;
  if (action.kind === 'devops_request') return action.workstationId;
  if (action.kind === 'integration' && (action.integration === 'github' || action.integration === 'jira'))
    return action.workstationId;
  return null;
}

// ---------------------------------------------------------------------------------------------- templates

export interface ExpandContext {
  /** `YYYY-MM-DD` in the schedule's zone. */
  date: string;
  /** ISO week, `2026-W41`. */
  week: string;
  /** The event that ran the schedule ("PhaseCompleted"), the card or phase ref, the issue. */
  event?: string;
  ref?: string;
  project?: string;
  issue?: { key: string; title: string; url?: string };
}

/** ISO 8601 week number of a `YYYY-MM-DD` date. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Expands `{date}`, `{week}`, `{event}`, `{ref}`, `{project}`, `{issue}` (key and title) and `{issue.key|title|url}`. */
export function expandText(text: string, c: ExpandContext): string {
  return text.replace(
    /\{(date|week|event|ref|project|issue(?:\.key|\.title|\.url)?)\}/g,
    (_m, name: string) => {
      switch (name) {
        case 'date':
          return c.date;
        case 'week':
          return c.week;
        case 'event':
          return c.event ?? '';
        case 'ref':
          return c.ref ?? '';
        case 'project':
          return c.project ?? '';
        case 'issue':
          return c.issue ? `${c.issue.key}: ${c.issue.title}` : '';
        case 'issue.key':
          return c.issue?.key ?? '';
        case 'issue.title':
          return c.issue?.title ?? '';
        default:
          return c.issue?.url ?? '';
      }
    },
  );
}

/** Title of a scheduled card: a title without placeholders gets the date appended (the long-standing "title (date)"). */
export function expandTitle(title: string, c: ExpandContext): string {
  return /\{(date|week|event|ref|project|issue)/.test(title) ? expandText(title, c) : `${title} (${c.date})`;
}

// ---------------------------------------------------------------------------------------------- webhooks

export const WEBHOOK_EVENT = 'schedule.run';

export interface WebhookData {
  scheduleId: string;
  scheduleName: string;
  trigger: string;
  at: string;
  /** The text a chat tool shows. */
  text: string;
  details?: Record<string, unknown>;
}

/**
 * The JSON body of an outgoing webhook. Every format has a `text` field (Slack incoming webhooks and n8n/Zapier hooks
 * show it); `slack` adds mrkdwn, `teams` is a MessageCard (the connector format; Workflows accept it too).
 */
export function webhookBody(format: WebhookFormat, d: WebhookData): Record<string, unknown> {
  if (format === 'slack') return { text: d.text, mrkdwn: true };
  if (format === 'teams')
    return {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: d.scheduleName,
      title: d.scheduleName,
      text: d.text.replace(/\n/g, '\n\n'),
    };
  return {
    event: WEBHOOK_EVENT,
    schedule: { id: d.scheduleId, name: d.scheduleName },
    trigger: d.trigger,
    at: d.at,
    text: d.text,
    ...(d.details ? { data: d.details } : {}),
  };
}

export const WEBHOOK_MAX_ATTEMPTS = 5;

/** Wait before try `attempt + 1` of a failed delivery: 1 min, 5 min, 30 min, 2 h. */
export function webhookBackoffMs(attempt: number): number {
  return [60_000, 300_000, 1_800_000, 7_200_000][Math.min(Math.max(attempt, 1), 4) - 1] as number;
}

/** HTTP statuses worth another try (a server error, a rate limit, a timeout); the rest of the 4xx is final. */
export const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 429 || status === 408;

// ---------------------------------------------------------------------------------------------- display

export function describeEventTrigger(t: Extract<ScheduleTrigger, { kind: 'event' }>): string {
  return scheduleEventLabel(t.event).toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmailAddress = (s: string): boolean => EMAIL_RE.test(s);

/** Triggers the server fires today. Incoming webhooks parse but are refused on save (later). */
export function isTriggerImplemented(t: ScheduleTrigger): boolean {
  switch (t.kind) {
    case 'cron':
    case 'manual':
    case 'issue_labelled':
      return true;
    case 'event':
      return SCHEDULE_EVENT_TRIGGERS.some((e) => e.id === t.event);
    case 'email_received':
    case 'email_reply':
      return true;
    case 'intake_ticket':
      // Mail makes cards through `email_received`; it does not start an intake.
      return t.source !== 'email';
    default:
      return false;
  }
}

/** Sources a card field mapping may read (`{token}` in `CardTemplate.mapping`); `card.fields.<key>` is also valid. */
export const MAPPING_TOKENS = [
  'email.subject',
  'email.body',
  'email.from',
  'email.date',
  'email.thread',
  'card.ref',
  'card.title',
  'issue.title',
  'issue.key',
  'ceo.kind',
  'ceo.title',
  'ceo.text',
  'event',
  'date',
] as const;

const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_.]*)\}/g;
const CARD_FIELD_TOKEN = /^card\.fields\.[a-zA-Z][a-zA-Z0-9_]*$/;

export const isMappingToken = (name: string): boolean =>
  (MAPPING_TOKENS as readonly string[]).includes(name) || CARD_FIELD_TOKEN.test(name);

/** The `{tokens}` a mapping text uses (in order, with repeats). */
export function mappingTokens(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1] as string);
}

/** Mapping tokens a template uses that are not known (the schedule form shows them as errors). */
export function unknownMappingTokens(mapping: Record<string, string> | undefined): string[] {
  const bad = new Set<string>();
  for (const text of Object.values(mapping ?? {}))
    for (const t of mappingTokens(text)) if (!isMappingToken(t)) bad.add(t);
  return [...bad];
}

/**
 * Replaces known `{tokens}` with their values (missing value: empty). Unknown braces stay as written. Values are
 * inserted verbatim and never re-expanded, so mail text containing `{card.ref}` stays text.
 */
export function expandMapping(text: string, values: Readonly<Record<string, string | undefined>>): string {
  return text.replace(TOKEN, (whole, name: string) => (isMappingToken(name) ? (values[name] ?? '') : whole));
}

/** The two triggers that read inbound e-mail. */
export const isMailTrigger = (
  t: ScheduleTrigger,
): t is Extract<ScheduleTrigger, { kind: 'email_received' | 'email_reply' }> =>
  t.kind === 'email_received' || t.kind === 'email_reply';
