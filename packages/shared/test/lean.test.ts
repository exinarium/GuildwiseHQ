import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  dropSections,
  identityLast,
  renderInstructions,
  renderQuestionPrompt,
  roleSectionsToDrop,
} from '../src/index.ts';
import { buildBrief } from './fixtures.ts';

describe('identityLast: the agent name closes the instructions so the cache prefix is shared', () => {
  it('moves the opening "Who you are" section to the end and leaves the rest as it was', () => {
    const md = '# Who you are\nYou are Ada.\n\n# Role instructions\nBuild.\n\n# Core rules\n- a\n';
    expect(identityLast(md)).toBe(
      '# Role instructions\nBuild.\n\n# Core rules\n- a\n\n# Who you are\nYou are Ada.\n',
    );
  });

  it('two agents of the same role and project render the same text up to the identity section', () => {
    const a = buildBrief();
    const b = { ...a, agent: { ...a.agent, name: 'Grace', seniority: 'junior' as const } };
    const ra = identityLast(renderInstructions(a));
    const rb = identityLast(renderInstructions(b));
    const cut = (s: string) => s.slice(0, s.indexOf('# Who you are'));
    expect(cut(ra)).toBe(cut(rb));
    expect(ra).not.toBe(rb);
    expect(ra.trimEnd().endsWith('Names are handles, not personas: do not roleplay, just do the work.')).toBe(
      true,
    );
  });

  it('puts the stage-specific outcomes after the text every shift of the role shares', () => {
    const r = renderInstructions(buildBrief());
    expect(r.indexOf('# Boundaries')).toBeLessThan(r.indexOf('# How to report'));
    expect(r.indexOf('# Standing orders')).toBeLessThan(r.indexOf('# How to report'));
    // the shift length moved with the stage-specific part: Boundaries is the same for every stage
    expect(r.slice(r.indexOf('# Boundaries'), r.indexOf('# How to report'))).not.toMatch(
      /at most \d+ minutes/,
    );
  });

  it('leaves text that does not open with the identity section alone', () => {
    expect(identityLast('# Role\nx\n')).toBe('# Role\nx\n');
    expect(identityLast('# Who you are\nonly this\n')).toBe('# Who you are\nonly this\n');
  });
});

describe('dropSections and the BA role text', () => {
  it('drops a ## section with its ### subsections, up to the next ## section', () => {
    const md = '# Role\n\n## A\na\n\n### A1\na1\n\n## B\nb\n\n## C\nc\n';
    expect(dropSections(md, ['A'])).toBe('# Role\n\n## B\nb\n\n## C\nc\n');
    expect(dropSections(md, ['B', 'C'])).toBe('# Role\n\n## A\na\n\n### A1\na1\n');
    expect(dropSections(md, [])).toBe(md);
  });

  it('does not treat a # comment inside a code fence as a heading', () => {
    const md = '## A\n```\n# not a heading\n```\n\n## B\nb\n';
    expect(dropSections(md, ['A'])).toBe('## B\nb\n');
  });

  const ba = BUILTIN_ROLES.find((r) => r.key === 'ba')!.instructions;
  const heads = (md: string) => md.split('\n').filter((l) => l.startsWith('## '));

  it('a background BA shift no longer carries the intake chat or the organisation design chat', () => {
    expect(heads(ba)).toEqual(
      expect.arrayContaining([
        '## Intake (chat with the manager)',
        '## Designing the organization (chat with the owner)',
      ]),
    );
    for (const kind of ['card', 'question', 'ba_task'] as const) {
      const out = dropSections(ba, roleSectionsToDrop('ba', kind));
      expect(out).not.toContain('## Intake (chat');
      expect(out).not.toContain('## Designing the organization');
      expect(out.length).toBeLessThan(ba.length);
    }
  });

  it('keeps what each kind of shift uses', () => {
    const card = dropSections(ba, roleSectionsToDrop('ba', 'card'));
    expect(card).toContain('## Finalize (background)');
    expect(card).toContain('## Outbound updates (background)');
    const question = dropSections(ba, roleSectionsToDrop('ba', 'question'));
    expect(question).toContain('## Answering questions (background)');
    expect(question).not.toContain('## Finalize (background)');
    const task = dropSections(ba, roleSectionsToDrop('ba', 'ba_task'));
    expect(task).toContain('## Phases (background)');
    expect(task).toContain('## Reporting to the manager (background)');
  });

  it('a batch intake task keeps the intake section (it reads the ticket and drafts cards)', () => {
    const batch = dropSections(ba, roleSectionsToDrop('ba', 'ba_task', { batchIntake: true }));
    expect(batch).toContain('## Intake (chat with the manager)');
    expect(batch).not.toContain('## Designing the organization');
  });

  it('other roles are left whole', () => {
    expect(roleSectionsToDrop('builder', 'card')).toEqual([]);
    expect(roleSectionsToDrop('devops', 'devops')).toEqual([]);
  });
});

describe('question prompt: card first, question last', () => {
  const q = {
    deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
    level: 'peer' as const,
    text: 'Tabs or spaces?',
    doing: 'writing the formatter',
    options: [{ id: 'o1', label: 'tabs' }],
    recommendation: 'o1',
    blocking: true,
    askedBy: { name: 'Ada', role: 'builder' },
    trail: [],
    ledgerMatches: [],
  };
  it('the card comes first and the question text last, so the card prefix is shared between questions', () => {
    const p = renderQuestionPrompt(buildBrief(), q);
    expect(p.startsWith('## The card')).toBe(true);
    expect(p.indexOf('## The card')).toBeLessThan(p.indexOf('# Question'));
    expect(p.indexOf('## The card')).toBeLessThan(p.indexOf('Tabs or spaces?'));
    expect(p.indexOf('Tabs or spaces?')).toBeGreaterThan(p.indexOf('## What the asker was doing'));
    // two different questions about the same card share everything up to the question header
    const p2 = renderQuestionPrompt(buildBrief(), {
      ...q,
      text: 'Semicolons?',
      deskItemId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c4',
    });
    const shared = (s: string) => s.slice(0, s.indexOf('# Question'));
    expect(shared(p)).toBe(shared(p2));
  });
});

describe('aom is never instructed to be piped', () => {
  it('the rendered instructions tell the agent to run aom on its own, and no example pipes it', () => {
    const r = renderInstructions(buildBrief());
    expect(r).toMatch(/no pipes, redirects/);
    for (const line of r.split('\n').filter((l) => /`aom [^`\n]*\|[^`\n]*`/.test(l)))
      expect(line).toMatch(/not|never|no pipes/i);
  });
});
