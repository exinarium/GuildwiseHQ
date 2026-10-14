import { z } from 'zod';
import { IsoTime } from './common.ts';

/**
 * Manual QA on a card (docs/design/manual-qa.md). `state`: `steps` while an agent writes the test steps, `open` while
 * the person tests, `passed` / `skipped` when it ended in done, `sent_back` while the card is back in rework.
 */
export const CardQaSchema = z.object({
  state: z.enum(['steps', 'open', 'passed', 'skipped', 'sent_back']),
  assignee: z.object({ userId: z.uuid(), name: z.string(), avatarSeed: z.string().nullable().optional() }),
  /** How the assignee was chosen. */
  source: z.enum(['starter', 'owner', 'project_owner', 'reassigned']),
  openedAt: IsoTime,
  /** The agent's test steps (markdown); null until posted (or when no agent could write them). */
  steps: z.string().nullable(),
  stepsBy: z.string().nullable().optional(),
  /** The last decision: who, what and the note (null while open). */
  decision: z
    .object({
      kind: z.enum(['passed', 'skipped', 'sent_back']),
      byName: z.string(),
      note: z.string().nullable(),
      at: IsoTime,
    })
    .nullable(),
  /** Times the card was sent back from QA (each one is a rework round). */
  sentBackCount: z.number().int(),
  /** An outgoing ticket comment is held until QA passes or is skipped. */
  heldComment: z.object({ kind: z.string(), externalKey: z.string(), body: z.string() }).nullable(),
  /** The viewer may pass, skip, send back and hand over. */
  canAct: z.boolean(),
  /** Active project members the card can be handed to. */
  members: z.array(z.object({ userId: z.uuid(), name: z.string() })),
  deskItemId: z.uuid().nullable(),
});
export type CardQa = z.infer<typeof CardQaSchema>;

/** `POST /api/cards/:id/qa/pass` */
export const QaPassRequestSchema = z.object({ note: z.string().trim().max(5000).optional() });
export type QaPassRequest = z.infer<typeof QaPassRequestSchema>;
/** `POST /api/cards/:id/qa/skip` */
export const QaSkipRequestSchema = z.object({ reason: z.string().trim().max(5000).optional() });
export type QaSkipRequest = z.infer<typeof QaSkipRequestSchema>;
/** `POST /api/cards/:id/qa/send-back`: the comment is required; the builder reads it as a review comment. */
export const QaSendBackRequestSchema = z.object({ comment: z.string().trim().min(1).max(10000) });
export type QaSendBackRequest = z.infer<typeof QaSendBackRequestSchema>;
/** `POST /api/cards/:id/qa/assign` */
export const QaAssignRequestSchema = z.object({ userId: z.uuid() });
export type QaAssignRequest = z.infer<typeof QaAssignRequestSchema>;

/** `PUT /api/projects/:id/manual-qa` (project Owner, organization Owner and Admins). */
export const SetManualQaRequestSchema = z.object({ enabled: z.boolean() });
