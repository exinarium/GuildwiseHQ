import { brandedMail, esc, type MailBlock, oneLine, PRODUCT, SLOGAN, TEAM } from './layout.ts';
import type { MailMessage } from './mailer.ts';

// Every template builds its content as data and hands it to `brandedMail` (layout.ts), which owns the look, the
// plain-text part and the footer. Templates take `origin` (the public origin) for the logo and the footer links.
// Whoever a mail names is a display name, an organization or the team: pass `senderName(...)`, never a login.

/** How soon the team answers; stated in the acknowledgement mail. */
export const SUPPORT_RESPONSE_TIME = 'within 24 to 48 hours';

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
  /** An Owner or Admin of this organization sent it from the members list (R6). */
  byOrg?: string | undefined;
}): MailMessage {
  return {
    ...brandedMail({
      to: opts.to,
      subject: `Reset your ${PRODUCT} password`,
      preheader: 'Choose a new password. The link works once and expires in an hour.',
      heading: 'Reset your password',
      origin: opts.origin,
      body: [
        `Hello ${opts.name},`,
        opts.byOrg
          ? `An Owner or Admin of ${opts.byOrg} sent you this link so you can choose a new password for your ${PRODUCT} account.`
          : opts.byTeam
            ? `The ${PRODUCT} team sent you this link so you can choose a new password.`
            : `Someone, hopefully you, asked to reset the password of your ${PRODUCT} account.`,
        'Choose a new password with the button below. Every other place you are signed in will be signed out, and if you use two-factor login you will still be asked for your code.',
      ],
      cta: { label: 'Choose a new password', url: opts.link },
      note: `This link expires ${expiry(opts.expiresAt)} and works once. If you did not ask for it, you can ignore this mail: your password stays as it is.`,
    }),
    sensitive: true,
  };
}

// ------------------------------------------------------------------------------------------------ account security (R2-R4)

/** How a password or second factor changed, in the words of the mail. */
export type PasswordChangeHow = 'change' | 'reset_link' | 'cli' | 'two_factor_reset_cli';

const HOW_TEXT: Record<PasswordChangeHow, string> = {
  change: 'You changed it in your account settings.',
  reset_link: 'It was set from a password reset link sent to this address.',
  cli: 'It was reset on the server console by the operator of this installation.',
  two_factor_reset_cli:
    'Your two-factor login was reset on the server console by the operator of this installation: set it up again at your next sign-in.',
};

const securityNote = (origin: string) =>
  `If this was not you, reset your password now at ${origin.replace(/\/+$/, '')}/forgot-password and tell your administrator.`;

/** "Your password was changed" (or "your two-factor login was reset"): every change, reset and admin reset (R3). */
export function passwordChangedMail(opts: {
  to: string;
  name: string;
  when: Date;
  ip?: string | null | undefined;
  how: PasswordChangeHow;
  origin: string;
}): MailMessage {
  const twoFactor = opts.how === 'two_factor_reset_cli';
  const what = twoFactor ? 'two-factor login was reset' : 'password was changed';
  return {
    ...brandedMail({
      to: opts.to,
      subject: `Your ${PRODUCT} ${what}`,
      preheader: `Your ${what} on ${opts.when.toUTCString()}.`,
      heading: twoFactor ? 'Your two-factor login was reset' : 'Your password was changed',
      origin: opts.origin,
      body: [
        `Hello ${opts.name},`,
        `The ${twoFactor ? 'two-factor login' : 'password'} of your ${PRODUCT} account changed. ${HOW_TEXT[opts.how]}`,
        {
          facts: [
            ['When', opts.when.toUTCString()],
            ...(opts.ip ? ([['From address', opts.ip]] as Array<[string, string]>) : []),
          ],
        },
      ],
      note: securityNote(opts.origin),
    }),
    sensitive: true,
  };
}

/** "New sign-in to your account": a sign-in from a browser family and address not seen in 180 days (R4, D2). */
export function newSignInMail(opts: {
  to: string;
  name: string;
  when: Date;
  ip?: string | null | undefined;
  device: string;
  origin: string;
}): MailMessage {
  return {
    ...brandedMail({
      to: opts.to,
      subject: `New sign-in to your ${PRODUCT} account`,
      preheader: `A sign-in from ${opts.device} on ${opts.when.toUTCString()}.`,
      heading: 'New sign-in to your account',
      origin: opts.origin,
      body: [
        `Hello ${opts.name},`,
        'Your account was just signed in to from a browser or address we have not seen for it before.',
        {
          facts: [
            ['When', opts.when.toUTCString()],
            ['Browser', opts.device],
            ...(opts.ip ? ([['From address', opts.ip]] as Array<[string, string]>) : []),
          ],
        },
        'If this was you, there is nothing to do.',
      ],
      note: securityNote(opts.origin),
    }),
    sensitive: true,
  };
}

