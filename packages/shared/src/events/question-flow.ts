import { z } from 'zod';
import { StopLossSettingsSchema } from '../questions/index.ts';
import { defineEvent, Id } from './define.ts';

/** Lean Team v3 (stream S1a): waiting questions, card affinity and the stop-loss setting. All additive. */
export const questionFlowEvents = [
  /**
   * A waiting question (`aom question --wait`, raised non-blocking so the shift stayed alive) ran out of time: it is now a
   * blocking question and the card is parked on it. The claim is released by the event that follows.
   */
  defineEvent('QuestionMadeBlocking', z.object({ deskItemId: Id, cardId: Id })),
  /** Only `agentId` may claim the card until `until` (it asked a question, or it is the builder the review findings go back to). */
  defineEvent(
    'CardAffinitySet',
    z.object({
      cardId: Id,
      agentId: Id,
      /** The Claude session to resume, when the runner reported one. */
      sessionId: z.string().optional(),
      until: z.iso.datetime(),
      reason: z.enum(['question', 'review']),
      /** The desk item whose answer is the first message of the resumed session. */
      deskItemId: Id.optional(),
    }),
  ),
  defineEvent('CardAffinityCleared', z.object({ cardId: Id, reason: z.string().default('expired') })),
  /** The project's stop-loss budget (passes, rounds and shifts by card size). */
  defineEvent(
    'ProjectStopLossSet',
    z.object({ projectId: Id, settings: StopLossSettingsSchema.nullable(), by: Id.optional() }),
  ),
] as const;
