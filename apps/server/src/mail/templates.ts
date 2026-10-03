import type { MailMessage } from './mailer.ts';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export function invitationMail(opts: {
  to: string;
  link: string;
  invitedBy: string;
  expiresAt: Date;
}): MailMessage {
  const expires = opts.expiresAt.toUTCString();
  return {
    to: opts.to,
    subject: 'You are invited to Agent Org Manager',
    text: `${opts.invitedBy} invited you to Agent Org Manager.\n\nAccept the invitation and choose a password:\n${opts.link}\n\nThis link expires ${expires} and can be used once.\n`,
    html: `<p>${esc(opts.invitedBy)} invited you to Agent Org Manager.</p><p><a href="${esc(opts.link)}">Accept the invitation</a> and choose a password.</p><p>This link expires ${esc(expires)} and can be used once.</p>`,
  };
}
