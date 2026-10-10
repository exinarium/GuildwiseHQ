import { brandedMail, esc, type MailBlock, oneLine, PRODUCT, SLOGAN } from './layout.ts';
import type { MailMessage } from './mailer.ts';

// Every template builds its content as data and hands it to `brandedMail` (layout.ts), which owns the look, the
// plain-text part and the footer. Templates take `origin` (the public origin) for the logo and the footer links.
// Whoever a mail names is a display name, an organization or the team: pass `senderName(...)`, never a login.

/** How soon the team answers; stated in the acknowledgement mail. */
export const SUPPORT_RESPONSE_TIME = 'within two working days';

const expiry = (d: Date) => d.toUTCString();

/** "<name> invited you to join <product>": a plain invitation (account only). */
export function invitationMail(opts: {
  to: string;
  link: string;
  invitedBy: string;
  expiresAt: Date;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: `You are invited to ${PRODUCT}`,
    preheader: `${opts.invitedBy} invited you to ${PRODUCT}, your guild of AI agents.`,
    heading: `You are invited to ${PRODUCT}`,
    origin: opts.origin,
    body: [
      `${opts.invitedBy} invited you to ${PRODUCT}, your guild of AI agents.`,
      'Accept the invitation and choose a password to get started.',
    ],
    cta: { label: 'Accept the invitation', url: opts.link },
    note: `This link expires ${expiry(opts.expiresAt)} and can be used once.`,
  });
}

/** "<name> invited you to join <org> as <role>": accepted on /invite/<token> (new account or signed in). */
export function orgInvitationMail(opts: {
  to: string;
  link: string;
  orgName: string;
  role: string;
  invitedBy: string;
  expiresAt: Date;
  origin: string;
}): MailMessage {
  const role = opts.role === 'admin' ? 'an Admin' : 'a Member';
  return brandedMail({
    to: opts.to,
    subject: `Join ${opts.orgName} on ${PRODUCT}`,
    preheader: `${opts.invitedBy} invited you to join ${opts.orgName} as ${role}.`,
    heading: `Join ${opts.orgName}`,
    origin: opts.origin,
    body: [
      {
        html: `${esc(opts.invitedBy)} invited you to join <strong>${esc(opts.orgName)}</strong> on ${PRODUCT} as ${role}.`,
        text: `${opts.invitedBy} invited you to join ${opts.orgName} on ${PRODUCT} as ${role}.`,
      },
      'You create an account first if you do not have one.',
    ],
    cta: { label: 'Accept the invitation', url: opts.link },
    note: `This link expires ${expiry(opts.expiresAt)} and can be used once.`,
  });
}

/** The platform invites someone to start their own organization. */
export function newOrgInvitationMail(opts: {
  to: string;
  link: string;
  orgName: string;
  terms: string;
  invitedBy: string;
  expiresAt: Date;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: `Start ${opts.orgName} on ${PRODUCT}`,
    preheader: `${opts.invitedBy} set up ${opts.orgName} for you on ${PRODUCT}.`,
    heading: `Start ${opts.orgName}`,
    origin: opts.origin,
    body: [
      {
        html: `${esc(opts.invitedBy)} set up the organization <strong>${esc(opts.orgName)}</strong> for you on ${PRODUCT}, your guild of AI agents.`,
        text: `${opts.invitedBy} set up the organization ${opts.orgName} for you on ${PRODUCT}, your guild of AI agents.`,
      },
      { facts: [['Terms', opts.terms]] },
      'Accept the invitation and become its Owner.',
    ],
    cta: { label: 'Accept the invitation', url: opts.link },
    note: `This link expires ${expiry(opts.expiresAt)} and can be used once.`,
  });
}

// ------------------------------------------------------------------------------------------------ password reset

/**
 * The link that sets a new password. Sent when the person asks for it on the sign-in page, or when a platform admin
 * sends it for them (`byTeam`). A two-factor code is still asked at the next sign-in.
 */
