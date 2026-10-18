import { z } from 'zod';
import { E2eAreaMapSchema, OwnerApprovalPolicySchema } from '../cards/lean-v6.ts';

/** `PUT /api/projects/:id/owner-approval`: when the owner approves a card after the review (organization Owner, Admin or project owner). */
export const SetOwnerApprovalRequestSchema = z.object({ policy: OwnerApprovalPolicySchema });
export type SetOwnerApprovalRequest = z.infer<typeof SetOwnerApprovalRequestSchema>;

/** `PUT /api/projects/:id/e2e-areas`: the mapping of changed paths to E2E specs; `null` returns to the default derived from the E2E folders. */
export const SetE2eAreasRequestSchema = z.object({ mapping: E2eAreaMapSchema.nullable() });
export type SetE2eAreasRequest = z.infer<typeof SetE2eAreasRequestSchema>;

/**
 * `POST /api/projects/:id/upgrade-workflow` (organization Owner and Admins): new cards of an existing project run on
 * code-v6 from now on. Cards in flight keep the version they are pinned to (their stages are unchanged).
 */
export const UpgradeWorkflowResponseSchema = z.object({
  workflowKey: z.string(),
  /** Open cards that stay on their older version until they finish. */
  openCardsOnOlderVersion: z.number().int(),
  /** Roles the new workflow works best with that no agent is hired for for this project (agents allowed on it), every role a code-v6 stage claims. */
  missingRoles: z.array(z.string()),
  /** Missing roles another hired role covers (the stage's fallback), e.g. the architect plans until a planner is hired. */
  coveredByFallback: z.array(z.object({ role: z.string(), fallbackRole: z.string() })).default([]),
  /** Missing roles nobody covers: cards reaching their stage wait until one is hired. */
  uncoveredRoles: z.array(z.string()).default([]),
});
export type UpgradeWorkflowResponse = z.infer<typeof UpgradeWorkflowResponseSchema>;

/** `POST /api/projects/:id/full-suite`: the manual full E2E regression run on the working branch (code-v6 turns the automatic run off). */
export const FullSuiteResponseSchema = z.object({ cardId: z.uuid(), ref: z.string() });
export type FullSuiteResponse = z.infer<typeof FullSuiteResponseSchema>;