/** "Sign-in to your account is paused": the account lock (R2), at most once a day per account. */
export function accountLockedMail(opts: {
  to: string;
  name: string;
  until: Date;
  failures: number;
  origin: string;
}): MailMessage {
  return {
    ...brandedMail({
      to: opts.to,
      subject: `Sign-in to your ${PRODUCT} account is paused`,
      preheader: `${opts.failures} failed sign-ins: sign-in is paused until ${opts.until.toUTCString()}.`,
      heading: 'Sign-in to your account is paused',
      origin: opts.origin,
      body: [
        `Hello ${opts.name},`,
        `There were ${opts.failures} failed attempts to sign in to your account, so new sign-ins are paused until ${opts.until.toUTCString()}.`,
        'A browser you signed in from in the last 30 days still works. Resetting your password ends the pause.',
      ],
      note: securityNote(opts.origin),
    }),
    sensitive: true,
  };
}

/** "Your password was right, the code was not": someone may know the password (R2), at most once an hour. */
export function secondFactorFailedMail(opts: {
  to: string;
  name: string;
  when: Date;
  ip?: string | null | undefined;
  origin: string;
}): MailMessage {
  return {
    ...brandedMail({
      to: opts.to,
      subject: `A sign-in to your ${PRODUCT} account failed at the second step`,
      preheader: 'The password was right, the two-factor code was not.',
      heading: 'Someone may know your password',
      origin: opts.origin,
      body: [
        `Hello ${opts.name},`,
        'Someone signed in to your account with the right password, then gave a wrong two-factor code. If that was not you, change your password now.',
        {
          facts: [
            ['When', opts.when.toUTCString()],
            ...(opts.ip ? ([['From address', opts.ip]] as Array<[string, string]>) : []),
          ],
        },
      ],
      note: securityNote(opts.origin),
    }),
    sensitive: true,
  };
}

/**
 * An Owner or Admin reset the person's password or two-factor login from the members list (R6): sent on every admin
 * reset, with when, who and from where. The temporary password itself is never in a mail.
 */
export function memberResetNoticeMail(opts: {
  to: string;
  name: string;
  orgName: string;
  what: 'password' | 'two_factor';
  by: string;
  when: Date;
  ip?: string | null | undefined;
  origin: string;
}): MailMessage {
  const thing = opts.what === 'password' ? 'password' : 'two-factor login';
  return brandedMail({
    to: opts.to,
    subject: `Your ${PRODUCT} ${thing} was reset by ${opts.orgName}`,
    preheader: `${opts.by} of ${opts.orgName} reset your ${thing}.`,
    heading: opts.what === 'password' ? 'Your password was reset' : 'Your two-factor login was reset',
    origin: opts.origin,
    body: [
      `Hello ${opts.name},`,
      `${opts.by}, an Owner or Admin of ${opts.orgName}, reset the ${thing} of your ${PRODUCT} account on ${opts.when.toUTCString()}${opts.ip ? ` from ${opts.ip}` : ''}. You were signed out everywhere.`,
      opts.what === 'password'
        ? 'They were given a temporary password to pass on to you; you choose your own the next time you sign in.'
        : 'You set up two-factor login again the next time you sign in.',
    ],
    note: `If you did not expect this, reset your password with "Forgot password?" on the sign-in page and tell the ${PRODUCT} team.`,
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
      `Thank you for contacting ${PRODUCT} support. We have received your request and you should get a response ${SUPPORT_RESPONSE_TIME}.`,
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
      TEAM,
    ],
    ...(opts.link ? { cta: { label: 'Answer in Help, My requests', url: opts.link } } : {}),
    note: `${PRODUCT} support. ${SLOGAN}`,
  });
}

/** A notice for the platform (support) address about something that landed on the super admin console. */
export function platformNoticeMail(opts: {
  to: string;
  subject: string;
  heading: string;
  facts: Array<[string, string]>;
  link: string;
  linkLabel: string;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: oneLine(opts.subject),
    preheader: oneLine(opts.facts.map(([k, v]) => `${k}: ${v}`).join(', ')).slice(0, 110),
    heading: opts.heading,
    origin: opts.origin,
    body: [{ facts: opts.facts.map(([k, v]) => [k, oneLine(v)] as [string, string]) }],
    cta: { label: opts.linkLabel, url: opts.link },
    note: 'You get this because notifications for the super admin console are switched on (Support page).',
  });
}

// ------------------------------------------------------------------------------------------------ public forms

/**
 * The secure link of a client whose form could not land because the firm's runner was offline. Only the firm name,
 * the link and its expiry: never a form title, an answer or a client reference.
 */
export function formSecureLinkMail(opts: {
  to: string;
  firmName: string;
  link: string;
  expiresAt: Date;
  origin: string;
}): MailMessage {
  const firm = oneLine(opts.firmName) || 'The firm';
  return brandedMail({
    to: opts.to,
    subject: `Your secure link from ${firm}`,
    preheader: 'Send your form now with your secure link.',
    heading: `${firm} is ready for your form`,
    origin: opts.origin,
    body: [`${firm} could not receive your form earlier. You can send it now with your secure link.`],
    cta: { label: 'Open your secure link', url: opts.link },
    note: `This link works once and expires on ${expiry(opts.expiresAt)}. If you did not ask for it, you can ignore this email.`,
  });
}