export function passwordResetMail(opts: {
  to: string;
  name: string;
  link: string;
  expiresAt: Date;
  origin: string;
  /** True when the platform team sent it, not the person themselves. */
  byTeam?: boolean | undefined;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: `Reset your ${PRODUCT} password`,
    preheader: 'Choose a new password. The link works once and expires in an hour.',
    heading: 'Reset your password',
    origin: opts.origin,
    body: [
      `Hello ${opts.name},`,
      opts.byTeam
        ? `The ${PRODUCT} team sent you this link so you can choose a new password.`
        : `Someone, hopefully you, asked to reset the password of your ${PRODUCT} account.`,
      'Choose a new password with the button below. Every other place you are signed in will be signed out, and if you use two-factor login you will still be asked for your code.',
    ],
    cta: { label: 'Choose a new password', url: opts.link },
    note: `This link expires ${expiry(opts.expiresAt)} and works once. If you did not ask for it, you can ignore this mail: your password stays as it is.`,
  });
}

// ------------------------------------------------------------------------------------------------ scheduled reports

/** A scheduled report or digest delivered by email: the text the schedule produced, in the layout. */
export function scheduledReportMail(opts: {
  to: string;
  subject: string;
  text: string;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: opts.subject,
    preheader: oneLine(opts.text).slice(0, 110),
    heading: oneLine(opts.subject),
    origin: opts.origin,
    body: [{ quote: opts.text }],
    note: 'You receive this because a schedule in your organization delivers it by email.',
  });
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

/** A new request, to the notification address. Replying to it in a mail program reaches the person who wrote in. */
export function supportNewMail(opts: {
  to: string;
  ticket: SupportMailTicket;
  message: string;
  link: string;
  origin: string;
  /** A visitor's Contact us message, as opposed to a request from a signed-in user. */
  fromVisitor?: boolean | undefined;
}): MailMessage {
  const t = opts.ticket;
  const facts: Array<[string, string]> = [
    ['From', `${t.contactName} <${t.contactEmail}>`],
    ...(t.orgName ? ([['Organization', t.orgName]] as Array<[string, string]>) : []),
    ...(t.page ? ([['Page', t.page]] as Array<[string, string]>) : []),
    ...(t.appVersion ? ([['Version', t.appVersion]] as Array<[string, string]>) : []),
    ...(t.browser ? ([['Browser', t.browser]] as Array<[string, string]>) : []),
  ];
  const body: MailBlock[] = [
    { facts },
    { quote: opts.message },
    ...(t.hasScreenshot ? ['Screenshot attached (open it in the inbox).'] : []),
    ...(t.errors.length ? [{ small: 'Recent errors' }, { list: t.errors }] : []),
  ];
  return brandedMail({
    to: opts.to,
    replyTo: t.contactEmail,
    subject: `[${t.ref}] ${t.kindLabel}: ${oneLine(t.subject)}`,
    preheader: oneLine(opts.message).slice(0, 110),
    heading: opts.fromVisitor ? `Contact us: ${oneLine(t.subject)}` : `${t.kindLabel}: ${oneLine(t.subject)}`,
    origin: opts.origin,
    body,
    cta: { label: 'Open in the Support inbox', url: opts.link },
    note: 'Reply to this mail to answer the person directly.',
  });
}

/** A signed-in user wrote again on an open request, to the notification address. */
export function supportFollowUpMail(opts: {
  to: string;
  ref: string;
  subject: string;
  name: string;
  email: string;
  body: string;
  link: string;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    replyTo: opts.email,
    subject: `[${opts.ref}] New message from ${oneLine(opts.name)}: ${oneLine(opts.subject)}`,
    preheader: oneLine(opts.body).slice(0, 110),
    heading: `New message on ${opts.ref}`,
    origin: opts.origin,
    body: [{ facts: [['From', `${opts.name} <${opts.email}>`]] }, { quote: opts.body }],
    cta: { label: 'Open in the Support inbox', url: opts.link },
  });
}

/**
 * The acknowledgement for the person who wrote in: their reference, what happens next and when to expect an answer.
 * Sent once per new request, only in answer to the form (there is no inbound mail), so it cannot start a reply loop.
 */
