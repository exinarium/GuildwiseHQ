import { z } from 'zod';
import { IsoTime } from './common.ts';

/**
 * An approval step on a card (backlog #16). `state`: `open` while the approver has not decided, `approved` when the card
 * moved on, `sent_back` while it is back with the earlier step.
 */
/**
 * What the owner approval step of code-v6 shows besides the buttons: the commit the approval is for, why it is needed, the
 * stored diff (the view loads it from `GET /api/cards/:id/diff`), the builder's evidence and the review verdicts.
 */
export const ApprovalReviewInfoSchema = z.object({
  /** The commit the approval is bound to (the one whose diff is shown); null when none was recorded. */
  sha: z.string().nullable(),
  /** The branch moved after the diff was shown: an approval is refused until the card is asked again. */
  stale: z.boolean(),
  highRisk: z.boolean(),
  highRiskPaths: z.array(z.string()),
  riskTier: z.string().nullable(),
  /** Why the owner approves (large, high risk, the project asks for every change). */
  reason: z.string().nullable(),
  diff: z.object({ bytes: z.number().int(), truncated: z.boolean(), files: z.number().int() }).nullable(),
  evidence: z
    .object({
      commands: z.array(
        z.object({ kind: z.string(), command: z.string(), status: z.string(), result: z.string() }),
      ),
      waived: z.string().nullable(),
    })
    .nullable(),
  verdicts: z.array(
    z.object({
      reviewerName: z.string(),
      score: z.number().int(),
      risk: z.string().nullable(),
      comments: z.string(),
    }),
  ),
  /** The architect's design summary (the card's investigation) and the Card Brief. */
  designSummary: z.string().nullable(),
  cardBrief: z.string().nullable(),
});
export type ApprovalReviewInfo = z.infer<typeof ApprovalReviewInfoSchema>;

/** `GET /api/cards/:id/diff`: the unified diff stored at the review handoff (capped at 2 MB). */
export const CardDiffResponseSchema = z.object({
  sha: z.string(),
  base: z.string(),
  body: z.string(),
  bytes: z.number().int(),
  truncated: z.boolean(),
  files: z.number().int(),
  at: IsoTime,
});
export type CardDiffResponse = z.infer<typeof CardDiffResponseSchema>;

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
  /** code-v6: the owner approval's review information (absent for an approval step of the older workflows). */
  review: ApprovalReviewInfoSchema.optional(),
});
export type CardApproval = z.infer<typeof CardApprovalSchema>;

/** `POST /api/cards/:id/approval/approve` */
export const ApprovalApproveRequestSchema = z.object({
  note: z.string().trim().max(5000).optional(),
  /**
   * code-v6: the commit whose diff the approver was shown. When it is not the card's head commit the approval is refused
   * (409 `approval_stale`) and nothing is approved. Absent: only the commit the approval was asked for is checked.
   */
  sha: z.string().trim().min(4).max(64).optional(),
});
export type ApprovalApproveRequest = z.infer<typeof ApprovalApproveRequestSchema>;
/** `POST /api/cards/:id/approval/send-back`: the comment is required; the earlier step reads it as a review comment. */
export const ApprovalSendBackRequestSchema = z.object({ comment: z.string().trim().min(1).max(10000) });
export type ApprovalSendBackRequest = z.infer<typeof ApprovalSendBackRequestSchema>;
