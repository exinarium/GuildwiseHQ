import { PUBLIC_TERMS } from './public-terms.ts';
import { TOPIC_AREAS, TOPIC_LIMITS, type TopicArea, type TopicProposal } from './topic.ts';

/**
 * The deterministic gate in front of the blog writer (docs/design/ceo-blog-topics.md section 3). Pure: no clock, no
 * database, no model. A question that passes is a `ScrubbedTopic`, the only type the queue accepts.
 */

declare const scrubbed: unique symbol;
/** A topic that `scrubTopic` accepted. Nothing else constructs one (the brand is not exported as a value). */
export type ScrubbedTopic = TopicProposal & { readonly [scrubbed]: true };

export type ScrubCode =
  | 'too_short'
  | 'too_long'
  | 'not_a_question'
  | 'more_than_one_sentence'
  | 'bad_area'
  | 'non_ascii'
  | 'too_many_digits'
  | 'symbol'
  | 'url'
  | 'email'
  | 'ip_address'
  | 'host_name'
  | 'file_path'
  | 'ticket_key'
  | 'identifier'
  | 'handle'
  | 'quoted_text'
  | 'cli_flag'
  | 'camel_case'
  | 'snake_case'
  | 'deny_list'
  | 'deny_list_similar'
  | 'unknown_proper_noun'
  | 'first_person';

export interface ScrubFinding {
  code: ScrubCode;
  /** The offending fragment of the question (never a deny-list entry, so the findings can go to the proposer). */
  detail?: string;
  /** The owner may confirm this finding away (an unknown proper noun): pass the word in `allowTerms`. */
  overridable?: boolean;
}

export interface ScrubOptions {
  /** Names of the organization (projects, repos, agents, people, hosts...). Built on the server per org; never sent on. */
  denyList?: readonly string[];
  /** Extra proper nouns that are fine for this proposal (an owner's second confirmation). */
  allowTerms?: readonly string[];
}

export type ScrubResult =
  | { ok: true; topic: ScrubbedTopic; findings: ScrubFinding[] }
  | { ok: false; findings: ScrubFinding[] };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const WORD_EDGE = (core: string) => `(?<![A-Za-z0-9])${core}(?![A-Za-z0-9])`;

/** Replaces every allowed public term (whole word, any case) with a neutral word, longest terms first. */
function maskTerms(text: string, terms: readonly string[]): string {
  let out = text;
  for (const t of [...terms].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(WORD_EDGE(escapeRe(t)), 'gi'), 'tech');
  return out;
}

/** Edit distance, stopping early once it passes 1. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

const FIRST_PERSON =
  /(?<![A-Za-z'])(we|we're|we've|we'll|our|ours|ourselves|us|my|mine|me|i|i'm|i've|i'd|i'll|let's)(?![A-Za-z'])/i;

const PATTERNS: Array<{ code: ScrubCode; re: RegExp }> = [
  { code: 'url', re: /\b(?:https?|ftp|ssh|file):\/\/\S*|\bwww\.\S+/i },
  { code: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/ },
  { code: 'ip_address', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b|\b(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{1,4}\b/i },
  {
    code: 'host_name',
    re: /\b[\w-]+(?:\.[\w-]+){2,}\b|\b[\w-]+\.(?:com|io|net|org|dev|app|co|local|internal|cloud|ai|xyz|sh|lan|corp|test)\b|\b[\w-]+:\d{2,5}\b/i,
  },
  { code: 'file_path', re: /[\\/~]/ },
  { code: 'ticket_key', re: /\b[A-Z]{2,}-\d+\b/ },
  {
    code: 'identifier',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/i,
  },
  { code: 'handle', re: /(?:^|[^A-Za-z0-9])@\w+/ },
  { code: 'quoted_text', re: /["“”‘’]/ },
  { code: 'cli_flag', re: /(?:^|\s)--?[A-Za-z][\w-]*/ },
  { code: 'snake_case', re: /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/ },
  { code: 'camel_case', re: /\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/ },
];

