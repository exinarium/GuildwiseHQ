import { z } from 'zod';
import { AccountKeySchema } from '../claude/accounts.ts';
import { defineEvent, Id } from './define.ts';

/** Where an intake's ticket lives. Inbound access is read-only (docs/SPEC.md "External systems boundary"). */
export const ExternalSystem = z.enum(['jira', 'github']);
export type ExternalSystem = z.infer<typeof ExternalSystem>;

/** Steps of the escalation chain (docs/ARCHITECTURE.md section 15): a senior of the same role or the previous holder, then the BA, then the desk. */
/** `ceo`: the organization's CEO sits between the BA and the manager's desk (Lean Team v3). */
export const ChainLevel = z.enum(['peer', 'ba', 'ceo', 'desk']);
export type ChainLevel = z.infer<typeof ChainLevel>;

export const intakeEvents = [
  /** The manager opened an intake chat with the BA (thread `kind 'intake'`, created by this event). */
  defineEvent(
    'IntakeStarted',
    z.object({
      intakeId: Id,
      threadId: Id,
      externalSystem: ExternalSystem.optional(),
      externalKey: z.string().min(1).max(200).optional(),
      startedBy: Id,
      baAgentId: Id,
      /** What the manager typed (free text, or the ticket key). */
      note: z.string().max(20000).optional(),
      /**
       * `chat`: the BA turned an existing chat (`threadId`, kind 'chat') into an intake the first time it created a
       * card there. The thread already exists and keeps its kind; there is no external ticket.
       */
      source: z.literal('chat').optional(),
      /** Documents (a PRD handed over from a discovery session) the BA's cards link to (`fields.linkedDocIds`). */
      linkedDocIds: z.array(Id).max(10).optional(),
    }),
  ),
  /**
   * The BA mapped the intake to a project (`projectId`), linked a card it drafted (`cardId`), or could not map the
   * ticket (`unmapped`, with the desk question that asks the manager).
   */
  defineEvent(
    'TicketMapped',
    z.object({
      intakeId: Id,
      projectId: Id.optional(),
      cardId: Id.optional(),
      unmapped: z.boolean(),
      deskItemId: Id.optional(),
    }),
  ),
  /**
   * A question that matches another open question of the project (same project, high similarity) was attached to it
   * instead of becoming a second item: the cards it blocks now wait on `intoDeskItemId`, and answering that one
   * unblocks them all.
   */
  defineEvent(
    'QuestionMerged',
    z.object({
      deskItemId: Id,
      intoDeskItemId: Id,
      fromAgentId: Id.optional(),
      note: z.string().default(''),
    }),
  ),
  /** A `question` shift for the agent a desk item is routed to (no card claim, no worktree). */
  defineEvent(
    'QuestionShiftDispatched',
    z.object({
      deskItemId: Id,
      shiftId: Id,
      agentId: Id,
      workstationId: Id,
      /** The Claude account the shift runs on; absent = main. */
      accountKey: AccountKeySchema.optional(),
    }),
  ),
] as const;
