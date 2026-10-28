import { describe, expect, it } from 'vitest';
import {
  BlogContentSchema,
  captionLength,
  composeCaption,
  escapeLittleText,
  graphemeCount,
  SOCIAL_LIMITS,
  SocialCaptionsSchema,
  X_LINK_SAMPLE,
} from '../src/index.ts';

const LINK =
  'https://guildwise.example/blog/some-post?utm_source=x&utm_medium=social&utm_campaign=a-very-long-one';

describe('composeCaption: X', () => {
  it('keeps the hashtags and cuts the text, 280 with the link counted as 23', () => {
    const c = composeCaption('x', 'word '.repeat(100), ['AI', 'Agents'], LINK).text;
    expect(c.endsWith(` #AI #Agents ${LINK}`)).toBe(true);
    expect(captionLength('x', c, LINK)).toBeLessThanOrEqual(280);
    expect(c).toContain('…');
  });
  it('counts emoji and CJK as graphemes', () => {
    const text = '👨‍👩‍👧 日本語'.repeat(60);
    const c = composeCaption('x', text, ['AI'], LINK).text;
    expect(captionLength('x', c, LINK)).toBeLessThanOrEqual(280);
    expect(c).toContain(' #AI ');
  });
  it('leaves a short caption alone and does not repeat a tag the text already has', () => {
    expect(composeCaption('x', 'Short #AI', ['ai', 'Agents'], LINK).text).toBe(`Short #AI #Agents ${LINK}`);
  });
  it('drops tags from the end only when the text would have almost no room', () => {
    const tags = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(50));
    const c = composeCaption('x', 'x'.repeat(300), tags, '').text;
    expect(c).toContain(`#${'d'.repeat(50)}`);
    expect(c).not.toContain('e'.repeat(50));
    expect(graphemeCount(c)).toBeLessThanOrEqual(SOCIAL_LIMITS.x.total);
  });
  it('previews with a 23 character sample link', () => {
    expect(graphemeCount(X_LINK_SAMPLE)).toBe(23);
  });
});

describe('composeCaption: Bluesky', () => {
  it('has no link in the text and tag facets on UTF-8 byte offsets', () => {
    const r = composeCaption('bluesky', 'Café 日本 👨‍👩‍👧', ['Agents', 'LLMOps'], LINK);
    expect(r.text).toBe('Café 日本 👨‍👩‍👧 #Agents #LLMOps');
    expect(r.text).not.toContain('http');
    const bytes = new TextEncoder().encode(r.text);
    const slices = r.facets.map((f) =>
      new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd)),
    );
    expect(slices).toEqual(['#Agents', '#LLMOps']);
    expect(r.facets.map((f) => f.features[0])).toEqual([
      { $type: 'app.bsky.richtext.facet#tag', tag: 'Agents' },
      { $type: 'app.bsky.richtext.facet#tag', tag: 'LLMOps' },
    ]);
  });
  it('stays within 300 graphemes with the tags', () => {
    const r = composeCaption('bluesky', 'é👨‍👩‍👧 '.repeat(200), ['AI', 'Agents']);
    expect(graphemeCount(r.text)).toBeLessThanOrEqual(300);
    expect(r.text.endsWith(' #AI #Agents')).toBe(true);
  });
  it('is the plain caption when there are no tags (older posts)', () => {
    const r = composeCaption('bluesky', 'Old caption', []);
    expect(r).toEqual({ text: 'Old caption', facets: [] });
  });
});

describe('composeCaption: LinkedIn and Facebook', () => {
  it('escapes the reserved characters of the little text format', () => {
    expect(escapeLittleText('a|b {c} @d [e] (f) <g> *h* _i_ ~j~ k\\l')).toBe(
      'a\\|b \\{c\\} \\@d \\[e\\] \\(f\\) \\<g\\> \\*h\\* \\_i\\_ \\~j\\~ k\\\\l',
    );
  });
  it('escapes a # that is not a hashtag but keeps one that is', () => {
    expect(escapeLittleText('No. # 1 and #AI')).toBe('No. \\# 1 and #AI');
  });
  it('puts the hashtags on their own line', () => {
    expect(composeCaption('linkedin', 'Big (news)', ['AI', 'LLM_Ops', 'Agents']).text).toBe(
      'Big \\(news\\)\n\n#AI #LLMOps #Agents',
    );
    expect(composeCaption('facebook', 'Big (news)', ['AI']).text).toBe('Big (news)\n\n#AI');
  });
  it('is unchanged for an older caption without a hashtag array', () => {
    expect(composeCaption('facebook', 'Old caption #AI', []).text).toBe('Old caption #AI');
    expect(composeCaption('linkedin', 'Old caption #AI', []).text).toBe('Old caption #AI');
  });
});

