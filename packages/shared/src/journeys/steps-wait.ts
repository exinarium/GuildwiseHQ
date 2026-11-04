import { z } from 'zod';
import { Position, StepIdSchema } from './step-base.ts';

// ---------------------------------------------------------------------------------------------------- durations

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 } as const;
const MIN_MS = 5 * 60_000;
const MAX_MS = 365 * 86_400_000;

const DurationBase = z.object({
  amount: z.number().int().min(1).max(525_600),
  unit: z.enum(['minutes', 'hours', 'days', 'weeks']),
});
export const JourneyDurationSchema = DurationBase.refine(
  (d) => {
    const ms = d.amount * UNIT_MS[d.unit];
    return ms >= MIN_MS && ms <= MAX_MS;
  },
  { message: 'A duration is between 5 minutes and 365 days.' },
);
export type JourneyDuration = z.infer<typeof JourneyDurationSchema>;

/** A shift of a date: may be negative ("2 days before"). */
export const JourneySignedDurationSchema = z.object({
  amount: z.number().int().min(-525_600).max(525_600),
  unit: z.enum(['minutes', 'hours', 'days', 'weeks']),
});
export type JourneySignedDuration = z.infer<typeof JourneySignedDurationSchema>;

export const durationMs = (d: { amount: number; unit: keyof typeof UNIT_MS }): number => d.amount * UNIT_MS[d.unit];
export const deadlineOf = (startedAt: Date, d: JourneyDuration): Date => new Date(startedAt.getTime() + durationMs(d));

// ----------------------------------------------------------------------------------------------------- approvers

export const JourneyApproverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('org_owner') }),
  z.object({ kind: z.literal('org_role'), role: z.enum(['owner', 'admin']) }),
  z.object({ kind: z.literal('project_owner') }),
  z.object({ kind: z.literal('member'), userId: z.string().uuid() }),
]);
export type JourneyApprover = z.infer<typeof JourneyApproverSchema>;

// ------------------------------------------------------------------------------------------------- wait + timeout

export const WaitForSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duration') }),
  z.object({
    kind: z.literal('date'),
    dateFrom: z.object({ field: z.string().min(1).max(100) }),
    offset: JourneySignedDurationSchema.optional(),
    atTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default('09:00'),
  }),
  z.object({
    kind: z.literal('form'),
    /** null in a template until the user picks one. */
    formId: z.string().uuid().nullable(),
    purpose: z.enum(['answers', 'upload']).default('answers'),
    send: z.object({ via: z.enum(['desk', 'webhook']) }).default({ via: 'desk' }),
  }),
  z.object({ kind: z.literal('webhook'), triggerId: z.string().uuid().nullable() }),
]);
export type WaitFor = z.infer<typeof WaitForSchema>;

export const TimeoutActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('remind'),
    every: JourneyDurationSchema.optional(),
    maxReminders: z.number().int().min(1).max(10).default(3),
    afterLast: z.enum(['escalate', 'cancel']).default('escalate'),
  }),
  z.object({ action: z.literal('goto'), stepId: StepIdSchema }),
  z.object({ action: z.literal('escalate'), to: JourneyApproverSchema.optional() }),
  z.object({ action: z.literal('cancel') }),
]);
export type TimeoutAction = z.infer<typeof TimeoutActionSchema>;

const StepBase = { id: StepIdSchema, label: z.string().min(1).max(120), position: Position.optional() };

/** Config is optional so unconfigured placeholders and drafts still parse; validation requires it. */
export const JourneyWaitStepSchema = z.object({
  ...StepBase,
  kind: z.literal('wait'),
  waitFor: WaitForSchema.optional(),
  duration: JourneyDurationSchema.optional(),
  onTimeout: TimeoutActionSchema.optional(),
});
export type JourneyWaitStep = z.infer<typeof JourneyWaitStepSchema>;

export const JourneyGateStepSchema = z.object({
  ...StepBase,
  kind: z.literal('gate'),
  approver: JourneyApproverSchema.optional(),
  question: z.string().max(500).optional(),
  deadline: z.object({ duration: JourneyDurationSchema, onTimeout: TimeoutActionSchema }).optional(),
});
export type JourneyGateStep = z.infer<typeof JourneyGateStepSchema>;

