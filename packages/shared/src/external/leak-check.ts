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
  ['product name', /\b(?:Agent\s+Org(?:ani[sz]ation)?(?:\s+Manager)?|Guildwise(?:\s+HQ)?|AOM)\b/i],
  ['internal branch', /\baom\/[\w./-]+/i],
  ['role title', /\b(?:scouts?|curators?)\b/i],
  ['standing orders', /\bstanding\s+orders?\b/i],
  // Invisible organisation (backlog #65): nothing a client reads reveals AI, the product or the card system.
  ['product link', /guildwise(?:hq)?\.com/i],
  [
    'AI',
    /\b(?:AI|A\.I\.)[\s-]+(?:agents?|assistants?|bots?|tools?|generated|powered|written)\b|\bartificial\s+intelligence\b/i,
  ],
  ['AI', /\b(?:Claude|Anthropic|ChatGPT|OpenAI|LLMs?)\b/],
  [
    'generated notice',
    /\b(?:generated|written|created|authored|drafted)\s+(?:by|with|using)\s+(?:an?\s+)?(?:AI|Claude|agent|bot|Guildwise)/i,
  ],
  ['card reference', /\bcard\s+[A-Z][A-Z0-9]{1,9}-P?\d+\b/],
];

/**
 * Agent names that are also everyday words. These match case-insensitively only when written capitalized (a name),
 * so "the Will agent" is caught and "I will fix it" is not.
 */
const COMMON_WORD_NAMES = new Set(
  [
    'will',
    'mark',
    'grace',
    'hope',
    'joy',
    'rose',
    'art',
    'bill',
    'page',
    'dawn',
    'faith',
    'rob',
    'pat',
    'sue',
    'jack',
    'may',
    'june',
    'april',
    'summer',
    'ray',
    'sky',
    'wade',
    'chase',
    'drew',
    'bob',
    'don',
    'earl',
    'frank',
    'gene',
    'guy',
    'hunter',
    'miles',
    'pierce',
    'rich',
    'sandy',
    'skip',
    'stone',
    'ward',
    'wayne',
    'case',
    'dean',
    'ivy',
    'iris',
    'lily',
    'olive',
    'pearl',
    'ruby',
    'amber',
    'autumn',
    'blake',
    'cliff',
    'dale',
    'glen',
    'heath',
    'jay',
    'lane',
    'max',
    'neil',
    'nick',
    'norm',
    'pete',
    'rod',
    'tag',
    'tom',
    'viola',
  ].map((n) => n.toLowerCase()),
);

export interface LeakResult {
  ok: boolean;
  /** What was found, once each, in the order of appearance. */
  matches: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds internal names and terms in a draft. `agentNames` are the organization's agents (whole word, case-insensitive). */
export function checkOutboundLeaks(body: string, agentNames: readonly string[] = []): LeakResult {
  const found: Array<{ at: number; text: string }> = [];
  for (const name of new Set(agentNames.map((n) => n.trim()).filter((n) => n.length >= 2))) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'giu');
    const common = COMMON_WORD_NAMES.has(name.toLowerCase());
    for (const m of body.matchAll(re)) {
      // an everyday word counts only when written like a name (capitalized, or exactly as the agent is spelled)
      if (common && m[0] !== name && m[0][0] !== m[0][0]?.toUpperCase()) continue;
      found.push({ at: m.index ?? 0, text: `agent name "${name}"` });
      break;
    }
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
