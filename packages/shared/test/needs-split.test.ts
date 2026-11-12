import { describe, expect, it } from 'vitest';
import {
  NEEDS_SPLIT_DESK_SUBKIND,
  NEEDS_SPLIT_MAX_SEAMS,
  NeedsSplitProposalSchema,
  NeedsSplitState,
  needsSplitRoute,
} from '../src/cards/needs-split.ts';
import { DomainEventSchema } from '../src/index.ts';
import {
  MIN_RUNNER_FOR_NEEDS_SPLIT,
  runnerAtLeast,
  renderSpecCardInstructions,
  renderSpecCardPrompt,
  SPEC_CARD_MAX_SPLIT,
  type SpecCardTask,
} from '../src/intake/spec-card.ts';
import { ROUTING_EXEMPT_SUBKINDS } from '../src/reporter/index.ts';

const seam = (title: string, folders = ['apps/server/src']) => ({ title, folders });
const base = {
  reason: 'over budget',
  folderScope: ['apps/server/src', 'apps/web/src'],
  seams: [seam('Server'), seam('Web', ['apps/web/src'])],
};
const parse = (over: Record<string, unknown>) => NeedsSplitProposalSchema.safeParse({ ...base, ...over });

describe('NeedsSplitProposalSchema', () => {
  it('normalises folders', () => {
    const p = parse({ folderScope: ['./apps/server/', 'apps\\web\\src'] });
    expect(p.success && p.data.folderScope).toEqual(['apps/server', 'apps/web/src']);
  });

  it('accepts dot-folders', () => {
    expect(parse({ folderScope: ['.github/workflows'] }).success).toBe(true);
  });

  it.each([['apps/server/src/index.ts'], ['/apps'], ['apps/../secrets'], ['apps/*'], ['']])(
    'refuses %j: folders only',
    (f) => {
      expect(parse({ folderScope: [f] }).success).toBe(false);
    },
  );

  it('refuses a file in a seam', () => {
    expect(parse({ seams: [seam('A', ['a/b.ts']), seam('B')] }).success).toBe(false);
  });

  it('takes 2 to 8 seams', () => {
    expect(parse({ seams: [seam('A')] }).success).toBe(false);
    expect(parse({ seams: Array.from({ length: 9 }, (_, i) => seam(`S${i}`)) }).success).toBe(false);
    expect(parse({ seams: Array.from({ length: 8 }, (_, i) => seam(`S${i}`)) }).success).toBe(true);
    expect(NEEDS_SPLIT_MAX_SEAMS).toBe(SPEC_CARD_MAX_SPLIT);
  });

  it('refuses a folder twice in the scope', () => {
    expect(parse({ folderScope: ['apps/server', './apps/server/'] }).success).toBe(false);
  });
});

describe('needsSplitRoute: once to the BA, then the owner', () => {
  it.each([
    [
      { taken: false, hasBa: true },
      { route: 'ba', reason: 'first' },
    ],
    [
      { taken: true, hasBa: true },
      { route: 'owner', reason: 'second_time' },
    ],
    [
      { taken: true, inherited: true, hasBa: true },
      { route: 'owner', reason: 'inherited' },
    ],
    [
      { taken: false, hasBa: false },
      { route: 'owner', reason: 'no_ba' },
    ],
    [
      { taken: true, force: true, hasBa: true },
      { route: 'ba', reason: 'owner_again' },
    ],
    [
      { taken: true, force: true, hasBa: false },
      { route: 'owner', reason: 'no_ba' },
    ],
  ])('%j -> %j', (input, out) => {
    expect(needsSplitRoute(input)).toEqual(out);
  });

  it('the owner item is never held for triage', () => {
    expect(ROUTING_EXEMPT_SUBKINDS).toContain(NEEDS_SPLIT_DESK_SUBKIND);
  });
});

describe('the needs-split BA prompt', () => {
  const task: SpecCardTask = {
    cardId: '00000000-0000-4000-8000-000000000001',
    ref: 'TOY-7',
    title: 'Too big',
    cardType: 'feature',
    projectKey: 'TOY',
    fields: { context: 'the card' },
    missing: [],
    listFields: [],
    needsSplit: {
      proposal: {
        reason: 'Estimated 1400 lines',
        folderScope: ['apps/server/src/commands', 'apps/web/src/components'],
        seams: [
          { title: 'Server transition', folders: ['apps/server/src/commands'], note: 'route too' },
          { title: 'Web panel', folders: ['apps/web/src/components'], repo: 'web' },
        ],
        estimate: { size: 1400, budget: 400, unit: 'changed_lines' },
      },
      round: 1,
      design: { reportPath: 'docs/investigations/TOY-7.md', summary: 'the design' },
      repos: [{ name: 'toy' }, { name: 'web' }],
      defaultRepo: 'toy',
    },
  };
  const brief = { agent: { name: 'Ben' }, role: { instructions: 'BA', coreRules: [] } };

  it('shows every folder and seam and asks for a split only', () => {
    const text = renderSpecCardInstructions(
      brief,
      task,
      [{ id: 'spec_card_done', label: 'done' }],
      (o) => o.id,
    );
    for (const f of task.needsSplit!.proposal.folderScope) expect(text).toContain(f);
    for (const s of task.needsSplit!.proposal.seams) expect(text).toContain(s.title);
    expect(text).toContain('over its size budget');
    expect(text).toContain('"split"');
    expect(text).toContain('1400 changed_lines, budget 400');
    expect(text).toContain('repository web');
    const prompt = renderSpecCardPrompt(task);
    expect(prompt).toContain('docs/investigations/TOY-7.md');
    expect(prompt).toContain('"split"');
    expect(prompt).not.toContain('## Missing');
  });

  it('a plain specify task is unchanged', () => {
    const plain = { ...task, needsSplit: undefined, missing: ['requirements'] };
    const text = renderSpecCardInstructions(brief, plain, [{ id: 'd', label: 'd' }], (o) => o.id);
    expect(text).not.toContain('over its size budget');
    expect(renderSpecCardPrompt(plain)).toContain('## Missing');
  });
});

describe('needs-split record and runner gate', () => {
  it('knows the dropped state and outcome', () => {
    expect(NeedsSplitState.options).toContain('dropped');
    const parsed = DomainEventSchema.safeParse({
      type: 'CardNeedsSplitResolved',
      payload: { cardId: '00000000-0000-4000-8000-000000000001', outcome: 'dropped' },
    });
    expect(parsed.success).toBe(true);
  });

  it('needs a runner newer than 0.1.73, which shipped without the needs-split prompt', () => {
    expect(runnerAtLeast('0.1.73', MIN_RUNNER_FOR_NEEDS_SPLIT)).toBe(false);
    expect(runnerAtLeast('0.1.74', MIN_RUNNER_FOR_NEEDS_SPLIT)).toBe(true);
  });
});
