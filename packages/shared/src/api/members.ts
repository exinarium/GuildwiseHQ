import { z } from 'zod';
import { DecisionPolicy } from '../cards/types.ts';
import { IsoTime } from './common.ts';

/** `POST /api/projects/:id/members`: the invitee must already have an account. */
export const ShareProjectRequestSchema = z.object({ email: z.string().email() });
export type ShareProjectRequest = z.infer<typeof ShareProjectRequestSchema>;

export const MemberParamsSchema = z.object({ id: z.uuid(), userId: z.uuid() });

/** `GET /api/project-invitations`: pending shares for the caller (the invitations inbox). */
export const ProjectInvitationDtoSchema = z.object({
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  invitedByName: z.string(),
  /** The organization that invited the user (guests see it in the inbox). */
  orgName: z.string().optional(),
  invitedAt: IsoTime.nullable(),
});
export type ProjectInvitationDto = z.infer<typeof ProjectInvitationDtoSchema>;
export const ProjectInvitationsResponseSchema = z.object({
  invitations: z.array(ProjectInvitationDtoSchema),
});

/** What removing a member hands to the owner (shown before confirming). */
export const RemovalPreviewSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  status: z.enum(['invited', 'active', 'removed']),
  agents: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      roleKey: z.string(),
      workstationName: z.string().nullable(),
      claimedCardRef: z.string().nullable(),
    }),
  ),
  /** Cards the agents hold now: released to the queue with their last handoff. */
  releasedCards: z.array(z.object({ ref: z.string(), title: z.string() })),
  /** Cards the member owns: ownership (and their desk items) moves to the project owner. */
  transferredCards: z.array(z.object({ ref: z.string(), title: z.string(), status: z.string() })),
});
export type RemovalPreview = z.infer<typeof RemovalPreviewSchema>;

/** `POST /api/cards/:id/decision-policy`. */
export const DecisionPolicyRequestSchema = z.object({ policy: DecisionPolicy });
export type DecisionPolicyRequest = z.infer<typeof DecisionPolicyRequestSchema>;
