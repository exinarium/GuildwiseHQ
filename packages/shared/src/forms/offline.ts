import { z } from 'zod';

/**
 * The client left an email address because the firm's runner is offline. The answers and files are never part of this
 * request: the browser keeps them (and drops them), the server holds the address only.
 */
export const OfflineRequestSchema = z
  .object({
    session: z.string().min(10).max(400),
    nonce: z.string().max(40).default(''),
    /** Honeypot: a person leaves it empty (checked with the session, like the start of a submission). */
    website: z.string().max(200).default(''),
    email: z.email().max(254),
    link: z.string().max(200).optional(),
  })
  .strict();
export type OfflineRequestBody = z.infer<typeof OfflineRequestSchema>;

/** A sub-state of the form wait (journey_waits is one row per step visit), not a `journey_waits.kind`. */
export const OFFLINE_WAIT_KIND = 'documents_pending_runner_offline';
export const OFFLINE_WAIT_LABEL = 'Documents pending, runner offline';
/** Days the secure link stays valid. */
export const OFFLINE_LINK_DAYS = { default: 7, min: 1, max: 30 } as const;
/** Days a case waits for the runner before the held email is deleted. */
export const OFFLINE_HOLD_DAYS = { default: 7, min: 1, max: 30 } as const;
/** Resends from the desk, per case. */
export const OFFLINE_MAX_RESENDS = 3;

export const OFFLINE_OPEN_STATUSES = ['held', 'sending', 'sent'] as const;

export interface OfflineNoticeInput {
  kind: 'sent' | 'hold_expired' | 'failed' | 'link_expired' | 'cancelled';
  formTitle: string;
  /** The firm's client reference from the personal link, or null for the public URL. */
  clientReference: string | null;
  /** The journey record's display name, when the form belongs to a journey. */
  recordName?: string | null;
  journeyName?: string | null;
  holdDays?: number;
}

/** The desk notification text of a case. Takes no email address, so none can end up in the item. */
export function offlineNoticeText(c: OfflineNoticeInput): { title: string; body: string } {
  const who = c.clientReference
    ? c.recordName && c.recordName !== c.clientReference
      ? `${c.clientReference}, ${c.recordName}`
      : c.clientReference
    : (c.recordName ?? 'a visitor of the public form');
  const where = c.journeyName ? ` in the journey "${c.journeyName}"` : '';
  switch (c.kind) {
    case 'sent':
      return {
        title: `Secure link sent: ${c.formTitle} (${who})`,
        body: `Your runner was offline when ${who} tried to send "${c.formTitle}"${where}. It is back online and the secure link has been emailed. The form lands in your storage when it is used.`,
      };
    case 'hold_expired':
      return {
        title: `Secure link not sent: ${c.formTitle} (${who})`,
        body: `Your runner was offline for ${c.holdDays ?? OFFLINE_HOLD_DAYS.default} days; we could not send the secure link${where} and have deleted the email address.`,
      };
    case 'failed':
      return {
        title: `Secure link not sent: ${c.formTitle} (${who})`,
        body: `We could not email the secure link${where}. The email address has been deleted. Ask the client to open the form again.`,
      };
    case 'link_expired':
      return {
        title: `Secure link expired: ${c.formTitle} (${who})`,
        body: `The secure link${where} expired unused and the email address has been deleted.`,
      };
    case 'cancelled':
      return {
        title: `Secure link cancelled: ${c.formTitle} (${who})`,
        body: `The case${where} was cancelled and the email address has been deleted.`,
      };
  }
}
