import { type GraphIndex, LEGEND } from './query.ts';
import { fenceUntrusted, sanitizeLabel } from './sanitize.ts';

/** The section of the shift instructions is never longer than this (docs/design/project-graphs.md section 7). */
export const GRAPH_BRIEF_MAX_BYTES = 1500;

export interface BriefQueryInput {
  title: string;
  /** `fields.affectedAreas` of the card. */
  affectedAreas?: string | undefined;
  /** Extra one-liners that name the area (ledger entries, the card's summary). */
  hints?: string[] | undefined;
}

/** What the section asks the graph: the card's title, its affected areas and the hints, as words. */
export function briefQueryText(c: BriefQueryInput): string {
  return [c.title, c.affectedAreas ?? '', ...(c.hints ?? [])]
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 700);
}

const HEAD =
  "## Graph context\n\nA map of this project's code, built on this workstation from the repository. ";
const TAIL =
  '\nBefore a broad grep or read, ask `aom graph query "<words>"`, `aom graph explain <node>`, `aom graph impact <file or symbol>` or `aom graph path <a> <b>`. A [I] or [A] link is a lead, not a fact: read the file before you act on it.';

/**
 * The "Graph context" section for a shift's instructions: a few start nodes and their strongest links for the card's own
 * words, at most 1.5 KB, with the repository-derived text fenced as untrusted data. Null when the graph knows nothing about
 * the card (no section is better than an empty one).
 */
export function graphBriefSection(
  index: GraphIndex,
  c: BriefQueryInput,
  maxBytes = GRAPH_BRIEF_MAX_BYTES,
): string | null {
  const q = briefQueryText(c);
  if (!q) return null;
  const r = index.query(q, { budget: 380, starts: 5, depth: 1 });
  if (r.starts === 0) return null;
  // drop the legend line (it sits outside the fence once) and the query echo
  const lines = r.text
    .split('\n')
    .filter((l) => !l.startsWith('Code graph for ') && l !== LEGEND && !l.startsWith('(cut at'));
  const fixed = HEAD.length + TAIL.length + LEGEND.length + fenceUntrusted('code graph', '').length + 8;
  const room = maxBytes - fixed;
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    const cost = Buffer.byteLength(l) + 1;
    if (used + cost > room) break;
    kept.push(l);
    used += cost;
  }
  if (kept.length < 2) return null;
  const out = `${HEAD}${LEGEND}\n${fenceUntrusted('code graph', kept.join('\n'))}${TAIL}`;
  return Buffer.byteLength(out) <= maxBytes ? out : null;
}

export const cardHints = (fields: Record<string, unknown>): string[] =>
  ['summary', 'goal', 'description']
    .map((k) => (typeof fields[k] === 'string' ? sanitizeLabel(fields[k] as string, 200) : ''))
    .filter(Boolean);

/** The two sentences a chat gets (it has no card to query for): the read-only verbs and how far to trust them. */
export const CHAT_GRAPH_NOTE =
  '## Code graph\n\nThis project has a map of its code, built on this workstation. `aom graph query "<words>"` finds the nodes and links for a question and `aom graph explain <node>` shows one node with its links (run each on its own, no pipes). A [I] or [A] link is a lead, not a fact: read the file before you answer from it.';
