import type { MailMessage } from './mailer.ts';

// User-facing product name (the web app keeps the same constant in apps/web/src/brand.ts).
const PRODUCT = 'Guildwise';

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
    subject: `You are invited to ${PRODUCT}`,
    text: `${opts.invitedBy} invited you to ${PRODUCT}, your guild of AI agents.\n\nAccept the invitation and choose a password:\n${opts.link}\n\nThis link expires ${expires} and can be used once.\n\nMany hands. One master.\n`,
    html: `<p>${esc(opts.invitedBy)} invited you to ${PRODUCT}, your guild of AI agents.</p><p><a href="${esc(opts.link)}">Accept the invitation</a> and choose a password.</p><p>This link expires ${esc(expires)} and can be used once.</p><p style="color:#5E687A">Many hands. One master.</p>`,
  };
}