export function supportReceivedMail(opts: {
  to: string;
  name: string;
  ref: string;
  subject: string;
  link: string | null;
  origin: string;
  replyTo?: string | undefined;
}): MailMessage {
  const subject = oneLine(opts.subject);
  const next = `A person on the team reads your message and answers by email${
    opts.link ? ', and the answer also appears under Help, My requests' : ''
  }. ${
    opts.link
      ? 'You can add details there while you wait.'
      : 'Reply to this mail if you want to add something; please keep the reference in the subject.'
  }`;
  return brandedMail({
    to: opts.to,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    subject: `We received your request ${opts.ref}: ${subject}`,
    preheader: `Your reference is ${opts.ref}. We answer ${SUPPORT_RESPONSE_TIME}.`,
    heading: 'We received your message',
    origin: opts.origin,
    body: [
      `Hello ${opts.name},`,
      `Thank you for contacting ${PRODUCT} support. Your message is with us.`,
      {
        facts: [
          ['Reference', opts.ref],
          ['Subject', subject],
          ['Expected answer', SUPPORT_RESPONSE_TIME],
        ],
      },
      { html: `<strong>What happens next.</strong> ${esc(next)}`, text: `What happens next. ${next}` },
    ],
    ...(opts.link ? { cta: { label: 'Follow your request', url: opts.link } } : {}),
    note: 'This is an automatic confirmation. Nothing more is needed from you.',
  });
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
  origin: string;
  replyTo?: string | undefined;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    subject: `Re: [${opts.ref}] ${oneLine(opts.subject)}`,
    preheader: oneLine(opts.body).slice(0, 110),
    heading: `Our answer to ${opts.ref}`,
    origin: opts.origin,
    body: [
      `Hello ${opts.name},`,
      { quote: opts.body },
      ...(opts.closed ? ['We have closed this request. Write to us again if you need anything else.'] : []),
      ...(opts.link ? [] : ['Reply to this email to answer.']),
    ],
    ...(opts.link ? { cta: { label: 'Answer in Help, My requests', url: opts.link } } : {}),
    note: `${PRODUCT} support. ${SLOGAN}`,
  });
}

// ------------------------------------------------------------------------------------------------ desk mail (support address)

export interface DeskMailItem {
  kindLabel: string;
  title: string;
  org: string;
  project: string | null;
  priorityLabel: string;
  summary: string;
  link: string;
}

const DESK_MAIL_NOTE = 'You receive this because desk mail is on in the platform settings (Support page).';

/** One new desk item, to the support address(es): what it is, where, how urgent, and a button to the item. */
export function deskItemMail(opts: { to: string; item: DeskMailItem; origin: string }): MailMessage {
  const i = opts.item;
  const facts: Array<[string, string]> = [
    ['Kind', i.kindLabel],
    ['Organization', i.org],
    ...(i.project ? ([['Project', i.project]] as Array<[string, string]>) : []),
    ['Priority', i.priorityLabel],
  ];
  return brandedMail({
    to: opts.to,
    subject: `[Desk] ${i.kindLabel}: ${oneLine(i.title)}`.slice(0, 200),
    preheader: oneLine(i.summary || i.title).slice(0, 110),
    heading: oneLine(i.title).slice(0, 200),
    origin: opts.origin,
    body: [{ facts }, ...(i.summary ? [{ quote: i.summary }] : [])],
    cta: { label: 'Open on the desk', url: i.link },
    note: DESK_MAIL_NOTE,
  });
}

/** More new desk items than the burst limit: one mail that lists them (the throttle). */
export function deskDigestMail(opts: {
  to: string;
  items: DeskMailItem[];
  more: number;
  origin: string;
}): MailMessage {
  const n = opts.items.length + opts.more;
  return brandedMail({
    to: opts.to,
    subject: `[Desk] ${n} new desk items`,
    preheader: oneLine(opts.items.map((i) => i.title).join('; ')).slice(0, 110),
    heading: `${n} new desk items`,
    origin: opts.origin,
    body: [
      'Several items arrived at once, so they are listed in one mail.',
      {
        list: [
          ...opts.items.map(
            (i) =>
              `${i.kindLabel}, ${i.org}${i.project ? ` / ${i.project}` : ''} (${i.priorityLabel}): ${oneLine(i.title)}`,
          ),
          ...(opts.more > 0 ? [`and ${opts.more} more`] : []),
        ],
      },
    ],
    cta: { label: 'Open the desk', url: `${opts.origin.replace(/\/+$/, '')}/desk` },
    note: DESK_MAIL_NOTE,
  });
}
