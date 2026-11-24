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

/**
 * A new workstation was paired with the account (release-readiness O3): what, where from and when, so a pairing the
 * person did not make is noticed at once. Never sent for a re-link of the same workstation or a simulated one.
 */
export function newWorkstationMail(opts: {
  to: string;
  name: string;
  workstation: { name: string; platform: string; hostname: string };
  when: Date;
  ip?: string | null | undefined;
  origin: string;
}): MailMessage {
  const facts: Array<[string, string]> = [
    ['Workstation', opts.workstation.name],
    ['Platform', opts.workstation.platform],
    ['Computer name', opts.workstation.hostname],
    ['When', opts.when.toUTCString()],
  ];
  if (opts.ip) facts.push(['From address', opts.ip]);
  return securityNoticeMail({
    to: opts.to,
    subject: 'A new workstation was added to your account',
    heading: 'New workstation added',
    paragraphs: [
      `Hello ${opts.name},`,
      `A computer was just linked to your account as the workstation "${opts.workstation.name}". It can run work for the organizations you switch on for it.`,
      'Not you? Unlink it on the Workstations page and change your password.',
    ],
    facts,
    cta: { label: 'Open Workstations', url: `${opts.origin}/workstations` },
    origin: opts.origin,
  });
}
