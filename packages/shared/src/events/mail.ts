import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/** How far the sender could be verified: SPF or DKIM passed, DKIM failed, or nothing could be told. */
export const MailAuthVerdict = z.enum(['pass', 'fail', 'unknown']);
export type MailAuthVerdict = z.infer<typeof MailAuthVerdict>;

/**
 * Inbound e-mail (docs/design/workflow-builder.md D9). The inboxes, threads and messages are operational tables (like
 * support tickets: message text does not enter the event log); these events are the audit trail and what the
 * automations' trigger sweep reads. `MailReceived` carries no body: the sweep loads the stored message by id.
 */
export const mailEvents = [
  defineEvent(
    'MailInboxCreated',
    z.object({
      inboxId: Id,
      label: z.string().max(80),
      address: z.string().max(254),
      projectId: Id.optional(),
    }),
  ),
  /** A new address replaced the old one; mail to the old address is no longer accepted. */
  defineEvent(
    'MailInboxRotated',
    z.object({ inboxId: Id, address: z.string().max(254), previousAddress: z.string().max(254) }),
  ),
  defineEvent(
    'MailInboxUpdated',
    z.object({ inboxId: Id, label: z.string().max(80).optional(), enabled: z.boolean().optional() }),
  ),
  /** The Owner changed who may have cards queued directly (full addresses and `@domain` entries). */
  defineEvent(
    'MailAllowListChanged',
    z.object({ inboxId: Id, entries: z.array(z.string().max(254)).max(200) }),
  ),
  /** A message reached one of the organisation's addresses. `status`: what became of it so far (`skipped` has a `reason`). */
  defineEvent(
    'MailReceived',
    z.object({
      inboxId: Id,
      messageId: Id,
      threadId: Id,
      from: z.string().max(254),
      subject: z.string().max(300),
      status: z.enum(['received', 'skipped']),
      reason: z.string().max(60).optional(),
      /** The thread belongs to this card: the message is a reply to mail that made a card. */
      replyToCardId: Id.optional(),
      auth: MailAuthVerdict,
      spamScore: z.number().optional(),
    }),
  ),
  /** The card made from a thread's first message: replies to the thread now reach the card. */
  defineEvent('MailThreadLinked', z.object({ threadId: Id, cardId: Id, messageId: Id })),
  /**
   * A person replied to a conversation as the organisation (Reply on a card made from e-mail, or in the inbox). The text
   * is stored on the thread (operational table), not in the event.
   */
  defineEvent(
    'MailReplySent',
    z.object({
      threadId: Id,
      messageId: Id,
      inboxId: Id,
      cardId: Id.optional(),
      to: z.string().max(254),
      by: Id,
      /** The reply started as a draft written by the BA and was reviewed by the sender. */
      draftedBy: z.enum(['ba']).optional(),
    }),
  ),
] as const;
