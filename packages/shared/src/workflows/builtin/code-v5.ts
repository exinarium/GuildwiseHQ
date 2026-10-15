import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';
import { codeWorkflowV4 } from './code-v4.ts';

/**
 * v5: the Test stage always runs (backlog #71). v4 skipped the tester unless the card's `integrationTests` field was on,
 * which meant projects with integration tests off (the default) got no tester at all. v5 drops that skip guard: with
 * integration tests off the tester checks the card's branch against its test plan as before #59 (no environment, no
 * forwarders, E2E and unit-level checks in its worktree; the pre-test rebase still happens); with them on the stage
 * behaves as v4 built it. `environment: 'project'` stays on the stage, and the server applies it only to cards whose
 * `integrationTests` field is on. Everything else equals v4. Cards on v1 to v4 that have not reached Test move to v5 when
 * they leave Review (`reviewApprovedPlan`); a card already in Test or beyond finishes as it was. v1 to v4 stay registered.
 */
export const codeWorkflowV5: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...codeWorkflowV4,
  version: 5,
  stages: codeWorkflowV4.stages.map((s) => {
    if (s.id !== 'test') return s;
    const { when: _when, ...rest } = s;
    return rest;
  }),
});
