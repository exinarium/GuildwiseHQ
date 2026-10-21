import { describe, expect, it } from 'vitest';
import { questionLoopStage } from '../src/ceo/detectors.ts';

describe('questionLoopStage', () => {
  it('takes the stage with the most counted shifts, not the stage the card is in now', () => {
    expect(questionLoopStage(['build', 'build', 'build', 'review', 'review', 'build'])).toBe('build');
    expect(questionLoopStage(['build', 'review', 'review', 'review', 'finalize'])).toBe('review');
  });

  it('gives a tie to the latest stage', () => {
    expect(questionLoopStage(['build', 'build', 'review', 'review'])).toBe('review');
    expect(questionLoopStage(['review', 'build', 'review', 'build'])).toBe('build');
  });

  it('skips shifts without a stage and returns null when none has one', () => {
    expect(questionLoopStage([null, 'build', null, null])).toBe('build');
    expect(questionLoopStage([null, null])).toBeNull();
    expect(questionLoopStage([])).toBeNull();
  });
});
