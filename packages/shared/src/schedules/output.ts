import type { OutputDestination, WebhookFormat } from '../events/schedule.ts';
import { type WebhookData, webhookBody } from './index.ts';

/** What the agent produced for a card, as read when the card is done. */
export interface CardOutput {
  ref: string;
  title: string;
  /** The agent's last handoff note, or the summary of the investigation report. */
  text: string;
  source: 'handoff' | 'report';
  /** Absolute link to the card. */
  link: string;
  /** Links to the cards and rules a brief cites (Brief cards only; absent: outputs are unchanged). */
  links?: Array<{ label: string; url: string }>;
}

const linkLines = (o: CardOutput): string => (o.links?.length ? o.links.map((l) => `- ${l.label}: ${l.url}`).join('\n') : '');

export const OUTPUT_EMPTY_TEXT = '(no text: see the card)';
/** Meta's template variable limit differs between sources: keep it low and in one place. */
export const WHATSAPP_EXCERPT_MAX = 500;
export const EMAIL_TEXT_MAX = 20_000;
export const SHEET_TEXT_MAX = 45_000;
export const CHAT_EXCERPT_MAX = 3000;

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const outputText = (o: CardOutput): string => o.text.trim() || OUTPUT_EMPTY_TEXT;

/** Subject of an output e-mail: the destination's own subject (with `{ref}` and `{title}`), or "<automation>: <ref> <title>". */
export function outputEmailSubject(o: CardOutput, scheduleName: string, subject: string): string {
  const own = subject
    .replace(/\{ref\}/g, o.ref)
    .replace(/\{title\}/g, o.title)
    .trim();
  return cut(own || `${scheduleName}: ${o.ref} ${o.title}`, 200);
}

export function outputEmail(
  o: CardOutput,
  scheduleName: string,
  dest: Extract<OutputDestination, { kind: 'email' }>,
): { to: string[]; subject: string; text: string } {
  return {
    to: dest.to,
    subject: outputEmailSubject(o, scheduleName, dest.subject),
    text: `${cut(outputText(o), EMAIL_TEXT_MAX)}${o.links?.length ? `\n\nLinks:\n${linkLines(o)}` : ''}\n\n${o.link}`,
  };
}

export interface OutputWebhookCtx {
  scheduleId: string;
  scheduleName: string;
  at: string;
  test?: boolean;
}

/** The JSON body of an output webhook. `generic` carries the card and the source of the text; chat formats get a text. */
export function outputWebhookBody(
  format: WebhookFormat,
  o: CardOutput,
  c: OutputWebhookCtx,
): Record<string, unknown> {
  if (format === 'generic')
    return {
      event: c.test ? 'schedule.test' : 'schedule.output',
      schedule: { id: c.scheduleId, name: c.scheduleName },
      trigger: c.test ? 'test' : 'event',
      at: c.at,
      text: outputText(o),
      data: {
        card: { ref: o.ref, title: o.title, url: o.link },
        output: { source: o.source },
        ...(o.links?.length ? { links: o.links } : {}),
      },
    };
  const d: WebhookData = {
    scheduleId: c.scheduleId,
    scheduleName: c.scheduleName,
    trigger: c.test ? 'test' : 'event',
    at: c.at,
    text: `${o.ref} ${o.title}\n${cut(outputText(o), CHAT_EXCERPT_MAX)}${o.links?.length ? `\n${linkLines(o)}` : ''}\n${o.link}`,
  };
  return webhookBody(format, d);
}

/**
 * One WhatsApp template variable / text line: newlines become " · ", runs of spaces are squeezed, the excerpt is cut
 * at `WHATSAPP_EXCERPT_MAX`, then the link follows.
 */
export function whatsappText(o: CardOutput): string {
  const flat = outputText(o)
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return `${cut(flat, WHATSAPP_EXCERPT_MAX)} ${o.link}`;
}

/** The five agreed columns: timestamp (UTC), automation, card ref, title, output text and link. */
export function sheetRow(at: string, scheduleName: string, o: CardOutput): string[] {
  return [at, scheduleName, o.ref, o.title, `${cut(outputText(o), SHEET_TEXT_MAX)}${o.links?.length ? `\n\nLinks:\n${linkLines(o)}` : ''}\n\n${o.link}`];
}

/** A short, secret-free label for the history: where an output goes. */
export function outputTarget(d: OutputDestination): string {
  switch (d.kind) {
    case 'email':
      return d.to.join(', ');
    case 'webhook':
      try {
        return new URL(d.url).host;
      } catch {
        return d.url;
      }
    case 'whatsapp':
      return d.to.join(', ');
    case 'google_sheet':
      return `Sheet ${d.spreadsheetId.slice(0, 8)}… / ${d.sheet}`;
  }
}

/** The tab of a Google Sheet in A1 notation (quoted when it has spaces or quotes). */
export const sheetRange = (sheet: string): string =>
  `${/^[A-Za-z0-9_]+$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!A:E`;

/** The id inside a pasted Google Sheets URL, or the input when it already is an id. */
export function spreadsheetIdFrom(input: string): string {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(input);
  return (m?.[1] ?? input).trim();
}
