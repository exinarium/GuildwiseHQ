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
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  close(): void;
}

export function createMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
    close() {
      transport.close();
    },
  };
}
