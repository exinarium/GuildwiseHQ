import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyGuideEdits,
  checkGuideUpdate,
  GUIDE_STEP,
  guideOutputSources,
  guideSlug,
  locateSections,
  missingReleaseDocsPrepRequirement,
  parseGuide,
  ReleaseDocsPrepPayloadSchema,
  releaseDocsPrepStep,
  renderGuideToc,
  scrubGuideText,
} from '../src/index.ts';

const SAMPLE = [
  '# Guide',
  '',
  'Intro.',
  '',
  '<!-- toc -->',
  '**Contents**',
  '',
  '- [4. Delivery](#4-delivery)',
  '  - [4.24 Builds](#424-builds)',
  '  - [4.24a Build logs](#424a-build-logs)',
  '  - [4.28 Releases](#428-releases)',
  '  - [4.29 Metrics](#429-metrics)',
  '  - [4.30 Costs](#430-costs)',
  '- [Appendix A. Where to find things](#appendix-a-where-to-find-things)',
  '  - [The section map](#the-section-map)',
  '',
  '<!-- /toc -->',
  '',
  '## 4. Delivery',
  '',
  '### 4.24 Builds',
  '',
  'Builds run on your computer.',
  '',
  '### 4.24a Build logs',
  '',
  'The log of a build.',
  '',
  '### 4.28 Releases',
  '',
  'The **Releases** page lists each version. Press **Approve release** to ship it (see 4.24).',
  '',
  '#### Release prep',
  '',
  'Turn on release prep in the project settings.',
  '',
  '> **In the app:** Help, "Phases" (`/help/phases#releases`).',
  '',
  '### 4.29 Metrics',
  '',
  'Charts of the work.',
  '',
  '### 4.30 Costs',
  '',
  'What the work cost.',
  '',
  '## Appendix A. Where to find things',
  '',
  '### The section map',
  '',
  '| # | Sidebar | Who | Guide | Route |',
  '|---|---|---|---|---|',
  '| 14 | **Releases** | Everybody | 4.28 | `releases` |',
  '| 15 | **Metrics** | Everybody | 4.29 | `metrics` |',
  '',
].join('\n');

const ctx = { assetExists: () => true };

describe('parseGuide and the contents block', () => {
  it('reads numbers, titles and slugs like assemble-guide.mjs', () => {
    const d = parseGuide(SAMPLE);
    const n = d.headings.map((h) => h.number);
    expect(n).toEqual(['4', '4.24', '4.24a', '4.28', null, '4.29', '4.30', null, null]);
    expect(guideSlug('4.28a Release prep (docs)')).toBe('428a-release-prep-docs');
    expect(d.sections.find((s) => s.heading.number === '4.28')?.chapter.number).toBe('4');
  });
  it('renders the contents block byte for byte', () => {
    const d = parseGuide(SAMPLE);
    expect(renderGuideToc(d)).toBe(d.lines.slice(d.toc!.start, d.toc!.end + 1).join('\n'));
  });
  it('matches the contents block of the real user guide', () => {
    const real = readFileSync(fileURLToPath(new URL('../../../docs/USER-GUIDE.md', import.meta.url)), 'utf8');
    const d = parseGuide(real);
    expect(d.toc).not.toBeNull();
    expect(renderGuideToc(d)).toBe(d.lines.slice(d.toc!.start, d.toc!.end + 1).join('\n'));
    expect(checkGuideUpdate(null, real, ctx).errors).toEqual([]);
  });
});

describe('locateSections', () => {
  it('ranks the Releases section first for a change to the Releases page', () => {
    const d = parseGuide(SAMPLE);
    const r = locateSections(d, {
      title: 'Release prep on the Releases page',
      files: ['apps/web/src/pages/Releases.tsx'],
    });
    expect(r[0]?.section).toBe('4.28 Releases');
    expect(r[0]?.why).toMatch(/section map/);
  });
});

