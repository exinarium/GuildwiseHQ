import { describe, expect, it } from 'vitest';
import { checkedProposal, designModeOf, designSizeStep, splitDecision } from '../src/commands/design-size.ts';

/** Pure checks of the design handoff's size step (no database). */

const project = (o: Record<string, unknown> = {}) => ({
  size_budget: 400,
  size_unit: 'changed_lines',
  risk_map: [{ pattern: 'apps/server/src/auth', risk: 'high' }],
  ...o,
});
const card = (o: Record<string, unknown> = {}) => ({
  id: 'c1',
  stage: 'investigate',
  fields: { affectedAreas: 'GuildwiseHQ: packages/shared, apps/server' },
  investigation: null,
  ...o,
});
const inv = (size?: Record<string, unknown>, review?: Record<string, unknown>) =>
  ({
    reportPath: 'docs/x.md',
    summary: 'The design.',
    location: 'repo',
    ...(size ? { size: { paths: [], seams: [], ...size } } : {}),
    ...(review ? { review } : {}),
  }) as never;
const NEW = '0.1.75';

describe('designSizeStep', () => {
  it('AC1: records the estimate in the project unit and the risk class from the paths', () => {
    const r = designSizeStep({
      card: card(),
      project: project(),
      inv: inv({ estimate: 120, paths: ['apps/server/src/auth/login.ts'] }),
      mode: 'design',
      runnerVersion: NEW,
    });
    expect('sizing' in r && r.sizing).toMatchObject({
      estimate: 120,
      unit: 'changed_lines',
      verdict: 'within_budget',
      risk: { class: 'high' },
    });
  });
  it('refuses a design without --size and --path when the project has a size unit', () => {
    const r = designSizeStep({
      card: card(),
      project: project(),
      inv: inv(),
      mode: 'design',
      runnerVersion: NEW,
    });
    expect(r).toMatchObject({ error: expect.stringContaining('add --size <n>') });
    const noPath = designSizeStep({
      card: card(),
      project: project(),
      inv: inv({ estimate: 5 }),
      mode: 'design',
      runnerVersion: NEW,
    });
    expect('error' in noPath).toBe(true);
  });
  it('does not trap an older runner that cannot send the estimate', () => {
    const r = designSizeStep({
      card: card(),
      project: project(),
      inv: inv(),
      mode: 'design',
      runnerVersion: '0.1.73',
    });
    expect('sizing' in r && r.sizing.verdict).toBeNull();
  });
  it('AC4: no budget set gives no verdict and "no size budget set"', () => {
    const r = designSizeStep({
      card: card(),
      project: project({ size_budget: null, size_unit: null }),
      inv: inv(),
      mode: 'design',
      runnerVersion: NEW,
    });
    expect('sizing' in r && r.sizing).toMatchObject({ verdict: null, verdictText: 'no size budget set' });
  });
  it('confirm recomputes the stored estimate against the current budget', () => {
    const first = designSizeStep({
      card: card(),
      project: project({ size_budget: 1000 }),
      inv: inv({ estimate: 640, paths: ['apps/web'] }),
      mode: 'design',
      runnerVersion: NEW,
    });
    if (!('sizing' in first)) throw new Error('refused');
    expect(first.sizing.verdict).toBe('within_budget');
    const confirmed = designSizeStep({
      card: card({ investigation: { sizing: first.sizing } }),
      project: project(),
      inv: inv(undefined, { decision: 'confirm', revised: [], note: '' }),
      mode: 'confirm',
      runnerVersion: NEW,
    });
    expect('sizing' in confirmed && confirmed.sizing).toMatchObject({
      estimate: 640,
      verdict: 'over_budget',
    });
  });
  it('confirm without a stored estimate is refused when a unit is set', () => {
    const r = designSizeStep({
      card: card(),
      project: project(),
      inv: inv(undefined, { decision: 'confirm', revised: [], note: '' }),
      mode: 'confirm',
      runnerVersion: NEW,
    });
    expect(r).toMatchObject({ error: expect.stringContaining('aom design revise') });
  });
});

describe('splitDecision and checkedProposal', () => {
  it('AC2/AC3: only an over-budget verdict leads to a split; continued goes on', () => {
    expect(splitDecision({ verdict: 'over_budget' }, null)).toBe('split');
    expect(splitDecision({ verdict: 'over_budget' }, 'continued')).toBe('continued');
    expect(splitDecision({ verdict: 'within_budget' }, null)).toBe('none');
    expect(splitDecision({ verdict: null }, null)).toBe('none');
  });
  it('refuses an over-budget design with fewer than 2 seams and accepts 2', () => {
    const over = (seams: Array<{ title: string; folders: string[] }>) => {
      const r = designSizeStep({
        card: card(),
        project: project(),
        inv: inv({ estimate: 900, paths: ['apps/server/src/a.ts', 'apps/web/src'], seams }),
        mode: 'design',
        runnerVersion: NEW,
      });
      if (!('sizing' in r)) throw new Error('refused');
      return checkedProposal(r.sizing, 'Summary.');
    };
    expect(over([{ title: 'One', folders: ['apps/web/src'] }])).toMatchObject({
      error: expect.stringContaining('name at least 2 split seams'),
    });
    const ok = over([
      { title: 'Server', folders: ['apps/server/src'] },
      { title: 'Web', folders: ['apps/web/src'] },
    ]);
    expect('proposal' in ok && ok.proposal.folderScope).toEqual(['apps/server/src', 'apps/web/src']);
  });
  it('reads the mode from the review decision', () => {
    expect(designModeOf({})).toBe('design');
    expect(designModeOf({ review: { decision: 'revise', revised: [1], note: '' } })).toBe('revise');
  });
});
