/**
 * Follow-up and chase (S-B2): an item on the Desk (digest ratings included) that is still open after N days nudges its owner
 * once, then waits another N days; an item that sits with an agent is handed back to the agent once. The organization sets N.
 */
export const FOLLOW_UP_DEFAULT_DAYS = 3;
export const FOLLOW_UP_MAX_DAYS = 30;
/** `0` turns the chase off for the organization. */
export const FOLLOW_UP_OFF = 0;
export const SNOOZE_MAX_DAYS = 14;
const DAY_MS = 86_400_000;

export interface FollowUpState {
  /** When the item was put on the desk. */
  openedAt: Date;
  /** The last nudge (or re-queue); null when never. */
  lastNudgeAt: Date | null;
  nudgeCount: number;
  snoozedUntil: Date | null;
  routedTo: 'manager' | 'agent';
}

export type FollowUpAction = 'nudge' | 'requeue' | null;

/**
 * What the sweep does with one open item. Pure and replay-safe: the answer depends only on the item's recorded state and the
 * clock, and a second sweep right after sees the nudge it just recorded.
 */
/** An item nudges its owner at most this often in all; after that it waits in the list without more pushes. */
export const FOLLOW_UP_MAX_NUDGES = 3;
/** A person may snooze one item at most this many times. */
export const FOLLOW_UP_MAX_SNOOZES = 5;

export function followUpAction(s: FollowUpState, now: Date, days: number): FollowUpAction {
  if (days <= FOLLOW_UP_OFF) return null;
  const window = days * DAY_MS;
  if (s.snoozedUntil && s.snoozedUntil.getTime() > now.getTime()) return null;
  // the clock for the next nudge starts at the later of the opening and the last nudge; a snooze only holds nudges back
  const since = Math.max(s.openedAt.getTime(), s.lastNudgeAt?.getTime() ?? 0);
  if (now.getTime() - since < window) return null;
  if (s.routedTo === 'agent') return s.nudgeCount === 0 ? 'requeue' : null;
  return s.nudgeCount >= FOLLOW_UP_MAX_NUDGES ? null : 'nudge';
}

export function clampFollowUpDays(n: number): number {
  return Math.min(FOLLOW_UP_MAX_DAYS, Math.max(FOLLOW_UP_OFF, Math.trunc(n)));
}

/** Desk kinds the chase covers: things somebody has to decide, answer or rate. Alerts and reports are not chased. */
export const FOLLOW_UP_KINDS = ['question', 'approval', 'escalation', 'rating'] as const;
/** Subkinds that are reports even when their kind is a question: never chased. */
export const FOLLOW_UP_SKIP_SUBKINDS = ['floor_report', 'ba_report', 'ceo_notice', 'ceo_decision'] as const;

export function followUpNudgeText(i: { title: string; ageDays: number; cardRef?: string | null }): {
  title: string;
  body: string;
} {
  const age = i.ageDays <= 1 ? 'a day' : `${i.ageDays} days`;
  return {
    title: i.cardRef ? `Still open on ${i.cardRef}` : 'Still waiting for you',
    body: `${i.title} has been open for ${age}.`,
  };
}
