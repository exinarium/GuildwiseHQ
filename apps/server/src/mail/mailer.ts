import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Where a reply from the recipient's mail program goes (support mail: the person who wrote in). */
  replyTo?: string;
  /** Overrides the mailer's From (support mails to customers: `AOM_SUPPORT_FROM`). */
  from?: string;
  /** Extra headers (`List-Unsubscribe` on the digest). */
  headers?: Record<string, string>;
  /** `Message-ID` (with angle brackets). Absent: the mail library makes one. Set it when replies should thread. */
  messageId?: string;
  /** The message this one answers, and the earlier messages of the conversation (`mail/threading.ts`). */
  inReplyTo?: string;
  references?: string[];
  /**
   * The organization this mail is about. When it is a simulation organization the subject gets "[Simulation] ",
   * whoever the recipient is. Mails not tied to an organization leave it out and are never prefixed.
   */
  orgId?: string;
  /** Force the "[Simulation] " prefix when the sender knows the subject organization is a simulation but it has no id yet. */
  simulation?: boolean;
  /**
   * A security mail (password changed, new sign-in, lock, reset link): sent with SendGrid click and open tracking off
   * (`X-SMTPAPI`), so the link is never rewritten through a tracking host (R3).
   */
  sensitive?: boolean;
}

/** SendGrid's per-message filter header that turns click and open tracking off. Other SMTP relays ignore it. */
export const SENSITIVE_MAIL_HEADER = JSON.stringify({
  filters: {
    clicktrack: { settings: { enable: 0, enable_text: false } },
    opentrack: { settings: { enable: 0 } },
  },
});

/**
 * The message as handed to the transport: `sensitive` becomes the `X-SMTPAPI` header, passed `prepared` so the JSON is
 * not MIME-encoded (SendGrid reads it raw).
 */
export function transportMessage(msg: MailMessage): Omit<MailMessage, 'sensitive' | 'headers'> & {
  headers?: Record<string, string | { prepared: true; value: string }>;
} {
  const { sensitive, ...rest } = msg;
  if (!sensitive) return rest;
  return {
    ...rest,
    headers: { ...(rest.headers ?? {}), 'X-SMTPAPI': { prepared: true, value: SENSITIVE_MAIL_HEADER } },
  };
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  close(): void;
}

export function createMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(msg) {
      await transport.sendMail({ from, ...transportMessage(msg) });
    },
    close() {
      transport.close();
    },
  };
}
