import {
  type CardTemplate,
  type CreateScheduleRequest,
  isEmailAction,
  isEmailAddress,
  isPollAction,
  isWebhookAction,
  normaliseAllowEntry,
  SCHEDULE_EVENT_TRIGGERS,
  SCHEDULE_PRESETS,
  type ScheduleAction,
  type ScheduleDto,
  type ScheduleEventName,
  type ScheduleTrigger,
  unknownMappingTokens,
  type WebhookFormat,
  type WorkflowDefinition,
} from '@aom/shared';
import { buildCardRequest, type CardFormValues, emptyForm, fieldToText, formFieldList } from './cardForm.ts';
import { defaultTimezone, describeCron } from './feeds.ts';

export type TriggerKind =
  | 'cron'
  | 'event'
  | 'intake_ticket'
  | 'issue_labelled'
  | 'email_received'
  | 'email_reply'
  | 'webhook_in'
  | 'manual';

export const isMailKind = (k: TriggerKind): boolean => k === 'email_received' || k === 'email_reply';
/** Triggers that react to something that happened (their cards are "made by an automation"). */
export const isReactiveKind = (k: TriggerKind): boolean =>
  k === 'event' || k === 'intake_ticket' || k === 'webhook_in' || isMailKind(k);
export type ActionTile =
  | 'create_card'
  | 'regression_run'
  | 'devops_request'
  | 'ba_task'
  | 'github'
  | 'jira'
  | 'webhook'
  | 'email';

export const TRIGGER_TILES: Array<{ id: TriggerKind; label: string; description: string }> = [
  { id: 'cron', label: 'On a schedule', description: 'At a time of day or on a cadence, in your time zone.' },
  {
    id: 'event',
    label: 'When something happens',
    description:
      'A phase is completed, a card reaches a stage or is done, an investigation is reported, an interest run is done or a project is converted.',
  },
  {
    id: 'intake_ticket',
    label: 'When an intake ticket arrives',
    description: 'A request is taken into intake with the BA, from an issue poll or the intake chat.',
  },
  {
    id: 'email_received',
    label: 'When an e-mail arrives',
    description:
      'Someone writes (or forwards) to your Guildwise inbox address. The card starts as a draft for the BA, unless the sender is on your allow-list.',
  },
  {
    id: 'email_reply',
    label: 'When a reply arrives',
    description: 'Someone replies to a mail that became a card. The reply is added to the card as a comment.',
  },
  {
    id: 'webhook_in',
    label: 'When a web address is called',
    description:
      'Another system (monitoring, a form, n8n, Zapier) calls a private address with a secret. The fields it sends can fill the card. Cards start as drafts.',
  },
  {
    id: 'issue_labelled',
    label: 'When an issue is labelled',
    description: 'A GitHub or Jira issue gets a label. Your workstation polls; the credentials stay on it.',
  },
  {
    id: 'manual',
    label: 'Only when I run it',
    description: 'No automatic trigger: use "Run now" on the Automations page.',
  },
];

