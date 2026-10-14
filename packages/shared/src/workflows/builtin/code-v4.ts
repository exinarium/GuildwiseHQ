import { type WorkflowDefinition, WorkflowDefinitionSchema } from '../schema.ts';
import { codeWorkflowV3 } from './code-v3.ts';

/**
 * v4: integration and E2E tests by the tester (docs/design/run-and-integration-tests.md D8, backlog #59). v3 plus, on the
 * `test` stage: it is skipped unless the card's `integrationTests` field is on (set from the project's Run & test
 * setting when the card is specified, changeable per card), it runs against a running environment of the project
 * (`environment: 'project'`: the dispatcher starts it for the card's commit before a tester may claim the card) and a
 * shift may take two hours. Everything else equals v3. Cards that started on v1 to v3 stay on their version until they
 * leave Review: then they move to the newest built-in version (`reviewApprovedNext`), so the project's switch applies to
 * them too; a card already in Test or beyond finishes as it was. v1 to v3 stay registered.
 */
export const codeWorkflowV4: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...codeWorkflowV3,
  version: 4,
  stages: codeWorkflowV3.stages.map((s) =>
    s.id === 'test'
      ? {
          ...s,
          when: { field: 'integrationTests', equals: true },
          environment: 'project',
          maxShiftMinutes: 120,
        }
      : s,
  ),
});
