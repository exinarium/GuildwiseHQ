import { describe, expect, it } from 'vitest';
import {
  boardColumns,
  type CardStatus,
  CODE_BOARD_COLUMNS,
  codeWorkflowV1,
  columnFor,
  feedWorkflowV1,
  researchWorkflowV1,
} from '../src/index.ts';

const stageOf = (id: string) => codeWorkflowV1.stages.find((s) => s.id === id)!;
const col = (status: CardStatus, stage: string, reworkRound = 0, cardType = 'feature') =>
  columnFor({ status, stage, reworkRound, cardType }, stageOf(stage));

describe('columnFor', () => {
  it('draft is Spec', () => expect(col('draft', 'spec')).toBe('Spec'));
  it('blocked is Blocked whatever the stage', () => expect(col('blocked', 'build')).toBe('Blocked'));
  it('a held design stays in its stage column, not in Blocked or To do', () =>
    expect(col('held', 'spec')).toBe(stageOf('spec').column));
  it('waiting is Test (waiting on bug)', () => expect(col('waiting', 'test')).toBe('Test (waiting on bug)'));
  it('waiting on a Finalize merge approval stays in Finalize', () => {
    expect(
      columnFor(
        { status: 'waiting', stage: 'finalize', reworkRound: 0, finalizeState: 'awaiting_approval' },
        stageOf('finalize'),
      ),
    ).toBe('Finalize');
    expect(
      columnFor(
        { status: 'waiting', stage: 'finalize', reworkRound: 0, finalizeState: 'running' },
        stageOf('finalize'),
      ),
    ).toBe('Finalize');
  });
  it('waiting with a stale or failed finalize state is still the bug column', () => {
    expect(
      columnFor(
        { status: 'waiting', stage: 'test', reworkRound: 0, finalizeState: 'failed' },
        stageOf('test'),
      ),
    ).toBe('Test (waiting on bug)');
    expect(
      columnFor({ status: 'waiting', stage: 'test', reworkRound: 0, finalizeState: null }, stageOf('test')),
    ).toBe('Test (waiting on bug)');
  });
  it('a non-waiting card ignores finalizeState', () => {
    expect(
      columnFor(
        { status: 'queued', stage: 'finalize', reworkRound: 0, finalizeState: 'awaiting_approval' },
        stageOf('finalize'),
      ),
    ).toBe('Finalize');
    expect(
      columnFor(
        { status: 'claimed', stage: 'build', reworkRound: 0, finalizeState: 'running' },
        stageOf('build'),
      ),
    ).toBe('In progress');
  });
  it('build claimed is In progress', () => expect(col('claimed', 'build')).toBe('In progress'));
  it('build queued is To do', () => expect(col('queued', 'build')).toBe('To do'));
  it('build queued with rework is Rework', () => expect(col('queued', 'build', 1)).toBe('Rework'));
  it('build queued bug card is Rework', () => expect(col('queued', 'build', 0, 'bug')).toBe('Rework'));
  it('build claimed in rework is still In progress', () =>
    expect(col('claimed', 'build', 2)).toBe('In progress'));
  it('other stages use the stage column', () => {
    expect(col('queued', 'review')).toBe('Review');
    expect(col('claimed', 'review')).toBe('Review');
    expect(col('queued', 'test')).toBe('Test');
    expect(col('queued', 'docs')).toBe('Docs');
    expect(col('queued', 'finalize')).toBe('Finalize');
    expect(col('done', 'done')).toBe('Done');
  });
});

describe('boardColumns', () => {
  it('code: spec order with the waiting column after Test', () => {
    expect(boardColumns(codeWorkflowV1)).toEqual([
      'Spec',
      'To do',
      'Rework',
      'In progress',
      'Blocked',
      'Review',
      'Test',
      'Test (waiting on bug)',
      'Docs',
      'Finalize',
      'Done',
    ]);
    expect(boardColumns(codeWorkflowV1).filter((c) => c !== 'Test (waiting on bug)')).toEqual([
      ...CODE_BOARD_COLUMNS,
    ]);
  });
  it('every column a code card can be in is on the board', () => {
    const cols = new Set(boardColumns(codeWorkflowV1));
    for (const s of codeWorkflowV1.stages)
      for (const st of ['draft', 'queued', 'claimed', 'blocked', 'waiting', 'done'] as const)
        expect(cols.has(columnFor({ status: st, stage: s.id, reworkRound: 1 }, s))).toBe(true);
  });
  it('research and feed', () => {
    expect(boardColumns(researchWorkflowV1)).toEqual(['Spec', 'Research', 'Fact check', 'Blocked', 'Done']);
    expect(boardColumns(feedWorkflowV1)).toEqual(['Scan', 'Curate', 'Blocked', 'Done']);
  });
});

describe('a card waiting in a sub-workflow step', () => {
  const step = { id: 'translate', column: 'Translation', kind: 'subworkflow' as const };
  const card = (status: CardStatus) => ({ status, stage: 'translate', reworkRound: 0 });
  it('stays in the step column while it waits, unlike a card waiting on a bug', () => {
    expect(columnFor(card('waiting'), step)).toBe('Translation');
    expect(columnFor(card('queued'), step)).toBe('Translation');
    expect(columnFor(card('blocked'), step)).toBe('Blocked');
    expect(columnFor(card('waiting'), { id: 'translate', column: 'Translation' })).toBe(
      'Test (waiting on bug)',
    );
  });
});
