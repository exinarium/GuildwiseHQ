import { z } from 'zod';
import { MailAuthVerdict } from '../events/mail.ts';
import { IsoTime } from './common.ts';

/** Inbound e-mail API (docs/design/workflow-builder.md D9): an organisation's inboxes and what arrived. */

export const MailInboxDtoSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  /** The address people write (or forward) to. */
  address: z.string(),
  enabled: z.boolean(),
  projectId: z.uuid().nullable(),
  /** Full addresses and `@domain` entries whose cards may be queued directly (Owner only). */
  allowList: z.array(z.string()),
  createdAt: IsoTime,
  lastReceivedAt: IsoTime.nullable(),
  /** Messages in the last 24 hours, by outcome. */
  last24h: z.object({ received: z.number().int(), skipped: z.number().int() }),
});
export type MailInboxDto = z.infer<typeof MailInboxDtoSchema>;

export const MailInboxesResponseSchema = z.object({
  /** False: the platform has no mail provider set up yet (no addresses can be made). */
  configured: z.boolean(),
  domain: z.string().nullable(),
  inboxes: z.array(MailInboxDtoSchema),
});
export type MailInboxesResponse = z.infer<typeof MailInboxesResponseSchema>;

export const CreateMailInboxRequestSchema = z.object({
  label: z.string().trim().min(1).max(80),
  projectId: z.uuid().optional(),
});
export type CreateMailInboxRequest = z.infer<typeof CreateMailInboxRequestSchema>;

export const PatchMailInboxRequestSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  /** Owner only. Entries are full addresses or domains (`acme.com`, `@acme.com`). */
  allowList: z.array(z.string().trim().min(1).max(254)).max(200).optional(),
});
export type PatchMailInboxRequest = z.infer<typeof PatchMailInboxRequestSchema>;

export const MailMessageDtoSchema = z.object({
  id: z.uuid(),
  inboxId: z.uuid(),
  threadId: z.uuid(),
  from: z.string(),
  fromName: z.string().nullable(),
  subject: z.string(),
  receivedAt: IsoTime,
  /** received | card_created | draft_created | comment_added | processed | skipped */
  status: z.string(),
  reason: z.string().nullable(),
  /** The reason in words, for the page. */
  reasonText: z.string().nullable(),
  cardId: z.uuid().nullable(),
  cardRef: z.string().nullable(),
  auth: MailAuthVerdict,
  allowListed: z.boolean(),
  attachments: z.number().int(),
  isReply: z.boolean(),
});
export type MailMessageDto = z.infer<typeof MailMessageDtoSchema>;

export const MailMessagesResponseSchema = z.object({ messages: z.array(MailMessageDtoSchema) });
export type MailMessagesResponse = z.infer<typeof MailMessagesResponseSchema>;

export const MailMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** What the super admin sees of the inbound mail provider (Platform > Status). */
export const InboundHealthSchema = z.object({
  provider: z.string().nullable(),
  domain: z.string().nullable(),
  configured: z.boolean(),
  /** The shared secret of the webhook is set. */
  secretSet: z.boolean(),
  inboxes: z.number().int(),
  lastReceivedAt: IsoTime.nullable(),
  last24h: z.object({
    received: z.number().int(),
    skipped: z.number().int(),
    skippedByReason: z.record(z.string(), z.number().int()),
    unknownAddress: z.number().int(),
    authFailed: z.number().int(),
  }),
  limits: z.object({
    maxMessageBytes: z.number().int(),
    ratePerHourPerOrg: z.number().int(),
    spamThreshold: z.number(),
  }),
});
export type InboundHealth = z.infer<typeof InboundHealthSchema>;
