import { z } from 'zod';

/**
 * Lean Team v3: how a question is routed, how long an agent waits for the answer inside its shift, how long a card
 * stays with the agent that asked, and how many passes a card may take before it is parked (docs/RUNNER.md "Questions").
 */

/** `aom question --topic <topic>`: the problem the question is about; the server routes by topic, not by who touched the card last. */
export const QUESTION_TOPICS = [
  'environment',
  'sandbox',
  'tooling',
  'tests',
  'dependency',
  'order',
  'requirements',
  'design',
  'code',
] as const;
export const QuestionTopicSchema = z.enum(QUESTION_TOPICS);
export type QuestionTopic = z.infer<typeof QuestionTopicSchema>;

/** Topics the workstation's DevOps engineer owns (a DevOps request, not a question shift). */
/** `tests`: running tests, or the test environment they need. */
export const DEVOPS_TOPICS: readonly QuestionTopic[] = ['environment', 'sandbox', 'tooling', 'tests'];
/** Routine or factual topics: the answer shift runs on Sonnet. Design and requirements keep the answerer's model. */
export const ROUTINE_TOPICS: readonly QuestionTopic[] = [
  'environment',
  'sandbox',
  'tooling',
  'tests',
  'dependency',
  'order',
  'code',
];

/** `aom question --wait`: minutes the asker waits inside its shift (default and ceiling), and how often it polls. */
export const QUESTION_WAIT = { defaultMinutes: 10, maxMinutes: 10, pollSeconds: 15 } as const;

/** How long a card keeps its affinity to an agent (the age ceiling of a resumed session). */
export const AFFINITY_HOURS = 4;

/** Question shifts on one card within the window that raise a loop signal, whatever the wording. */
export const QUESTION_LOOP = { shifts: 5, windowHours: 2 } as const;

/** Card size for the stop-loss budget. */
export const CARD_SIZES = ['small', 'medium', 'large'] as const;
export type CardSize = (typeof CARD_SIZES)[number];

/** Budget of one card size: build passes, review rounds and shifts before the card is parked for arbitration. */
export const StopLossBudgetSchema = z.object({
  buildPasses: z.number().int().min(1).max(50),
  reviewRounds: z.number().int().min(1).max(50),
  shifts: z.number().int().min(1).max(500),
});
export type StopLossBudget = z.infer<typeof StopLossBudgetSchema>;

export const StopLossSettingsSchema = z.object({
  small: StopLossBudgetSchema,
  medium: StopLossBudgetSchema,
  large: StopLossBudgetSchema,
});
export type StopLossSettings = z.infer<typeof StopLossSettingsSchema>;

/** Owner decision 17 Oct: small 2 / 2 / 10, medium 3 / 2 / 15, large 4 / 2 / 25. */
export const DEFAULT_STOP_LOSS: StopLossSettings = {
  small: { buildPasses: 2, reviewRounds: 2, shifts: 10 },
  medium: { buildPasses: 3, reviewRounds: 2, shifts: 15 },
  large: { buildPasses: 4, reviewRounds: 2, shifts: 25 },
};

/** What one answered arbitration adds to a card's budget (the architect said "go on"). */
export const STOP_LOSS_EXTENSION: StopLossBudget = { buildPasses: 1, reviewRounds: 1, shifts: 5 };

/** Parses `10m`, `90s`, `2h` or a bare number of minutes. Null when it is none of these. */
export function parseWaitDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const minutes = unit === 's' ? n / 60 : unit === 'h' ? n * 60 : n;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}
