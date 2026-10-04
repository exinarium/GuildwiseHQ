/**
 * The leak check for outbound drafts (docs/SPEC.md "External systems boundary": internal stays internal). An update to
 * a company system is written in the manager's voice and says what was done, never how the team did it: agent names,
 * review comments, bounce history and question threads stay on the board. The server runs this on every draft and on
 * every edit; the runner runs it once more before it posts (defence in depth, with the names it was given).
 */

/** Phrases that only make sense inside the organization. Each entry is a label and a case-insensitive pattern. */
const INTERNAL_TERMS: ReadonlyArray<readonly [string, RegExp]> = [
  ['agent', /\bagents?\b/i],
  ['bounce', /\bbounc(?:e|es|ed|ing)\b/i],
  ['review comments', /\breview(?:er)?s?['’]?\s+(?:comments?|feedback|notes?|said|asked|rejected)\b/i],
  ['review comments', /\b(?:comments?|feedback)\s+from\s+(?:the\s+)?review(?:er|ers)?\b/i],
  ['changes requested', /\bchanges\s+requested\b/i],
  ['rework', /\brework(?:ed|\s+round)?\b/i],
  ['decision desk', /\b(?:decision\s+desk|desk\s+item|the\s+desk)\b/i],
  ['question thread', /\bquestion\s+thread\b/i],
  ['escalation', /\bescalat(?:e|ed|es|ion|ions)\b/i],
  ['ledger', /\bledger\b/i],
  ['role title', /\b(?:builders?|reviewers?|business\s+analyst)\b/i],
  ['role title', /\bBA\b/],
  ['product name', /\b(?:Agent\s+Org\s+Manager|AOM)\b/],
];

export interface LeakResult {
  ok: boolean;
  /** What was found, once each, in the order of appearance. */
  matches: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds internal names and terms in a draft. `agentNames` are the organization's agents (whole word, case-sensitive). */
export function checkOutboundLeaks(body: string, agentNames: readonly string[] = []): LeakResult {
  const found: Array<{ at: number; text: string }> = [];
  for (const name of new Set(agentNames.map((n) => n.trim()).filter((n) => n.length >= 2))) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'u').exec(body);
    if (m) found.push({ at: m.index, text: `agent name "${name}"` });
  }
  for (const [label, re] of INTERNAL_TERMS) {
    const m = re.exec(body);
    if (m) found.push({ at: m.index, text: `"${m[0]}" (${label})` });
  }
  found.sort((a, b) => a.at - b.at);
  const matches = [...new Set(found.map((f) => f.text))];
  return { ok: matches.length === 0, matches };
}

/** The message shown to the BA or the manager when a draft is refused. */
export const leakMessage = (matches: readonly string[]): string =>
  `The draft mentions internal details (${matches.join(', ')}). An update to an outside system says what was done, in the manager's voice, and never names agents or describes reviews, bounces or questions. Rewrite it without them.`;
