import { z } from 'zod';
import { ExternalSystem } from '../events/intake.ts';
import { OutboundKind, OutboundStatus } from '../events/outbound.ts';
import { IsoTime } from './common.ts';

/** One outbound update (docs/SPEC.md "External systems boundary"): the draft, what was approved, and what happened to it. */
export const OutboundDraftDtoSchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  cardRef: z.string(),
  cardTitle: z.string(),
  projectKey: z.string(),
  externalSystem: ExternalSystem,
  externalKey: z.string(),
  kind: OutboundKind,
  /** The draft as written. */
  body: z.string(),
  /** What was approved, and is posted as it stands (the manager's edit, if any). */
  finalBody: z.string().nullable(),
  edited: z.boolean(),
  status: OutboundStatus,
  /** The approval on the decision desk (open while the draft is pending; the failure alert when posting failed). */
  deskItemId: z.uuid().nullable(),
  draftedByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  /** The URL or id the company system returned once it was posted. */
  externalRef: z.string().nullable(),
  error: z.string().nullable(),
  /** Internal terms that blocked the draft. */
  blockedMatches: z.array(z.string()),
  rejectReason: z.string().nullable(),
  createdAt: IsoTime,
  approvedAt: IsoTime.nullable(),
  postedAt: IsoTime.nullable(),
});
export type OutboundDraftDto = z.infer<typeof OutboundDraftDtoSchema>;

/** `GET /api/outbound?card=<id or ref>&status=...`: drafts the caller can see, newest first. */
export const OutboundListQuerySchema = z.object({
  card: z.string().min(1).optional(),
  status: OutboundStatus.optional(),
});
export const OutboundListResponseSchema = z.object({ drafts: z.array(OutboundDraftDtoSchema) });

/** `POST /api/cards/:id/outbound`: the manager writes the update themselves (the BA normally drafts it). */
export const CreateOutboundDraftRequestSchema = z.object({
  kind: OutboundKind.default('comment'),
  body: z.string().min(1).max(20000),
});
export type CreateOutboundDraftRequest = z.infer<typeof CreateOutboundDraftRequestSchema>;
export const CreateOutboundDraftResponseSchema = z.object({ draft: OutboundDraftDtoSchema });

export const OutboundParamsSchema = z.object({ id: z.uuid() });
/** `POST /api/outbound/:id/retry`: post a failed update again (the approved text is unchanged). */
export const OutboundRetryResponseSchema = z.object({ draft: OutboundDraftDtoSchema });

/** The BA's `outbound.draft` RPC (`aom outbound draft`), checked on the server. */
export const OutboundDraftRpcParamsSchema = z.object({
  kind: OutboundKind.default('resolution'),
  body: z.string().min(1).max(20000),
});
