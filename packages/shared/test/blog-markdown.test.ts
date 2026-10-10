import { describe, expect, it } from 'vitest';
import {
  BlogContentSchema,
  markdownLinks,
  parseMarkdown,
  readingMinutes,
  renderMarkdownHtml,
  safeHref,
  wordCount,
} from '../src/blog/index.ts';

describe('blog markdown (restricted, no raw HTML)', () => {
  it('renders the allowed blocks', () => {
    const html = renderMarkdownHtml(
      '## Title\n\nA *soft* and **hard** `code` [link](https://example.com/x).\n\n- one\n- two\n\n1. a\n2. b\n\n> quote\n\n```js\nlet a = 1 < 2;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n#### Deep',
    );
    expect(html).toContain('<h2 id="title">Title</h2>');
    expect(html).toContain('<em>soft</em>');
    expect(html).toContain('<strong>hard</strong>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>a</li><li>b</li></ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('let a = 1 &lt; 2;');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<h4 id="deep">Deep</h4>');
    expect(html).toContain('rel="nofollow noopener noreferrer" target="_blank"');
  });

  it('survives an XSS corpus: no tag, handler or script URL ever reaches the output', () => {
    const corpus = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](//evil.example/x)',
      '[x](vbscript:msgbox(1))',
      '<a href="https://x" onclick="a()">y</a>',
      '"><svg/onload=alert(1)>',
      '**<b>bold</b>**',
      '`</code><script>`',
      '[x](https://example.com/"onmouseover="alert(1))',
    ];
    for (const src of corpus) {
      const html = renderMarkdownHtml(src);
      expect(html, src).not.toMatch(/<(script|img|svg|iframe|b)\b/i);
      expect(html, src).not.toMatch(/href="(javascript|data|vbscript|\/\/)/i);
      expect(html, src).not.toMatch(/<[^>]*\son[a-z]+=/i);
    }
  });

  it('accepts only http(s) and same-site links', () => {
    expect(safeHref('https://a.example/p?q=1')).toBe('https://a.example/p?q=1');
    expect(safeHref('/blog/x')).toBe('/blog/x');
    for (const bad of ['javascript:alert(1)', '//a.example', 'ftp://a.example', 'data:x', 'mailto:a@b.c', ''])
      expect(safeHref(bad), bad).toBeNull();
    expect(markdownLinks('[a](https://a.example) [b](javascript:x) [c](/local)')).toEqual([
      'https://a.example',
      '/local',
    ]);
  });

  it('numbers duplicate headings and counts words', () => {
    const blocks = parseMarkdown('## Same\n\n## Same');
    expect(blocks.map((b) => (b.t === 'h' ? b.id : ''))).toEqual(['same', 'same-2']);
    expect(wordCount('one two **three**')).toBe(3);
    expect(readingMinutes(1)).toBe(1);
    expect(readingMinutes(2200)).toBe(10);
  });
});

describe('blog content schema', () => {
  const ok = {
    slug: 'my-first-post',
    title: 'A title that is long enough',
    summary: 's'.repeat(90),
    bodyMarkdown: 'b'.repeat(4000),
    coverImage: { defaultKey: 'ai-agents', alt: 'An abstract picture' },
    tags: ['ai-agents'],
  };
  it('accepts a valid post and rejects the broken ones', () => {
    expect(BlogContentSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, slug: 'Bad Slug' },
      { ...ok, slug: 'a--b' },
      { ...ok, title: 'short' },
      { ...ok, tags: [] },
      { ...ok, tags: ['unknown'] },
      { ...ok, tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...ok, sources: [{ title: 'x', url: 'javascript:alert(1)' }] },
      { ...ok, coverImage: { defaultKey: 'nope', alt: 'An abstract picture' } },
      { ...ok, bodyMarkdown: 'b'.repeat(100) },
    ])
      expect(BlogContentSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });
});