describe('applyGuideEdits', () => {
  it('edits only the named section and names it', () => {
    const out = applyGuideEdits(SAMPLE, [
      {
        op: 'replace_text',
        section: '4.28',
        find: 'lists each version',
        replace: 'lists each version and its prep',
        sources: ['card:GWP-1'],
      },
    ]);
    expect(out.kind).toBe('changed');
    if (out.kind !== 'changed') return;
    expect(out.changed).toEqual(['4.28 Releases']);
    const a = SAMPLE.split('\n');
    const b = out.md.split('\n');
    expect(b.length).toBe(a.length);
    const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
    expect(diff).toEqual([
      a.indexOf('The **Releases** page lists each version. Press **Approve release** to ship it (see 4.24).'),
    ]);
    expect(checkGuideUpdate(SAMPLE, out.md, { ...ctx, changedRanges: out.written }).errors).toEqual([]);
  });

  it('appends before the trailing In the app callout', () => {
    const out = applyGuideEdits(SAMPLE, [
      {
        op: 'append',
        section: '4.28 Releases',
        text: '**Update user guide.** Prep updates the guide.',
        sources: [],
      },
    ]);
    if (out.kind !== 'changed') throw new Error(out.kind);
    const b = out.md.split('\n');
    const at = b.indexOf('**Update user guide.** Prep updates the guide.');
    expect(b[at - 1]).toBe('');
    expect(b[at - 2]).toBe('Turn on release prep in the project settings.');
    expect(b[at + 2]).toMatch(/^> \*\*In the app:\*\*/);
  });

  it('numbers a new section after one with a later sibling with a letter, and again with the next letter', () => {
    const out = applyGuideEdits(SAMPLE, [
      {
        op: 'add_section',
        after: '4.28',
        title: 'Release prep',
        body: 'Prep text.',
        sources: ['card:GWP-2'],
      },
      { op: 'add_section', after: '4.28', title: 'Release notes', body: 'Notes text.', sources: [] },
      { op: 'add_section', after: '4.24a', title: 'Build cache', body: 'Cache text.', sources: [] },
    ]);
    if (out.kind !== 'changed') throw new Error(JSON.stringify(out));
    expect(out.added.map((a) => a.section)).toEqual([
      '4.24b Build cache',
      '4.28a Release prep',
      '4.28b Release notes',
    ]);
    const heads = parseGuide(out.md)
      .headings.map((h) => h.number)
      .filter(Boolean);
    expect(heads).toEqual(['4', '4.24', '4.24a', '4.24b', '4.28', '4.28a', '4.28b', '4.29', '4.30']);
    expect(out.md).toContain('  - [4.28a Release prep](#428a-release-prep)');
    expect(
      checkGuideUpdate(SAMPLE, out.md, { ...ctx, changedRanges: out.written, addedSections: 3 }).errors,
    ).toEqual([]);
  });

  it('gives the next integer after the last section of a chapter, and none after an unnumbered one', () => {
    const out = applyGuideEdits(SAMPLE, [
      { op: 'add_section', after: '4.30', title: 'Budgets', body: 'Budget text.', sources: [] },
      { op: 'add_section', after: 'The section map', title: 'Shortcuts', body: 'Keys.', sources: [] },
    ]);
    if (out.kind !== 'changed') throw new Error(JSON.stringify(out));
    expect(out.added.map((a) => a.section)).toEqual(['4.31 Budgets', 'Shortcuts']);
  });

  it('refuses a numbered title, a heading in the body, a figure, an unknown or ambiguous section and a slug clash', () => {
    const bad = (e: Parameters<typeof applyGuideEdits>[1][number]) => applyGuideEdits(SAMPLE, [e]).kind;
    expect(bad({ op: 'add_section', after: '4.28', title: '4.28a Prep', body: 'x', sources: [] })).toBe(
      'error',
    );
    expect(bad({ op: 'append', section: '4.28', text: '### New', sources: [] })).toBe('error');
    expect(bad({ op: 'append', section: '4.28', text: '![x](guide/assets/x.jpg)', sources: [] })).toBe(
      'error',
    );
    expect(bad({ op: 'append', section: '9.9', text: 'x', sources: [] })).toBe('error');
    expect(bad({ op: 'replace_text', section: '4.28', find: 'nope', replace: 'x', sources: [] })).toBe(
      'error',
    );
    expect(
      bad({ op: 'add_section', after: 'The section map', title: 'The section map!', body: 'x', sources: [] }),
    ).toBe('error');
  });

  it('drops edits that are already in the guide, so a second run changes nothing', () => {
    const edits = [
      { op: 'append' as const, section: '4.28', text: '**Prep.** It runs before the ship.', sources: [] },
      { op: 'add_section' as const, after: '4.28', title: 'Release prep', body: 'Prep text.', sources: [] },
      {
        op: 'replace_text' as const,
        section: '4.29',
        find: 'Charts of the work.',
        replace: 'Charts of the work and its cost.',
        sources: [],
      },
    ];
    const once = applyGuideEdits(SAMPLE, edits);
    if (once.kind !== 'changed') throw new Error(once.kind);
    const twice = applyGuideEdits(once.md, edits);
    expect(twice.kind).toBe('unchanged');
    if (twice.kind === 'unchanged') expect(twice.duplicates).toHaveLength(3);
  });

  it('keeps CRLF line ends', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const out = applyGuideEdits(crlf, [{ op: 'append', section: '4.29', text: 'More.', sources: [] }]);
    if (out.kind !== 'changed') throw new Error(out.kind);
    expect(out.md.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('checkGuideUpdate', () => {
  it('fails a changed heading, a broken link, a stale contents block, a missing figure and wrong references', () => {
    const e = (after: string, extra = {}) => checkGuideUpdate(SAMPLE, after, { ...ctx, ...extra }).errors;
    expect(e(SAMPLE.replace('### 4.29 Metrics', '### 4.29 Charts')).join()).toMatch(/heading/);
    expect(e(SAMPLE.replace('(#430-costs)', '(#430-cost)')).join()).toMatch(/link #430-cost/);
    expect(e(SAMPLE.replace('  - [4.30 Costs](#430-costs)\n', '')).join()).toMatch(/contents block/);
    expect(
      checkGuideUpdate(null, `${SAMPLE}\n![Shot](guide/assets/none.jpg)\n`, {
        assetExists: () => false,
      }).errors.join(),
    ).toMatch(/figure/);
    const lines = SAMPLE.split('\n');
    const at = lines.indexOf('Charts of the work.');
    lines[at] = 'Charts of the work (see 4.99 and chapter 12, GWP-12, commit 1a2b3c4d).';
    const errs = e(lines.join('\n'), { changedRanges: [[at, at + 1]] }).join('\n');
    expect(errs).toMatch(/section 4\.99/);
    expect(errs).toMatch(/chapter 12/);
    expect(errs).toMatch(/ticket key/);
    expect(errs).toMatch(/commit id/);
  });

  it('checks Help links only in written lines and only when the Help articles exist', () => {
    const lines = SAMPLE.split('\n');
    const at = lines.indexOf('Charts of the work.');
    lines[at] = 'See `/help/metrics#charts`.';
    const after = lines.join('\n');
    const r = [[at, at + 1]] as Array<[number, number]>;
    expect(checkGuideUpdate(SAMPLE, after, { ...ctx, changedRanges: r }).warnings.join()).toMatch(
      /could not be checked/,
    );
    expect(
      checkGuideUpdate(SAMPLE, after, { ...ctx, changedRanges: r, helpRef: () => false }).errors.join(),
    ).toMatch(/goes nowhere/);
    expect(checkGuideUpdate(SAMPLE, after, { ...ctx, changedRanges: r, helpRef: () => true }).errors).toEqual(
      [],
    );
  });

  it('refuses an update that rewrites too much', () => {
    expect(checkGuideUpdate(SAMPLE, SAMPLE, { ...ctx, editedSections: 7 }).errors.join()).toMatch(/too much/);
  });

  it('makes an oddity that was there before a warning', () => {
    const odd = SAMPLE.replace('(#430-costs)', '(#430-cost)');
    const r = checkGuideUpdate(odd, odd, ctx);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/430-cost/);
  });

  it('scrubs deny-listed terms', () => {
    expect(scrubGuideText('Built by Acme bots', ['acme'])).toEqual(['the term "acme"']);
    expect(scrubGuideText('UTF-8 and ISO-8601 are fine')).toEqual([]);
  });
});

describe('the guide step in the registry', () => {
  it('is on by default, writes files and needs Analyse changes', () => {
    expect(releaseDocsPrepStep('guide')).toEqual(GUIDE_STEP);
    expect(GUIDE_STEP).toMatchObject({
      order: 30,
      defaultOn: true,
      producesFiles: true,
      requires: ['analyse'],
    });
    const commit = releaseDocsPrepStep('commit')!;
    expect(missingReleaseDocsPrepRequirement([GUIDE_STEP, commit])).toEqual({
      step: 'guide',
      requires: 'analyse',
      message: 'Update user guide needs Analyse changes. Turn it on in the project settings.',
    });
    expect(
      missingReleaseDocsPrepRequirement([releaseDocsPrepStep('analyse')!, GUIDE_STEP, commit]),
    ).toBeNull();
  });
  it('collects the covered sources of an output and ignores bad data', () => {
    expect(
      guideOutputSources({
        status: 'passed',
        changed: [{ section: '4.28 Releases', sources: ['card:GWP-1'] }],
        added: [{ section: '4.28a X', after: '4.28 Releases', sources: ['merge:abc'] }],
        covered: [{ source: 'card:GWP-2', section: '4.29' }],
        skippedChanges: [{ source: 'commit:def', reason: 'tests only' }],
      }),
    ).toEqual(['card:GWP-1', 'merge:abc', 'card:GWP-2', 'commit:def']);
    expect(guideOutputSources({ nope: 1 })).toEqual([]);
  });
  it('accepts a payload without step input or writer', () => {
    const base = {
      runId: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      repoId: '00000000-0000-4000-8000-000000000003',
      remoteUrlNormalized: 'github.com/a/b',
      releaseBranch: 'release/1.5.0',
      step: 'guide',
    };
    expect(ReleaseDocsPrepPayloadSchema.safeParse(base).success).toBe(true);
    expect(
      ReleaseDocsPrepPayloadSchema.safeParse({ ...base, stepInput: { guidePath: 'docs/USER-GUIDE.md' } })
        .success,
    ).toBe(true);
  });
});
