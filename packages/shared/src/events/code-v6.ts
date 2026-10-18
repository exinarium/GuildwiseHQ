import { z } from 'zod';
import { E2eAreaMapSchema, OwnerApprovalPolicySchema } from '../cards/lean-v6.ts';
import { defineEvent, Id, IsoDate, Stage } from './define.ts';

/**
 * Lean Team v3, workflow lean team (stream S3). All additive: events of other domains keep their meaning, and the optional
 * fields this stream added to `ReviewRequested`, `ReviewApproved`, `ChangesRequested`, `ApprovalRequested` and
 * `ApprovalDecided` are absent from older events.
 */
export const GroupIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a group id is letters, digits, dot, dash and underscore');

export const codeV6Events = [
  /** The planner or architect put the card in a group (`null`: out of it). Cards of one group go to one builder. */
  defineEvent(
    'CardGroupSet',
    z.object({ cardId: Id, groupId: GroupIdSchema.nullable(), agentId: Id.optional(), by: Id.optional() }),
  ),
  /** The Card Brief: the short summary the planner or architect writes for the builder (the server never rewrites it). */
  defineEvent(
    'CardBriefSet',
    z.object({ cardId: Id, brief: z.string().trim().min(1).max(4000), agentId: Id.optional() }),
  ),
  /** The first builder of a group keeps the rest of the group (a hard dispatch clause) until `until`. */
  defineEvent(
    'GroupBuilderAssigned',
    z.object({ projectId: Id, groupId: GroupIdSchema, agentId: Id, cardId: Id, until: IsoDate }),
  ),
  defineEvent(
    'GroupBuilderCleared',
    z.object({ projectId: Id, groupId: GroupIdSchema, reason: z.string().max(200).default('expired') }),
  ),
  /** The commit a card branch is at, as the runner measured it (shift start, after a rebase, after a bug fix). */
  defineEvent(
    'CardHeadObserved',
    z.object({
      cardId: Id,
      sha: z.string().min(7).max(64),
      source: z.enum(['shift_start', 'rebase', 'bugfix', 'conflict', 'docs']),
      /** The commit it was at before (a clean rebase carries the build evidence and approvals over to `sha`). */
      from: z.string().min(7).max(64).optional(),
    }),
  ),
  /** A review shift found the branch at another commit than the build evidence: back to Build with fresh evidence due. */
  defineEvent(
    'EvidenceLapsed',
    z.object({ cardId: Id, stage: Stage, expectedSha: z.string(), actualSha: z.string() }),
  ),
  /** The owner's approval is for another commit than the branch is at now: the card returns to the approval step. */
  defineEvent(
    'OwnerApprovalLapsed',
    z.object({ cardId: Id, approvedSha: z.string(), actualSha: z.string(), fromStage: Stage }),
  ),
  /** The server-run Test deploy stage finished: the environment is healthy at the reviewed commit, or none applies. */
  defineEvent(
    'TestDeployResolved',
    z.object({
      cardId: Id,
      result: z.enum(['healthy', 'skipped']),
      reason: z.string().max(500).default(''),
      envId: Id.optional(),
      sha: z.string().max(64).optional(),
    }),
  ),
  /** Owner approval policy of a project (default: the owner approves large and high-risk cards). */
  defineEvent(
    'ProjectOwnerApprovalSet',
    z.object({ projectId: Id, policy: OwnerApprovalPolicySchema, by: Id }),
  ),
  /** The project's mapping of changed paths to E2E specs (`null`: the default derived from the E2E folders). */
  defineEvent(
    'ProjectE2eAreasSet',
    z.object({ projectId: Id, mapping: E2eAreaMapSchema.nullable(), by: Id }),
  ),
  /**
   * The merge at Finalize conflicted and the approvals stand: the card stays in Finalize (parked on DevOps' attempt, which
   * works in a scratch worktree) instead of going back to Build; nothing is merging any more.
   */
  defineEvent('FinalizeConflictHeld', z.object({ cardId: Id })),
  /**
   * DevOps resolved a merge conflict at Finalize in a scratch worktree. `mergeOnly`: the resolution touched no reviewed lines
   * beyond the merge, so the earlier approvals stay and the card goes to a merge review; else it is re-reviewed from Build.
   */
  defineEvent(
    'ConflictResolutionRecorded',
    z.object({
      cardId: Id,
      requestId: Id,
      /** Decided by the merge reviewer reading the resolution; absent when recorded before that. */
      mergeOnly: z.boolean().optional(),
      oldHead: z.string().max(64).optional(),
      newHead: z.string().max(64).optional(),
      touched: z.array(z.string().max(500)).max(200).default([]),
    }),
  ),
] as const;
