import { describe, expect, it } from 'vitest';
import { normalizeGuidePath, ReleaseDocsPrepGuideInputSchema } from '../src/release/user-guide.ts';

describe('normalizeGuidePath', () => {
  it('treats empty and the default as not set', () => {
    for (const v of [undefined, null, '', '   ', 'docs/USER-GUIDE.md', './docs//USER-GUIDE.md'])
      expect(normalizeGuidePath(v)).toEqual({ ok: true, path: null });
  });
  it('accepts and normalises a Markdown path', () => {
    expect(normalizeGuidePath('docs/guide/MANUAL.md')).toEqual({ ok: true, path: 'docs/guide/MANUAL.md' });
    expect(normalizeGuidePath('./docs//guide/MANUAL.md')).toEqual({ ok: true, path: 'docs/guide/MANUAL.md' });
    expect(normalizeGuidePath('docs\\guide\\MANUAL.md')).toEqual({ ok: true, path: 'docs/guide/MANUAL.md' });
    expect(normalizeGuidePath(' ..foo/x.md ')).toEqual({ ok: true, path: '..foo/x.md' });
  });
  it('rejects paths that leave the repository or are not Markdown', () => {
    for (const v of [
      '/etc/x.md',
      'C:\\x.md',
      'c:x.md',
      '\\\\host\\x.md',
      '../x.md',
      'docs/../x.md',
      'docs\\..\\x.md',
      'docs/x.txt',
      'docs/.md',
      `${'a'.repeat(300)}.md`,
      'docs/a\u0007.md',
    ])
      expect(normalizeGuidePath(v).ok, v).toBe(false);
  });
  it('names the problem', () => {
    expect(normalizeGuidePath('../x.md')).toEqual({ ok: false, reason: "must not contain '..'" });
  });
  it('is not configured by default in the step input', () => {
    const p = ReleaseDocsPrepGuideInputSchema.parse({});
    expect(p.guidePathConfigured).toBe(false);
    expect(p.guidePath).toBe('docs/USER-GUIDE.md');
  });
});
