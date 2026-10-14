import { z } from 'zod';
import { IsoTime } from './common.ts';

/**
 * An approval step on a card (backlog #16). `state`: `open` while the approver has not decided, `approved` when the card
 * moved on, `sent_back` while it is back with the earlier step.
 */
export const CardApprovalSchema = z.object({
  state: z.enum(['open', 'approved', 'sent_back']),
  stageId: z.string(),
  stageLabel: z.string(),
  approver: z.object({ userId: z.uuid(), name: z.string(), avatarSeed: z.string().nullable().optional() }),
  /** How the approver was chosen: the step's setting, or the Owner because the named person was not available. */
  approverKind: z.enum(['org_owner', 'project_owner', 'starter', 'member']),
  fellBack: z.boolean(),
  openedAt: IsoTime,
  /** Where an approval leads and where a send back goes, by the labels of the steps. */
  approveTo: z.string().nullable(),
  sendBackTo: z.string().nullable(),
  decision: z
    .object({
      kind: z.enum(['approved', 'sent_back']),
      byName: z.string(),
      note: z.string().nullable(),
      at: IsoTime,
    })
    .nullable(),
  sentBackCount: z.number().int(),
  /** The viewer may approve or send back (the approver, the organization's Owner and Admins, the project owner). */
  canAct: z.boolean(),
  deskItemId: z.uuid().nullable(),
});
export type CardApproval = z.infer<typeof CardApprovalSchema>;

/** `POST /api/cards/:id/approval/approve` */
export const ApprovalApproveRequestSchema = z.object({ note: z.string().trim().max(5000).optional() });
export type ApprovalApproveRequest = z.infer<typeof ApprovalApproveRequestSchema>;
/** `POST /api/cards/:id/approval/send-back`: the comment is required; the earlier step reads it as a review comment. */
export const ApprovalSendBackRequestSchema = z.object({ comment: z.string().trim().min(1).max(10000) });
export type ApprovalSendBackRequest = z.infer<typeof ApprovalSendBackRequestSchema>;
