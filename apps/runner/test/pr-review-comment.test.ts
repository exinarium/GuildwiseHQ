import { describe, expect, it } from 'vitest';
import { renderReviewerInstructions } from '../src/review/instructions.ts';

describe('reviewer instructions (blind marking)', () => {
  it('tells the model not to name itself, the model, the tool or the vendor', () => {
    expect(renderReviewerInstructions()).toContain(
      'Do not name yourself, the model, the tool or the vendor in the summary or in any finding.',
    );
  });
});