/** Characters that may remain once the specific patterns found nothing: letters, digits, space and light punctuation. */
const PLAIN = /^[A-Za-z0-9 ,'\-():.?]*$/;

/**
 * Checks one proposed research question. Any finding rejects it; the findings carry a reason code (and the fragment,
 * where that is safe) so the proposer can retry. Pure and deterministic.
 */
export function scrubTopic(
  input: { question: string; area: string; audience?: TopicProposal['audience'] },
  opts: ScrubOptions = {},
): ScrubResult {
  const findings: ScrubFinding[] = [];
  const add = (code: ScrubCode, detail?: string, overridable?: boolean) => {
    if (!findings.some((f) => f.code === code && f.detail === detail))
      findings.push({ code, ...(detail ? { detail } : {}), ...(overridable ? { overridable } : {}) });
  };
  const question = (input.question ?? '').trim().replace(/\s+/g, ' ');

  // ---- shape
  if (question.length < TOPIC_LIMITS.questionMin) add('too_short');
  if (question.length > TOPIC_LIMITS.questionMax) add('too_long');
  if (!(TOPIC_AREAS as readonly string[]).includes(input.area)) add('bad_area');
  if (!question.endsWith('?')) add('not_a_question');
  if (/[^\x20-\x7e]/.test(question)) add('non_ascii');
  if ((question.match(/\d/g) ?? []).length > TOPIC_LIMITS.maxDigits) add('too_many_digits');

  // The public terms are masked first, so "Node.js" or "CI/CD" are not read as a host or a path.
  const allowed = [...PUBLIC_TERMS, ...(opts.allowTerms ?? [])].map((t) => t.trim()).filter(Boolean);
  const masked = maskTerms(question, allowed);

  // One sentence: a single trailing "?", no sentence end followed by more text.
  const body = masked.endsWith('?') ? masked.slice(0, -1) : masked;
  if (/[?!]/.test(body) || /\.(?:\s|$)/.test(body)) add('more_than_one_sentence');

  // ---- identifiers
  for (const { code, re } of PATTERNS) {
    // A scheme such as "https" and an address are public-looking words, so these two read the raw text.
    const m = re.exec(code === 'url' || code === 'email' ? question : masked);
    if (m) add(code, m[0].trim().slice(0, 40));
  }
  if (!PLAIN.test(masked) && !findings.some((f) => f.code === 'non_ascii')) add('symbol');

  // ---- narrative
  const fp = FIRST_PERSON.exec(body);
  if (fp) add('first_person', fp[0]);

  // ---- the organization's own names
  const lower = question.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  for (const raw of opts.denyList ?? []) {
    const term = raw.trim().toLowerCase();
    if (term.length < 3) continue;
    if (new RegExp(WORD_EDGE(escapeRe(term)), 'i').test(lower)) {
      add('deny_list');
      continue;
    }
    const single = term.replace(/[^a-z0-9]/g, '');
    if (
      single.length >= 5 &&
      !/[^a-z0-9]/.test(term) &&
      words.some((w) => w.length >= 4 && withinOneEdit(w, single))
    )
      add('deny_list_similar');
  }

  // ---- proper nouns: every capitalised word that does not start the sentence must be a public term
  const tokens = masked.split(/\s+/).filter(Boolean);
  tokens.forEach((tok, i) => {
    if (i === 0) return;
    const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z0-9]+$/g, '');
    if (/^[A-Z]/.test(w) && w !== 'I') add('unknown_proper_noun', w, true);
  });

  const hard = findings;
  if (hard.length) return { ok: false, findings };
  const topic = {
    question,
    area: input.area as TopicArea,
    ...(input.audience ? { audience: input.audience } : {}),
  } as ScrubbedTopic;
  return { ok: true, topic, findings: [] };
}
