import type { MailMessage } from './mailer.ts';

// User-facing product name (the web app keeps the same constant in apps/web/src/brand.ts).
const PRODUCT = 'Guildwise HQ';

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

const expiry = (d: Date) => d.toUTCString();

/** "<name> invited you to join <org> as <role>": accepted on /invite/<token> (new account or signed in). */
export function orgInvitationMail(opts: {
  to: string;
  link: string;
  orgName: string;
  role: string;
  invitedBy: string;
  expiresAt: Date;
}): MailMessage {
  const role = opts.role === 'admin' ? 'an Admin' : 'a Member';
  return {
    to: opts.to,
    subject: `Join ${opts.orgName} on ${PRODUCT}`,
    text: `${opts.invitedBy} invited you to join ${opts.orgName} on ${PRODUCT} as ${role}.\n\nAccept the invitation (you create an account first if you do not have one):\n${opts.link}\n\nThis link expires ${expiry(opts.expiresAt)} and can be used once.\n\nMany hands. One master.\n`,
    html: `<p>${esc(opts.invitedBy)} invited you to join <strong>${esc(opts.orgName)}</strong> on ${PRODUCT} as ${role}.</p><p><a href="${esc(opts.link)}">Accept the invitation</a> (you create an account first if you do not have one).</p><p>This link expires ${esc(expiry(opts.expiresAt))} and can be used once.</p><p style="color:#5E687A">Many hands. One master.</p>`,
  };
}

/** The platform invites someone to start their own organization. */
export function newOrgInvitationMail(opts: {
  to: string;
  link: string;
  orgName: string;
  terms: string;
  invitedBy: string;
  expiresAt: Date;
}): MailMessage {
  return {
    to: opts.to,
    subject: `Start ${opts.orgName} on ${PRODUCT}`,
    text: `${opts.invitedBy} set up the organization ${opts.orgName} for you on ${PRODUCT}, your guild of AI agents (${opts.terms}).\n\nAccept the invitation and become its Owner:\n${opts.link}\n\nThis link expires ${expiry(opts.expiresAt)} and can be used once.\n\nMany hands. One master.\n`,
    html: `<p>${esc(opts.invitedBy)} set up the organization <strong>${esc(opts.orgName)}</strong> for you on ${PRODUCT}, your guild of AI agents (${esc(opts.terms)}).</p><p><a href="${esc(opts.link)}">Accept the invitation</a> and become its Owner.</p><p>This link expires ${esc(expiry(opts.expiresAt))} and can be used once.</p><p style="color:#5E687A">Many hands. One master.</p>`,
  };
}
