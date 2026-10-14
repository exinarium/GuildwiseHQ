/**
 * Inbound e-mail rules shared by the server and the browser (docs/design/workflow-builder.md D9): addresses, the
 * sender allow-list, subject normalisation. Pure.
 */

const ADDRESS_RE = /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+$/;

/** A bare, lower-cased address from `Name <a@b.c>` or `a@b.c`; null when there is none. */
export function parseAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /<([^<>]+)>/.exec(raw);
  const s = (m?.[1] ?? raw).trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : null;
}

export const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/**
 * An allow-list entry: a full address (`ana@acme.com`) or a domain (`acme.com` or `@acme.com`). Returns the stored form
 * (`ana@acme.com` or `@acme.com`), or null when it is neither.
 */
export function normaliseAllowEntry(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@') && !s.startsWith('@')) return ADDRESS_RE.test(s) ? s : null;
  const d = s.replace(/^@/, '');
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(d) ? `@${d}` : null;
}

/** Does `sender` match one of the entries (exact address, or the domain of an `@domain` entry; subdomains do not match)? */
export function senderAllowed(sender: string | null | undefined, entries: readonly string[]): boolean {
  const a = parseAddress(sender);
  if (!a) return false;
  const d = `@${domainOf(a)}`;
  return entries.some((e) => {
    const n = normaliseAllowEntry(e);
    return n !== null && (n === a || n === d);
  });
}

/** `Re: Fwd: Hello` -> `hello` (thread matching by subject and the dedupe key). */
export function normaliseSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/^\s*(?:re|fw|fwd|aw|sv|antw)\s*(?:\[\d+\])?\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** An inbound address split at the `+token` (`slug-ab12cd+thr9f3a@in.example.com`): the base address and the token. */
export function splitPlusAddress(address: string): { base: string; token: string | null } {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus < 0) return { base: address.toLowerCase(), token: null };
  return {
    base: `${local.slice(0, plus)}@${domain}`.toLowerCase(),
    token: local.slice(plus + 1) || null,
  };
}

/** A header Message-ID with its angle brackets, or null. */
export const messageIdOf = (raw: string | null | undefined): string | null => {
  const m = raw ? /<([^<>\s]+)>/.exec(raw) : null;
  return m ? `<${m[1]}>` : null;
};

/** All Message-IDs in a `References` or `In-Reply-To` value, in order. */
export const messageIdsOf = (raw: string | null | undefined): string[] =>
  raw ? [...raw.matchAll(/<([^<>\s]+)>/g)].map((m) => `<${m[1]}>`) : [];

/** Why an inbound message was not turned into work (the settings page says it in words). */
export const MAIL_SKIP_REASONS = {
  spam: 'Looked like spam',
  sender_check_failed: 'The sender could not be verified (failed the DKIM check)',
  rate_limited: 'Too many messages arrived in the last hour',
  sender_rate_limited: 'This sender sent too many messages in the last hour',
  too_large: 'The message was larger than the limit',
  automatic: 'An automatic reply, bounce or list mail',
  address_retired: 'Sent to an address that was replaced',
  inbox_disabled: 'The inbox is switched off',
  no_automation: 'No automation picked it up',
  duplicate: 'Already received',
  trigger_failed: 'The automation failed',
} as const;
export type MailSkipReason = keyof typeof MAIL_SKIP_REASONS;

export const MAIL_STATUS_LABELS = {
  received: 'Received',
  card_created: 'Card created',
  draft_created: 'Draft card created',
  comment_added: 'Added to a card',
  processed: 'Handled by an automation',
  skipped: 'Skipped',
} as const;
export type MailMessageStatus = keyof typeof MAIL_STATUS_LABELS;
