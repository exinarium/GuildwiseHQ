import { z } from 'zod';
import { defineEvent, Id, IsoDate } from './define.ts';

export const RecommendationKind = z.enum([
  'blocked_ledger',
  'blocked_topic',
  'blocked_thin_specs',
  'rework_reason',
  'model_up',
  'model_down',
  'split_role',
  'fire_idle',
  'fire_quality',
  'reviewer_strict',
]);
export type RecommendationKind = z.infer<typeof RecommendationKind>;

/** HR and scheduler-health events (M9). */
export const hrEvents = [
  /** A rule-based HR recommendation was applied with one click; the change itself is its own event in the same append. */
  defineEvent(
    'RecommendationApplied',
    z.object({
      orgId: Id,
      /** Stable key of the recommendation (`kind:subject`), also used to suppress it afterwards. */
      recommendationId: z.string().min(1),
      kind: RecommendationKind,
      agentId: Id.optional(),
      appliedBy: Id,
      effect: z.string(),
      deskItemId: Id.optional(),
    }),
  ),
  /**
   * A due schedule could not emit its card (for example a regression schedule on a project without a repo). The
   * scheduler backs off instead of retrying every tick: `nextFireAt` is the retry time. The first failure of a streak
   * also raises one desk notice (`deskItemId`); it is resolved when the schedule next fires.
   */
  defineEvent(
    'ScheduleFireFailed',
    z.object({
      scheduleId: Id,
      error: z.string(),
      attempts: z.number().int().positive(),
      nextFireAt: IsoDate,
      deskItemId: Id.optional(),
    }),
  ),
] as const;
