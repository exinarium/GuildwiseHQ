import { z } from 'zod';
import { GateClassSchema } from '../governance/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * S-B1 Governance. Gate settings and gated-action requests are events (replay rebuilds `agent_action_gates` and
 * `gated_actions`); the notification action and the offboarding events are audit events that the org audit export reads.
 */
export const governanceEvents = [
  /** An agent is (un)gated on one side-effecting action class. Stream `agent-<id>`, org scope. */
  defineEvent(
    'AgentGateSet',
    z.object({ agentId: Id, orgId: Id, actionClass: GateClassSchema, gated: z.boolean(), by: Id }),
  ),
  /** A gated action paused and raised a desk item. */
  defineEvent(
    'GatedActionRequested',
    z.object({
      requestId: Id,
      orgId: Id,
      agentId: Id,
      actionClass: GateClassSchema,
      /** What the retry must match (the same target): the approval is for this and nothing else. */
      fingerprint: z.string().min(1).max(300),
      summary: z.string().max(500),
      deskItemId: Id,
      projectId: Id.optional(),
      cardId: Id.optional(),
    }),
  ),
  defineEvent(
    'GatedActionDecided',
    z.object({
      requestId: Id,
      orgId: Id,
      decision: z.enum(['approved', 'rejected']),
      decidedBy: Id,
      deskItemId: Id,
    }),
  ),
  /** The agent's retry used the approval (single use). */
  defineEvent('GatedActionUsed', z.object({ requestId: Id, orgId: Id, agentId: Id })),
  /** A desk action taken from a notification link: applied, or refused (with why). */
  defineEvent(
    'DeskNotificationActionTaken',
    z.object({
      orgId: Id,
      deskItemId: Id,
      /** The person who held the link (the token is bound to them). */
      userId: Id,
      action: z.string().max(80),
      outcome: z.enum(['applied', 'refused']),
      reason: z.string().max(200).optional(),
      /** The signed-in person who opened the link, when that was somebody else. */
      attemptedBy: Id.optional(),
    }),
  ),
  /** A member was taken out of the organization and the offboarding checklist ran. */
  defineEvent(
    'MemberOffboarded',
    z.object({
      orgId: Id,
      userId: Id,
      by: Id,
      transferredTo: Id.nullable(),
      privatePurgeAfter: z.iso.datetime().nullable(),
      /** The report, kept as the audit record (no secrets: counts and names only). */
      report: z.object({
        steps: z.array(z.object({ key: z.string(), count: z.number(), status: z.string() })),
      }),
      /** Private chats and packs scheduled for removal at `privatePurgeAfter`. */
      purge: z.object({ chatIds: z.array(Id), packIds: z.array(Id) }).default({ chatIds: [], packIds: [] }),
    }),
  ),
  /** Ownership of sessions, org packs moved from a removed member to the person who removed them. */
  defineEvent(
    'OwnedItemsTransferred',
    z.object({
      orgId: Id,
      fromUserId: Id,
      toUserId: Id,
      sessionIds: z.array(Id).default([]),
      packIds: z.array(Id).default([]),
    }),
  ),
  /** An organization admin exported the audit log (who, which range, which filters): the export audits itself. */
  defineEvent(
    'AuditExported',
    z.object({
      orgId: Id,
      by: Id,
      format: z.enum(['csv', 'json']),
      from: z.iso.datetime(),
      to: z.iso.datetime(),
      actorUserId: Id.optional(),
      type: z.string().max(80).optional(),
    }),
  ),
  /** The grace period of a removed member's private items ended and they were deleted. */
  defineEvent(
    'OffboardingPurgeRan',
    z.object({
      /** The `MemberOffboarded` event id that scheduled it. */
      purgeId: Id,
      orgId: Id,
      userId: Id,
      /** `done`: deleted; `cancelled`: the person came back to the organization first. */
      outcome: z.enum(['done', 'cancelled']).default('done'),
      chatIds: z.array(Id),
      packIds: z.array(Id),
    }),
  ),
] as const;
