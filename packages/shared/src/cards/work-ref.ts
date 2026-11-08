import { type ExternalRef, parseExternalRef, parseGithubKey } from '../external/index.ts';
import { branchName, slugify } from '../ids.ts';
import { canonicalTicketKey } from '../intake/batch.ts';
import { isSafeGitRef } from '../safe.ts';

/**
 * The work reference of a card: what the work is called outside the platform. A card made from a client ticket
 * (`fields.externalRef`) is called by that ticket's key (`ABC-1`, `acme/web#12`); every other card by its internal ref
 * (`GWP-123`). Branch names, prompts, commit messages and client-facing outputs all read it from here.
 */

const JIRA_SHAPED = /\b[A-Za-z][A-Za-z0-9]{1,9}-\d+\b/g;
const JIRA_CANONICAL = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/** The ticket a card came from (`fields.externalRef`), normalised like batch intake; null when none or unparseable. */
export function cardTicketRef(fields: unknown): ExternalRef | null {
  const raw =
    fields && typeof fields === 'object' ? (fields as { externalRef?: unknown }).externalRef : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  // Exact parse first (keeps GitHub case, finds upper-case keys); then accept Jira keys typed in lower case.
  const ref = parseExternalRef(text) ?? parseExternalRef(text.replace(JIRA_SHAPED, (k) => k.toUpperCase()));
  return ref ? { ...ref, key: canonicalTicketKey(ref) } : null;
}

export interface WorkReference {
  /** What the work is called outside the platform: `ABC-1`, `acme/web#12`, or the internal ref `GWP-123`. */
  ref: string;
  /** `ref` is the client's ticket (the card came from one), not the internal card ref. */
  isClientRef: boolean;
  /** The parsed ticket when `isClientRef`. */
  ticket: ExternalRef | null;
}

/** The card's work reference: its intake ticket key when it has one, otherwise its internal ref. */
export function workReference(card: { ref: string; fields?: unknown }): WorkReference {
  const ticket = cardTicketRef(card.fields);
  return ticket
    ? { ref: ticket.key, isClientRef: true, ticket }
    : { ref: card.ref, isClientRef: false, ticket: null };
}

/** The ref part a ticket contributes to a branch name: Jira `ABC-1` (case kept), GitHub `web-12`; null if unsafe. */
export function ticketBranchPart(ticket: ExternalRef): string | null {
  if (ticket.system === 'jira') {
    const key = ticket.key.toUpperCase();
    return JIRA_CANONICAL.test(key) ? key : null;
  }
  const gh = parseGithubKey(ticket.key);
  if (!gh) return null;
  const repo = slugify(gh.repo.split('/').pop() ?? '', 30);
  return repo ? `${repo}-${gh.number}` : `gh-${gh.number}`;
}

/** Same as ticketBranchPart, from a work reference string (the runner gets `workRef` in the brief); null if none. */
export function workRefBranchPart(workRef: string): string | null {
  const t = parseExternalRef(workRef.trim());
  return t ? ticketBranchPart({ ...t, key: canonicalTicketKey(t) }) : null;
}

export interface CardBranch {
  name: string;
  /** Set when the card has a ticket that could not be used: the name fell back to the internal ref. */
  fallbackReason?: string;
  /** The name is built from the card's ticket (not the internal ref), so it can collide with another card's. */
  fromTicket?: boolean;
}

/**
 * The branch a card gets when it has none yet. Non-intake cards: exactly `branchName(prefix, ref, title)`. Intake cards:
 * `<prefix><ticket part>-<slug(title, 40)>`, checked with isSafeGitRef; a ticket that cannot be used falls back to the
 * internal ref with a reason. The raw `externalRef` text never reaches the name: only the ticket part does.
 */
export function cardBranchName(
  prefix: string,
  card: { ref: string; title: string; fields?: unknown },
): CardBranch {
  const legacy = branchName(prefix, card.ref, card.title);
  const ticket = cardTicketRef(card.fields);
  if (!ticket) return { name: legacy };
  const part = ticketBranchPart(ticket);
  const slug = slugify(card.title, 40);
  const name = part ? `${prefix}${part}${slug ? `-${slug}` : ''}` : '';
  if (part && isSafeGitRef(name)) return { name, fromTicket: true };
  return {
    name: legacy,
    fallbackReason: `The ticket reference ${ticket.key} cannot be used in a branch name`,
  };
}
