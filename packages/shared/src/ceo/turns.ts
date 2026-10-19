import { z } from 'zod';
import { ModelChoiceSchema } from '../models/choices.ts';

/**
 * The CEO's full-power turns (docs/design/ceo-front-door.md sections 3 and 5). Provenance is decided by the SERVER and
 * enforced by the runner; nothing the model or an event says upgrades a turn.
 */

/** A CEO chat turn the owner sent (`owner`) or that enforces one Owner-authorized standing order (`order`). */
export const CEO_TURN_MODES = ['owner', 'order'] as const;
export const CeoTurnMode = z.enum(CEO_TURN_MODES);
export type CeoTurnMode = z.infer<typeof CeoTurnMode>;

export const CEO_TURN_STATUSES = ['queued', 'running', 'done', 'failed', 'dropped'] as const;
export const CeoTurnStatus = z.enum(CEO_TURN_STATUSES);
export type CeoTurnStatus = z.infer<typeof CeoTurnStatus>;

/** Where an `aom ceo` call comes from; the server derives it from its own records (`ceo_turns`, `ceo_batches`). */
export type CeoOriginKind = 'owner' | 'order' | 'wake';

/** The capability string a runner announces in `hello.capabilities` when `aom-runner ceo full-power on` was run. */
export const CEO_FULL_POWER_CAPABILITY = 'ceo-full-power:1';

/** `chat.done.degraded`: the turn ran in the restricted profile because the machine owner has not switched full power on. */
export const CEO_DEGRADED_FULL_POWER_OFF = 'full_power_off';

/** A queued owner message older than this asks before it is sent ("This waited 3 days, still want it?"). */
export const CEO_QUEUE_STALE_HOURS = 72;

/** An unanswered permission question is a Deny after this long (docs section 14.1). */
export const CEO_PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** The desk item "authorize this execution" (an approval any Owner or Admin may answer). */
export const CEO_PERMISSION_SUBKIND = 'ceo_permission';

/** Order turns: at most this many per order per day, and one per (order, subject) per this many hours. */
export const ORDER_TURNS_PER_DAY = 5;
export const ORDER_SUBJECT_HOURS = 6;

/** Used when the runner reports what a turn used (the server's backstop logs an unlabelled off-board job from it). */
export const ToolCountsSchema = z.object({
  bash: z.number().int().min(0).default(0),
  edit: z.number().int().min(0).default(0),
  mcp: z.number().int().min(0).default(0),
  other: z.number().int().min(0).default(0),
});
export type ToolCounts = z.infer<typeof ToolCountsSchema>;

export const CeoPermissionDecision = z.enum(['once', 'turn', 'deny', 'timeout']);
export type CeoPermissionDecision = z.infer<typeof CeoPermissionDecision>;

/** What the runner needs to start an `order` turn and to refuse it when the authorization does not hold. */
export const CeoOrderSpecSchema = z.object({
  entryId: z.uuid(),
  versionHash: z.string().length(64),
  /** The order's text exactly as authorized: the runner recomputes `sha256(title + "\n" + body)`. */
  title: z.string(),
  body: z.string(),
  /** The Owner's own mark (`StandingOrderAuthorized`): without it the runner refuses the turn. */
  ownerMarked: z.boolean(),
  /** The owner-reserved keys this order may act on. */
  covers: z.array(z.string()).default([]),
});
export type CeoOrderSpec = z.infer<typeof CeoOrderSpecSchema>;

export const CeoTurnModelSchema = ModelChoiceSchema;

// ------------------------------------------------------------------------------------------------- repeats (4.3)

/** Docs section 14.5: a repeat is the same kind 4 or more times in 7 days, or 10 or more times in 30 days. */
export const REPEAT_RULE = { days7: { days: 7, times: 4 }, days30: { days: 30, times: 10 } } as const;
export const REPEAT_DISMISS_DAYS = 90;

export interface RepeatCount {
  hit: boolean;
  count7: number;
  count30: number;
}

export function countRepeats(times: readonly Date[], now: Date): RepeatCount {
  const within = (days: number) =>
    times.filter((t) => {
      // a job stamped a moment after `now` (clock skew inside one request) is as recent as it gets
      return now.getTime() - t.getTime() <= days * 86_400_000;
    }).length;
  const count7 = within(REPEAT_RULE.days7.days);
  const count30 = within(REPEAT_RULE.days30.days);
  return {
    hit: count7 >= REPEAT_RULE.days7.times || count30 >= REPEAT_RULE.days30.times,
    count7,
    count30,
  };
}

export const REPEAT_SUGGESTIONS = ['feature', 'skill', 'automation'] as const;
export const RepeatSuggestion = z.enum(REPEAT_SUGGESTIONS);
export type RepeatSuggestion = z.infer<typeof RepeatSuggestion>;

/** The suggestion rule: a project job is a feature; the same first shell token is an automation; otherwise a skill. */
export function suggestForRepeat(input: {
  hasProject: boolean;
  firstTokens: readonly string[];
}): RepeatSuggestion {
  if (input.hasProject) return 'feature';
  const t = input.firstTokens.filter(Boolean);
  if (t.length >= 2 && new Set(t).size === 1) return 'automation';
  return 'skill';
}

/** The slug of a job kind: lower case words joined by dashes. */
export const normalizeJobKind = (kind: string): string =>
  kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'unlabelled';
