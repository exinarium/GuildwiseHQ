/**
 * Writes every mail template to HTML (and .txt) files so they can be reviewed in a browser.
 * Usage: pnpm --filter @aom/server mails:render [outDir]   (default: ./tmp/mails)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MailMessage } from '../src/mail/mailer.ts';
import * as t from '../src/mail/templates.ts';

const origin = process.env.AOM_PUBLIC_ORIGIN ?? 'https://app.guildwisehq.com';
const out = process.argv[2] ?? 'tmp/mails';
const expiresAt = new Date(Date.now() + 7 * 86_400_000);
const hour = new Date(Date.now() + 3_600_000);
const link = `${origin}/invite/example-token`;
const resetLink = `${origin}/reset-password/example-token`;
const supportLink = `${origin}/platform/support/1`;
const myLink = `${origin}/help/requests/1`;
const ticket = {
  ref: 'SUP-1001',
  kindLabel: 'Bug report',
  subject: 'The board does not load',
  contactName: 'Ada Example',
  contactEmail: 'ada@example.com',
  orgName: 'Example Co',
  page: '/p/TOY/board',
  appVersion: '1.4.0',
  browser: 'Firefox 130',
  errors: ['2026-10-07T08:00:00Z TypeError: x is undefined'],
  hasScreenshot: true,
};

const mails: Record<string, MailMessage> = {
  invitation: t.invitationMail({ to: 'new@example.com', link, invitedBy: 'Ada Example', expiresAt, origin }),
  'org-invitation': t.orgInvitationMail({
    to: 'new@example.com',
    link,
    orgName: 'Example Co',
    role: 'member',
    invitedBy: 'Ada Example',
    expiresAt,
    origin,
  }),
  'new-org-invitation': t.newOrgInvitationMail({
    to: 'new@example.com',
    link,
    orgName: 'Example Co',
    terms: 'Founding plan, trial until 2026-12-01',
    invitedBy: 'The Guildwise HQ team',
    expiresAt,
    origin,
  }),
  'password-reset': t.passwordResetMail({
    to: 'ada@example.com',
    name: 'Ada',
    link: resetLink,
    expiresAt: hour,
    origin,
  }),
  'password-reset-by-team': t.passwordResetMail({
    to: 'ada@example.com',
    name: 'Ada',
    link: resetLink,
    expiresAt: hour,
    origin,
    byTeam: true,
  }),
  'scheduled-report': t.scheduledReportMail({
    to: 'ada@example.com',
    subject: 'Organization report 2026-10-09',
    text: 'Shifts: 12\nCards done: 7\nNeeds you: 2',
    origin,
  }),
  'support-new': t.supportNewMail({
    to: 'support@example.com',
    ticket,
    message: 'I click on the board and nothing happens.',
    link: supportLink,
    origin,
  }),
  'support-new-contact-us': t.supportNewMail({
    to: 'support@example.com',
    ticket: { ...ticket, orgName: null },
    message: 'Hello, I have a question about plans.',
    link: supportLink,
    origin,
    fromVisitor: true,
  }),
  'support-follow-up': t.supportFollowUpMail({
    to: 'support@example.com',
    ref: 'SUP-1001',
    subject: 'The board does not load',
    name: 'Ada Example',
    email: 'ada@example.com',
    body: 'It still fails after a reload.',
    link: supportLink,
    origin,
  }),
  'support-received': t.supportReceivedMail({
    to: 'ada@example.com',
    name: 'Ada',
    ref: 'SUP-1001',
    subject: 'The board does not load',
    link: myLink,
    origin,
  }),
  'support-received-visitor': t.supportReceivedMail({
    to: 'ada@example.com',
    name: 'Ada',
    ref: 'SUP-1002',
    subject: 'A question about plans',
    link: null,
    origin,
  }),
  'support-reply': t.supportReplyMail({
    to: 'ada@example.com',
    name: 'Ada',
    ref: 'SUP-1001',
    subject: 'The board does not load',
    body: 'Thanks for the report. We fixed it in 1.4.1.',
    closed: true,
    link: myLink,
    origin,
  }),
};

mkdirSync(out, { recursive: true });
for (const [name, m] of Object.entries(mails)) {
  writeFileSync(join(out, `${name}.html`), m.html ?? '');
  writeFileSync(join(out, `${name}.txt`), `Subject: ${m.subject}\n\n${m.text}`);
}
const items = Object.keys(mails).map(
  (n) => `<li><a href="${n}.html">${n}</a> (<a href="${n}.txt">text</a>)</li>`,
);
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Mails</title><ul>${items.join('')}</ul>`,
);
console.log(`wrote ${Object.keys(mails).length} mails to ${out}`);
