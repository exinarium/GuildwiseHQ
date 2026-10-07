import { describe, expect, it } from 'vitest';
import {
  boardColumns,
  boardColumnsWith,
  ConvertProjectRequestSchema,
  CROSS_PROJECT_CARD_TYPES,
  canConvertProject,
  codeWorkflowV1,
  DomainEventSchema,
  feedWorkflowV1,
  isResearchStage,
  memberOutcome,
  phaseCompletion,
  RESEARCH_INDEX_SECTION_ID,
  renderResearchIndex,
  researchWorkflowV1,
  WorkingBranchReason,
} from '../src/index.ts';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('board columns with cards of other workflows', () => {
  it('adds the research columns before Done, once, and only when given', () => {
    const own = boardColumns(codeWorkflowV1);
    expect(boardColumnsWith(codeWorkflowV1, [])).toEqual(own);
    const withResearch = boardColumnsWith(codeWorkflowV1, [researchWorkflowV1]);
    expect(withResearch.slice(-1)).toEqual(['Done']);
    expect(withResearch).toContain('Research');
    expect(withResearch).toContain('Fact check');
    expect(withResearch.indexOf('Fact check')).toBe(withResearch.length - 2);
    expect(withResearch.filter((c) => c === 'Spec')).toHaveLength(1);
    // two other workflows with the same columns do not duplicate them
    expect(boardColumnsWith(codeWorkflowV1, [researchWorkflowV1, researchWorkflowV1])).toEqual(withResearch);
  });
  it('a research board gets the code columns the same way, and Done stays last', () => {
    const cols = boardColumnsWith(researchWorkflowV1, [codeWorkflowV1]);
    expect(cols.slice(-1)).toEqual(['Done']);
    expect(cols).toEqual(expect.arrayContaining(['To do', 'In progress', 'Review', 'Test']));
    expect(boardColumnsWith(feedWorkflowV1, [])).toEqual(boardColumns(feedWorkflowV1));
  });
});

describe('research stage helpers', () => {
  it('knows the cross-project card types and the stage', () => {
    expect(CROSS_PROJECT_CARD_TYPES).toEqual({ research: 'research' });
    expect(isResearchStage('research')).toBe(true);
    expect(isResearchStage('code')).toBe(false);
    expect(canConvertProject({ orgRole: 'owner' })).toBe(true);
    expect(canConvertProject({ orgRole: 'admin' })).toBe(true);
    expect(canConvertProject({ orgRole: 'member' })).toBe(false);
    expect(canConvertProject({ orgRole: null })).toBe(false);
  });
  it('a published research card is a resolved phase member', () => {
    const m = { status: 'done', assignment: 'confirmed' as const, finalized: false, merged: false };
    expect(memberOutcome(m)).toBe('closed_manually');
    expect(memberOutcome({ ...m, published: true })).toBe('published');
    expect(phaseCompletion([{ ...m, published: true }])).toBe('complete');
    expect(phaseCompletion([{ ...m, status: 'queued', published: true }])).toBe('incomplete');
  });
});

describe('ProjectConverted and the convert request', () => {
  it('parses with defaults and the new cancel cause', () => {
    const e = DomainEventSchema.parse({
      type: 'ProjectConverted',
      payload: { projectId: U(1), fromWorkflowKey: 'research', toWorkflowKey: 'code', by: U(2) },
    });
    expect(e.type === 'ProjectConverted' && e.payload).toMatchObject({
      cardDecisions: [],
      cancelledCardIds: [],
      repoIds: [],
    });
    expect(
      DomainEventSchema.parse({
        type: 'CardCancelled',
        payload: { cardId: U(3), reason: 'Project converted', cause: 'project_converted' },
      }).type,
    ).toBe('CardCancelled');
    expect(WorkingBranchReason.parse('conversion')).toBe('conversion');
    // a request written by the manager (no agent) parses
    expect(
      DomainEventSchema.parse({
        type: 'RepoCreateRequested',
        payload: {
          requestId: U(4),
          projectId: U(1),
          name: 'acme/x',
          visibility: 'private',
          requestedByUserId: U(2),
          deskItemId: U(5),
        },
      }).type,
    ).toBe('RepoCreateRequested');
  });
  it('the request defaults to keeping cards and takes existing and new repositories', () => {
    const r = ConvertProjectRequestSchema.parse({
      toWorkflowKey: 'code',
      repos: [{ name: 'a', remoteUrl: 'https://github.com/acme/a.git' }, { create: { name: 'acme/b' } }],
    });
    expect(r.defaultDecision).toBe('keep');
    expect(r.cardDecisions).toEqual({});
    expect(r.repos[1]).toEqual({ create: { name: 'acme/b', visibility: 'private' } });
    expect(
      ConvertProjectRequestSchema.safeParse({
        toWorkflowKey: 'code',
        repos: [{ create: { name: 'noslash' } }],
      }).success,
    ).toBe(false);
    expect(
      ConvertProjectRequestSchema.safeParse({ toWorkflowKey: 'code', defaultDecision: 'maybe' }).success,
    ).toBe(false);
  });
});

describe('the research index of PROJECT.md', () => {
  const notes = [
    {
      title: 'Second [draft]',
      vaultPath: 'projects/rld/b/second.md',
      cardRef: 'RLD-2',
      citations: 1,
      publishedAt: '2026-10-04T10:00:00.000Z',
    },
    {
      title: 'First',
      vaultPath: 'projects/rld/a/first note.md',
      cardRef: 'RLD-1',
      citations: 3,
      publishedAt: '2026-10-03T10:00:00.000Z',
    },
  ];
  it('lists the notes oldest first, relative to the project folder, deterministically', () => {
    const md = renderResearchIndex(notes, { folder: 'projects/rld', convertedTo: 'Code' });
    expect(RESEARCH_INDEX_SECTION_ID).toBe('research-index');
    expect(md.indexOf('First')).toBeLessThan(md.indexOf('Second'));
    expect(md).toContain('- [First](a/first%20note.md) (RLD-1, 3 citations, 2026-10-03)');
    expect(md).toContain('- [Second draft](b/second.md) (RLD-2, 1 citation, 2026-10-04)');
    expect(md).toContain('converted to the Code workflow');
    expect(renderResearchIndex(notes, { folder: 'projects/rld', convertedTo: 'Code' })).toBe(md);
    expect(md.endsWith('\n')).toBe(true);
  });
  it('says so when nothing was published', () => {
    expect(renderResearchIndex([], { folder: 'projects/rld' })).toContain('_No notes were published yet._');
  });
});
