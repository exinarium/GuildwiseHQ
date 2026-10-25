import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Topic retrieval for the public assistant (R3c). The always-on system text holds the product facts and an index of help topics;
 * the help articles themselves are one chunk each (`pack/topics/<slug>.md`) and only the ones that match the visitor's question
 * are attached to their newest message, within a token budget that is checked on every request. Matching is plain keyword
 * scoring over the chunk's title, summary, headings and text (weighted, with an inverse-document-frequency so common words count
 * little), the earlier questions of the conversation at half weight (a follow-up like "and how much?" keeps its topic), and a
 * small boost from the page the visitor is on. No model call, no network: it costs nothing and is deterministic.
 */

/** Per-request limits on what is attached from the help articles. */
export const TOPIC_LIMITS = {
  /** Tokens (about four characters each) of help text attached to one question. */
  budgetTokens: 2200,
  /** Chunks attached to one question. */
  maxTopics: 3,
  /** A chunk is attached only when its score reaches this (a lone common word does not count). */
  minScore: 4,
} as const;

export const approxTokens = (s: string): number => Math.ceil(s.length / 4);

export interface TopicChunk {
  slug: string;
  title: string;
  summary: string;
  headings: string[];
  text: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** The committed pack folder (source tree: `pack/`, bundle: `assistant-pack/`). */
function packDir(): string {
  for (const d of [join(here, 'pack'), join(here, 'assistant-pack')]) {
    try {
      readFileSync(join(d, 'index.md'), 'utf8');
      return d;
    } catch {
      // try the next layout
    }
  }
  throw new Error('assistant knowledge pack not found (run: pnpm --filter @aom/server assistant:pack)');
}

export function parseChunk(slug: string, text: string): TopicChunk {
  const lines = text.split('\n');
  const title = (lines[0] ?? '').replace(/^###\s*/, '');
  const bullets = lines.filter((l) => l.startsWith('- '));
  const summary = lines.slice(1).find((l) => l && !l.startsWith('- ')) ?? '';
  return {
    slug,
    title,
    summary,
    headings: bullets.map((b) => b.slice(2).split(':', 1)[0] ?? ''),
    text,
  };
}

export function loadIndexText(): string {
  return readFileSync(join(packDir(), 'index.md'), 'utf8');
}

let chunks: TopicChunk[] | undefined;
export function loadTopics(): TopicChunk[] {
  if (chunks) return chunks;
  const dir = join(packDir(), 'topics');
  chunks = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseChunk(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')));
  return chunks;
}

// ------------------------------------------------------------------------------------------------ scoring

const STOP = new Set(
  (
    'the and for are was were you your yours with that this these those from have has had not but can could would should will ' +
    'what when where which who whom whose how why does did doing done any all some more most much many into onto over under about ' +
    'than then them they their there here also just very out off its it is in on of to a an or as at by be if so do we our us me my i ' +
    'guildwise hq tell give know want need like get got use used using work works working please thanks thank'
  ).split(' '),
);

/** A crude stem: plural and common verb endings off, so "workstations" and "workstation", "billing" and "bill" meet. */
export function stem(w: string): string {
  let s = w;
  for (const [suf, min] of [
    ['ing', 5],
    ['ies', 5],
    ['es', 5],
    ['ed', 5],
    ['s', 4],
  ] as const)
    if (s.length > min && s.endsWith(suf)) {
      s = suf === 'ies' ? `${s.slice(0, -3)}y` : s.slice(0, -suf.length);
      break;
    }
  return s;
}

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) ?? [])
    .map((w) => w.replace(/[.-]+$/, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);
}

interface Indexed {
  chunk: TopicChunk;
  title: Set<string>;
  summary: Set<string>;
  headings: Set<string>;
  body: Set<string>;
}

const indexed = new WeakMap<TopicChunk[], { docs: Indexed[]; df: Map<string, number> }>();
function indexOf(all: TopicChunk[]) {
  let hit = indexed.get(all);
  if (hit) return hit;
  const df = new Map<string, number>();
  const docs = all.map((chunk) => {
    const d: Indexed = {
      chunk,
      title: new Set(terms(chunk.title)),
      summary: new Set(terms(chunk.summary)),
      headings: new Set(chunk.headings.flatMap(terms)),
      body: new Set(terms(chunk.text)),
    };
    for (const t of d.body) df.set(t, (df.get(t) ?? 0) + 1);
    return d;
  });
  hit = { docs, df };
  indexed.set(all, hit);
  return hit;
}

/** The page a visitor is on suggests topics: pricing page, the blog, security and hosting. Slugs of help articles. */
export const PAGE_TOPICS: ReadonlyArray<{ prefix: string; slugs: readonly string[] }> = [
  { prefix: '/pricing', slugs: ['pricing', 'billing-and-plans', 'open-source-and-self-hosting'] },
  { prefix: '/blog', slugs: ['blog-and-digest'] },
  { prefix: '/security', slugs: ['workstations-and-installer', 'cloud-workstations', 'two-factor'] },
  { prefix: '/contact', slugs: ['writing-to-us'] },
];

export interface Selection {
  chunk: TopicChunk;
  score: number;
  /** The text attached (cut to fit the budget). */
  text: string;
}

/** Cuts a chunk to `tokens` at a line end (the title and summary always stay). */
export function fitChunk(text: string, tokens: number): string {
  if (approxTokens(text) <= tokens) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const t = approxTokens(`${l}\n`);
    if (used + t > tokens && out.length >= 2) break;
    out.push(l);
    used += t;
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * The help chunks for a conversation: the newest visitor question (full weight), the earlier ones (half), the page (a fixed boost).
 * At most `maxTopics` chunks and `budgetTokens` tokens in total, best first; nothing when no chunk reaches `minScore`.
 */
export function selectTopics(
  conversation: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
  opts: {
    page?: string | undefined;
    all?: TopicChunk[];
    limits?: Partial<{ budgetTokens: number; maxTopics: number; minScore: number }>;
  } = {},
): Selection[] {
  const limits = { ...TOPIC_LIMITS, ...(opts.limits ?? {}) };
  const all = opts.all ?? loadTopics();
  const users = conversation.filter((m) => m.role === 'user');
  const newest = users.at(-1)?.content ?? '';
  const earlier = users
    .slice(0, -1)
    .slice(-2)
    .map((m) => m.content)
    .join(' ');
  const weights = new Map<string, number>();
  for (const t of terms(newest)) weights.set(t, Math.max(weights.get(t) ?? 0, 1));
  for (const t of terms(earlier)) weights.set(t, Math.max(weights.get(t) ?? 0, 0.5));
  const { docs, df } = indexOf(all);
  const n = docs.length;
  const pageSlugs = new Set(
    PAGE_TOPICS.filter((p) => (opts.page ?? '').toLowerCase().startsWith(p.prefix)).flatMap((p) => p.slugs),
  );
  const scored: Selection[] = [];
  for (const d of docs) {
    let score = 0;
    for (const [t, w] of weights) {
      const idf = Math.log(1 + n / (1 + (df.get(t) ?? 0)));
      const field = d.title.has(t) ? 5 : d.headings.has(t) ? 3 : d.summary.has(t) ? 3 : d.body.has(t) ? 1 : 0;
      score += w * field * idf;
    }
    // the page only breaks a tie or lifts a topic that already matches a little
    if (pageSlugs.has(d.chunk.slug) && score > 0) score += 4;
    if (score >= limits.minScore) scored.push({ chunk: d.chunk, score, text: d.chunk.text });
  }
  scored.sort((a, b) => b.score - a.score || a.chunk.slug.localeCompare(b.chunk.slug));
  const out: Selection[] = [];
  let left = limits.budgetTokens;
  for (const s of scored) {
    if (out.length >= limits.maxTopics || left < 120) break;
    const text = fitChunk(s.text, left);
    out.push({ ...s, text });
    left -= approxTokens(text);
  }
  return out;
}

/** The block attached to the visitor's newest message, or undefined when nothing matched. */
export function relevantHelpBlock(selected: readonly Selection[]): string | undefined {
  if (!selected.length) return undefined;
  return `<relevant_help>\n${selected.map((s) => s.text.trimEnd()).join('\n\n')}\n</relevant_help>`;
}