describe('LinkedIn legacy captions and tag normalisation', () => {
  it('keeps an inline #tag_x one hashtag (underscore dropped, not escaped)', () => {
    expect(escapeLittleText('Launch #foo_bar now')).toBe('Launch #foobar now');
    expect(composeCaption('linkedin', 'Launch #foo_bar now', []).text).toBe('Launch #foobar now');
  });
  it('escapes a URL with _ ~ ( in an older caption and still keeps the inline hashtag', () => {
    const t = composeCaption('linkedin', 'Read https://x.test/a_b~c_(d) #tag_x', []).text;
    expect(t).toBe('Read https://x.test/a\\_b\\~c\\_\\(d\\) #tagx');
  });
  it('does not add foo_bar and foobar as two LinkedIn tags, nor a tag the text already has once stripped', () => {
    expect(composeCaption('linkedin', 'Hi', ['foo_bar', 'foobar']).text).toBe('Hi\n\n#foobar');
    expect(composeCaption('linkedin', 'Hi #foo_bar', ['foobar']).text).toBe('Hi #foobar');
  });
});

describe('SocialCaptionsSchema', () => {
  it('accepts hashtags with or without #, stores them without', () => {
    const r = SocialCaptionsSchema.parse({ hashtags: { x: ['#AI', 'Agents'] } });
    expect(r.hashtags?.x).toEqual(['AI', 'Agents']);
  });
  it('rejects bad tags, too many tags and duplicates', () => {
    expect(SocialCaptionsSchema.safeParse({ hashtags: { x: ['has space'] } }).success).toBe(false);
    expect(SocialCaptionsSchema.safeParse({ hashtags: { x: ['1abc'] } }).success).toBe(false);
    expect(SocialCaptionsSchema.safeParse({ hashtags: { x: ['a1', 'b2', 'c3'] } }).success).toBe(false);
    expect(SocialCaptionsSchema.safeParse({ hashtags: { facebook: ['aa', 'AA'] } }).success).toBe(false);
    expect(
      SocialCaptionsSchema.safeParse({ hashtags: { linkedin: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'] } })
        .success,
    ).toBe(false);
  });
  it('accepts non-Latin tags', () => {
    expect(SocialCaptionsSchema.safeParse({ hashtags: { x: ['日本語'] } }).success).toBe(true);
  });
  it('checks the X caption together with its tags against 256', () => {
    const text = 'a'.repeat(253);
    expect(SocialCaptionsSchema.safeParse({ xText: text }).success).toBe(true);
    expect(SocialCaptionsSchema.safeParse({ xText: text, hashtags: { x: ['AI'] } }).success).toBe(false);
    expect(SocialCaptionsSchema.safeParse({ xText: 'a'.repeat(257) }).success).toBe(false);
    expect(SocialCaptionsSchema.safeParse({ blueskyText: 'a'.repeat(300) }).success).toBe(true);
    expect(
      SocialCaptionsSchema.safeParse({ blueskyText: 'a'.repeat(299), hashtags: { bluesky: ['AI'] } }).success,
    ).toBe(false);
  });
});

describe('older posts', () => {
  const base = {
    slug: 'old-post',
    title: 'An older post with a title',
    summary: 'S'.repeat(90),
    bodyMarkdown: 'B'.repeat(1200),
    coverImage: { defaultKey: 'ai-agents', alt: 'Cover alt' },
    tags: ['ai-agents'],
  };
  it('parses with inline hashtags and no hashtag array', () => {
    const r = BlogContentSchema.parse({
      ...base,
      social: {
        xText: 'New on the blog #AI',
        blueskyText: 'x'.repeat(270),
        facebookText: 'f',
        linkedinText: 'l',
      },
    });
    expect(r.social.hashtags).toBeUndefined();
  });
  it('parses with no social at all', () => {
    expect(BlogContentSchema.parse(base).social).toEqual({});
  });
});
