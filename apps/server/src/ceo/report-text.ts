import { type Queryable, rows } from '../db/sql.ts';

/**
 * Plain wording for the text of the daily report (the facts under "The facts behind this report" and the CEO's brief).
 * Free text that reaches the digest (signal details, answers, DevOps requests) can carry what was written for a
 * program: a raw question id, the validation message of a refused command, or a whole prompt. The owner reads it at
 * breakfast, so:
 * - "question 7d92c125..." becomes the question's title (or just "a question" when it is not known);
 * - internal validation messages ("option o1 is not one of the item's options") are dropped;
 * - a long body is cut to its first line, a short summary.
 */

/** Longest summary of a request or note in the report. */
export const REPORT_SUMMARY_MAX = 140;

const QUESTION_REF = /\bquestion\s+([0-9a-f]{8})(?:[0-9a-f-]{0,28})?\s*(?:…|\.\.\.)?/gi;

/** Messages the server and the CLI return to an agent for a refused command: not information for the owner. */
const INTERNAL_MESSAGES: RegExp[] = [
  /(?:--)?option\s+\S+\s+is not one of the item'?s? options\.?/gi,
  /this item is already (?:answered|dismissed|resolved|closed|open)\.?/gi,
  /that desk item does not exist\.?/gi,
  /this question is no longer routed to you\.?(?: Finish now\.?)?/gi,
  /give --option or --text\.?/gi,
];

export function clip(text: string, max = REPORT_SUMMARY_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The first line of a long body, cut short: the summary of a request. */
export function summarize(body: string, max = REPORT_SUMMARY_MAX): string {
  const first = body.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return clip(first, max);
}

/** Replaces `question <id>` with the question's title; `titles` maps the first 8 characters of an id to a title. */
export function plainText(text: string, titles: ReadonlyMap<string, string> = new Map()): string {
  let out = text.replace(QUESTION_REF, (_m, id: string) => {
    const title = titles.get(id.toLowerCase());
    return title ? `the question "${clip(title, 80)}"` : 'a question';
  });
  for (const re of INTERNAL_MESSAGES) out = out.replace(re, '');
  return out
    .replace(/\(\s*[;,:]?\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/^[\s.;:,-]+/, '')
    .trim();
}

/** The titles of the questions a text refers to by id prefix, loaded for the organization. */
export async function questionTitles(
  db: Queryable,
  orgId: string,
  texts: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const prefixes = new Set<string>();
  for (const t of texts)
    for (const m of (t ?? '').matchAll(QUESTION_REF)) prefixes.add((m[1] as string).toLowerCase());
  const map = new Map<string, string>();
  for (const p of prefixes) {
    const r = await rows<{ title: string }>(
      db,
      `SELECT title FROM desk_items WHERE org_id=$1 AND id::text LIKE $2 ORDER BY created_at DESC LIMIT 1`,
      [orgId, `${p}%`],
    );
    if (r[0]) map.set(p, r[0].title);
  }
  return map;
}
