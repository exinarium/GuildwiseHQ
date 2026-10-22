import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeWorkflowV6 } from '../src/workflows/builtin/code-v6.ts';

const stage = (id: string) => codeWorkflowV6.stages.find((st) => st.id === id);

describe('lean flow (code v6) facts the guide capture relies on', () => {
  it('sends a conflicting card to merge review, not back to build', () => {
    const mergeReview = stage('merge_review');
    expect(mergeReview).toBeDefined();
    expect(mergeReview?.outcomes.find((o) => o.id === 'approve')?.to).toBe('test_deploy');
  });

  it('has an owner approval step for large changes, and no separate merge approval step', () => {
    const ownerApproval = stage('owner_approval');
    expect(ownerApproval?.kind).toBe('human');
    expect(codeWorkflowV6.stages.map((st) => st.id)).not.toContain('merge_approval');
  });
});

describe('the guide capture spec is written for the lean flow', () => {
  const spec = readFileSync(
    fileURLToPath(new URL('../../../e2e/tests/guide-screenshots.spec.ts', import.meta.url)),
    'utf8',
  );

  it('hires the planner and the architect that Planning and Design need', () => {
    expect(spec).toMatch(/hire\('[^']+', 'planner'/);
    expect(spec).toMatch(/hire\('[^']+', 'architect'/);
  });

  it('starts the full suite itself after the history cards', () => {
    expect(spec).toContain('/full-suite');
  });

  it('waits for the merge review after a conflict, nor for the retired floor report', () => {
    expect(spec).toContain("c.stage === 'merge_review'");
    expect(spec).not.toContain("subkind='floor_report'");
    expect(spec).toContain("subkind='ceo_report'");
  });

  it.each([
    'backlog',
    'ceo',
    'ceo-chat',
    'ceo-reporting',
    'desk-daily-report',
    'environments',
    'metrics',
    'org-project-links',
    'releases',
  ])('captures the figure %s', (name) => {
    expect(spec).toContain(`'${name}'`);
  });
});
