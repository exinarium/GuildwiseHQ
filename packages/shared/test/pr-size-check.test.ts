import { describe, expect, it } from 'vitest';
import {
  type ChainCandidate,
  changeSize,
  isSecondTimeout,
  prChain,
  prSizeVerdict,
  splitNoticeBody,
  splitNoticeMarker,
  timeoutFollowUp,
} from '../src/index.ts';

const c = (
  changeId: string,
  head: string,
  base: string,
  lines: number | null,
  over: Partial<ChainCandidate> = {},
): ChainCandidate => ({
  changeId,
  head,
  base,
  crossRepo: false,
  size: { changedLines: lines, changedFiles: lines === null ? null : Math.ceil(lines / 100) },
  excluded: false,
  ...over,
});
const settings = (
  sizeBudget: number | null,
  sizeUnit: 'changed_lines' | 'changed_files' | null = 'changed_lines',
) => ({
  sizeBudget,
  sizeUnit,
});

describe('prChain: stacked pull requests are one chain', () => {
  const open = [
    c('10', 'f1', 'main', 300),
    c('11', 'f2', 'f1', 400),
    c('12', 'f3', 'main', 50),
    c('13', 'f4', 'f2', 20),
  ];
  it('links by base == head, in both directions and through several levels', () => {
    for (const id of ['10', '11', '13'])
      expect(prChain(id, open).map((x) => x.changeId)).toEqual(['10', '11', '13']);
    expect(prChain('12', open).map((x) => x.changeId)).toEqual(['12']);
  });
  it('sorts by change number, not as text', () => {
    const list = [c('9', 'a', 'main', 1), c('10', 'b', 'a', 1)];
    expect(prChain('10', list).map((x) => x.changeId)).toEqual(['9', '10']);
  });
  it('a pull request from a fork is not a parent, and a card branch neither counts nor links', () => {
    expect(
      prChain('11', [c('10', 'f1', 'main', 1, { crossRepo: true }), c('11', 'f2', 'f1', 1)]).map(
        (x) => x.changeId,
      ),
    ).toEqual(['11']);
    const withCard = [
      c('10', 'f1', 'main', 1),
      c('11', 'card', 'f1', 1, { excluded: true }),
      c('12', 'f3', 'card', 1),
    ];
    expect(prChain('10', withCard).map((x) => x.changeId)).toEqual(['10']);
    expect(prChain('11', withCard)).toEqual([]);
  });
  it('an unlisted pull request has no chain', () => expect(prChain('99', open)).toEqual([]));
});

describe('changeSize', () => {
  it('reads the unit and keeps unknown as null', () => {
    const s = { changedLines: 12, changedFiles: null };
    expect(changeSize(s, 'changed_lines')).toBe(12);
    expect(changeSize(s, 'changed_files')).toBeNull();
  });
});

