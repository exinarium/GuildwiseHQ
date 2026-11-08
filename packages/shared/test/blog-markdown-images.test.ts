import { describe, expect, it } from 'vitest';
import {
  ManualBlogContentSchema,
  markdownLinks,
  mdInlineText,
  parseMdInline,
  renderMarkdownHtml,
  slugifyTitle,
  wordCount,
} from '../src/blog/index.ts';

const ID = '0b6f0d7e-1c2a-4d3b-8e4f-5a6b7c8d9e0f';

describe('blog markdown images (our own uploads only)', () => {
  it('renders an uploaded blog image as an img', () => {
    expect(renderMarkdownHtml(`![A "cat"](/blog/media/${ID}.png)`)).toBe(
      `<p><img src="/blog/media/${ID}.png" alt="A &quot;cat&quot;" loading="lazy"></p>`,
    );
    expect(parseMdInline(`x ![](/blog/media/${ID}.webp) y`)).toEqual([
      { t: 'text', v: 'x ' },
      { t: 'img', src: `/blog/media/${ID}.webp`, alt: '' },
      { t: 'text', v: ' y' },
    ]);
  });

  it('renders every other image syntax exactly as before (a "!" and a link)', () => {
    expect(renderMarkdownHtml('![x](https://example.com/a.png)')).toBe(
      '<p>!<a href="https://example.com/a.png" rel="nofollow noopener noreferrer" target="_blank">x</a></p>',
    );
    expect(renderMarkdownHtml('![x](/blog/media/../x.png)')).toBe(
      '<p>!<a href="/blog/media/../x.png">x</a></p>',
    );
    expect(renderMarkdownHtml(`![x](/blog/media/${ID}.svg)`)).not.toContain('<img');
    expect(renderMarkdownHtml(`![x](//evil.example/blog/media/${ID}.png)`)).not.toContain('<img');
    expect(renderMarkdownHtml('![x](data:image/png;base64,AAAA)')).not.toContain('<img');
  });

  it('adds no text to the word count and no link', () => {
    expect(wordCount(`one two ![alt words](/blog/media/${ID}.png) three`)).toBe(3);
    expect(mdInlineText(parseMdInline(`![a](/blog/media/${ID}.png)`))).toBe('');
    expect(markdownLinks(`![a](/blog/media/${ID}.png)`)).toEqual([]);
  });
});

describe('manual article helpers', () => {
  it('slugifyTitle makes URL-safe slugs of 3 to 80 characters', () => {
    expect(slugifyTitle('Café déjà vu: A Title!!')).toBe('cafe-deja-vu-a-title');
    expect(slugifyTitle('  ---  ')).toBe('post');
    expect(slugifyTitle('Hi')).toBe('post-hi');
    const long = slugifyTitle('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('ManualBlogContentSchema accepts no tags and a short body', () => {
    const base = {
      slug: 'my-post',
      title: 'My post',
      summary: 'A summary of at least twenty characters.',
      bodyMarkdown: 'Short.',
      coverImage: { defaultKey: 'ai-agents', alt: 'Cover of the post' },
      tags: [],
    };
    expect(ManualBlogContentSchema.safeParse(base).success).toBe(true);
    expect(ManualBlogContentSchema.safeParse({ ...base, tags: ['nope'] }).success).toBe(false);
  });
});
