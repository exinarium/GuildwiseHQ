import { z } from 'zod';
import { defineEvent, Id, IsoDate } from './define.ts';

/**
 * Agent UX (S-B2, docs/design/discovery-boardroom-registry.md). Mentions in card comments, and follow-up and chase on the desk.
 * Every field added later must be optional so earlier streams replay.
 */
export const agentUxEvents = [
  /** Whether project members (not only Owners and Admins) may mention this agent in a card comment. Off by default. Stream `agent-<id>`, org scope. */
  defineEvent(
    'AgentMentionPolicySet',
    z.object({ agentId: Id, orgId: Id, allowMembers: z.boolean(), changedBy: Id }),
  ),
  /** A comment mentioned a hired agent and the mention was accepted (stream `card-<id>`, project scope). */
  defineEvent(
    'CardMentionRequested',
    z.object({
      mentionId: Id,
      orgId: Id,
      projectId: Id,
      cardId: Id,
      agentId: Id,
      requestedBy: Id,
      commentId: Id,
      /** The mention may edit and run commands in the card's working folder (the commenter could grant it). */
      work: z.boolean().optional(),
    }),
  ),
  /** The mention is over: the agent's answer was posted, or the run failed. */
  defineEvent(
    'CardMentionEnded',
    z.object({
      mentionId: Id,
      cardId: Id,
      outcome: z.enum(['replied', 'failed']),
      reason: z.string().max(500).optional(),
    }),
  ),
  /** The organization's chase window in days (`0` is off). Stream `org-<id>`. */
  defineEvent('FollowUpDaysSet', z.object({ orgId: Id, days: z.number().int().min(0).max(30), by: Id })),
  /**
   * A desk item was chased: `owner` nudged its owner(s), `requeue` handed an agent-owned item back to the agent. At most one per
   * item per window; the projection records when, so a replay and a second sweep see it.
   */
  defineEvent(
    'DeskItemNudged',
    z.object({
      deskItemId: Id,
      orgId: Id,
      projectId: Id.optional(),
      mode: z.enum(['owner', 'requeue']),
      recipients: z.array(Id).max(50).default([]),
      nudgeNumber: z.number().int().min(1),
    }),
  ),
  /** Somebody snoozed the chase of one item until `until`. */
  defineEvent(
    'DeskItemSnoozed',
    z.object({ deskItemId: Id, orgId: Id, projectId: Id.optional(), until: IsoDate, by: Id }),
  ),
] as const;
