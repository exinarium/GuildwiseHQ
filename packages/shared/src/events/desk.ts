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
      /** Part B: held for the BA's triage until `deadline` (non-urgent questions of the DevOps engineer). */
      triage: z.object({ deadline: z.iso.datetime() }).optional(),
      /** Structured data the answer handler needs (the working-branch question: repo and reason). */
      data: z.record(z.string(), z.unknown()).optional(),
      /** Org-level questions (the DevOps engineer's) addressed to one user. */
      addresseeUserId: Id.optional(),
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
        /** The ledger entry the answer was recorded as (agents' answers: feature scope; the manager's: their choice). */
        ledgerEntryId: Id.optional(),
        /** Blocked cards that return to the queue (no other open blocker). */
        unblockedCardIds: z.array(Id).default([]),
      })
      // The manager's answers always carry their ledger entry id (an agent's in the chain may predate it).
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
      /** Part B: the item is held for the BA's triage until `deadline`; the manager does not see it before. */
      triage: z.object({ deadline: z.iso.datetime() }).optional(),
      /** Part B: structured data a renderer needs (the floor report's digest). */
      data: z.record(z.string(), z.unknown()).optional(),
      /** Part B: the standing BA chat thread the report links to. */
      chatThreadId: Id.optional(),
      /** Org-level items addressed to one user (DevOps, vault conflict, workstation bottleneck): only they and the org's Owner and Admins see it. */
      addresseeUserId: Id.optional(),
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
