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

// ------------------------------------------------------------------------------------------------ support (Contact us)

export interface SupportMailTicket {
  ref: string;
  kindLabel: string;
  subject: string;
  contactName: string;
  contactEmail: string;
  orgName: string | null;
  page?: string | undefined;
  appVersion?: string | undefined;
  browser?: string | undefined;
  errors: string[];
  hasScreenshot: boolean;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

/** A new request, to the support address. Replying to it in a mail program reaches the person who wrote in. */
export function supportNewMail(opts: {
  to: string;
  ticket: SupportMailTicket;
  message: string;
  link: string;
}): MailMessage {
  const t = opts.ticket;
  const lines = [
    `${t.kindLabel} from ${t.contactName} <${t.contactEmail}>${t.orgName ? ` (${t.orgName})` : ''}`,
    ...(t.page ? [`Page: ${t.page}`] : []),
    ...(t.appVersion ? [`Version: ${t.appVersion}`] : []),
    ...(t.browser ? [`Browser: ${t.browser}`] : []),
    ...(t.hasScreenshot ? ['Screenshot attached (open it in the inbox).'] : []),
  ];
  const errorText = t.errors.length ? `\n\nRecent errors:\n${t.errors.map((e) => `- ${e}`).join('\n')}` : '';
  return {
    to: opts.to,
    replyTo: t.contactEmail,
    subject: `[${t.ref}] ${t.kindLabel}: ${oneLine(t.subject)}`,
    text: `${lines.join('\n')}\n\n${opts.message}${errorText}\n\nOpen in the Support inbox:\n${opts.link}\n`,
    html: `<p>${lines.map(esc).join('<br>')}</p><blockquote style="white-space:pre-wrap;border-left:3px solid #d0d5de;margin:0;padding:4px 12px">${esc(opts.message)}</blockquote>${
      t.errors.length
        ? `<p>Recent errors:</p><ul>${t.errors.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>`
        : ''
    }<p><a href="${esc(opts.link)}">Open in the Support inbox</a></p>`,
  };
}

/** "We received your request": to the person who wrote in. */
export function supportReceivedMail(opts: {
  to: string;
  name: string;
  ref: string;
  subject: string;
  link: string | null;
}): MailMessage {
  const where = opts.link
    ? `You can follow it, and read our reply, under Help, My requests:\n${opts.link}`
    : 'We will answer by email to this address.';
  return {
    to: opts.to,
    subject: `We received your request ${opts.ref}: ${oneLine(opts.subject)}`,
    text: `Hello ${opts.name},\n\nThank you for contacting ${PRODUCT} support. Your request ${opts.ref} ("${oneLine(opts.subject)}") is with us.\n\n${where}\n\nMany hands. One master.\n`,
    html: `<p>Hello ${esc(opts.name)},</p><p>Thank you for contacting ${PRODUCT} support. Your request <strong>${esc(opts.ref)}</strong> (&ldquo;${esc(opts.subject)}&rdquo;) is with us.</p><p>${
      opts.link
        ? `You can follow it, and read our reply, under <a href="${esc(opts.link)}">Help, My requests</a>.`
        : 'We will answer by email to this address.'
    }</p><p style="color:#5E687A">Many hands. One master.</p>`,
  };
}

/** The support team's answer, to the person who wrote in. */
export function supportReplyMail(opts: {
  to: string;
  name: string;
  ref: string;
  subject: string;
  body: string;
  closed: boolean;
  link: string | null;
}): MailMessage {
  const tail = opts.link
    ? `\n\nYou can answer under Help, My requests:\n${opts.link}`
    : '\n\nReply to this email to answer.';
  return {
    to: opts.to,
    subject: `Re: [${opts.ref}] ${oneLine(opts.subject)}`,
    text: `Hello ${opts.name},\n\n${opts.body}${opts.closed ? '\n\nWe have closed this request. Write to us again if you need anything else.' : ''}${tail}\n\n${PRODUCT} support\n`,
    html: `<p>Hello ${esc(opts.name)},</p><div style="white-space:pre-wrap">${esc(opts.body)}</div>${
      opts.closed ? '<p>We have closed this request. Write to us again if you need anything else.</p>' : ''
    }<p>${opts.link ? `You can answer under <a href="${esc(opts.link)}">Help, My requests</a>.` : 'Reply to this email to answer.'}</p><p style="color:#5E687A">${PRODUCT} support</p>`,
  };
}
