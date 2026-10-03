import { describe, expect, it } from 'vitest';
import {
  commandForOutcome,
  DomainEventSchema,
  defaultNotePath,
  getBuiltinRole,
  isPublishRequest,
  noteExcerpt,
  outcomeDataSchema,
  PublicationDataSchema,
  PublishRequestSchema,
  parseNoteFrontMatter,
  renderNote,
  splitNote,
} from '../src/index.ts';
import { U } from './fixtures.ts';

const cite = (n: number) => ({
  url: `https://source.example.test/${n}`,
  title: `Source ${n}`,
  accessedAt: '2026-10-03T08:00:00.000Z',
});

describe('research notes', () => {
  it('renders front matter that reads back with title and citations', () => {
    const md = renderNote({
      title: 'Is 6mm ARC "better" than 6.5 Creedmoor?',
      body: 'Short answer: it depends. [1]\n\n1. Source 1',
      cardRef: 'RES-1',
      subCategory: 'Reloading',
      published: '2026-10-03',
      citations: [cite(1), cite(2)],
    });
    expect(md.startsWith('---\ntitle: ')).toBe(true);
    const fm = parseNoteFrontMatter(md);
    expect(fm?.title).toBe('Is 6mm ARC "better" than 6.5 Creedmoor?');
    expect(fm?.citations).toEqual([
      { url: cite(1).url, title: 'Source 1', accessedAt: cite(1).accessedAt },
      { url: cite(2).url, title: 'Source 2', accessedAt: cite(2).accessedAt },
    ]);
    expect(splitNote(md).body.trim().startsWith('Short answer')).toBe(true);
    expect(noteExcerpt(md, 20)).toHaveLength(20);
  });

  it('understands plain and inline citation lists and reports none for a note without them', () => {
    expect(
      parseNoteFrontMatter('---\ntitle: T\ncitations:\n  - https://a.test/x\n  - https://b.test/y\n---\nbody')
        ?.citations,
    ).toEqual([{ url: 'https://a.test/x' }, { url: 'https://b.test/y' }]);
    expect(
      parseNoteFrontMatter('---\ncitations: [https://a.test/x, "https://b.test/y"]\n---\nbody')?.citations,
    ).toHaveLength(2);
    expect(parseNoteFrontMatter('---\ntitle: T\ncitations:\n---\nbody')?.citations).toEqual([]);
    expect(parseNoteFrontMatter('---\ntitle: T\n---\nbody')?.citations).toEqual([]);
    expect(parseNoteFrontMatter('no front matter at all')).toBeNull();
  });

  it('puts a note under projects/<name>/<sub-category>/ by default', () => {
    expect(defaultNotePath('projects/shooting', 'Hunting ballistics', 'Is 6mm ARC enough?')).toBe(
      'projects/shooting/hunting-ballistics/is-6mm-arc-enough.md',
    );
    expect(defaultNotePath('projects/shooting', undefined, 'A note')).toBe(
      'projects/shooting/general/a-note.md',
    );
  });
});

describe('M6 contract', () => {
  it('a publication needs at least one citation; the request form carries the note content', () => {
    const ok = { vaultPath: 'projects/x/general/n.md', title: 'T', citations: [cite(1)] };
    expect(PublicationDataSchema.parse(ok).excerpt).toBe('');
    expect(PublicationDataSchema.safeParse({ ...ok, citations: [] }).success).toBe(false);
    expect(
      PublishRequestSchema.parse({ content: '# T', citations: [{ url: 'https://a.test', title: 'A' }] })
        .citations,
    ).toHaveLength(1);
    expect(isPublishRequest({ content: 'x' })).toBe(true);
    expect(isPublishRequest(ok)).toBe(false);
    expect(outcomeDataSchema('publication').safeParse(ok).success).toBe(true);
    expect(outcomeDataSchema('publication').safeParse({ content: '# T' }).success).toBe(true);
    expect(outcomeDataSchema('publication').safeParse({ nonsense: 1 }).success).toBe(false);
  });

  it('parses ResearchPublished', () => {
    const e = DomainEventSchema.parse({
      type: 'ResearchPublished',
      payload: {
        cardId: U.a,
        projectId: U.b,
        vaultPath: 'projects/x/g/n.md',
        title: 'T',
        citations: [cite(1)],
      },
    });
    expect(e.type === 'ResearchPublished' && e.payload.excerpt).toBe('');
    expect(
      DomainEventSchema.safeParse({
        type: 'ResearchPublished',
        payload: { cardId: U.a, projectId: U.b, vaultPath: 'p', title: 'T', citations: [] },
      }).success,
    ).toBe(false);
  });

  it('ships real researcher and checker instructions and commands', () => {
    const researcher = getBuiltinRole('researcher');
    const checker = getBuiltinRole('checker');
    expect(researcher?.instructions).not.toContain('TODO');
    expect(checker?.instructions).not.toContain('TODO');
    expect(checker?.instructions).toContain('aom publish');
    expect(checker?.coreRules.join(' ')).toMatch(/no citations, no publication/);
    expect(
      commandForOutcome({ id: 'published', label: 'p', kind: 'success', data: 'publication' }),
    ).toContain('aom publish --file');
    expect(commandForOutcome({ id: 'unsupported', label: 'u', kind: 'failure', data: 'none' })).toContain(
      'aom outcome unsupported',
    );
  });
});
