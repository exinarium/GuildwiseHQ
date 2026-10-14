import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';
import { codeWorkflowV2 } from './code.ts';

/**
 * v3: manual QA after Finalize (docs/design/manual-qa.md). Finalize runs as before (the merge, push or pull request) and
 * then hands the card to `qa_steps` (an agent writes the test steps, read-only) and `manual_qa` (a person passes,
 * skips, sends back or hands over). Both stages are skipped (`when`) unless the derived flag `manualQa` holds: the
 * server sets it from the project setting at the moment the card leaves Finalize, so cards that are further along keep
 * the behaviour they had, and `qaAgent` (an agent of the tester or BA role is hired) skips only the steps. Cards that
 * started on v1/v2 finish on those versions and never get a QA stage. v1 and v2 stay registered.
 */
export const codeWorkflowV3: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...codeWorkflowV2,
  version: 3,
  stages: [
    ...codeWorkflowV2.stages
      .filter((s) => s.id !== 'done')
      .map((s) =>
        s.id === 'finalize'
          ? {
              ...s,
              outcomes: s.outcomes.map((o) => (o.id === 'finalized' ? { ...o, to: 'qa_steps' } : o)),
            }
          : s,
      ),
    {
      id: 'qa_steps',
      label: 'QA steps',
      column: 'QA',
      kind: 'agent',
      claimRole: 'tester',
      fallbackRole: 'ba',
      doneCriteria:
        'Write the manual test steps for the person who will test this card, from the card (context, requirements, acceptance criteria, test plan), the review and test handoffs and what changed. Group them by scenario: happy path, edge cases, error handling, regressions, UI and data checks. Each step is a markdown checkbox ("- [ ] ...") that says what to do and what to expect. Read-only: do not change code or files and do not run the project. Post the steps with `aom outcome steps --note-file <steps.md>`.',
      outcomes: [
        {
          id: 'steps',
          label: 'Post the QA steps',
          kind: 'success',
          to: 'manual_qa',
          event: 'StageCompleted',
        },
      ],
      when: { field: 'qaAgent', equals: true },
      worktree: 'none',
      maxShiftMinutes: 20,
    },
    {
      id: 'manual_qa',
      label: 'Manual QA',
      column: 'QA',
      kind: 'human',
      human: { purpose: 'qa', assignee: 'starter' },
      claimRole: null,
      doneCriteria:
        'The person who started the card tested it and passed it, skipped the test, or sent it back with a comment.',
      outcomes: [
        { id: 'pass', label: 'Pass', kind: 'success', to: 'done', event: 'QaPassed' },
        { id: 'skip', label: 'Skip the test', kind: 'success', to: 'done', event: 'QaSkipped' },
        {
          id: 'send_back',
          label: 'Send back',
          kind: 'failure',
          to: 'build',
          event: 'QaSentBack',
          rework: true,
        },
      ],
      when: { field: 'manualQa', equals: true },
    },
    { id: 'done', label: 'Done', column: 'Done', kind: 'terminal', claimRole: null, doneCriteria: '' },
  ],
});
