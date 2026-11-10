import { z } from 'zod';
import { PUBLIC_TERMS } from '../blog/public-terms.ts';
import { SCRUB_PATTERNS } from '../blog/topic-scrub.ts';
import { CHANGELOG_HEADINGS, changelogHeadingOf } from './changelog-rewrite.ts';

/**
 * The gate in front of the 'Write changelog' prep step: every proposed entry is public text, so anything internal is
 * refused before the entry gets near a CHANGELOG.md. Pure: the deny list and the public filter are passed in.
 */

export type EntryFindingCode =
  | 'not_public'
  | 'multi_line'
  | 'too_long'
  | 'too_short'
  | 'ticket_key'
  | 'sha'
  | 'url'
  | 'email'
  | 'ip_address'
  | 'host_name'
  | 'secret'
  | 'deny_list'
  | 'heading';

export interface EntryFinding {
  code: EntryFindingCode;
  /** The offending fragment (never a deny-list term). */
  detail?: string;
}

export const CHANGELOG_ENTRY_LIMITS = { min: 20, max: 900 } as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const WORD_EDGE = (core: string) => `(?<![A-Za-z0-9])${core}(?![A-Za-z0-9])`;

const maskPublicTerms = (text: string): string => {
  let out = text;
  for (const t of [...PUBLIC_TERMS].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(WORD_EDGE(escapeRe(t)), 'gi'), 'tech');
  return out;
};

const PICKED = new Set(['url', 'email', 'ip_address', 'host_name']);
const SHARED = SCRUB_PATTERNS.filter((p) => PICKED.has(p.code));

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const SECRETS: RegExp[] = [
  /-----BEGIN/,
  /\b(?:ghp|gho|ghs|github_pat|glpat|xox[abp]|sk|pk)[-_][A-Za-z0-9_-]{12,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|secret|token|apikey|api_key)\s*[=:]\s*\S+/i,
  /(?=[A-Za-z0-9+/=_-]*\d)(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]{32,}/,
];

/** Checks one entry. Empty = the entry may be written exactly as it is. */
export function scrubChangelogEntry(
  e: { heading: string; text: string },
  opts: { denyList?: readonly string[]; agentHandles?: readonly string[]; publicText: (s: string) => string },
): EntryFinding[] {
  const findings: EntryFinding[] = [];
  if (!changelogHeadingOf(e.heading))
    findings.push({ code: 'heading', detail: `use one of ${CHANGELOG_HEADINGS.join(', ')}` });
  if (/[\r\n]/.test(e.text)) findings.push({ code: 'multi_line' });
  const text = e.text.replace(/\s+/g, ' ').trim();
  if (text.length < CHANGELOG_ENTRY_LIMITS.min) findings.push({ code: 'too_short' });
  if (text.length > CHANGELOG_ENTRY_LIMITS.max) findings.push({ code: 'too_long' });
  if (opts.publicText(text) !== text) findings.push({ code: 'not_public' });
  const tk = TICKET_KEY.exec(text);
  if (tk) findings.push({ code: 'ticket_key', detail: tk[0] });
  const sha = SHA.exec(text);
  if (sha) findings.push({ code: 'sha', detail: sha[0] });
  const masked = maskPublicTerms(text);
  for (const p of SHARED) {
    // Public terms (Node.js) are masked for the host name check only; a URL or address is never a public term.
    const m = p.re.exec(p.code === 'host_name' ? masked : text);
    // A version number (1.5.0) is not a host name.
    if (m && !(p.code === 'host_name' && /^[\d.]+$/.test(m[0])))
      findings.push({ code: p.code as EntryFindingCode, detail: m[0] });
  }
  if (/\blocalhost\b/i.test(text) && !findings.some((f) => f.code === 'host_name'))
    findings.push({ code: 'host_name', detail: 'localhost' });
  if (SECRETS.some((re) => re.test(text))) findings.push({ code: 'secret' });
  const strict: string[] = [...(opts.denyList ?? [])];
  const loose: string[] = [];
  for (const h of opts.agentHandles ?? [])
    (ORDINARY_WORD_HANDLES.has(h.trim().toLowerCase()) ? loose : strict).push(h);
  let denied = false;
  for (const term of strict) {
    const t = term.trim();
    if (t.length < 3) continue;
    if (new RegExp(WORD_EDGE(escapeRe(t)), 'i').test(text)) {
      denied = true;
      break;
    }
  }
  if (!denied) denied = loose.some((h) => h.trim().length >= 3 && namesAgent(text, masked, h.trim()));
  if (denied) findings.push({ code: 'deny_list' });
  return findings;
}

