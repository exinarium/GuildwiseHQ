import { describe, expect, it } from 'vitest';
import {
  type ChainCandidate,
  COMMIT_STATUS_DESCRIPTION_MAX,
  prSizeVerdict,
  SIZE_STATUS_CONTEXT,
  sizeStatusFor,
  sizeWithUnit,
} from '../src/index.ts';

const cand = (id: string, head: string, base: string, lines: number | null, files = 1): ChainCandidate => ({
  changeId: id,
  head,
  base,
  crossRepo: false,
  size: { changedLines: lines, changedFiles: files },
  excluded: false,
});

const lines600 = { sizeBudget: 600, sizeUnit: 'changed_lines' as const };

function statusOf(
  id: string,
  open: ChainCandidate[],
  opts: { excepted?: boolean; hadStatus?: boolean; settings?: Record<string, unknown> } = {},
) {
  const verdict = prSizeVerdict({
    settings: (opts.settings ?? lines600) as never,
    changeId: id,
    open,
    complete: true,
  });
  return sizeStatusFor({ verdict, excepted: opts.excepted ?? false, hadStatus: opts.hadStatus ?? false });
}

describe('size status (GWP-211)', () => {
  it('uses the context the owner makes required', () => {
    expect(SIZE_STATUS_CONTEXT).toBe('size-budget');
  });

  it('AC1: an over-budget PR fails and names size, budget and unit', () => {
    const s = statusOf('12', [cand('12', 'a', 'main', 700)]);
    expect(s?.state).toBe('failure');
    expect(s?.reason).toBe('over');
    expect(s?.description).toBe('Over budget: 700 changed lines, budget 600 changed lines');
  });

  it('AC1: the files unit says changed files, singular for one', () => {
    const s = statusOf('1', [cand('1', 'a', 'main', 10, 9)], {
      settings: { sizeBudget: 5, sizeUnit: 'changed_files' },
    });
    expect(s?.description).toBe('Over budget: 9 changed files, budget 5 changed files');
    expect(sizeWithUnit(1, 'changed_files')).toBe('1 changed file');
    expect(sizeWithUnit(1, 'changed_lines')).toBe('1 changed line');
  });

  it('AC2: an over-budget PR with an owner exception passes and says so', () => {
    const s = statusOf('12', [cand('12', 'a', 'main', 700)], { excepted: true });
    expect(s?.state).toBe('success');
    expect(s?.reason).toBe('owner_exception');
    expect(s?.description).toContain('owner exception');
    expect(s?.description).toContain('700 changed lines');
    expect(s?.description).toContain('600 changed lines');
  });

  it('AC3: a within-budget PR passes, and exactly the budget is within', () => {
    const a = statusOf('1', [cand('1', 'a', 'main', 420)]);
    expect(a?.state).toBe('success');
    expect(a?.description).toBe('Within budget: 420 changed lines, budget 600 changed lines');
    expect(statusOf('1', [cand('1', 'a', 'main', 600)])?.state).toBe('success');
    expect(statusOf('1', [cand('1', 'a', 'main', 601)])?.state).toBe('failure');
  });

  it('an exception does not change a within-budget status', () => {
    expect(statusOf('1', [cand('1', 'a', 'main', 10)], { excepted: true })?.reason).toBe('within');
  });

  it('AC4: every PR of a stack that is over budget in total fails with the same numbers', () => {
    const open = [cand('12', 'a', 'main', 300), cand('13', 'b', 'a', 400)];
    const a = statusOf('12', open);
    const b = statusOf('13', open);
    expect(a?.state).toBe('failure');
    expect(b?.state).toBe('failure');
    expect(a?.description).toBe('Over budget: 700 changed lines, budget 600 changed lines (stack #12 #13)');
    expect(b?.description).toBe(a?.description);
  });

  it('AC4: a stack within budget in total passes for each PR', () => {
    const open = [cand('12', 'a', 'main', 200), cand('13', 'b', 'a', 300)];
    expect(statusOf('12', open)?.state).toBe('success');
    expect(statusOf('13', open)?.state).toBe('success');
  });

  it('stays within 140 characters with a long stack, keeping size, budget and unit', () => {
    const open: ChainCandidate[] = [];
    for (let i = 0; i < 30; i++)
      open.push(cand(String(1000 + i), `h${i}`, i === 0 ? 'main' : `h${i - 1}`, 100));
    const s = statusOf('1000', open, { settings: { sizeBudget: 600, sizeUnit: 'changed_lines' } });
    expect(s?.state).toBe('failure');
    expect(s?.description.length).toBeLessThanOrEqual(COMMIT_STATUS_DESCRIPTION_MAX);
    expect(s?.description).toContain('3000 changed lines');
    expect(s?.description).toContain('budget 600 changed lines');
    expect(s?.description).toContain('stack of 30 PRs');
    const e = statusOf('1000', open, { excepted: true });
    expect(e?.description.length).toBeLessThanOrEqual(COMMIT_STATUS_DESCRIPTION_MAX);
    expect(e?.description).toContain('owner exception');
  });

  it('AC5: without a budget nothing is posted', () => {
    expect(statusOf('1', [cand('1', 'a', 'main', 9999)], { settings: {} })).toBeNull();
    expect(
      statusOf('1', [cand('1', 'a', 'main', 9999)], { settings: { sizeUnit: 'changed_lines' } }),
    ).toBeNull();
  });

  it('AC5: after the budget is removed a repository that had the check gets a passing inactive status', () => {
    const s = statusOf('1', [cand('1', 'a', 'main', 9999)], { settings: {}, hadStatus: true });
    expect(s?.state).toBe('success');
    expect(s?.reason).toBe('inactive');
    expect(s?.description).toBe('Size check inactive: no size budget set');
  });

  it('a PR without a measured size is pending', () => {
    const s = statusOf('1', [cand('1', 'a', 'main', null)]);
    expect(s?.state).toBe('pending');
    expect(s?.description).toBe('Size not measured yet');
  });
});
