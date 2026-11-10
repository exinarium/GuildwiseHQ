import type { Release } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { listPage, releasePage, releasesIndexPage } from '../src/blog/render.ts';

const empty = { added: [], changed: [], fixed: [] } as unknown as Release['sections'];
const mk = (over: Partial<Release> & { version: string }): Release =>
  ({ date: '2026-01-02', intro: '', sections: empty, whatsNew: [], ...over }) as Release;
const wn = (title: string) => [{ id: 'a', title, date: '2026-01-02', body: '' }];
const sec = (o: Record<string, string[]>) => ({ ...empty, ...o }) as Release['sections'];

const LONG = `${'word '.repeat(120)}end`;
const LONGV = '123456789.987654321.123456789012';
const origin = 'https://aom.test';
const page = (rs: Release[]) => releasesIndexPage(origin, rs);
const cards = (html: string) =>
  html
    .split('<article class="rel-card">')
    .slice(1)
    .map((c) => c.slice(0, c.indexOf('</article>')));

describe('releases index cards', () => {
  const rs = [
    mk({ version: '1.2.0', whatsNew: wn('Normal title') }),
    mk({ version: '1.1.0', whatsNew: wn(LONG) }),
    mk({ version: '1.0.0' }),
    mk({ version: LONGV, whatsNew: wn('x') }),
  ];
  const html = page(rs);

  it('every card has the same skeleton, in order', () => {
    const cs = cards(html);
    expect(cs).toHaveLength(4);
    for (const [i, c] of cs.entries()) {
      const v = rs[i]!.version;
      expect(c).toMatch(
        new RegExp(
          `^<h2 class="rel-version">[^<]+</h2>\\s*<p class="rel-date"><time datetime="[^"]+">[^<]+</time></p>\\s*<p class="rel-summary[^"]*">[^<]*</p>\\s*<p class="rel-more"><a href="/releases/${v.replace(/\./g, '\\.')}">`,
        ),
      );
      expect(c.match(/<a /g)).toHaveLength(1);
    }
  });

  it('link accessible name includes the version', () => {
    for (const r of rs) {
      expect(html).toContain(
        `href="/releases/${r.version}">Read more<span class="vh"> about Guildwise HQ ${r.version}</span></a>`,
      );
    }
  });

  it('cuts a long summary at 300 characters on a word boundary and clamps with CSS', () => {
    const m = cards(html)[1]!.match(/<p class="rel-summary">([^<]*)<\/p>/)!;
    expect(m[1]!.length).toBeLessThanOrEqual(300);
    expect(m[1]!.endsWith('...')).toBe(true);
    expect(html).toContain('-webkit-line-clamp:3');
    expect(html).toContain('line-clamp:3;');
  });

  it('shows a placeholder for an empty summary', () => {
    expect(cards(html)[2]).toContain(
      '<p class="rel-summary is-empty">See the release notes for the full list of changes.</p>',
    );
  });
});

describe('summary source and text', () => {
  const sum = (r: Release) => cards(page([r]))[0]!.match(/<p class="rel-summary[^"]*">([^<]*)<\/p>/)![1];
  it('falls back in order', () => {
    expect(
      sum(mk({ version: '1.0.0', whatsNew: wn('T'), sections: sec({ added: ['A'] }), intro: 'I' })),
    ).toBe('T');
    expect(sum(mk({ version: '1.0.0', sections: sec({ added: ['A'], changed: ['C'] }), intro: 'I' }))).toBe(
      'A',
    );
    expect(sum(mk({ version: '1.0.0', sections: sec({ changed: ['C'] }), intro: 'I' }))).toBe('I');
    expect(sum(mk({ version: '1.0.0', sections: sec({ changed: ['C'], fixed: ['F'] }) }))).toBe('C');
    expect(sum(mk({ version: '1.0.0', sections: sec({ fixed: ['F'] }) }))).toBe('F');
  });
  it('strips inline markdown', () => {
    expect(sum(mk({ version: '1.0.0', whatsNew: wn('See [blog page](https://x) **b** `c`') }))).toBe(
      'See blog page b c',
    );
  });
  it('escapes release text', () => {
    const out = page([mk({ version: '1.0.0', whatsNew: wn('A <b>x</b> & "q"') })]);
    expect(out).toContain('A &lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;');
    expect(out).not.toContain('<b>x</b>');
  });
});

describe('styles', () => {
  it('adds no new colours', () => {
    const style = page([mk({ version: '1.0.0' })]).match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const allowed = new Set(
      '#f5f6f8 #fff #eef0f4 #e2e5ea #12161f #4b5365 #3446d9 #e8ebfd #d4f24a #0d1220 #0b0e14 #131822 #1a2030 #262d3b #eceff5 #a9b2c3 #9daeff #1d2447'.split(
        ' ',
      ),
    );
    for (const h of style.match(/#[0-9a-f]{3,6}\b/gi) ?? []) expect(allowed.has(h.toLowerCase())).toBe(true);
  });
  it('other pages do not use the release card markup', () => {
    const r = releasePage(origin, mk({ version: '1.0.0' }));
    expect(r).not.toContain('class="rel-card"');
    expect(r).not.toContain('class="releases-index"');
    const l = listPage(origin, { posts: [], total: 0, page: 1, perPage: 12 });
    expect(l).not.toContain('class="rel-card"');
  });
});
