import { brandedMail, type MailBlock, oneLine } from './layout.ts';
import type { MailMessage } from './mailer.ts';

/**
 * Account and organization security notices (R17): two-factor recovery, ownership transfer consent, feature changes by
 * the platform and changed notification addresses. Plain facts and one button; never a secret, a code or a password.
 */
export function securityNoticeMail(opts: {
  to: string;
  subject: string;
  heading: string;
  paragraphs: string[];
  facts?: Array<[string, string]>;
  cta?: { label: string; url: string };
  note?: string;
  origin: string;
}): MailMessage {
  const body: MailBlock[] = [...opts.paragraphs];
  if (opts.facts?.length)
    body.push({ facts: opts.facts.map(([k, v]) => [k, oneLine(v)] as [string, string]) });
  return brandedMail({
    to: opts.to,
    subject: oneLine(opts.subject),
    preheader: oneLine(opts.paragraphs[0] ?? opts.heading).slice(0, 110),
    heading: opts.heading,
    origin: opts.origin,
    body,
    ...(opts.cta ? { cta: opts.cta } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  });
}
