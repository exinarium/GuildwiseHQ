import { z } from 'zod';
import { defineEvent, Id, Note } from './define.ts';
import { ChainLevel as ChainLevelSchema } from './intake.ts';

export const DeskItemKind = z.enum(['question', 'approval', 'escalation', 'alert', 'rating']);
export type DeskItemKind = z.infer<typeof DeskItemKind>;

export const DeskItemStatus = z.enum(['open', 'answered', 'dismissed', 'superseded']);
export type DeskItemStatus = z.infer<typeof DeskItemStatus>;

export const DeskOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type DeskOption = z.infer<typeof DeskOptionSchema>;

export const DeskActorSchema = z.object({
  kind: z.enum(['agent', 'user', 'system']),
  agentId: Id.optional(),
  userId: Id.optional(),
  /** Role key of the asking agent (builder, reviewer, ...). */
  role: z.string().optional(),
});
export type DeskActor = z.infer<typeof DeskActorSchema>;

export const DeskResolution = z.enum(['approved', 'rejected', 'acknowledged', 'dismissed']);
export type DeskResolution = z.infer<typeof DeskResolution>;

/** Option ids minted for `aom question --option` labels: `o1`, `o2`, ... (recommendation refers to one of them). */
export const optionId = (index: number): string => `o${index + 1}`;

export const deskEvents = [
  defineEvent(
    'QuestionRaised',
    z.object({
      deskItemId: Id,
      cardId: Id.optional(),
      projectId: Id.optional(),
      /** Shift that raised the question (blocking questions end it). */
      shiftId: Id.optional(),
      askedBy: DeskActorSchema,
      /** What the asker was doing when the question came up. */
      doing: z.string().default(''),
      question: Note,
      options: z.array(DeskOptionSchema).default([]),
      /** Option id. */
      recommendation: z.string().optional(),
      blocking: z.boolean(),
      routedTo: z.enum(['manager', 'agent']).default('manager'),
      routedAgentId: Id.optional(),
      dedupLedgerIds: z.array(Id).default([]),
      /** The asking card plus the open cards that depend on it. */
      affectedCardIds: z.array(Id).default([]),
      /** Blocking questions are pinned to the top of the desk. */
      pinned: z.boolean().default(false),
      /** M7: `unmapped_ticket` for the mapping question of an intake. */
      subkind: z.string().optional(),
      /** M7: where in the escalation chain the question starts (default: the desk). */
      chainLevel: ChainLevelSchema.optional(),
    }),
  ),
  defineEvent(
    'QuestionEscalated',
    z.object({
      deskItemId: Id,
      fromAgentId: Id.optional(),
      routedTo: z.enum(['manager', 'agent']),
      routedAgentId: Id.optional(),
      note: z.string(),
      /** M7: the step the question moves to. */
      chainLevel: ChainLevelSchema.optional(),
    }),
  ),
  defineEvent(
    'QuestionAnswered',
    z
      .object({
        deskItemId: Id,
        answer: Note,
        answerOption: z.string().optional(),
        answeredBy: DeskActorSchema,
        /** Absent when an agent (not the manager) answered: only the manager's answers become ledger entries. */
        ledgerEntryId: Id.optional(),
        /** Blocked cards that return to the queue (no other open blocker). */
        unblockedCardIds: z.array(Id).default([]),
      })
      // The manager's answers always become a ledger entry; an agent's (M7 escalation chain) do not.
      .refine((p) => p.answeredBy.kind !== 'user' || p.ledgerEntryId !== undefined, {
        message: 'a manager answer needs its ledger entry id',
        path: ['ledgerEntryId'],
      }),
  ),
  defineEvent(
    'DeskItemCreated',
    z.object({
      deskItemId: Id,
      kind: z.enum(['approval', 'escalation', 'alert', 'rating']),
      subkind: z.string().optional(),
      title: z.string().min(1),
      body: z.string().default(''),
      options: z.array(DeskOptionSchema).default([]),
      recommendation: z.string().optional(),
      blocking: z.boolean().default(false),
      pinned: z.boolean().default(false),
      cardId: Id.optional(),
      projectId: Id.optional(),
      affectedCardIds: z.array(Id).default([]),
      askedBy: DeskActorSchema.optional(),
    }),
  ),
  defineEvent(
    'DeskItemResolved',
    z.object({
      deskItemId: Id,
      resolution: DeskResolution,
      note: z.string().optional(),
      editedBody: z.string().optional(),
      by: DeskActorSchema,
    }),
  ),
] as const;
