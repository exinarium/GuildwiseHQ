import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/** Shared projects and multi-manager rules (docs/ARCHITECTURE.md sections 5.2 and 17, M3). Audience `project`. */
export const sharingEvents = [
  defineEvent('ProjectShared', z.object({ projectId: Id, userId: Id, invitedBy: Id })),
  /** An organization Owner or Admin gave an org Member access to a project: active at once, no accept step. */
  defineEvent('ProjectMemberAdded', z.object({ projectId: Id, userId: Id, addedBy: Id })),
  defineEvent('ProjectShareAccepted', z.object({ projectId: Id, userId: Id })),
  defineEvent('ProjectShareDeclined', z.object({ projectId: Id, userId: Id })),
  /**
   * One append with this event removes the member and hands their agents (`needs_rehome`, no workstation) and cards
   * to the owner. `ClaimReleased(member_removed)` events for the agents' claims precede it in the same append.
   */
  defineEvent(
    'ProjectMemberRemoved',
    z.object({
      projectId: Id,
      userId: Id,
      removedBy: Id,
      inheritedAgentIds: z.array(Id),
      transferredCardIds: z.array(Id),
    }),
  ),
  /** Card re-home: forgets the worktree and home workstation so the stage restarts from the base branch. */
  defineEvent('CardRehomed', z.object({ cardId: Id, by: Id })),
] as const;
