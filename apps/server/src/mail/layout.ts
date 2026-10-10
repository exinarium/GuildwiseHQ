import type { MailMessage } from './mailer.ts';

/**
 * The one branded layout every mail goes through (docs/ARCHITECTURE.md, "Mail"). A template builds its content as
 * data (`body` blocks, a call-to-action, a note) and `brandedMail` produces the HTML part (table layout, inline CSS
 * for clients that strip <style>, a <style> block with dark-mode overrides for those that honour it) and the plain-
 * text part. Colours are the product tokens of apps/web/src/tokens.css; the logo is the 2x PNG mark (apps/web/public/brand/logo-mark-mail@2x.png, 72 px shown at 36 px, rendered from logo-mark.svg) served from the
 * public origin (SVG is not safe in mail clients).
 *
 * Mail never carries a login name or a personal email address: whoever is named in it is a display name, an
 * organization or the team (see `senderName`).
 */

/** User-facing product name (the web app keeps the same constant in apps/web/src/brand.ts). */
export const PRODUCT = 'Guildwise HQ';
export const SLOGAN = 'Many hands. One master.';
export const TEAM = 'The Guildwise HQ team';
/** The website shown in the footer; the app itself lives on the public origin. */
export const SITE_URL = 'https://guildwisehq.com';

export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Header/subject-safe: no line breaks. */
export const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

/**
 * Who a mail says an invitation or action comes from. A display name if the person has one that is not their login
 * (an email address), else the organization, else the team. Never the login username or an email local part.
 */
export function senderName(opts: {
  displayName?: string | null | undefined;
  /** The person's login email: a display name equal to its local part is a username and is not used. */
  email?: string | null | undefined;
  orgName?: string | null | undefined;
}): string {
  const name = opts.displayName?.trim();
  const local = opts.email?.split('@')[0]?.trim().toLowerCase();
  if (name && !name.includes('@') && name.toLowerCase() !== local) return name;
  const org = opts.orgName?.trim();
  if (org) return org;
  return TEAM;
}

/** One block of the mail body. A bare string is a paragraph (escaped). */
export type MailBlock =
  | string
  /** A paragraph with markup the template vouches for (already escaped), and its plain-text twin. */
  | { html: string; text: string }
  /** The words of someone else (a message, a reply): preformatted, in a quote bar. */
  | { quote: string }
  /** Label and value rows. */
  | { facts: Array<[label: string, value: string]> }
  /** Bullet points. */
  | { list: string[] }
  /** Small grey print inside the body. */
  | { small: string };

export interface BrandedMailOptions {
  to: string;
  subject: string;
  /** The grey preview line mail programs show next to the subject. */
  preheader: string;
  heading: string;
  /** The public origin of the app (`ctx.config.publicOrigin`): the logo and the footer links are absolute. */
  origin: string;
  body: MailBlock[];
  /** A single button. */
  cta?: { label: string; url: string };
  /** A line under the button (an expiry, "if this was not you"). */
  note?: string;
  replyTo?: string | undefined;
  /** Override for the generated plain-text part (rarely needed). */
  text?: string;
}

const C = {
  canvas: '#f5f6f8',
  surface: '#ffffff',
  line: '#e2e5ea',
  fg: '#12161f',
  muted: '#4b5365',
  subtle: '#5e687a',
  brand: '#3446d9',
  brandFg: '#ffffff',
  brandSoft: '#e8ebfd',
  sunken: '#eef0f4',
  accent: '#d4f24a',
  side: '#0d1220',
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function blockHtml(b: MailBlock): string {
  const p = `margin:0 0 16px;font-size:16px;line-height:1.55;color:${C.fg}`;
  if (typeof b === 'string') return `<p class="fg" style="${p}">${esc(b)}</p>`;
  if ('html' in b) return `<p class="fg" style="${p}">${b.html}</p>`;
  if ('quote' in b)
    return `<div class="quote fg" style="margin:0 0 16px;padding:10px 14px;border-left:3px solid ${C.brand};background:${C.sunken};color:${C.fg};font-size:15px;line-height:1.55;white-space:pre-wrap">${esc(b.quote)}</div>`;
  if ('facts' in b)
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse">${b.facts
      .map(
        ([k, v]) =>
          `<tr><td class="muted line" style="padding:6px 12px 6px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.muted};white-space:nowrap;vertical-align:top">${esc(k)}</td><td class="fg line" style="padding:6px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.fg}">${esc(v)}</td></tr>`,
      )
      .join('')}</table>`;
  if ('list' in b)
    return `<ul class="fg" style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:1.55;color:${C.fg}">${b.list.map((i) => `<li style="margin:0 0 4px">${esc(i)}</li>`).join('')}</ul>`;
  return `<p class="muted" style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${C.muted}">${esc(b.small)}</p>`;
}