describe('prSizeVerdict', () => {
  const stacked = [c('10', 'f1', 'main', 300), c('11', 'f2', 'f1', 400)];
  it('AC1: 300 + 400 against 600 is over, with both members and the total', () => {
    const v = prSizeVerdict({ settings: settings(600), changeId: '10', open: stacked, complete: true });
    expect(v).toMatchObject({ state: 'over', total: 700, budget: 600, unit: 'changed_lines' });
    expect(v.state === 'over' && v.members).toEqual([
      { changeId: '10', size: 300 },
      { changeId: '11', size: 400 },
    ]);
    expect(
      prSizeVerdict({ settings: settings(600), changeId: '11', open: stacked, complete: true }).state,
    ).toBe('over');
  });
  it('equal to the budget is within; a single pull request is a chain of one', () => {
    expect(
      prSizeVerdict({ settings: settings(700), changeId: '10', open: stacked, complete: true }),
    ).toMatchObject({ state: 'within', total: 700 });
    expect(
      prSizeVerdict({
        settings: settings(600),
        changeId: '12',
        open: [c('12', 'x', 'main', 601)],
        complete: true,
      }).state,
    ).toBe('over');
    expect(
      prSizeVerdict({
        settings: settings(600),
        changeId: '12',
        open: [c('12', 'x', 'main', 600)],
        complete: true,
      }).state,
    ).toBe('within');
  });
  it('counts files when the unit is changed files', () => {
    const v = prSizeVerdict({
      settings: settings(3, 'changed_files'),
      changeId: '10',
      open: stacked,
      complete: true,
    });
    expect(v).toMatchObject({ state: 'over', total: 7, unit: 'changed_files' });
  });
  it('is inactive without a budget or a unit', () => {
    expect(
      prSizeVerdict({ settings: settings(null), changeId: '10', open: stacked, complete: true }).state,
    ).toBe('inactive');
    expect(
      prSizeVerdict({ settings: settings(600, null), changeId: '10', open: stacked, complete: true }).state,
    ).toBe('inactive');
    expect(prSizeVerdict({ settings: null, changeId: '10', open: stacked, complete: true }).state).toBe(
      'inactive',
    );
  });
  it('a member without a size is unknown, unless the known sizes are already over', () => {
    const list = [c('10', 'f1', 'main', 300), c('11', 'f2', 'f1', null)];
    expect(prSizeVerdict({ settings: settings(600), changeId: '10', open: list, complete: true })).toEqual({
      state: 'unknown',
      reason: 'no_size',
    });
    expect(prSizeVerdict({ settings: settings(200), changeId: '10', open: list, complete: true }).state).toBe(
      'over',
    );
    expect(prSizeVerdict({ settings: settings(600), changeId: '77', open: list, complete: true })).toEqual({
      state: 'unknown',
      reason: 'not_listed',
    });
  });
});

describe('timeouts: the size check decides, never the timeout', () => {
  const within = prSizeVerdict({
    settings: settings(600),
    changeId: '1',
    open: [c('1', 'a', 'main', 100)],
    complete: true,
  });
  const over = prSizeVerdict({
    settings: settings(600),
    changeId: '1',
    open: [c('1', 'a', 'main', 900)],
    complete: true,
  });
  const inactive = prSizeVerdict({
    settings: null,
    changeId: '1',
    open: [c('1', 'a', 'main', 900)],
    complete: true,
  });
  it('isSecondTimeout needs a timed-out manual re-run', () => {
    expect(isSecondTimeout({ state: 'timed_out', trigger: 'manual', rerunOfRunId: 'r1' })).toBe(true);
    expect(isSecondTimeout({ state: 'timed_out', trigger: 'auto', rerunOfRunId: null })).toBe(false);
    expect(isSecondTimeout({ state: 'timed_out', trigger: 'manual', rerunOfRunId: null })).toBe(false);
    expect(isSecondTimeout({ state: 'failed', trigger: 'manual', rerunOfRunId: 'r1' })).toBe(false);
  });
  it('follow-up table', () => {
    expect(timeoutFollowUp(false, within)).toBe('none'); // AC3
    expect(timeoutFollowUp(false, over)).toBe('needs_split');
    expect(timeoutFollowUp(true, over)).toBe('needs_split'); // AC4
    expect(timeoutFollowUp(true, within)).toBe('owner_pending'); // AC5
    expect(timeoutFollowUp(true, inactive)).toBe('owner_pending');
    expect(timeoutFollowUp(false, inactive)).toBe('none');
  });
});

describe('splitNoticeBody', () => {
  it('names the budget and the chain, ends with the marker, and names no reviewer', () => {
    const body = splitNoticeBody({
      unit: 'changed_lines',
      budget: 600,
      total: 700,
      members: [
        { changeId: '10', size: 300 },
        { changeId: '11', size: 400 },
      ],
      self: '10',
      noticeId: 'n-1',
    });
    expect(body).toContain('600 changed lines');
    expect(body).toContain('#11');
    expect(body).toContain('700');
    expect(body.trimEnd().endsWith(splitNoticeMarker('n-1'))).toBe(true);
    expect(body).not.toMatch(/claude|sonnet|opus|model/i);
  });
});