const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,60}$/);
const CredName = z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/);

export const JourneyWebhookCallStepSchema = z.object({
  ...StepBase,
  kind: z.literal('webhook_call'),
  workstationId: z.string().uuid().nullable().default(null),
  url: z.string().max(2000).default(''),
  method: z.enum(['POST', 'PUT', 'PATCH', 'GET', 'DELETE']).default('POST'),
  headers: z.array(z.object({ name: HeaderName, value: z.string().max(1000) })).max(20).default([]),
  credentialHeaders: z.array(z.object({ name: HeaderName, credential: CredName })).max(5).default([]),
  signWith: CredName.optional(),
  contentType: z.enum(['application/json', 'application/x-www-form-urlencoded', 'text/plain']).default('application/json'),
  body: z.string().max(20_000).default(''),
});
export type JourneyWebhookCallStep = z.infer<typeof JourneyWebhookCallStepSchema>;

// ------------------------------------------------------------------------------------------------ date waits

function zoneOffsetMs(utc: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(utc))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(utc / 1000) * 1000;
}

/**
 * The moment a date wait ends. `value` is an ISO date (`2026-12-01`: the time of day is `atTime` in `timeZone`) or an ISO
 * date-time (taken as is). `offset` shifts it. Null when the value is not a valid date.
 */
export function dateWaitFireAt(
  value: unknown,
  offset: JourneySignedDuration | undefined,
  atTime: string | undefined,
  timeZone = 'UTC',
): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  let base: number;
  if (value instanceof Date) base = value.getTime();
  else {
    const v = value.trim();
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (day) {
      const [hh, mm] = (atTime ?? '09:00').split(':').map(Number) as [number, number];
      const y = Number(day[1]);
      const mo = Number(day[2]);
      const d = Number(day[3]);
      const probe = new Date(Date.UTC(y, mo - 1, d, 12));
      if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
      const wall = Date.UTC(y, mo - 1, d, hh, mm);
      let tz: string;
      try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        tz = timeZone;
      } catch {
        tz = 'UTC';
      }
      let guess = wall - zoneOffsetMs(wall, tz);
      guess = wall - zoneOffsetMs(guess, tz);
      base = guess;
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      base = Date.parse(v);
    } else return null;
  }
  if (!Number.isFinite(base)) return null;
  const at = base + (offset ? durationOffsetMs(offset) : 0);
  return Number.isFinite(at) ? new Date(at) : null;
}

const durationOffsetMs = (d: JourneySignedDuration): number => d.amount * UNIT_MS[d.unit];

// ---------------------------------------------------------------------------------------------- timeout decision

export interface WaitView {
  kind: string;
  status: 'open' | 'escalated' | 'resolved' | 'timed_out' | 'cancelled';
  startedAt: Date;
  deadlineAt: Date | null;
  nextFireAt: Date | null;
  remindersSent: number;
  /** The wait's own config: `onTimeout` for form and webhook waits (and gates with a deadline). */
  onTimeout?: TimeoutAction | undefined;
  defaultEscalateTo?: JourneyApprover | undefined;
}

export type TimeoutDecision =
  | { kind: 'elapsed' }
  | { kind: 'remind'; n: number; of: number; nextFireAt: Date }
  | { kind: 'goto'; stepId: string }
  | { kind: 'escalate'; to: JourneyApprover | undefined }
  | { kind: 'cancel' };

/**
 * What a due wait does. A reminder series that fell behind (the server was down) sends one reminder and plans the next from
 * `now`, never a burst. After the last reminder `afterLast` runs.
 */
export function timeoutDecision(w: WaitView, now: Date): TimeoutDecision {
  if (w.kind === 'duration' || w.kind === 'date') return { kind: 'elapsed' };
  const t = w.onTimeout;
  if (!t) return { kind: 'escalate', to: w.defaultEscalateTo };
  switch (t.action) {
    case 'goto':
      return { kind: 'goto', stepId: t.stepId };
    case 'cancel':
      return { kind: 'cancel' };
    case 'escalate':
      return { kind: 'escalate', to: t.to };
    case 'remind': {
      if (w.remindersSent >= t.maxReminders)
        return t.afterLast === 'cancel' ? { kind: 'cancel' } : { kind: 'escalate', to: undefined };
      const every = t.every
        ? durationMs(t.every)
        : Math.max(MIN_MS, (w.deadlineAt ?? now).getTime() - w.startedAt.getTime());
      return { kind: 'remind', n: w.remindersSent + 1, of: t.maxReminders, nextFireAt: new Date(now.getTime() + every) };
    }
  }
}

