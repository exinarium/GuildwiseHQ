import { posix } from 'node:path';
import {
  type Citation,
  defaultNotePath,
  isSafeVaultPath,
  normalizeUrl,
  noteExcerpt,
  type PublicationData,
  type PublishRequest,
  parseNoteFrontMatter,
  renderNote,
  splitNote,
} from '@aom/shared';
import type { FetchedUrls } from '../feeds/validation.ts';

export type PreparedPublication =
  | { ok: true; path: string; content: string; publication: PublicationData }
  | { ok: false; error: string };

/**
 * Prepares `aom publish` (docs/SPEC.md "Research and feeds", ARCHITECTURE.md section 16.4): the checker may only publish
 * a note that lists its citations, and only sources it opened in this shift. The note is rewritten with normalized
 * front matter (title, card, sub-category, citations) and goes to `projects/<name>/<sub-category>/` of the vault.
 * Pure: the caller writes the file into the vault clone and reports the returned publication to the server.
 */
export function preparePublication(i: {
  request: PublishRequest;
  /** `projects/<name>` of the card's vault. */
  folder: string;
  card: { ref: string; subCategory?: string | undefined };
  fetched: FetchedUrls;
  /** Transcripts saved in the vault in this shift (`aom transcript`), by normalized URL: linked from the note. */
  transcripts?: ReadonlyMap<string, { path: string; title: string }>;
  /** Start of the shift: dates are derived from it so a retried publish writes identical content. */
  at: Date;
}): PreparedPublication {
  const { request } = i;
  const fm = parseNoteFrontMatter(request.content);
  const { body } = splitNote(request.content);

  const title = request.title?.trim() || fm?.title?.trim() || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || '';
  if (!title)
    return { ok: false, error: 'the note needs a title (--title, front matter `title:` or a `# heading`)' };

  // Citations of the note plus the ones listed next to it, by normalized URL.
  const stamp = i.at.toISOString();
  const byUrl = new Map<string, Citation>();
  for (const c of [...(fm?.citations ?? []), ...request.citations]) {
    const key = normalizeUrl(c.url);
    if (!/^https?:\/\//.test(c.url) || byUrl.has(key)) continue;
    const transcriptPath = i.transcripts?.get(key)?.path;
    byUrl.set(key, {
      url: c.url,
      ...(transcriptPath ? { transcriptPath } : {}),
      title: ('title' in c && c.title ? c.title : c.url).slice(0, 300),
      accessedAt: ('accessedAt' in c && c.accessedAt ? c.accessedAt : stamp) as string,
    });
  }
  const citations = [...byUrl.values()];
  if (citations.length === 0)
    return {
      ok: false,
      error:
        'a published note needs citations: list every source in the note front matter (citations:) or with --citations-file. No citations, no publication.',
    };
  const unopened = citations.filter((c) => !i.fetched.has(c.url));
  if (unopened.length > 0)
    return {
      ok: false,
      error: `these sources are not pages you opened in this shift: ${unopened.map((c) => c.url).join(', ')}. Open each cited page and verify the claims against it, or remove the citation.`,
    };

  const path = request.path?.trim() || defaultNotePath(i.folder, i.card.subCategory, title);
  if (!isSafeVaultPath(path) || !path.endsWith('.md'))
    return { ok: false, error: `unsafe note path: ${path} (a vault-relative markdown path)` };
  if (!path.startsWith(`${i.folder}/`))
    return {
      ok: false,
      error: `the note must go under ${i.folder}/ (the project's vault folder), not ${path}`,
    };

  // Sources with a transcript are linked from the note (relative to the note, so the link works in the vault).
  const withTranscript = citations.filter((c) => c.transcriptPath);
  const linked = withTranscript.length
    ? `${body.trim()}\n\n## Transcripts\n\n${withTranscript
        .map(
          (c) =>
            `- [${c.title.replace(/[[\]]/g, '')}](${posix.relative(posix.dirname(path), c.transcriptPath as string)})`,
        )
        .join('\n')}\n`
    : body;
  const content = renderNote({
    title,
    body: linked,
    cardRef: i.card.ref,
    ...(i.card.subCategory ? { subCategory: i.card.subCategory } : {}),
    published: stamp.slice(0, 10),
    citations,
  });
  return {
    ok: true,
    path,
    content,
    publication: { vaultPath: path, title, citations, excerpt: noteExcerpt(content) },
  };
}