/** Agent handles that are also ordinary English words: matched only where they are used as a name. Lower case. */
export const ORDINARY_WORD_HANDLES: ReadonlySet<string> = new Set([
  // the built-in name pool (apps/server/src/commands/agents.ts)
  'grace',
  'rob',
  'swift',
  'crane',
  'lark',
  'finch',
  'robin',
  'wren',
  'heron',
  'kestrel',
  'osprey',
  'plover',
  'egret',
  'merlin',
  'tern',
  'ibis',
  'sparrow',
  'falcon',
  'curlew',
  'magpie',
  'starling',
  'alder',
  'birch',
  'cedar',
  'elm',
  'hazel',
  'juniper',
  'larch',
  'maple',
  'oak',
  'poplar',
  'rowan',
  'spruce',
  'willow',
  'yew',
  'aspen',
  'beech',
  'cypress',
  'hawthorn',
  'linden',
  'sycamore',
  // common given names that are words
  'mark',
  'will',
  'bill',
  'joy',
  'hope',
  'faith',
  'rose',
  'may',
  'june',
  'april',
  'august',
  'summer',
  'dawn',
  'eve',
  'amber',
  'ruby',
  'pearl',
  'ivy',
  'lily',
  'iris',
  'daisy',
  'holly',
  'violet',
  'olive',
  'penny',
  'sky',
  'storm',
  'river',
  'brook',
  'chase',
  'drew',
  'hunter',
  'guy',
  'frank',
  'art',
  'jack',
  'pat',
  'sue',
  'max',
  'ray',
  'gene',
  'herb',
  'wade',
  'lance',
  'miles',
  'dean',
  'rich',
  'sandy',
  'cliff',
  'dale',
  'glen',
  'grant',
  'mason',
  'carter',
  'cash',
  'page',
  'reed',
  'bell',
  'price',
  'don',
]);

const ROLE_WORD =
  '(?:agent|ba|architect|planner|builder|reviewer|tester|devops|ceo|scout|researcher|checker|curator|designer)';

/** Whether text uses an ordinary-word handle as a name: @Mark, Mark (BA), agent Mark, or a capitalised Mark mid-sentence. */
function namesAgent(text: string, masked: string, handle: string): boolean {
  const core = escapeRe(handle);
  const cap = escapeRe(handle[0]?.toUpperCase() + handle.slice(1));
  if (new RegExp(`@${core}(?![A-Za-z0-9])`, 'i').test(text)) return true;
  if (new RegExp(`${WORD_EDGE(core)}\\s*\\(\\s*(?:the\\s+)?${ROLE_WORD}\\b`, 'i').test(text)) return true;
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${ROLE_WORD}\\s+(${core})(?![A-Za-z0-9])`, 'gi')))
    if (/^[A-Z]/.test(m[1] ?? '')) return true;
  for (const m of masked.matchAll(new RegExp(WORD_EDGE(cap), 'g'))) {
    const before = masked.slice(0, m.index).trimEnd();
    if (before !== '' && !/[.!?:;]$/.test(before)) return true;
  }
  return false;
}

const FINDING_TEXT: Record<EntryFindingCode, string> = {
  not_public: 'contains text the public release notes would change (a /help/ link, #number or @handle)',
  multi_line: 'must be one line',
  too_long: `is longer than ${CHANGELOG_ENTRY_LIMITS.max} characters`,
  too_short: `is shorter than ${CHANGELOG_ENTRY_LIMITS.min} characters`,
  ticket_key: 'contains a ticket key',
  sha: 'contains a commit id',
  url: 'contains a URL',
  email: 'contains an email address',
  ip_address: 'contains an IP address',
  host_name: 'contains a host name',
  secret: 'looks like it contains a secret',
  deny_list: 'names an internal person, agent or machine',
  heading: 'has an unknown heading',
};

/** One sentence per finding, for the writer to fix ("entry 2: contains a ticket key 'GWP-74'"). */
export const describeEntryFinding = (index: number, f: EntryFinding): string =>
  `entry ${index + 1}: ${FINDING_TEXT[f.code]}${f.detail && f.code !== 'deny_list' ? ` '${f.detail}'` : ''}`;

const HeadingSchema = z.enum(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const);

/** What the changelog writer reports (`release-prep-proposal.json` of a `changelog_entries` task). Every change ends up in exactly one list. */
export const ChangelogProposalSchema = z.object({
  entries: z
    .array(
      z.object({
        heading: z.string().max(40),
        text: z.string().max(2000),
        sources: z.array(z.string().max(60)).min(1).max(50),
      }),
    )
    .max(60),
  covered: z
    .array(z.object({ source: z.string().max(60), existing: z.number().int().min(1) }))
    .max(600)
    .default([]),
  skipped: z
    .array(z.object({ source: z.string().max(60), reason: z.string().max(200) }))
    .max(600)
    .default([]),
});
export type ChangelogProposal = z.infer<typeof ChangelogProposalSchema>;

const EntryWithSources = z.object({
  heading: HeadingSchema,
  text: z.string().min(1).max(CHANGELOG_ENTRY_LIMITS.max),
  sources: z.array(z.string().max(60)).max(50).default([]),
});

/** `payload.changelog` of `release.docs_prep` for the step 'changelog': the checked entries to merge. */
export const ReleasePrepChangelogPayloadSchema = z.object({
  projectName: z.string().max(200).default(''),
  version: z.string().max(40).optional(),
  entries: z.array(EntryWithSources).max(60),
  proposal: z
    .object({
      covered: ChangelogProposalSchema.shape.covered,
      skipped: ChangelogProposalSchema.shape.skipped,
    })
    .optional(),
});
export type ReleasePrepChangelogPayload = z.infer<typeof ReleasePrepChangelogPayloadSchema>;

/** The stored output of the step 'changelog' for one repository (shown on the Releases page). */
export const ReleaseChangelogOutputSchema = z.object({
  created: z.boolean().default(false),
  added: z.array(EntryWithSources).max(60).default([]),
  duplicates: z
    .array(z.object({ heading: HeadingSchema, text: z.string().max(2000) }))
    .max(60)
    .default([]),
  covered: ChangelogProposalSchema.shape.covered,
  skipped: ChangelogProposalSchema.shape.skipped,
  warnings: z.array(z.string().max(500)).max(50).default([]),
});
export type ReleaseChangelogOutput = z.infer<typeof ReleaseChangelogOutputSchema>;
