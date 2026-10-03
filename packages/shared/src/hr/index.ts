import type { ReworkReason } from '../cards/types.ts';

/**
 * M9 HR board contract shared by the server (rules, stats) and the web (labels, thresholds shown as evidence).
 * Stats cover a rolling window; every rule needs a minimum sample so a first card never triggers advice.
 */
export const HR_WINDOW_DAYS = 30;

export const HR_RULES = {
  /** Cards an agent must have touched in the window before any rate-based rule can fire. */
  minCards: 3,
  /** Blocked: share of its cards that raised a question. */
  blockedRate: 0.4,
  /** Questions that must share a topic keyword before a standing order is proposed. */
  topicQuestions: 3,
  /** Share of questions that the ledger had already answered (ledger search is failing). */
  ledgerMissRate: 0.5,
  /** Share of blocked cards whose spec is thin before the BA is blamed. */
  thinSpecShare: 0.5,
  /** A review reason counts as recurring from this many bounces. */
  reasonRecurring: 3,
  /** Rework or bug rate on complex (large) cards that asks for a stronger model. */
  largeFailRate: 0.5,
  minLargeCards: 2,
  /** Model down: rework rate at most this, no bugs, and mostly small cards. */
  lowReworkRate: 0.1,
  smallShare: 0.8,
  minCardsDown: 4,
  /** Split the role: both sizes appear at least this often. */
  splitMinEach: 2,
  splitMinCards: 6,
  /** Fire or reassign: utilisation below this over a window of at least `idleMinDays` days in an empty queue. */
  lowUtilisation: 0.02,
  idleMinDays: 7,
  /** Reviewer quality score average at or below this over `minReviews` reviews on both card sizes. */
  lowScore: 2.5,
  minReviews: 3,
  /** A reviewer who bounces at least this share of at least `strictMinReviews` cards. */
  strictBounceRate: 0.8,
  strictMinReviews: 4,
} as const;

/** Models from light to strong. The model of an agent is a free-form string; the ladder matches by substring. */
export const MODEL_LADDER = ['haiku', 'sonnet', 'opus'] as const;

export function modelTier(model: string): number | null {
  const m = model.toLowerCase();
  const i = MODEL_LADDER.findIndex((t) => m.includes(t));
  return i < 0 ? null : i;
}

/** The model one step up (`delta` 1) or down (-1) the ladder, keeping any version suffix; null when none. */
export function shiftModel(model: string, delta: 1 | -1): string | null {
  const tier = modelTier(model);
  if (tier === null) return null;
  const next = MODEL_LADDER[tier + delta];
  if (!next) return null;
  return model.toLowerCase().replace(MODEL_LADDER[tier] as string, next);
}

export const REWORK_REASON_LABEL: Record<ReworkReason, string> = {
  missed_requirement: 'Missed requirement',
  broke_convention: 'Broke convention',
  weak_tests: 'No or weak tests',
  poor_structure: 'Poor structure',
  spec_unclear: 'Spec unclear',
  out_of_scope_test_change: 'Changed tests out of scope',
};

/** Everything except an unclear spec counts against the builder. */
export const countsAgainstBuilder = (reason: ReworkReason): boolean => reason !== 'spec_unclear';

/** Standing order proposed when a rework reason recurs. */
export const REWORK_STANDING_ORDER: Record<ReworkReason, string | null> = {
  missed_requirement:
    'Before handing off, walk through every acceptance criterion on the card and confirm your change meets it; name any you could not meet in the handoff note.',
  broke_convention:
    'Before handing off, compare your diff with the surrounding code and the repository conventions (naming, error handling, structure) and fix any deviation.',
  weak_tests:
    'Write or update tests together with every code change, run them before handing off, and say which test covers which acceptance criterion.',
  poor_structure:
    'Keep changes small and cohesive: reuse existing modules and helpers instead of adding parallel structures.',
  out_of_scope_test_change:
    'Do not edit existing unit tests outside the card scope; add new tests for new behaviour instead.',
  spec_unclear: null,
};

export const LEDGER_SEARCH_STANDING_ORDER =
  'Before asking the manager a question, search the ledger with at least two different phrasings (`aom ledger search`) and cite any entry that already answers it; ask only when nothing does.';

export const THIN_SPEC_STANDING_ORDER =
  'Business analysts: a spec leaves Spec only with at least two testable acceptance criteria, concrete affected areas and a test plan; ask the manager rather than guess.';

/** A spec is thin when it has fewer than two acceptance criteria or barely any requirements text. */
export function isThinSpec(fields: Record<string, unknown> | null | undefined): boolean {
  const f = fields ?? {};
  const criteria = Array.isArray(f.acceptanceCriteria) ? f.acceptanceCriteria.length : 0;
  const reqs = typeof f.requirements === 'string' ? f.requirements.trim().length : 0;
  return criteria < 2 || reqs < 40;
}

/** Desk `subkind` values the HR board introduces. */
export const HR_DESK_SUBKIND = {
  standingOrder: 'standing_order',
  scheduleFailed: 'schedule_failed',
} as const;

/** Themed name lists of the Hire form's generator. */
export const NAME_THEMES = [
  { id: 'default', label: 'Pioneers' },
  { id: 'birds', label: 'Birds' },
  { id: 'trees', label: 'Trees' },
  { id: 'rivers', label: 'Rivers' },
  { id: 'planets', label: 'Planets and moons' },
] as const;

/** Schedule retry backoff after a failed fire: 1 min, doubling, capped at 6 h. */
export function scheduleBackoffMs(attempts: number): number {
  return Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** Stopwords dropped when finding the topic shared by several questions. */
const STOP = new Set(
  (
    'a an and are as at be but by can could do does for from had has have how i if in into is it its my of on or ' +
    'our should so than that the their then there these they this to up us use using was we what when where which ' +
    'who why will with would you your not no yes need needs want shall must may might also just more some ' +
    'any all new old same other card cards task'
  ).split(' '),
);

export function topicWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP.has(w)),
    ),
  ];
}
