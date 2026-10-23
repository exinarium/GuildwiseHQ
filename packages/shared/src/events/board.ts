import { z } from 'zod';
import {
  BoardFormatSchema,
  BoardModelsSchema,
  BoardRoundKindSchema,
  CastMemberSchema,
  StickyColumnSchema,
} from '../boardroom/index.ts';
import { defineEvent, Id } from './define.ts';

const Author = z.object({
  kind: z.enum(['user', 'agent', 'persona', 'system']),
  id: z.string().max(80).nullable(),
  name: z.string().min(1).max(100),
});

/**
 * Boardroom (stream `thread-<threadId>`, organization scope). The whiteboard, the rounds, the recorded disagreements and the
 * decision points are projections of these events; the session state (stage, round, pause, mentions) lives in the thread's
 * `session_config`, written by `SessionThreadUpdated`. Saved rooms live on the organization's `board-rooms-<orgId>` stream.
 */
export const boardEvents = [
  /** The Chair (or the server, when the Chair gave no usable pick) planned a round: who speaks and why. */
  defineEvent(
    'BoardRoundPlanned',
    z.object({
      threadId: Id,
      round: z.number().int().min(1),
      kind: BoardRoundKindSchema,
      speakers: z.array(z.object({ participantId: Id, name: z.string().min(1).max(100) })).min(1),
      reason: z.string().max(600).default(''),
      instruction: z.string().max(1000).default(''),
      source: z.enum(['independent', 'chair', 'fallback']),
      turnId: Id.optional(),
    }),
  ),
  defineEvent(
    'BoardNoteAdded',
    z.object({
      threadId: Id,
      noteId: Id,
      column: StickyColumnSchema,
      text: z.string().min(1).max(600),
      by: Author,
      round: z.number().int().nullable().default(null),
      turnId: Id.optional(),
    }),
  ),
  defineEvent(
    'BoardNoteUpdated',
    z.object({
      threadId: Id,
      noteId: Id,
      text: z.string().min(1).max(600).optional(),
      column: StickyColumnSchema.optional(),
    }),
  ),
  /** `noteIds` are folded into `intoNoteId`: their votes are added up, their texts kept in `mergedFrom`, and they disappear. */
  defineEvent(
    'BoardNoteMerged',
    z.object({
      threadId: Id,
      intoNoteId: Id,
      noteIds: z.array(Id).min(1).max(12),
      text: z.string().min(1).max(600).optional(),
      mergedTexts: z.array(z.string().max(600)).max(12).default([]),
    }),
  ),
  defineEvent('BoardNoteRemoved', z.object({ threadId: Id, noteId: Id })),
  /** +1 from a person; `voted: false` takes it back. */
  defineEvent('BoardNoteVoted', z.object({ threadId: Id, noteId: Id, userId: Id, voted: z.boolean() })),
  defineEvent(
    'BoardDisagreementRecorded',
    z.object({
      threadId: Id,
      disagreementId: Id,
      topic: z.string().min(1).max(300),
      positions: z
        .array(z.object({ who: z.string().min(1).max(100), position: z.string().min(1).max(600) }))
        .min(2),
      round: z.number().int().nullable().default(null),
      by: Author,
    }),
  ),
  /** The Chair stopped at a decision only the owner can take. */
  defineEvent(
    'BoardDecisionRaised',
    z.object({
      threadId: Id,
      decisionId: Id,
      question: z.string().min(1).max(600),
      options: z
        .array(z.object({ id: z.string().min(1).max(20), label: z.string().min(1).max(200) }))
        .max(6)
        .default([]),
      round: z.number().int().nullable().default(null),
      askedByName: z.string().min(1).max(100),
    }),
  ),
  defineEvent(
    'BoardDecisionResolved',
    z.object({
      threadId: Id,
      decisionId: Id,
      answer: z.string().max(4000).default(''),
      optionId: z.string().max(20).optional(),
      /** The session ended while the decision was open: it is withdrawn, not answered. */
      withdrawn: z.boolean().optional(),
      by: Id.nullable(),
    }),
  ),
  /** A saved cast ("room"), reusable for new boardrooms. */
  defineEvent(
    'BoardRoomSaved',
    z.object({
      roomId: Id,
      orgId: Id,
      name: z.string().min(1).max(100),
      format: BoardFormatSchema,
      roundCap: z.number().int().min(1).max(12),
      cast: z.array(CastMemberSchema).min(1).max(8),
      models: BoardModelsSchema.default({}),
      createdBy: Id,
    }),
  ),
  defineEvent('BoardRoomDeleted', z.object({ roomId: Id, orgId: Id })),
] as const;
