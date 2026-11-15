import { z } from 'zod';

/**
 * Owner-pending items of the review workflow: an item that waits for the owner (it timed out twice within its size budget,
 * it waits for the owner to start a review by hand, or it needs the owner's approval to spend past the daily cap). When the
 * owner has not acted for 2 working days, the owner is reminded once; the item itself stays "not reviewed".
 *
 * Size exception requests are deliberately not an owner-pending kind: they lapse after 2 working days without a reminder
 * (a separate timer), so they can never be registered here.
 */
export const OWNER_PENDING_KINDS = ['second_timeout', 'manual_trigger', 'over_cap_spend'] as const;
export const OwnerPendingKindSchema = z.enum(OWNER_PENDING_KINDS);
export type OwnerPendingKind = z.infer<typeof OwnerPendingKindSchema>;

/** Working days without owner action before the reminder. */
export const OWNER_PENDING_REMINDER_WORKING_DAYS = 2;

export const OWNER_PENDING_KIND_LABEL: Record<OwnerPendingKind, string> = {
  second_timeout: 'timed out twice and waits for your decision',
  manual_trigger: 'waits for you to start a review by hand',
  over_cap_spend: 'is over the daily review limit and waits for your approval of extra spend',
};

/** Desk subkind of the reminder (an alert, so the open-item chase never reminds about the reminder). */
export const OWNER_PENDING_REMINDER_SUBKIND = 'owner_pending_reminder';

export const RegisterOwnerPendingSchema = z.object({
  kind: OwnerPendingKindSchema,
  orgId: z.uuid(),
  projectId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  /** The item in the owning feature (a PR, a card + PR number): opaque to the timer. */
  subjectId: z.string().min(1).max(200),
  ownerUserId: z.uuid(),
  /** Shown on the reminder ("PR #42: add login"); no secrets, no content. */
  title: z.string().min(1).max(200),
  /** Same-origin path the reminder opens (the item's page); default: the reminder on the Desk. */
  url: z.string().startsWith('/').max(400).optional(),
  startedAt: z.date(),
});
export type RegisterOwnerPending = z.infer<typeof RegisterOwnerPendingSchema>;

export interface OwnerPendingTimerState {
  status: 'open' | 'resolved';
  dueAt: Date;
  remindedAt: Date | null;
}

/** The rule: remind once, when the timer is due and still open. Pure; replay-safe. */
export function ownerPendingAction(t: OwnerPendingTimerState, now: Date): 'remind' | null {
  if (t.status !== 'open') return null;
  if (t.remindedAt) return null;
  if (now.getTime() < t.dueAt.getTime()) return null;
  return 'remind';
}

export function ownerPendingReminderText(i: { title: string; kind: OwnerPendingKind }): {
  title: string;
  body: string;
} {
  return {
    title: `Still waiting for you: ${i.title}`,
    body: `${i.title} ${OWNER_PENDING_KIND_LABEL[i.kind]} for ${OWNER_PENDING_REMINDER_WORKING_DAYS} working days. It stays not reviewed until you act.`,
  };
}
