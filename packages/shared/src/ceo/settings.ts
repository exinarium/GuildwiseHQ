import { z } from 'zod';

/** The first days of a CEO are a training period: it recommends, the owner decides, and it learns from the difference. */
export const TRAINING_DAYS = 14;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time of day as HH:MM');

export const CeoTone = z.enum(['concise', 'warm', 'formal']);
export const NotifyKind = z.enum(['needs_you', 'urgent', 'task_done']);
export type NotifyKind = z.infer<typeof NotifyKind>;

export const NotifyChannelsSchema = z.object({
  desk: z.boolean().default(true),
  email: z.boolean().default(true),
  /** Raise the `CeoNotified` internal event so an automation can forward it (Slack, Teams). */
  automation: z.boolean().default(true),
});
export type NotifyChannels = z.infer<typeof NotifyChannelsSchema>;

export const CeoTrainingSchema = z.object({
  on: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  /** Nominal end; training stays on until the owner graduates the CEO. */
  until: z.iso.datetime().nullable(),
  graduatedAt: z.iso.datetime().nullable(),
  extensions: z.number().int().min(0).default(0),
});
export type CeoTraining = z.infer<typeof CeoTrainingSchema>;

export const CeoModelsSchema = z.object({
  wake: z.object({ model: z.string().min(1), effort: z.string().min(1) }),
  review: z.object({ model: z.string().min(1), effort: z.string().min(1) }),
  chat: z.object({ model: z.string().min(1), effort: z.string().min(1) }),
});
export type CeoModels = z.infer<typeof CeoModelsSchema>;
export const DEFAULT_CEO_MODELS: CeoModels = {
  wake: { model: 'sonnet', effort: 'medium' },
  review: { model: 'opus', effort: 'high' },
  chat: { model: 'opus', effort: 'high' },
};

export const CeoSettingsSchema = z.object({
  persona: z.object({
    tone: CeoTone.default('concise'),
    language: z.string().max(40).default('English'),
    signature: z.string().max(200).default(''),
  }),
  /** Owner-authored free text, added to every brief as an instruction (the only free text that is one). */
  standingInstructions: z.string().max(2000).default(''),
  models: CeoModelsSchema,
  /** Local time of the daily review; null follows the organization's reporting time. */
  reportAt: HHMM.nullable().default(null),
  notify: z.object({
    needs_you: NotifyChannelsSchema,
    urgent: NotifyChannelsSchema,
    task_done: NotifyChannelsSchema,
  }),
  /** E-mails that are not urgent wait until the daily report between these local times. */
  quietHours: z.object({ from: HHMM, to: HHMM }).nullable().default(null),
  /** Signal kinds that wake the CEO at once. */
  urgentSignals: z.array(z.string()).default(['loop', 'budget', 'repo_hygiene']),
  blockedHours: z.number().int().min(1).max(72).default(4),
  /** Debounce window for normal wakes, minutes. */
  wakeWindowMinutes: z.number().int().min(1).max(60).default(5),
  /** Soft notice when the CEO's own spend passes this many micro-units in a day (0: off). */
  spendNoticeMicros: z.number().int().min(0).default(5_000_000),
  /**
   * An optional monthly budget for the whole organization, in micro-units of its currency (0: none). At 80% the owner is
   * told, at 100% the CEO continues in minimal mode (the daily report and the chat) and nothing else wakes it; hires and
   * model-ups also stay under it. Projects keep their own budgets.
   */
  orgBudgetMonthlyMicros: z.number().int().min(0).default(0),
});
export type CeoSettings = z.infer<typeof CeoSettingsSchema>;

const on = { desk: true, email: true, automation: true };
export const DEFAULT_CEO_SETTINGS: CeoSettings = {
  persona: { tone: 'concise', language: 'English', signature: '' },
  standingInstructions: '',
  models: DEFAULT_CEO_MODELS,
  reportAt: null,
  notify: { needs_you: on, urgent: on, task_done: { desk: true, email: false, automation: true } },
  quietHours: null,
  urgentSignals: ['loop', 'budget', 'repo_hygiene'],
  blockedHours: 4,
  wakeWindowMinutes: 5,
  spendNoticeMicros: 5_000_000,
  orgBudgetMonthlyMicros: 0,
};

export const UpdateCeoSettingsRequestSchema = CeoSettingsSchema.partial();
export type UpdateCeoSettingsRequest = z.infer<typeof UpdateCeoSettingsRequestSchema>;

export function startTraining(now: Date, extensions = 0): CeoTraining {
  return {
    on: true,
    startedAt: now.toISOString(),
    until: new Date(now.getTime() + TRAINING_DAYS * 86_400_000).toISOString(),
    graduatedAt: null,
    extensions,
  };
}

/** Days of training left (0 once the nominal end has passed; training itself stays on until the owner graduates). */
export function trainingDaysLeft(t: CeoTraining, now: Date): number {
  if (!t.on || !t.until) return 0;
  return Math.max(0, Math.ceil((new Date(t.until).getTime() - now.getTime()) / 86_400_000));
}

export function extendTraining(t: CeoTraining, now: Date, days = 7): CeoTraining {
  const base = t.until && new Date(t.until) > now ? new Date(t.until) : now;
  return {
    ...t,
    on: true,
    graduatedAt: null,
    until: new Date(base.getTime() + days * 86_400_000).toISOString(),
    extensions: t.extensions + 1,
  };
}

export function graduate(t: CeoTraining, now: Date): CeoTraining {
  return { ...t, on: false, graduatedAt: now.toISOString() };
}

// ------------------------------------------------------------------------------- training observations

/** What the owner did with a recommendation of the CEO. */
export const RecommendationResponse = z.enum([
  /** Accepted as recommended (one click, or the same choice made by hand). */
  'accepted',
  /** Accepted with a change (another option or parameter). */
  'accepted_changed',
  /** Rejected / dismissed. */
  'rejected',
  /** The owner answered or acted differently from what was recommended. */
  'different',
]);
export type RecommendationResponse = z.infer<typeof RecommendationResponse>;
export const isAgreement = (r: RecommendationResponse): boolean => r === 'accepted';

export interface AgreementScore {
  class: string;
  agreed: number;
  total: number;
}

/** Agreement per class from the responded recommendations; classes with no responses are left out. */
export function agreementScores(
  responses: ReadonlyArray<{ class: string; response: RecommendationResponse }>,
): AgreementScore[] {
  const by = new Map<string, AgreementScore>();
  for (const r of responses) {
    const s = by.get(r.class) ?? { class: r.class, agreed: 0, total: 0 };
    s.total++;
    if (isAgreement(r.response)) s.agreed++;
    by.set(r.class, s);
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.class.localeCompare(b.class));
}

export const sumScores = (scores: readonly AgreementScore[]): { agreed: number; total: number } =>
  scores.reduce((a, s) => ({ agreed: a.agreed + s.agreed, total: a.total + s.total }), {
    agreed: 0,
    total: 0,
  });
