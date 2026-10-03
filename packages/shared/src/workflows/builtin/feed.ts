import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';

/** Feed cards are created directly in `scan` with status queued. */
export const feedWorkflowV1: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  key: 'feed',
  version: 1,
  name: 'Feed',
  department: 'feeds',
  builtIn: true,
  fieldSet: 'feed',
  cardTypes: ['feed'],
  initialStage: 'scan',
  stages: [
    {
      id: 'scan',
      label: 'Scan',
      column: 'Scan',
      kind: 'agent',
      claimRole: 'scout',
      doneCriteria: 'Candidate items for the topic were collected, skipping items already seen.',
      outcomes: [
        {
          id: 'handoff',
          label: 'Hand off candidates',
          kind: 'success',
          to: 'curate',
          event: 'StageCompleted',
          data: 'candidates',
        },
      ],
    },
    {
      id: 'curate',
      label: 'Curate',
      column: 'Curate',
      kind: 'agent',
      claimRole: 'curator',
      doneCriteria: 'The qualifying items were selected, summarised and posted as a digest.',
      outcomes: [
        {
          id: 'digest',
          label: 'Post digest',
          kind: 'success',
          to: 'done',
          event: 'DigestPosted',
          data: 'digest',
        },
      ],
    },
    { id: 'done', label: 'Done', column: 'Done', kind: 'terminal', claimRole: null, doneCriteria: '' },
  ],
});
