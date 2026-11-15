import { applyFindingsCap } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildReviewPost, selectFindingsToPost } from '../src/commands/pr-review-runs.ts';

const spec = {
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
  projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
  remoteUrlNormalized: 'github.com/acme/toy',
  prNumber: 7,
  baseRef: 'main',
};
const run = {
  runId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  summary: 'ok',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
};
const sevs = ['low', 'high', 'medium', 'high', 'low', 'medium', 'high'] as const;
const seven = sevs.map((severity, i) => ({
  path: `src/f${i}.ts`,
  line: null,
  severity,
  title: `t${i}`,
  body: 'b',
  anchored: false,
}));
const postFor = (lines: number) => {
  const { ordered } = applyFindingsCap(seven, lines);
  const stored = ordered.map((f, i) => ({
    ...f,
    findingId: `019e3f6a-7b1c-7a2d-8c3e-01234567${String(i).padStart(4, '0')}`,
  }));
  return { post: buildReviewPost(run, spec, stored), stored };
};

describe('the post carries only the findings the cap allows (AC1, AC2)', () => {
  it.each([
    [250, 3],
    [30, 1],
    [900, 5],
  ])('%i changed lines: %i findings in the post, most important first', (lines, n) => {
    const { post } = postFor(lines);
    expect(post.findings).toHaveLength(n);
    expect(post.findings[0]?.finding.title).toMatch(/^\[high\]/);
  });
  it('no held-back finding id is in the post', () => {
    const { post, stored } = postFor(250);
    const held = stored.filter((f) => f.disposition === 'held_back').map((f) => f.findingId);
    expect(held).toHaveLength(4);
    expect(post.findings.map((f) => f.findingId).some((id) => held.includes(id))).toBe(false);
  });
  it('a finding without a disposition counts as posted', () => {
    expect(selectFindingsToPost([{ a: 1 }, { disposition: 'held_back' as const }])).toEqual([{ a: 1 }]);
  });
});