export const ACTION_TILES: Array<{
  id: ActionTile;
  label: string;
  description: string;
  /** Needs no project: then only Owners and Admins may create it. */
  orgLevelOnly?: boolean;
  /** Not usable with this trigger. */
  notWith?: TriggerKind[];
}> = [
  {
    id: 'create_card',
    label: 'Create a card',
    description: 'A card from a template, queued for the next free agent.',
  },
  {
    id: 'regression_run',
    label: 'Run a regression',
    description: 'A regression card per platform, queued at Test.',
    notWith: ['issue_labelled', 'email_received', 'email_reply', 'webhook_in'],
  },
  {
    id: 'devops_request',
    label: 'Ask DevOps',
    description: 'A request to the DevOps engineer of one of your workstations, or a repository hygiene run.',
  },
  {
    id: 'ba_task',
    label: 'Ask the CEO',
    description: 'The CEO does a task you describe (read-only) and reports to your desk.',
  },
  {
    id: 'github',
    label: 'Poll GitHub issues',
    description: 'New issues of a repository go into intake with the BA. Runs on your workstation.',
    notWith: ['issue_labelled', 'event', 'email_received', 'email_reply', 'webhook_in'],
  },
  {
    id: 'jira',
    label: 'Poll Jira issues',
    description: 'New issues from a JQL filter go into intake with the BA. Runs on your workstation.',
    notWith: ['issue_labelled', 'event', 'email_received', 'email_reply', 'webhook_in'],
  },
  {
    id: 'webhook',
    label: 'Send a webhook',
    description: 'POST JSON to a URL (Slack, Teams, n8n, Zapier), signed, with retries and a delivery log.',
  },
  {
    id: 'email',
    label: 'E-mail a digest',
    description: 'A summary e-mail: the floor report or a project summary.',
  },
];

export const actionTileOf = (a: ScheduleAction): ActionTile => {
  if (a.kind !== 'integration') return a.kind;
  if (isWebhookAction(a)) return 'webhook';
  if (isEmailAction(a)) return 'email';
  return a.integration;
};

/** A short noun for the list ("Webhook", "CEO task"). */
export const actionLabel = (a: ScheduleAction): string =>
  ACTION_TILES.find((t) => t.id === actionTileOf(a))?.label ?? a.kind;

export const SCHEDULE_ACTION_NOUN: Record<ActionTile, string> = {
  create_card: 'Card',
  regression_run: 'Regression',
  devops_request: 'DevOps request',
  ba_task: 'CEO task',
  github: 'GitHub poll',
  jira: 'Jira poll',
  webhook: 'Webhook',
  email: 'E-mail digest',
};

export const WEBHOOK_FORMAT_LABEL: Record<WebhookFormat, string> = {
  generic: 'Generic JSON (n8n, Zapier, your own)',
  slack: 'Slack incoming webhook',
  teams: 'Microsoft Teams',
};

export function describeTrigger(t: ScheduleTrigger): string {
  switch (t.kind) {
    case 'cron':
      return `${describeCron(t.cron)} (${t.timezone})`;
    case 'manual':
      return 'Only when run by hand';
    case 'event': {
      const e = SCHEDULE_EVENT_TRIGGERS.find((x) => x.id === t.event);
      const where = [
        t.workflowKey ? `workflow ${t.workflowKey}` : '',
        t.stageId ? `stage ${t.stageId}` : '',
        t.filter?.cardType ? `type ${t.filter.cardType}` : '',
        ...(t.filter?.fieldEquals ?? []).map((f) => `${f.field} = ${String(f.equals)}`),
      ].filter(Boolean);
      return `When ${(e?.label ?? t.event).toLowerCase()}${where.length ? ` (${where.join(', ')})` : ''}`;
    }
    case 'issue_labelled':
      return `When a ${t.provider === 'github' ? 'GitHub' : 'Jira'} issue in ${t.query} gets the label "${t.label}"`;
    case 'email_received': {
      const only = [
        t.from?.length ? `from ${t.from.join(', ')}` : '',
        t.subjectContains ? `subject contains "${t.subjectContains}"` : '',
      ].filter(Boolean);
      return `When an e-mail arrives${only.length ? ` (${only.join(', ')})` : ''}`;
    }
    case 'email_reply':
      return 'When a reply to a card e-mail arrives';
    case 'intake_ticket':
      return `When an intake ticket is created${t.source ? ` (${t.source === 'issues' ? 'from issues' : 'from the intake chat'})` : ''}`;
    case 'webhook_in':
      return `When its web address is called${t.maxPerHour ? ` (at most ${t.maxPerHour} an hour)` : ''}`;
  }
}

