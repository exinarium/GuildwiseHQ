import { applyHelpEdits, checkHelpUpdate, HelpEditSchema, parseHelpArticle } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { HelpStepOutput } from '../components/delivery/HelpStepOutput.tsx';
import { buildArticle, searchHelp } from '../help/articles.ts';

const SOURCES = import.meta.glob('../help/articles/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCES).map(([p, src]) => [/([^/]+)\.md$/.exec(p)?.[1] as string, src]),
);

describe('Help articles and the release prep Help step', () => {
  it('the shared parser finds the same heading ids, in the same order, as the app for every article', () => {
    expect(Object.keys(FILES).length).toBeGreaterThan(10);
    for (const [slug, src] of Object.entries(FILES))
      expect(
        parseHelpArticle(src).headings.map((h) => h.id),
        slug,
      ).toEqual(buildArticle(slug, src).headings.map((h) => h.id));
  });

  it('the real articles pass the Help check as they are', () => {
    expect(checkHelpUpdate(null, FILES).errors).toEqual([]);
  });

  it('after an update every article still parses, every anchor still resolves and search finds the new text', () => {
    const r = applyHelpEdits(FILES, [
      HelpEditSchema.parse({
        op: 'append',
        article: 'phases',
        section: 'release-prep',
        text: 'Zephyrine marker paragraph for the release prep test.',
      }),
      HelpEditSchema.parse({
        op: 'add_section',
        article: 'phases',
        after: 'release-prep',
        level: 2,
        title: 'Quillbrook section',
        id: 'quillbrook-section',
        body: 'A new section for a new feature.',
      }),
    ]);
    expect(r.kind).toBe('changed');
    if (r.kind !== 'changed') return;
    expect(Object.keys(r.files)).toEqual(['phases']);
    const after = { ...FILES, ...r.files };
    expect(checkHelpUpdate(FILES, after, { changedRanges: r.written }).errors).toEqual([]);
    const before = buildArticle('phases', FILES.phases as string);
    const now = buildArticle('phases', after.phases as string);
    expect(now.title).toBe(before.title);
    expect(now.order).toBe(before.order);
    const ids = now.headings.map((h) => h.id);
    for (const h of before.headings) expect(ids).toContain(h.id);
    expect(ids).toContain('quillbrook-section');
    const articles = Object.entries(after).map(([slug, src]) => buildArticle(slug, src));
    expect(articles).toHaveLength(Object.keys(FILES).length);
    expect(searchHelp('zephyrine', articles).map((h) => h.to)).toContain('/help/phases#release-prep');
    expect(searchHelp('quillbrook', articles).map((h) => h.to)).toContain('/help/phases#quillbrook-section');
    // the other articles are byte for byte the same
    for (const slug of Object.keys(FILES)) if (slug !== 'phases') expect(after[slug]).toBe(FILES[slug]);
  });

  it('phases.md describes the Update Help articles step under its release prep anchor', () => {
    const a = buildArticle('phases', FILES.phases as string);
    expect(a.sections.find((s) => s.id === 'release-prep')?.text).toContain('Update Help articles');
  });
});

describe('HelpStepOutput', () => {
  const wrap = (output: unknown) =>
    render(
      <MemoryRouter>
        <HelpStepOutput output={output} />
      </MemoryRouter>,
    );
  const base = {
    status: 'passed',
    changed: [],
    added: [],
    covered: [],
    skippedChanges: [],
    errors: [],
    warnings: [],
    notes: [],
  };

  it('lists the updated and added sections with links to them', () => {
    wrap({
      ...base,
      changed: [
        {
          article: 'phases',
          title: 'Phases and follow-ups',
          section: 'releases',
          heading: 'Releases',
          sources: [],
        },
      ],
      added: [
        {
          article: 'phases',
          title: 'Phases and follow-ups',
          section: 'prep-help',
          heading: 'Help in prep',
          after: 'releases',
          sources: [],
        },
      ],
    });
    expect(screen.getByTestId('help-output-changed')).toHaveTextContent('Phases and follow-ups › Releases');
    expect(screen.getByRole('link', { name: /Releases/ })).toHaveAttribute('href', '/help/phases#releases');
    expect(screen.getByTestId('help-output-added')).toHaveTextContent('Help in prep (after #releases)');
  });

  it('says when no article needed changes, and when the repository has no Help articles', () => {
    const a = wrap({ ...base, nothing: 'no Help change needed' });
    expect(screen.getByTestId('help-output-none')).toHaveTextContent('No Help article needed changes.');
    a.unmount();
    wrap({ ...base, skipped: 'no help articles' });
    expect(screen.getByTestId('help-output-skipped')).toHaveTextContent(
      'Skipped: no Help articles in this repository.',
    );
  });

  it('shows nothing for an output it cannot read', () => {
    const { container } = wrap({ something: 'else' });
    expect(container).toBeEmptyDOMElement();
  });
});
