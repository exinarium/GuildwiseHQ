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
  /** Force the "[Simulation] " subject prefix (set by the sender when it knows the organization is a simulation). */
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