export function describeAction(a: ScheduleAction): string {
  switch (a.kind) {
    case 'create_card':
      return `Create a card "${a.template.title}"`;
    case 'regression_run':
      return `Run a regression (${String(a.template.fields.platform ?? 'web')})`;
    case 'devops_request':
      return a.hygiene ? 'Repository hygiene run' : `Ask DevOps: ${a.text}`;
    case 'ba_task':
      return `Ask the CEO: ${a.prompt}`;
    case 'integration':
      if (isPollAction(a))
        return `Take new ${a.integration === 'github' ? 'GitHub' : 'Jira'} issues of ${a.query} into intake`;
      if (isWebhookAction(a)) return `POST to ${hostOf(a.url)}`;
      if (isEmailAction(a)) return `E-mail ${a.to.join(', ')}`;
      return 'Integration';
  }
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ---------------------------------------------------------------------------------------------- wizard state

export interface WizardState {
  name: string;
  enabled: boolean;
  triggerKind: TriggerKind;
  preset: string;
  cron: string;
  timezone: string;
  event: ScheduleEventName;
  eventProjectId: string;
  /** Card events: the workflow (and for "reaches a stage" the stage) the card must be in. */
  eventWorkflowKey: string;
  eventStageId: string;
  filterCardType: string;
  filterField: string;
  filterEquals: string;
  /** `intake_ticket`: '' = any source. */
  intakeSource: '' | 'issues' | 'web';
  /** `email_received`, `email_reply`: the inbox, the senders it is limited to (comma separated) and a subject word. */
  inboxId: string;
  mailFrom: string;
  mailSubject: string;
  /** `webhook_in`: calls accepted per hour ('' = the default) and whether the Owner lets its cards start queued. */
  hookMaxPerHour: string;
  hookAllowQueued: boolean;
  provider: 'github' | 'jira';
  labelQuery: string;
  label: string;
  tile: ActionTile;
  /** '' = organization-level (where the action allows it). */
  projectId: string;
  workstationId: string;
  // card
  card: CardFormValues;
  /** Field mapping of an automation's card: target (`title`, `context`, a field key) <- text with {tokens}. */
  mapping: Array<{ target: string; text: string }>;
  /** '' = as the server decides (queued, or draft for members). */
  start: '' | 'draft' | 'queued';
  ratePerHour: string;
  dedupe: 'none' | 'thread' | 'subject_from';
  platform: 'web' | 'mobile' | 'both';
  // devops
  devopsText: string;
  hygiene: boolean;
  // ba
  prompt: string;
  deliver: 'desk_notice' | 'chat';
  // poll
  query: string;
  // webhook
  url: string;
  format: WebhookFormat;
  message: string;
  digest: '' | 'floor_report' | 'project_summary';
  // email
  to: string;
  subject: string;
  emailDigest: 'floor_report' | 'project_summary';
}

export const CUSTOM_PRESET = 'custom';

export const emptyWizard = (over: Partial<WizardState> = {}): WizardState => ({
  name: '',
  enabled: true,
  triggerKind: 'cron',
  preset: 'weekdays-0700',
  cron: '0 7 * * 1-5',
  timezone: defaultTimezone(),
  event: 'phase_completed',
  eventProjectId: '',
  eventWorkflowKey: '',
  eventStageId: '',
  filterCardType: '',
  filterField: '',
  filterEquals: '',
  intakeSource: '',
  inboxId: '',
  mailFrom: '',
  mailSubject: '',
  hookMaxPerHour: '',
  hookAllowQueued: false,
  provider: 'github',
  labelQuery: '',
  label: '',
  tile: 'create_card',
  projectId: '',
  workstationId: '',
  card: emptyForm(),
  mapping: [],
  start: '',
  ratePerHour: '',
  dedupe: 'none',
  platform: 'web',
  devopsText: '',
  hygiene: false,
  prompt: '',
  deliver: 'desk_notice',
  query: '',
  url: '',
  format: 'generic',
  message: '',
  digest: '',
  to: '',
  subject: '',
  emailDigest: 'floor_report',
  ...over,
});

const EVENT_NAMES = new Set<string>(SCHEDULE_EVENT_TRIGGERS.map((e) => e.id));
export const isEventName = (s: string): s is ScheduleEventName => EVENT_NAMES.has(s);

/** The wizard state of an existing schedule (editing). Card fields come back as the text the form edits. */
export function stateFromSchedule(s: ScheduleDto, workflow?: WorkflowDefinition): WizardState {
  const st = emptyWizard({ name: s.name, enabled: s.enabled, tile: actionTileOf(s.action) });
  const t = s.trigger;
  // The newer trigger kinds are refused on save until the automations page supports them (workflow builder WP6).
  st.triggerKind =
    t.kind === 'cron' ||
    t.kind === 'event' ||
    t.kind === 'issue_labelled' ||
    t.kind === 'intake_ticket' ||
    t.kind === 'email_received' ||
    t.kind === 'email_reply' ||
    t.kind === 'webhook_in'
      ? t.kind
      : 'manual';
  if (t.kind === 'cron') {
    st.cron = t.cron;
    st.timezone = t.timezone;
    st.preset = presetFor(t.cron);
  } else if (t.kind === 'event') {
    st.event = t.event;
    st.eventProjectId = t.projectId ?? '';
    st.eventWorkflowKey = t.workflowKey ?? '';
    st.eventStageId = t.stageId ?? '';
    st.filterCardType = t.filter?.cardType ?? '';
    const f = t.filter?.fieldEquals?.[0];
    st.filterField = f?.field ?? '';
    st.filterEquals = f ? String(f.equals) : '';
  } else if (t.kind === 'email_received') {
    st.inboxId = t.inboxId;
    st.mailFrom = (t.from ?? []).join(', ');
    st.mailSubject = t.subjectContains ?? '';
  } else if (t.kind === 'email_reply') {
    st.inboxId = t.inboxId;
  } else if (t.kind === 'webhook_in') {
    st.hookMaxPerHour = t.maxPerHour ? String(t.maxPerHour) : '';
    st.hookAllowQueued = t.allowQueued === true;
  } else if (t.kind === 'intake_ticket') {
    st.intakeSource = t.source === 'issues' || t.source === 'web' ? t.source : '';
  } else if (t.kind === 'issue_labelled') {
    st.provider = t.provider;
    st.workstationId = t.workstationId;
    st.labelQuery = t.query;
    st.label = t.label;
    st.cron = t.cron;
    st.timezone = t.timezone;
    st.preset = presetFor(t.cron);
  }
  const a = s.action;
  st.projectId = ('projectId' in a ? a.projectId : null) ?? '';
  if (a.kind === 'create_card' || a.kind === 'regression_run') {
    if (a.kind === 'regression_run')
      st.platform = (a.template.fields.platform as WizardState['platform']) ?? 'web';
    else st.card = formFromTemplate(a.template, workflow);
    if (a.kind === 'create_card') {
      st.mapping = Object.entries(a.template.mapping ?? {}).map(([target, text]) => ({ target, text }));
      st.start = a.template.start ?? '';
      st.ratePerHour = a.ratePerHour ? String(a.ratePerHour) : '';
      st.dedupe = a.dedupe === 'thread' || a.dedupe === 'subject_from' ? a.dedupe : 'none';
    }
  } else if (a.kind === 'devops_request') {
    st.workstationId = a.workstationId;
    st.devopsText = a.text;
    st.hygiene = a.hygiene ?? false;
  } else if (a.kind === 'ba_task') {
    st.prompt = a.prompt;
    st.deliver = a.deliver;
  } else if (isPollAction(a)) {
    st.workstationId = a.workstationId;
    st.query = a.query;
  } else if (isWebhookAction(a)) {
    st.url = a.url;
    st.format = a.format;
    st.message = a.message;
    st.digest = (a.digest as WizardState['digest'] | null | undefined) ?? '';
  } else if (isEmailAction(a)) {
    st.to = a.to.join(', ');
    st.subject = a.subject;
    st.emailDigest = a.digest === 'project_summary' ? 'project_summary' : 'floor_report';
  }
  return st;
}

const presetFor = (cron: string): string => {
  const c = cron.trim().replace(/\s+/g, ' ');
  return describeCron(c).startsWith('Cron ') ? CUSTOM_PRESET : (PRESET_BY_CRON.get(c) ?? CUSTOM_PRESET);
};
const PRESET_BY_CRON = new Map<string, string>(SCHEDULE_PRESETS.map((p) => [p.cron, p.id]));

export function formFromTemplate(template: CardTemplate, workflow?: WorkflowDefinition): CardFormValues {
  const v = emptyForm(template.cardType ?? workflow?.cardTypes[0] ?? '');
  v.title = template.title;
  if (template.priority) v.priority = String(template.priority);
  if (workflow)
    for (const [key, meta] of formFieldList(workflow, true))
      if (template.fields[key] !== undefined) v.fields[key] = fieldToText(meta.kind, template.fields[key]);
  return v;
}

export interface BuildResult {
  body: CreateScheduleRequest | null;
  errors: Record<string, string>;
}

export interface BuildContext {
  workflow?: WorkflowDefinition | undefined;
  mockUi: boolean;
  /** The signed-in user's address: the default recipient. */
  myEmail?: string;
}

/** `true`/`false` and numbers compare as such; anything else as text. */
function coerceValue(text: string): unknown {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
}

/** The mapping rows as the request's record (blank rows dropped; a repeated target keeps the last). */
export function mappingOf(rows: WizardState['mapping']): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.target.trim() && r.text.trim()) out[r.target.trim()] = r.text;
  return Object.keys(out).length ? out : undefined;
}