// ----------------------------------------------------------------------------------------------- body templates

export const BODY_TOKENS = [
  'record.name',
  'record.type',
  'record.externalId',
  'journey.name',
  'instance.id',
  'step.id',
  'step.label',
  'submission.id',
  'wait.link',
  'now',
] as const;
export type BodyToken = (typeof BODY_TOKENS)[number];

export function templateTokens(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z.]+)\}/g)].map((m) => m[1]!);
}

export function unknownBodyTokens(template: string): string[] {
  return [...new Set(templateTokens(template).filter((t) => !(BODY_TOKENS as readonly string[]).includes(t)))];
}

/** Fills `{token}` values. JSON bodies get JSON-string-escaped values, form bodies get URL-encoded values. */
export function renderBodyTemplate(
  template: string,
  vars: Partial<Record<BodyToken, string>>,
  contentType: 'application/json' | 'application/x-www-form-urlencoded' | 'text/plain',
): string {
  const bad = unknownBodyTokens(template);
  if (bad.length) throw new Error(`Unknown token {${bad[0]}}`);
  return template.replace(/\{([a-zA-Z.]+)\}/g, (_w, k: string) => {
    const v = vars[k as BodyToken] ?? '';
    if (contentType === 'application/json') return JSON.stringify(v).slice(1, -1);
    if (contentType === 'application/x-www-form-urlencoded') return encodeURIComponent(v);
    return v;
  });
}

// ------------------------------------------------------------------------------------------------ hook mapping

export const HookMappingSchema = z.object({
  externalId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).optional(),
});
export type HookMapping = z.infer<typeof HookMappingSchema>;

/** RFC 6901. Undefined when the pointer leads nowhere. */
export function readPointer(obj: unknown, pointer: string): unknown {
  if (pointer === '') return obj;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = obj;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (cur && typeof cur === 'object') {
      if (!Object.hasOwn(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    } else return undefined;
  }
  return cur;
}

export type HookMapResult =
  | { externalId: string; displayName?: string }
  | { error: 'missing_match' | 'value_too_long' | 'not_scalar' };

const scalar = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** Picks the external id (≤ 120) and display name (≤ 200) and nothing else from a payload. */
export function mapHookPayload(mapping: HookMapping, json: unknown): HookMapResult {
  const rawId = readPointer(json, mapping.externalId);
  if (rawId === undefined || rawId === null || rawId === '') return { error: 'missing_match' };
  const externalId = scalar(rawId);
  if (externalId === null) return { error: 'not_scalar' };
  const id = externalId.trim();
  if (!id) return { error: 'missing_match' };
  if (id.length > 120) return { error: 'value_too_long' };
  if (!mapping.displayName) return { externalId: id };
  const rawName = readPointer(json, mapping.displayName);
  if (rawName === undefined || rawName === null || rawName === '') return { externalId: id };
  const name = scalar(rawName);
  if (name === null) return { error: 'not_scalar' };
  const n = name.trim();
  if (n.length > 200) return { error: 'value_too_long' };
  return n ? { externalId: id, displayName: n } : { externalId: id };
}

// ------------------------------------------------------------------------------------------------ retry backoff

/** Retry schedule of an outbound call, in minutes after a failed try: 1, 5, 30, 120. */
export const CALL_BACKOFF_MINUTES = [1, 5, 30, 120] as const;
export const CALL_MAX_ATTEMPTS = CALL_BACKOFF_MINUTES.length + 1;
export function callBackoffMs(attemptsDone: number): number | null {
  const m = CALL_BACKOFF_MINUTES[attemptsDone - 1];
  return m === undefined ? null : m * 60_000;
}
export const isRetryableHttpStatus = (s: number): boolean => s === 408 || s === 425 || s === 429 || s >= 500;
