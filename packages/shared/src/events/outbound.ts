import { z } from 'zod';
import { defineEvent, Id } from './define.ts';
import { ExternalSystem } from './intake.ts';

/** What an outbound update is: a comment, a design decision the manager made, or the resolution of the ticket. */
export const OutboundKind = z.enum(['comment', 'resolution', 'decision']);
export type OutboundKind = z.infer<typeof OutboundKind>;

export const OutboundStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'posted',
  'failed',
  'blocked',
  'held',
]);
export type OutboundStatus = z.infer<typeof OutboundStatus>;

/** Who wrote the draft: the BA, or the manager by hand. */
export const OutboundAuthor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: Id }),
  z.object({ kind: z.literal('user'), userId: Id }),
]);
export type OutboundAuthor = z.infer<typeof OutboundAuthor>;

/**
 * Outbound updates to company systems (docs/SPEC.md "External systems boundary"; docs/ARCHITECTURE.md section 16.5).
 * Nothing is posted without an `OutboundApproved`; the stream id is the draft's (`outbound-<draftId>`).
 */
export const outboundEvents = [
  /** The BA (or the manager) drafted an update for a ticket; `deskItemId` is the approval on the desk. */
  defineEvent(
    'OutboundDrafted',
    z.object({
      draftId: Id,
      cardId: Id,
      externalSystem: ExternalSystem,
      externalKey: z.string().min(1).max(200),
      /** The ticket's URL when it is known (used to build the result reference). */
      externalUrl: z.string().optional(),
      kind: OutboundKind,
      body: z.string().min(1).max(20000),
      deskItemId: Id,
      draftedBy: OutboundAuthor.optional(),
    }),
  ),
  /**
   * The BA drafted an update while manual QA is on for the card: it is held (no desk item, nothing posted) until QA
   * passes or is skipped, then that decision approves it (`OutboundApproved` with `viaManualQa`) and it is posted (docs/design/manual-qa.md section 5).
   */
  defineEvent(
    'OutboundHeld',
    z.object({
      draftId: Id,
      cardId: Id,
      externalSystem: ExternalSystem,
      externalKey: z.string().min(1).max(200),
      externalUrl: z.string().optional(),
      kind: OutboundKind,
      body: z.string().min(1).max(20000),
      draftedBy: OutboundAuthor.optional(),
    }),
  ),
  /** The draft mentioned something internal (an agent name, review or bounce history, ...) and never reached the desk. */
  defineEvent(
    'OutboundBlocked',
    z.object({
      draftId: Id,
      cardId: Id,
      externalSystem: ExternalSystem,
      externalKey: z.string().min(1).max(200),
      kind: OutboundKind,
      body: z.string().min(1).max(20000),
      /** The offending words or phrases. */
      matches: z.array(z.string()),
      draftedBy: OutboundAuthor.optional(),
    }),
  ),
  /** The card's owner approved the draft; `finalBody` is the text that is posted as it stands (their edit, if any). */
  defineEvent(
    'OutboundApproved',
    z.object({
      draftId: Id,
      finalBody: z.string().min(1).max(20000),
      approvedBy: Id,
      edited: z.boolean().default(false),
      /** Approved by the manual QA decision (pass or skip) of `approvedBy`, not on the desk. */
      viaManualQa: z.boolean().optional(),
    }),
  ),
  defineEvent('OutboundRejected', z.object({ draftId: Id, by: Id, reason: z.string().max(2000).optional() })),
  /** The runner posted it; `externalRef` is the URL or id the system returned. */
  defineEvent('OutboundPosted', z.object({ draftId: Id, externalRef: z.string().optional() })),
  defineEvent(
    'OutboundPostFailed',
    z.object({ draftId: Id, error: z.string().max(4000), alertDeskItemId: Id.optional() }),
  ),
  /** The manager asked to post a failed draft again (same approved text). */
  defineEvent('OutboundRetryRequested', z.object({ draftId: Id, by: Id })),
] as const;
