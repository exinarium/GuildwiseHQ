import type { PublicBlogPostFull } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { absolutizeHtml, cdata, rssFeed } from '../src/blog/render.ts';

const origin = 'https://aom.test';
const post = (over: Partial<PublicBlogPostFull> = {}): PublicBlogPostFull => ({
  slug: 'alpha',
  title: 'Alpha & <Omega>',
  summary: 'A "summary"',
  coverImage: { defaultKey: 'ai-agents', alt: 'Agents' },
  tags: ['ai-agents'],
  publishedAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  readingMinutes: 4,
  url: `${origin}/blog/alpha`,
  bodyMarkdown: 'Hello **world**\n\n[internal](/blog/beta)\n\n![pic](/blog/cover/x.png)',
  sources: [],
  author: 'Guildwise Research Desk',
  ...over,
});

describe('rssFeed', () => {
  it('adds content:encoded, absolute URLs, enclosure, media, dc:creator and namespaces', () => {
    const x = rssFeed(origin, [post()]);
    expect(x).toContain('xmlns:content="http://purl.org/rss/1.0/modules/content/"');
    expect(x).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(x).toContain('xmlns:media="http://search.yahoo.com/mrss/"');
    expect(x).toMatch(
      /<content:encoded><!\[CDATA\[[\s\S]*<strong>world<\/strong>[\s\S]*\]\]><\/content:encoded>/,
    );
    expect(x).toContain('href="https://aom.test/blog/beta"');
    expect(x).toContain('<img src="https://aom.test/blog/cover/ai-agents.png" alt="Agents"');
    expect(
      absolutizeHtml(origin, '<img src="/a.png"><a href="//x.y/z">q</a><a href="https://e.com/">r</a>'),
    ).toBe('<img src="https://aom.test/a.png"><a href="//x.y/z">q</a><a href="https://e.com/">r</a>');
    expect(x).toContain(
      '<enclosure url="https://aom.test/blog/cover/ai-agents.png" type="image/png" length="0"/>',
    );
    expect(x).toContain('<media:content url="https://aom.test/blog/cover/ai-agents.png" medium="image"/>');
    expect(x).toContain('<dc:creator>Guildwise Research Desk</dc:creator>');
    expect(x).toContain('<title>Alpha &amp; &lt;Omega&gt;</title>');
    expect(x).toContain('<atom:link href="https://aom.test/blog/rss.xml" rel="self"');
    expect(x).toContain('<lastBuildDate>');
  });

  it('omits enclosure and media without a cover', () => {
    const x = rssFeed(origin, [post({ coverImage: undefined as never })]);
    expect(x).not.toContain('<enclosure');
    expect(x).not.toContain('<media:content');
    expect(x).toContain('<content:encoded>');
  });

  it('splits "]]>" inside CDATA and the renderer already escapes it in a body', () => {
    expect(cdata('a ]]> b')).toBe('<![CDATA[a ]]]]><![CDATA[> b]]>');
    const x = rssFeed(origin, [post({ bodyMarkdown: 'a ]]> b' })]);
    expect(x).not.toMatch(/\]\]>[^<]/);
  });
});
