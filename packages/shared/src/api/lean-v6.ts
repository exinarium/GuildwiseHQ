import { z } from 'zod';
import { E2eAreaMapSchema, OwnerApprovalPolicySchema } from '../cards/lean-v6.ts';

/** `PUT /api/projects/:id/owner-approval`: when the owner approves a card after the review (organization Owner, Admin or project owner). */
export const SetOwnerApprovalRequestSchema = z.object({ policy: OwnerApprovalPolicySchema });
export type SetOwnerApprovalRequest = z.infer<typeof SetOwnerApprovalRequestSchema>;

/** `PUT /api/projects/:id/e2e-areas`: the mapping of changed paths to E2E specs; `null` returns to the default derived from the E2E folders. */
export const SetE2eAreasRequestSchema = z.object({ mapping: E2eAreaMapSchema.nullable() });
export type SetE2eAreasRequest = z.infer<typeof SetE2eAreasRequestSchema>;

/** Body of `POST /api/projects/:id/full-suite`: the repository to run on (required when the project has several; absent: its only one). */
export const FullSuiteRequestSchema = z.object({ repoId: z.uuid().optional() });
export type FullSuiteRequest = z.infer<typeof FullSuiteRequestSchema>;

/** `POST /api/projects/:id/full-suite`: the manual full E2E regression run on the working branch (the lean team workflow turns the automatic run off). */
export const FullSuiteResponseSchema = z.object({ cardId: z.uuid(), ref: z.string() });
export type FullSuiteResponse = z.infer<typeof FullSuiteResponseSchema>;
