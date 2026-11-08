import { renderUntrusted } from './untrusted.ts';

/**
 * Reading the card's work reference in prompts. The server fills `card.workRef` / `card.isClientRef` in the shift brief
 * (and the DevOps card) from the card's intake ticket; prompts only read those fields and never re-derive them.
 */

/** The work-reference fields on ShiftBrief.card and DevopsShift.card. */
export interface WorkRefFields {
  ref: string;
  workRef?: string;
  isClientRef?: boolean;
}

/** The card's work reference as the server sent it. An older server sends none: the internal ref, not a client one. */
export function shiftWorkRef(card: WorkRefFields): { ref: string; client: boolean } {
  return card.isClientRef === true && card.workRef
    ? { ref: card.workRef, client: true }
    : { ref: card.workRef ?? card.ref, client: false };
}

/** A ticket key safe to print as a plain value: Jira `ABC-1` or GitHub `owner/repo#12`. */
const SAFE_REF = /^(?:[A-Z][A-Z0-9]{1,9}-\d+|[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+)$/;
export const isPlainTicketKey = (s: string): boolean => SAFE_REF.test(s);

/** The client reference of a card when it has one that differs from its internal ref; null otherwise. */
export function clientWorkRef(card: WorkRefFields): string | null {
  const w = shiftWorkRef(card);
  return w.client && w.ref !== card.ref ? w.ref : null;
}

/**
 * One line naming the client reference for the DevOps texts. A reference of an unexpected shape is never printed as
 * plain text: it is shown inside an untrusted block.
 */
export function workRefLine(ref: string, internal: string): string {
  const plain = isPlainTicketKey(ref);
  const r = plain ? `\`${ref}\`` : 'the ticket key shown below';
  const line = `Work reference: ${r} (the client's ticket). Use it, never \`${internal}\`, in any commit or merge message, branch name, pull request text and anything that goes to the client.`;
  return plain ? line : `${line}\n${renderUntrusted('Ticket reference', ref)}`;
}
