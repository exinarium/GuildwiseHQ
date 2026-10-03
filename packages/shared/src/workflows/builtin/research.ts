import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';

export const researchWorkflowV1: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  key: 'research',
  version: 1,
  name: 'Research',
  department: 'research',
  builtIn: true,
  fieldSet: 'research',
  cardTypes: ['research'],
  initialStage: 'question',
  stages: [
    {
      id: 'question',
      label: 'Question',
      column: 'Spec',
      kind: 'manual',
      claimRole: null,
      requiredFields: ['title', 'cardType'],
      doneCriteria: 'The research question is stated and the card is queued for research.',
      outcomes: [
        { id: 'specified', label: 'Specified', kind: 'success', to: 'research', event: 'CardSpecified' },
      ],
    },
    {
      id: 'research',
      label: 'Research',
      column: 'Research',
      kind: 'agent',
      claimRole: 'researcher',
      requiredFields: ['question', 'depth'],
      doneCriteria: 'The question is answered with cited findings ready for fact checking.',
      outcomes: [
        {
          id: 'handoff',
          label: 'Hand off to fact check',
          kind: 'success',
          to: 'factcheck',
          event: 'StageCompleted',
        },
      ],
    },
    {
      id: 'factcheck',
      label: 'Fact check',
      column: 'Fact check',
      kind: 'agent',
      claimRole: 'checker',
      doneCriteria: 'Every claim was verified against its citation; the note is published or sent back.',
      outcomes: [
        {
          id: 'published',
          label: 'Published',
          kind: 'success',
          to: 'done',
          event: 'ResearchPublished',
          data: 'publication',
        },
        {
          id: 'unsupported',
          label: 'Unsupported claims',
          kind: 'failure',
          to: 'research',
          event: 'StageCompleted',
          rework: true,
        },
      ],
    },
    { id: 'done', label: 'Done', column: 'Done', kind: 'terminal', claimRole: null, doneCriteria: '' },
  ],
});