function blockText(b: MailBlock): string {
  if (typeof b === 'string') return b;
  if ('html' in b) return b.text;
  if ('quote' in b) return b.quote.replace(/^/gm, '> ');
  if ('facts' in b) return b.facts.map(([k, v]) => `${k}: ${v}`).join('\n');
  if ('list' in b) return b.list.map((i) => `- ${i}`).join('\n');
  return b.small;
}

/** The finished message: styled HTML plus a plain-text part with the same content. */
export function brandedMail(o: BrandedMailOptions): MailMessage {
  const origin = o.origin.replace(/\/+$/, '');
  const logo = `${origin}/brand/logo-mark-mail@2x.png`;
  const subject = oneLine(o.subject);
  const button = o.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td class="btn" style="border-radius:8px;background:${C.brand}"><a href="${esc(o.cta.url)}" class="btn" style="display:inline-block;padding:13px 26px;font-size:16px;font-weight:600;line-height:1.2;color:${C.brandFg};text-decoration:none;border-radius:8px;background:${C.brand}">${esc(o.cta.label)}</a></td></tr></table><p class="muted" style="margin:0 0 20px;font-size:13px;line-height:1.5;color:${C.muted}">Button not working? Copy this link into your browser:<br><a href="${esc(o.cta.url)}" class="link" style="color:${C.brand};word-break:break-all">${esc(o.cta.url)}</a></p>`
    : '';
  const note = o.note
    ? `<p class="muted" style="margin:0 0 4px;font-size:13px;line-height:1.5;color:${C.muted}">${esc(o.note)}</p>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title>
<style>
@media (prefers-color-scheme: dark){
  .canvas{background:#0b0e14 !important}
  .card{background:#131822 !important;border-color:#262d3b !important}
  .fg{color:#eceff5 !important}
  .muted{color:#a9b2c3 !important}
  .line{border-color:#262d3b !important}
  .quote{background:#1a2030 !important}
  .link{color:#9daeff !important}
  .btn{background:#4c63f0 !important;color:#ffffff !important}
}
@media (max-width:620px){.card{border-radius:0 !important}.pad{padding:24px 20px !important}}
</style></head>
<body class="canvas" style="margin:0;padding:0;background:${C.canvas};font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${esc(o.preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="canvas" style="background:${C.canvas}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:10px;vertical-align:middle"><img src="${esc(logo)}" width="36" height="36" alt="" style="display:block;border:0;border-radius:8px"></td><td class="fg" style="vertical-align:middle;font-family:${FONT};font-size:18px;font-weight:700;color:${C.fg};letter-spacing:-0.01em">${PRODUCT}</td></tr></table></td></tr>
<tr><td class="card" style="background:${C.surface};border:1px solid ${C.line};border-radius:12px;border-top:4px solid ${C.accent}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pad" style="padding:32px 36px 24px;font-family:${FONT}">
<h1 class="fg" style="margin:0 0 20px;font-size:24px;line-height:1.25;font-weight:700;color:${C.fg}">${esc(o.heading)}</h1>
${o.body.map(blockHtml).join('\n')}
${button}${note}
</td></tr></table></td></tr>
<tr><td align="center" style="padding:20px 12px 8px;font-family:${FONT}"><p class="muted" style="margin:0 0 4px;font-size:13px;line-height:1.5;color:${C.muted}"><strong>${PRODUCT}</strong> &middot; ${esc(SLOGAN)}</p><p class="muted" style="margin:0;font-size:12px;line-height:1.5;color:${C.subtle}"><a href="${SITE_URL}" class="link" style="color:${C.brand};text-decoration:underline">${SITE_URL.replace('https://', '')}</a> &middot; <a href="${esc(origin)}/privacy" class="link" style="color:${C.brand};text-decoration:underline">Privacy</a> &middot; <a href="${esc(origin)}/terms" class="link" style="color:${C.brand};text-decoration:underline">Terms</a></p></td></tr>
</table></td></tr></table></body></html>`;

  const text =
    o.text ??
    [
      o.heading,
      '',
      ...o.body.flatMap((b) => [blockText(b), '']),
      ...(o.cta ? [`${o.cta.label}:`, o.cta.url, ''] : []),
      ...(o.note ? [o.note, ''] : []),
      '--',
      `${PRODUCT}. ${SLOGAN}`,
      SITE_URL,
      `Privacy: ${origin}/privacy  Terms: ${origin}/terms`,
      '',
    ].join('\n');

  return { to: o.to, subject, html, text, ...(o.replyTo ? { replyTo: o.replyTo } : {}) };
}