/** Validates the wizard and builds the request. Server rules (cron syntax, project access) are the server's to judge. */
export function buildScheduleRequest(s: WizardState, c: BuildContext): BuildResult {
  const errors: Record<string, string> = {};
  if (!s.name.trim()) errors.name = 'Give the automation a name';

  let trigger: ScheduleTrigger | null = null;
  const expression =
    s.preset === CUSTOM_PRESET
      ? s.cron.trim()
      : (SCHEDULE_PRESETS.find((p) => p.id === s.preset)?.cron ?? s.cron.trim());
  if (s.triggerKind === 'cron' || s.triggerKind === 'issue_labelled') {
    if (!expression) errors.cron = 'Enter a cron expression';
    else if (expression.split(/\s+/).length !== 5) errors.cron = 'Five fields: minute hour day month weekday';
    if (!s.timezone.trim()) errors.timezone = 'Enter an IANA time zone, e.g. Africa/Johannesburg';
  }
  if (s.triggerKind === 'cron')
    trigger = { kind: 'cron', cron: expression, timezone: s.timezone.trim() || 'UTC' };
  else if (s.triggerKind === 'manual') trigger = { kind: 'manual' };
  else if (s.triggerKind === 'webhook_in') {
    const per = s.hookMaxPerHour.trim() ? Number(s.hookMaxPerHour) : undefined;
    if (per !== undefined && (!Number.isInteger(per) || per < 1 || per > 10000))
      errors.hookMaxPerHour = 'A whole number from 1 to 10000';
    trigger = {
      kind: 'webhook_in',
      ...(per ? { maxPerHour: per } : {}),
      ...(s.hookAllowQueued ? { allowQueued: true } : {}),
    };
  } else if (s.triggerKind === 'event') {
    const def = SCHEDULE_EVENT_TRIGGERS.find((e) => e.id === s.event);
    const cardEvent = !!def?.cardFilters;
    if (def?.cardFilters === 'stage') {
      if (!s.eventWorkflowKey) errors.eventWorkflowKey = 'Choose the workflow';
      if (!s.eventStageId) errors.eventStageId = 'Choose the stage the card must reach';
    }
    if (s.filterField.trim() && !s.filterEquals.trim()) errors.filterEquals = 'Enter the value to compare';
    const fieldEquals = s.filterField.trim()
      ? [{ field: s.filterField.trim(), equals: coerceValue(s.filterEquals.trim()) }]
      : [];
    const filter =
      cardEvent && (s.filterCardType || fieldEquals.length)
        ? {
            ...(s.filterCardType ? { cardType: s.filterCardType } : {}),
            ...(fieldEquals.length ? { fieldEquals } : {}),
          }
        : undefined;
    trigger = {
      kind: 'event',
      event: s.event,
      ...(s.eventProjectId ? { projectId: s.eventProjectId } : {}),
      ...(cardEvent && s.eventWorkflowKey ? { workflowKey: s.eventWorkflowKey } : {}),
      ...(def?.cardFilters === 'stage' && s.eventStageId ? { stageId: s.eventStageId } : {}),
      ...(filter ? { filter } : {}),
    };
  } else if (s.triggerKind === 'intake_ticket')
    trigger = { kind: 'intake_ticket', ...(s.intakeSource ? { source: s.intakeSource } : {}) };
  else if (isMailKind(s.triggerKind)) {
    if (!s.inboxId) errors.inboxId = 'Choose the inbox';
    const from = s.mailFrom
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (s.triggerKind === 'email_received' && from.some((x) => !normaliseAllowEntry(x)))
      errors.mailFrom = 'Addresses (ana@acme.com) or domains (acme.com), separated by commas';
    trigger =
      s.triggerKind === 'email_reply'
        ? { kind: 'email_reply', inboxId: s.inboxId }
        : {
            kind: 'email_received',
            inboxId: s.inboxId,
            ...(from.length ? { from: from.map((x) => normaliseAllowEntry(x) ?? x) } : {}),
            ...(s.mailSubject.trim() ? { subjectContains: s.mailSubject.trim() } : {}),
          };
  } else {
    if (!s.workstationId) errors.workstationId = 'Choose the workstation that polls';
    if (!s.labelQuery.trim())
      errors.labelQuery =
        s.provider === 'github' ? 'Enter the repository as owner/repo' : 'Enter a JQL filter';
    if (!s.label.trim()) errors.label = 'Enter the label';
    trigger = {
      kind: 'issue_labelled',
      provider: s.provider,
      workstationId: s.workstationId,
      query: s.labelQuery.trim(),
      label: s.label.trim(),
      cron: expression,
      timezone: s.timezone.trim() || 'UTC',
    };
  }

  let action: ScheduleAction | null = null;
  const projectId = s.projectId || null;
  switch (s.tile) {
    case 'create_card': {
      if (!projectId) errors.projectId = 'Choose the project the card goes on';
      if (c.workflow) {
        const r = buildCardRequest(c.workflow, s.card, false, c.mockUi);
        for (const [k, m] of Object.entries(r.errors)) errors[`card.${k}`] = m;
        const mapping = mappingOf(s.mapping);
        const bad = unknownMappingTokens(mapping);
        if (bad.length) errors.mapping = `Unknown token ${bad.map((b) => `{${b}}`).join(', ')}`;
        const rate = s.ratePerHour.trim() ? Number(s.ratePerHour) : undefined;
        if (rate !== undefined && (!Number.isInteger(rate) || rate < 1 || rate > 1000))
          errors.ratePerHour = 'A whole number from 1 to 1000';
        if (projectId && Object.keys(errors).length === 0) {
          const automation = isReactiveKind(s.triggerKind);
          action = {
            kind: 'create_card',
            projectId,
            template: {
              title: r.title,
              cardType: r.cardType,
              fields: r.fields,
              ...(r.priority ? { priority: r.priority } : {}),
              ...(automation && mapping ? { mapping } : {}),
              ...(automation && s.start ? { start: s.start } : {}),
            },
            ...(automation && rate ? { ratePerHour: rate } : {}),
            ...(automation && s.dedupe !== 'none' ? { dedupe: s.dedupe } : {}),
          };
        }
      } else if (projectId) errors['card.title'] = 'Loading the project workflow';
      break;
    }
    case 'regression_run':
      if (!projectId) errors.projectId = 'Choose the project';
      else
        action = {
          kind: 'regression_run',
          projectId,
          template: { title: s.card.title.trim() || 'Regression run', fields: { platform: s.platform } },
        };
      break;
    case 'devops_request':
      if (!s.workstationId) errors.workstationId = 'Choose the workstation';
      if (!s.hygiene && !s.devopsText.trim())
        errors.devopsText = 'Write what DevOps should do, or choose hygiene';
      if (!errors.workstationId && !errors.devopsText)
        action = {
          kind: 'devops_request',
          workstationId: s.workstationId,
          text: s.hygiene ? '' : s.devopsText.trim(),
          ...(s.hygiene ? { hygiene: true } : {}),
          ...(projectId ? { projectId } : {}),
        };
      break;
    case 'ba_task':
      if (!s.prompt.trim()) errors.prompt = 'Tell the BA what to do';
      else action = { kind: 'ba_task', projectId, prompt: s.prompt.trim(), deliver: s.deliver };
      break;
    case 'github':
    case 'jira':
      if (!s.workstationId) errors.workstationId = 'Choose the workstation that polls';
      if (!s.query.trim())
        errors.query = s.tile === 'github' ? 'Enter the repository as owner/repo' : 'Enter a JQL filter';
      if (!errors.workstationId && !errors.query)
        action = {
          kind: 'integration',
          integration: s.tile,
          operation: 'issues_poll',
          workstationId: s.workstationId,
          query: s.query.trim(),
          ...(projectId ? { projectId } : {}),
        };
      break;
    case 'webhook':
      if (!/^https?:\/\/\S+$/i.test(s.url.trim())) errors.url = 'Enter the full URL, starting with https://';
      else
        action = {
          kind: 'integration',
          integration: 'webhook',
          operation: 'post',
          url: s.url.trim(),
          format: s.format,
          message: s.message,
          ...(s.digest ? { digest: s.digest } : {}),
          ...(projectId && s.digest !== 'floor_report' ? { projectId } : {}),
        };
      break;
    case 'email': {
      const list = s.to
        .split(/[\s,;]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const to = list.length ? list : c.myEmail ? [c.myEmail] : [];
      if (!to.length || to.some((x) => !isEmailAddress(x))) errors.to = 'Enter one or more e-mail addresses';
      if (s.emailDigest === 'project_summary' && !projectId)
        errors.projectId = 'A project summary needs a project';
      if (!errors.to && !errors.projectId)
        action = {
          kind: 'integration',
          integration: 'email',
          operation: 'digest',
          to,
          subject: s.subject.trim(),
          digest: s.emailDigest,
          ...(s.emailDigest === 'project_summary' && projectId ? { projectId } : {}),
        };
      break;
    }
  }
  if (Object.keys(errors).length || !trigger || !action) return { body: null, errors };
  return { body: { name: s.name.trim(), enabled: s.enabled, trigger, action }, errors };
}

/** Does this action (as the wizard has it) belong to the whole organization? Mirrors the server rule. */
export function wizardIsOrgLevel(s: WizardState): boolean {
  if (s.tile === 'devops_request' && s.hygiene) return true;
  if (s.tile === 'email' && s.emailDigest === 'floor_report') return true;
  if (s.tile === 'webhook' && s.digest === 'floor_report') return true;
  if (s.tile === 'create_card' || s.tile === 'regression_run') return false;
  return !s.projectId;
}
