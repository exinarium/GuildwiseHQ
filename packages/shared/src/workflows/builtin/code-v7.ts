import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';
import { codeWorkflowV6 } from './code-v6.ts';

/** The owner's design gate between Investigate & design and Build (`code` version 7). */
export const DESIGN_GATE_STAGE = 'design_gate';

/**
 * `code` version 7: version 6 plus one human approval stage, the design gate, between Investigate & design and Build.
 * The server decides the `designGate` flag at the design hand-off (the project setting, the card's own switch, or a design
 * that touches high-risk paths); when it is off the stage is skipped and the card goes straight to Build, exactly as on v6.
 * The owner reviews the existing design report: approve moves the card on to Build, return sends it back to the architect
 * with the owner's note. Shipped as a new version because built-ins register once per (key, version).
 */
export const codeWorkflowV7: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...codeWorkflowV6,
  version: 7,
  stages: codeWorkflowV6.stages.flatMap((s) => {
    if (s.id !== 'investigate') return [s];
    const investigate = {
      ...s,
      outcomes: s.outcomes.map((o) =>
        o.id === 'handoff' ? { ...o, to: DESIGN_GATE_STAGE, label: 'Hand off the design' } : o,
      ),
    };
    const gate = {
      id: DESIGN_GATE_STAGE,
      label: 'Design gate',
      column: 'Design',
      kind: 'human',
      human: { purpose: 'approval', approver: { kind: 'project_owner' } },
      claimRole: null,
      doneCriteria:
        'The project owner read the design report and approved it (on to Build), or returned it to design with a note.',
      outcomes: [
        { id: 'approve', label: 'Approve the design', kind: 'success', to: 'build', event: 'StageCompleted' },
        {
          id: 'send_back',
          label: 'Return to design',
          kind: 'failure',
          to: 'investigate',
          event: 'StageCompleted',
          rework: true,
        },
      ],
      // Decided by the server at the design hand-off (project setting, card switch, high risk); otherwise skipped.
      when: { field: 'designGate', equals: true },
    };
    return [investigate, gate];
  }),
});
