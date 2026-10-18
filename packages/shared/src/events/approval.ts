import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/**
 * Approval steps (backlog #16): a `human` stage with `purpose: 'approval'`. When a card reaches it the server asks the
 * approver on the desk (`ApprovalRequested`); the decision (`ApprovalDecided`) is appended together with the
 * `StageCompleted` that moves the card (approve: the next step; send back: the earlier step, as rework).
 */
export const ApprovalApproverKind = z.enum(['org_owner', 'project_owner', 'starter', 'member']);
export type ApprovalApproverKind = z.infer<typeof ApprovalApproverKind>;

export const approvalEvents = [
  defineEvent(
    'ApprovalRequested',
    z.object({
      cardId: Id,
      stageId: z.string().min(1),
      approverUserId: Id,
      approverKind: ApprovalApproverKind,
      /** The named approver could not be used (left the project): the Owner was asked instead. */
      fellBack: z.boolean().optional(),
      deskItemId: Id,
      /** The event that brought the card into the step: one request per entry. */
      entrySeq: z.string().optional(),
      /** lean team: the commit whose diff the approver is shown; the approval is bound to it. */
      sha: z.string().max(64).optional(),
    }),
  ),
  defineEvent(
    'ApprovalDecided',
    z.object({
      cardId: Id,
      stageId: z.string().min(1),
      decision: z.enum(['approved', 'sent_back']),
      by: Id,
      note: z.string().max(10000).optional(),
      /** The stage the card moves to. */
      toStage: z.string().min(1),
      deskItemId: Id.optional(),
      /** lean team: the commit an approval is for. */
      sha: z.string().max(64).optional(),
    }),
  ),
] as const;
