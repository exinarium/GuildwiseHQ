import { type Queryable, type Row, rows } from '../db/sql.ts';

const REF_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const RULE_RE = /\brule ([0-9a-f]{8})\b/gi;

/**
 * The check on the handoff note of a Brief card's `brief` stage. Returns the message for the agent (who shortens or
 * corrects the note and reports again in the same shift), or null when the note is fine.
 */
export async function checkBriefNote(db: Queryable, card: Row, note: string): Promise<string | null> {
  const text = note.trim();
  if (!text) return 'The brief is empty: write it as your handoff note and report again.';
  const cap = Number((card.fields as Record<string, unknown> | null)?.maxWords);
  const words = text.split(/\s+/).length;
  if (Number.isFinite(cap) && cap > 0 && words > cap)
    return `The brief has ${words} words; the cap is ${cap}. Shorten it and report again.`;

  const refs = [...new Set(text.match(REF_RE) ?? [])].filter((r) => r !== card.ref);
  if (refs.length) {
    const found = await rows(db, 'SELECT ref FROM cards WHERE org_id=$1 AND ref = ANY($2::text[])', [
      card.org_id,
      refs,
    ]);
    const known = new Set(found.map((r) => r.ref as string));
    const unknown = refs.filter((r) => !known.has(r));
    if (unknown.length)
      return `These refs are not cards of this organization: ${unknown.join(', ')}. Use only refs from the Context.`;
  }
  const ruleIds = [...new Set([...text.matchAll(RULE_RE)].map((m) => (m[1] as string).toLowerCase()))];
  if (ruleIds.length) {
    const found = await rows(
      db,
      'SELECT left(id::text, 8) AS short FROM ledger_entries WHERE org_id=$1 AND left(id::text, 8) = ANY($2::text[])',
      [card.org_id, ruleIds],
    );
    const known = new Set(found.map((r) => r.short as string));
    const unknown = ruleIds.filter((r) => !known.has(r));
    if (unknown.length)
      return `These rule ids are not rules of this organization: ${unknown.join(', ')}. Use only rule ids from the Context.`;
  }
  const context = String((card.fields as Record<string, unknown> | null)?.context ?? '');
  const lists = new RegExp(REF_RE.source).test(context);
  if (lists && !refs.length) return 'Name the cards you mention by their ref.';
  return null;
}
