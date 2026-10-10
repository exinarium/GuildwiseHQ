import { parse } from 'yaml';
import { type BlogContent, BlogContentSchema } from './schema.ts';

/**
 * A blog article stored as a Markdown file with YAML frontmatter (the launch set, apps/server/src/blog/launch/*.md).
 * Frontmatter: title, slug, summary, tags, cover {defaultKey, alt}, sources [{title, url}], seo, social
 * {facebookText, linkedinText}. The body is the post's restricted Markdown. The AI disclosure and the author are fixed.
 */
export function parseBlogArticle(
  file: string,
  disclosure: { model?: string; agentName?: string } = {},
): BlogContent {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(file);
  if (!m) throw new Error('blog article: frontmatter missing');
  const fm = parse(m[1] as string) as Record<string, unknown> | null;
  if (!fm || typeof fm !== 'object') throw new Error('blog article: frontmatter is not a mapping');
  return BlogContentSchema.parse({
    slug: fm.slug,
    title: fm.title,
    summary: fm.summary,
    bodyMarkdown: (m[2] as string).trim(),
    coverImage: fm.cover,
    tags: fm.tags,
    sources: fm.sources ?? [],
    seo: fm.seo ?? {},
    social: fm.social ?? {},
    aiDisclosure: disclosure,
  });
}
