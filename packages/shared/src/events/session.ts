import { z } from 'zod';
import { DelegateOutcomeSchema } from '../delegate/index.ts';
import { ModelChoiceSchema } from '../models/choices.ts';
import { ParticipantKindSchema, SessionContextSchema, SessionThreadKindSchema } from '../sessions/index.ts';
import { defineEvent, Id, Usage } from './define.ts';

/**
 * Multi-participant sessions (stream `thread-<threadId>` for the thread and its participants, `session-turn-<turnId>`
 * for the durable turns). Threads of kind `discovery` and `boardroom` only; chat, card and CEO threads never use these.
 */
export const sessionEvents = [
  defineEvent(
    'SessionThreadCreated',
    z.object({
      threadId: Id,
      kind: SessionThreadKindSchema,
      title: z.string().min(1).max(200),
      createdBy: Id,
      projectId: Id.optional(),
      /** The host agent of the session (the facilitator, e.g. the analyst), when it has one. */
      agentId: Id.optional(),
      /** Where the turns run unless a turn says otherwise. */
      workstationId: Id.optional(),
      /** Free-form session state owned by the facilitator logic (phase, stance, time box, ...). */
      config: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  /** Title and/or config (merged key by key; a null value removes the key). */
  defineEvent(
    'SessionThreadUpdated',
    z.object({
      threadId: Id,
      title: z.string().min(1).max(200).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      workstationId: Id.optional(),
    }),
  ),
  defineEvent(
    'ThreadParticipantAdded',
    z.object({
      threadId: Id,
      participantId: Id,
      kind: ParticipantKindSchema,
      refId: z.string().min(1).max(80),
      seat: z.string().min(1).max(60),
      stance: z.string().max(500).optional(),
      displayName: z.string().min(1).max(100),
    }),
  ),
  defineEvent(
    'ThreadParticipantUpdated',
    z.object({
      threadId: Id,
      participantId: Id,
      seat: z.string().min(1).max(60).optional(),
      stance: z.string().max(500).optional(),
    }),
  ),
  defineEvent('ThreadParticipantRemoved', z.object({ threadId: Id, participantId: Id })),

  // ----------------------------------------------------------------------------------------------- durable turns
  /** A turn is persisted before it is sent: a restart or an offline workstation never loses it. */
  defineEvent(
    'SessionTurnQueued',
    z.object({
      turnId: Id,
      threadId: Id,
      orgId: Id,
      participantId: Id,
      speaker: z.object({
        kind: z.enum(['agent', 'persona']),
        name: z.string().min(1).max(100),
        agentId: Id.optional(),
        personaKey: z.string().max(80).optional(),
        seat: z.string().max(60).optional(),
      }),
      /** The persona text; absent for a stored persona the runner resolves from its registry, or an agent's own role. */
      instructions: z.string().max(40_000).optional(),
      /** What the speaker is asked to do. */
      message: z.string().min(1).max(20_000),
      /** Which messages of the thread it sees. */
      context: SessionContextSchema,
      model: ModelChoiceSchema,
      workstationId: Id,
      replyToMessageId: Id.optional(),
      round: z.number().int().optional(),
      requestedBy: Id.nullable(),
      /** What the turn is for (set by the Discovery orchestrator): `{purpose: 'facilitator'|'ceo_answer', questionId?, ...}`. */
      meta: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  /** The turn was sent to the workstation. Appended again for each re-dispatch after `SessionTurnRequeued`. */
  defineEvent(
    'SessionTurnStarted',
    z.object({ turnId: Id, threadId: Id, workstationId: Id, attempt: z.number().int().min(1) }),
  ),
  /** The workstation no longer holds a started turn (restart, lost connection): it goes back to the queue. */
  defineEvent(
    'SessionTurnRequeued',
    z.object({ turnId: Id, threadId: Id, reason: z.string().max(300), workstationId: Id.optional() }),
  ),
  /** The reply is stored as `messageId` (a `ThreadMessagePosted` in the same append). */
  defineEvent(
    'SessionTurnCompleted',
    z.object({
      turnId: Id,
      threadId: Id,
      messageId: Id,
      usage: Usage,
      /** Price stamped when the event was appended (like `ShiftEnded.costMicros`), so a rebuild never reprices it. */
      costMicros: z.number().int().nonnegative().optional(),
      /** The model has no price in the tables (a direct-model provider's unlisted model): `costMicros` is 0 and the cost is unknown, not zero. */
      costUnknown: z.boolean().optional(),
      runtimeSessionId: z.string().max(200).optional(),
    }),
  ),
  /**
   * A nested `aom delegate` call ended (stream `delegate-<id>`). Its usage is booked under the caller: a session turn or a
   * shift (`shift_costs` kind `delegate`, `parent_id` = the caller), so the session's and the project's meters count it.
   */
  defineEvent(
    'DelegateCompleted',
    z.object({
      delegateId: Id,
      callerKind: z.enum(['session_turn', 'shift']),
      callerId: Id,
      /** The session of a `session_turn` caller (so the session page refreshes its cost meter). */
      threadId: Id.optional(),
      personaKey: z.string().max(120),
      usage: Usage,
      outcome: DelegateOutcomeSchema,
      durationMs: z.number().int().nonnegative().optional(),
      /** Stamped when appended, like `SessionTurnCompleted.costMicros`. */
      costMicros: z.number().int().nonnegative().optional(),
      costUnknown: z.boolean().optional(),
    }),
  ),
  defineEvent(
    'SessionTurnFailed',
    z.object({ turnId: Id, threadId: Id, error: z.string().max(500), workstationId: Id.optional() }),
  ),
] as const;
