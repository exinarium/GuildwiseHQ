import { brandedMail, PRODUCT } from '../mail/layout.ts';
import type { MailMessage } from '../mail/mailer.ts';

/** "Your cloud workstation needs attention": GitHub credits ran out, the token stopped working, or it cannot start. */
export function cloudProblemMail(opts: {
  to: string;
  name: string;
  title: string;
  text: string;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: opts.title,
    preheader: `Your cloud workstation "${opts.name}" is not running.`,
    heading: opts.title,
    origin: opts.origin,
    body: [opts.text, `Cards that need this workstation wait until it runs again.`],
    cta: { label: `Open ${PRODUCT}`, url: `${opts.origin.replace(/\/+$/, '')}/workstations` },
    note: 'You receive this because you set up this cloud workstation.',
  });
}
