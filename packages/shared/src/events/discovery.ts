import { z } from 'zod';
import {
  AnswerSourceSchema,
  DiscoveryPhaseSchema,
  PanelSectionSchema,
  QuestionOptionSchema,
} from '../discovery/index.ts';
import { defineEvent, Id } from './define.ts';

const Author = z.object({
  kind: z.enum(['user', 'agent', 'persona', 'system']),
  id: z.string().max(80).nullable(),
  name: z.string().min(1).max(100),
});

/**
 * Discovery Studio (stream `thread-<threadId>`, organization scope). Questions, answers, panel notes and proposals are
 * projections of these events; the facilitation state (phase, pause, CEO pre-draft progress) lives in the thread's
 * `session_config`, written by `SessionThreadUpdated` and `DiscoveryPhaseChanged`/`DiscoveryPauseChanged`.
 */
export const discoveryEvents = [
  /** The facilitator asked a question. A question that is still open is withdrawn by the next one (one open at a time). */
  defineEvent(
    'DiscoveryQuestionAsked',
    z.object({
      threadId: Id,
      questionId: Id,
      turnId: Id.optional(),
      askedByName: z.string().min(1).max(100),
      question: z.string().min(1).max(1000),
      why: z.string().max(600).optional(),
      options: z.array(QuestionOptionSchema).max(6).default([]),
      allowFreeText: z.boolean().default(true),
      phase: z.string().max(40),
    }),
  ),
  defineEvent(
    'DiscoveryQuestionWithdrawn',
    z.object({ threadId: Id, questionId: Id, reason: z.string().max(300).optional() }),
  ),
  /** The CEO proposed an answer. It is only a proposal: the owner confirms, edits or overrides it. */
  defineEvent(
    'DiscoveryAnswerProposed',
    z.object({
      threadId: Id,
      questionId: Id,
      turnId: Id.optional(),
      text: z.string().max(4000),
      optionId: z.string().max(20).optional(),
      rationale: z.string().max(1000).optional(),
      by: z.object({
        kind: z.enum(['agent', 'persona']),
        id: z.string().max(80),
        name: z.string().min(1).max(100),
      }),
      mode: z.enum(['joint', 'ceo_prep']),
    }),
  ),
  /** The question is settled (answered, skipped or parked). `source` says whose words they are. */
  defineEvent(
    'DiscoveryQuestionAnswered',
    z.object({
      threadId: Id,
      questionId: Id,
      kind: z.enum(['pick', 'text', 'skip', 'park']),
      optionId: z.string().max(20).optional(),
      text: z.string().max(8000).optional(),
      source: AnswerSourceSchema,
      by: Id.nullable(),
    }),
  ),
  defineEvent(
    'DiscoveryNoteAdded',
    z.object({
      threadId: Id,
      noteId: Id,
      section: PanelSectionSchema,
      text: z.string().min(1).max(2000),
      by: Author,
    }),
  ),
  defineEvent(
    'DiscoveryNoteUpdated',
    z.object({
      threadId: Id,
      noteId: Id,
      text: z.string().min(1).max(2000).optional(),
      section: PanelSectionSchema.optional(),
      by: Author.optional(),
    }),
  ),
  defineEvent('DiscoveryNoteRemoved', z.object({ threadId: Id, noteId: Id })),
  /** A change the facilitator suggests. Nothing changes until the owner resolves it with Apply. */
  defineEvent(
    'DiscoveryProposalRaised',
    z.object({
      threadId: Id,
      proposalId: Id,
      turnId: Id.optional(),
      title: z.string().min(1).max(200),
      change: z.string().min(1).max(8000),
      rationale: z.string().min(1).max(2000),
      docId: Id.optional(),
      section: z.string().min(1).max(200).optional(),
      askedByName: z.string().min(1).max(100),
    }),
  ),
  defineEvent(
    'DiscoveryProposalResolved',
    z.object({
      threadId: Id,
      proposalId: Id,
      resolution: z.enum(['applied', 'rejected', 'redirected']),
      text: z.string().max(4000).optional(),
      by: Id.nullable(),
    }),
  ),
  defineEvent(
    'DiscoveryPhaseChanged',
    z.object({
      threadId: Id,
      from: DiscoveryPhaseSchema,
      to: DiscoveryPhaseSchema,
      by: Author,
      reason: z.string().max(400).optional(),
    }),
  ),
  /** Pause or resume. `elapsedMs` is the active time at that moment, so a paused session keeps its clock. */
  defineEvent(
    'DiscoveryPauseChanged',
    z.object({
      threadId: Id,
      paused: z.boolean(),
      elapsedMs: z.number().int().nonnegative(),
      by: Id.nullable(),
    }),
  ),
] as const;
