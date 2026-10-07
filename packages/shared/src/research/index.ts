import { z } from 'zod';
import { slugify } from '../ids.ts';
import { HttpUrlSchema } from '../safe.ts';

/**
 * Research contract (M6, docs/SPEC.md "Research and feeds"): what the checker publishes, how a note carries its
 * citations (front matter), and what the site records. Pure and deterministic; used by the server, the runner and the
 * mock agent.
 */

/** A source a note relies on. `accessedAt` is when the checker opened the page. */
export const CitationSchema = z.object({
  url: HttpUrlSchema.max(2000),
  title: z.string().min(1).max(300),
  accessedAt: z.iso.datetime(),
  /** Vault path of the transcript of a video or podcast source (`aom transcript`), when one was fetched. */
  transcriptPath: z.string().max(400).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/** What the checker hands the runner with `aom publish` (the runner writes the note, then reports the publication). */
export const PublishRequestSchema = z.object({
  /** Vault-relative path of the note; defaults to `projects/<name>/<sub-category>/<title-slug>.md`. */
  path: z.string().min(1).max(300).optional(),
  /** The whole note: markdown with front matter that lists the citations. */
  content: z.string().min(1).max(200_000),
  title: z.string().min(1).max(300).optional(),
  /** Citations in addition to (or instead of) the ones in the note's front matter. */
  citations: z.array(CitationSchema.partial({ accessedAt: true })).default([]),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/** What the server records (`ResearchPublished`): the note itself lives in the vault. */
export const PublicationDataSchema = z.object({
  vaultPath: z.string().min(1).max(400),
  title: z.string().min(1).max(300),
  citations: z.array(CitationSchema).min(1, 'a published note needs at least one citation'),
  /** First lines of the note body, for the card page. */
  excerpt: z.string().max(2000).default(''),
});
export type PublicationData = z.infer<typeof PublicationDataSchema>;

/** `data` of the checker's `published` outcome: the request on the way to the runner, the record on the way to the server. */
export const PublicationOutcomeSchema = z.union([PublicationDataSchema, PublishRequestSchema]);

export const isPublishRequest = (data: Record<string, unknown>): boolean => typeof data.content === 'string';

// ---------------------------------------------------------------- note front matter

export interface NoteFrontMatter {
  title?: string;
  citations: Array<{ url: string; title?: string; accessedAt?: string; transcriptPath?: string }>;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Splits a note into its front matter block (raw) and the body. */
export function splitNote(md: string): { front: string | null; body: string } {
  const m = FRONT.exec(md);
  return m ? { front: m[1] as string, body: md.slice(m[0].length) } : { front: null, body: md };
}

const unquote = (s: string) => {
  const t = s.trim();
  const quoted = /^"(.*)"$/s.exec(t);
  if (quoted) return (quoted[1] as string).replace(/\\(["\\])/g, '$1');
  return t.replace(/^'(.*)'$/s, '$1');
};

/**
 * Reads the `title` and the `citations` list of a note's front matter. Understands the block list this module writes
 * (`- url: ...` with optional `title:` and `accessed:` lines), a plain list of URLs, and an inline `[a, b]` list.
 * Anything else yields no citations, which is exactly what the publish guard rejects.
 */
export function parseNoteFrontMatter(md: string): NoteFrontMatter | null {
  const { front } = splitNote(md);
  if (front === null) return null;
  const out: NoteFrontMatter = { citations: [] };
  const lines = front.split(/\r?\n/);
  let inCitations = false;
  let current: NoteFrontMatter['citations'][number] | null = null;
  const flush = () => {
    if (current?.url) out.citations.push(current);
    current = null;
  };
  for (const line of lines) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top && !line.startsWith(' ') && !line.startsWith('\t')) {
      flush();
      inCitations = top[1] === 'citations';
      if (top[1] === 'title') out.title = unquote(top[2] ?? '');
      if (inCitations && (top[2] ?? '').trim().startsWith('[')) {
        for (const u of (top[2] as string).replace(/^\s*\[|\]\s*$/g, '').split(',')) {
          const url = unquote(u);
          if (url) out.citations.push({ url });
        }
        inCitations = false;
      }
      continue;
    }
    if (!inCitations) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      flush();
      const rest = (item[1] ?? '').trim();
      const kv = /^url:\s*(.+)$/.exec(rest);
      if (kv) current = { url: unquote(kv[1] as string) };
      else if (/^https?:\/\//.test(unquote(rest))) current = { url: unquote(rest) };
      continue;
    }
    const field = /^\s+(title|accessed|accessedAt|transcript):\s*(.+)$/.exec(line);
    if (field && current) {
      if (field[1] === 'title') current.title = unquote(field[2] as string);
      else if (field[1] === 'transcript') current.transcriptPath = unquote(field[2] as string);
      else current.accessedAt = unquote(field[2] as string);
    }
  }
  flush();
  return out;
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;

/** A note with the front matter this module reads back: title, card, sub-category, publication date and citations. */
export function renderNote(n: {
  title: string;
  body: string;
  cardRef?: string;
  subCategory?: string;
  published: string;
  citations: Citation[];
}): string {
  const lines = ['---', `title: ${q(n.title)}`];
  if (n.cardRef) lines.push(`card: ${n.cardRef}`);
  if (n.subCategory) lines.push(`subCategory: ${q(n.subCategory)}`);
  lines.push(`published: ${n.published}`, 'citations:');
  for (const c of n.citations) {
    lines.push(`  - url: ${c.url}`, `    title: ${q(c.title)}`, `    accessed: ${c.accessedAt}`);
    if (c.transcriptPath) lines.push(`    transcript: ${c.transcriptPath}`);
  }
  lines.push('---', '', n.body.trim(), '');
  return lines.join('\n');
}

/** `projects/<folder>/<sub-category>/<title-slug>.md` (the default place of a published note). */
export function defaultNotePath(folder: string, subCategory: string | undefined, title: string): string {
  const sub = slugify(subCategory ?? '', 40) || 'general';
  return `${folder}/${sub}/${slugify(title, 60) || 'note'}.md`;
}

/** First lines of a note body (no front matter, no leading title heading), for the excerpt on the card page. */
export function noteExcerpt(md: string, max = 600): string {
  const { body } = splitNote(md);
  // the card page shows the title itself: skip a leading `# title` line
  const text = body
    .replace(/\r/g, '')
    .trim()
    .replace(/^#\s+.*\n+/, '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------- the research index in PROJECT.md

/** The managed block of `PROJECT.md` a conversion writes: every later shift reads the project's research through it. */
export const RESEARCH_INDEX_SECTION_ID = 'research-index';
export const PROJECT_FILE = 'PROJECT.md';
export const PROJECT_FILE_HEADER = '# Project\n';

export interface ResearchIndexNote {
  title: string;
  /** Vault-relative path of the note. */
  vaultPath: string;
  cardRef: string;
  citations: number;
  publishedAt: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The body of the `research-index` section of `PROJECT.md`: one line per published note (oldest first), linking the note
 * by its path relative to the project folder when it lives there. Pure; the same input yields the same text, so a
 * repeated write is a no-op.
 */
export function renderResearchIndex(
  notes: readonly ResearchIndexNote[],
  opts: { folder: string; startedAs?: string; convertedTo?: string } = { folder: '' },
): string {
  const lines = ['## Research', ''];
  lines.push(
    opts.convertedTo
      ? `This project started as research and was converted to the ${opts.convertedTo} workflow. The notes below were published before the conversion; read them before you start.`
      : 'The notes below were published by this project. Read them before you start.',
    '',
  );
  if (notes.length === 0) lines.push('_No notes were published yet._', '');
  const prefix = opts.folder ? `${opts.folder}/` : '';
  for (const n of [...notes].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    const rel = prefix && n.vaultPath.startsWith(prefix) ? n.vaultPath.slice(prefix.length) : n.vaultPath;
    lines.push(
      `- [${oneLine(n.title).replace(/[[\]]/g, '')}](${rel.replace(/ /g, '%20')}) (${n.cardRef}, ${n.citations} citation${n.citations === 1 ? '' : 's'}, ${n.publishedAt.slice(0, 10)})`,
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
