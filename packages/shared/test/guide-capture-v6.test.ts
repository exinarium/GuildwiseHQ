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
