import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';

/** Internal: used only for bug children created by `TestFailed`. Shares the parent's worktree and branch. */
export const codeBugfixWorkflowV1: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  key: 'code-bugfix',
  version: 1,
  name: 'Code bugfix',
  department: 'delivery',
  builtIn: true,
  fieldSet: 'code',
  cardTypes: ['bug'],
  initialStage: 'build',
  stages: [
    {
      id: 'build',
      label: 'Build',
      column: 'In progress',
      kind: 'agent',
      claimRole: 'builder',
      requiredFields: ['title', 'cardType'],
      doneCriteria:
        'The bug is fixed, a regression unit test covers it, all unit tests pass and the work is committed.',
      outcomes: [
        {
          id: 'handoff',
          label: 'Hand off for review',
          kind: 'success',
          to: 'review',
          event: 'ReviewRequested',
          data: 'diffStats',
        },
      ],
      worktree: 'reuse',
    },
    {
      id: 'review',
      label: 'Review',
      column: 'Review',
      kind: 'agent',
      claimRole: 'reviewer',
      seniorOnly: true,
      doneCriteria: 'The fix was checked against the bug report; the verdict and score are recorded.',
      outcomes: [
        // Approval completes the child; the server also appends ChildCardResolved on the parent.
        {
          id: 'approve',
          label: 'Approve',
          kind: 'success',
          to: 'done',
          event: 'StageCompleted',
          data: 'review',
          effect: 'resume_parent',
        },
        {
          id: 'changes',
          label: 'Request changes',
          kind: 'failure',
          to: 'build',
          event: 'ChangesRequested',
          data: 'review',
          rework: true,
        },
      ],
      worktree: 'reuse',
      approvals: { small: 1, large: 1 },
    },
    { id: 'done', label: 'Done', column: 'Done', kind: 'terminal', claimRole: null, doneCriteria: '' },
  ],
});
